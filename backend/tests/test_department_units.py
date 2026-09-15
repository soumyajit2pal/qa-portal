from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from types import SimpleNamespace

from app import models
from app.constants import Role
from app.deps import department_unit_visibility_condition, require_department_unit_visibility
from app.routers.auth import _coordinator_scope_allows, _validated_department_units
from app.routers.qa_requests import _resolve_requester_department_unit
from app.routers.functional import sm_decision
from app.routers import dashboard
from app.schemas import WorkflowDecision
from app.routers.test_projects import _validated_department_unit_id
from app.workspace_service import set_current_workspace_id


def _session():
    engine = create_engine("sqlite:///:memory:")
    models.Base.metadata.create_all(engine)
    return Session(engine)


def test_legacy_units_are_not_saved_on_new_projects():
    db = _session()
    dbd = models.Department(name="DBD IT", is_active=True)
    hr = models.Department(name="HR", is_active=True)
    core = models.DepartmentUnit(department=dbd, name="Core Banking", is_active=True)
    db.add_all([dbd, hr, core]); db.commit()

    assert _validated_department_units(db, [core.id], ["DBD IT"]) == [core]

    try:
        _validated_department_units(db, [core.id], ["HR"])
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 400
    else:
        raise AssertionError("Cross-department unit assignment should be rejected")

    assert _validated_department_unit_id(db, core.id, "DBD IT") is None
    assert _validated_department_unit_id(db, core.id, "HR") is None


def test_legacy_unit_does_not_narrow_department_coordinator_scope():
    db = _session()
    department = models.Department(name="DBD IT", is_active=True)
    core = models.DepartmentUnit(department=department, name="Core Banking", is_active=True)
    payments = models.DepartmentUnit(department=department, parent=core, name="Payments", is_active=True)
    channels = models.DepartmentUnit(department=department, name="Channels", is_active=True)
    workspace = models.QAWorkspace(workspace_key="DBD", name="DBD", is_active=True)
    coordinator = models.User(username="coord", full_name="Coordinator", hashed_password="x", is_active=True)
    core_user = models.User(username="core", full_name="Core User", hashed_password="x", is_active=True)
    channels_user = models.User(username="channels", full_name="Channels User", hashed_password="x", is_active=True)
    db.add_all([department, core, payments, channels, workspace, coordinator, core_user, channels_user]); db.flush()
    coordinator.department_coordinator_assignments.append(models.DepartmentCoordinatorAssignment(
        department=department, department_unit=core, workspace=workspace, is_active=True,
    ))
    coordinator.active_qa_workspace_id = workspace.id
    core_user.department_assignments.append(models.UserDepartment(department="DBD IT"))
    core_user.department_unit_assignments.append(models.UserDepartmentUnit(unit=payments))
    channels_user.department_assignments.append(models.UserDepartment(department="DBD IT"))
    channels_user.department_unit_assignments.append(models.UserDepartmentUnit(unit=channels))
    db.commit()

    assert _coordinator_scope_allows(db, coordinator, core_user)
    assert _coordinator_scope_allows(db, coordinator, channels_user)


def test_legacy_unit_does_not_filter_same_department_requests():
    db = _session()
    department = models.Department(name="Digital Banking Department - IT", is_active=True)
    zenlyfe = models.DepartmentUnit(department=department, name="DBD - ZenLyfe", is_active=True)
    other = models.DepartmentUnit(department=department, name="DBD - Other", is_active=True)
    user = models.User(
        username="requester3", full_name="Requester 3", hashed_password="x", is_active=True,
        department="Digital Banking Department - IT",
        department_assignments=[models.UserDepartment(department="Digital Banking Department - IT")],
        department_unit_assignments=[models.UserDepartmentUnit(unit=zenlyfe)],
        role_assignments=[models.UserRole(role=Role.REQUESTER)],
    )
    db.add_all([department, zenlyfe, other, user]); db.flush()
    db.add_all([
        models.QARequest(application_name="ZEN", department=department.name, department_unit_id=zenlyfe.id),
        models.QARequest(application_name="OTHER", department=department.name, department_unit_id=other.id),
    ]); db.commit(); db.refresh(user)

    condition = department_unit_visibility_condition(
        db, user, models.QARequest.department, models.QARequest.department_unit_id,
    )
    assert [row.application_name for row in db.query(models.QARequest).filter(condition).all()] == ["ZEN", "OTHER"]
    require_department_unit_visibility(db, user, department.name, zenlyfe.id)
    require_department_unit_visibility(db, user, department.name, other.id)


