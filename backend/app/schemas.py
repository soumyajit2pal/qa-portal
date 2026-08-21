import datetime
import re
from typing import Optional, List, Dict, Literal
from pydantic import BaseModel, ConfigDict, field_validator, model_validator

RICH_TEXT_MAX_LENGTH = 10000


def _limited_rich_text(value, info):
    if value is not None and len(value) > RICH_TEXT_MAX_LENGTH:
        label = info.field_name.replace("_", " ").title()
        raise ValueError(
            f"{label} cannot exceed {RICH_TEXT_MAX_LENGTH:,} characters; "
            f"remove {len(value) - RICH_TEXT_MAX_LENGTH:,} characters"
        )
    return value


def _plain_person_name(value):
    """Legacy demo accounts embedded request context in full_name (for
    example, 'SM 1 Of Req 1'). Display only the person's name everywhere."""
    if not isinstance(value, str):
        return value
    return re.sub(r"\s+of\s+req\s+\d+\s*$", "", value, flags=re.IGNORECASE).strip()


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------- Auth / Users ----------------
class Token(ORMModel):
    access_token: str
    token_type: str = "bearer"
    roles: List[str]
    full_name: str
    username: str

    _normalize_full_name = field_validator("full_name", mode="before")(_plain_person_name)


class UserOut(ORMModel):
    id: int
    username: str
    full_name: str
    email: Optional[str] = None
    # 2026-08 "one user can be on multiple departments" CR -- `department`
    # (singular) is kept for every existing consumer that only expects one
    # value. It's the raw legacy column, but every write path now keeps it
    # in sync with models.User.primary_department (the FIRST department
    # assigned -- see routers/auth.py::_sync_primary_department), so it
    # never goes stale. `departments` (plural) is the real, complete list --
    # new code should read that instead.
    department: Optional[str] = None
    departments: List[str] = []
    roles: List[str]
    login_type: str
    is_active: bool
    needs_role_review: bool = False
    # True right after first-ever LDAP login until the person picks their own
    # department via PATCH /api/auth/me -- see models.User.needs_department_selection.
    needs_department_selection: bool = False
    # System-Admin-only flag -- see models.User.admin_managed_only. When True,
    # this user is hidden from Department Admin / Executive  local-admin
    # rosters and only a System Admin can reassign their role(s) or status.
    admin_managed_only: bool = False

    _normalize_full_name = field_validator("full_name", mode="before")(_plain_person_name)


class UserSummaryOut(BaseModel):
    """SRS 7.2 pagination rollout -- backs Admin.tsx's account-summary strip
    and sidebar-nav badge, computed via SQL COUNT instead of `.length` over
    the (now-paginated) full directory fetch."""
    total: int
    active_count: int
    ldap_count: int
    review_count: int


class UserCreate(BaseModel):
    username: str
    full_name: str
    email: Optional[str] = None
    # 2026-08 "one user can be on multiple departments" CR -- `departments`
    # (plural) is the new field Admin.tsx now sends; `department` (singular)
    # is kept accepted for backward compatibility (e.g. any older client/
    # script), and is treated as a single-item department list if
    # `departments` itself isn't provided. See routers/auth.py::create_user.
    department: Optional[str] = None
    departments: Optional[List[str]] = None
    roles: List[str]                    # a user must be assigned at least one role
    login_type: str = "STANDARD"       # STANDARD / LDAP
    password: Optional[str] = None      # required when login_type == STANDARD; ignored for LDAP


class UserUpdate(BaseModel):
    """Admin-only partial update -- role reassignment, activation, login-type change, etc.
    `roles`, if provided, REPLACES the user's full set of assigned roles.
    `departments`, if provided, REPLACES the user's full set of assigned
    departments (2026-08 CR) -- `department` (singular) is kept accepted for
    backward compatibility and is treated the same as a one-item
    `departments` list when `departments` itself isn't provided."""
    full_name: Optional[str] = None
    email: Optional[str] = None
    department: Optional[str] = None
    departments: Optional[List[str]] = None
    roles: Optional[List[str]] = None
    login_type: Optional[str] = None
    is_active: Optional[bool] = None
    needs_role_review: Optional[bool] = None
    # See models.User.admin_managed_only -- only reachable through this
    # Admin-only endpoint (require_roles(Role.ADMIN)), never through
    # LocalAdminUserUpdate below, so a Department Head/Executive  can
    # never set or clear this on anyone, including themselves.
    admin_managed_only: Optional[bool] = None


class PasswordReset(BaseModel):
    new_password: str


class LocalAdminUserUpdate(BaseModel):
    """Body for PATCH /api/auth/local-admin/users/{id} -- a Department Head's
    (or Executive 's, for the QA department) deliberately narrower
    counterpart to the Admin-only UserUpdate above. Only `roles` (constrained
    server-side to DEPARTMENT_ADMIN_ASSIGNABLE_ROLES or
    QA_ADMIN_ASSIGNABLE_ROLES depending on which kind of local admin is
    calling -- see routers/auth.py::_local_admin_assignable_roles) and
    `is_active` may be touched this way -- no department, login type,
    profile fields, or password. See routers/auth.py::update_local_admin_user."""
    roles: Optional[List[str]] = None
    is_active: Optional[bool] = None


