import pytest
import importlib.util
from pathlib import Path
from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas
from app.constants import QAStatus, Role
from app.routers import defects, functional, performance, qa_requests, sast_dast, suppression, test_projects
from app.workspace_service import workspace_context
from app.workflow_authority import workflow_context


def _session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    models.Base.metadata.create_all(engine)
    return Session(engine)


def _user(username: str, *roles: str, department: str = "Technology") -> models.User:
    return models.User(
        username=username,
        full_name=username.replace("-", " ").title(),
        hashed_password="x",
        department=department,
        is_active=True,
        role_assignments=[models.UserRole(role=role) for role in roles],
    )


def _seed_workflow_requests(db: Session):
    owner_workspace = models.QAWorkspace(
        workspace_key="OWNER", name="Owner Workspace", is_active=True,
    )
    foreign_workspace = models.QAWorkspace(
        workspace_key="FOREIGN", name="Foreign Workspace", is_active=True,
    )
    requester = _user("requester", Role.REQUESTER)
    lead = _user("foreign-lead", Role.QA_LEAD)
    db.add_all([owner_workspace, foreign_workspace, requester, lead])
    db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=foreign_workspace.id,
        user_id=lead.id,
        role="WORKSPACE_MEMBER",
        is_active=True,
    ))
    gateway = models.QARequest(
        request_id="TQA-REQ-SCOPE",
        application_name="Scoped Application",
        department="Technology",
        requester_id=requester.id,
        qa_workspace_id=owner_workspace.id,
        status="RAISED",
    )
    db.add(gateway)
    db.flush()
    functional_request = models.FunctionalRequest(
        request_id="TQA-FUNC-SCOPE",
        qa_request_id=gateway.id,
        requester_id=requester.id,
        qa_lead_id=lead.id,
        status=QAStatus.QA_LEAD_ASSIGNED,
    )
    performance_request = models.PerformanceRequest(
        request_id="TQA-PERF-SCOPE",
        application_name="Scoped Application",
        qa_request_id=gateway.id,
        requester_id=requester.id,
        engineer_id=lead.id,
        status="ENGINEER_ASSIGNED",
    )
    sast_request = models.SASTRequest(
        request_id="TQA-SAST-SCOPE",
        application_name="Scoped Application",
        qa_request_id=gateway.id,
        requester_id=requester.id,
        security_lead_id=lead.id,
        status="SECURITY_LEAD_ASSIGNED",
    )
    dast_request = models.DASTRequest(
        request_id="TQA-DAST-SCOPE",
        qa_request_id=gateway.id,
        requester_id=requester.id,
        security_lead_id=lead.id,
        status="SECURITY_LEAD_ASSIGNED",
    )
    db.add_all([functional_request, performance_request, sast_request, dast_request])
    db.commit()
    lead.active_qa_workspace_id = foreign_workspace.id
    return owner_workspace, foreign_workspace, requester, lead, {
        "functional": functional_request,
        "performance": performance_request,
        "sast": sast_request,
        "dast": dast_request,
    }


@pytest.mark.parametrize("kind", ["functional", "performance", "sast", "dast"])
def test_qa_stage_mutation_rejects_actor_operating_from_another_workspace(kind):
    db = _session()
    _, foreign_workspace, _, lead, requests = _seed_workflow_requests(db)
    request = requests[kind]

    with workspace_context(foreign_workspace.id, (foreign_workspace.id,)):
        with pytest.raises(HTTPException) as denied:
            if kind == "functional":
                functional.start_readiness_verification(request.id, db=db, current_user=lead)
            elif kind == "performance":
                performance.start_readiness(request.id, db=db, current_user=lead)
            elif kind == "sast":
                sast_dast.sast_start_readiness(request.id, db=db, current_user=lead)
            else:
                sast_dast.dast_start_readiness(request.id, db=db, current_user=lead)

    assert denied.value.status_code == 403
    assert "another workspace" in str(denied.value.detail).lower()
    db.refresh(request)
    expected = {
        "functional": QAStatus.QA_LEAD_ASSIGNED,
        "performance": "ENGINEER_ASSIGNED",
        "sast": "SECURITY_LEAD_ASSIGNED",
        "dast": "SECURITY_LEAD_ASSIGNED",
    }
    assert request.status == expected[kind]


