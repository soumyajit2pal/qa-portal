import datetime
import uuid
from typing import List
from sqlalchemy import (
    Column, Integer, String, Text, Boolean, DateTime, ForeignKey, Date, Identity, UniqueConstraint
)
from sqlalchemy.orm import relationship
from .database import Base
from .constants import QAStatus, LoginType

# Unlike SQLite/PostgreSQL/MySQL, SQLAlchemy does NOT automatically make a
# bare `Column(Integer, primary_key=True)` self-generating on Oracle -- Oracle
# has no native AUTO_INCREMENT, so you must opt in explicitly with Identity()
# (Oracle 12c+ identity columns). Every primary key below uses this helper so
# inserts get a generated id instead of failing with ORA-01400.
def pk_column():
    return Column(Integer, Identity(start=1, increment=1), primary_key=True)


def now():
    return datetime.datetime.utcnow()


def gen_id(prefix):
    return f"{prefix}-{datetime.datetime.utcnow().strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"


class User(Base):
    __tablename__ = "qap_users"
    id = pk_column()
    username = Column(String(64), unique=True, nullable=False)
    full_name = Column(String(150), nullable=False)
    email = Column(String(150))
    department = Column(String(150))
    login_type = Column(String(16), nullable=False, default=LoginType.STANDARD)
    # Nullable because LDAP-type accounts authenticate against the directory
    # server and never store a local password hash.
    hashed_password = Column(String(255), nullable=True)
    is_active = Column(Boolean, default=True)
    # Set True when a User row is auto-created via LDAP just-in-time
    # provisioning (first successful login for an unknown username); cleared
    # once an admin explicitly reassigns a role in the Admin section.
    needs_role_review = Column(Boolean, default=False)
    created_at = Column(DateTime, default=now)

    qa_requests = relationship("QARequest", back_populates="requester", foreign_keys="QARequest.requester_id")
    # A user can now hold multiple roles simultaneously (e.g. QA Lead +
    # Security Analyst) -- replaces the old single `role` column. All
    # permission checks treat a user's assigned roles as active at once (no
    # role-switcher): see has_role() below and deps.py::require_roles.
    role_assignments = relationship("UserRole", back_populates="user", cascade="all,delete-orphan")

    @property
    def roles(self) -> List[str]:
        return [ra.role for ra in self.role_assignments]

    @property
    def roles_csv(self) -> str:
        """Snapshot of all currently-assigned roles, used when logging an
        audit action (ApprovalAction.actor_role) since a user may be acting
        under more than one role at once."""
        return ",".join(sorted(self.roles))

    def has_role(self, *roles) -> bool:
        """True if the user is an Administrator, or holds at least one of the
        given roles. Called with no arguments, checks for Administrator only."""
        codes = set(self.roles)
        return "ADMIN" in codes or bool(codes & set(roles))


class UserRole(Base):
    """Join table backing User.roles -- one row per (user, role) pair."""
    __tablename__ = "qap_user_roles"
    __table_args__ = (UniqueConstraint("user_id", "role", name="uq_qap_user_roles"),)
    id = pk_column()
    user_id = Column(Integer, ForeignKey("qap_users.id"), nullable=False)
    role = Column(String(32), nullable=False)

    user = relationship("User", back_populates="role_assignments")


class Department(Base):
    """DB-backed department list (Admin section) -- replaces the old hardcoded
    constants.DEPARTMENTS list so an admin can add/deactivate departments at
    runtime without a redeploy. See routers/departments.py. Seeded once from
    constants.SEED_DEPARTMENTS by seed.py."""
    __tablename__ = "qap_departments"
    id = pk_column()
    name = Column(String(150), unique=True, nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=now)


