"""Bounded, permission-aware suggestions for the shared Spotlight search."""
import re
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, case, false, func, literal, or_
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_workflow_user, active_qa_workspace_scope_ids, dashboard_department_scope, viewable_project_ids
from ..email_notifications import _portal_link
from .approvals import _comment_target_or_404

router = APIRouter(prefix="/api/search", tags=["global-search"])


class SearchSuggestion(BaseModel):
    entity_type: str
    entity_id: int
    reference: str
    title: str
    category: str
    status: str | None
    change_reference: str | None
    destination: str


_SOURCES = (
    ("QA_REQUEST", models.QARequest, "request_id", "application_name", "QA request"),
    ("FUNCTIONAL_REQUEST", models.FunctionalRequest, "request_id", "application_name", "Functional request"),
    ("SAST", models.SASTRequest, "request_id", "application_name", "SAST request"),
    ("DAST", models.DASTRequest, "request_id", "application_name", "DAST request"),
    ("PERFORMANCE", models.PerformanceRequest, "request_id", "application_name", "Performance request"),
    ("SUPPRESSION", models.SuppressionRequest, "suppression_id", "application_name", "Suppression request"),
    ("SIGNOFF", models.QASignOff, "certificate_id", "application_name", "QA sign-off"),
    ("DEFECT", models.Defect, "defect_key", "title", "Defect"),
    ("TEST_PROJECT", models.TestProject, "project_key", "name", "Test project"),
    ("TEST_CASE", models.TestCase, "test_case_key", "test_scenario", "Test case"),
    ("TEST_CYCLE", models.TestCycle, "cycle_key", "name", "Test cycle"),
)
_CHILD_TYPES = {"FUNCTIONAL_REQUEST", "SAST", "DAST", "PERFORMANCE"}
_PROJECT_TYPES = {"TEST_PROJECT", "TEST_CASE", "TEST_CYCLE"}
_SHORTHAND = re.compile(r"^(FUNC|SAST|DAST|PERF|SIGN|PROJ|TC|CYCLE)-", re.I)


def _candidate_query(db, user, entity_type, model, project_ids):
    workspace_ids = active_qa_workspace_scope_ids(user)
    if entity_type == "DEFECT":
        from .defects import _scoped_defects
        return _scoped_defects(db, user)
    q = db.query(model)
    if entity_type in _CHILD_TYPES:
        q = q.outerjoin(models.QARequest, model.qa_request_id == models.QARequest.id)
        workspace_column, department_column = models.QARequest.qa_workspace_id, models.QARequest.department
    elif entity_type == "SIGNOFF":
        q = q.outerjoin(models.FunctionalRequest, model.testing_request_id == models.FunctionalRequest.request_id)
        q = q.outerjoin(models.QARequest, models.FunctionalRequest.qa_request_id == models.QARequest.id)
        workspace_column, department_column = model.qa_workspace_id, models.QARequest.department
    elif entity_type in _PROJECT_TYPES:
        if entity_type != "TEST_PROJECT":
            q = q.join(models.TestProject, model.project_id == models.TestProject.id)
        if project_ids is not None:
            q = q.filter((model.id if entity_type == "TEST_PROJECT" else model.project_id).in_(project_ids))
        if entity_type == "TEST_CYCLE" and not user.has_role("QA_ENGINEER", "QA_LEAD", "CHIEF_MANAGER_QA", "AGM_QA", "VIEW_ONLY"):
            # Filter restricted folders before the candidate limit, so a run
            # of newer hidden cycles cannot crowd out a visible older match.
            folder = models.TestCycleFolder
            grants = models.TestCycleFolderAccess
            q = q.filter(or_(model.folder_id.is_(None), model.folder.has(or_(
                folder.created_by_id == user.id,
                folder.project.has(models.TestProject.owner_id == user.id),
                ~folder.access_grants.any(),
                folder.access_grants.any(or_(grants.user_id == user.id, grants.department.in_(user.departments))),
            ))))
        return q.filter(model.is_deleted == False) if entity_type == "TEST_CASE" else q  # noqa: E712
    else:
        workspace_column, department_column = model.qa_workspace_id, model.department
    if workspace_ids:
        q = q.filter(workspace_column.in_(workspace_ids))
    scope = dashboard_department_scope(user)
    if scope is not None:
        visible = [department_column.in_(scope)]
        creator_column = model.__table__.c.get("requester_id")
        if creator_column is None:
            creator_column = model.__table__.c.get("created_by_id")
        if creator_column is not None:
            visible.append(creator_column == user.id)
        if entity_type in _CHILD_TYPES | {"QA_REQUEST"}:
            target_type = "FUNCTIONAL" if entity_type == "FUNCTIONAL_REQUEST" else entity_type
            visible.append(models.QARequest.delegations.any(and_(
                models.QARequestDelegation.target_type == target_type,
                models.QARequestDelegation.target_id == model.id,
                models.QARequestDelegation.status == "ACTIVE",
                models.QARequestDelegation.assigned_to_id == user.id,
            )))
        if entity_type == "SUPPRESSION" and user.has_role("DEPARTMENT_HEAD_CM", "DEPARTMENT_HEAD_AGM"):
            visible.append(model.department_approvals.any(models.SuppressionDepartmentApproval.department.has(
                models.Department.name.in_(user.departments))))
        q = q.filter(or_(*visible))
    if entity_type == "QA_REQUEST":
        from .qa_requests import _GATEWAY_PRIVATE_STATUSES
        q = q.filter(or_(model.status.notin_(_GATEWAY_PRIVATE_STATUSES), model.requester_id == user.id,
            model.delegations.any(and_(models.QARequestDelegation.status == "ACTIVE",
                models.QARequestDelegation.assigned_to_id == user.id,
                models.QARequestDelegation.target_type == "QA_REQUEST"))))
    elif entity_type == "SUPPRESSION":
        from .suppression import _apply_private_status_visibility
        q = _apply_private_status_visibility(q, user)
    return q