@pytest.mark.parametrize("kind", ["functional", "performance", "sast", "dast"])
def test_document_upload_rejects_requester_operating_from_another_workspace(kind):
    db = _session()
    _, foreign_workspace, requester, _, requests = _seed_workflow_requests(db)
    request = requests[kind]
    request.status = "DRAFT"
    db.commit()

    with workspace_context(foreign_workspace.id, (foreign_workspace.id,)):
        with pytest.raises(HTTPException) as denied:
            if kind == "functional":
                functional.upload_functional_documents(request.id, [], db=db, current_user=requester)
            elif kind == "performance":
                performance.upload_performance_documents(request.id, [], db=db, current_user=requester)
            elif kind == "sast":
                sast_dast.upload_sast_documents(request.id, [], db=db, current_user=requester)
            else:
                sast_dast.upload_dast_documents(request.id, [], db=db, current_user=requester)

    assert denied.value.status_code == 403
    assert db.query(models.RequestDocument).count() == 0


@pytest.mark.parametrize("kind", ["functional", "performance", "sast", "dast"])
def test_requester_submit_rejects_actor_operating_from_another_workspace(kind):
    db = _session()
    _, foreign_workspace, requester, _, requests = _seed_workflow_requests(db)
    request = requests[kind]
    request.status = "DRAFT"
    db.commit()

    with workspace_context(foreign_workspace.id, (foreign_workspace.id,)):
        with pytest.raises(HTTPException) as denied:
            if kind == "functional":
                functional.submit_request(request.id, db=db, current_user=requester)
            elif kind == "performance":
                performance.submit_performance(request.id, db=db, current_user=requester)
            elif kind == "sast":
                sast_dast.submit_sast(request.id, db=db, current_user=requester)
            else:
                sast_dast.submit_dast(request.id, db=db, current_user=requester)

    assert denied.value.status_code == 403
    db.refresh(request)
    assert request.status == "DRAFT"


@pytest.mark.parametrize("kind", ["functional", "performance", "sast", "dast"])
def test_request_update_rejects_actor_operating_from_another_workspace(kind):
    db = _session()
    _, foreign_workspace, requester, _, requests = _seed_workflow_requests(db)
    request = requests[kind]
    request.status = "DRAFT"
    db.commit()
    payloads = {
        "functional": schemas.FunctionalUpdate(priority="High"),
        "performance": schemas.PerformanceUpdate(priority="High"),
        "sast": schemas.SASTUpdate(priority="High"),
        "dast": schemas.DASTUpdate(priority="High"),
    }

    with workspace_context(foreign_workspace.id, (foreign_workspace.id,)):
        with pytest.raises(HTTPException) as denied:
            if kind == "functional":
                functional.update_functional(request.id, payloads[kind], db=db, current_user=requester)
            elif kind == "performance":
                performance.update_performance(request.id, payloads[kind], db=db, current_user=requester)
            elif kind == "sast":
                sast_dast.update_sast(request.id, payloads[kind], db=db, current_user=requester)
            else:
                sast_dast.update_dast(request.id, payloads[kind], db=db, current_user=requester)

    assert denied.value.status_code == 403


@pytest.mark.parametrize("kind", ["functional", "performance", "sast", "dast"])
def test_requester_resubmit_rejects_actor_operating_from_another_workspace(kind):
    db = _session()
    _, foreign_workspace, requester, _, requests = _seed_workflow_requests(db)
    request = requests[kind]
    request.status = "RETURNED_BY_SM"
    db.commit()

    with workspace_context(foreign_workspace.id, (foreign_workspace.id,)):
        with pytest.raises(HTTPException) as denied:
            if kind == "functional":
                functional.resubmit_request(request.id, db=db, current_user=requester)
            elif kind == "performance":
                performance.resubmit_performance(request.id, db=db, current_user=requester)
            elif kind == "sast":
                sast_dast.resubmit_sast(request.id, db=db, current_user=requester)
            else:
                sast_dast.resubmit_dast(request.id, db=db, current_user=requester)

    assert denied.value.status_code == 403
    db.refresh(request)
    assert request.status == "RETURNED_BY_SM"


@pytest.mark.parametrize("kind", ["functional", "performance"])
def test_requester_final_decision_rejects_actor_operating_from_another_workspace(kind):
    db = _session()
    _, foreign_workspace, requester, _, requests = _seed_workflow_requests(db)
    request = requests[kind]
    request.status = "REQUESTER_VERIFICATION"
    db.commit()
    payload = schemas.RequesterDecisionIn(decision="Accepted")

    with workspace_context(foreign_workspace.id, (foreign_workspace.id,)):
        with pytest.raises(HTTPException) as denied:
            if kind == "functional":
                functional.requester_decision(request.id, payload, db=db, current_user=requester)
            else:
                performance.requester_decision(request.id, payload, db=db, current_user=requester)

    assert denied.value.status_code == 403
    db.refresh(request)
    assert request.status == "REQUESTER_VERIFICATION"


