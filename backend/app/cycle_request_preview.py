"""Short-lived, scoped preview receipts with an immutable audit trail.

Preview tokens are signed with a purpose-specific key and cannot authenticate
portal sessions. Confirmation and application are separate audit events; a
receipt row lock serializes one-time application with the cycle transaction.
"""
import datetime
import hashlib
import hmac
import json
import uuid

import jwt
from fastapi import HTTPException

from . import models
from .config import settings

AUDIENCE = "qualityops-cycle-request-preview-v1"
MAX_AGE = datetime.timedelta(hours=1)


def refresh_parent(db, request, lock=False):
    if request.qa_request_id:
        query = db.query(models.QARequest).filter_by(id=request.qa_request_id).populate_existing()
        if lock:
            query = query.with_for_update()
        query.one_or_none()


def _key():
    return hmac.new(settings.secret_key.encode(), AUDIENCE.encode(), hashlib.sha256).digest()


def snapshot(request):
    parent = request.qa_request
    fields = ("request_id", "application_name", "application_master_id", "module_name",
              "cr_number", "epic_number", "change_type", "business_defect_number",
              "change_description", "department", "environment", "target_promotion_environment",
              "release_version", "build_number", "target_release_date", "requester_id", "status", "updated_at")
    value = {name: getattr(request, name, None) for name in fields}
    value.update(qa_request_id=request.qa_request_id, qa_workspace_id=parent.qa_workspace_id if parent else None,
                 parent_updated_at=parent.updated_at if parent else None,
                 department_unit_id=parent.department_unit_id if parent else None)
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _claims(user, project, request, cycle_id):
    return dict(actor_id=user.id, project_id=project.id, request_id=request.id,
                cycle_id=cycle_id, snapshot=snapshot(request))


def _audit_details(project, request):
    values = [('Functional request', request.request_id), ('Application', request.application_name),
              ('Module', request.module_name), ('Test project', project.project_key),
              ('CR / EPIC', request.cr_number or request.epic_number), ('Change type', request.change_type),
              ('Business defect', request.business_defect_number), ('Environment', request.environment)]
    return [f'{label}: {value}' for label, value in values if value]


def _issue(claims, phase, **extra):
    now = datetime.datetime.now(datetime.UTC)
    return jwt.encode({**claims, **extra, "phase": phase, "aud": AUDIENCE,
                       "iat": now, "exp": now + MAX_AGE, "jti": str(uuid.uuid4())}, _key(), algorithm="HS256")


def loaded(user, project, request, cycle_id):
    return _issue(_claims(user, project, request, cycle_id), "loaded")


def _validate(token, user, project, request, cycle_id, phase):
    try:
        claims = jwt.decode(token or "", _key(), algorithms=["HS256"], audience=AUDIENCE,
                            options={"require": ["aud", "iat", "exp", "jti", "phase", "snapshot"]})
    except jwt.PyJWTError:
        raise HTTPException(409, "Preview the selected Functional QA Request and choose Use this request before saving. The previous preview may have expired.")
    expected = _claims(user, project, request, cycle_id)
    if claims.get("phase") != phase or any(claims.get(key) != value for key, value in expected.items()):
        raise HTTPException(409, "The selected request or preview context changed. Preview the request again and choose Use this request.")
    return claims


def confirm(db, token, user, project, request, cycle_id):
    _validate(token, user, project, request, cycle_id, "loaded")
    cycle = db.get(models.TestCycle, cycle_id) if cycle_id is not None else None
    details = _audit_details(project, request)
    details.append(f'Cycle: {cycle.cycle_key}' if cycle else 'Reviewed for a new Test Cycle.')
    audit = models.ApprovalAction(entity_type="FUNCTIONAL_REQUEST", entity_id=request.id,
        step_name="Test Cycle Preview", actor_id=user.id, actor_role=user.roles_csv,
        decision="Preview Confirmed", comments='\n'.join(details))
    db.add(audit)
    db.flush()
    return _issue(_claims(user, project, request, cycle_id), "confirmed", review_id=audit.id)


def require_confirmed(db, token, user, project, request, cycle_id):
    claims = _validate(token, user, project, request, cycle_id, "confirmed")
    review_id = claims.get("review_id")
    if not isinstance(review_id, int):
        raise HTTPException(409, "Preview confirmation is missing. Preview this request again.")
    review = db.query(models.ApprovalAction).filter_by(id=review_id).populate_existing().with_for_update().one_or_none()
    if not review or (review.entity_type, review.entity_id, review.actor_id, review.decision) != (
            "FUNCTIONAL_REQUEST", request.id, user.id, "Preview Confirmed"):
        raise HTTPException(409, "Preview confirmation is unavailable. Preview this request again.")
    used = db.query(models.ApprovalAction.id).filter_by(entity_type="TEST_CYCLE_PREVIEW", entity_id=review.id,
                                                       decision="Applied").first()
    if used:
        raise HTTPException(409, "This preview confirmation has already been used. Preview the request again for this cycle.")
    return review.id


def applied(db, review_id, cycle, request, user):
    details = '\n'.join([*_audit_details(cycle.project, request), f'Cycle: {cycle.cycle_key}',
                         f'Linked after preview confirmation (audit #{review_id}).'])
    db.add(models.ApprovalAction(entity_type="TEST_CYCLE_PREVIEW", entity_id=review_id,
        step_name="Request Preview", actor_id=user.id, actor_role=user.roles_csv, decision="Applied", comments=details))
    db.add(models.ApprovalAction(entity_type="TEST_CYCLE", entity_id=cycle.id,
        step_name="Request Preview", actor_id=user.id, actor_role=user.roles_csv, decision="Request Preview Applied", comments=details))
