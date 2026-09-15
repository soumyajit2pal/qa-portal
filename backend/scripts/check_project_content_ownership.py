"""Read-only check of the Oracle ownership migration and serialized access state."""
from app.database import SessionLocal
from app import models, schemas
from app.project_workspace_ownership import bind_actor

with SessionLocal() as db:
    user = db.query(models.User).filter(models.User.username == 'admin').first()
    assert user is not None
    for model in (models.TestCase, models.TestCycle, models.TestFolder, models.TestCycleFolder):
        total = db.query(model).count()
        missing = db.query(model).filter(model.origin_workspace_id.is_(None)).count()
        print(model.__name__, 'records:', total, 'without creating workspace:', missing)
        assert missing == 0
    case = db.query(models.TestCase).first()
    if case:
        user.active_qa_workspace_id = case.origin_workspace_id
        bind_actor(db, user)
        data = schemas.TestCaseOut.model_validate(case)
        assert data.workspace_writable and data.origin_workspace_name
        user.active_qa_workspace_id = -1
        assert not schemas.TestCaseOut.model_validate(case).workspace_writable
        print('Testcase ownership and read-only serialization verified.')
    db.rollback()
