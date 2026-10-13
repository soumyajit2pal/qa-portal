"""Save module names in the request transaction; modules never need approval."""
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import models


def save_module_name(db: Session, *, workspace_id: int, application_id: int,
                     name: str | None) -> str | None:
    normalized = " ".join((name or "").split()).upper()
    if not normalized:
        return None
    if len(normalized) > 150:
        raise ValueError("Module Name must be 150 characters or fewer")
    query = db.query(models.ApplicationModule).filter_by(
        qa_workspace_id=workspace_id, application_master_id=application_id, name=normalized,
    )
    if query.first() is None:
        # The unique constraint also protects simultaneous requests introducing
        # the same name. A savepoint keeps their surrounding request intact.
        try:
            with db.begin_nested():
                db.add(models.ApplicationModule(
                    qa_workspace_id=workspace_id, application_master_id=application_id, name=normalized,
                ))
                db.flush()
        except IntegrityError:
            if query.first() is None:
                raise
    return normalized


def list_module_names(db: Session, *, workspace_id: int, application_name: str) -> list[str]:
    catalogue = (db.query(models.ApplicationModule.name.label("name"))
            .join(models.ApplicationMaster, models.ApplicationModule.application_master_id == models.ApplicationMaster.id)
            .filter(models.ApplicationModule.qa_workspace_id == workspace_id,
                    models.ApplicationMaster.name == application_name.strip().upper()))
    # Standalone defects may name an application outside the master catalogue.
    # Reuse their modules without creating an application approval request.
    defect_modules = db.query(models.Defect.module_name.label("name")).filter(
        models.Defect.qa_workspace_id == workspace_id,
        func.upper(models.Defect.application_name) == application_name.strip().upper(),
        models.Defect.module_name.isnot(None),
    )
    rows = catalogue.union(defect_modules).order_by("name").all()
    return [row[0] for row in rows]


def save_defect_module(db: Session, *, workspace_id: int | None, application_name: str,
                       name: str | None) -> str | None:
    normalized = " ".join((name or "").split()).upper() or None
    if not normalized:
        return None
    if len(normalized) > 150:
        raise ValueError("Module Name must be 150 characters or fewer")
    application = db.query(models.ApplicationMaster).filter_by(name=application_name.strip().upper()).first()
    if application and workspace_id:
        return save_module_name(db, workspace_id=workspace_id, application_id=application.id, name=normalized)
    return normalized
