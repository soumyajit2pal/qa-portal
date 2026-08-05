import datetime
import re
from typing import Optional, List
from pydantic import BaseModel, ConfigDict, field_validator


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
    department: Optional[str] = None
    roles: List[str]
    login_type: str
    is_active: bool
    needs_role_review: bool = False
    # True right after first-ever LDAP login until the person picks their own
    # department via PATCH /api/auth/me -- see models.User.needs_department_selection.
    needs_department_selection: bool = False
    # System-Admin-only flag -- see models.User.admin_managed_only. When True,
    # this user is hidden from Department Admin / Executive COE local-admin
    # rosters and only a System Admin can reassign their role(s) or status.
    admin_managed_only: bool = False

    _normalize_full_name = field_validator("full_name", mode="before")(_plain_person_name)


class UserCreate(BaseModel):
    username: str
    full_name: str
    email: Optional[str] = None
    department: Optional[str] = None
    roles: List[str]                    # a user must be assigned at least one role
    login_type: str = "STANDARD"       # STANDARD / LDAP
    password: Optional[str] = None      # required when login_type == STANDARD; ignored for LDAP


class UserUpdate(BaseModel):
    """Admin-only partial update -- role reassignment, activation, login-type change, etc.
    `roles`, if provided, REPLACES the user's full set of assigned roles."""
    full_name: Optional[str] = None
    email: Optional[str] = None
    department: Optional[str] = None
    roles: Optional[List[str]] = None
    login_type: Optional[str] = None
    is_active: Optional[bool] = None
    needs_role_review: Optional[bool] = None
    # See models.User.admin_managed_only -- only reachable through this
    # Admin-only endpoint (require_roles(Role.ADMIN)), never through
    # LocalAdminUserUpdate below, so a Department Head/Executive COE can
    # never set or clear this on anyone, including themselves.
    admin_managed_only: Optional[bool] = None


class PasswordReset(BaseModel):
    new_password: str


class LocalAdminUserUpdate(BaseModel):
    """Body for PATCH /api/auth/local-admin/users/{id} -- a Department Head's
    (or Executive COE's, for the QA department) deliberately narrower
    counterpart to the Admin-only UserUpdate above. Only `roles` (constrained
    server-side to DEPARTMENT_ADMIN_ASSIGNABLE_ROLES or
    QA_ADMIN_ASSIGNABLE_ROLES depending on which kind of local admin is
    calling -- see routers/auth.py::_local_admin_assignable_roles) and
    `is_active` may be touched this way -- no department, login type,
    profile fields, or password. See routers/auth.py::update_local_admin_user."""
    roles: Optional[List[str]] = None
    is_active: Optional[bool] = None


class DepartmentSelection(BaseModel):
    """Body for PATCH /api/auth/me -- the one thing a logged-in user (not
    just an Admin) can set on their own profile, used by the first-LDAP-login
    department-selection popup."""
    department: str


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


class AuditLogPage(BaseModel):
    rows: List[AuditLogOut]
    total: int
    page: int
    page_size: int
    summary: AuditSummary


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


class WalkthroughCreate(BaseModel):
    conducted_by: Optional[str] = None
    participants: Optional[str] = None
    recording_path: Optional[str] = None
    document_path: Optional[str] = None
    notes: Optional[str] = None


class WalkthroughOut(ORMModel):
    id: int
    session_date: datetime.datetime
    conducted_by: Optional[str] = None
    participants: Optional[str] = None
    recording_path: Optional[str] = None
    document_path: Optional[str] = None
    qa_acknowledged_by_id: Optional[int] = None
    qa_acknowledged_at: Optional[datetime.datetime] = None
    notes: Optional[str] = None


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
    vendor_si_partner: Optional[str] = None
    technology_stack: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    environment: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    request_types: List[str] = []
    request_type_other: Optional[str] = None
    target_release_date: Optional[datetime.date] = None
    supporting_doc_path: Optional[str] = None
    remarks: Optional[str] = None
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
    vendor_si_partner: Optional[str] = None
    technology_stack: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    environment: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    request_types: Optional[str] = None
    request_type_other: Optional[str] = None
    target_release_date: Optional[datetime.date] = None
    supporting_doc_path: Optional[str] = None
    remarks: Optional[str] = None
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
    # Auto-linked child requests generated because this request's
    # request_types included the matching type (see _sync_linked_child_requests).
    linked_functional_requests: List[LinkedRequestRef] = []
    linked_sast_requests: List[LinkedRequestRef] = []
    linked_dast_requests: List[LinkedRequestRef] = []
    linked_performance_requests: List[LinkedRequestRef] = []
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
    created_at: datetime.datetime
    updated_at: datetime.datetime
    qa_request_id: Optional[int] = None
    qa_request: Optional[LinkedRequestRef] = None
    # Delegated from the linked QA Request gateway.
    application_name: Optional[str] = None
    epic_number: Optional[str] = None
    department: Optional[str] = None
    application_owner: Optional[str] = None
    request_types: Optional[str] = None
    target_release_date: Optional[datetime.date] = None
    cr_number: Optional[str] = None
    change_type: Optional[str] = None
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
    """Department Head reviews the request and assigns its IT-QA QA Lead."""
    decision: str                          # Approved / Returned / Rejected
    comments: Optional[str] = None
    qa_lead_id: Optional[int] = None


class AssignTesterIn(BaseModel):
    tester_ids: List[int]


class AssignSecurityAnalystIn(BaseModel):
    security_analyst_id: int


class SecurityDeptHeadDecisionIn(BaseModel):
    """SAST/DAST Department Head decision with IT-QA QA Lead assignment."""
    decision: str                          # Approved / Returned / Rejected
    comments: Optional[str] = None
    qa_lead_id: Optional[int] = None
    security_lead_id: Optional[int] = None  # legacy alias for qa_lead_id