# ---------------------------------------------------------------------------
# Module 1: QA Request Management
# ---------------------------------------------------------------------------
class QARequest(Base):
    __tablename__ = "qap_requests"
    id = pk_column()
    request_id = Column(String(40), unique=True, default=lambda: gen_id("TQA-REQ"))
    request_date = Column(Date, default=lambda: datetime.date.today())
    department = Column(String(150))
    application_name = Column(String(150), nullable=False)
    application_owner = Column(String(150))
    cr_number = Column(String(64))
    project_name = Column(String(150))
    release_version = Column(String(64))
    environment = Column(String(32))
    request_types = Column(String(255))          # comma-separated from REQUEST_TYPES
    request_type_other = Column(String(150))
    priority = Column(String(16))
    risk_rating = Column(String(16))
    target_release_date = Column(Date)
    supporting_doc_path = Column(String(255))
    remarks = Column(Text)

    status = Column(String(32), default=QAStatus.DRAFT, index=True)
    requester_id = Column(Integer, ForeignKey("qap_users.id"))
    department_head_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)  # who performed Department Head Approval
    qa_lead_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)       # QA Lead assigned by the Department Head
    assigned_tester_ids = Column(String(255))     # comma-separated QA Engineer user ids (Tester Assigned step)
    signoff_id = Column(Integer, ForeignKey("qap_signoffs.id"), nullable=True)    # linked QA Sign-off certificate

    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    requester = relationship("User", back_populates="qa_requests", foreign_keys=[requester_id])
    checklist_items = relationship("ReadinessChecklistItem", back_populates="qa_request", cascade="all,delete-orphan")
    walkthroughs = relationship("WalkthroughSession", back_populates="qa_request", cascade="all,delete-orphan")
    # Test Case Repository (Module 2) is temporarily DISABLED (see main.py) --
    # this relationship and the TestCase model below are left in place so
    # existing/seeded data and this mapping keep working, but there's no live
    # API surface to create/browse test cases while the module is disabled.
    test_cases = relationship("TestCase", back_populates="qa_request")
    documents = relationship("QARequestDocument", back_populates="qa_request", cascade="all,delete-orphan")
    # Auto-created when this request's request_types include SAST/DAST (see
    # routers/qa_requests.py::_sync_linked_security_requests) so security
    # testing gets its own trackable unique ID while staying linked back to
    # the originating (typically Functional Testing) QA Request.
    linked_sast_requests = relationship("SASTRequest", back_populates="qa_request")
    linked_dast_requests = relationship("DASTRequest", back_populates="qa_request")


class QARequestDocument(Base):
    """Supporting documents uploaded against a QA Request (Module 1, field 4.1.2).
    Multiple files are allowed; each is stored on disk under
    backend/app/uploads/<request_id>/<filename> -- see UPLOAD_ROOT in
    routers/qa_requests.py."""
    __tablename__ = "qap_request_documents"
    id = pk_column()
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"))
    file_name = Column(String(255), nullable=False)
    stored_path = Column(String(500), nullable=False)   # relative to UPLOAD_ROOT
    content_type = Column(String(150))
    file_size = Column(Integer)
    uploaded_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    uploaded_at = Column(DateTime, default=now)

    qa_request = relationship("QARequest", back_populates="documents")


class ReadinessChecklistItem(Base):
    """'Ready for Testing' gate — configurable checklist (Module 1)."""
    __tablename__ = "qap_readiness_checklist_items"
    id = pk_column()
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"))
    item = Column(String(255), nullable=False)
    owner = Column(String(150))
    is_mandatory = Column(Boolean, default=True)
    # Requester's own self-declaration, ticked when raising (or editing, pre-
    # submission) the QA Request -- purely informational for the QA Lead, who
    # must still independently verify every item via is_complete below (see
    # readiness_decision in routers/qa_requests.py -- nothing is auto-approved
    # just because the requester ticked it).
    requester_checked = Column(Boolean, default=False)
    # QA Lead's independent verification -- this is the flag the readiness
    # gate actually checks.
    is_complete = Column(Boolean, default=False)
    approved_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    approved_at = Column(DateTime, nullable=True)

    qa_request = relationship("QARequest", back_populates="checklist_items")


