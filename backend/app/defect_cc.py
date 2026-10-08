"""Workspace-scoped, passive defect followers and their durable selections."""
from fastapi import HTTPException
from sqlalchemy import select

from . import models


def candidates(db, workspace_id):
    members = select(models.QAWorkspaceMember.user_id).where(
        models.QAWorkspaceMember.workspace_id == workspace_id,
        models.QAWorkspaceMember.is_active == True,
    )
    return db.query(models.User).filter(
        models.User.id.in_(members), models.User.is_active == True,
        models.User.show_in_user_dropdowns == True,
    ).order_by(models.User.full_name, models.User.id)


def replace(db, defect, user_ids, actor):
    ids = sorted(set(user_ids))
    if any(user_id <= 0 for user_id in ids):
        raise HTTPException(400, 'Select valid CC users')
    previous = set(defect.cc_user_ids)
    added = set(ids) - previous
    eligible = {}
    workspace_id = defect.qa_workspace_id or (defect.qa_request.qa_workspace_id if defect.qa_request else None)
    if added:
        eligible = {user.id: user for user in candidates(db, workspace_id).filter(models.User.id.in_(added)).all()} if workspace_id else {}
        if set(eligible) != added:
            raise HTTPException(400, 'CC users must be active members of the defect workspace')
    if previous == set(ids):
        return False
    defect.cc_entries = [entry for entry in defect.cc_entries if entry.user_id in ids]
    defect.cc_entries.extend(models.DefectCCUser(user_id=user_id, user=eligible[user_id], added_by_id=actor.id) for user_id in sorted(added))
    defect.updated_at = models.now()
    return True


def notification_ids(db, defect):
    """Recheck membership at delivery routing; old CC is never an access grant."""
    workspace_id = defect.qa_workspace_id or (defect.qa_request.qa_workspace_id if defect.qa_request else None)
    if not workspace_id or not defect.cc_user_ids:
        return set()
    members = select(models.QAWorkspaceMember.user_id).where(
        models.QAWorkspaceMember.workspace_id == workspace_id,
        models.QAWorkspaceMember.is_active == True,
    )
    return {user_id for (user_id,) in db.query(models.User.id).filter(
        models.User.id.in_(defect.cc_user_ids), models.User.id.in_(members), models.User.is_active == True,
    ).all()}
