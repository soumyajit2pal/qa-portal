import datetime
from typing import Optional, List
from pydantic import BaseModel, ConfigDict


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------- Auth / Users ----------------
class Token(ORMModel):
    access_token: str
    token_type: str = "bearer"
    roles: List[str]
    full_name: str
    username: str


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


class PasswordReset(BaseModel):
    new_password: str


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
    without pulling the full nested payload (findings, etc.)."""
    id: int
    request_id: str
    status: Optional[str] = None


class QARequestDocumentOut(ORMModel):
    id: int
    file_name: str
    content_type: Optional[str] = None
    file_size: Optional[int] = None
    uploaded_by_id: Optional[int] = None
    uploaded_at: datetime.datetime


class QARequestCreate(BaseModel):
    department: Optional[str] = None
    application_name: str
    application_owner: Optional[str] = None
    cr_number: Optional[str] = None
    project_name: Optional[str] = None
    release_version: Optional[str] = None
    environment: Optional[str] = None
    request_types: List[str] = []
    request_type_other: Optional[str] = None
    priority: Optional[str] = None
    risk_rating: Optional[str] = None
    target_release_date: Optional[datetime.date] = None
    supporting_doc_path: Optional[str] = None
    remarks: Optional[str] = None
    # Readiness checklist items the requester is self-declaring as already
    # satisfied (matched by item text against DEFAULT_CHECKLIST_ITEMS). This
    # is informational for the QA Lead, who still independently verifies
    # every item -- see requester_checked on ReadinessChecklistItem.
    checked_items: List[str] = []


class QARequestUpdate(QARequestCreate):
    application_name: Optional[str] = None


class QARequestOut(ORMModel):
    id: int
    request_id: str
    request_date: Optional[datetime.date] = None
    department: Optional[str] = None
    application_name: str
    application_owner: Optional[str] = None
    cr_number: Optional[str] = None
    project_name: Optional[str] = None
    release_version: Optional[str] = None
    environment: Optional[str] = None
    request_types: Optional[str] = None
    request_type_other: Optional[str] = None
    priority: Optional[str] = None
    risk_rating: Optional[str] = None
    target_release_date: Optional[datetime.date] = None
    supporting_doc_path: Optional[str] = None
    remarks: Optional[str] = None
    status: str
    requester_id: Optional[int] = None
    department_head_id: Optional[int] = None
    qa_lead_id: Optional[int] = None
    assigned_tester_ids: Optional[str] = None
    signoff_id: Optional[int] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    # Auto-linked SAST/DAST requests generated because this request's
    # request_types included SAST and/or DAST (see _sync_linked_security_requests).
    linked_sast_requests: List[LinkedRequestRef] = []
    linked_dast_requests: List[LinkedRequestRef] = []


class WorkflowDecision(BaseModel):
    decision: str          # Approved / Rejected / Returned
    comments: Optional[str] = None


# ---- QA Request lifecycle-specific payloads ----
class DepartmentHeadDecisionIn(BaseModel):
    """Department Head reviews the freshly-submitted request and, on
    approval, assigns the QA Lead."""
    decision: str                          # Approved / Returned / Rejected
    comments: Optional[str] = None
    qa_lead_id: Optional[int] = None        # required when decision == "Approved"


class AssignTesterIn(BaseModel):
    tester_ids: List[int]


class ReadinessDecisionIn(BaseModel):
    decision: str                          # Passed / Failed
    comments: Optional[str] = None


class RequesterDecisionIn(BaseModel):
    decision: str                          # Accepted / ChangesRequired
    comments: Optional[str] = None


class CommentIn(BaseModel):
    """Payload for simple, non-branching lifecycle transitions (raise defect,
    mark waiting for fix, start retesting/regression, etc.)."""
    comments: Optional[str] = None


class ConfirmSignoffIn(BaseModel):
    signoff_id: Optional[int] = None
    comments: Optional[str] = None


# ---------------- Module 2: Test Case ----------------
# DISABLED for now -- see main.py; schemas kept for when the module is re-enabled.
class TestCaseCreate(BaseModel):
    epic_id: Optional[str] = None
    feature_id: Optional[str] = None
    user_story_id: Optional[str] = None
    test_type: Optional[str] = None
    module_name: Optional[str] = None
    project_name: Optional[str] = None
    test_scenario: Optional[str] = None
    precondition: Optional[str] = None
    description: Optional[str] = None
    steps: Optional[str] = None
    expected_result: Optional[str] = None
    priority: Optional[str] = None
    qa_request_id: Optional[int] = None


class TestCaseUpdate(BaseModel):
    epic_id: Optional[str] = None
    feature_id: Optional[str] = None
    user_story_id: Optional[str] = None
    test_type: Optional[str] = None
    module_name: Optional[str] = None
    project_name: Optional[str] = None
    test_scenario: Optional[str] = None
    precondition: Optional[str] = None
    description: Optional[str] = None
    steps: Optional[str] = None
    expected_result: Optional[str] = None
    actual_result: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    review_status: Optional[str] = None
    defect_id: Optional[str] = None
    is_archived: Optional[bool] = None


class TestCaseOut(ORMModel):
    id: int
    test_case_id: str
    epic_id: Optional[str] = None
    feature_id: Optional[str] = None
    user_story_id: Optional[str] = None
    test_type: Optional[str] = None
    module_name: Optional[str] = None
    project_name: Optional[str] = None
    test_scenario: Optional[str] = None
    precondition: Optional[str] = None
    description: Optional[str] = None
    steps: Optional[str] = None
    expected_result: Optional[str] = None
    priority: Optional[str] = None
    actual_result: Optional[str] = None
    status: str
    review_status: str
    defect_id: Optional[str] = None
    version: int
    is_archived: bool
    qa_request_id: Optional[int] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime


# ---------------- Module 3: Test Execution ----------------
# DISABLED for now -- see main.py; schemas kept for when the module is re-enabled.
class TestRunCreate(BaseModel):
    project: Optional[str] = None
    application: Optional[str] = None
    release: Optional[str] = None
    run_type: str
    start_date: Optional[datetime.date] = None
    end_date: Optional[datetime.date] = None
    test_case_ids: List[int] = []


class TestRunCaseOut(ORMModel):
    id: int
    test_run_id: int
    test_case_id: int
    execution_status: str
    actual_result: Optional[str] = None
    defect_id: Optional[str] = None
    executed_at: Optional[datetime.datetime] = None


class TestRunOut(ORMModel):
    id: int
    test_run_id: str
    project: Optional[str] = None
    application: Optional[str] = None
    release: Optional[str] = None
    run_type: str
    qa_owner_id: Optional[int] = None
    start_date: Optional[datetime.date] = None
    end_date: Optional[datetime.date] = None
    status: str
    created_at: datetime.datetime
    cases: List[TestRunCaseOut] = []


class TestRunCaseUpdate(BaseModel):
    execution_status: str
    actual_result: Optional[str] = None
    defect_id: Optional[str] = None


# ---------------- Module 4/5: SAST / DAST ----------------
class SASTCreate(BaseModel):
    application_name: str
    project_name: Optional[str] = None
    cr_number: Optional[str] = None
    build_number: Optional[str] = None
    repository_url: Optional[str] = None
    git_branch: Optional[str] = None
    commit_id: Optional[str] = None
    technology_stack: Optional[str] = None
    risk_category: Optional[str] = None
    hash_value: Optional[str] = None


class SASTUpdate(BaseModel):
    """Partial update -- lets the requester (or a security analyst/admin) fill in
    or correct details, including auto-linked requests created with placeholder
    data from a QA Request. Only allowed while status == 'Requested'."""
    application_name: Optional[str] = None
    project_name: Optional[str] = None
    cr_number: Optional[str] = None
    build_number: Optional[str] = None
    repository_url: Optional[str] = None
    git_branch: Optional[str] = None
    commit_id: Optional[str] = None
    technology_stack: Optional[str] = None
    risk_category: Optional[str] = None
    hash_value: Optional[str] = None


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
    project_name: Optional[str] = None
    cr_number: Optional[str] = None
    build_number: Optional[str] = None
    repository_url: Optional[str] = None
    git_branch: Optional[str] = None
    commit_id: Optional[str] = None
    technology_stack: Optional[str] = None
    risk_category: Optional[str] = None
    hash_value: Optional[str] = None
    status: str
    report_path: Optional[str] = None
    requester_id: Optional[int] = None
    created_at: datetime.datetime
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


class DASTCreate(BaseModel):
    application_url: str
    environment: Optional[str] = None
    authentication_required: bool = False
    test_credentials: Optional[str] = None
    target_release: Optional[str] = None
    risk_category: Optional[str] = None


class DASTUpdate(BaseModel):
    """Partial update -- lets the requester (or a security analyst/admin) fill in
    or correct details, including auto-linked requests created with placeholder
    data from a QA Request. Only allowed while status == 'Requested'."""
    application_url: Optional[str] = None
    environment: Optional[str] = None
    authentication_required: Optional[bool] = None
    test_credentials: Optional[str] = None
    target_release: Optional[str] = None
    risk_category: Optional[str] = None


class DASTFindingOut(ORMModel):
    id: int
    issue_id: Optional[str] = None
    severity: str
    description: Optional[str] = None
    status: str


class DASTOut(ORMModel):
    id: int
    request_id: str
    application_url: str
    environment: Optional[str] = None
    authentication_required: bool
    target_release: Optional[str] = None
    risk_category: Optional[str] = None
    status: str
    report_path: Optional[str] = None
    requester_id: Optional[int] = None
    created_at: datetime.datetime
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


# ---------------- Module 6: Suppression ----------------
class SuppressionItemIn(BaseModel):
    issue_id: Optional[str] = None
    severity: str
    description: Optional[str] = None
    justification: Optional[str] = None


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
    # autosuggest resolved to (see SASTOut/DASTOut.department/application_owner);
    # left blank if that scan has no linked QA Request.
    department: Optional[str] = None
    application_owner: Optional[str] = None
    # Exactly one of these should be set, matching scan_type.
    sast_request_id: Optional[int] = None
    dast_request_id: Optional[int] = None
    risk_assessment: Optional[str] = None
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
    risk_assessment: Optional[str] = None
    items: List[SuppressionItemOut] = []
    status: str
    app_owner_decision: Optional[str] = None
    dept_head_decision: Optional[str] = None
    created_at: datetime.datetime


# ---------------- Module 7: Approval log ----------------
class ApprovalActionOut(ORMModel):
    id: int
    entity_type: str
    entity_id: int
    # Human-readable business ID of the underlying record (e.g. "TQA-REQ-...",
    # "SAST-...", "SUP-...") resolved server-side from entity_type/entity_id --
    # None if that record no longer exists. Lets the Approval Workflow Log
    # show something meaningful instead of the raw internal entity_id.
    request_ref: Optional[str] = None
    step_name: Optional[str] = None
    actor_id: Optional[int] = None
    actor_role: Optional[str] = None
    decision: Optional[str] = None
    comments: Optional[str] = None
    created_at: datetime.datetime


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
    risk_tier: Optional[str] = None
    release_version: Optional[str] = None
    build_number: Optional[str] = None
    environment_tested: Optional[str] = None
    target_promotion_environment: Optional[str] = None
    status: str
    created_at: datetime.datetime