def test_legacy_profile_unit_is_not_saved_on_new_request():
    db = _session()
    department = models.Department(name="Digital Banking Department - IT", is_active=True)
    other = models.DepartmentUnit(department=department, name="DBD - Other", is_active=True)
    user = models.User(
        username="requester7", full_name="Requester 7", hashed_password="x", is_active=True,
        department=department.name,
        department_assignments=[models.UserDepartment(department=department.name)],
        department_unit_assignments=[models.UserDepartmentUnit(unit=other)],
        role_assignments=[models.UserRole(role=Role.REQUESTER)],
    )
    db.add_all([department, other, user]); db.commit(); db.refresh(user)

    assert _resolve_requester_department_unit(db, user, department.name, None) is None


def test_sm_can_approve_same_department_when_workspace_scope_matches():
    db = _session()
    department = models.Department(name="Digital Banking Department - IT", is_active=True)
    zenlyfe = models.DepartmentUnit(department=department, name="DBD - ZenLyfe", is_active=True)
    other = models.DepartmentUnit(department=department, name="DBD - Other", is_active=True)
    requester = models.User(
        username="requester7", full_name="Requester 7", hashed_password="x", is_active=True,
        department=department.name,
        department_assignments=[models.UserDepartment(department=department.name)],
        department_unit_assignments=[models.UserDepartmentUnit(unit=other)],
        role_assignments=[models.UserRole(role=Role.REQUESTER)],
    )
    sm = models.User(
        username="sm3", full_name="SM 3", hashed_password="x", is_active=True,
        department=department.name,
        department_assignments=[models.UserDepartment(department=department.name)],
        department_unit_assignments=[models.UserDepartmentUnit(unit=zenlyfe)],
        role_assignments=[models.UserRole(role=Role.SM)],
    )
    gateway = models.QARequest(
        application_name="ZENLYFE", department=department.name,
        department_unit=other, requester=requester,
    )
    functional = models.FunctionalRequest(
        request_id="TQA-FUNC-02", status="SM_APPROVAL_PENDING",
        requester=requester, qa_request=gateway,
    )
    db.add_all([department, zenlyfe, other, requester, sm, gateway, functional])
    db.commit()

    sm_decision(
        functional.id, WorkflowDecision(decision="Approved", comments="Looks good"),
        db, sm,
    )
    db.refresh(functional)
    assert functional.status == "DEPARTMENT_HEAD_APPROVAL_PENDING"


def test_dashboard_cards_and_drilldowns_ignore_legacy_units():
    db = _session()
    department = models.Department(name="Digital Banking Department - IT", is_active=True)
    zenlyfe = models.DepartmentUnit(department=department, name="DBD - ZenLyfe", is_active=True)
    other = models.DepartmentUnit(department=department, name="DBD - Other", is_active=True)
    user = models.User(
        username="requester3", full_name="Requester 3", hashed_password="x", is_active=True,
        department=department.name,
        department_assignments=[models.UserDepartment(department=department.name)],
        department_unit_assignments=[models.UserDepartmentUnit(unit=zenlyfe)],
        role_assignments=[models.UserRole(role=Role.REQUESTER)],
    )
    own_gateway = models.QARequest(
        application_name="ZENLYFE", department=department.name,
        department_unit=zenlyfe, requester=user, cr_number="CR-ZEN",
    )
    other_gateway = models.QARequest(
        application_name="OTHER", department=department.name,
        department_unit=other, requester=user, cr_number="CR-OTHER",
    )
    own_request = models.FunctionalRequest(
        request_id="TQA-FUNC-ZEN", status="SM_APPROVAL_PENDING",
        requester=user, qa_request=own_gateway,
    )
    other_request = models.FunctionalRequest(
        request_id="TQA-FUNC-OTHER", status="SM_APPROVAL_PENDING",
        requester=user, qa_request=other_gateway,
    )
    db.add_all([department, zenlyfe, other, user, own_gateway, other_gateway,
                own_request, other_request])
    db.commit(); db.refresh(user)

    project_metrics = dashboard.project_wise(None, None, db, user)
    assert project_metrics["metrics"]["active_projects"] == 2

    detail = dashboard.dashboard_attention_detail(
        "active-projects", SimpleNamespace(page=1, page_size=25, search=None),
        None, None, db, user,
    )
    assert {row["project_id"] for row in detail["rows"]} == {"CR-ZEN", "CR-OTHER"}