@pytest.mark.parametrize("operation", ["upload", "delegate"])
def test_gateway_mutations_reject_requester_operating_from_another_workspace(operation):
    db = _session()
    _, foreign_workspace, requester, _, requests = _seed_workflow_requests(db)
    gateway = requests["functional"].qa_request
    gateway.status = "DRAFT"
    delegate = _user("delegate", Role.REQUESTER)
    db.add(delegate)
    db.commit()

    with workspace_context(foreign_workspace.id, (foreign_workspace.id,)):
        with pytest.raises(HTTPException) as denied:
            if operation == "upload":
                qa_requests.upload_documents(gateway.id, [], db=db, current_user=requester)
            else:
                qa_requests.assign_for_input(
                    gateway.id,
                    schemas.QARequestDelegationCreate(
                        assigned_to_id=delegate.id, reason="Need input",
                    ),
                    db=db,
                    current_user=requester,
                )

    assert denied.value.status_code == 403
    assert db.query(models.QARequestDelegation).count() == 0
    assert db.query(models.QARequestDocument).count() == 0


@pytest.mark.parametrize("operation", ["upload", "relink"])
def test_suppression_mutations_reject_requester_operating_from_another_workspace(operation):
    db = _session()
    owner_workspace, foreign_workspace, requester, _, requests = _seed_workflow_requests(db)
    linked = requests["sast"]
    linked.status = "SCANNING"
    record = models.SuppressionRequest(
        suppression_id="TQA-SUP-SCOPE",
        application_name="Scoped Application",
        scan_type="SAST",
        department="Technology",
        qa_workspace_id=owner_workspace.id,
        created_by_id=requester.id,
        sast_request_id=linked.id,
        status="Draft",
    )
    db.add(record)
    db.commit()

    with workspace_context(foreign_workspace.id, (foreign_workspace.id,)):
        with pytest.raises(HTTPException) as denied:
            if operation == "upload":
                suppression.upload_suppression_documents(
                    record.id, [], db=db, current_user=requester,
                )
            else:
                suppression.relink_suppression(
                    record.id,
                    schemas.SuppressionRelinkIn(sast_request_id=linked.id),
                    db=db,
                    current_user=requester,
                )

    assert denied.value.status_code in {403, 404}
    assert db.query(models.RequestDocument).count() == 0


def test_project_view_grant_exposes_linked_defect_read_only():
    db = _session()
    owner_workspace = models.QAWorkspace(
        workspace_key="DEFECT-OWNER", name="Defect Owner", is_active=True,
    )
    viewer_workspace = models.QAWorkspace(
        workspace_key="DEFECT-VIEWER", name="Defect Viewer", is_active=True,
    )
    reporter = _user("defect-reporter", Role.QA_ENGINEER)
    viewer = _user("defect-viewer", Role.QA_LEAD)
    db.add_all([owner_workspace, viewer_workspace, reporter, viewer])
    db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=viewer_workspace.id, user_id=viewer.id,
        role="WORKSPACE_MEMBER", is_active=True,
    ))
    project = models.TestProject(
        project_key="TQA-PRJ-DEFECT-VIEW", name="Defect Project",
        department="Technology", qa_workspace_id=owner_workspace.id,
        owner_id=reporter.id,
    )
    cycle = models.TestCycle(
        project=project, cycle_key="TQA-CYC-DEFECT-VIEW", name="Cycle",
    )
    defect = models.Defect(
        defect_key="TQA-DEF-VIEW", title="Read only", description="Details",
        status="New", qa_workspace_id=owner_workspace.id,
        department="Technology", cycle=cycle, application_name="Application",
        module_feature="Feature", environment="UAT", severity="Medium",
        priority="P3 – Medium", steps_to_reproduce="Steps",
        expected_result="Expected", actual_result="Actual", reporter_id=reporter.id,
    )
    db.add_all([project, cycle, defect])
    db.flush()
    db.add(models.TestProjectViewGrant(
        project_id=project.id, workspace_id=viewer_workspace.id,
        granted_by_id=reporter.id,
    ))
    db.commit()
    viewer.active_qa_workspace_id = viewer_workspace.id

    with workspace_context(viewer_workspace.id, (viewer_workspace.id,)):
        assert defects.get_defect(defect.id, db=db, current_user=viewer).id == defect.id
        with pytest.raises(HTTPException) as denied:
            defects.update_defect(
                defect.id,
                schemas.DefectUpdate(title="Unauthorized edit"),
                db=db,
                current_user=viewer,
            )

    assert denied.value.status_code == 404
    db.refresh(defect)
    assert defect.title == "Read only"


