import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import models
from app.routers import approvals


def _session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    models.Base.metadata.create_all(engine)
    return Session(engine)


def test_restricted_cycle_folder_hides_comments_and_approval_history():
    db = _session()
    try:
        workspace = models.QAWorkspace(workspace_key="QA", name="QA", is_active=True)
        owner = models.User(
            username="owner", full_name="Owner", hashed_password="x", is_active=True,
        )
        outsider = models.User(
            username="finance-user", full_name="Finance User", hashed_password="x", is_active=True,
            department_assignments=[models.UserDepartment(department="Finance")],
        )
        db.add_all([workspace, owner, outsider])
        db.flush()
        project = models.TestProject(
            project_key="TQA-PRJ-SECRET", name="Secret", department="Finance",
            qa_workspace_id=workspace.id, owner_id=owner.id,
        )
        folder = models.TestCycleFolder(
            project=project, name="Restricted", created_by_id=owner.id,
        )
        folder.access_grants.append(models.TestCycleFolderAccess(
            department="Legal", granted_by_id=owner.id,
        ))
        cycle = models.TestCycle(
            project=project, folder=folder,
            cycle_key="TQA-CYC-SECRET", name="Secret Cycle",
        )
        db.add_all([project, folder, cycle])
        db.flush()
        action = models.ApprovalAction(
            entity_type="TEST_CYCLE", entity_id=cycle.id,
            step_name="Cycle", decision="Created", actor_id=owner.id,
        )
        db.add(action)
        db.commit()

        with pytest.raises(HTTPException) as denied:
            approvals._comment_target_or_404(
                db, "TEST_CYCLE", cycle.id, outsider,
            )
        assert denied.value.status_code == 403
        assert approvals._filtered_approval_rows(
            db, outsider, "TEST_CYCLE", cycle.id,
        ) == []
    finally:
        db.close()

