import datetime
import unittest
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import models
from app.constants import Role
from app.routers.pending_approvals import (
    _application_master_items,
    _test_case_items,
    _paginate_pending_items,
    _sm_dept_head_items,
    _suppression_items,
    count_pending_approvals,
)
from app.workspace_service import (
    active_workspace_scope_ids,
    set_current_workspace_id,
    set_current_workspace_scope_ids,
)


def pending_item(category: str, entity_id: int, submitted_at):
    return {
        "category": category,
        "entity_type": "TEST_CASE",
        "entity_id": entity_id,
        "submitted_at": submitted_at,
    }


class PendingApprovalsPaginationTests(unittest.TestCase):
    def test_test_case_queue_is_visible_to_eligible_qa_group_members(self):
        engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(engine)
        with Session(engine) as db:
            workspace = models.QAWorkspace(workspace_key="QA", name="QA", is_active=True)
            author = models.User(username="author", full_name="Author", hashed_password="x", is_active=True,
                                 role_assignments=[models.UserRole(role=Role.QA_ENGINEER)])
            reviewer = models.User(username="reviewer", full_name="Assigned Reviewer", hashed_password="x", is_active=True,
                                   role_assignments=[models.UserRole(role=Role.QA_ENGINEER)])
            other = models.User(username="other", full_name="Other Reviewer", hashed_password="x", is_active=True,
                                role_assignments=[models.UserRole(role=Role.QA_ENGINEER)])
            db.add_all([workspace, author, reviewer, other]); db.flush()
            project = models.TestProject(project_key="TQA-PROJ-01", name="Project", is_active=True,
                                         owner_id=author.id, created_by_id=author.id, qa_workspace_id=workspace.id)
            case = models.TestCase(test_case_key="TQA-TC-01", project=project, created_by_id=author.id)
            draft = models.TestCaseVersion(test_case=case, status="Recommendation Pending", author_id=author.id,
                                           submitted_by_id=author.id, assigned_reviewer_id=reviewer.id,
                                           version_major=1, version_minor=0)
            db.add_all([project, case, draft]); db.flush()
            case.current_draft_version_id = draft.id
            for person in (reviewer, other):
                db.add(models.QAWorkspaceMember(workspace_id=workspace.id, user_id=person.id,
                                                role="WORKSPACE_MEMBER", is_active=True))
            db.commit()

            set_current_workspace_id(workspace.id)
            set_current_workspace_scope_ids({workspace.id})
            try:
                self.assertEqual([item["display_id"] for item in _test_case_items(db, reviewer)], ["TQA-TC-01"])
                self.assertEqual([item["display_id"] for item in _test_case_items(db, other)], ["TQA-TC-01"])
                self.assertEqual(count_pending_approvals(db=db, current_user=reviewer), {"count": 1})
                self.assertEqual(count_pending_approvals(db=db, current_user=other), {"count": 1})
            finally:
                set_current_workspace_id(None)
                set_current_workspace_scope_ids(set())

    def test_shared_project_approvals_follow_creating_workspace_and_maker_checker(self):
        from app.routers.test_repository import _require_stage_group_user
        from fastapi import HTTPException
        engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(engine)
        with Session(engine) as db:
            owner = models.QAWorkspace(workspace_key="OWNER", name="Owner")
            qa = models.QAWorkspace(workspace_key="QA", name="QA")
            users = [models.User(username=name, full_name=name, hashed_password="x", is_active=True,
                                 role_assignments=[models.UserRole(role=Role.QA_ENGINEER)])
                     for name in ("qa1", "qa2")]
            db.add_all([owner, qa, *users]); db.flush()
            for user in users:
                db.add(models.QAWorkspaceMember(workspace_id=qa.id, user_id=user.id,
                                                role="WORKSPACE_MEMBER", is_active=True))
                user.active_qa_workspace_id = qa.id
            project = models.TestProject(project_key="SHARED", name="Shared", is_active=True,
                                         qa_workspace_id=owner.id)
            db.add(project); db.flush()
            grant = models.TestProjectViewGrant(project_id=project.id, workspace_id=qa.id)
            db.add(grant)
            for key, workspace in (("QA-CASE", qa), ("OWNER-CASE", owner)):
                case = models.TestCase(test_case_key=key, project=project, origin_workspace_id=workspace.id)
                draft = models.TestCaseVersion(test_case=case, status="Recommendation Pending",
                                               author_id=users[0].id, submitted_by_id=users[0].id,
                                               version_major=1, version_minor=0)
                db.add_all([case, draft]); db.flush()
                case.current_draft_version_id = draft.id
            db.commit()
            set_current_workspace_id(qa.id)
            set_current_workspace_scope_ids({qa.id, owner.id})
            try:
                self.assertEqual(_test_case_items(db, users[0]), [])
                self.assertEqual([i['display_id'] for i in _test_case_items(db, users[1])], ['QA-CASE'])
                self.assertEqual(count_pending_approvals(db=db, current_user=users[1]), {'count': 1})
                _require_stage_group_user(db, project, users[1], stage=1)
                db.delete(grant); db.commit()
                self.assertEqual(count_pending_approvals(db=db, current_user=users[1]), {'count': 0})
                with self.assertRaises(HTTPException):
                    _require_stage_group_user(db, project, users[1], stage=1)
            finally:
                set_current_workspace_id(None)
                set_current_workspace_scope_ids(set())

    def test_pages_are_oldest_first_with_complete_category_counts(self):
        items = [
            pending_item("Review", 3, datetime.datetime(2026, 8, 3)),
            pending_item("Decision", 2, datetime.datetime(2026, 8, 2, tzinfo=datetime.timezone.utc)),
            pending_item("Review", 1, datetime.datetime(2026, 8, 1)),
        ]
        page = _paginate_pending_items(items, SimpleNamespace(page=1, page_size=2), None)
        self.assertEqual([item["entity_id"] for item in page["items"]], [1, 2])
        self.assertEqual(page["category_counts"], {"Review": 2, "Decision": 1})
        self.assertEqual(page["total"], 3)
        self.assertEqual(page["total_pages"], 2)
        self.assertTrue(page["has_next"])

    def test_count_builds_department_scoped_query_for_non_admin_approver(self):
        engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(engine)
        with Session(engine) as db:
            user = models.User(
                username="scoped-sm",
                full_name="Scoped SM",
                hashed_password="x",
                is_active=True,
                role_assignments=[models.UserRole(role=Role.SM)],
                department_assignments=[models.UserDepartment(department="Operations")],
            )
            db.add(user)
            db.commit()
            db.refresh(user)

            self.assertEqual(count_pending_approvals(db=db, current_user=user), {"count": 0})

    def test_parent_workspace_admin_department_head_sees_pending_approval(self):
        engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(engine)
        with Session(engine) as db:
            parent = models.QAWorkspace(
                workspace_key="DBD", name="DBD", is_active=True,
            )
            requester = models.User(
                username="requester", full_name="Requester", hashed_password="x", is_active=True,
                department="Digital Banking Department - IT",
                department_assignments=[models.UserDepartment(department="Digital Banking Department - IT")],
                role_assignments=[models.UserRole(role=Role.REQUESTER)],
            )
            department_head = models.User(
                username="department-head", full_name="Department Head", hashed_password="x", is_active=True,
                department="Digital Banking Department - IT",
                department_assignments=[models.UserDepartment(department="Digital Banking Department - IT")],
                role_assignments=[models.UserRole(role=Role.DEPARTMENT_HEAD_CM)],
            )
            gateway = models.QARequest(
                request_id="TQA-REQ-01",
                application_name="MOBILE BANKING",
                department="Digital Banking Department - IT",
                requester=requester,
                qa_workspace=parent,
                status="RAISED",
            )
            functional = models.FunctionalRequest(
                request_id="TQA-FUNC-01",
                status="DEPARTMENT_HEAD_APPROVAL_PENDING",
                requester=requester,
                qa_request=gateway,
            )
            db.add_all([parent, requester, department_head, gateway, functional])
            db.flush()
            db.add(models.QAWorkspaceMember(
                workspace_id=parent.id,
                user_id=department_head.id,
                role="PARENT_WORKSPACE_ADMIN",
                is_active=True,
            ))
            db.commit()
            db.refresh(department_head)
            department_head.active_qa_workspace_id = parent.id
            set_current_workspace_id(parent.id)
            set_current_workspace_scope_ids(
                active_workspace_scope_ids(db, department_head, parent.id),
            )
            try:
                items = _sm_dept_head_items(db, department_head)
                self.assertEqual([item["display_id"] for item in items], ["TQA-FUNC-01"])
                self.assertEqual(
                    count_pending_approvals(db=db, current_user=department_head),
                    {"count": 1},
                )
            finally:
                set_current_workspace_id(None)
                set_current_workspace_scope_ids(set())

    def test_second_stage_queue_excludes_the_same_sm_approver(self):
        engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(engine)
        with Session(engine) as db:
            workspace = models.QAWorkspace(workspace_key="QA", name="QA", is_active=True)
            requester = models.User(
                username="requester", full_name="Requester", hashed_password="x", is_active=True,
                department_assignments=[models.UserDepartment(department="Operations")],
                role_assignments=[models.UserRole(role=Role.REQUESTER)],
            )
            approver = models.User(
                username="dual-approver", full_name="Dual Approver", hashed_password="x", is_active=True,
                department_assignments=[models.UserDepartment(department="Operations")],
                role_assignments=[
                    models.UserRole(role=Role.SM),
                    models.UserRole(role=Role.DEPARTMENT_HEAD_CM),
                ],
            )
            gateway = models.QARequest(
                request_id="TQA-REQ-MAKER", application_name="APP", department="Operations",
                requester=requester, qa_workspace=workspace, status="RAISED",
            )
            functional = models.FunctionalRequest(
                request_id="TQA-FUNC-MAKER", qa_request=gateway, requester=requester,
                status="DEPARTMENT_HEAD_APPROVAL_PENDING",
            )
            db.add_all([workspace, requester, approver, gateway, functional])
            db.flush()
            db.add_all([
                models.QAWorkspaceMember(
                    workspace_id=workspace.id, user_id=approver.id,
                    role="WORKSPACE_MEMBER", is_active=True,
                ),
                models.ApprovalAction(
                    entity_type="FUNCTIONAL_REQUEST", entity_id=functional.id,
                    step_name="SM Approval", decision="Approved", actor_id=approver.id,
                ),
            ])
            db.commit()
            approver.active_qa_workspace_id = workspace.id
            set_current_workspace_id(workspace.id)
            set_current_workspace_scope_ids({workspace.id})
            try:
                self.assertEqual(_sm_dept_head_items(db, approver), [])
                self.assertEqual(count_pending_approvals(db=db, current_user=approver), {"count": 0})
            finally:
                set_current_workspace_id(None)
                set_current_workspace_scope_ids(set())

    def test_self_approval_items_are_absent_from_application_and_security_queues(self):
        engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(engine)
        with Session(engine) as db:
            workspace = models.QAWorkspace(workspace_key="QA", name="QA", is_active=True)
            actor = models.User(
                username="dual-role", full_name="Dual Role", hashed_password="x", is_active=True,
                department_assignments=[models.UserDepartment(department="Operations")],
                role_assignments=[
                    models.UserRole(role=Role.REQUESTER),
                    models.UserRole(role=Role.APPLICATION_OWNER),
                    models.UserRole(role=Role.SECURITY_ANALYST),
                ],
            )
            gateway = models.QARequest(
                request_id="TQA-REQ-SELF", application_name="SELF APP", department="Operations",
                requester=actor, qa_workspace=workspace, status="SUBMITTED",
            )
            application = models.ApplicationMaster(
                name="SELF APP", department="Operations", status="PENDING_APP_OWNER",
                requested_by=actor, qa_request=gateway,
            )
            gateway.application_master = application
            suppression = models.SuppressionRequest(
                suppression_id="TQA-SUP-SELF", application_name="SELF APP",
                department="Operations", qa_workspace=workspace,
                created_by_id=actor.id, status="SECURITY_TEAM_VERIFICATION",
            )
            db.add_all([workspace, actor, gateway, application, suppression])
            db.flush()
            db.add(models.QAWorkspaceMember(
                workspace_id=workspace.id, user_id=actor.id,
                role="WORKSPACE_MEMBER", is_active=True,
            ))
            db.commit()
            actor.active_qa_workspace_id = workspace.id
            set_current_workspace_id(workspace.id)
            set_current_workspace_scope_ids({workspace.id})
            try:
                self.assertEqual(_application_master_items(db, actor), [])
                self.assertEqual(_suppression_items(db, actor), [])
                self.assertEqual(count_pending_approvals(db=db, current_user=actor), {"count": 0})
            finally:
                set_current_workspace_id(None)
                set_current_workspace_scope_ids(set())

    def test_category_filter_is_applied_before_pagination(self):
        items = [
            pending_item("Review", 1, None),
            pending_item("Decision", 2, datetime.datetime(2026, 8, 2)),
            pending_item("Review", 3, datetime.datetime(2026, 8, 3)),
        ]
        page = _paginate_pending_items(items, SimpleNamespace(page=2, page_size=1), " Review ")
        self.assertEqual([item["entity_id"] for item in page["items"]], [3])
        self.assertEqual(page["total"], 2)
        self.assertTrue(page["has_previous"])
        self.assertFalse(page["has_next"])
        self.assertEqual(page["category_counts"], {"Review": 2, "Decision": 1})


if __name__ == "__main__":
    unittest.main()