class DepartmentSelection(BaseModel):
    """Exactly one primary department chosen during first-time LDAP onboarding."""
    department: str

    @field_validator("department")
    @classmethod
    def validate_primary_department(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Select your primary department")
        return normalized


class AuditLogOut(ORMModel):
    id: int
    event_type: str
    action: str
    outcome: str
    actor_id: Optional[int] = None
    actor_username: Optional[str] = None
    actor_name: Optional[str] = None
    actor_roles: Optional[str] = None
    method: Optional[str] = None
    path: Optional[str] = None
    status_code: Optional[int] = None
    target_type: Optional[str] = None
    target_id: Optional[str] = None
    target_name: Optional[str] = None
    details: Optional[str] = None
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    request_id: Optional[str] = None
    created_at: datetime.datetime


class AuditSummary(BaseModel):
    total: int
    failed: int
    authentication: int
    access_management: int


# ---------------- Module 1: QA Request ----------------
class ChecklistItemOut(ORMModel):
    id: int
    item: str
    owner: Optional[str] = None
    is_mandatory: bool
    requester_checked: bool = False
    is_complete: bool
    approved_by_id: Optional[int] = None
    approved_at: Optional[datetime.datetime] = None


class ChecklistItemUpdate(BaseModel):
    is_complete: bool


class LinkedRequestRef(ORMModel):
    """Minimal cross-reference between a QA Request and an auto-linked SAST/DAST
    request (or vice versa) -- just enough for the UI to show a badge/link
    without pulling the full nested payload (findings, etc.). Also carries
    Priority/Risk so the QA Request gateway's own list/detail views can show
    a per-type breakdown (see models.FunctionalRequest for why Priority/Risk
    moved off the gateway) -- only one of risk_rating (Functional)/
    risk_category (SAST/DAST/Performance) is ever populated for a
    given row; each model exposes both as a real column or a None-returning
    property so this shape works uniformly across all 4 linked-request
    types."""
    id: int
    request_id: str
    status: Optional[str] = None
    priority: Optional[str] = None
    risk_rating: Optional[str] = None
    risk_category: Optional[str] = None


class LinkedSuppressionRef(ORMModel):
    """Minimal cross-reference the other direction from LinkedRequestRef --
    one of the Suppression / False Positive requests raised against a given
    SAST/DAST request (see models.SASTRequest.suppressions/
    models.DASTRequest.suppressions). Lets a SAST/DAST request's own Overview
    show "Suppression Requested? Yes/No" and, if Yes, which suppression
    id(s), without pulling the full nested SuppressionOut payload (items,
    approval decisions, etc.)."""
    id: int
    suppression_id: str
    status: Optional[str] = None


class QARequestDocumentOut(ORMModel):
    id: int
    file_name: str
    content_type: Optional[str] = None
    file_size: Optional[int] = None
    uploaded_by_id: Optional[int] = None
    uploaded_at: datetime.datetime


class RequestDocumentOut(ORMModel):
    """Same shape as QARequestDocumentOut, for the generic
    models.RequestDocument table used by every other module (Functional/
    SAST/DAST/Performance/Suppression/Sign-off)."""
    id: int
    file_name: str
    content_type: Optional[str] = None
    file_size: Optional[int] = None
    uploaded_by_id: Optional[int] = None
    uploaded_at: datetime.datetime


class DraftChecklistEvidenceOut(RequestDocumentOut):
    """Response shape for GET /{req_id}/checklist-evidence/documents -- the
    batched counterpart to list_draft_checklist_evidence (routers/
    qa_requests.py), which returns just one checklist item's own documents at
    a time. `kind`/`item_index` tag each row so the frontend can regroup this
    one flat list back into per-item buckets itself (see ChecklistEvidencePicker.
    tsx's own evidenceKey(kind, item_index) helper -- the same keying used
    client-side for not-yet-uploaded pending files)."""
    kind: str
    item_index: int


class ChecklistItemDocumentOut(RequestDocumentOut):
    """Response shape for GET .../checklist/documents -- the batched
    counterpart, once per request (Functional/SAST/DAST/Performance), to the
    per-item list_*_checklist_documents endpoints below. ChecklistEvidence
    (frontend/src/components/Common.tsx) renders one instance per readiness
    checklist item on a raised request's detail page, and each independently
    fired its own GET on mount -- reported directly via server logs showing
    8 parallel .../checklist/{item_id}/documents calls for one Functional
    request with 8 checklist items. `item_id` tags each row so the frontend
    can regroup this one flat list back into its existing per-item buckets,
    same idea as DraftChecklistEvidenceOut above for the pre-raise wizard."""
    item_id: int


class SASTComponentIn(BaseModel):
    """One repository row -- Repository URL/Branch/Commit ID/Tech Stack/Build
    Number all belong together (see RepeatableGroupInput on the SAST form and
    the QA Request wizard's SAST step) -- one full row per repository, added
    via the "+" button. Used both to seed a brand-new SASTRequest's
    components from the QA Request wizard, and to replace an existing
    SASTRequest's components wholesale on edit (see SASTUpdate below).
    Replaces the old design where all 5 fields were comma-joined into a
    single column each (e.g. build_number = "1.1, 1.1") -- one real row per
    repository now (see models.SASTComponent)."""
    repository_url: Optional[str] = None
    git_branch: Optional[str] = None
    commit_id: Optional[str] = None
    technology_stack: Optional[str] = None
    build_number: Optional[str] = None


class SASTComponentOut(ORMModel):
    id: int
    repository_url: Optional[str] = None
    git_branch: Optional[str] = None
    commit_id: Optional[str] = None
    technology_stack: Optional[str] = None
    build_number: Optional[str] = None


class DASTTargetIn(BaseModel):
    """One scan target row -- Application URL/Environment/Authentication
    Required/Test Credentials all belong together (see RepeatableRows on the
    DAST form and the QA Request wizard's DAST step) -- one full row per
    target URL, added via the "+" button. Replaces the old design where all
    4 fields were newline-joined into a single column each (see
    models.DASTTarget)."""
    application_url: Optional[str] = None
    environment: Optional[str] = None
    authentication_required: Optional[str] = None   # "Yes"/"No"
    test_credentials: Optional[str] = None


class DASTTargetOut(ORMModel):
    id: int
    application_url: str
    environment: Optional[str] = None
    authentication_required: Optional[str] = None
    # Sensitive -- masked out per-row for unauthorized viewers; see
    # _dast_out in routers/sast_dast.py.
    test_credentials: Optional[str] = None


class QARequestCreate(BaseModel):
    department: Optional[str] = None
    application_name: str
    application_owner: Optional[str] = None
    cr_number: Optional[str] = None
    epic_number: Optional[str] = None
    change_type: Optional[str] = None
    bug_fix_source_request_id: Optional[str] = None
    vendor_si_partner: Optional[str] = None
    technology_stack: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    environment: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    request_types: List[str] = []
    target_release_date: Optional[datetime.date] = None
    supporting_doc_path: Optional[str] = None
    remarks: Optional[str] = None
    # Mandatory in the wizard (see DetailsStep.tsx/validation.ts's
    # REQUIRED_DETAIL_FIELDS) -- Optional here like every other UI-mandatory
    # field on this schema (application_owner, cr_number, technology_stack,
    # ...), matching QARequest.change_description's own comment.
    change_description: Optional[str] = None
    # Readiness checklist items the requester is self-declaring as already
    # satisfied (matched by item text against DEFAULT_CHECKLIST_ITEMS). This
    # is informational for the QA Lead, who still independently verifies
    # every item -- see requester_checked on ReadinessChecklistItem.
    checked_items: List[str] = []

    # ---- Priority + Risk Category/Rating are per-request-type, not a single
    # shared "Classification" value at gateway level anymore -- the same
    # change can reasonably need SAST done at lower priority
    # while Performance Testing on the same change is high priority. Each
    # pair is shown/collected only while its matching request type is ticked
    # in request_types, and seeds that type's own request at raise time (see
    # routers/qa_requests.py::_sync_linked_child_requests). None of these are
    # columns on QARequest itself -- staged on draft_child_details until
    # submit, same as sast_components/performance_* etc. below.
    functional_priority: Optional[str] = None
    functional_risk_rating: Optional[str] = None

    # ---- Shown/collected on this form only while "SAST" is ticked in
    # request_types -- used to seed the auto-created SASTRequest's components
    # at raise time (see routers/qa_requests.py::_sync_linked_child_requests)
    # instead of leaving them as placeholders. Not stored on QARequest itself
    # (staged on draft_child_details until submit -- see qa_requests.py);
    # once raised, further edits happen on the SAST request's own page. One
    # entry per repository, added via the "+" button.
    sast_components: List[SASTComponentIn] = []
    sast_priority: Optional[str] = None
    sast_risk_category: Optional[str] = None
    # Optional -- collected alongside Repository Details on this step now
    # (see SASTRequest.hash_value); not required to raise the request.
    sast_hash_value: Optional[str] = None
    # Security Readiness checklist self-declaration -- same pattern as
    # checked_items above, for SAST's own checklist
    # (see constants.DEFAULT_SAST_CHECKLIST_ITEMS). Unlike the others, a
    # mandatory item here also blocks the SAST request's own Submit later if
    # left unticked -- see routers/sast_dast.py::_require_checklist_ready.
    sast_checked_items: List[str] = []

    # ---- Shown/collected on this form only while "DAST" is ticked in
    # request_types -- same idea, seeds the auto-created DASTRequest's
    # targets. One entry per target URL, added via the "+" button -- no
    # separate target_release here, Target Release Date is already collected
    # once above.
    dast_components: List[DASTTargetIn] = []
    dast_priority: Optional[str] = None
    dast_risk_category: Optional[str] = None
    # Security Readiness checklist self-declaration for DAST's own checklist
    # (see constants.DEFAULT_DAST_CHECKLIST_ITEMS) -- same idea as
    # sast_checked_items above.
    dast_checked_items: List[str] = []

    # ---- Shown/collected on this form only while "Performance Testing" is
    # ticked in request_types (Annexure VIII) -- seeds the auto-created
    # PerformanceRequest, including its 19-item pre-testing checklist.
    # change_type/vendor_si_partner/technology_stack/release_version/
    # build_number/target_promotion_environment are deliberately NOT
    # collected again here -- they're already collected once on the gateway's
    # own "Application & Change Details" step (see change_type etc above) and
    # are delegated straight from there when the PerformanceRequest is
    # created (see routers/qa_requests.py::_sync_linked_child_requests).
    # hash_value has no gateway equivalent, so it's simply left blank at
    # intake and can be filled in later on the Performance request's own page.
    performance_request_type: Optional[str] = None       # comma-separated Load/Stress/Spike Testing
    performance_priority: Optional[str] = None
    performance_risk_category: Optional[str] = None
    # Reported directly: Performance testing is never run against Dev or
    # SIT, regardless of the gateway's own Deployment Environment -- so
    # unlike every other field in this block, this one is NOT delegated from
    # the gateway; it's its own mandatory ask on the Performance wizard step,
    # restricted to constants.POST_SIT_ENVIRONMENTS (UAT/Pre-Production/
    # Production). Enforced server-side in
    # routers/qa_requests.py::submit_request.
    performance_environment: Optional[str] = None
    # Readiness checklist self-declaration -- same pattern as checked_items
    # above, for Performance's own 19-item "L1:
    # Pre-Testing Readiness Checklist" (see constants.
    # DEFAULT_PERFORMANCE_CHECKLIST_ITEMS).
    performance_checked_items: List[str] = []


class QARequestUpdate(QARequestCreate):
    application_name: Optional[str] = None


class QARequestDelegationCreate(BaseModel):
    assigned_to_id: int
    reason: str


class QARequestDelegationClose(BaseModel):
    comments: str


class QARequestDelegationOut(ORMModel):
    id: int
    qa_request_id: int
    target_type: str
    target_id: int
    assigned_by_id: int
    assigned_to_id: int
    assigned_by_name: Optional[str] = None
    assigned_to_name: Optional[str] = None
    assignment_reason: str
    status: str
    assigned_at: datetime.datetime
    closed_by_id: Optional[int] = None
    closed_by_name: Optional[str] = None
    returned_at: Optional[datetime.datetime] = None
    return_comments: Optional[str] = None


class QARequestOut(ORMModel):
    """The QA Request is a pure intake/gateway record -- `status` here is just
    Draft/Submitted/Raised/Cancelled (see constants.GatewayStatus). The real
    workflow state lives on whichever linked child request(s) below were
    auto-raised (see FunctionalOut for the Functional/Sanity/Regression
    Testing/UAT Support bucket's own full lifecycle)."""
    id: int
    # Optional -- unlike every other business ID in this app, this one is not
    # assigned at Draft-creation time (see models.QARequest.request_id's
    # column comment); it stays null until the gateway is actually raised.
    request_id: Optional[str] = None
    request_date: Optional[datetime.date] = None
    department: Optional[str] = None
    application_name: str
    application_owner: Optional[str] = None
    cr_number: Optional[str] = None
    epic_number: Optional[str] = None
    change_type: Optional[str] = None
    bug_fix_source_request_id: Optional[str] = None
    vendor_si_partner: Optional[str] = None
    technology_stack: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    environment: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    request_types: Optional[str] = None
    target_release_date: Optional[datetime.date] = None
    supporting_doc_path: Optional[str] = None
    remarks: Optional[str] = None
    change_description: Optional[str] = None
    status: str
    requester_id: Optional[int] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    # See models.ApplicationMaster -- live approval status of this request's
    # own Application Name (set on every create/edit, see routers/
    # qa_requests.py::_resolve_application_name); application_master_id lets
    # the UI point an SM's Approve/Reject action at the right master row.
    application_master_id: Optional[int] = None
    application_master_status: Optional[str] = None
    active_delegation: Optional[QARequestDelegationOut] = None
    # Auto-linked child requests generated because this request's
    # request_types included the matching type (see _sync_linked_child_requests).
    linked_functional_requests: List[LinkedRequestRef] = []
    linked_sast_requests: List[LinkedRequestRef] = []
    linked_dast_requests: List[LinkedRequestRef] = []
    linked_performance_requests: List[LinkedRequestRef] = []
    # Sign-off has no FK to QARequest (matched by business ID string, see
    # models.QASignOff.testing_request_id) so it isn't auto-linked the same
    # way as the 4 fields above -- populated explicitly in get_request()
    # below. See QARequestListOut's own linked_signoffs for why this was
    # added: "can we get all requests details based on that cr[number]?"
    linked_signoffs: List[LinkedRequestRef] = []
    # Read-only -- whatever the wizard's SAST/DAST/Performance/checklist steps
    # collected on an earlier Draft save (staged on draft_child_details, see
    # models.QARequest), so "Edit Request" can pre-fill them instead of
    # showing them blank again. Always empty once this request has actually
    # been raised (draft_child_details is cleared then -- see submit_request).
    draft_checked_items: List[str] = []
    draft_sast_components: List[SASTComponentIn] = []
    draft_dast_components: List[DASTTargetIn] = []
    draft_performance: dict = {}
    draft_performance_checked_items: List[str] = []
    # Same pre-fill purpose as draft_checked_items above, for SAST's/DAST's
    # own Security Readiness checklist self-declaration.
    draft_sast_checked_items: List[str] = []
    draft_dast_checked_items: List[str] = []
    # Per-request-type Priority/Risk Category values collected on an earlier
    # Draft save (e.g. {"functional_priority": "High", "sast_risk_category":
    # "Critical", ...}) -- same pre-fill purpose as the draft_* fields above.
    draft_classification: dict = {}


# SRS 7.2 PAG-005 -- lightweight counterpart to QARequestOut for
# GET /api/qa-requests (paginated list). Deliberately excludes every
# wizard-resume/draft-prefill field above (draft_sast_components,
# draft_dast_components, draft_performance, the draft_*_checked_items
# arrays, draft_classification, remarks, supporting_doc_path) -- none of
# it is rendered by the list table (QARequests/index.tsx), all of it only
# matters once a specific Draft is actually reopened for editing, which
# goes through the GET /api/qa-requests/{id} detail endpoint (still
# QARequestOut, PAG-006) instead.
class QARequestListOut(ORMModel):
    id: int
    request_id: Optional[str] = None
    request_date: Optional[datetime.date] = None
    department: Optional[str] = None
    application_name: str
    # Reported directly: "why CR number is blank, though input is provided."
    # This lightweight list schema only ever carried the legacy epic_number
    # column (kept for pre-consolidation historical rows) -- the live,
    # consolidated field every current request actually writes to
    # (cr_number, see QARequestCreate/QARequestOut) was missing here
    # entirely, so index.tsx's "CR Number/EPIC Number" column always read
    # `r.cr_number` as undefined regardless of what was typed. Detail views
    # (GET /api/qa-requests/{id}, QARequestOut) were never affected -- this
    # was specific to the list endpoint's own lightweight schema.
    cr_number: Optional[str] = None
    epic_number: Optional[str] = None
    target_release_date: Optional[datetime.date] = None
    status: str
    requester_id: Optional[int] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    application_master_status: Optional[str] = None
    active_delegation: Optional[QARequestDelegationOut] = None
    linked_functional_requests: List[LinkedRequestRef] = []
    linked_sast_requests: List[LinkedRequestRef] = []
    linked_dast_requests: List[LinkedRequestRef] = []
    linked_performance_requests: List[LinkedRequestRef] = []
    # Reported directly: "can we get all requests details based on that
    # cr[number]?" -- Sign-off has no FK to QARequest (matched by business ID
    # string instead, see models.QASignOff.testing_request_id), so it wasn't
    # among the 4 relationship-backed linked_* fields above. Batched onto
    # each row in list_requests() below via QASignOff.request_id (an alias
    # property for certificate_id) so it fits the same LinkedRequestRef shape.
    linked_signoffs: List[LinkedRequestRef] = []
    # Reported directly, alongside the cr_number fix above -- shown as its
    # own column on the list table now too (see index.tsx).
    change_description: Optional[str] = None


# ---- Functional Testing Request (Functional/Sanity/Regression Testing/UAT Support) ----
class FunctionalCreate(BaseModel):
    """Standalone creation is disabled (see routers/functional.py) -- this
    schema only exists so the disabled POST "" endpoint has a body type."""
    pass


class FunctionalUpdate(BaseModel):
    """Priority/risk_rating are real, independently-editable columns on
    FunctionalRequest itself (see models.FunctionalRequest). Every other
    field here (epic_number, cr_number, change_type, environment,
    target_promotion_environment, release_version, build_number,
    target_release_date) is delegated (read-only) from the parent QA
    Request -- update_functional writes those through to obj.qa_request
    instead of obj itself, since the QA Request gateway can no longer be
    edited directly once it's RAISED (see constants.GATEWAY_EDITABLE_STATUSES)
    and this was otherwise a dead end for fixing a typo in one of them.
    Department/Application Owner stay read-only everywhere (fixed to the
    requester's profile / not meaningfully editable after intake), so
    they're deliberately not included here. application_name/epic_number/
    cr_number ARE included but are Admin-only once this request exists at
    all (see update_functional's _ADMIN_ONLY_FIELDS check) -- same
    restriction as SASTUpdate/PerformanceUpdate below."""
    priority: Optional[str] = None
    risk_rating: Optional[str] = None
    application_name: Optional[str] = None
    epic_number: Optional[str] = None
    cr_number: Optional[str] = None
    change_type: Optional[str] = None
    environment: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    target_release_date: Optional[datetime.date] = None
    # Same reasoning as SASTUpdate.checked_items, for Functional's
    # own "Ready for Testing" readiness checklist. Previously had no way at
    # all to revisit self-declaration after the request was raised (every
    # other module's Edit Details already supported this).
    checked_items: Optional[List[str]] = None


class LinkedTestCycleRef(ORMModel):
    id: int
    cycle_key: str
    project_id: int
    name: str
    status: str
    start_date: Optional[datetime.date] = None
    end_date: Optional[datetime.date] = None


class FunctionalListOut(ORMModel):
    """PAG-005 lightweight list schema -- exactly the fields
    modules/functional/Functional.tsx's list table renders/filters on, plus
    application_master_status (drives the "Pending With: Application Owner"
    override) and department (server-side scoping/filter only, not directly
    rendered as its own column). See FunctionalOut below for the full
    detail-view shape fetched on open (PAG-006)."""
    id: int
    request_id: str
    status: str
    application_master_status: Optional[str] = None
    requester_id: Optional[int] = None
    qa_lead_id: Optional[int] = None
    priority: Optional[str] = None
    application_name: Optional[str] = None
    epic_number: Optional[str] = None
    cr_number: Optional[str] = None
    change_description: Optional[str] = None
    department: Optional[str] = None
    # Not rendered by Functional.tsx's own list table, but modules/
    # governance/SignOff.tsx's "New Sign-off Certificate" Testing Request ID
    # picker reuses this same paginated endpoint and shows it in its search
    # dropdown -- cheap to include since qa_request is already eager-loaded
    # for application_name/department above.
    application_owner: Optional[str] = None
    qa_request: Optional[LinkedRequestRef] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime


class FunctionalOut(ORMModel):
    """Carries the full Draft -> SM -> Department Head -> QA Lead -> ... ->
    Closed lifecycle (constants.QAStatus) that used to live directly on
    QARequestOut. Descriptive fields are delegated (read-only) from the
    linked qa_request -- see models.FunctionalRequest."""
    id: int
    request_id: str
    status: str
    # True while `status` is RETURNED_BY_QA_LEAD *and* that return was flagged
    # as needing a fresh Department Head approval (see routers/functional.py's
    # readiness_decision/resubmit) -- lets the frontend show that note next to
    # the accurate "Returned by QA Lead" status instead of the status itself
    # lying about who returned it.
    needs_dept_head_reapproval: bool = False
    requester_id: Optional[int] = None
    department_head_id: Optional[int] = None
    qa_lead_id: Optional[int] = None
    assigned_tester_ids: Optional[str] = None
    signoff_id: Optional[int] = None
    signoff_certificate_id: Optional[str] = None      # 2026-08 -- "LINK THE CERTIFICATE ONCE GENERATED"
    signoff_certificate_status: Optional[str] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    qa_request: Optional[LinkedRequestRef] = None
    active_delegation: Optional[QARequestDelegationOut] = None
    # Delegated from the linked QA Request gateway.
    application_name: Optional[str] = None
    epic_number: Optional[str] = None
    department: Optional[str] = None
    application_owner: Optional[str] = None
    request_types: Optional[str] = None
    target_release_date: Optional[datetime.date] = None
    cr_number: Optional[str] = None
    change_description: Optional[str] = None
    change_type: Optional[str] = None
    bug_fix_source_request_id: Optional[str] = None
    environment: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    technology_stack: Optional[str] = None
    # See models.ApplicationMaster / QARequest.application_master_status --
    # delegated the same way as application_name/epic_number/etc. above, so
    # an SM reviewing this request's own SM Approval step can see (and act
    # on) a pending new Application Name right from this request's own view.
    application_master_id: Optional[int] = None
    application_master_status: Optional[str] = None
    # NOT delegated -- real, independently-editable columns on
    # FunctionalRequest itself (see models.FunctionalRequest for why).
    priority: Optional[str] = None
    risk_rating: Optional[str] = None
    # "Ready for Testing" readiness checklist -- see models.ReadinessChecklistItem.
    # Added so the Edit Details modal (FunctionalFormModal) can show/refresh
    # a self-declaration section the same way SASTOut/DASTOut/
    # PerformanceOut's own checklist_items already do.
    checklist_items: List[ChecklistItemOut] = []
    linked_test_cycles: List[LinkedTestCycleRef] = []


class WorkflowDecision(BaseModel):
    decision: str          # Approved / Rejected / Returned
    comments: Optional[str] = None
    # Only meaningful for Suppression's security-team-decision, on a
    # "Returned" decision (see routers/suppression.py::security_team_decision)
    # -- every other consumer of this shared schema (SM/Dept Head decisions
    # across all request types) simply ignores it. Lets the Security Analyst
    # choose, at the moment they return a suppression request to the
    # requester, whether the resubmitted request needs a fresh Department
    # Head approval or can go straight back to Security Team Verification
    # once fixed (the default).
    require_dept_head_reapproval: Optional[bool] = False


# ---- QA Request lifecycle-specific payloads ----
class DepartmentHeadDecisionIn(BaseModel):
    """Department Head reviews the request and assigns its COE - Quality Assurance QA Lead."""
    decision: str                          # Approved / Returned / Rejected
    comments: Optional[str] = None
    qa_lead_id: Optional[int] = None


class AssignTesterIn(BaseModel):
    tester_ids: List[int]
    # 2026-08 Reassignment CR -- mandatory only when this call is actually a
    # reassignment (status already past the initial PLANNING assignment);
    # optional here so the very first assignment (nothing to give a reason
    # for yet) isn't forced to fill it in. Enforced server-side in
    # functional.py::assign_tester / performance.py::complete_planning via
    # reassignment.require_reason.
    reason: Optional[str] = None


class StartFunctionalExecutionIn(BaseModel):
    link_test_cycle: bool = False
    test_cycle_id: Optional[int] = None


class AssignSecurityAnalystIn(BaseModel):
    security_analyst_id: int
    # 2026-08 Reassignment CR -- mandatory only when this call is actually a
    # reassignment (status already past the initial PLANNING assignment);
    # see AssignTesterIn's identical field for the same reasoning. Enforced
    # server-side in sast_dast.py::_assign_security_analyst via
    # reassignment.require_reason.
    reason: Optional[str] = None


class SecurityDeptHeadDecisionIn(BaseModel):
    """SAST/DAST Department Head decision with COE - Quality Assurance QA Lead assignment."""
    decision: str                          # Approved / Returned / Rejected
    comments: Optional[str] = None
    qa_lead_id: Optional[int] = None
    security_lead_id: Optional[int] = None  # legacy alias for qa_lead_id


class PerformanceDeptHeadDecisionIn(BaseModel):
    """Performance Department Head decision with COE - Quality Assurance QA Lead assignment."""
    decision: str                     # Approved / Returned / Rejected
    comments: Optional[str] = None
    qa_lead_id: Optional[int] = None
    engineer_id: Optional[int] = None  # legacy alias for qa_lead_id


class ReadinessDecisionIn(BaseModel):
    decision: str                          # Passed / Failed
    comments: Optional[str] = None
    # Only meaningful when decision == "Failed", and only actually consumed by
    # the Functional/SAST/DAST readiness-decision endpoints (the only ones
    # where a Lead's readiness check returns the request to the requester at
    # all -- Performance's result-analysis-decision loop back internally
    # instead, never to the requester, so it simply ignores this field). Lets
    # the assigned Lead
    # choose, at the moment they fail readiness, whether the resubmitted
    # request needs a fresh Department Head approval (True -> routes to
    # RETURNED_BY_DEPARTMENT_HEAD) or can go straight back to them once fixed
    # (False, the default -- routes to RETURNED_BY_QA_LEAD/
    # RETURNED_BY_SECURITY_LEAD, same Lead, no re-approval needed).
    require_dept_head_reapproval: Optional[bool] = False


class RequesterDecisionIn(BaseModel):
    decision: str                          # Accepted / ChangesRequired
    comments: Optional[str] = None


class ScanCompletionIn(BaseModel):
    """2026-08 -- superseded by the "Findings Validation" requirement doc's
    Mark Scan Complete (routers/sast_dast.py::_mark_scan_complete), which
    derives no_findings from the latest SecurityScanResult automatically
    instead of asking the analyst to self-report it. No longer referenced by
    any route; kept defined rather than deleted in case something else needs
    the same shape later."""
    no_findings: bool
    comments: Optional[str] = None


class SecurityScanStartIn(BaseModel):
    """Fortify SSC identity selected when entering the Scanning stage."""
    application_name: str
    application_version: str

    @field_validator("application_name", "application_version")
    @classmethod
    def validate_scan_identity(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Application Name and Version are required")
        return normalized


class SecurityScanFilterOut(BaseModel):
    title: str
    guid: str
    total_count: int
    critical_count: int
    high_count: int
    medium_count: int
    low_count: int
    audit_url: Optional[str] = None


class SecurityScanResultOut(ORMModel):
    id: int
    request_type: str
    request_id: int
    application_name: str
    application_version: str
    provider: str
    provider_version_id: str
    critical_count: int
    high_count: int
    medium_count: int
    low_count: int
    total_count: int
    audit_url: Optional[str] = None
    filters: List[SecurityScanFilterOut] = []
    imported_by_id: Optional[int] = None
    imported_at: datetime.datetime
    # 2026-08 "Findings Validation" doc, section 4.3 Scan History -- derived
    # (not stored columns) by routers/sast_dast.py::_scan_results based on
    # each row's position among its own request's scan history: Scan No 1 is
    # always "Initial Scan", every later one is a "Rescan"; Status is always
    # "Completed" since a failed/partial SSC import never persists a row.
    scan_no: int = 1
    scan_type: str = "Initial Scan"
    status: str = "Completed"


class SecurityScanSummaryOut(ORMModel):
    """Backs the "Findings Validation" doc's 4.1 Scan Summary section."""
    initial: Optional[SecurityScanResultOut] = None
    current: Optional[SecurityScanResultOut] = None
    total_rescans: int = 0
    open_findings: int = 0
    suppressed_findings: int = 0


class CommentIn(BaseModel):
    """Payload for simple, non-branching lifecycle transitions (raise defect,
    mark waiting for fix, start retesting/regression, etc.)."""
    comments: Optional[str] = None


class ConfirmSignoffIn(BaseModel):
    signoff_id: Optional[int] = None
    comments: Optional[str] = None


class RequestSignoffIn(BaseModel):
    """Optional -- lets the frontend link a QA Clearance Certificate (created
    via POST /api/signoffs right before this call, see SignOff.tsx's
    NewSignOffModal opened from the Functional module's "Request Sign-off"
    button) at the moment sign-off is requested, rather than waiting until
    confirm-signoff. confirm-signoff still accepts its own optional
    signoff_id for backward compatibility / the case where no certificate
    was linked yet at request time."""
    signoff_id: Optional[int] = None


# ---------------- Module 4/5: SAST / DAST ----------------
class SASTCreate(BaseModel):
    application_name: str
    epic_number: Optional[str] = None
    cr_number: Optional[str] = None
    risk_category: Optional[str] = None
    hash_value: Optional[str] = None
    components: List[SASTComponentIn] = []


class SASTUpdate(BaseModel):
    """Partial update -- lets the requester (or a security analyst/admin) fill in
    or correct details, including auto-linked requests created with placeholder
    data from a QA Request. Only allowed while status == 'Requested'.
    application_name/epic_number/cr_number are Admin-only -- see
    update_sast's _ADMIN_ONLY_FIELDS check (a submitted value equal to the
    request's current one is allowed through for anyone, since that's not
    actually a change; only an attempt to alter it is blocked)."""
    application_name: Optional[str] = None
    epic_number: Optional[str] = None
    cr_number: Optional[str] = None
    risk_category: Optional[str] = None
    priority: Optional[str] = None
    hash_value: Optional[str] = None
    # When provided, replaces the request's entire set of repository rows --
    # simplest correct semantics for a "+"-driven repeatable list (see
    # update_sast in routers/sast_dast.py). None means "leave components
    # alone" (e.g. a request that's only updating risk_category).
    components: Optional[List[SASTComponentIn]] = None
    # Security Readiness checklist self-declaration -- item names the
    # requester is self-declaring ready, replacing the checklist's entire
    # requester_checked set (see update_sast in routers/sast_dast.py). None
    # means "leave the checklist's requester_checked flags alone".
    checked_items: Optional[List[str]] = None


class SASTFindingIn(BaseModel):
    issue_id: Optional[str] = None
    severity: str
    description: Optional[str] = None


class SASTFindingOut(ORMModel):
    id: int
    issue_id: Optional[str] = None
    severity: str
    description: Optional[str] = None
    status: str


class SASTListOut(ORMModel):
    """PAG-005 lightweight list schema -- mirrors modules/security/SAST.tsx's
    list table exactly (findings_count instead of the full findings list --
    see models.SASTRequest.findings_count)."""
    id: int
    request_id: str
    status: str
    application_master_status: Optional[str] = None
    requester_id: Optional[int] = None
    security_lead_id: Optional[int] = None
    priority: Optional[str] = None
    risk_category: Optional[str] = None
    application_name: Optional[str] = None
    # Cheap to include -- already eager-loaded via the same joinedload(qa_request
    # -> application_master) used for application_name/application_master_status
    # above. Needed by Suppression.tsx's cross-module SAST/DAST request picker
    # (department scoping + subtitle line), no extra query cost.
    department: Optional[str] = None
    application_owner: Optional[str] = None
    change_description: Optional[str] = None
    findings_count: int = 0
    # 2026-08 "Findings Validation" doc -- lets the list Status column
    # overlay "Suppression Approval Pending" over WAITING_FOR_FIX, mirroring
    # application_master_status's own overlay of "Application Owner Approval
    # Pending" over SM_APPROVAL_PENDING. See models.SASTRequest.has_open_suppression.
    has_open_suppression: bool = False
    qa_request: Optional[LinkedRequestRef] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime


class SASTOut(ORMModel):
    id: int
    request_id: str
    application_name: str
    epic_number: Optional[str] = None
    cr_number: Optional[str] = None
    change_description: Optional[str] = None
    risk_category: Optional[str] = None
    priority: Optional[str] = None
    hash_value: Optional[str] = None
    status: str
    # See FunctionalOut.needs_dept_head_reapproval -- same reasoning, paired
    # with RETURNED_BY_SECURITY_LEAD here.
    needs_dept_head_reapproval: bool = False
    report_path: Optional[str] = None
    requester_id: Optional[int] = None
    security_lead_id: Optional[int] = None
    security_analyst_id: Optional[int] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    findings: List[SASTFindingOut] = []
    # Set when this SAST request was auto-created from a QA Request that
    # included SAST in its request types; null for standalone SAST requests
    # raised directly through this module.
    linked_request_type: Optional[str] = None
    linked_request_id: Optional[int] = None
    qa_request: Optional[LinkedRequestRef] = None
    active_delegation: Optional[QARequestDelegationOut] = None
    # Read-only lookups (via the linked QA Request, if any) -- lets the
    # Suppression "Request ID" autosuggest auto-populate Department/Owner.
    department: Optional[str] = None
    application_owner: Optional[str] = None
    # See models.ApplicationMaster / QARequest.application_master_status --
    # delegated the same way as department/application_owner above, so an SM
    # reviewing this request's own SM Approval step can see (and act on) a
    # pending new Application Name right from this request's own view.
    application_master_id: Optional[int] = None
    application_master_status: Optional[str] = None
    # Delegated from the QA Request gateway -- shown on the SAST detail view
    # so the security team can see where the code is deployed/being promoted
    # to before starting a scan.
    environment: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    # One row per repository -- replaces the old design of 5 comma-joined
    # columns (repository_url, git_branch, commit_id, technology_stack,
    # build_number) directly on this request; see models.SASTComponent.
    components: List[SASTComponentOut] = []
    # "Security Readiness" pre-scan checklist -- see models.SASTChecklistItem
    # and constants.DEFAULT_SECURITY_CHECKLIST_ITEMS. Reuses ChecklistItemOut
    # (Functional's own checklist item shape) since the fields are identical.
    checklist_items: List[ChecklistItemOut] = []
    # Every Suppression / False Positive request raised against this SAST
    # request (see models.SASTRequest.suppressions) -- lets the Overview tab
    # show "Suppression Requested? Yes/No" and the suppression id(s) if so.
    suppressions: List[LinkedSuppressionRef] = []


class DASTCreate(BaseModel):
    risk_category: Optional[str] = None
    targets: List[DASTTargetIn] = []


class DASTUpdate(BaseModel):
    """Partial update -- lets the requester (or a security analyst/admin) fill in
    or correct details, including auto-linked requests created with placeholder
    data from a QA Request. Only allowed while status == 'Requested'."""
    risk_category: Optional[str] = None
    priority: Optional[str] = None
    # When provided, replaces the request's entire set of target rows --
    # same "+"-driven repeatable-list semantics as SASTUpdate.components
    # above (see update_dast in routers/sast_dast.py). None means "leave
    # targets alone".
    targets: Optional[List[DASTTargetIn]] = None
    # See SASTUpdate.checked_items -- same reasoning, for DAST's own
    # Security Readiness checklist.
    checked_items: Optional[List[str]] = None


class DASTFindingOut(ORMModel):
    id: int
    issue_id: Optional[str] = None
    severity: str
    description: Optional[str] = None
    status: str


class DASTListOut(ORMModel):
    """PAG-005 lightweight list schema -- mirrors modules/security/DAST.tsx's
    list table exactly. Deliberately does NOT include `targets` (so
    test_credentials masking, see _dast_out in routers/sast_dast.py, is only
    ever a concern for the detail endpoint, not this list)."""
    id: int
    request_id: str
    status: str
    application_master_status: Optional[str] = None
    requester_id: Optional[int] = None
    security_lead_id: Optional[int] = None
    priority: Optional[str] = None
    risk_category: Optional[str] = None
    application_name: Optional[str] = None
    # See the matching comment on SASTListOut above -- same reasoning, same
    # eager-load, needed by Suppression.tsx's cross-module picker.
    department: Optional[str] = None
    application_owner: Optional[str] = None
    change_description: Optional[str] = None
    findings_count: int = 0
    # See SASTListOut.has_open_suppression above -- same idea, for DAST.
    has_open_suppression: bool = False
    qa_request: Optional[LinkedRequestRef] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime


class DASTOut(ORMModel):
    id: int
    request_id: str
    risk_category: Optional[str] = None
    priority: Optional[str] = None
    status: str
    # See FunctionalOut.needs_dept_head_reapproval -- same reasoning, paired
    # with RETURNED_BY_SECURITY_LEAD here.
    needs_dept_head_reapproval: bool = False
    report_path: Optional[str] = None
    requester_id: Optional[int] = None
    security_lead_id: Optional[int] = None
    security_analyst_id: Optional[int] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    findings: List[DASTFindingOut] = []
    # Set when this DAST request was auto-created from a QA Request that
    # included DAST in its request types; null for standalone DAST requests
    # raised directly through this module.
    qa_request_id: Optional[int] = None
    qa_request: Optional[LinkedRequestRef] = None
    active_delegation: Optional[QARequestDelegationOut] = None
    # Read-only lookups (via the linked QA Request, if any) -- lets the
    # Suppression "Request ID" autosuggest auto-populate Department/Owner.
    department: Optional[str] = None
    application_owner: Optional[str] = None
    # See models.ApplicationMaster / QARequest.application_master_status --
    # delegated the same way as department/application_owner above, so an SM
    # reviewing this request's own SM Approval step can see (and act on) a
    # pending new Application Name right from this request's own view.
    application_master_id: Optional[int] = None
    application_master_status: Optional[str] = None
    # Delegated from the QA Request gateway -- Target Release Date is only
    # ever collected once, at QA Request creation time (see
    # models.DASTRequest.target_release_date).
    target_release_date: Optional[datetime.date] = None
    # DAST has no columns of its own for these (it tests a URL, not "an
    # application" directly) -- delegated from the gateway so the security
    # team can see the full business context before starting a scan.
    application_name: Optional[str] = None
    epic_number: Optional[str] = None
    cr_number: Optional[str] = None
    change_description: Optional[str] = None
    deployment_environment: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    # One row per scan target -- replaces the old design of 4 newline-joined
    # columns (application_url, environment, authentication_required,
    # test_credentials) directly on this request; see models.DASTTarget.
    # Each row's test_credentials is masked out server-side for unauthorized
    # viewers (see _dast_out in routers/sast_dast.py) -- never the whole list.
    targets: List[DASTTargetOut] = []
    # "Security Readiness" pre-scan checklist -- see models.DASTChecklistItem
    # and constants.DEFAULT_SECURITY_CHECKLIST_ITEMS. Reuses ChecklistItemOut,
    # same as SASTOut.checklist_items above.
    checklist_items: List[ChecklistItemOut] = []
    # See SASTOut.suppressions above -- same idea, for DAST.
    suppressions: List[LinkedSuppressionRef] = []


class SASTScanStartOut(BaseModel):
    request: SASTOut
    scan_result: SecurityScanResultOut


class DASTScanStartOut(BaseModel):
    request: DASTOut
    scan_result: SecurityScanResultOut


# ---------------- Module 4c: Performance Testing ----------------
class PerformanceCreate(BaseModel):
    application_name: str
    epic_number: Optional[str] = None
    cr_number: Optional[str] = None
    tool_used: Optional[str] = None
    target_load: Optional[str] = None
    environment: Optional[str] = None
    risk_category: Optional[str] = None
    priority: Optional[str] = None
    # ---- Annexure VIII fields ----
    request_type: Optional[str] = None
    change_type: Optional[str] = None
    vendor_si_partner: Optional[str] = None
    technology_stack: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    hash_value: Optional[str] = None
    target_promotion_environment: Optional[str] = None


class PerformanceUpdate(BaseModel):
    application_name: Optional[str] = None
    epic_number: Optional[str] = None
    cr_number: Optional[str] = None
    tool_used: Optional[str] = None
    target_load: Optional[str] = None
    environment: Optional[str] = None
    risk_category: Optional[str] = None
    priority: Optional[str] = None
    request_type: Optional[str] = None
    change_type: Optional[str] = None
    vendor_si_partner: Optional[str] = None
    technology_stack: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    hash_value: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    # Same reasoning as SASTUpdate.checked_items, for the 19-item
    # "L1: Pre-Testing Readiness Checklist".
    checked_items: Optional[List[str]] = None


class PerformanceChecklistItemOut(ORMModel):
    id: int
    item: str
    data_required: Optional[str] = None
    is_mandatory: bool
    # Requester's own self-declaration, ticked on the QA Request wizard's
    # Performance Testing step -- purely informational, same pattern as
    # Functional's requester_checked. is_complete below is still
    # the binding, independently-verified flag.
    requester_checked: bool = False
    is_complete: bool
    approved_by_id: Optional[int] = None
    approved_at: Optional[datetime.datetime] = None


class PerformanceChecklistItemUpdate(BaseModel):
    is_complete: bool


class PerformanceListOut(ORMModel):
    """PAG-005 lightweight list schema -- mirrors
    modules/specialised-testing/Performance.tsx's list table exactly."""
    id: int
    request_id: str
    status: str
    application_master_status: Optional[str] = None
    requester_id: Optional[int] = None
    engineer_id: Optional[int] = None
    priority: Optional[str] = None
    risk_category: Optional[str] = None
    application_name: Optional[str] = None
    # Cheap to include -- already eager-loaded via the same joinedload(qa_request
    # -> application_master) used for application_master_status above. Needed
    # by Dashboard.tsx's "My Department" unified-request filter (toUnified),
    # which silently drops any row with no department -- see the matching
    # addition to SASTListOut/DASTListOut for the same reasoning.
    department: Optional[str] = None
    change_description: Optional[str] = None
    qa_request: Optional[LinkedRequestRef] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime


class PerformanceOut(ORMModel):
    id: int
    request_id: str
    application_name: str
    epic_number: Optional[str] = None
    cr_number: Optional[str] = None
    change_description: Optional[str] = None
    tool_used: Optional[str] = None
    target_load: Optional[str] = None
    environment: Optional[str] = None
    risk_category: Optional[str] = None
    priority: Optional[str] = None
    request_type: Optional[str] = None
    change_type: Optional[str] = None
    bug_fix_source_request_id: Optional[str] = None
    vendor_si_partner: Optional[str] = None
    technology_stack: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    hash_value: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    status: str
    # See FunctionalOut.needs_dept_head_reapproval -- same reasoning, paired
    # with RETURNED_BY_ENGINEER here (Readiness failure).
    needs_dept_head_reapproval: bool = False
    report_path: Optional[str] = None
    requester_id: Optional[int] = None
    engineer_id: Optional[int] = None
    assigned_tester_ids: Optional[str] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    qa_request_id: Optional[int] = None
    qa_request: Optional[LinkedRequestRef] = None
    active_delegation: Optional[QARequestDelegationOut] = None
    department: Optional[str] = None
    application_owner: Optional[str] = None
    # See models.ApplicationMaster / QARequest.application_master_status --
    # delegated the same way as department/application_owner above, so an SM
    # reviewing this request's own SM Approval step can see (and act on) a
    # pending new Application Name right from this request's own view.
    application_master_id: Optional[int] = None
    application_master_status: Optional[str] = None
    checklist_items: List[PerformanceChecklistItemOut] = []


# ---------------- Module 6: Suppression ----------------
class SuppressionItemIn(BaseModel):
    # Every field on the "New Suppression / False Positive Request" form is
    # mandatory (see routers/suppression.py's create/update handlers, which
    # also enforce exactly one of sast_request_id/dast_request_id being set --
    # there is no more "standalone finding" fallback).
    issue_id: str
    severity: str
    description: str
    justification: str


class SuppressionItemOut(ORMModel):
    id: int
    issue_id: Optional[str] = None
    severity: str
    description: Optional[str] = None
    justification: Optional[str] = None


class SuppressionCreate(BaseModel):
    application_name: str
    scan_type: str
    # Auto-populated from whichever SAST/DAST request the "Request ID"
    # autosuggest resolved to (see SASTOut/DASTOut.department/application_owner).
    # Required -- a suppression request must always be linked to the SAST/DAST
    # request whose finding it's suppressing.
    department: str
    application_owner: str
    # Exactly one of these must be set, matching scan_type -- enforced in
    # routers/suppression.py (create_suppression/update_suppression).
    sast_request_id: Optional[int] = None
    dast_request_id: Optional[int] = None
    risk_assessment: str
    # One scan commonly has multiple findings -- list every one being
    # suppressed here instead of raising a separate request per finding.
    items: List[SuppressionItemIn]


# 2026-08 -- reported directly: "give option to link and delink supression
# request from sast request and supression both." A dedicated, minimal
# payload for POST /api/suppressions/{id}/relink -- only the link itself,
# not the full SuppressionCreate form -- so relinking doesn't require
# resending every other field untouched. Exactly one of the two must be set,
# same rule as SuppressionCreate, enforced in routers/suppression.py.
class SuppressionRelinkIn(BaseModel):
    sast_request_id: Optional[int] = None
    dast_request_id: Optional[int] = None


class SuppressionOut(ORMModel):
    id: int
    suppression_id: str
    application_name: str
    scan_type: str
    department: Optional[str] = None
    application_owner: Optional[str] = None
    sast_request_id: Optional[int] = None
    dast_request_id: Optional[int] = None
    # Whichever of sast_request_id/dast_request_id is actually set, resolved
    # to its human-readable Request ID (e.g. "TQA-SAST-01") -- see
    # models.SuppressionRequest.linked_request. Lets the Overview tab show
    # which SAST/DAST request this suppression was raised against, instead
    # of just the scan type.
    linked_request: Optional[LinkedRequestRef] = None
    risk_assessment: Optional[str] = None
    items: List[SuppressionItemOut] = []
    status: str
    created_by_id: Optional[int] = None
    sm_decision: Optional[str] = None
    dept_head_decision: Optional[str] = None
    security_decision: Optional[str] = None
    created_at: datetime.datetime


# ---------------- Module 7: Approval log ----------------
class ApprovalActionOut(ORMModel):
    id: int
    entity_type: str
    entity_id: int
    # Human-readable business ID of the underlying record (e.g. "TQA-REQ-...",
    # "TQA-SAST-...", "TQA-SUP-...") resolved server-side from entity_type/entity_id --
    # None if that record no longer exists. Lets the Approval Workflow Log
    # show something meaningful instead of the raw internal entity_id.
    request_ref: Optional[str] = None
    step_name: Optional[str] = None
    actor_id: Optional[int] = None
    actor_name: Optional[str] = None
    actor_role: Optional[str] = None
    decision: Optional[str] = None
    comments: Optional[str] = None
    # APR-005 -- populated for TEST_CASE approval-workflow rows (see
    # ApprovalAction's own docstring in models.py); None for every other
    # entity type's rows, which is expected, not a gap.
    previous_state: Optional[str] = None
    new_state: Optional[str] = None
    created_at: datetime.datetime

    _normalize_actor_name = field_validator("actor_name", mode="before")(_plain_person_name)


class CommentCreate(BaseModel):
    body: str


# ---------------- Defect Management ----------------
class DefectCreate(BaseModel):
    title: str
    description: str
    qa_request_id: int
    cycle_id: Optional[int] = None
    test_case_id: Optional[int] = None
    execution_id: Optional[int] = None
    test_case_ids: List[int] = []
    module_feature: str
    environment: str
    severity: str
    priority: str
    steps_to_reproduce: str
    expected_result: str
    actual_result: str
    retest_tester_id: Optional[int] = None
    device_details: Optional[str] = None
    build_version: Optional[str] = None
    api_endpoint: Optional[str] = None
    request_response_details: Optional[str] = None
    log_details: Optional[str] = None
    related_cr_number: Optional[str] = None
    external_defect_id: Optional[str] = None
    remarks: Optional[str] = None
    labels: Optional[str] = None

    _limit_rich_text = field_validator(
        "description", "steps_to_reproduce", "expected_result", "actual_result", "remarks"
    )(_limited_rich_text)


class DefectLinkExecution(BaseModel):
    execution_id: int


class DefectExecutionLinkOut(ORMModel):
    """One ADDITIONAL execution a Defect has been traced to, beyond its
    primary one -- see models.Defect.execution_links' own comment."""
    id: int
    execution_id: int
    cycle_id: Optional[int] = None
    cycle_key: Optional[str] = None
    project_id: Optional[int] = None
    test_case_key: Optional[str] = None
    status: Optional[str] = None


class DefectUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    module_feature: Optional[str] = None
    environment: Optional[str] = None
    severity: Optional[str] = None
    priority: Optional[str] = None
    steps_to_reproduce: Optional[str] = None
    expected_result: Optional[str] = None
    actual_result: Optional[str] = None
    device_details: Optional[str] = None
    build_version: Optional[str] = None
    api_endpoint: Optional[str] = None
    request_response_details: Optional[str] = None
    log_details: Optional[str] = None
    related_cr_number: Optional[str] = None
    external_defect_id: Optional[str] = None
    remarks: Optional[str] = None
    labels: Optional[str] = None

    _limit_rich_text = field_validator(
        "description", "steps_to_reproduce", "expected_result", "actual_result", "remarks"
    )(_limited_rich_text)


class DefectTransition(BaseModel):
    status: str
    assignee_id: Optional[int] = None
    assigned_team: Optional[str] = None
    remarks: Optional[str] = None
    resolution_type: Optional[str] = None
    resolution_summary: Optional[str] = None
    root_cause: Optional[str] = None
    fix_details: Optional[str] = None
    fixed_build_version: Optional[str] = None
    tested_build_version: Optional[str] = None
    actual_result: Optional[str] = None
    retest_remarks: Optional[str] = None
    reopen_reason: Optional[str] = None
    deferral_reason: Optional[str] = None
    deferral_approved_by: Optional[str] = None
    target_release: Optional[str] = None
    expected_resolution_date: Optional[datetime.date] = None
    rejection_reason: Optional[str] = None
    duplicate_defect_id: Optional[int] = None
    # 2026-08 "Not a Defect" cycle addition -- required (see
    # routers/defects.py::transition_defect's own "Not a Defect" branch)
    # when transitioning to that status, same pattern as rejection_reason
    # above for Rejected.
    not_a_defect_reason: Optional[str] = None
    closure_remarks: Optional[str] = None

    _limit_rich_text = field_validator(
        "remarks", "resolution_summary", "root_cause", "fix_details", "actual_result",
        "retest_remarks", "reopen_reason", "deferral_reason", "rejection_reason",
        "not_a_defect_reason", "closure_remarks",
    )(_limited_rich_text)


# 2026-08 Reassignment Requirement -- dedicated endpoint/payload for changing
# an already-assigned defect's assignee without touching status/history.
# Deliberately separate from DefectTransition: the "Assigned" status is only
# reachable from New/Reopened/Deferred (see defects.py's TRANSITIONS), so
# there was previously no way to change the assignee once work was already
# under way (In Progress/Resolved/Retest/etc).
class DefectReassign(BaseModel):
    assignee_id: int
    assigned_team: Optional[str] = None
    reason: Optional[str] = None


class DefectOut(ORMModel):
    id: int
    defect_key: str
    title: str
    description: str
    status: str
    qa_request_id: int
    qa_request_key: Optional[str] = None
    cycle_id: Optional[int] = None
    cycle_key: Optional[str] = None
    project_id: Optional[int] = None
    # 2026-08 -- reported directly: "During assigning defect, department
    # should be auto populated based on linked request or Failed / Blocked
    # Test Execution." See models.Defect.project_department's own docstring
    # -- the linked Test Cycle's own Project.department, used by
    # Defects.tsx's TransitionModal to prefill the "Assigned" step's
    # Department field ahead of the QA Request's own department.
    project_department: Optional[str] = None
    primary_test_case_id: Optional[int] = None
    test_case_key: Optional[str] = None
    execution_id: Optional[int] = None
    linked_test_case_ids: List[int] = []
    linked_test_case_keys: List[str] = []
    # Additional executions this same governed defect has also been traced
    # to, beyond its primary one above -- see models.Defect.execution_links.
    execution_links: List[DefectExecutionLinkOut] = []
    application_name: str
    module_feature: str
    environment: str
    severity: str
    priority: str
    steps_to_reproduce: str
    expected_result: str
    actual_result: str
    reporter_id: int
    reporter_name: Optional[str] = None
    reported_at: datetime.datetime
    assignee_id: Optional[int] = None
    assignee_name: Optional[str] = None
    assigned_team: Optional[str] = None
    assigned_by_id: Optional[int] = None
    assigned_by_name: Optional[str] = None
    assigned_at: Optional[datetime.datetime] = None
    assignment_remarks: Optional[str] = None
    retest_tester_id: Optional[int] = None
    device_details: Optional[str] = None
    build_version: Optional[str] = None
    api_endpoint: Optional[str] = None
    request_response_details: Optional[str] = None
    log_details: Optional[str] = None
    related_cr_number: Optional[str] = None
    external_defect_id: Optional[str] = None
    remarks: Optional[str] = None
    labels: Optional[str] = None
    resolution_type: Optional[str] = None
    resolution_summary: Optional[str] = None
    root_cause: Optional[str] = None
    fix_details: Optional[str] = None
    fixed_build_version: Optional[str] = None
    resolved_at: Optional[datetime.datetime] = None
    retest_result: Optional[str] = None
    retest_at: Optional[datetime.datetime] = None
    tested_build_version: Optional[str] = None
    retest_actual_result: Optional[str] = None
    retest_remarks: Optional[str] = None
    reopen_reason: Optional[str] = None
    reopen_count: int = 0
    deferral_reason: Optional[str] = None
    deferral_approved_by: Optional[str] = None
    target_release: Optional[str] = None
    expected_resolution_date: Optional[datetime.date] = None
    rejection_reason: Optional[str] = None
    not_a_defect_reason: Optional[str] = None
    duplicate_of_id: Optional[int] = None
    duplicate_of_key: Optional[str] = None
    closure_remarks: Optional[str] = None
    closed_at: Optional[datetime.datetime] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime


class DefectListOut(ORMModel):
    """PAG-005 lightweight list schema for `GET /api/defects` -- drops the
    long free-text fields (description, steps_to_reproduce, expected/actual
    result, log/request details, resolution/root-cause/fix writeups, etc.)
    that only ever get read once a defect is actually opened (see PAG-006's
    `GET /{defect_id}` -> `DefectOut` fetch-on-open in Defects.tsx). Keeps
    everything the register table, the queue tabs, and every other module's
    defect pickers (TestExecution.tsx's cycle-completion gate and
    "link existing defect" modal) actually read off a row."""
    id: int
    defect_key: str
    title: str
    status: str
    qa_request_id: int
    qa_request_key: Optional[str] = None
    cycle_id: Optional[int] = None
    cycle_key: Optional[str] = None
    project_id: Optional[int] = None
    test_case_key: Optional[str] = None
    execution_id: Optional[int] = None
    application_name: str
    module_feature: str
    environment: str
    severity: str
    priority: str
    reporter_id: int
    reporter_name: Optional[str] = None
    reported_at: datetime.datetime
    assignee_id: Optional[int] = None
    assignee_name: Optional[str] = None
    assigned_team: Optional[str] = None
    target_release: Optional[str] = None
    expected_resolution_date: Optional[datetime.date] = None
    reopen_count: int = 0
    closed_at: Optional[datetime.datetime] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime


class DefectDashboardOut(BaseModel):
    total: int
    open: int
    closed: int
    reopened: int
    deferred: int
    # SRS 7.2 pagination rollout -- these four back Defects.tsx's queue tabs
    # (previously client-computed via `.filter().length` over the whole,
    # now-paginated list). Computed via dedicated SQL COUNTs, not derived
    # from `by_status`/`by_severity` alone, since each is a compound
    # condition (e.g. "Critical/High severity AND not terminal status") that
    # a single-column GROUP BY can't answer on its own.
    attention_count: int = 0
    mine_count: int = 0
    unlinked_count: int = 0
    retest_count: int = 0
    by_status: dict[str, int]
    by_severity: dict[str, int]
    by_priority: dict[str, int]
    by_application: dict[str, int]
    by_assignee: dict[str, int]
    by_ageing: dict[str, int]
    closure_trend: dict[str, int]


# ---------------- Module 8: QA Clearance ----------------
class SignOffCreate(BaseModel):
    certificate_type: str
    testing_type: str
    testing_request_id: Optional[str] = None
    change_request_ids: Optional[str] = None
    application_name: str
    application_owner: Optional[str] = None
    department: Optional[str] = None
    vendor_si_partner: Optional[str] = None
    technology_stack: Optional[str] = None
    risk_tier: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    environment_tested: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    validity_from: Optional[datetime.date] = None
    validity_to: Optional[datetime.date] = None
    exit_criteria_notes: Optional[str] = None
    open_defect_summary: Optional[str] = None
    residual_risk_notes: Optional[str] = None

    _limit_rich_text = field_validator(
        "exit_criteria_notes", "open_defect_summary", "residual_risk_notes"
    )(_limited_rich_text)


class SignOffUpdate(BaseModel):
    """Edits a certificate's own descriptive fields -- available to the
    QA requester while it's DRAFT/RETURNED_BY_*, and to the QA Lead directly
    while it sits at QA Lead approval (legacy status code
    SM_APPROVAL_PENDING; see routers/signoff.py::update_signoff for the exact
    permission windows). Everything optional --
    only fields actually sent are changed."""
    certificate_type: Optional[str] = None
    testing_type: Optional[str] = None
    change_request_ids: Optional[str] = None
    vendor_si_partner: Optional[str] = None
    technology_stack: Optional[str] = None
    risk_tier: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    environment_tested: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    validity_from: Optional[datetime.date] = None
    validity_to: Optional[datetime.date] = None
    exit_criteria_notes: Optional[str] = None
    open_defect_summary: Optional[str] = None
    residual_risk_notes: Optional[str] = None

    _limit_rich_text = field_validator(
        "exit_criteria_notes", "open_defect_summary", "residual_risk_notes"
    )(_limited_rich_text)


class SignOffOut(ORMModel):
    id: int
    certificate_id: str
    certificate_date: Optional[datetime.date] = None
    certificate_type: str
    testing_type: str
    testing_request_id: Optional[str] = None
    change_request_ids: Optional[str] = None
    application_name: str
    application_owner: Optional[str] = None
    department: Optional[str] = None
    request_department: Optional[str] = None
    # Delegated from the QA Request via source_functional_request -- see
    # models.QASignOff.change_description.
    change_description: Optional[str] = None
    vendor_si_partner: Optional[str] = None
    technology_stack: Optional[str] = None
    risk_tier: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    environment_tested: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    validity_from: Optional[datetime.date] = None
    validity_to: Optional[datetime.date] = None
    exit_criteria_notes: Optional[str] = None
    open_defect_summary: Optional[str] = None
    residual_risk_notes: Optional[str] = None
    status: str
    # Requested By (QA Team) / Approved By (QA Lead) / Approved By
    # (Executive ) -- see models.QASignOff for the full reasoning.
    # Mandatory on a fully-Issued certificate's own report (enforced by the
    # workflow itself: a certificate can't reach ISSUED without all three
    # having acted on it), optional/blank on one still in progress.
    requester_id: Optional[int] = None
    reviewed_by_id: Optional[int] = None
    approved_by_id: Optional[int] = None
    # Vestigial -- see models.QASignOff, kept only so any pre-rollout
    # certificate's old data is still visible if ever needed.
    issued_by_id: Optional[int] = None
    signed_by_id: Optional[int] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime


# ---------------- Module 9: Departments (Admin) ----------------
class DepartmentOut(ORMModel):
    id: int
    name: str
    is_active: bool


class DepartmentCreate(BaseModel):
    name: str


class DepartmentUpdate(BaseModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None


# ---------------- Configurable Readiness Checklists ----------------
# See models.ChecklistTemplateItem / checklist_config.py / routers/
# checklist_config.py for the full reasoning.
class ChecklistTemplateItemOut(ORMModel):
    id: int
    module: str
    item: str
    detail: Optional[str] = None
    is_mandatory: bool
    sort_order: int
    active: bool


class ChecklistTemplateItemCreate(BaseModel):
    item: str
    detail: Optional[str] = None
    is_mandatory: bool = False
    # Appended to the end of the module's own list if left unset (see
    # routers/checklist_config.py::create_item).
    sort_order: Optional[int] = None


class ChecklistTemplateItemUpdate(BaseModel):
    item: Optional[str] = None
    detail: Optional[str] = None
    is_mandatory: Optional[bool] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None


# ---------------- Module 10: Application Name Master ----------------
class ApplicationMasterOut(ORMModel):
    id: int
    name: str
    status: str
    department: Optional[str] = None
    requested_by_id: Optional[int] = None
    qa_request_id: Optional[int] = None
    qa_request: Optional[LinkedRequestRef] = None
    # Application Owner tier -- populated once an Application Owner has
    # decided (see models.ApplicationMaster's two-tier docstring).
    app_owner_decided_by_id: Optional[int] = None
    app_owner_decided_at: Optional[datetime.datetime] = None
    app_owner_comments: Optional[str] = None
    decided_by_id: Optional[int] = None
    decided_at: Optional[datetime.datetime] = None
    comments: Optional[str] = None
    created_at: datetime.datetime


class ApplicationMasterDecision(BaseModel):
    decision: str          # "Approved" or "Rejected"
    comments: Optional[str] = None


class ApplicationMasterDepartmentUpdate(BaseModel):
    department: str


class ApplicationMasterRenameUpdate(BaseModel):
    name: str


class ApplicationSeedResult(ORMModel):
    """Result of an Admin bulk-seeding an xlsx of known-good Application
    Names into ApplicationMaster (see routers/applications.py::
    bulk_seed_application_names) -- same result-summary shape as
    TestCaseImportResult (created/skipped counts + a row-level errors list),
    with the extra buckets this operation can land a row in: an existing
    still-pending name gets approved outright rather than created again, and
    an existing already-approved/rejected name is left untouched and simply
    counted as skipped."""
    created: int
    approved_existing: int
    skipped_duplicate: int
    skipped_rejected: int
    skipped_invalid: int
    errors: List[str] = []
    failure_reason: Optional[str] = None


# ---------------- Module 11: Test Management (Project Management / Test Repository / Test Execution) ----------------
class TestProjectCreate(BaseModel):
    name: str
    application_master_id: Optional[int] = None
    department: str
    description: Optional[str] = None
    owner_id: Optional[int] = None
    # APR-001 -- project-level default Reviewer/QA Lead, copied onto each
    # TestCaseVersion at submission time (see TestCaseVersion.
    # assigned_reviewer_id/assigned_qa_lead_id).
    default_reviewer_id: Optional[int] = None
    default_qa_lead_id: Optional[int] = None


class TestProjectUpdate(BaseModel):
    name: Optional[str] = None
    application_master_id: Optional[int] = None
    department: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None
    owner_id: Optional[int] = None
    default_reviewer_id: Optional[int] = None
    default_qa_lead_id: Optional[int] = None


class TestProjectOut(ORMModel):
    id: int
    project_key: str
    name: str
    application_master_id: Optional[int] = None
    department: Optional[str] = None
    description: Optional[str] = None
    is_active: bool
    owner_id: Optional[int] = None
    owner_name: Optional[str] = None
    created_by_id: Optional[int] = None
    created_at: datetime.datetime
    pending_is_active: Optional[bool] = None
    pending_requested_by_id: Optional[int] = None
    pending_requested_by_name: Optional[str] = None
    pending_requested_at: Optional[datetime.datetime] = None
    is_archived: bool = False
    archived_by_id: Optional[int] = None
    archived_by_name: Optional[str] = None
    archived_at: Optional[datetime.datetime] = None
    archived_reason: Optional[str] = None
    default_reviewer_id: Optional[int] = None
    default_reviewer_name: Optional[str] = None
    default_qa_lead_id: Optional[int] = None
    default_qa_lead_name: Optional[str] = None
    # 2026-08 "view-only access to department/user" CR -- True when the
    # CURRENT viewer can only see this project via a TestProjectViewGrant
    # (not their own department membership, and not an unrestricted QA/Admin
    # role). Computed per-request by the router (routers/test_projects.py),
    # not a column on TestProject itself -- see that model's own docstring.
    # Defaults False so any response NOT explicitly stamped (e.g. a
    # not-yet-updated caller) reads as "full access", the safe default for
    # something that isn't itself a permission enforcement -- the frontend
    # uses this purely to badge/disable UI; every real mutation stays
    # enforced server-side by its own existing role/ownership checks
    # regardless of what this flag says.
    view_only: bool = False
    # True when an explicit project view grant targets the current user or
    # one of their departments. Separate from view_only because a QA-wide
    # viewer may already have broad visibility and still be a named grant
    # recipient who should see the sharing indicator.
    shared_with_you: bool = False


class TestProjectViewGrantOut(ORMModel):
    id: int
    project_id: int
    department: Optional[str] = None
    user_id: Optional[int] = None
    user_name: Optional[str] = None
    granted_by_id: Optional[int] = None
    granted_by_name: Optional[str] = None
    created_at: datetime.datetime


class TestProjectViewGrantCreate(BaseModel):
    """Exactly one of `department`/`user_id` must be set -- validated in
    routers/test_projects.py::create_project_view_grant, not here (mirrors
    this app's other "exactly one of" payload rules, e.g.
    auth.py's department/departments resolution)."""
    department: Optional[str] = None
    user_id: Optional[int] = None


class TestProjectMyAccessOut(BaseModel):
    """SRS PRJ-005/GOV-001 -- advisory permission summary for the signed-in
    user on one Test Project, matching deps.py's enforcement helpers exactly.
    See routers/test_projects.py::get_my_project_access."""
    project_id: int
    project_role: Optional[str] = None
    is_member: bool
    can_author_repository: bool
    can_review_repository: bool
    # 2026-08 "Test Approval Workflow" refactor -- Stage 2 (QA Lead final
    # approve/return/reject on "Review Completed"), deliberately narrower
    # than can_review_repository (Stage 1, Reviewer recommend/return on "In
    # Review") -- see can_give_final_approval's own docstring in deps.py.
    can_give_final_approval: bool
    can_execute: bool
    can_manage_execution_governance: bool


class TestProjectActivationReview(BaseModel):
    decision: str
    comments: Optional[str] = None


class TestProjectArchive(BaseModel):
    reason: Optional[str] = None


class TestProjectMemberCreate(BaseModel):
    """SRS PRJ-005/GOV-001. project_role must be one of
    constants.TEST_PROJECT_ROLES -- see routers/test_projects.py::
    add_project_member for validation."""
    user_id: int
    project_role: str = "Tester"


class TestProjectMemberUpdate(BaseModel):
    project_role: str


class TestProjectMemberOut(ORMModel):
    id: int
    project_id: int
    user_id: int
    user_name: Optional[str] = None
    user_email: Optional[str] = None
    project_role: str
    added_by_id: Optional[int] = None
    added_by_name: Optional[str] = None
    added_at: datetime.datetime


class TestFolderCreate(BaseModel):
    name: str
    parent_id: Optional[int] = None


class TestFolderOut(ORMModel):
    id: int
    project_id: int
    parent_id: Optional[int] = None
    name: str
    created_by_id: Optional[int] = None
    created_by_name: Optional[str] = None
    created_at: datetime.datetime


class TestFolderMove(BaseModel):
    # None means "move to top level" (no parent) -- explicit null is a real,
    # valid destination, not "leave unchanged" (this endpoint is POST-only,
    # always applied, unlike TestCaseBulkUpdate's model_fields_set trick).
    parent_id: Optional[int] = None


class TestFolderCopy(BaseModel):
    # None means "copy to the same parent as the source folder" -- i.e.
    # duplicate in place, as a sibling of the original.
    parent_id: Optional[int] = None
    name: Optional[str] = None


class TestFolderUpdate(BaseModel):
    # Reported directly: "Once folder is created, folder details should be
    # editable." Uses model_fields_set (see update_folder) rather than
    # TestFolderMove's "always applied" convention, since this is a general
    # PATCH that may only touch name and leave parent_id untouched -- an
    # explicit null still means "move to top level", same as TestFolderMove.
    name: Optional[str] = None
    parent_id: Optional[int] = None


class TestStepIn(BaseModel):
    step_no: int
    step_text: Optional[str] = None
    expected_result: Optional[str] = None


class TestStepOut(ORMModel):
    id: int
    step_no: int
    step_text: Optional[str] = None
    expected_result: Optional[str] = None


class TestCaseVersionStepOut(ORMModel):
    id: int
    step_no: int
    step_text: Optional[str] = None
    expected_result: Optional[str] = None


class TestCaseVersionOut(ORMModel):
    """SRS VER-001..006 -- one immutable snapshot. See
    models.TestCaseVersion's own docstring."""
    id: int
    test_case_id: int
    version_major: int
    version_minor: int
    version: str
    status: str
    epic_id: Optional[str] = None
    cr_number: Optional[str] = None
    feature_id: Optional[str] = None
    user_story_id: Optional[str] = None
    test_type: Optional[str] = None
    module_name: Optional[str] = None
    test_scenario: Optional[str] = None
    pre_condition: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    author_id: Optional[int] = None
    author_name: Optional[str] = None
    created_at: datetime.datetime
    submitted_by_id: Optional[int] = None
    submitted_by_name: Optional[str] = None
    submitted_at: Optional[datetime.datetime] = None
    submit_note: Optional[str] = None
    reviewed_by_id: Optional[int] = None
    reviewed_by_name: Optional[str] = None
    reviewed_at: Optional[datetime.datetime] = None
    review_comments: Optional[str] = None
    qa_lead_decided_by_id: Optional[int] = None
    qa_lead_decided_by_name: Optional[str] = None
    qa_lead_decided_at: Optional[datetime.datetime] = None
    qa_lead_decision_comments: Optional[str] = None
    assigned_reviewer_id: Optional[int] = None
    assigned_reviewer_name: Optional[str] = None
    assigned_qa_lead_id: Optional[int] = None
    assigned_qa_lead_name: Optional[str] = None
    pending_with_user_id: Optional[int] = None
    pending_with_user_name: Optional[str] = None
    source_version_id: Optional[int] = None
    steps: List[TestCaseVersionStepOut] = []


class TestCaseVersionSummary(ORMModel):
    """Lightweight row for a testcase's version-history list -- avoids
    shipping every version's full steps when the UI just needs the
    dropdown/list of versions (VER-005 compare picker)."""
    id: int
    version: str
    status: str
    author_name: Optional[str] = None
    created_at: datetime.datetime
    submitted_at: Optional[datetime.datetime] = None
    reviewed_at: Optional[datetime.datetime] = None


class TestCaseVersionCompareOut(BaseModel):
    """SRS VER-005 "field-level and step-level differences" between any two
    versions of the same testcase."""
    left: TestCaseVersionOut
    right: TestCaseVersionOut
    # Field name -> (left value, right value), only for fields that differ.
    field_diffs: dict
    # Step number -> {"left": {...}|None, "right": {...}|None} for any step
    # that was added, removed, or changed between the two versions.
    step_diffs: dict


class TestCaseCreate(BaseModel):
    # Retained for backward compatibility with older clients/templates. The
    # router always assigns the governed TQA-TC-NN key and never trusts this
    # caller-supplied value as the repository's business ID.
    test_case_key: Optional[str] = None
    folder_id: Optional[int] = None
    epic_id: Optional[str] = None
    cr_number: Optional[str] = None
    feature_id: Optional[str] = None
    user_story_id: Optional[str] = None
    test_type: Optional[str] = None
    module_name: Optional[str] = None
    test_scenario: Optional[str] = None
    pre_condition: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    tags: List[str] = []
    # The API always creates cases as Draft, ready for explicit submission
    # to Reviewer recommendation. Kept in
    # the input shape for backward compatibility with older clients, but the
    # router never trusts a client-supplied lifecycle status.
    status: str = "Draft"
    steps: List[TestStepIn] = []

    @model_validator(mode="after")
    def validate_manual_test_case(self):
        """Manual creation must not mint an empty, unusable Draft."""
        required_fields = {
            "Test Type": self.test_type,
            "Module Name": self.module_name,
            "Test Scenario": self.test_scenario,
            "Description": self.description,
            "Priority": self.priority,
        }
        missing = [label for label, value in required_fields.items() if not (value or "").strip()]
        if missing:
            raise ValueError(f"Complete the mandatory fields: {', '.join(missing)}")
        if not self.steps:
            raise ValueError("Add at least one test step")
        for index, step in enumerate(self.steps, start=1):
            if not (step.step_text or "").strip():
                raise ValueError(f"Step {index} cannot be blank")
            if not (step.expected_result or "").strip():
                raise ValueError(f"Expected Result for step {index} cannot be blank")
        return self


class TestCaseUpdate(BaseModel):
    folder_id: Optional[int] = None
    epic_id: Optional[str] = None
    cr_number: Optional[str] = None
    feature_id: Optional[str] = None
    user_story_id: Optional[str] = None
    test_type: Optional[str] = None
    module_name: Optional[str] = None
    test_scenario: Optional[str] = None
    pre_condition: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    tags: Optional[List[str]] = None
    status: Optional[str] = None
    steps: Optional[List[TestStepIn]] = None


class TestCaseBulkUpdate(BaseModel):
    ids: List[int]
    # model_fields_set lets the endpoint distinguish "leave folder unchanged"
    # from an explicit null meaning "move selected cases to Unfiled".
    folder_id: Optional[int] = None
    priority: Optional[str] = None
    test_type: Optional[str] = None
    module_name: Optional[str] = None
    tags: Optional[List[str]] = None
    status: Optional[str] = None


class TestCaseBulkDelete(BaseModel):
    ids: List[int]


class TestCaseBulkApprove(BaseModel):
    """QA-Lead-tier bulk FINAL decision -- acts only on rows whose draft is
    "Review Completed" (see bulk_recommend_test_cases below for the
    Reviewer-tier bulk equivalent on "In Review" rows). Always an Approve &
    Activate, minor-bump only -- a major bump's mandatory justification is
    inherently per-case, so that path stays single-case only via review_
    test_case."""
    ids: List[int]
    comments: str


class TestCaseBulkRecommend(BaseModel):
    """2026-08 Approval Workflow refactor -- Reviewer-tier bulk equivalent
    of TestCaseBulkApprove, acting on rows whose draft is "In Review",
    moving each to "Review Completed" for QA Lead final decision. comments
    is optional to match the single-case Recommend action (APR-004: return/
    reject require a comment, approval/recommendation don't)."""
    ids: List[int]
    comments: Optional[str] = None


class TestCaseBulkReturn(BaseModel):
    """2026-08 -- NEW-workflow-only bulk equivalent of review_test_case's
    single-case RETURN decision, available at either NEW-path checkpoint
    ("Recommendation Pending" -> "Returned by QA", or "QA Lead Approval
    Pending" -> "Returned by QA Lead"). comments is mandatory, matching the
    single-case RETURN's own requirement (a reason is required when
    returning a test case for changes). OLD-path rows are not supported by
    this endpoint -- return/reject there remain single-case only via
    review_test_case, per this migration's established "new cases only"
    convention."""
    ids: List[int]
    comments: str


class TestCaseBulkReject(BaseModel):
    """2026-08 -- NEW-workflow-only bulk equivalent of review_test_case's
    single-case REJECT decision (terminal), available at either NEW-path
    checkpoint. comments is mandatory, matching the single-case REJECT's own
    requirement. OLD-path rows are not supported, same reasoning as
    TestCaseBulkReturn above."""
    ids: List[int]
    comments: str


class TestCaseBulkSubmit(BaseModel):
    """REV-001, bulk form -- submits every selected case's current Draft/
    Returned version for Reviewer recommendation in one action. Reported
    directly: with a large imported/cloned batch, submitting one testcase
    at a time was impractical."""
    ids: List[int]
    note: Optional[str] = None


class TestCaseReview(BaseModel):
    """2026-08 Approval Workflow refactor -- one endpoint, two stages,
    decision vocabulary depends on which stage the target draft is
    currently sitting in (see routers/test_repository.py::review_test_case):
      draft.status == "In Review" (Reviewer-tier acts):
        RECOMMEND -> "Review Completed" (comments optional)
        RETURN    -> "Returned" (comments MANDATORY, APR-004)
      draft.status == "Review Completed" (QA-Lead-tier acts):
        APPROVE -> "Approved" (comments optional; version_bump applies)
        RETURN  -> "Returned" (comments MANDATORY)
        REJECT  -> "Rejected", terminal (comments MANDATORY)
    """
    decision: str
    comments: Optional[str] = None
    # SRS VER-004 "Default policy may auto-increment minor and permit QA
    # Lead to select major with justification" -- version_bump is ignored
    # unless decision=="APPROVE"; "major" requires non-blank comments
    # (enforced in routers/test_repository.py) since a major bump is meant
    # to record WHY the intent materially changed, not just that it did.
    version_bump: Optional[str] = None  # "minor" (default) | "major"


class TestCaseReassignApprovers(BaseModel):
    """APR-001 -- optional item-level reassignment of a test case's current
    draft version away from its project-level default Reviewer/QA Lead.
    Both optional/independent; only fields present in model_fields_set are
    changed (so reassigning just the Reviewer doesn't disturb the QA Lead
    assignment, and vice versa). Passing null explicitly clears that
    assignment back to "unassigned" (still actionable by anyone holding the
    right project role -- see TestCaseVersion.assigned_reviewer_id's own
    docstring; this is a routing field, not an authorization gate)."""
    assigned_reviewer_id: Optional[int] = None
    assigned_qa_lead_id: Optional[int] = None


class TestCaseSubmit(BaseModel):
    """REV-001 -- submitting a Draft version for Reviewer recommendation. note is
    the author's own optional context for the reviewer, stored on
    TestCaseVersion.submit_note."""
    note: Optional[str] = None


class TestCaseCheckoutOverride(BaseModel):
    """TC-004 "QA Lead and Administrator override shall require a reason
    and audit event" -- forcing a checkout away from whoever currently
    holds it."""
    reason: str


class TestCaseCloneIn(BaseModel):
    """TC-005 -- clone creates a NEW testcase identity at version 1.0
    Draft, in the given (or same) project/folder, recording the source
    testcase/version it was cloned from."""
    project_id: Optional[int] = None
    folder_id: Optional[int] = None
    name_suffix: Optional[str] = None


class TestCaseArchive(BaseModel):
    """TC-006 -- archiving preserves all versions/cycle membership/
    execution history while preventing new cycle selection. 2026-08 --
    reason is now mandatory (was optional): "Final-Approved Test Case
    Deletion and Archive Requirement" -- "The user must provide an archive
    reason." Recorded verbatim on the audit trail (see archive_test_case)."""
    reason: str


class TestCaseBulkArchive(BaseModel):
    """2026-08 -- bulk counterpart to TestCaseArchive, for the "Archive
    Selected" bulk action alongside bulk-delete (see bulk_archive_test_cases
    in test_repository.py). Acts only on rows with a live Approved baseline
    -- an already-Archived row in the same selection is silently skipped
    rather than rejecting the whole batch, since re-archiving an archived
    row isn't a meaningful conflict the way deleting a governed one is."""
    ids: List[int]
    reason: str


class TestCaseBulkRestoreFromArchive(BaseModel):
    """2026-08 -- bulk counterpart to the single-case restore_test_case
    (Archived -> Approved), alongside TestCaseBulkArchive. No reason field --
    matches the single-case /restore endpoint, which likewise doesn't
    require one (only the Archive direction demands a documented reason;
    reversing it back to Approved isn't a governance decision the way
    archiving or deleting is)."""
    ids: List[int]


class TestCaseBulkRestoreFromRecycleBin(BaseModel):
    """2026-08 "Recycle Bin" requirement -- bulk counterpart to
    restore_test_case_from_recycle_bin. Any Author-tier user may restore
    (same tier that can delete in the first place) -- restoring an
    accidental delete isn't a governance decision the way purging
    permanently is."""
    ids: List[int]


class TestCaseBulkPurge(BaseModel):
    """2026-08 "Recycle Bin" requirement -- "only QA lead can clear from
    recycle bin." Bulk counterpart to purge_test_case -- the only remaining
    code path (besides the single-case one) that issues a real, irreversible
    `db.delete()`. QA Lead Group only (require_can_manage_repository_governance)."""
    ids: List[int]


class TestCaseOut(ORMModel):
    id: int
    test_case_key: str
    project_id: int
    folder_id: Optional[int] = None
    folder_name: Optional[str] = None
    epic_id: Optional[str] = None
    cr_number: Optional[str] = None
    feature_id: Optional[str] = None
    user_story_id: Optional[str] = None
    test_type: Optional[str] = None
    module_name: Optional[str] = None
    test_scenario: Optional[str] = None
    pre_condition: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    tags: List[str] = []
    status: str
    version: str = "1.0"
    # SRS VER-002 -- which version is which, when both a live approved
    # baseline and an in-progress draft revision exist side by side.
    current_approved_version_id: Optional[int] = None
    current_draft_version_id: Optional[int] = None
    current_draft_author_id: Optional[int] = None
    current_draft_author_name: Optional[str] = None
    # GOV-002 gap fix -- see models.TestCase.current_draft_submitted_by_id/
    # current_draft_reviewed_by_id's own docstring.
    current_draft_submitted_by_id: Optional[int] = None
    current_draft_reviewed_by_id: Optional[int] = None
    # "show submitted by as well" -- see models.TestCase.
    # current_draft_submitted_by_name's own docstring.
    current_draft_submitted_by_name: Optional[str] = None
    # "Add Recommended By once recommended" -- see models.TestCase.
    # current_draft_reviewed_by_name's own docstring.
    current_draft_reviewed_by_name: Optional[str] = None
    created_by_id: Optional[int] = None
    created_by_name: Optional[str] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    checked_out_by_id: Optional[int] = None
    checked_out_by_name: Optional[str] = None
    checked_out_at: Optional[datetime.datetime] = None
    # 2026-08 "Recycle Bin" requirement -- see models.TestCase.is_deleted's
    # own docstring. False/None for every normal (non-recycled) case.
    is_deleted: bool = False
    deleted_by_name: Optional[str] = None
    deleted_at: Optional[datetime.datetime] = None
    # APR-006 "current assignee, pending action, elapsed time" -- bridges
    # through the current draft version, see models.TestCase's own
    # properties. None once nothing is pending (Approved with no draft in
    # progress, or a brand-new never-submitted Draft).
    pending_with_user_id: Optional[int] = None
    pending_with_user_name: Optional[str] = None
    pending_since: Optional[datetime.datetime] = None
    steps: List[TestStepOut] = []
    # Also present on the PAG-005 list schema below (which has no `steps` at
    # all) -- kept here too so a mutation response (checkout/checkin/review/
    # save) has the same field the list state expects, for any consumer that
    # still merges a full record back into a list row rather than reloading.
    steps_count: int = 0


class TestCaseListOut(ORMModel):
    """PAG-005 lightweight list schema -- mirrors
    modules/test-management/TestRepository.tsx's list table exactly.
    `steps_count` replaces the full `steps` array (see models.TestCase.
    steps_count) -- the list table only ever shows a count, never step
    text/expected results."""
    id: int
    test_case_key: str
    project_id: int
    folder_id: Optional[int] = None
    folder_name: Optional[str] = None
    epic_id: Optional[str] = None
    cr_number: Optional[str] = None
    feature_id: Optional[str] = None
    user_story_id: Optional[str] = None
    test_type: Optional[str] = None
    module_name: Optional[str] = None
    test_scenario: Optional[str] = None
    priority: Optional[str] = None
    tags: List[str] = []
    status: str
    version: str = "1.0"
    current_approved_version_id: Optional[int] = None
    current_draft_version_id: Optional[int] = None
    current_draft_author_id: Optional[int] = None
    current_draft_author_name: Optional[str] = None
    # GOV-002 gap fix -- see models.TestCase.current_draft_submitted_by_id/
    # current_draft_reviewed_by_id's own docstring.
    current_draft_submitted_by_id: Optional[int] = None
    current_draft_reviewed_by_id: Optional[int] = None
    # "show submitted by as well" -- see models.TestCase.
    # current_draft_submitted_by_name's own docstring.
    current_draft_submitted_by_name: Optional[str] = None
    # "Add Recommended By once recommended" -- see models.TestCase.
    # current_draft_reviewed_by_name's own docstring.
    current_draft_reviewed_by_name: Optional[str] = None
    created_by_id: Optional[int] = None
    created_by_name: Optional[str] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    checked_out_by_id: Optional[int] = None
    checked_out_by_name: Optional[str] = None
    checked_out_at: Optional[datetime.datetime] = None
    # 2026-08 "Recycle Bin" requirement -- see models.TestCase.is_deleted's
    # own docstring. False/None for every normal (non-recycled) case.
    is_deleted: bool = False
    deleted_by_name: Optional[str] = None
    deleted_at: Optional[datetime.datetime] = None
    pending_with_user_id: Optional[int] = None
    pending_with_user_name: Optional[str] = None
    pending_since: Optional[datetime.datetime] = None
    steps_count: int = 0


class TestCaseSummaryOut(BaseModel):
    """SRS 7.2 pagination rollout -- Test Repository's folder tree, tag
    filter dropdown, and project-wide "Test cases / Approved / Pending
    review / Critical" stat bar all used to be computed client-side from the
    complete (unpaginated) project case list. Now that the main list is a
    paginated GET /projects/{id}/test-cases, this single aggregation
    endpoint (GET /projects/{id}/test-cases/summary, computed via SQL GROUP
    BY/COUNT, never a full-row fetch) is the one source for all of those
    counts, independent of whatever page/folder/filter the main list
    currently has selected."""
    total: int
    unfiled_count: int
    folder_counts: Dict[int, int]
    approved_count: int
    in_review_count: int
    review_completed_count: int
    critical_count: int
    tags: List[str]
    # 2026-08 "Recycle Bin" requirement -- power the sidebar's "Archived"/
    # "Recycle Bin" shortcut badges the same way unfiled_count already
    # powers "Unfiled"'s. total/unfiled_count/folder_counts above now
    # exclude both Archived and soft-deleted (Recycle Bin) cases -- these
    # two are their dedicated counts.
    archived_count: int = 0
    recycle_bin_count: int = 0
    # Reported directly: "Testcases count and all should be updated based on
    # folder. otherwise creating confusion" -- total/approved_count/
    # in_review_count/critical_count above are deliberately project-wide
    # (they also power the sidebar's "All test cases" badge, which must NOT
    # change just because a different folder is open). These four are the
    # same four stats scoped to whatever folder/view the caller passed via
    # the new `folder_id` query param (see get_test_case_summary) -- equal to
    # the project-wide fields above when no folder_id was given (the "All
    # test cases" view itself). Power the "Current view" stat cards only.
    scoped_total: int = 0
    scoped_approved_count: int = 0
    scoped_in_review_count: int = 0
    scoped_critical_count: int = 0


# Summary shown when importing an xlsx sheet. imported_executions remains in
# the response for client compatibility, but new imports deliberately report
# zero until definitions pass QA Lead review and are assigned to a cycle.
class TestCaseImportResult(ORMModel):
    created_test_cases: int
    imported_executions: int
    skipped_rows: int
    errors: List[str] = []
    # Always populated when nothing was created, so the UI never has to
    # infer the primary failure from an optional row-level errors list.
    failure_reason: Optional[str] = None


class TestCycleFolderCreate(BaseModel):
    name: str


class TestCycleFolderAccessCreate(BaseModel):
    """Exactly one of `department`/`user_id` must be set -- validated in
    routers/test_execution.py::create_cycle_folder_access, mirroring
    TestProjectViewGrantCreate."""
    department: Optional[str] = None
    user_id: Optional[int] = None


class TestCycleFolderAccessOut(ORMModel):
    id: int
    folder_id: int
    department: Optional[str] = None
    user_id: Optional[int] = None
    user_name: Optional[str] = None
    granted_by_id: Optional[int] = None
    granted_by_name: Optional[str] = None
    created_at: datetime.datetime


class TestCycleFolderOut(ORMModel):
    id: int
    project_id: int
    name: str
    created_by_id: Optional[int] = None
    created_by_name: Optional[str] = None
    created_at: datetime.datetime
    # Reported directly: "give access department based or user level, same
    # behaviour like project has" -- non-empty access_grants means this
    # folder is RESTRICTED (see models.TestCycleFolder's own docstring);
    # empty means it's visible to anyone who can execute in the project,
    # same as an Unfiled cycle. Included inline (not a separate endpoint)
    # since the folder sidebar needs to show a lock icon/count without an
    # extra round trip per folder.
    access_grants: List[TestCycleFolderAccessOut] = []
    cycle_count: int = 0


class TestCycleFolderListOut(BaseModel):
    folders: List[TestCycleFolderOut]
    # Mirrors TestCaseSummaryOut.unfiled_count/total -- the sidebar's "All
    # cycles"/"Unfiled" pseudo-folder badges. total here only counts cycles
    # this caller can actually see (i.e. excludes cycles sitting in a
    # restricted folder they don't have access to) -- see
    # deps.py::can_view_cycle_folder.
    unfiled_count: int = 0
    total: int = 0


class TestCycleCreate(BaseModel):
    name: str
    description: Optional[str] = None
    start_date: datetime.date
    end_date: datetime.date
    # Reported directly: "Create Test Cycle Folder ... Under this folder
    # create test cycle." None means Unfiled, same convention as
    # TestCaseCreate/TestCaseModal's own folder_id.
    folder_id: Optional[int] = None
    # Reported: "failure in test lifecycle and testcases, basically on test
    # management" -- routers/test_execution.py::create_cycle unconditionally
    # reads payload.linked_request_id/linked_request_type (added alongside
    # the "Linked Child Request" feature, and correctly present on
    # TestCycleUpdate/TestCycleOut below), but this Create schema was never
    # updated to match -- it only had the vestigial `qa_request_id` field
    # below, which nothing in create_cycle ever read. Since Pydantic v2's
    # default extra="ignore" silently drops any field the frontend sent that
    # isn't declared here, `payload.linked_request_id` didn't just come back
    # None -- the attribute didn't exist on the model at all, so every single
    # POST /projects/{project_id}/cycles (creating a new Test Cycle) raised
    # AttributeError -> unhandled 500, unconditionally, whether or not a
    # linked request was even selected. Editing an existing cycle
    # (TestCycleUpdate) was never affected -- only creation was broken.
    linked_request_type: Optional[str] = None
    linked_request_id: Optional[int] = None
    # CYC-001 / LNK-003.
    cycle_type: Optional[str] = None
    environment: Optional[str] = None
    build: Optional[str] = None
    owner_id: Optional[int] = None


class TestCycleUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    start_date: Optional[datetime.date] = None
    end_date: Optional[datetime.date] = None
    linked_request_type: Optional[str] = None
    linked_request_id: Optional[int] = None
    cycle_type: Optional[str] = None
    environment: Optional[str] = None
    build: Optional[str] = None
    owner_id: Optional[int] = None
    blocking_reason: Optional[str] = None
    remarks: Optional[str] = None
    reason: Optional[str] = None  # 2026-08 Reassignment Requirement -- mandatory only when owner_id changes and a previous owner already existed
    # Lets an existing cycle be moved between folders (or back to Unfiled via
    # explicit null) after creation, same latitude TestCaseBulkUpdate/
    # TestCaseModal already give Test Repository folders.
    folder_id: Optional[int] = None


class TestCycleOut(ORMModel):
    id: int
    cycle_key: str
    project_id: int
    name: str
    description: Optional[str] = None
    status: str
    start_date: Optional[datetime.date] = None
    end_date: Optional[datetime.date] = None
    folder_id: Optional[int] = None
    folder_name: Optional[str] = None
    linked_request_type: Optional[str] = None
    linked_request_id: Optional[int] = None
    linked_request_key: Optional[str] = None
    cycle_type: Optional[str] = None
    environment: Optional[str] = None
    build: Optional[str] = None
    owner_id: Optional[int] = None
    owner_name: Optional[str] = None
    created_by_id: Optional[int] = None
    created_at: datetime.datetime


class EligibleTestCycleOut(ORMModel):
    id: int
    cycle_key: str
    project_id: int
    project_key: str
    project_name: str
    name: str
    status: str
    start_date: Optional[datetime.date] = None
    end_date: Optional[datetime.date] = None


class TestExecutionAdd(BaseModel):
    """Add one or more existing test cases to a cycle -- creates a
    Not-Executed TestExecution row for each (see routers/test_execution.py)."""
    test_case_ids: List[int]
    assigned_to_id: Optional[int] = None


class TestCaseCandidateOut(ORMModel):
    """Compact cycle-candidate row. Full testcase/version content is loaded
    only when a user opens a testcase, never for the bulk picker."""
    id: int
    test_case_key: str
    test_scenario: Optional[str] = None
    test_type: Optional[str] = None
    priority: Optional[str] = None
    module_name: Optional[str] = None
    version: str = "1.0"


class TestCaseCandidatePage(BaseModel):
    items: List[TestCaseCandidateOut]
    total: int
    next_cursor: Optional[int] = None
    has_more: bool = False


class TestExecutionCandidateSelection(BaseModel):
    """Server-side selection used by the Add Test Cases modal.

    ``all_matching`` represents the current database filter plus a small set
    of rows the user explicitly unchecked. It therefore remains a constant-
    size request even when tens of thousands of testcases match.
    """
    selection_mode: Literal["ids", "all_matching"] = "ids"
    test_case_ids: List[int] = []
    excluded_ids: List[int] = []
    search: Optional[str] = None
    priority: Optional[str] = None
    assigned_to_id: Optional[int] = None


class TestExecutionAddResult(BaseModel):
    created_count: int
    skipped_count: int = 0
    job_id: Optional[str] = None
    status: Optional[str] = None


class TestExecutionUpdate(BaseModel):
    status: str
    actual_result: Optional[str] = None
    test_run_artifacts: Optional[str] = None
    defect_id: Optional[str] = None
    # SRS EXE-007 "optimistic concurrency" -- when given, the server 409s
    # instead of recording the attempt if this slot's run_version has moved
    # on since the client last read it (someone else already saved a newer
    # attempt). Optional so older/simpler callers (e.g. Excel import) still
    # work unchanged -- the check only runs when a caller opts in.
    expected_run_version: Optional[int] = None


class TestExecutionVersionUpgrade(BaseModel):
    """CYC-006 -- upgrade an unexecuted cycle item to a newer approved
    version after reviewing a change summary. Rejected once any attempt
    exists against the slot (see models.TestExecution's own docstring)."""
    target_version_id: int


class TestExecutionBulkResult(BaseModel):
    """Record the same execution outcome as a new attempt on several
    testcase slots. The router validates the complete selection before it
    writes anything, so the operation is atomic."""
    execution_ids: List[int]
    status: str
    actual_result: Optional[str] = None
    test_run_artifacts: Optional[str] = None
    defect_id: Optional[str] = None
    defect_url: Optional[str] = None
    defect_title: Optional[str] = None
    defect_status: Optional[str] = None
    defect_notes: Optional[str] = None


class TestExecutionBulkRemove(BaseModel):
    execution_ids: List[int]


class TestExecutionBulkRemoveResult(BaseModel):
    removed_count: int
    removed_execution_ids: List[int]
    removed_test_case_keys: List[str]
    removed_attempt_count: int
    removed_evidence_count: int


class TestExecutionAssign(BaseModel):
    assigned_to_id: Optional[int] = None
    # 2026-08 Reassignment CR -- mandatory only when this execution already
    # has a runner (i.e. this call is actually a reassignment/unassignment,
    # not the first-ever assignment). Enforced server-side in
    # test_execution.py::assign_execution via reassignment.require_reason.
    reason: Optional[str] = None


class TestExecutionBulkAssign(BaseModel):
    execution_ids: List[int]
    assigned_to_id: int
    # 2026-08 Reassignment CR -- mandatory only if ANY of the selected
    # executions already has a runner. See TestExecutionAssign.reason.
    reason: Optional[str] = None


class TestRunDefectCreate(BaseModel):
    defect_key: str
    defect_url: Optional[str] = None
    title: Optional[str] = None
    defect_status: Optional[str] = None
    notes: Optional[str] = None


class TestRunDefectOut(ORMModel):
    id: int
    run_id: int
    defect_key: str
    defect_url: Optional[str] = None
    title: Optional[str] = None
    defect_status: Optional[str] = None
    notes: Optional[str] = None
    linked_by_id: Optional[int] = None
    linked_by_name: Optional[str] = None
    created_at: datetime.datetime


class LinkedGovernedDefectRef(ORMModel):
    """A governed Defect (defects.py, not the free-text TestRunDefect above)
    linked to a specific execution slot via Defect.execution_id. Reported
    directly: while any linked defect is active (not Deferred/Closed) the
    whole execution is locked, and once failed at least once, 'Pass'/'NA'
    stay permanently blocked -- the frontend needs each linked defect's own
    key + governed status to explain why, not just a yes/no flag. See
    routers/test_execution.py::_execution_status_gate for where this is
    enforced server-side too (this field is read-only/informational)."""
    id: int
    defect_key: str
    status: str


class TestExecutionRunOut(ORMModel):
    """One immutable historical attempt -- see models.TestExecutionRun."""
    id: int
    execution_id: int
    attempt_no: int
    status: str
    actual_result: Optional[str] = None
    test_run_artifacts: Optional[str] = None
    defect_id: Optional[str] = None
    executed_by_id: Optional[int] = None
    executed_by_name: Optional[str] = None
    executed_at: Optional[datetime.datetime] = None
    defects: List[TestRunDefectOut] = []


class TestExecutionOut(ORMModel):
    id: int
    cycle_id: int
    test_case_id: int
    test_case: Optional[TestCaseOut] = None
    # SRS CYC-004 -- the exact version this slot is pinned to, frozen once
    # any attempt exists. pinned_version_label is the "1.0"/"1.1"-style
    # string; is_pinned_stale flags when the testcase's current approved
    # version has since moved on (surfaced as an upgrade affordance while
    # still unexecuted, or as a "Version impact" report entry once it isn't).
    pinned_version_id: Optional[int] = None
    pinned_version_label: Optional[str] = None
    is_pinned_stale: bool = False
    status: str
    actual_result: Optional[str] = None
    test_run_artifacts: Optional[str] = None
    defect_id: Optional[str] = None
    assigned_to_id: Optional[int] = None
    assigned_to_name: Optional[str] = None
    assigned_by_id: Optional[int] = None
    assigned_by_name: Optional[str] = None
    assigned_at: Optional[datetime.datetime] = None
    executed_by_id: Optional[int] = None
    executed_by_name: Optional[str] = None
    executed_at: Optional[datetime.datetime] = None
    # Scenario 1 self-remove fix -- see models.TestExecution.added_by_id's
    # own docstring. None for any slot created before this column existed.
    added_by_id: Optional[int] = None
    added_by_name: Optional[str] = None
    run_count: int = 0
    run_version: int = 0
    created_at: datetime.datetime
    # Full attempt-by-attempt history, oldest first -- see
    # models.TestExecutionRun. The columns above always mirror runs[-1] once
    # at least one attempt has been recorded.
    runs: List[TestExecutionRunOut] = []
    # Governed Defect(s) (defects.py) linked to this slot -- see
    # LinkedGovernedDefectRef's own docstring.
    linked_defects: List[LinkedGovernedDefectRef] = []


class TestExecutionSummaryOut(BaseModel):
    """SRS 7.2 pagination rollout -- see routers/test_execution.py's
    get_execution_summary docstring for what this replaces (the progress
    bar, assignment stat, "My queue" count, and both tab bars on
    TestExecution.tsx's cycle detail view)."""
    total: int
    status_counts: Dict[str, int]
    executed_count: int
    assigned_count: int
    unassigned_count: int
    mine_count: int
    total_run_count: int


class DefectLinkableExecutionOut(ORMModel):
    """2026-08 -- reported directly: on Defect Management's page load, "if
    there are 30 project[s] then 30 api call[s] ... same for cycles,
    executions" -- Defects.tsx used to fan out one /my-access call per
    project, then one /cycles call per project, then one /executions call
    per cycle in that project, purely to build the "pick a Failed/Blocked
    execution" dropdown for creating/linking a defect. This is the single
    batch replacement: routers/test_execution.py::list_blocked_failed_
    executions joins TestProject -> TestCycle -> TestExecution server-side
    in one query (scoped to active projects, status in Fail/Blocked, and the
    caller's own department scope) and returns one flattened row per
    execution, each carrying its project/cycle context alongside it --
    mirrors the frontend's own pre-existing `ExecutionContext` shape
    (project + cycle + execution) exactly, so Defects.tsx's own dropdown/
    picker code needs no logic changes, only its data source."""
    project: TestProjectOut
    cycle: TestCycleOut
    execution: TestExecutionOut


# ---------------- Test Management Reporting (SRS section 11) ----------------
# Typed response contracts for routers/test_reports.py -- RPT-002 "Counts
# shall link to the filtered underlying records" is carried by
# ReportFilterRef on every grouped row: the frontend reproduces that exact
# slice by passing these fields to the existing list endpoints
# (test_repository.py::list_test_cases, test_execution.py::list_executions,
# etc.), so this router itself never needs to return the underlying rows.
class ReportFilterRef(BaseModel):
    project_id: Optional[int] = None
    cycle_id: Optional[int] = None
    status: Optional[str] = None
    test_case_id: Optional[int] = None
    requirement: Optional[str] = None


class ReportCountRow(BaseModel):
    key: str
    count: int
    filters: ReportFilterRef


class ReportStatusCountRow(BaseModel):
    status: str
    count: int
    filters: ReportFilterRef


class RepositoryHealthOut(BaseModel):
    project_id: int
    project_key: str
    population_note: str
    total_cases: int
    by_status: List[ReportCountRow]
    by_module: List[ReportCountRow]
    by_priority: List[ReportCountRow]
    by_test_type: List[ReportCountRow]
    by_owner: List[ReportCountRow]
    average_age_days: float
    never_executed_count: int


class CycleProgressOut(BaseModel):
    cycle_id: int
    cycle_key: str
    cycle_status: str
    population_note: str
    total_items: int
    by_status: List[ReportStatusCountRow]
    assigned_count: int
    unassigned_count: int
    completion_pct: float
    is_locked: bool


class DefectQualityOut(BaseModel):
    project_id: int
    project_key: str
    population_note: str
    total_defect_links: int
    by_module: List[ReportCountRow]
    by_status: List[ReportCountRow]
    retest_success_rate_pct: float


class VersionImpactItemOut(BaseModel):
    cycle_id: int
    cycle_key: str
    cycle_status: str
    stale_item_count: int
    upgradeable_count: int
    permanently_pinned_count: int
    filters: ReportFilterRef


class VersionImpactOut(BaseModel):
    project_id: int
    project_key: str
    population_note: str
    cycles_with_stale_items: int
    total_items: int
    returned_items: int
    items: List[VersionImpactItemOut]


class CycleStatusCountRow(BaseModel):
    status: str
    count: int


class CycleTrendPointOut(BaseModel):
    month: str
    count: int


class ProjectOwnershipRow(BaseModel):
    owner: str
    project_count: int


class ProjectPortfolioOut(BaseModel):
    population_note: str
    active_project_count: int
    inactive_project_count: int
    archived_project_count: int
    cycle_count: int
    cycles_by_status: List[CycleStatusCountRow]
    cycle_creation_trend: List[CycleTrendPointOut]
    ownership: List[ProjectOwnershipRow]


# ---------------- Pending Approvals (see routers/pending_approvals.py) ----------------
class PendingApprovalCount(BaseModel):
    """Lightweight login summary; detailed rows load only in the workspace."""
    count: int


class PendingApprovalItem(BaseModel):
    """One row in the logged-in user's Pending Approvals feed -- a single
    checkpoint, on a single entity, that is genuinely awaiting THIS user's
    decision right now (see routers/pending_approvals.py's own module
    docstring for exactly how "awaiting this user" is worked out per
    category). Not an ORM model -- built up as plain dicts across many
    different tables (ApplicationMaster, FunctionalRequest, SASTRequest,
    DASTRequest, PerformanceRequest, SuppressionRequest, QASignOff,
    TestProject), so there's no single underlying row shape to map
    from_attributes onto."""
    category: str          # e.g. "Application Name -- Application Owner Approval"
    entity_type: str        # e.g. "APPLICATION_MASTER", "FUNCTIONAL_REQUEST", "SAST", ...
    entity_id: int
    display_id: Optional[str] = None    # business id, e.g. "TQA-FUNC-0007" -- None where the entity has no business id of its own (ApplicationMaster)
    # Reported directly: "Parent Section should be Project Name, the Folder
    # wise testcase segregation" -- for a QA-Request-backed category
    # (Functional/SAST/DAST/Performance/Suppression/Sign-off) this remains
    # the gateway's own business id (e.g. "TQA-REQ-0007"); for TEST_CASE
    # items (which have no QA Request parent at all) this is instead the
    # owning Test Project's own identity ("<project_key> — <name>"), so the
    # frontend's existing parent-grouping-by-this-field logic clusters every
    # pending test case under its Test Project card instead of showing one
    # "Standalone Request" card per test case. parent_label distinguishes
    # the two so the frontend can label the card accurately ("Parent QA
    # Request" vs "Test Project") without hardcoding entity_type checks.
    parent_request_id: Optional[str] = None  # gateway business id, e.g. TQA-REQ-0007, OR a Test Project's own identity
    parent_path: Optional[str] = None
    parent_label: Optional[str] = None  # e.g. "Parent QA Request" or "Test Project" -- None defaults to the QA-Request wording on the frontend
    # Second-level grouping WITHIN a parent card, e.g. the Test Repository
    # folder a pending test case lives in ("Unfiled" when it has none).
    # Always None for every other category.
    folder_name: Optional[str] = None
    title: str               # short human label, e.g. the application name or "Functional Testing -- SM Approval"
    status: str
    status_label: str
    department: Optional[str] = None
    submitted_by: Optional[str] = None
    submitted_at: Optional[datetime.datetime] = None
    path: str                # frontend route to open this item for review
