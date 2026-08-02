import datetime
import json
from typing import List
from zoneinfo import ZoneInfo

from sqlalchemy import (
    Column, Integer, String, Text, Boolean, DateTime, ForeignKey, Date, Identity, UniqueConstraint, text
)
from sqlalchemy.orm import relationship
from .database import Base
from .constants import QAStatus, LoginType, GatewayStatus

# Unlike SQLite/PostgreSQL/MySQL, SQLAlchemy does NOT automatically make a
# bare `Column(Integer, primary_key=True)` self-generating on Oracle -- Oracle
# has no native AUTO_INCREMENT, so you must opt in explicitly with Identity()
# (Oracle 12c+ identity columns). Every primary key below uses this helper so
# inserts get a generated id instead of failing with ORA-01400.
def pk_column():
    return Column(Integer, Identity(start=1, increment=1), primary_key=True)


def now():
    return datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata"))


# Reported directly: IDs must read "{PREFIX}-{YYYYMMDD}-{n}", e.g.
# "TQA-FUNC-20260801-1", with n a small sequential counter that starts back
# at 1 each day for that prefix (so it stays a short, rememberable number
# instead of growing forever). Oracle's native SEQUENCE object has no daily
# reset, so a small counter table (IdCounter, one row per prefix+date) plus a
# single atomic MERGE statement (_claim_daily_seq below) does the counting
# instead -- the MERGE takes a row lock on that prefix+date's counter row, so
# two concurrent requests for the same prefix on the same day serialize
# correctly and never hand out the same number twice. Every app-generated
# business ID (the human-facing string field -- request_id/suppression_id/
# certificate_id/project_key/cycle_key/test_case_key -- as opposed to the
# internal numeric `id` PK) uses this scheme. Existing legacy-format IDs
# already in the database are left as-is (no backfill/rename) -- old formats
# (a random-hex suffix, or a bare "{PREFIX}-{n}" from an earlier revision of
# this scheme) remain distinguishable from the current format by hyphen
# count/shape, so old and new formats coexist indefinitely.
class IdCounter(Base):
    __tablename__ = "qap_id_counters"
    prefix = Column(String(20), primary_key=True)
    counter_date = Column(Date, primary_key=True)
    next_value = Column(Integer, nullable=False)


def _ist_today() -> datetime.date:
    return now().date()


def _claim_daily_seq(prefix, executable, ist_date) -> int:
    """`executable` is anything exposing .execute(text(...)) -- a raw
    Connection (from a Column default's ExecutionContext, see
    gen_id_default below) or an ORM Session (when called directly from
    router code, e.g. routers/test_repository.py's manual gen_id("TC", db)
    calls). The MERGE is a single atomic statement: Oracle locks the target
    row (inserting it first if this is the first ID of the day for this
    prefix) so a concurrent MERGE against the same prefix+date blocks until
    this transaction commits, then sees the updated value -- no separate
    read-then-write race window."""
    executable.execute(
        text(
            "MERGE INTO qap_id_counters t "
            "USING (SELECT :prefix AS prefix, :cdate AS counter_date FROM dual) s "
            "ON (t.prefix = s.prefix AND t.counter_date = s.counter_date) "
            "WHEN MATCHED THEN UPDATE SET next_value = next_value + 1 "
            "WHEN NOT MATCHED THEN INSERT (prefix, counter_date, next_value) "
            "VALUES (s.prefix, s.counter_date, 1)"
        ),
        {"prefix": prefix, "cdate": ist_date},
    )
    return executable.execute(
        text("SELECT next_value FROM qap_id_counters WHERE prefix = :prefix AND counter_date = :cdate"),
        {"prefix": prefix, "cdate": ist_date},
    ).scalar()


def gen_id(prefix, db):
    """Call directly with the active Session when a business ID is needed
    outside of a Column default (e.g. routers/test_repository.py, where a
    Test Case's key is only generated if the user left it blank). For
    Column-level defaults, use gen_id_default below instead -- a plain 0-arg
    callable has no access to the live connection Oracle needs for the
    MERGE, only the ExecutionContext SQLAlchemy hands a 1-arg default at
    flush time."""
    ist_date = _ist_today()
    n = _claim_daily_seq(prefix, db, ist_date)
    return f"{prefix}-{ist_date:%Y%m%d}-{n}"


def gen_id_default(prefix):
    """Returns a context-sensitive SQLAlchemy Column default -- pass to
    Column(..., default=gen_id_default("TQA-REQ")). SQLAlchemy detects the
    1-argument signature and supplies the ExecutionContext automatically at
    flush/insert time, whose .connection is used to run the MERGE."""
    def _default(context):
        ist_date = _ist_today()
        n = _claim_daily_seq(prefix, context.connection, ist_date)
        return f"{prefix}-{ist_date:%Y%m%d}-{n}"
    return _default


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
    # Set True at the same moment as needs_role_review above -- on first-ever
    # LDAP login (JIT provisioning, see routers/auth.py::login) -- since the
    # directory's own "department" attribute is free text and often blank or
    # not an exact match for one of our canonical qap_departments.name values
    # (case/wording differences), the person is prompted once, right after
    # that first login, to explicitly confirm/pick their department from the
    # real list themselves (see PATCH /api/auth/me). Cleared the moment they
    # do. Unlike needs_role_review, this is never cleared by an admin action
    # -- only the user's own self-service pick resolves it.
    needs_department_selection = Column(Boolean, default=False)
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