@pytest.mark.parametrize(
    "kind,entity_type",
    [
        ("functional", "FUNCTIONAL_REQUEST"),
        ("performance", "PERFORMANCE"),
        ("sast", "SAST"),
        ("dast", "DAST"),
    ],
)
def test_department_head_cannot_approve_after_own_sm_approval(kind, entity_type):
    db = _session()
    owner_workspace, _, requester, _, requests = _seed_workflow_requests(db)
    actor = _user("dual-stage-approver", Role.SM, Role.DEPARTMENT_HEAD_CM)
    db.add(actor)
    db.flush()
    request = requests[kind]
    request.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
    db.add(models.ApprovalAction(
        entity_type=entity_type,
        entity_id=request.id,
        step_name="SM Approval",
        actor_id=actor.id,
        actor_role=actor.roles_csv,
        decision="Approved",
    ))
    db.commit()
    actor.active_qa_workspace_id = owner_workspace.id

    with workspace_context(owner_workspace.id, (owner_workspace.id,)):
        with pytest.raises(HTTPException) as denied:
            if kind == "functional":
                functional.department_head_decision(
                    request.id,
                    schemas.DepartmentHeadDecisionIn(decision="Approved"),
                    db=db,
                    current_user=actor,
                )
            elif kind == "performance":
                performance.department_head_decision(
                    request.id,
                    schemas.PerformanceDeptHeadDecisionIn(decision="Approved"),
                    db=db,
                    current_user=actor,
                )
            elif kind == "sast":
                sast_dast.sast_department_head_decision(
                    request.id,
                    schemas.SecurityDeptHeadDecisionIn(decision="Approved"),
                    db=db,
                    current_user=actor,
                )
            else:
                sast_dast.dast_department_head_decision(
                    request.id,
                    schemas.SecurityDeptHeadDecisionIn(decision="Approved"),
                    db=db,
                    current_user=actor,
                )

    assert denied.value.status_code == 403
    assert "different approver" in str(denied.value.detail).lower()
    db.refresh(request)
    assert request.status == "DEPARTMENT_HEAD_APPROVAL_PENDING"


def test_admin_retains_maker_checker_bypass():
    db = _session()
    owner_workspace, _, requester, _, requests = _seed_workflow_requests(db)
    admin = _user("administrator", Role.ADMIN, Role.DEPARTMENT_HEAD_CM)
    db.add(admin)
    db.flush()
    request = requests["functional"]
    request.status = QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING
    db.add(models.ApprovalAction(
        entity_type="FUNCTIONAL_REQUEST",
        entity_id=request.id,
        step_name="SM Approval",
        actor_id=admin.id,
        actor_role=admin.roles_csv,
        decision="Approved",
    ))
    db.commit()
    admin.active_qa_workspace_id = owner_workspace.id

    with workspace_context(owner_workspace.id, (owner_workspace.id,)), workflow_context(admin):
        functional.department_head_decision(
            request.id,
            schemas.DepartmentHeadDecisionIn(decision="Approved"),
            db=db,
            current_user=admin,
        )

    db.refresh(request)
    assert request.status == QAStatus.QA_LEAD_ASSIGNED


@pytest.mark.parametrize("kind", ["sast", "dast"])
def test_maker_checker_honors_unambiguous_legacy_security_approval(kind):
    db = _session()
    owner_workspace, _, _, _, requests = _seed_workflow_requests(db)
    actor = _user("legacy-dual-approver", Role.SM, Role.DEPARTMENT_HEAD_CM)
    db.add(actor)
    db.flush()
    request = requests[kind]
    db.delete(requests["dast" if kind == "sast" else "sast"])
    db.flush()
    request.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
    db.add(models.ApprovalAction(
        entity_type="SAST_DAST",
        entity_id=request.id,
        step_name="SM Approval",
        actor_id=actor.id,
        actor_role=actor.roles_csv,
        decision="Approved",
    ))
    db.commit()
    actor.active_qa_workspace_id = owner_workspace.id

    with workspace_context(owner_workspace.id, (owner_workspace.id,)):
        with pytest.raises(HTTPException) as denied:
            if kind == "sast":
                sast_dast.sast_department_head_decision(
                    request.id,
                    schemas.SecurityDeptHeadDecisionIn(decision="Approved"),
                    db=db,
                    current_user=actor,
                )
            else:
                sast_dast.dast_department_head_decision(
                    request.id,
                    schemas.SecurityDeptHeadDecisionIn(decision="Approved"),
                    db=db,
                    current_user=actor,
                )

    assert denied.value.status_code == 403