def test_dashboard_card_and_drilldown_share_authenticated_workspace_scope():
    """The card must never advertise a row that its Open action rejects."""
    db = _session()
    active = models.QAWorkspace(workspace_key="ACTIVE", name="Active", is_active=True)
    other = models.QAWorkspace(workspace_key="OTHER", name="Other", is_active=True)
    user = models.User(
        username="qa", full_name="QA", hashed_password="x", is_active=True,
        department="IT - Software",
        department_assignments=[models.UserDepartment(department="IT - Software")],
        role_assignments=[models.UserRole(role=Role.QA_ENGINEER)],
    )
    db.add_all([active, other, user]); db.flush()
    user.qa_workspace_memberships = [
        models.QAWorkspaceMember(workspace_id=active.id, role="WORKSPACE_MEMBER", is_active=True),
        models.QAWorkspaceMember(workspace_id=other.id, role="WORKSPACE_MEMBER", is_active=True),
    ]
    user.active_qa_workspace_id = active.id
    own_gateway = models.QARequest(
        application_name="ACTIVE APP", department="Business", requester=user,
        cr_number="CR-ACTIVE", qa_workspace_id=active.id,
    )
    other_gateway = models.QARequest(
        application_name="OTHER APP", department="Business", requester=user,
        cr_number="CR-OTHER", qa_workspace_id=other.id,
    )
    db.add_all([
        own_gateway, other_gateway,
        models.FunctionalRequest(request_id="TQA-FUNC-ACTIVE", status="EXECUTION_IN_PROGRESS",
                                 requester=user, qa_request=own_gateway),
        models.FunctionalRequest(request_id="TQA-FUNC-OTHER", status="EXECUTION_IN_PROGRESS",
                                 requester=user, qa_request=other_gateway),
    ])
    db.commit(); db.refresh(user)
    own_functional = db.query(models.FunctionalRequest).filter_by(request_id="TQA-FUNC-ACTIVE").one()
    other_functional = db.query(models.FunctionalRequest).filter_by(request_id="TQA-FUNC-OTHER").one()
    db.add_all([
        models.ApprovalAction(entity_type="FUNCTIONAL_REQUEST", entity_id=own_functional.id,
                              step_name="Execution", actor_id=user.id, actor_role=Role.QA_ENGINEER,
                              decision="Started"),
        models.ApprovalAction(entity_type="FUNCTIONAL_REQUEST", entity_id=other_functional.id,
                              step_name="Execution", actor_id=user.id, actor_role=Role.QA_ENGINEER,
                              decision="Started"),
    ])
    db.commit()

    # Deliberately clear the legacy request-global state. Dashboard scope
    # must still come from the authenticated user, just like detail access.
    set_current_workspace_id(None)
    assert dashboard.project_wise(None, None, db, user)["metrics"]["active_projects"] == 1
    detail = dashboard.dashboard_attention_detail(
        "active-projects", SimpleNamespace(page=1, page_size=25, search=None),
        None, None, db, user,
    )
    assert [row["project_id"] for row in detail["rows"]] == ["CR-ACTIVE"]
    activity = dashboard.recent_activity(None, None, 5, db, user)
    assert [row["request_ref"] for row in activity] == ["TQA-FUNC-ACTIVE"]


def test_tester_roster_uses_qa_role_and_workspace_not_legacy_qa_department():
    db = _session()
    active = models.QAWorkspace(workspace_key="DBD", name="DBD QA", is_active=True)
    other = models.QAWorkspace(workspace_key="COE", name="COE QA", is_active=True)
    viewer = models.User(
        username="lead", full_name="Lead", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role=Role.QA_LEAD)],
    )
    dbd_tester = models.User(
        username="qa4", full_name="QA 4", hashed_password="x", is_active=True,
        department="Digital Banking Department - IT",
        department_assignments=[models.UserDepartment(department="Digital Banking Department - IT")],
        role_assignments=[models.UserRole(role=Role.QA_ENGINEER)],
    )
    coe_tester = models.User(
        username="qa1", full_name="QA 1", hashed_password="x", is_active=True,
        department="IT - Software",
        department_assignments=[models.UserDepartment(department="IT - Software")],
        role_assignments=[models.UserRole(role=Role.QA_ENGINEER)],
    )
    db.add_all([active, other, viewer, dbd_tester, coe_tester]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=active.id, user_id=viewer.id, role="WORKSPACE_MEMBER", is_active=True),
        models.QAWorkspaceMember(workspace_id=active.id, user_id=dbd_tester.id, role="WORKSPACE_MEMBER", is_active=True),
        models.QAWorkspaceMember(workspace_id=other.id, user_id=coe_tester.id, role="WORKSPACE_MEMBER", is_active=True),
    ])
    db.commit(); db.refresh(viewer)
    viewer.active_qa_workspace_id = active.id

    assert [user.username for user in dashboard._workspace_qa_testers(db, viewer)] == ["qa4"]