class ApplicationMaster(Base):
    """Master list of standardised Application Names, built up over time as
    requesters introduce new ones via the QA Request wizard's Application
    Name dropdown (see routers/qa_requests.py::_resolve_application_name).
    The dropdown itself only ever offers names with status == APPROVED (see
    routers/applications.py::list_application_names); picking "Other" and
    typing a name not already on this list creates a new row here (name
    always upper-cased at the point of entry, see the same resolver, to
    minimise case-sensitivity duplicates).

    Two-tier approval (2026-08): a brand-new name starts at
    PENDING_APP_OWNER -- an Application Owner from the same department must
    approve it first (see routers/applications.py::decide_app_owner) --
    before it moves to PENDING_SM for the existing SM approval step (see
    decide_application_name). Only once SM approves does it become APPROVED
    and: (a) show up as a pickable option for everyone else going forward,
    and (b) stop showing as "pending" on this particular request. Either
    tier can Reject, which is terminal. Approving/rejecting the name is
    independent of approving the request itself in the sense that raising/
    saving a request is never blocked on it (_resolve_application_name never
    blocks the caller) -- but the request's own SM/Department Head Approval
    decisions ARE blocked from reaching "Approved" while this is anything
    other than APPROVED (see application_name_block_message in constants.py
    and its 6 call sites across functional.py/sast_dast.py/performance.py)."""
    __tablename__ = "qap_application_master"
    id = pk_column()
    name = Column(String(150), unique=True, nullable=False)
    # PENDING_APP_OWNER / PENDING_SM / APPROVED / REJECTED -- see the class
    # docstring above and constants.APPLICATION_MASTER_STATUSES.
    status = Column(String(20), default="PENDING_APP_OWNER", index=True)
    # The department context the name was proposed under -- who gets to
    # decide at EITHER tier (see require_same_department in
    # routers/applications.py), same scoping rule as every other SM/
    # Department Head approval checkpoint in the app -- an Application Owner
    # from this same department decides first, then an SM from it.
    department = Column(String(150))
    requested_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    # The QA Request that first introduced this name -- purely for
    # traceability/display (e.g. "requested via TQA-REQ-..."), nullable since
    # a REJECTED name that gets proposed again later re-links to whichever
    # QA Request triggered that.
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)
    # Application Owner's own tier -- populated only when an Application
    # Owner decides (Approved moves the row on to PENDING_SM without
    # touching decided_by_id/decided_at/comments below; Rejected is terminal
    # and populates BOTH this tier's fields and the SM-tier fields below, so
    # anything reading decided_by_id/decided_at/comments as "the decision
    # that made this terminal" keeps working regardless of which tier made
    # the call).
    app_owner_decided_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    app_owner_decided_at = Column(DateTime, nullable=True)
    app_owner_comments = Column(Text, nullable=True)
    # SM's own tier -- populated when SM makes the final Approved/Rejected
    # call, or when an Application Owner rejects (see above).
    decided_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    decided_at = Column(DateTime, nullable=True)
    comments = Column(Text, nullable=True)
    created_at = Column(DateTime, default=now)

    requested_by = relationship("User", foreign_keys=[requested_by_id])
    app_owner_decided_by = relationship("User", foreign_keys=[app_owner_decided_by_id])
    decided_by = relationship("User", foreign_keys=[decided_by_id])
    qa_request = relationship("QARequest", foreign_keys=[qa_request_id])


# ---------------------------------------------------------------------------
# Module 1: QA Request Management -- pure intake/gateway record
# ---------------------------------------------------------------------------
class QARequest(Base):
    """The QA Request is a lightweight intake/gateway record only -- it has no
    approval workflow of its own (see constants.GatewayStatus: Draft ->
    Submitted -> Raised, or Cancelled while still Draft). Raising it
    immediately spins off whichever independent child request(s) apply, each
    with its own unique ID and its own full workflow (see
    routers/qa_requests.py::_sync_linked_child_requests):
      - Functional/Sanity/Regression Testing or UAT Support -> one combined
        FunctionalRequest (see FunctionalRequest below).
      - SAST / DAST -> SASTRequest / DASTRequest.
      - Performance Testing -> PerformanceRequest.
    """
    __tablename__ = "qap_requests"
    id = pk_column()
    request_id = Column(String(40), unique=True, default=gen_id_default("TQA-REQ"))
    request_date = Column(Date, default=lambda: datetime.date.today())
    department = Column(String(150))
    application_name = Column(String(150), nullable=False)
    application_owner = Column(String(150))
    cr_number = Column(String(64))
    epic_number = Column(String(150))
    change_type = Column(String(32))              # New / Enhancement / Bug Fix -- see constants.CHANGE_TYPES
    vendor_si_partner = Column(String(150))
    technology_stack = Column(String(150))
    release_version = Column(String(64))
    build_number = Column(String(64))
    environment = Column(String(32))              # "Deployment Environment" -- SIT/UAT/Pre-Production/Production
    target_promotion_environment = Column(String(32))
    request_types = Column(String(255))          # comma-separated from REQUEST_TYPES
    request_type_other = Column(String(150))
    # Priority/Risk used to be a single shared "Classification" pair here,
    # collected once regardless of which request type(s) were selected. Moved
    # to be per-request-type instead (e.g. FunctionalRequest.priority,
    # SASTRequest.priority, PerformanceRequest.risk_category, ...) since the
    # same change can reasonably need SAST done at low priority
    # while Performance Testing on the same change is high priority -- no
    # longer meaningful as a single gateway-level value. The underlying Oracle
    # columns (qap_requests.priority/risk_rating) are left in place (harmless,
    # simply unmapped/unused going forward) rather than dropped -- see the
    # Oracle migration notes for this round.
    target_release_date = Column(Date)
    supporting_doc_path = Column(String(255))
    remarks = Column(Text)

    # Staging area, JSON-encoded, for the SAST/DAST/Performance detail fields
    # (and the requester's readiness-checklist self-declaration ticks)
    # collected on the wizard's own steps while this gateway is still a Draft.
    # Linked child requests (Functional/SAST/DAST/Performance) are
    # NOT created at Draft save time -- only "Submit / Raise" (see
    # routers/qa_requests.py::submit_request) actually creates them, reading
    # this column to seed their details before clearing it. This is what
    # keeps "Linked Requests" empty (and correctly so) on a still-Draft
    # request -- nothing should get its own trackable ID until the requester
    # has actually raised it.
    draft_child_details = Column(Text, nullable=True)

    status = Column(String(32), default=GatewayStatus.DRAFT, index=True)
    requester_id = Column(Integer, ForeignKey("qap_users.id"))

    # Set by routers/qa_requests.py::_resolve_application_name every time
    # this gateway is created/edited, whether application_name resolved to
    # an already-APPROVED master entry or a brand-new/still-PENDING one --
    # lets the UI show the live approval status (application_master_status
    # below) and, for an SM, which ApplicationMaster row to act on.
    application_master_id = Column(Integer, ForeignKey("qap_application_master.id"), nullable=True)

    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    requester = relationship("User", back_populates="qa_requests", foreign_keys=[requester_id])
    application_master = relationship("ApplicationMaster", foreign_keys=[application_master_id])
    documents = relationship("QARequestDocument", back_populates="qa_request", cascade="all,delete-orphan")
    # Auto-created when this request's request_types include the matching
    # type (see routers/qa_requests.py::_sync_linked_child_requests) so each
    # gets its own trackable unique ID while staying linked back to the
    # originating gateway QA Request.
    linked_functional_requests = relationship("FunctionalRequest", back_populates="qa_request")
    linked_sast_requests = relationship("SASTRequest", back_populates="qa_request")
    linked_dast_requests = relationship("DASTRequest", back_populates="qa_request")
    linked_performance_requests = relationship("PerformanceRequest", back_populates="qa_request")

    def _draft_details(self) -> dict:
        """Parses draft_child_details (see the column comment above) --
        returns an empty shell once it's None, e.g. after Submit/Raise
        consumes and clears it (see routers/qa_requests.py::submit_request)."""
        if not self.draft_child_details:
            return {
                "checked_items": [], "sast_components": [], "dast_components": [],
                "performance": {}, "performance_checked_items": [],
                "classification": {}, "sast_checked_items": [], "dast_checked_items": [],
            }
        return json.loads(self.draft_child_details)

    # Exposed read-only via QARequestOut so the "Edit Request" wizard can
    # pre-fill the SAST/DAST/Performance/checklist steps it collected on an
    # earlier Draft save, instead of showing them blank again (they aren't
    # columns on this gateway record -- they only exist in this staging
    # column until Submit/Raise turns them into a real child request).
    @property
    def draft_checked_items(self):
        return self._draft_details().get("checked_items") or []

    @property
    def draft_sast_components(self):
        return self._draft_details().get("sast_components") or []

    @property
    def draft_dast_components(self):
        return self._draft_details().get("dast_components") or []

    @property
    def draft_performance(self):
        return self._draft_details().get("performance") or {}

    @property
    def draft_performance_checked_items(self):
        return self._draft_details().get("performance_checked_items") or []

    @property
    def draft_classification(self):
        return self._draft_details().get("classification") or {}

    @property
    def draft_sast_checked_items(self):
        return self._draft_details().get("sast_checked_items") or []

    @property
    def draft_dast_checked_items(self):
        return self._draft_details().get("dast_checked_items") or []

    # Live approval status of this request's own Application Name (see
    # ApplicationMaster's class docstring) -- None if application_master_id
    # was never set (shouldn't happen post-rollout, but older rows created
    # before this feature existed will have it blank).
    @property
    def application_master_status(self):
        return self.application_master.status if self.application_master else None


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