class PerformanceDeptHeadDecisionIn(BaseModel):
    """Performance Department Head decision with IT-QA QA Lead assignment."""
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
    """Payload for SAST/DAST's Complete Scan confirmation pop-up ("Are you
    sure no security findings were identified during the scan?"). True ->
    no findings, request fast-tracks toward Security Complete/Report Ready/
    Closed; False -> findings were identified, request goes to Finding
    Validation and the UI switches to the Findings tab so they can be
    logged."""
    no_findings: bool
    comments: Optional[str] = None


class CommentIn(BaseModel):
    """Payload for simple, non-branching lifecycle transitions (raise defect,
    mark waiting for fix, start retesting/regression, etc.)."""
    comments: Optional[str] = None


class ConfirmSignoffIn(BaseModel):
    signoff_id: Optional[int] = None
    comments: Optional[str] = None


class RequestSignoffIn(BaseModel):
    """Optional -- lets the frontend link a QA Sign-off Certificate (created
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


class SASTOut(ORMModel):
    id: int
    request_id: str
    application_name: str
    epic_number: Optional[str] = None
    cr_number: Optional[str] = None
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
    qa_request_id: Optional[int] = None
    qa_request: Optional[LinkedRequestRef] = None
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


class PerformanceOut(ORMModel):
    id: int
    request_id: str
    application_name: str
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
    created_at: datetime.datetime

    _normalize_actor_name = field_validator("actor_name", mode="before")(_plain_person_name)


class CommentCreate(BaseModel):
    body: str


# ---------------- Module 8: QA Sign-off ----------------
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
    # (Executive COE) -- see models.QASignOff for the full reasoning.
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


# ---------------- Module 11: Test Management (Project Management / Test Repository / Test Execution) ----------------
class TestProjectCreate(BaseModel):
    name: str
    application_master_id: Optional[int] = None
    department: Optional[str] = None
    description: Optional[str] = None


class TestProjectUpdate(BaseModel):
    name: Optional[str] = None
    application_master_id: Optional[int] = None
    department: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None


class TestProjectOut(ORMModel):
    id: int
    project_key: str
    name: str
    application_master_id: Optional[int] = None
    department: Optional[str] = None
    description: Optional[str] = None
    is_active: bool
    created_by_id: Optional[int] = None
    created_at: datetime.datetime
    pending_is_active: Optional[bool] = None
    pending_requested_by_id: Optional[int] = None
    pending_requested_by_name: Optional[str] = None
    pending_requested_at: Optional[datetime.datetime] = None


class TestProjectActivationReview(BaseModel):
    decision: str
    comments: Optional[str] = None


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
    # The API always creates cases as Draft/Pending QA Lead Review. Kept in
    # the input shape for backward compatibility with older clients, but the
    # router never trusts a client-supplied lifecycle status.
    status: str = "Draft"
    steps: List[TestStepIn] = []


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
    status: Optional[str] = None
    steps: Optional[List[TestStepIn]] = None


class TestCaseBulkUpdate(BaseModel):
    ids: List[int]
    # model_fields_set lets the endpoint distinguish "leave folder unchanged"
    # from an explicit null meaning "move selected cases to Unfiled".
    folder_id: Optional[int] = None
    priority: Optional[str] = None
    status: Optional[str] = None


class TestCaseBulkDelete(BaseModel):
    ids: List[int]


class TestCaseBulkApprove(BaseModel):
    ids: List[int]
    comments: str


class TestCaseReview(BaseModel):
    decision: str
    comments: Optional[str] = None


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
    status: str
    version: str = "1.0"
    created_by_id: Optional[int] = None
    created_by_name: Optional[str] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    checked_out_by_id: Optional[int] = None
    checked_out_by_name: Optional[str] = None
    checked_out_at: Optional[datetime.datetime] = None
    steps: List[TestStepOut] = []


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


class TestCycleCreate(BaseModel):
    name: str
    description: Optional[str] = None
    start_date: Optional[datetime.date] = None
    end_date: Optional[datetime.date] = None


class TestCycleUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    start_date: Optional[datetime.date] = None
    end_date: Optional[datetime.date] = None


class TestCycleOut(ORMModel):
    id: int
    cycle_key: str
    project_id: int
    name: str
    description: Optional[str] = None
    status: str
    start_date: Optional[datetime.date] = None
    end_date: Optional[datetime.date] = None
    created_by_id: Optional[int] = None
    created_at: datetime.datetime


class TestExecutionAdd(BaseModel):
    """Add one or more existing test cases to a cycle -- creates a
    Not-Executed TestExecution row for each (see routers/test_execution.py)."""
    test_case_ids: List[int]
    assigned_to_id: Optional[int] = None


class TestExecutionUpdate(BaseModel):
    status: str
    actual_result: Optional[str] = None
    test_run_artifacts: Optional[str] = None
    defect_id: Optional[str] = None


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
    run_count: int = 0
    created_at: datetime.datetime
    # Full attempt-by-attempt history, oldest first -- see
    # models.TestExecutionRun. The columns above always mirror runs[-1] once
    # at least one attempt has been recorded.
    runs: List[TestExecutionRunOut] = []


# ---------------- Pending Approvals (see routers/pending_approvals.py) ----------------
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
    title: str               # short human label, e.g. the application name or "Functional Testing -- SM Approval"
    status: str
    status_label: str
    department: Optional[str] = None
    submitted_by: Optional[str] = None
    submitted_at: Optional[datetime.datetime] = None
    path: str                # frontend route to open this item for review