class WalkthroughSession(Base):
    __tablename__ = "qap_walkthrough_sessions"
    id = pk_column()
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"))
    session_date = Column(DateTime, default=now)
    conducted_by = Column(String(150))
    participants = Column(Text)
    recording_path = Column(String(255))
    document_path = Column(String(255))
    qa_acknowledged_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    qa_acknowledged_at = Column(DateTime, nullable=True)
    notes = Column(Text)

    qa_request = relationship("QARequest", back_populates="walkthroughs")


# ---------------------------------------------------------------------------
# Module 2: Test Case Repository
# ---------------------------------------------------------------------------
class TestCase(Base):
    __tablename__ = "qap_test_cases"
    id = pk_column()
    test_case_id = Column(String(40), unique=True, default=lambda: gen_id("TC"))
    epic_id = Column(String(64))
    feature_id = Column(String(64))
    user_story_id = Column(String(64))
    test_type = Column(String(32))
    module_name = Column(String(150))
    project_name = Column(String(150))
    test_scenario = Column(String(255))
    precondition = Column(Text)
    description = Column(Text)
    steps = Column(Text)
    expected_result = Column(Text)
    priority = Column(String(16))
    actual_result = Column(Text)
    status = Column(String(32), default="Draft")
    review_status = Column(String(32), default="Draft")
    test_run_artifacts_path = Column(String(255))
    defect_id = Column(String(64))
    version = Column(Integer, default=1)
    is_archived = Column(Boolean, default=False)

    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)
    created_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    qa_request = relationship("QARequest", back_populates="test_cases")


class TestCaseVersion(Base):
    """Archived snapshot every time a test case is edited (version control)."""
    __tablename__ = "qap_test_case_versions"
    id = pk_column()
    test_case_id = Column(Integer, ForeignKey("qap_test_cases.id"))
    version = Column(Integer)
    snapshot_json = Column(Text)
    archived_at = Column(DateTime, default=now)


# ---------------------------------------------------------------------------
# Module 3: Test Execution Management
# ---------------------------------------------------------------------------
class TestRun(Base):
    __tablename__ = "qap_test_runs"
    id = pk_column()
    test_run_id = Column(String(40), unique=True, default=lambda: gen_id("TR"))
    project = Column(String(150))
    application = Column(String(150))
    release = Column(String(64))
    run_type = Column(String(32))
    qa_owner_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    start_date = Column(Date)
    end_date = Column(Date)
    status = Column(String(32), default="Not Started")
    created_at = Column(DateTime, default=now)

    cases = relationship("TestRunCase", back_populates="test_run", cascade="all,delete-orphan")


class TestRunCase(Base):
    __tablename__ = "qap_test_run_cases"
    id = pk_column()
    test_run_id = Column(Integer, ForeignKey("qap_test_runs.id"))
    test_case_id = Column(Integer, ForeignKey("qap_test_cases.id"))
    execution_status = Column(String(32), default="Not Started")
    actual_result = Column(Text)
    defect_id = Column(String(64))
    executed_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    executed_at = Column(DateTime, nullable=True)

    test_run = relationship("TestRun", back_populates="cases")
    test_case = relationship("TestCase")


# ---------------------------------------------------------------------------
# Module 4: SAST Request Management
# ---------------------------------------------------------------------------
class SASTRequest(Base):
    __tablename__ = "qap_sast_requests"
    id = pk_column()
    request_id = Column(String(40), unique=True, default=lambda: gen_id("SAST"))
    application_name = Column(String(150), nullable=False)
    project_name = Column(String(150))
    cr_number = Column(String(64))
    build_number = Column(String(64))
    repository_url = Column(String(255))
    git_branch = Column(String(150))
    commit_id = Column(String(150))
    technology_stack = Column(String(150))
    risk_category = Column(String(16))
    source_code_path = Column(String(255))
    hash_value = Column(String(255))

    status = Column(String(32), default="Requested")
    requester_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    report_path = Column(String(255))
    # Set when this SAST request was auto-created because a QA Request's
    # request_types included "SAST" (see routers/qa_requests.py
    # ::_sync_linked_security_requests); null for standalone SAST requests
    # raised directly through this module -- those still get their own
    # unique request_id via the default above, just with no QA Request link.
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    findings = relationship("SASTFinding", back_populates="sast_request", cascade="all,delete-orphan")
    qa_request = relationship("QARequest", back_populates="linked_sast_requests")

    # Convenience read-only lookups so the Suppression "Request ID" autosuggest
    # can auto-populate Department/Owner without a separate round trip -- these
    # only resolve when this SAST request was auto-linked from a QA Request;
    # standalone SAST requests (raised directly, no qa_request) yield None.
    @property
    def department(self):
        return self.qa_request.department if self.qa_request else None

    @property
    def application_owner(self):
        return self.qa_request.application_owner if self.qa_request else None