# ---------------------------------------------------------------------------
# Module 1b: Functional Testing Request (Functional/Sanity/Regression/UAT Support)
# ---------------------------------------------------------------------------
class FunctionalRequest(Base):
    """Auto-created from a QA Request when any of Functional Testing/Sanity
    Testing/Regression Testing/UAT Support is one of its request types (see
    routers/qa_requests.py::_sync_linked_child_requests) -- same auto-link
    pattern as SASTRequest/DASTRequest/PerformanceRequest,
    just for the "common" bucket. Carries the full QAStatus lifecycle that
    used to live directly on QARequest (see constants.QAStatus). Most
    descriptive fields (application name, project, department, etc.) are NOT
    duplicated here -- they're delegated (read-only) from the linked
    qa_request below, since a Functional Testing Request always describes the
    exact same application/change as its parent gateway. Priority/risk_rating
    are the exception -- real, independently-editable columns (see below),
    since those can legitimately differ per request type even on the same
    underlying change."""
    __tablename__ = "qap_functional_requests"
    id = pk_column()
    request_id = Column(String(40), unique=True, default=gen_id_default("TQA-FUNC"))
    status = Column(String(32), default=QAStatus.DRAFT, index=True)
    # Set (independently of `status`) when the QA Lead fails Readiness
    # Verification with "require re-approval" ticked. `status` is always set
    # to RETURNED_BY_QA_LEAD in that case -- who actually returned it -- never
    # RETURNED_BY_DEPARTMENT_HEAD (that status value is reserved for a genuine
    # direct return during Department Head Approval); this flag is what
    # `resubmit` checks to decide whether to route back through Department
    # Head Approval or straight back to Readiness Verification, and what the
    # frontend uses to show a "Department Head re-approval required after
    # changes" note alongside the accurate status.
    needs_dept_head_reapproval = Column(Boolean, default=False)
    # Real, independently-editable columns -- NOT delegated from the parent
    # QA Request (unlike application_name/epic_number/department/
    # application_owner below, which really are always identical to the
    # gateway's). Priority/Risk moved to be per-request-type: this bucket
    # (Functional/Sanity/Regression/UAT Support) can reasonably need a
    # different priority than, say, a linked SAST request on
    # the same QA Request. Collected on the wizard's own "Functional Testing
    # Classification" step and editable afterwards via
    # PUT /api/functional-requests/{id}.
    priority = Column(String(16))
    risk_rating = Column(String(16))
    requester_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    department_head_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)  # who performed Department Head Approval
    qa_lead_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)       # IT-QA QA Lead assigned by Department Head
    assigned_tester_ids = Column(String(255))     # comma-separated QA Engineer user ids (Tester Assigned step)
    signoff_id = Column(Integer, ForeignKey("qap_signoffs.id"), nullable=True)    # linked QA Sign-off certificate
    # Set when auto-created from a QA Request gateway (always, for new rows --
    # standalone creation is disabled, see routers/functional.py); nullable
    # only for symmetry with the other linked-request models.
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)

    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    requester = relationship("User", foreign_keys=[requester_id])
    qa_request = relationship("QARequest", back_populates="linked_functional_requests")
    checklist_items = relationship("ReadinessChecklistItem", back_populates="functional_request", cascade="all,delete-orphan")
    walkthroughs = relationship("WalkthroughSession", back_populates="functional_request", cascade="all,delete-orphan")

    # Delegated (read-only) lookups from the parent gateway QA Request --
    # see the class docstring above for why these aren't duplicated columns.
    @property
    def application_name(self):
        return self.qa_request.application_name if self.qa_request else None

    @property
    def epic_number(self):
        return self.qa_request.epic_number if self.qa_request else None

    @property
    def department(self):
        return self.qa_request.department if self.qa_request else None

    @property
    def application_owner(self):
        return self.qa_request.application_owner if self.qa_request else None

    @property
    def request_types(self):
        return self.qa_request.request_types if self.qa_request else None

    @property
    def target_release_date(self):
        return self.qa_request.target_release_date if self.qa_request else None

    # Rest of "Application & Change Details"/"Release & Environment" --
    # delegated (read-only) the same way as application_name/epic_number/
    # department/application_owner above. Previously omitted entirely (this
    # request type showed fewer Overview fields than SAST/DAST/
    # Performance); added so the Functional Testing Overview can show the
    # full picture, and made writable (by writing through to qa_request, see
    # routers/functional.py::update_functional) since once the QA Request
    # gateway itself is RAISED it can no longer be edited there directly
    # (see constants.GATEWAY_EDITABLE_STATUSES) -- this is the only place
    # left to fix a typo in these fields after that point.
    @property
    def cr_number(self):
        return self.qa_request.cr_number if self.qa_request else None

    @property
    def change_type(self):
        return self.qa_request.change_type if self.qa_request else None

    @property
    def environment(self):
        return self.qa_request.environment if self.qa_request else None

    @property
    def target_promotion_environment(self):
        return self.qa_request.target_promotion_environment if self.qa_request else None

    @property
    def release_version(self):
        return self.qa_request.release_version if self.qa_request else None

    @property
    def build_number(self):
        return self.qa_request.build_number if self.qa_request else None

    # Added specifically so the QA Sign-off Certificate modal (raised from
    # this request once QA Completed -- see routers/functional.py::
    # request_signoff and frontend SignOff.tsx) can auto-populate "Technology
    # Stack" the same way it auto-populates every other delegated field above.
    @property
    def technology_stack(self):
        return self.qa_request.technology_stack if self.qa_request else None

    # See QARequest.application_master_status -- delegated the same way as
    # every other field above, so the SM reviewing this request's own SM
    # Approval step can see (and act on) a pending new Application Name
    # right from this request's own detail view.
    @property
    def application_master_status(self):
        return self.qa_request.application_master_status if self.qa_request else None

    @property
    def application_master_id(self):
        return self.qa_request.application_master_id if self.qa_request else None

    # Always None here -- Functional Testing uses risk_rating (above), not
    # risk_category. Exists purely so schemas.LinkedRequestRef (the generic
    # cross-reference shape shared by all 5 linked-request types) can safely
    # read `.risk_category` off any of them without an AttributeError.
    @property
    def risk_category(self):
        return None


