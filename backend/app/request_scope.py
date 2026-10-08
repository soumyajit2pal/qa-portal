"""Approval-requested, additive testing scope; existing child workflows stay intact."""
from fastapi import HTTPException
from . import models
from .constants import FUNCTIONAL_BUCKET_TYPES, GatewayStatus, REQUEST_TYPES
from .request_type_config import inactive_request_types

RETURNED = {"RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD"}


def family(value):
    return "FUNCTIONAL" if value in FUNCTIONAL_BUCKET_TYPES else value


def children(parent):
    return [*parent.linked_functional_requests, *parent.linked_sast_requests,
            *parent.linked_dast_requests, *parent.linked_performance_requests]


def existing_families(parent):
    return {key for key, rows in (
        ("FUNCTIONAL", parent.linked_functional_requests), ("SAST", parent.linked_sast_requests),
        ("DAST", parent.linked_dast_requests), ("Performance Testing", parent.linked_performance_requests),
    ) if rows}


def raised_families(parent):
    return {key for key, rows in (
        ("FUNCTIONAL", parent.linked_functional_requests), ("SAST", parent.linked_sast_requests),
        ("DAST", parent.linked_dast_requests), ("Performance Testing", parent.linked_performance_requests),
    ) if any(row.status not in {"DRAFT", "SUBMITTED", "CANCELLED"} for row in rows)}


def can_add_types(parent):
    linked = children(parent)
    return bool(parent.status == GatewayStatus.RAISED and linked and len(existing_families(parent)) < 4
                and any(row.status in RETURNED for row in linked)
                and not parent.active_delegation
                and not any(row.active_delegation for row in linked if row.status in RETURNED))


def entity_type(child):
    for cls, kind in [(models.FunctionalRequest, "FUNCTIONAL_REQUEST"), (models.SASTRequest, "SAST"),
                      (models.DASTRequest, "DAST"), (models.PerformanceRequest, "PERFORMANCE")]:
        if isinstance(child, cls):
            return kind
    raise ValueError("Unsupported testing request")


def _missing(parent, requirements):
    raised = raised_families(parent)
    required = {value for row in requirements for value in row.required_types.split(",")}
    return [value for value in REQUEST_TYPES if value in required and family(value) not in raised]


def missing_for_parent(parent):
    return _missing(parent, parent.scope_requirements)


def missing_for_child(child):
    if not child.qa_request:
        return []
    kind = entity_type(child)
    missing = _missing(child.qa_request, [row for row in child.qa_request.scope_requirements
                                         if row.entity_type == kind and row.entity_id == child.id])
    staged = child.qa_request.scope_addition_types if child.status in RETURNED else []
    return list(dict.fromkeys([*missing, *staged]))


def lock_parent(db, parent_id):
    parent = (db.query(models.QARequest).filter_by(id=parent_id)
              .populate_existing().with_for_update().one())
    # Fresh links after waiting for another worker's scope submission.
    db.expire(parent, ["linked_functional_requests", "linked_sast_requests", "linked_dast_requests",
                       "linked_performance_requests", "scope_requirements"])
    return parent


def record_return_requirement(db, child, payload, user):
    types = list(dict.fromkeys(getattr(payload, "required_testing_types", [])))
    if not types:
        return
    if payload.decision != "Returned" or not child.qa_request_id:
        raise HTTPException(400, "Additional testing requires a returned request linked to a QA request")
    if any(value not in REQUEST_TYPES for value in types):
        raise HTTPException(400, "Unsupported additional testing type")
    disabled = inactive_request_types(db, types)
    if disabled:
        raise HTTPException(400, "Disabled testing types cannot be required: " + ", ".join(disabled))
    parent = lock_parent(db, child.qa_request_id)
    if not can_add_types(parent):
        raise HTTPException(400, "Additional testing can only be requested during approval; resolve active delegations first")
    if any(family(value) in existing_families(parent) for value in types):
        raise HTTPException(400, "Select only testing types that are not already linked to this QA request")
    db.add(models.QARequestScopeRequirement(
        qa_request_id=parent.id, entity_type=entity_type(child), entity_id=child.id,
        required_types=",".join(types), reason=payload.comments, actor_id=user.id,
    ))
    # Human-readable parent audit; structured requirements are stored separately.
    db.add(models.ApprovalAction(entity_type="QA_REQUEST", entity_id=parent.id,
        step_name="Testing Scope", actor_id=user.id, actor_role=user.roles_csv,
        decision="Additional Testing Required",
        comments=f"{child.request_id}: {', '.join(types)} required. {payload.comments}"))
    payload.comments += "\nRequired additional testing: " + ", ".join(types)


def require_scope_satisfied(db, child):
    if not child.qa_request_id:
        return
    lock_parent(db, child.qa_request_id)
    missing = missing_for_child(child)
    if missing:
        raise HTTPException(400, "Cannot resubmit -- raise the required linked testing request(s) on the same QA request first: " + ", ".join(missing))