class SASTFinding(Base):
    __tablename__ = "qap_sast_findings"
    id = pk_column()
    sast_request_id = Column(Integer, ForeignKey("qap_sast_requests.id"))
    issue_id = Column(String(64))
    severity = Column(String(16))
    description = Column(Text)
    status = Column(String(32), default="Open")

    sast_request = relationship("SASTRequest", back_populates="findings")


# ---------------------------------------------------------------------------
# Module 5: DAST Request Management
# ---------------------------------------------------------------------------
class DASTRequest(Base):
    __tablename__ = "qap_dast_requests"
    id = pk_column()
    request_id = Column(String(40), unique=True, default=lambda: gen_id("DAST"))
    application_url = Column(String(255), nullable=False)
    environment = Column(String(32))
    authentication_required = Column(Boolean, default=False)
    test_credentials = Column(String(255))
    target_release = Column(String(64))
    risk_category = Column(String(16))
    supporting_docs_path = Column(String(255))

    status = Column(String(32), default="Requested")
    requester_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    report_path = Column(String(255))
    # Set when this DAST request was auto-created because a QA Request's
    # request_types included "DAST"; null for standalone DAST requests
    # raised directly through this module.
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    findings = relationship("DASTFinding", back_populates="dast_request", cascade="all,delete-orphan")
    qa_request = relationship("QARequest", back_populates="linked_dast_requests")

    # See SASTRequest.department/application_owner above -- same idea, for DAST.
    @property
    def department(self):
        return self.qa_request.department if self.qa_request else None

    @property
    def application_owner(self):
        return self.qa_request.application_owner if self.qa_request else None


class DASTFinding(Base):
    __tablename__ = "qap_dast_findings"
    id = pk_column()
    dast_request_id = Column(Integer, ForeignKey("qap_dast_requests.id"))
    issue_id = Column(String(64))
    severity = Column(String(16))
    description = Column(Text)
    status = Column(String(32), default="Open")

    dast_request = relationship("DASTRequest", back_populates="findings")


# ---------------------------------------------------------------------------
# Module 6: False Positive / Suppression Management
# ---------------------------------------------------------------------------
class SuppressionRequest(Base):
    __tablename__ = "qap_suppression_requests"
    id = pk_column()
    suppression_id = Column(String(40), unique=True, default=lambda: gen_id("SUP"))
    application_name = Column(String(150), nullable=False)
    scan_type = Column(String(16))     # SAST / DAST
    # Auto-populated (at creation time, from whichever SAST/DAST request the
    # "Request ID" autosuggest field resolved to) rather than retyped --
    # blank when that scan has no linked QA Request (standalone scan).
    department = Column(String(150))
    application_owner = Column(String(150))
    # Exactly one of these is set, matching scan_type -- lets the suppression
    # stay traceable back to the specific scan it was raised against.
    sast_request_id = Column(Integer, ForeignKey("qap_sast_requests.id"), nullable=True)
    dast_request_id = Column(Integer, ForeignKey("qap_dast_requests.id"), nullable=True)
    risk_assessment = Column(Text)

    status = Column(String(40), default="Draft")
    created_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    # Legacy -- Application Owner approval was removed from the flow (SM was
    # inserted in its place, see sm_decision below); columns kept unused
    # rather than dropped, to avoid an Oracle DROP COLUMN migration for old
    # data. Nothing in the current flow reads or writes these anymore.
    app_owner_decision = Column(String(16))
    app_owner_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    app_owner_decided_at = Column(DateTime, nullable=True)
    sm_decision = Column(String(16))
    sm_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    sm_decided_at = Column(DateTime, nullable=True)
    dept_head_decision = Column(String(16))
    dept_head_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    dept_head_decided_at = Column(DateTime, nullable=True)
    security_decision = Column(String(16))
    security_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    security_decided_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    # One scan commonly turns up several findings -- this lets one suppression
    # request cover all of them instead of forcing a separate request per
    # finding (each finding still gets its own issue id/severity/description/
    # justification, just grouped under a single approval workflow).
    items = relationship("SuppressionItem", back_populates="suppression_request", cascade="all,delete-orphan")
    sast_request = relationship("SASTRequest")
    dast_request = relationship("DASTRequest")