class ReadinessChecklistItem(Base):
    """'Ready for Testing' gate — configurable checklist (Module 1b, lives on
    the Functional Testing Request since that's where the QA activity/
    readiness verification actually happens)."""
    __tablename__ = "qap_readiness_checklist_items"
    id = pk_column()
    functional_request_id = Column(Integer, ForeignKey("qap_functional_requests.id"))
    item = Column(String(255), nullable=False)
    owner = Column(String(150))
    is_mandatory = Column(Boolean, default=True)
    # Requester's own self-declaration, ticked when raising (or editing, pre-
    # submission) the QA Request -- purely informational for the QA Lead, who
    # must still independently verify every item via is_complete below (see
    # readiness_decision in routers/functional.py -- nothing is auto-approved
    # just because the requester ticked it).
    requester_checked = Column(Boolean, default=False)
    # QA Lead's independent verification -- this is the flag the readiness
    # gate actually checks.
    is_complete = Column(Boolean, default=False)
    approved_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    approved_at = Column(DateTime, nullable=True)

    functional_request = relationship("FunctionalRequest", back_populates="checklist_items")


class WalkthroughSession(Base):
    __tablename__ = "qap_walkthrough_sessions"
    id = pk_column()
    functional_request_id = Column(Integer, ForeignKey("qap_functional_requests.id"))
    session_date = Column(DateTime, default=now)
    conducted_by = Column(String(150))
    participants = Column(Text)
    recording_path = Column(String(255))
    document_path = Column(String(255))
    qa_acknowledged_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    qa_acknowledged_at = Column(DateTime, nullable=True)
    notes = Column(Text)

    functional_request = relationship("FunctionalRequest", back_populates="walkthroughs")


# ---------------------------------------------------------------------------
# Module 4: SAST Request Management
# ---------------------------------------------------------------------------
class SASTRequest(Base):
    __tablename__ = "qap_sast_requests"
    id = pk_column()
    request_id = Column(String(40), unique=True, default=gen_id_default("TQA-SAST"))
    application_name = Column(String(150), nullable=False)
    epic_number = Column(String(150))
    cr_number = Column(String(64))
    risk_category = Column(String(16))
    # Priority is per-request-type now (see FunctionalRequest's comment on
    # priority/risk_rating for the full reasoning) -- collected on the QA
    # Request wizard's own SAST step and editable afterwards via this
    # request's own Edit Details modal, same as risk_category above already was.
    priority = Column(String(16))
    source_code_path = Column(String(255))
    hash_value = Column(String(255))

    status = Column(String(32), default="DRAFT")
    # See FunctionalRequest.needs_dept_head_reapproval for the full
    # explanation -- same reasoning, set when the Security Lead fails
    # Security Readiness with "require re-approval" ticked (status is always
    # RETURNED_BY_SECURITY_LEAD in that case, never RETURNED_BY_DEPARTMENT_HEAD).
    needs_dept_head_reapproval = Column(Boolean, default=False)
    requester_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    # IT-QA QA Lead assigned by the requester's Department Head for readiness,
    # followed by the IT-QA Security Analyst selected by that lead.
    security_lead_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    security_analyst_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    report_path = Column(String(255))
    # Set when this SAST request was auto-created because a QA Request's
    # request_types included "SAST" (see routers/qa_requests.py
    # ::_sync_linked_child_requests); null for standalone SAST requests
    # raised directly through this module -- those still get their own
    # unique request_id via the default above, just with no QA Request link.
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    findings = relationship("SASTFinding", back_populates="sast_request", cascade="all,delete-orphan")
    walkthroughs = relationship("SASTWalkthrough", back_populates="sast_request", cascade="all,delete-orphan")
    checklist_items = relationship("SASTChecklistItem", back_populates="sast_request", cascade="all,delete-orphan")
    qa_request = relationship("QARequest", back_populates="linked_sast_requests")
    # Every Suppression / False Positive request raised against this SAST
    # request (see SuppressionRequest.sast_request_id) -- lets the Overview
    # tab show "Suppression Requested? Yes/No" and, if so, which suppression
    # id(s), without a separate round trip.
    suppressions = relationship("SuppressionRequest", back_populates="sast_request")
    # One row per repository -- a project can span more than one, each with
    # its own branch/commit/tech stack/build number. Used to be packed as the
    # Nth comma-separated value across 5 parallel columns directly on this
    # row (repository_url, git_branch, commit_id, technology_stack,
    # build_number) -- fragile to parse/reconstruct and awkward to query.
    # Replaced with a proper child table; see SASTComponent below.
    components = relationship(
        "SASTComponent", back_populates="sast_request", cascade="all,delete-orphan",
        order_by="SASTComponent.id",
    )

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

    # Deployment/target promotion environment aren't columns on SASTRequest
    # itself -- collected once, on the QA Request gateway, same delegation
    # pattern as department/application_owner above.
    @property
    def environment(self):
        return self.qa_request.environment if self.qa_request else None

    @property
    def target_promotion_environment(self):
        return self.qa_request.target_promotion_environment if self.qa_request else None

    # Convenience passthrough for callers that just want "a" build number for
    # this request (e.g. the Reports export) without reaching into
    # .components themselves -- first repository's, since that's overwhelmingly
    # the common case of one repository per SAST request.
    @property
    def build_number(self):
        return self.components[0].build_number if self.components else None

    # Always None here -- SAST uses risk_category (above), not risk_rating.
    # Exists purely so schemas.LinkedRequestRef can safely read
    # `.risk_rating` off any of the 5 linked-request types without an
    # AttributeError -- see FunctionalRequest.risk_category for the mirror.
    @property
    def risk_rating(self):
        return None

    # See QARequest.application_master_status -- delegated the same way as
    # department/application_owner above, so the SM reviewing this request's
    # own SM Approval step can see (and act on) a pending new Application
    # Name right from this request's own detail view.
    @property
    def application_master_status(self):
        return self.qa_request.application_master_status if self.qa_request else None

    @property
    def application_master_id(self):
        return self.qa_request.application_master_id if self.qa_request else None


class SASTComponent(Base):
    """One repository entry for a SAST request -- its own branch/commit/tech
    stack/build number. A project can span more than one repository, each
    needing its own full set of these 5 fields (see RepeatableGroupInput on
    the SAST form, one row added per "+" click). Ordered by `id` (insertion
    order == the order the requester added them in)."""
    __tablename__ = "qap_sast_components"
    id = pk_column()
    sast_request_id = Column(Integer, ForeignKey("qap_sast_requests.id"), nullable=False)
    repository_url = Column(String(1000))
    git_branch = Column(String(500))
    commit_id = Column(String(500))
    technology_stack = Column(String(500))
    build_number = Column(String(300))

    sast_request = relationship("SASTRequest", back_populates="components")