@router.get("/suggestions", response_model=list[SearchSuggestion])
def search_suggestions(q: str = Query("", max_length=120), limit: int = Query(10, ge=1, le=20),
                       db: Session = Depends(get_db), current_user: models.User = Depends(get_workflow_user)):
    term = q.strip().lower()
    if len(term) < 2:
        return []
    normalized = f"tqa-{term}" if _SHORTHAND.match(term) else term
    ranked = []
    project_ids = viewable_project_ids(db, current_user)
    for order, (entity_type, model, ref_attr, title_attr, category) in enumerate(_SOURCES):
        query = _candidate_query(db, current_user, entity_type, model, project_ids)
        reference = model.__table__.c[ref_attr]
        title = model.__table__.c.get(title_attr)
        if title is None:
            title = models.QARequest.application_name
        change_fields = [model.__table__.c[name] for name in ("cr_number", "epic_number", "epic_id", "related_cr_number") if name in model.__table__.c]
        if entity_type in _CHILD_TYPES | {"SIGNOFF"}:
            change_fields.extend([models.QARequest.cr_number, models.QARequest.epic_number])
        searchable = [title]
        if entity_type == "DEFECT":
            searchable.extend([model.application_name, model.external_defect_id])
        if entity_type in {"TEST_CASE", "TEST_CYCLE"}:
            searchable.append(models.TestProject.name)
        reference_terms = dict.fromkeys((normalized, term))
        reference_match = or_(*(func.lower(reference).contains(value, autoescape=True) for value in reference_terms))
        matches = [reference_match, *(func.lower(column).contains(term, autoescape=True) for column in searchable)]
        # Autocomplete accepts partial references; submitting the raw term
        # still uses the existing exact CR/EPIC/IN search destination.
        matches.extend(func.lower(column).contains(term, autoescape=True) for column in change_fields)
        rank = case((or_(*(func.lower(reference) == value for value in reference_terms)), 0),
                    (or_(false(), *(func.lower(column) == term for column in change_fields)), 1),
                    (reference_match, 2),
                    (func.lower(title).startswith(term, autoescape=True), 3), else_=4)
        # Fetch only the labels needed by the picker. Loading full ORM rows
        # here also loaded large descriptions/JSON and their parent requests
        # for hundreds of candidates which would never reach the screen.
        display_changes = change_fields + ([models.QARequest.cr_number, models.QARequest.epic_number]
                                          if entity_type == "DEFECT" else [])
        columns = [model.id, reference, title, model.__table__.c.get("status", literal(None)),
                   model.created_at, rank, *display_changes]
        for row in query.with_entities(*columns).filter(or_(*matches)).order_by(
                rank, model.created_at.desc(), model.id.desc()).limit(40):
            identifier, ref, title_text, status, created_at, score, *changes = row
            ref = ref or f"Draft #{identifier}"
            change_reference = next((value for value in changes if value and term in value.lower()),
                                    next((value for value in changes if value), None))
            suggestion = SearchSuggestion(entity_type=entity_type, entity_id=identifier, reference=ref,
                title=title_text or ref, category=category, status=status, change_reference=change_reference,
                destination=_portal_link(SimpleNamespace(entity_type=entity_type, entity_id=identifier), ref))
            ranked.append((score, -(created_at.timestamp() if created_at else 0), order, -identifier, suggestion))
    ranked.sort(key=lambda item: item[:4])
    results = []
    for *_, suggestion in ranked:
        try:
            # Authorize in final display order; keep searching after a denial.
            # This retains the detail policies without checking every candidate
            # in every module before returning just ten visible suggestions.
            if suggestion.entity_type != "DEFECT":
                _comment_target_or_404(db, suggestion.entity_type, suggestion.entity_id, current_user,
                                       visible_project_ids=project_ids)
        except HTTPException as exc:
            if exc.status_code not in {403, 404}:
                raise
            continue
        results.append(suggestion)
        if len(results) == limit:
            break
    return results