class SuppressionItem(Base):
    """A single vulnerability/finding covered by a SuppressionRequest -- see
    SuppressionRequest.items above."""
    __tablename__ = "qap_suppression_items"
    id = pk_column()
    suppression_request_id = Column(Integer, ForeignKey("qap_suppression_requests.id"))
    issue_id = Column(String(64))
    severity = Column(String(16))
    description = Column(Text)
    justification = Column(Text)

    suppression_request = relationship("SuppressionRequest", back_populates="items")


# ---------------------------------------------------------------------------
# Module 7: Generic Approval Workflow Engine
# ---------------------------------------------------------------------------
class ApprovalAction(Base):
    """
    Generic append-only approval/audit log usable by any entity
    (QA_REQUEST, TEST_CASE, SAST_DAST, SUPPRESSION, SIGNOFF ...).
    """
    __tablename__ = "qap_approval_actions"
    id = pk_column()
    entity_type = Column(String(32), index=True)
    entity_id = Column(Integer, index=True)
    step_name = Column(String(64))
    actor_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    # Widened from 32 -> 150: with multi-role users this stores a CSV
    # snapshot of every role the actor held at the time (see User.roles_csv),
    # not just a single role code.
    actor_role = Column(String(150))
    # Widened from 16 -> 64: many workflow decision labels run longer than a
    # simple Approved/Rejected/Returned (e.g. "Regression Testing Started",
    # "Test Design Started") -- 16 was only ever big enough for the shortest
    # ones and silently worked until a longer one came through.
    decision = Column(String(64))
    comments = Column(Text)
    created_at = Column(DateTime, default=now)


# ---------------------------------------------------------------------------
# Module 8: QA Sign-off Management
# ---------------------------------------------------------------------------
class QASignOff(Base):
    __tablename__ = "qap_signoffs"
    id = pk_column()
    certificate_id = Column(String(40), unique=True, default=lambda: gen_id("QA-CERT"))
    certificate_date = Column(Date, default=lambda: datetime.date.today())
    certificate_type = Column(String(32))
    testing_type = Column(String(16))
    testing_request_id = Column(String(40))
    change_request_ids = Column(String(255))
    application_name = Column(String(150), nullable=False)
    application_owner = Column(String(150))
    department = Column(String(150))
    vendor_si_partner = Column(String(150))
    technology_stack = Column(String(150))
    risk_tier = Column(String(32))
    release_version = Column(String(64))
    build_number = Column(String(64))
    environment_tested = Column(String(32))
    target_promotion_environment = Column(String(32))
    validity_from = Column(Date)
    validity_to = Column(Date)

    exit_criteria_notes = Column(Text)
    open_defect_summary = Column(Text)
    residual_risk_notes = Column(Text)

    status = Column(String(32), default="Draft")   # Draft / Issued
    issued_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)   # TQA Lead - CM QA
    signed_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)   # CM-QA

    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)