class SASTFinding(Base):
    __tablename__ = "qap_sast_findings"
    id = pk_column()
    sast_request_id = Column(Integer, ForeignKey("qap_sast_requests.id"))
    issue_id = Column(String(64))
    severity = Column(String(16))
    description = Column(Text)
    status = Column(String(32), default="Open")

    sast_request = relationship("SASTRequest", back_populates="findings")


class SASTChecklistItem(Base):
    """'Security Readiness' pre-scan checklist -- distinct from
    ReadinessChecklistItem (Functional Testing's) and DASTChecklistItem
    (DAST's own, separate table -- same pattern as SASTFinding/DASTFinding
    being separate rather than one shared table). Seeded onto every
    auto-created SASTRequest (see constants.DEFAULT_SAST_CHECKLIST_ITEMS and
    routers/qa_requests.py::_sync_linked_child_requests). Unlike
    PerformanceChecklistItem, some of these items ARE
    mandatory -- and mandatory here is a hard gate at Submit time (not just
    Security Readiness): the requester can't Submit for SM Approval while a
    mandatory item's own requester_checked is still false (see
    routers/sast_dast.py::_require_checklist_ready, called from
    _submit/_resubmit). is_complete (independent Security/QA verification)
    is checked separately, during Security Readiness itself (see
    _readiness_decision)."""
    __tablename__ = "qap_sast_checklist_items"
    id = pk_column()
    sast_request_id = Column(Integer, ForeignKey("qap_sast_requests.id"))
    item = Column(String(255), nullable=False)
    owner = Column(String(150))
    is_mandatory = Column(Boolean, default=False)
    # Requester's own self-declaration -- purely informational, same pattern
    # as every other checklist's requester_checked; does NOT set is_complete.
    requester_checked = Column(Boolean, default=False)
    # Security Lead's (or QA Lead's) independent verification during Security
    # Readiness -- this is the flag the readiness gate actually checks.
    is_complete = Column(Boolean, default=False)
    approved_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    approved_at = Column(DateTime, nullable=True)

    sast_request = relationship("SASTRequest", back_populates="checklist_items")


class SASTWalkthrough(Base):
    """Same shape as WalkthroughSession (Functional Testing's walkthrough
    table) -- SAST previously had no walkthrough concept at all, unlike
    every other module."""
    __tablename__ = "qap_sast_walkthroughs"
    id = pk_column()
    sast_request_id = Column(Integer, ForeignKey("qap_sast_requests.id"))
    session_date = Column(DateTime, default=now)
    conducted_by = Column(String(150))
    participants = Column(Text)
    recording_path = Column(String(255))
    document_path = Column(String(255))
    qa_acknowledged_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    qa_acknowledged_at = Column(DateTime, nullable=True)
    notes = Column(Text)

    sast_request = relationship("SASTRequest", back_populates="walkthroughs")


# ---------------------------------------------------------------------------
# Module 5: DAST Request Management
# ---------------------------------------------------------------------------
class DASTRequest(Base):
    __tablename__ = "qap_dast_requests"
    id = pk_column()
    request_id = Column(String(40), unique=True, default=gen_id_default("TQA-DAST"))
    risk_category = Column(String(16))
    # See SASTRequest.priority for the full reasoning.
    priority = Column(String(16))
    supporting_docs_path = Column(String(255))

    status = Column(String(32), default="DRAFT")
    # See FunctionalRequest.needs_dept_head_reapproval for the full
    # explanation -- same reasoning, set when the Security Lead fails
    # Security Readiness with "require re-approval" ticked (status is always
    # RETURNED_BY_SECURITY_LEAD in that case, never RETURNED_BY_DEPARTMENT_HEAD).
    needs_dept_head_reapproval = Column(Boolean, default=False)
    requester_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    security_lead_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)  # assigned IT-QA QA Lead
    security_analyst_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)  # assigned IT-QA Security Analyst
    report_path = Column(String(255))
    # Set when this DAST request was auto-created because a QA Request's
    # request_types included "DAST"; null for standalone DAST requests
    # raised directly through this module.
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    findings = relationship("DASTFinding", back_populates="dast_request", cascade="all,delete-orphan")
    walkthroughs = relationship("DASTWalkthrough", back_populates="dast_request", cascade="all,delete-orphan")
    checklist_items = relationship("DASTChecklistItem", back_populates="dast_request", cascade="all,delete-orphan")
    qa_request = relationship("QARequest", back_populates="linked_dast_requests")
    # See SASTRequest.suppressions above -- same idea, for DAST.
    suppressions = relationship("SuppressionRequest", back_populates="dast_request")
    # One row per scan target -- a project can span more than one target URL,
    # each with its own environment/auth requirement/credentials. Used to be
    # packed as the Nth newline-separated value across 4 parallel columns
    # directly on this row (application_url, environment,
    # authentication_required, test_credentials) -- fragile to parse/
    # reconstruct and made per-row credential masking awkward. Replaced with
    # a proper child table; see DASTTarget below.
    targets = relationship(
        "DASTTarget", back_populates="dast_request", cascade="all,delete-orphan",
        order_by="DASTTarget.id",
    )

    # Convenience passthroughs so existing callers that used to read the flat
    # application_url/environment/authentication_required columns still have
    # a simple way to get "the first target's" value without reaching into
    # .targets themselves (e.g. list views showing one summary URL, the
    # Reports export).
    @property
    def application_url(self):
        return self.targets[0].application_url if self.targets else None

    @property
    def environment(self):
        return self.targets[0].environment if self.targets else None

    # See SASTRequest.department/application_owner above -- same idea, for DAST.
    @property
    def department(self):
        return self.qa_request.department if self.qa_request else None

    @property
    def application_owner(self):
        return self.qa_request.application_owner if self.qa_request else None

    # Target Release Date is already collected once, at QA Request creation
    # time -- no separate "target_release" column on DAST anymore (was a
    # free-text duplicate of the same thing); this delegates to the one
    # source of truth, same pattern as FunctionalRequest.target_release_date.
    @property
    def target_release_date(self):
        return self.qa_request.target_release_date if self.qa_request else None

    # DAST has no application_name/epic_number/cr_number columns of its own
    # (it tests a URL, not "an application" directly) -- delegated from the
    # gateway so the security team can see the full business context before
    # starting a scan, same reasoning as SASTRequest's equivalents.
    @property
    def application_name(self):
        return self.qa_request.application_name if self.qa_request else None

    @property
    def epic_number(self):
        return self.qa_request.epic_number if self.qa_request else None

    @property
    def cr_number(self):
        return self.qa_request.cr_number if self.qa_request else None

    # Named "deployment_environment" (not "environment") to avoid clashing
    # with the `environment` property above, which surfaces the first
    # target's own scan environment instead -- this is the gateway's own
    # Deployment Environment, shown as an additional reference.
    @property
    def deployment_environment(self):
        return self.qa_request.environment if self.qa_request else None

    @property
    def target_promotion_environment(self):
        return self.qa_request.target_promotion_environment if self.qa_request else None

    # See SASTRequest.risk_rating above for the full reasoning.
    @property
    def risk_rating(self):
        return None

    # See QARequest.application_master_status -- delegated the same way as
    # department/application_owner above, so the SM reviewing this request's
    # own SM Approval step can see (and act on) a pending new Application
    # Name right from this request's own detail view.
    @property
    def application_master_status(self):
        return self.qa_request.application_master_status if self.qa_request else None

    @property
    def application_master_id(self):
        return self.qa_request.application_master_id if self.qa_request else None


