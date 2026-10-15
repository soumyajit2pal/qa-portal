"""Shared Functional Request visibility for registers and traceability pickers."""
from sqlalchemy import and_, or_
from . import models
from .deps import dashboard_department_scope, active_qa_workspace_scope_ids, department_unit_visibility_condition


def visible_functional_requests(db, user):
    q = db.query(models.FunctionalRequest).outerjoin(models.QARequest, models.FunctionalRequest.qa_request_id == models.QARequest.id)
    if dashboard_department_scope(user) is not None:
        delegated = models.QARequest.delegations.any(and_(
            models.QARequestDelegation.target_type == 'FUNCTIONAL',
            models.QARequestDelegation.target_id == models.FunctionalRequest.id,
            models.QARequestDelegation.status == 'ACTIVE',
            models.QARequestDelegation.assigned_to_id == user.id,
        ))
        q = q.filter(or_(department_unit_visibility_condition(db, user, models.QARequest.department, models.QARequest.department_unit_id), delegated))
    workspace_ids = active_qa_workspace_scope_ids(user)
    if workspace_ids:
        q = q.filter(models.QARequest.qa_workspace_id.in_(workspace_ids))
    return q