def test_project_lifecycle_mutations_reject_shared_foreign_workspace():
    db = _session()
    owner_workspace = models.QAWorkspace(workspace_key="PROJECT", name="Project", is_active=True)
    foreign_workspace = models.QAWorkspace(workspace_key="SHARED", name="Shared", is_active=True)
    owner = _user("project-owner", Role.QA_LEAD)
    foreign_lead = _user("foreign-project-lead", Role.QA_LEAD)
    db.add_all([owner_workspace, foreign_workspace, owner, foreign_lead])
    db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=foreign_workspace.id,
        user_id=foreign_lead.id,
        role="WORKSPACE_MEMBER",
        is_active=True,
    ))
    project = models.TestProject(
        project_key="TQA-PRJ-SCOPE",
        name="Scoped Project",
        qa_workspace_id=owner_workspace.id,
        owner_id=owner.id,
        created_by_id=owner.id,
        is_active=True,
        is_archived=False,
        pending_is_active=False,
        pending_requested_by_id=owner.id,
    )
    db.add(project)
    db.flush()
    db.add(models.TestProjectViewGrant(
        project_id=project.id,
        workspace_id=foreign_workspace.id,
        granted_by_id=owner.id,
    ))
    db.commit()
    foreign_lead.active_qa_workspace_id = foreign_workspace.id

    actions = [
        lambda: test_projects.update_test_project(
            project.id,
            schemas.TestProjectUpdate(is_active=False),
            db=db,
            current_user=foreign_lead,
        ),
        lambda: test_projects.review_project_activation(
            project.id,
            schemas.TestProjectActivationReview(decision="APPROVE"),
            db=db,
            current_user=foreign_lead,
        ),
        lambda: test_projects.archive_test_project(
            project.id,
            schemas.TestProjectArchive(reason="retire"),
            db=db,
            current_user=foreign_lead,
        ),
        lambda: test_projects.unarchive_test_project(
            project.id,
            db=db,
            current_user=foreign_lead,
        ),
    ]
    with workspace_context(foreign_workspace.id, (foreign_workspace.id,)):
        for action in actions:
            with pytest.raises(HTTPException) as denied:
                action()
            assert denied.value.status_code == 403


def test_test_project_expression_indexes_enforce_both_business_keys():
    db = _session()
    first_application = models.ApplicationMaster(
        name="Application One", department="Technology", status="APPROVED",
    )
    second_application = models.ApplicationMaster(
        name="Application Two", department="Technology", status="APPROVED",
    )
    db.add_all([first_application, second_application])
    db.flush()
    db.add(models.TestProject(
        project_key="TQA-PRJ-ONE",
        name="Unique Project",
        application_master_id=first_application.id,
        is_archived=False,
    ))
    db.commit()

    db.add(models.TestProject(
        project_key="TQA-PRJ-TWO",
        name="  unique project  ",
        application_master_id=second_application.id,
        is_archived=False,
    ))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()

    db.add(models.TestProject(
        project_key="TQA-PRJ-THREE",
        name="Another Project",
        application_master_id=first_application.id,
        is_archived=False,
    ))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()

    # Archived history is intentionally excluded from the Application index.
    db.add(models.TestProject(
        project_key="TQA-PRJ-ARCHIVED",
        name="Archived Project",
        application_master_id=first_application.id,
        is_archived=True,
    ))
    db.commit()


def test_project_name_preflight_matches_trimmed_expression_index():
    db = _session()
    db.add(models.TestProject(
        project_key="TQA-PRJ-PADDED",
        name="  Legacy Padded Name  ",
        is_archived=False,
    ))
    db.commit()

    with pytest.raises(HTTPException) as conflict:
        test_projects._require_unique_project_name(db, "Legacy Padded Name")

    assert conflict.value.status_code == 409
    assert "Legacy Padded Name" in str(conflict.value.detail)


def test_uniqueness_migration_duplicate_scan_is_sqlite_safe():
    migration_path = (
        Path(__file__).parents[1]
        / "alembic/versions/d2f4a6c8e105_enforce_test_project_uniqueness.py"
    )
    spec = importlib.util.spec_from_file_location("test_project_uniqueness_migration", migration_path)
    migration = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(migration)

    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE qap_test_projects ("
            "name VARCHAR(150), application_master_id INTEGER, is_archived BOOLEAN)"
        ))
        connection.execute(text(
            "INSERT INTO qap_test_projects "
            "(name, application_master_id, is_archived) VALUES "
            "(' Name ', 1, 0), ('name', 1, NULL), ('Other', 1, 1)"
        ))
        name_rows, application_rows = migration._duplicate_samples(connection)

    assert name_rows == [("NAME", 2)]
    assert application_rows == [(1, 2)]