class DASTTarget(Base):
    """One scan target for a DAST request -- its own environment/
    authentication requirement/credentials. A project can span more than one
    target URL, each needing its own answers for these (see RepeatableRows on
    the DAST form, one row added per "+" click). Test Credentials is
    sensitive -- see _can_view_dast_credentials in routers/sast_dast.py,
    which now masks it per-row instead of on the whole newline-joined string
    at once. Ordered by `id` (insertion order == the order added in)."""
    __tablename__ = "qap_dast_targets"
    id = pk_column()
    dast_request_id = Column(Integer, ForeignKey("qap_dast_requests.id"), nullable=False)
    application_url = Column(String(2000), nullable=False)
    environment = Column(String(500))
    authentication_required = Column(String(16), default="No")   # "Yes"/"No"
    test_credentials = Column(String(2000))

    dast_request = relationship("DASTRequest", back_populates="targets")


class DASTChecklistItem(Base):
    """Same shape/purpose as SASTChecklistItem above, DAST's own separate
    table -- see that class's docstring for the full reasoning."""
    __tablename__ = "qap_dast_checklist_items"
    id = pk_column()
    dast_request_id = Column(Integer, ForeignKey("qap_dast_requests.id"))
    item = Column(String(255), nullable=False)
    owner = Column(String(150))
    is_mandatory = Column(Boolean, default=False)
    requester_checked = Column(Boolean, default=False)
    is_complete = Column(Boolean, default=False)
    approved_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    approved_at = Column(DateTime, nullable=True)

    dast_request = relationship("DASTRequest", back_populates="checklist_items")


class DASTFinding(Base):
    __tablename__ = "qap_dast_findings"
    id = pk_column()
    dast_request_id = Column(Integer, ForeignKey("qap_dast_requests.id"))
    issue_id = Column(String(64))
    severity = Column(String(16))
    description = Column(Text)
    status = Column(String(32), default="Open")

    dast_request = relationship("DASTRequest", back_populates="findings")


class DASTWalkthrough(Base):
    """Same shape as WalkthroughSession/SASTWalkthrough -- see SASTWalkthrough
    for why this exists (DAST previously had no walkthrough concept either)."""
    __tablename__ = "qap_dast_walkthroughs"
    id = pk_column()
    dast_request_id = Column(Integer, ForeignKey("qap_dast_requests.id"))
    session_date = Column(DateTime, default=now)
    conducted_by = Column(String(150))
    participants = Column(Text)
    recording_path = Column(String(255))
    document_path = Column(String(255))
    qa_acknowledged_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    qa_acknowledged_at = Column(DateTime, nullable=True)
    notes = Column(Text)

    dast_request = relationship("DASTRequest", back_populates="walkthroughs")


# ---------------------------------------------------------------------------
# Module 4c: Performance Testing Request Management
# ---------------------------------------------------------------------------
class PerformanceRequest(Base):
    """Auto-created from a QA Request when 'Performance Testing' is one of its
    request types -- same pattern as SASTRequest/DASTRequest.
    See constants.PERFORMANCE_STATUSES for the independent lifecycle.

    Fields below mirror Annexure VIII ("QA Request Form & Checklist --
    Performance Testing") -- see constants.PERFORMANCE_REQUEST_TYPES/
    CHANGE_TYPES and PerformanceChecklistItem for the accompanying 19-item
    pre-testing readiness checklist."""
    __tablename__ = "qap_performance_requests"
    id = pk_column()
    request_id = Column(String(40), unique=True, default=gen_id_default("TQA-PERF"))
    application_name = Column(String(150), nullable=False)
    epic_number = Column(String(150))
    cr_number = Column(String(64))
    tool_used = Column(String(150))            # e.g. JMeter, LoadRunner
    target_load = Column(String(150))          # e.g. "500 concurrent users / 200 TPS"
    environment = Column(String(32))
    risk_category = Column(String(16))
    # See SASTRequest.priority for the full reasoning.
    priority = Column(String(16))

    # Annexure VIII fields not already covered above.
    request_type = Column(String(120))          # comma-separated: Load/Stress/Spike Testing
    change_type = Column(String(32))            # New / Enhancement / Bug Fix
    vendor_si_partner = Column(String(150))
    technology_stack = Column(String(150))
    release_version = Column(String(64))
    build_number = Column(String(64))
    hash_value = Column(String(255))
    target_promotion_environment = Column(String(32))  # UAT / Pre-Production / Production

    status = Column(String(32), default="DRAFT")
    # See FunctionalRequest.needs_dept_head_reapproval for the full
    # explanation -- same reasoning, set when Readiness is Failed with
    # "require re-approval" ticked (status is always RETURNED_BY_ENGINEER in
    # that case, never RETURNED_BY_DEPARTMENT_HEAD).
    needs_dept_head_reapproval = Column(Boolean, default=False)
    requester_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    # Existing column now represents the IT-QA QA Lead assigned by the
    # requester's Department Head. Execution testers are tracked separately.
    engineer_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    assigned_tester_ids = Column(String(255))  # comma-separated IT-QA QA Engineer ids
    report_path = Column(String(255))
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    qa_request = relationship("QARequest", back_populates="linked_performance_requests")
    checklist_items = relationship("PerformanceChecklistItem", back_populates="performance_request",
                                    cascade="all,delete-orphan")
    walkthroughs = relationship("PerformanceWalkthrough", back_populates="performance_request",
                                 cascade="all,delete-orphan")

    @property
    def department(self):
        return self.qa_request.department if self.qa_request else None

    @property
    def application_owner(self):
        return self.qa_request.application_owner if self.qa_request else None

    # See SASTRequest.risk_rating above for the full reasoning.
    @property
    def risk_rating(self):
        return None

    # See QARequest.application_master_status -- delegated the same way as
    # department/application_owner above, so the SM reviewing this request's
    # own SM Approval step can see (and act on) a pending new Application
    # Name right from this request's own detail view.
    @property
    def application_master_status(self):
        return self.qa_request.application_master_status if self.qa_request else None

    @property
    def application_master_id(self):
        return self.qa_request.application_master_id if self.qa_request else None


