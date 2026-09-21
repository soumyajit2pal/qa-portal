from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import models
from app.constants import Role
from app.routers import approvals
from app.workspace_service import workspace_context


def test_comment_target_accepts_record_in_active_workspace():
    """Regression: the department guard must receive the target workspace.

    Previously `_comment_target_or_404` omitted it, so the guard compared the
    active workspace set to `None` and rejected every otherwise-valid comment
    with "This record belongs to another workspace."
    """
    engine = create_engine("sqlite:///:memory:")
    models.Base.metadata.create_all(engine)
    with Session(engine) as db:
        workspace = models.QAWorkspace(workspace_key="QA", name="QA", is_active=True)
        user = models.User(
            username="requester",
            full_name="Requester",
            hashed_password="x",
            is_active=True,
            department_assignments=[models.UserDepartment(department="Technology")],
            role_assignments=[models.UserRole(role=Role.REQUESTER)],
        )
        db.add_all([workspace, user])
        db.flush()
        db.add(models.QAWorkspaceMember(
            workspace_id=workspace.id,
            user_id=user.id,
            role="WORKSPACE_MEMBER",
            is_active=True,
        ))
        request = models.QARequest(
            request_id="TQA-REQ-COMMENT",
            application_name="Comment Test",
            department="Technology",
            requester_id=user.id,
            qa_workspace_id=workspace.id,
            status="RAISED",
        )
        db.add(request)
        db.commit()
        user.active_qa_workspace_id = workspace.id

        with workspace_context(workspace.id, (workspace.id,)):
            assert approvals._comment_target_or_404(
                db, "QA_REQUEST", request.id, user,
            ) == "QA_REQUEST"