class PerformanceChecklistItem(Base):
    """'L1: Pre-Testing Readiness Checklist' from Annexure VIII -- 19 fixed
    items (see constants.DEFAULT_PERFORMANCE_CHECKLIST_ITEMS), seeded onto
    every auto-created PerformanceRequest. None are mandatory (self-declared/
    QA-verified for visibility only) -- an unticked item no longer blocks
    Readiness -> Feasibility (see routers/performance.py::readiness_decision)."""
    __tablename__ = "qap_performance_checklist_items"
    id = pk_column()
    performance_request_id = Column(Integer, ForeignKey("qap_performance_requests.id"))
    item = Column(String(255), nullable=False)
    data_required = Column(String(255))   # "Data Required from Department" column in the annexure
    is_mandatory = Column(Boolean, default=True)
    # Requester's own self-declaration, ticked on the QA Request wizard's
    # Performance Testing step -- purely informational, same pattern as
    # Functional's requester_checked. Does NOT set is_complete;
    # QA still independently verifies every item (see
    # routers/performance.py::update_checklist_item).
    requester_checked = Column(Boolean, default=False)
    is_complete = Column(Boolean, default=False)
    approved_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    approved_at = Column(DateTime, nullable=True)

    performance_request = relationship("PerformanceRequest", back_populates="checklist_items")


class PerformanceWalkthrough(Base):
    """Walkthrough session log for a Performance Testing Request -- own
    dedicated table, mirroring WalkthroughSession (Functional Testing's)."""
    __tablename__ = "qap_performance_walkthroughs"
    id = pk_column()
    performance_request_id = Column(Integer, ForeignKey("qap_performance_requests.id"))
    session_date = Column(DateTime, default=now)
    conducted_by = Column(String(150))
    participants = Column(Text)
    recording_path = Column(String(255))
    document_path = Column(String(255))
    qa_acknowledged_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    qa_acknowledged_at = Column(DateTime, nullable=True)
    notes = Column(Text)

    performance_request = relationship("PerformanceRequest", back_populates="walkthroughs")


# ---------------------------------------------------------------------------
# Module 6: False Positive / Suppression Management
# ---------------------------------------------------------------------------
class SuppressionRequest(Base):
    __tablename__ = "qap_suppression_requests"
    id = pk_column()
    suppression_id = Column(String(40), unique=True, default=gen_id_default("SUP"))
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
    walkthroughs = relationship("SuppressionWalkthrough", back_populates="suppression_request",
                                 cascade="all,delete-orphan")
    sast_request = relationship("SASTRequest", back_populates="suppressions")
    dast_request = relationship("DASTRequest", back_populates="suppressions")

    @property
    def linked_request(self):
        """Whichever of sast_request/dast_request is actually set, matching
        scan_type -- lets the UI show the raw SAST-xxxx/DAST-xxxx Request ID
        this suppression was raised against (see schemas.LinkedRequestRef),
        the same way SAST/DAST/Functional/Performance already show their own
        linked QA Request."""
        return self.sast_request if self.sast_request_id else self.dast_request


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


class SuppressionWalkthrough(Base):
    """Walkthrough session log for a Suppression / False Positive request --
    own dedicated table, mirroring WalkthroughSession (Functional Testing's).
    Suppression has no readiness-checklist concept (it's an approval flow,
    not a testing-readiness flow), so it only gets Walkthroughs + History,
    not a Checklist tab."""
    __tablename__ = "qap_suppression_walkthroughs"
    id = pk_column()
    suppression_request_id = Column(Integer, ForeignKey("qap_suppression_requests.id"))
    session_date = Column(DateTime, default=now)
    conducted_by = Column(String(150))
    participants = Column(Text)
    recording_path = Column(String(255))
    document_path = Column(String(255))
    qa_acknowledged_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    qa_acknowledged_at = Column(DateTime, nullable=True)
    notes = Column(Text)

    suppression_request = relationship("SuppressionRequest", back_populates="walkthroughs")


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

    actor = relationship("User", foreign_keys=[actor_id])

    @property
    def actor_name(self):
        return self.actor.full_name if self.actor else None


class RequestDocument(Base):
    """Supporting documents uploaded after a request has been raised, for
    every request type EXCEPT the Gateway QA Request (which has its own
    dedicated QARequestDocument table/endpoints predating this one -- see
    Module 1, field 4.1.2). Generic/polymorphic (keyed by module+request_id)
    rather than one dedicated table per module, to avoid 7x near-identical
    tables.

    Unlike ApprovalAction.entity_type (where SAST and DAST unsafely share
    the string "SAST_DAST" despite each table having its own independent id
    sequence -- see the collision note on _sast_dast_history() in
    routers/sast_dast.py), every module here is assigned its own distinct
    `module` string (FUNCTIONAL / SAST / DAST / PERFORMANCE /
    SUPPRESSION / SIGNOFF), so (module, request_id) is always unambiguous.
    Files are stored on disk under backend/app/uploads/<module>/<request's
    own request_id string>/<filename> -- see UPLOAD_ROOT in documents.py."""
    __tablename__ = "qap_module_documents"
    id = pk_column()
    module = Column(String(20), nullable=False, index=True)
    request_id = Column(Integer, nullable=False, index=True)
    file_name = Column(String(255), nullable=False)
    stored_path = Column(String(500), nullable=False)   # relative to UPLOAD_ROOT
    content_type = Column(String(150))
    file_size = Column(Integer)
    uploaded_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    uploaded_at = Column(DateTime, default=now)


# ---------------------------------------------------------------------------
# Module 8: QA Sign-off Management
# ---------------------------------------------------------------------------
class QASignOff(Base):
    __tablename__ = "qap_signoffs"
    id = pk_column()
    certificate_id = Column(String(40), unique=True, default=gen_id_default("QA-CERT"))
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

    # IT - QA Engineer raises the certificate -> IT - QA Lead approves it ->
    # Executive COE gives the final approval that issues it -- see
    # constants.SIGNOFF_STATUSES. Replaces the old, much simpler Draft/Issued
    # flow (a QA Lead alone could draft and immediately sign/issue); existing
    # rows at the old "Draft"/"Issued" string values need a one-time data
    # migration, see ORACLE_MIGRATION_2026-07.md.
    status = Column(String(32), default="DRAFT")
    requester_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)   # Requested By (QA Team)
    reviewed_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)  # Approved By (QA Lead)
    approved_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)  # Approved By (Executive COE)
    # Vestigial -- left in place (unused going forward) rather than dropped,
    # same convention as qap_requests.priority/risk_rating (see section 30 of
    # the migration notes). issued_by_id used to mean "TQA Lead - CM QA who
    # drafted it" and signed_by_id "CM-QA who signed & issued it" under the
    # old single-step QA-Lead-only flow -- both superseded by requester_id/
    # reviewed_by_id/approved_by_id above.
    issued_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    signed_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)

    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)


# ---------------------------------------------------------------------------
# Module 10: Test Management (Project Management / Test Repository / Test
# Execution) -- a Zephyr-style test case management layer, built per direct
# request to mirror Zephyr's own 3-part structure: Projects contain a Test
# Repository (a folder tree of Test Cases, each with its own Steps), and
# Test Cycles under Test Execution which record a Pass/Fail/Blocked/NA/
# Retest Passed result per test case run. Deliberately its own standalone
# module rather than bolted onto Functional Testing -- a test case here can
# be authored/reused/executed independently of any one QA Request's
# lifecycle, same as in a real standalone test-management tool.
#
# Project <-> existing data: by explicit product decision, one TestProject
# maps to one Application (reusing ApplicationMaster rather than inventing a
# second, parallel "application name" list) -- application_master_id is kept
# purely for that traceability link; `name`/`department` are their own
# columns (not read live off ApplicationMaster) since a Project's own name
# may reasonably diverge from the master list over time (e.g. renamed) and
# should not silently change history on every existing Test Case/Cycle.
# ---------------------------------------------------------------------------
class TestProject(Base):
    __tablename__ = "qap_test_projects"
    id = pk_column()
    project_key = Column(String(40), unique=True, default=gen_id_default("TPROJ"))
    name = Column(String(150), nullable=False)
    application_master_id = Column(Integer, ForeignKey("qap_application_master.id"), nullable=True)
    department = Column(String(150))
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)

    application_master = relationship("ApplicationMaster", foreign_keys=[application_master_id])
    created_by = relationship("User", foreign_keys=[created_by_id])
    folders = relationship("TestFolder", back_populates="project", cascade="all,delete-orphan")
    test_cases = relationship("TestCase", back_populates="project", cascade="all,delete-orphan")
    cycles = relationship("TestCycle", back_populates="project", cascade="all,delete-orphan")


class TestFolder(Base):
    """Hierarchical folder tree within one Project's Test Repository --
    self-referential parent_id for nesting (e.g. 'Regression' > 'Login').
    A test case may sit directly under the Project with no folder at all
    (folder_id NULL on TestCase) -- folders are an organizing convenience,
    not mandatory."""
    __tablename__ = "qap_test_folders"
    id = pk_column()
    project_id = Column(Integer, ForeignKey("qap_test_projects.id"), nullable=False)
    parent_id = Column(Integer, ForeignKey("qap_test_folders.id"), nullable=True)
    name = Column(String(150), nullable=False)
    created_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)

    project = relationship("TestProject", back_populates="folders")
    parent = relationship("TestFolder", remote_side=[id], backref="children")
    created_by = relationship("User", foreign_keys=[created_by_id])

    @property
    def created_by_name(self):
        """Human-readable audit identity exposed by TestFolderOut."""
        return self.created_by.full_name if self.created_by else None


class TestCase(Base):
    """A single reusable test case in the Test Repository. Columns mirror the
    fixed xlsx upload template exactly (Test Case ID, Epic ID, Feature ID,
    User Story ID, Test Type, Module Name, Test Scenario, Pre-Condition,
    Test Case Description, Priority) -- see routers/test_repository.py's
    import_test_cases for the parser. Steps (with their own Expected Result)
    live in the separate TestStep table below, one row per step. Note this
    table holds the test case *definition* only -- Actual Result/Status/
    Test Run Artifacts/Defect ID from the template are execution-time facts
    and are not stored until an approved definition is used in a Test Cycle."""
    __tablename__ = "qap_test_cases"
    id = pk_column()
    test_case_key = Column(String(60), unique=True, nullable=False)
    project_id = Column(Integer, ForeignKey("qap_test_projects.id"), nullable=False)
    folder_id = Column(Integer, ForeignKey("qap_test_folders.id"), nullable=True)
    epic_id = Column(String(60))
    feature_id = Column(String(60))
    user_story_id = Column(String(60))
    test_type = Column(String(60))
    module_name = Column(String(150))
    test_scenario = Column(String(255))
    pre_condition = Column(Text)
    description = Column(Text)
    priority = Column(String(16))
    # Approval lifecycle: Draft = Pending QA Lead Review, Active = Approved
    # for Test Cycles, Deprecated = retained for history but unavailable for
    # new execution. The API, not a client edit form, controls transitions.
    status = Column(String(20), default="Active")
    created_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    project = relationship("TestProject", back_populates="test_cases")
    folder = relationship("TestFolder")
    created_by = relationship("User", foreign_keys=[created_by_id])
    steps = relationship("TestStep", back_populates="test_case", cascade="all,delete-orphan",
                          order_by="TestStep.step_no")
    executions = relationship("TestExecution", back_populates="test_case", cascade="all,delete-orphan")


class TestStep(Base):
    __tablename__ = "qap_test_steps"
    id = pk_column()
    test_case_id = Column(Integer, ForeignKey("qap_test_cases.id"), nullable=False)
    step_no = Column(Integer, nullable=False)
    step_text = Column(Text)
    expected_result = Column(Text)

    test_case = relationship("TestCase", back_populates="steps")


class TestCycle(Base):
    """Test Execution module -- a named run (e.g. 'Sprint 12 Regression',
    'CR-XX UAT Cycle 1') under a Project. Test cases are explicitly added to
    a cycle (creating a Not-Executed TestExecution row each) and then run
    against it -- the same case can be added to several different cycles
    over time, each getting its own independent execution history."""
    __tablename__ = "qap_test_cycles"
    id = pk_column()
    cycle_key = Column(String(40), unique=True, default=gen_id_default("CYCLE"))
    project_id = Column(Integer, ForeignKey("qap_test_projects.id"), nullable=False)
    name = Column(String(150), nullable=False)
    description = Column(Text)
    status = Column(String(20), default="Not Started")
    start_date = Column(Date, nullable=True)
    end_date = Column(Date, nullable=True)
    created_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)

    project = relationship("TestProject", back_populates="cycles")
    created_by = relationship("User", foreign_keys=[created_by_id])
    executions = relationship("TestExecution", back_populates="cycle", cascade="all,delete-orphan")


class TestExecution(Base):
    """One test case's result within one cycle. Created (status defaults to
    Not Executed) the moment a test case is added to a cycle; updated in
    place as it's actually run. Field names mirror the xlsx template's own
    execution-time columns (Actual Result, Status, Test Run Artifacts,
    Defect ID) so the same shape is used whether the result was typed in
    the UI or came in via the Excel import."""
    __tablename__ = "qap_test_executions"
    __table_args__ = (UniqueConstraint("cycle_id", "test_case_id", name="uq_qap_test_exec_cycle_case"),)
    id = pk_column()
    cycle_id = Column(Integer, ForeignKey("qap_test_cycles.id"), nullable=False)
    test_case_id = Column(Integer, ForeignKey("qap_test_cases.id"), nullable=False)
    status = Column(String(20), default="Not Executed")
    actual_result = Column(Text)
    test_run_artifacts = Column(String(255))
    defect_id = Column(String(60))
    executed_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    executed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=now)

    cycle = relationship("TestCycle", back_populates="executions")
    test_case = relationship("TestCase", back_populates="executions")
    executed_by = relationship("User", foreign_keys=[executed_by_id])
