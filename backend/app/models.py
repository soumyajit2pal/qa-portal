import datetime
import json
from typing import List
from zoneinfo import ZoneInfo

from sqlalchemy import (
    Column, Integer, String, Text, Boolean, DateTime, ForeignKey, Date, Identity, Index,
    UniqueConstraint, CheckConstraint, text, and_
)
from sqlalchemy.orm import relationship, foreign
from .db_base import Base
from .constants import QAStatus, LoginType, GatewayStatus, FUNCTIONAL_BUCKET_TYPES, SUPPRESSION_TERMINAL_STATUSES, Role

# Unlike SQLite/PostgreSQL/MySQL, SQLAlchemy does NOT automatically make a
# bare `Column(Integer, primary_key=True)` self-generating on Oracle -- Oracle
# has no native AUTO_INCREMENT, so you must opt in explicitly with Identity()
# (Oracle 12c+ identity columns). Every primary key below uses this helper so
# inserts get a generated id instead of failing with ORA-01400.
def pk_column():
    return Column(Integer, Identity(start=1, increment=1), primary_key=True)


def now():
    return datetime.datetime.now(datetime.UTC).astimezone(ZoneInfo("Asia/Kolkata"))


def today_ist():
    return now().date()


def as_aware(dt):
    """Reported directly (traceback): "TypeError: can't compare offset-naive
    and offset-aware datetimes" in test_reports.py::project_portfolio,
    comparing a TestCycle.created_at read back from the database against a
    now()-derived value.

    Every `created_at`/`submitted_at`/`reviewed_at`/etc. column in this app
    is a plain `Column(DateTime)` (no `timezone=True`) written via now()
    above, which returns a timezone-AWARE IST datetime -- but on Oracle
    (and most other backends) a plain DateTime column round-trips values as
    NAIVE on read, silently dropping the tzinfo the row was written with.
    So any later `now() - some_row.created_at` or `some_row.created_at <
    some_now_derived_value` mixes an aware value with a naive one and raises
    exactly this TypeError -- not on every request, only once live data
    actually exists to compare against, which is why this can slip past
    py_compile/tsc and even a fresh empty database.

    dashboard.py's own `_age_days` helper hit this same error previously and
    fixed it by treating a naive value as already being in IST rather than
    comparing it against a UTC-derived now (see that function's own
    comment) -- this is that exact fix, extracted so every other call site
    doing now()-based datetime math (test_reports.py and any future one)
    shares one implementation
    instead of re-deriving it -- and re-risking forgetting it -- each time.
    Returns None unchanged; an already-aware value is returned unchanged
    too (nothing here assumes every caller's value is naive)."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=ZoneInfo("Asia/Kolkata"))
    return dt


# Every system-generated, user-facing business ID uses one consistent shape:
# "TQA-{MODULE}-{NN}", for example TQA-FUNC-01, TQA-FUNC-02 and
# TQA-SAST-01. Counters are independent per module and never reset. `02` is
# a minimum width rather than a hard limit, so item 100 becomes `...-100`.
#
# Oracle-safe concurrency continues to use qap_id_counters. Its historical
# `counter_date` key is retained to avoid a destructive table migration, but
# all new-format counters use one fixed lifetime scope date. Existing dated
# counter rows and already-issued business IDs remain untouched for audit and
# deep-link stability; new-format numbering starts at 01 for each prefix.
BUSINESS_ID_PREFIXES = {
    "QA_REQUEST": "TQA-REQ",
    "FUNCTIONAL": "TQA-FUNC",
    "SAST": "TQA-SAST",
    "DAST": "TQA-DAST",
    "PERFORMANCE": "TQA-PERF",
    "SUPPRESSION": "TQA-SUP",
    "SIGNOFF": "TQA-SIGN",
    "TEST_PROJECT": "TQA-PROJ",
    "TEST_CYCLE": "TQA-CYCLE",
    "TEST_CASE": "TQA-TC",
    "DEFECT": "DEF",
}
_BUSINESS_ID_PREFIX_SET = frozenset(BUSINESS_ID_PREFIXES.values())
_LIFETIME_COUNTER_SCOPE = datetime.date(1900, 1, 1)


class IdCounter(Base):
    __tablename__ = "qap_id_counters"
    prefix = Column(String(20), primary_key=True)
    counter_date = Column(Date, primary_key=True)
    next_value = Column(Integer, nullable=False)


def _claim_business_seq(prefix, executable) -> int:
    """`executable` is anything exposing .execute(text(...)) -- a raw
    Connection (from a Column default's ExecutionContext, see
    gen_id_default below) or an ORM Session (when called directly from
    router code). The fixed scope means the per-prefix number never resets."""
    if prefix not in _BUSINESS_ID_PREFIX_SET:
        raise ValueError(f"Unsupported business ID prefix: {prefix}")
    executable.execute(
        text(
            "MERGE INTO qap_id_counters t "
            "USING (SELECT :prefix AS prefix, :cdate AS counter_date FROM dual) s "
            "ON (t.prefix = s.prefix AND t.counter_date = s.counter_date) "
            "WHEN MATCHED THEN UPDATE SET next_value = next_value + 1 "
            "WHEN NOT MATCHED THEN INSERT (prefix, counter_date, next_value) "
            "VALUES (s.prefix, s.counter_date, 1)"
        ),
        {"prefix": prefix, "cdate": _LIFETIME_COUNTER_SCOPE},
    )
    return executable.execute(
        text("SELECT next_value FROM qap_id_counters WHERE prefix = :prefix AND counter_date = :cdate"),
        {"prefix": prefix, "cdate": _LIFETIME_COUNTER_SCOPE},
    ).scalar()


def gen_id(prefix, db):
    """Call directly with the active Session when a business ID is needed
    outside of a Column default (e.g. routers/test_repository.py, where a
    Test Case's key is generated explicitly by its router). For
    Column-level defaults, use gen_id_default below instead -- a plain 0-arg
    callable has no access to the live connection Oracle needs for the
    MERGE, only the ExecutionContext SQLAlchemy hands a 1-arg default at
    flush time."""
    n = _claim_business_seq(prefix, db)
    return f"{prefix}-{n:02d}"


def gen_id_default(prefix):
    """Returns a context-sensitive SQLAlchemy Column default -- pass to
    Column(..., default=gen_id_default("TQA-REQ")). SQLAlchemy detects the
    1-argument signature and supplies the ExecutionContext automatically at
    flush/insert time, whose .connection is used to run the MERGE."""
    def _default(context):
        n = _claim_business_seq(prefix, context.connection)
        return f"{prefix}-{n:02d}"
    return _default


def gen_defect_id(db):
    """Issue the governed Defect Management ID: TQA-DEF-NNNNN, same
    "TQA-{MODULE}-{NN...}" convention as every other business ID in this app
    (see the header comment above BUSINESS_ID_PREFIXES) -- a global,
    monotonically increasing counter via _claim_business_seq, never reset
    per year. Docstring/body previously disagreed (this said "DEF-YYYY-
    NNNNN" and computed an unused `year` local that was never actually
    incorporated into the returned string) -- fixed to describe what this
    actually returns rather than an abandoned year-scoped format."""
    n = _claim_business_seq(BUSINESS_ID_PREFIXES["DEFECT"], db)
    return f"TQA-DEF-{n:05d}"


class User(Base):
    __tablename__ = "qap_users"
    id = pk_column()
    username = Column(String(64), unique=True, nullable=False)
    full_name = Column(String(150), nullable=False)
    email = Column(String(150))
    # 2026-08 "one user can be on multiple departments" CR -- a user's real
    # department membership now lives in department_assignments (many-to-many
    # via UserDepartment, same pattern as role_assignments/UserRole below).
    # This column is kept, but is no longer the source of truth: every write
    # path now also keeps it in sync with the FIRST-assigned department (see
    # `departments`/`primary_department` below, and _sync_primary_department
    # in routers/auth.py) purely so any legacy code/report that still queries
    # this raw column directly keeps working with a sane "primary department"
    # value instead of silently going stale or NULL. New code should use
    # `.departments` (the full list) or `.has_department(...)` instead.
    department = Column(String(150))
    login_type = Column(String(16), nullable=False, default=LoginType.STANDARD)
    # Nullable because LDAP-type accounts authenticate against the directory
    # server and never store a local password hash.
    hashed_password = Column(String(255), nullable=True)
    is_active = Column(Boolean, default=True)
    # Set True when a User row is auto-created via LDAP just-in-time
    # provisioning (first successful login for an unknown username); cleared
    # once an Administrator or the mapped Department Coordinator explicitly
    # assigns an approved role through access management.
    needs_role_review = Column(Boolean, default=False)
    # Set True for a normal first-ever LDAP login (JIT provisioning, see
    # routers/auth.py::login) -- since the
    # directory's own "department" attribute is free text and often blank or
    # not an exact match for one of our canonical qap_departments.name values
    # (case/wording differences), the person is prompted once, right after
    # that first login, to explicitly confirm/pick their department from the
    # real list themselves (see PATCH /api/auth/me). Cleared the moment they
    # do. Unlike needs_role_review, this is never cleared by an admin action
    # -- only the user's own self-service pick resolves it. External
    # document-only identities are a deliberate exception: they are assigned
    # `Other` automatically and therefore start with this flag False.
    needs_department_selection = Column(Boolean, default=False)
    # Set by a System Admin only (PATCH /api/auth/users/{id} -- Admin.tsx's
    # "Users & Access" page; never exposed on the narrower local-admin
    # endpoints below). When True, this user is hidden from every Department
    # Head / Executive 's local-admin roster (see
    # routers/auth.py::list_local_admin_users) and can't be targeted by
    # PATCH /api/auth/local-admin/users/{id} even by ID (see
    # _require_own_department_target) -- same treatment "ADMIN" accounts
    # already get there, just opt-in per user rather than tied to a role.
    # Intended for people a department head shouldn't be able to reassign or
    # deactivate even though they're mapped to that department (e.g. a
    # sensitive or cross-functional account) -- only a System Admin can
    # change their role(s) or active status from here on.
    admin_managed_only = Column(Boolean, default=False)
    created_at = Column(DateTime, default=now)

    qa_requests = relationship("QARequest", back_populates="requester", foreign_keys="QARequest.requester_id")
    # A user can now hold multiple roles simultaneously (e.g. QA Lead +
    # Security Analyst) -- replaces the old single `role` column. All
    # permission checks treat a user's assigned roles as active at once (no
    # role-switcher): see has_role() below and deps.py::require_roles.
    role_assignments = relationship("UserRole", back_populates="user", cascade="all,delete-orphan")
    # 2026-08 "one user can be on multiple departments" CR, reported
    # directly. A user can now belong to more than one department at once
    # (e.g. a shared/cross-functional QA + Security Analyst account) --
    # mirrors role_assignments/UserRole above exactly, same join-table
    # pattern. `order_by` keeps `.departments`/`primary_department` stable
    # and predictable (insertion order = the order departments were
    # assigned), which matters for `primary_department` below.
    department_assignments = relationship(
        "UserDepartment", back_populates="user", cascade="all,delete-orphan",
        order_by="UserDepartment.id",
    )

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
        if "ADMIN" in codes or bool(codes & set(roles)):
            return True
        return False

    @property
    def departments(self) -> List[str]:
        """Every department this user currently belongs to. Falls back to the
        legacy `department` column for any account that predates the
        department_assignments rollout and hasn't been touched since (e.g. a
        row seeded before this migration ran) -- keeps has_department() and
        every caller of `.departments` working immediately, with no separate
        backfill step required."""
        assigned = [da.department for da in self.department_assignments]
        if assigned:
            return assigned
        return [self.department] if self.department else []

    @property
    def primary_department(self) -> "str | None":
        """The FIRST department this user was ever assigned -- used only as a
        default/prefill for the handful of places that need exactly one
        department (e.g. a new QA Request's own department field). Never
        used for eligibility/access checks -- those should always check
        against the full `.departments` list via has_department()."""
        departments = self.departments
        return departments[0] if departments else None

    def has_department(self, *departments: str) -> bool:
        """True if this user belongs to at least one of the given
        departments. The multi-department equivalent of the old
        `user.department == X` / `user.department in (...)` checks scattered
        across the app -- every one of those was rewritten to call this
        instead of comparing the single legacy column directly."""
        return bool(set(self.departments) & set(d for d in departments if d))


class UserRole(Base):
    """Join table backing User.roles -- one row per (user, role) pair."""
    __tablename__ = "qap_user_roles"
    __table_args__ = (UniqueConstraint("user_id", "role", name="uq_qap_user_roles"),)
    id = pk_column()
    user_id = Column(Integer, ForeignKey("qap_users.id"), nullable=False)
    role = Column(String(32), nullable=False)

    user = relationship("User", back_populates="role_assignments")


class UserDepartment(Base):
    """Join table backing User.departments -- one row per (user, department)
    pair, exact mirror of UserRole above. `department` is a free-text string
    (not a FK to qap_departments.id) for the same reason the legacy
    User.department column was: it's validated against active Department
    rows at write time (routers/auth.py::_validate_department) rather than
    DB-enforced, matching how every other "department" field in this app
    (QARequest.department, TestProject.department, etc.) already works."""
    __tablename__ = "qap_user_departments"
    __table_args__ = (UniqueConstraint("user_id", "department", name="uq_qap_user_departments"),)
    id = pk_column()
    user_id = Column(Integer, ForeignKey("qap_users.id"), nullable=False)
    department = Column(String(150), nullable=False)
    created_at = Column(DateTime, default=now)

    user = relationship("User", back_populates="department_assignments")


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


class SystemSetting(Base):
    """Admin-managed server settings that must persist across deployments."""
    __tablename__ = "qap_system_settings"
    id = pk_column()
    key = Column(String(100), unique=True, nullable=False)
    value = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=now, onupdate=now)


class ApplicationMaster(Base):
    """Master list of standardised Application Names, built up over time as
    requesters introduce new ones via the QA Request wizard's Application
    Name dropdown (see routers/qa_requests.py::_resolve_application_name).
    The dropdown itself only ever offers names with status == APPROVED (see
    routers/applications.py::list_application_names); picking "Other" and
    typing a name not already on this list creates a new row here (name
    always upper-cased at the point of entry, see the same resolver, to
    minimise case-sensitivity duplicates).

    Single-tier approval (2026-08 v2): a brand-new name starts at
    PENDING_APP_OWNER -- an Application Owner from the same department must
    approve it (see routers/applications.py::decide_app_owner_name) -- and
    that decision is immediately terminal either way: Approved goes straight
    to APPROVED (a pickable option for everyone else going forward, and no
    longer "pending" on this particular request), Rejected goes straight to
    REJECTED. Reported directly: "only application owner approval required,
    no SM involvement. if application owner approved then automatically come
    to SM for readiness verification and all" -- the linked request's own
    child requests (Functional/SAST/DAST/Performance) are created the moment
    the name is Approved and go straight to their assigned SM's own normal
    readiness-verification queue, same as any other Raised request; no
    separate SM decision on the NAME itself exists anymore.

    Historical note: for a short window in 2026-08 (v1 of this feature) there
    was a second, SM tier in between (PENDING_SM, decided via
    decide_application_name) before a name became APPROVED. That tier is now
    legacy-only -- PENDING_SM is kept as a valid status value purely so any
    row that was already sitting there before v2 shipped keeps working via
    decide_application_name (a one-time data fix-up documented in the
    migration notes converts any such row straight to APPROVED, so this
    should not normally be reachable at all) -- no NEW name can ever reach
    PENDING_SM again. Approving/rejecting the name is independent of
    approving the request itself in the sense that raising/saving a request
    is never blocked on it (_resolve_application_name never blocks the
    caller) -- but the request's own SM/Department Head Approval decisions
    ARE blocked from reaching "Approved" while this is anything other than
    APPROVED (see application_name_block_message in constants.py and its 6
    call sites across functional.py/sast_dast.py/performance.py)."""
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
    # Intentional cycle: ApplicationMaster traces the introducing QARequest,
    # while QARequest points back to its resolved ApplicationMaster. Tell
    # SQLAlchemy/Alembic to add this side after both tables exist so metadata
    # sorting is deterministic (and Oracle never sees an inline FK to a table
    # that has not been created yet).
    qa_request_id = Column(Integer, ForeignKey(
        "qap_requests.id", name="fk_qap_app_master_qa_req", use_alter=True,
    ), nullable=True)
    # Application Owner's own decision -- the only tier that decides a NEW
    # name (2026-08 v2). Populated whenever an Application Owner decides,
    # Approved or Rejected; either outcome is terminal, so both this tier's
    # own fields AND the (legacy-named, but no longer SM-specific) fields
    # below get populated together -- anything reading decided_by_id/
    # decided_at/comments as "the decision that made this terminal" keeps
    # working regardless.
    app_owner_decided_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    app_owner_decided_at = Column(DateTime, nullable=True)
    app_owner_comments = Column(Text, nullable=True)
    # Historically the SM's own tier (see the class docstring's "Historical
    # note") -- now just mirrors whichever decision (by the Application
    # Owner) was terminal. Left named as-is rather than renamed, since this
    # is a live Oracle column (see ORACLE_MIGRATION_2026-07.md) and no
    # renaming DDL has been requested.
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
    # Deliberately NOT gen_id_default -- unlike every other business ID in
    # this app, this one is not assigned at row-creation time. A QA Request
    # starts life as a Draft (pure scratch work, see status below) and is
    # commonly cancelled before ever being raised; burning a real
    # TQA-REQ-NN number on every Draft (including ones that are
    # immediately cancelled) would leave the sequence full of gaps for
    # nothing. Stays NULL while Draft; assigned exactly once, by
    # routers/qa_requests.py::submit_request, the moment it's actually
    # raised. Oracle's UNIQUE constraint permits any number of NULLs, so
    # multiple concurrent Drafts are never blocked by this.
    request_id = Column(String(40), unique=True, nullable=True)
    request_date = Column(Date, default=today_ist)
    department = Column(String(150))
    application_name = Column(String(150), nullable=False)
    application_owner = Column(String(150))
    cr_number = Column(String(64))
    epic_number = Column(String(150))
    change_type = Column(String(32))              # New / Enhancement / Bug Fix -- see constants.CHANGE_TYPES
    # Optional traceability for a Bug Fix back to the earlier gateway whose
    # Functional Testing workflow reached CLOSED. The business request ID is
    # stable and unique, so it is stored directly and protected by a
    # self-referencing FK; routers/qa_requests.py additionally verifies that
    # the referenced request belongs to the same application/department and
    # is actually completed.
    bug_fix_source_request_id = Column(
        String(40), ForeignKey("qap_requests.request_id"), nullable=True,
    )
    vendor_si_partner = Column(String(150))
    technology_stack = Column(String(150))
    release_version = Column(String(64))
    build_number = Column(String(64))
    environment = Column(String(32))              # "Deployment Environment" -- SIT/UAT/Pre-Production/Production
    target_promotion_environment = Column(String(32))
    request_types = Column(String(255))          # comma-separated from REQUEST_TYPES
    # Retained only for non-destructive compatibility with historical rows;
    # "Others" is no longer an accepted Request Type and this legacy column
    # is not exposed by create/update/output schemas.
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
    # Reported directly: a new mandatory field describing the change itself
    # (distinct from Change Type's New/Enhancement/Bug Fix classification).
    # Nullable here like every other "mandatory" wizard field on this table
    # (application_owner, cr_number, technology_stack, ...) -- application_name
    # is the one deliberate NOT NULL exception (see its own comment). Real
    # enforcement is at the wizard level (validation.ts's REQUIRED_DETAIL_FIELDS
    # + DetailsStep.tsx's `required`), the same reasoning validation.ts's own
    # header comment gives for why that has to be explicit instead of relying
    # on the browser's native `required` attribute alone.
    change_description = Column(Text)

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
    delegations = relationship(
        "QARequestDelegation", back_populates="qa_request", cascade="all,delete-orphan",
        order_by="QARequestDelegation.assigned_at.desc()",
    )
    # Read only filtered relationship used by permission checks and list/detail
    # responses. Keeping it separate avoids loading the complete historical
    # delegation collection on every paginated QA Request row.
    active_delegation = relationship(
        "QARequestDelegation",
        primaryjoin="and_(QARequest.id == foreign(QARequestDelegation.qa_request_id), "
                    "QARequestDelegation.target_type == 'QA_REQUEST', "
                    "QARequestDelegation.target_id == QARequest.id, "
                    "QARequestDelegation.status == 'ACTIVE')",
        uselist=False,
        viewonly=True,
    )

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

class QARequestDelegation(Base):
    """Temporary, request-specific editing access granted by the requester.

    This does not change QARequest.requester_id, department, or workflow
    status. ACTIVE grants the selected user access to this one Draft only;
    RETURNED and RECALLED are immutable history retained for audit evidence.
    """
    __tablename__ = "qap_request_delegations"
    __table_args__ = (
        CheckConstraint("status IN ('ACTIVE','RETURNED','RECALLED')", name="ck_qap_del_status"),
        CheckConstraint(
            "target_type IN ('QA_REQUEST','FUNCTIONAL','SAST','DAST','PERFORMANCE')",
            name="ck_qap_del_target_type",
        ),
    )
    id = pk_column()
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=False)
    target_type = Column(String(24), nullable=False, default="QA_REQUEST")
    target_id = Column(Integer, nullable=False)
    assigned_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=False)
    assigned_to_id = Column(Integer, ForeignKey("qap_users.id"), nullable=False)
    assignment_reason = Column(Text, nullable=False)
    status = Column(String(16), nullable=False, default="ACTIVE")
    assigned_at = Column(DateTime, default=now, nullable=False)
    closed_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    returned_at = Column(DateTime, nullable=True)
    return_comments = Column(Text, nullable=True)

    qa_request = relationship("QARequest", back_populates="delegations")
    assigned_by = relationship("User", foreign_keys=[assigned_by_id])
    assigned_to = relationship("User", foreign_keys=[assigned_to_id])
    closed_by = relationship("User", foreign_keys=[closed_by_id])

    @property
    def assigned_by_name(self):
        return self.assigned_by.full_name if self.assigned_by else None

    @property
    def assigned_to_name(self):
        return self.assigned_to.full_name if self.assigned_to else None

    @property
    def closed_by_name(self):
        return self.closed_by.full_name if self.closed_by else None


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
    request_id = Column(String(40), unique=True, default=gen_id_default(BUSINESS_ID_PREFIXES["FUNCTIONAL"]))
    # IDX-002/IDX-005: no longer index=True on its own -- superseded by the
    # composite ix_qap_func_status_created below (same leading column, plus
    # created_at), see the "Performance optimization indexes" block near the
    # end of this file for the full rationale.
    status = Column(String(32), default=QAStatus.DRAFT)
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
    qa_lead_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)       # COE - Quality Assurance QA Lead assigned by Department Head
    assigned_tester_ids = Column(String(255))     # comma-separated QA Engineer user ids (Tester Assigned step)
    signoff_id = Column(Integer, ForeignKey("qap_signoffs.id"), nullable=True)    # linked QA Clearance certificate
    # Set when auto-created from a QA Request gateway (always, for new rows --
    # standalone creation is disabled, see routers/functional.py); nullable
    # only for symmetry with the other linked-request models.
    # Perf tuning (2026-08) -- indexed via explicit short-named Index()
    # (ix_qap_func_qa_req) near the end of this file, not inline index=True
    # -- see SuppressionRequest.department's own comment for why.
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)

    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    requester = relationship("User", foreign_keys=[requester_id])
    qa_request = relationship("QARequest", back_populates="linked_functional_requests")
    checklist_items = relationship("ReadinessChecklistItem", back_populates="functional_request", cascade="all,delete-orphan")
    signoff = relationship("QASignOff", foreign_keys=[signoff_id])
    test_cycle_links = relationship(
        "TestCycleChildRequestLink",
        primaryjoin=lambda: and_(
            FunctionalRequest.id == foreign(TestCycleChildRequestLink.child_id),
            TestCycleChildRequestLink.child_type == "Functional",
        ),
        viewonly=True,
    )

    @property
    def linked_test_cycles(self):
        return [link.cycle for link in self.test_cycle_links if link.cycle]

    # 2026-08 -- reported directly: "LINK THE CERTIFICATE ONCE GENERATED" --
    # this request's detail view had no way to see the QA Clearance
    # certificate it's linked to (signoff_id above) even after one existed.
    # Delegated the same way as application_name/department/application_owner
    # above rather than adding duplicate columns.
    @property
    def signoff_certificate_id(self):
        return self.signoff.certificate_id if self.signoff else None

    @property
    def signoff_certificate_status(self):
        return self.signoff.status if self.signoff else None

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
        """Reported directly: a Functional child request's own "Request
        Type(s)" field showed the gateway's ENTIRE request_types list --
        e.g. "Functional Testing,SAST" -- even though this specific,
        already-raised Functional request only ever represents whichever of
        the 4 Functional-bucket types (FUNCTIONAL_BUCKET_TYPES: Functional/
        Sanity/Regression Testing, UAT Support -- see this class's own
        docstring for why they share one entity) were actually selected;
        "SAST" etc. belong to a SIBLING child request, not this one. Showing
        the gateway's full combined list is correct on the QA Request
        gateway's own page (RequestDetail.tsx, unaffected -- reads
        qa_request.request_types directly, not through this property) --
        wrong here, on this "independent" child's own detail page. Filtered
        down to just the bucket types this request actually represents."""
        if not self.qa_request or not self.qa_request.request_types:
            return None
        selected = [t.strip() for t in self.qa_request.request_types.split(",")]
        own = [t for t in selected if t in FUNCTIONAL_BUCKET_TYPES]
        return ",".join(own) if own else None

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

    # Same delegation pattern as cr_number above -- requested so the Change
    # Description entered on the QA Request wizard also shows on this
    # request's own list/overview, not just the parent gateway's list.
    @property
    def change_description(self):
        return self.qa_request.change_description if self.qa_request else None

    @property
    def change_type(self):
        return self.qa_request.change_type if self.qa_request else None

    @property
    def bug_fix_source_request_id(self):
        return self.qa_request.bug_fix_source_request_id if self.qa_request else None

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

    # Added specifically so the QA Clearance Certificate modal (raised from
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

    @property
    def active_delegation(self):
        """Temporary input assignment scoped to this Functional request."""
        if not self.qa_request:
            return None
        return next((item for item in self.qa_request.delegations
                     if item.target_type == "FUNCTIONAL" and item.target_id == self.id
                     and item.status == "ACTIVE"), None)

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


# ---------------------------------------------------------------------------
# Module 4: SAST Request Management
# ---------------------------------------------------------------------------
class SASTRequest(Base):
    __tablename__ = "qap_sast_requests"
    id = pk_column()
    request_id = Column(String(40), unique=True, default=gen_id_default(BUSINESS_ID_PREFIXES["SAST"]))
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
    # COE - Quality Assurance QA Lead assigned by the requester's Department Head for readiness,
    # followed by the COE - Quality Assurance Security Analyst selected by that lead.
    security_lead_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    security_analyst_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    report_path = Column(String(255))
    # Set when this SAST request was auto-created because a QA Request's
    # request_types included "SAST" (see routers/qa_requests.py
    # ::_sync_linked_child_requests); null for standalone SAST requests
    # raised directly through this module -- those still get their own
    # unique request_id via the default above, just with no QA Request link.
    # Perf tuning (2026-08) -- indexed via explicit short-named Index()
    # (ix_qap_sast_qa_req) near the end of this file, not inline index=True
    # -- see SuppressionRequest.department's own comment for why.
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    findings = relationship("SASTFinding", back_populates="sast_request", cascade="all,delete-orphan")
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

    # Same delegation pattern as department/application_owner above.
    @property
    def change_description(self):
        return self.qa_request.change_description if self.qa_request else None

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

    @property
    def active_delegation(self):
        if not self.qa_request:
            return None
        return next((item for item in self.qa_request.delegations
                     if item.target_type == "SAST" and item.target_id == self.id
                     and item.status == "ACTIVE"), None)

    # PAG-005 -- the paginated list view (SASTListOut) shows a findings
    # count, not the full findings list; routers/sast_dast.py's list_sast
    # eager-loads `findings` via selectinload so reading this property
    # doesn't turn into a lazy-load-per-row.
    @property
    def findings_count(self):
        return len(self.findings)

    # 2026-08 "Findings Validation" doc restoration -- list-row Status badge
    # needs to know (without a second query per row) whether a non-terminal
    # Suppression / False Positive request is currently linked, so it can
    # overlay "Suppression Approval Pending" over WAITING_FOR_FIX the same
    # way application_master_status overlays "Application Owner Approval
    # Pending" over SM_APPROVAL_PENDING. Mirrors the has_open_suppression
    # check already used server-side (_pending_suppression_ids in
    # routers/sast_dast.py); routers/sast_dast.py's list_sast selectinload's
    # `suppressions` so this doesn't lazy-load per row.
    @property
    def has_open_suppression(self):
        return any(s.status not in SUPPRESSION_TERMINAL_STATUSES for s in self.suppressions)


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


# ---------------------------------------------------------------------------
# Module 5: DAST Request Management
# ---------------------------------------------------------------------------
class DASTRequest(Base):
    __tablename__ = "qap_dast_requests"
    id = pk_column()
    request_id = Column(String(40), unique=True, default=gen_id_default(BUSINESS_ID_PREFIXES["DAST"]))
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
    security_lead_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)  # assigned COE - Quality Assurance QA Lead
    security_analyst_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)  # assigned COE - Quality Assurance Security Analyst
    report_path = Column(String(255))
    # Set when this DAST request was auto-created because a QA Request's
    # request_types included "DAST"; null for standalone DAST requests
    # raised directly through this module.
    # Perf tuning (2026-08) -- indexed via explicit short-named Index()
    # (ix_qap_dast_qa_req) near the end of this file, not inline index=True
    # -- see SuppressionRequest.department's own comment for why.
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    findings = relationship("DASTFinding", back_populates="dast_request", cascade="all,delete-orphan")
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

    # Same delegation pattern as cr_number above.
    @property
    def change_description(self):
        return self.qa_request.change_description if self.qa_request else None

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

    @property
    def active_delegation(self):
        if not self.qa_request:
            return None
        return next((item for item in self.qa_request.delegations
                     if item.target_type == "DAST" and item.target_id == self.id
                     and item.status == "ACTIVE"), None)

    # See SASTRequest.findings_count above -- same idea, for DAST.
    @property
    def findings_count(self):
        return len(self.findings)

    # See SASTRequest.has_open_suppression above -- same idea, for DAST.
    @property
    def has_open_suppression(self):
        return any(s.status not in SUPPRESSION_TERMINAL_STATUSES for s in self.suppressions)


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


class SecurityScanResult(Base):
    """Immutable Fortify SSC snapshot imported when Start Scan is clicked.

    One shared table serves SAST and DAST because SSC exposes the same
    project-version/filter-set result shape for both. request_type plus
    request_id identifies the owning portal record without cross-table
    foreign keys; prior snapshots remain available as an audit trail.
    """
    __tablename__ = "qap_security_scan_results"
    id = pk_column()
    request_type = Column(String(8), nullable=False, index=True)
    request_id = Column(Integer, nullable=False, index=True)
    application_name = Column(String(150), nullable=False)
    application_version = Column(String(100), nullable=False)
    provider = Column(String(40), nullable=False, default="Fortify SSC")
    provider_version_id = Column(String(100), nullable=False)
    critical_count = Column(Integer, nullable=False, default=0)
    high_count = Column(Integer, nullable=False, default=0)
    medium_count = Column(Integer, nullable=False, default=0)
    low_count = Column(Integer, nullable=False, default=0)
    total_count = Column(Integer, nullable=False, default=0)
    audit_url = Column(String(1000))
    filters_json = Column(Text)
    imported_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    imported_at = Column(DateTime, default=now, nullable=False)

    imported_by = relationship("User", foreign_keys=[imported_by_id])

    @property
    def filters(self):
        try:
            return json.loads(self.filters_json or "[]")
        except (TypeError, ValueError):
            return []


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
    request_id = Column(String(40), unique=True, default=gen_id_default(BUSINESS_ID_PREFIXES["PERFORMANCE"]))
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
    # Existing column now represents the COE - Quality Assurance QA Lead assigned by the
    # requester's Department Head. Execution testers are tracked separately.
    engineer_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    assigned_tester_ids = Column(String(255))  # comma-separated COE - Quality Assurance QA Engineer ids
    report_path = Column(String(255))
    # Perf tuning (2026-08) -- indexed via explicit short-named Index()
    # (ix_qap_perf_qa_req) near the end of this file, not inline index=True
    # -- see SuppressionRequest.department's own comment for why.
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)

    qa_request = relationship("QARequest", back_populates="linked_performance_requests")
    checklist_items = relationship("PerformanceChecklistItem", back_populates="performance_request",
                                    cascade="all,delete-orphan")

    @property
    def department(self):
        return self.qa_request.department if self.qa_request else None

    # Same delegation pattern as department above.
    @property
    def change_description(self):
        return self.qa_request.change_description if self.qa_request else None

    @property
    def bug_fix_source_request_id(self):
        return self.qa_request.bug_fix_source_request_id if self.qa_request else None

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

    @property
    def active_delegation(self):
        if not self.qa_request:
            return None
        return next((item for item in self.qa_request.delegations
                     if item.target_type == "PERFORMANCE" and item.target_id == self.id
                     and item.status == "ACTIVE"), None)


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


class ChecklistTemplateItem(Base):
    """Admin-configurable checklist item definition -- the live source of
    truth every new Functional/SAST/DAST/Performance request's own readiness
    checklist (ReadinessChecklistItem/SASTChecklistItem/DASTChecklistItem/
    PerformanceChecklistItem above) is seeded from (see
    checklist_config.get_template_items and
    routers/qa_requests.py::_sync_linked_child_requests, which read active
    rows here ordered by sort_order instead of the old hardcoded
    constants.DEFAULT_*_CHECKLIST_ITEMS python lists).

    Reported directly: "I want to make configurable readiness checklist,
    whatever I mention on that configuration will automatically behave like
    that -- if I make any checklist item mandatory, that will be mandatory."
    Editing this table (Admin > Readiness Checklist Configuration, see
    routers/checklist_config.py) only ever affects requests raised from that
    point forward -- a request already in flight keeps its own already-seeded
    checklist item rows untouched (they were copied at seed time, they don't
    reference this table), so changing a definition here can never silently
    alter what's already in progress somewhere else.

    constants.DEFAULT_*_CHECKLIST_ITEMS remain in the codebase as this
    table's shipped defaults -- used to bootstrap it the first time a module
    is read with zero rows (see checklist_config.get_template_items), and
    offered back to an Admin as a one-click "Restore Defaults" action.

    Reported directly: "readiness checklist item sometime showing multiple in
    UI while raising request." Root cause was a race in the lazy-bootstrap
    seeding this table (see checklist_config.get_template_items): two
    concurrent requests could both see zero rows for a module and both insert
    a full default set, with nothing at the DB level stopping it. The unique
    constraint below is the actual fix -- makes a second concurrent seed
    attempt fail outright instead of silently duplicating every item -- see
    get_template_items' own comment for how that failure is now handled
    gracefully (lost the race, not an error)."""
    __tablename__ = "qap_checklist_template_items"
    __table_args__ = (UniqueConstraint("module", "item", name="uq_qap_checklist_template_item"),)
    id = pk_column()
    # One of checklist_config.CHECKLIST_MODULES: "FUNCTIONAL", "SAST", "DAST",
    # "PERFORMANCE". Plain string column (not a FK/enum table) -- same
    # convention as every other "kind"/"module" discriminator column already
    # in this app (e.g. RequestDocument.module).
    module = Column(String(20), nullable=False)
    item = Column(String(255), nullable=False)
    # "Owner" for Functional/SAST/DAST, "Data Required from Department" for
    # Performance (Annexure VIII) -- one shared free-text column, labeled
    # differently per module by the frontend rather than two near-duplicate
    # nullable columns for what is, functionally, the same "extra context per
    # row" field.
    detail = Column(String(255))
    is_mandatory = Column(Boolean, default=False)
    sort_order = Column(Integer, default=0)
    # Soft-disable rather than hard delete -- keeps this row's history (and
    # any audit trail that might reference its text) intact, and makes
    # "oops, put that back" a one-click toggle instead of re-typing it.
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)


# ---------------------------------------------------------------------------
# Module 6: False Positive / Suppression Management
# ---------------------------------------------------------------------------
class SuppressionRequest(Base):
    __tablename__ = "qap_suppression_requests"
    id = pk_column()
    suppression_id = Column(String(40), unique=True, default=gen_id_default(BUSINESS_ID_PREFIXES["SUPPRESSION"]))
    application_name = Column(String(150), nullable=False)
    scan_type = Column(String(16))     # SAST / DAST
    # Auto-populated (at creation time, from whichever SAST/DAST request the
    # "Request ID" autosuggest field resolved to) rather than retyped --
    # blank when that scan has no linked QA Request (standalone scan).
    # Perf tuning (2026-08) -- indexed via an explicit short-named Index()
    # in the "Performance optimization indexes" block near the end of this
    # file (ix_qap_sup_dept), not inline index=True -- this table's own
    # name is long enough that SQLAlchemy's auto-generated
    # `ix_qap_suppression_requests_department` name would exceed Oracle's
    # 30-byte identifier limit (same ORA-00972 concern noted on that block).
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
    sast_request = relationship("SASTRequest", back_populates="suppressions")
    dast_request = relationship("DASTRequest", back_populates="suppressions")

    @property
    def linked_request(self):
        """Whichever of sast_request/dast_request is actually set, matching
        scan_type -- lets the UI show the raw TQA-SAST-NN/TQA-DAST-NN Request ID
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
    # entity_type no longer index=True on its own -- superseded by the
    # composite ix_qap_appract_entity_created below (same leading column,
    # plus entity_id and created_at). entity_id's own single-column index is
    # kept -- see that block's comment for why.
    entity_type = Column(String(32))
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
    # APR-005 "Every decision shall record actor, delegated role, timestamp,
    # previous state, new state and comment." Optional/additive -- every
    # existing caller across this app (QA_REQUEST/SAST_DAST/SUPPRESSION/
    # SIGNOFF/etc.) already records actor/timestamp/comment via the columns
    # above and `decision` already names the transition in practice (e.g.
    # "Approved & Activated"); these two are populated specifically by the
    # 2026-08 "Test Approval Workflow" refactor's TEST_CASE review actions
    # (routers/test_repository.py::_case_workflow_action) to close the
    # literal state-machine traceability requirement for that one entity
    # type, without changing every other module's own call sites. NULL
    # elsewhere is expected, not a data-quality gap. "Delegated role" is
    # deliberately not modeled -- delegation (APR-012) was explicitly
    # descoped for this pass (see ORACLE_MIGRATION_2026-07.md).
    # Assignment/reassignment events also use these audit fields to retain
    # the human-readable prior/new assignee label. A multi-tester label can
    # be far longer than a workflow status (the production ORA-12899 was a
    # 40-character example), so 30 characters is not a safe audit limit.
    # Keep this bounded VARCHAR rather than truncating history; 1,000 chars
    # covers a large comma-separated group while staying within Oracle's
    # standard VARCHAR2 limit.
    previous_state = Column(String(1000), nullable=True)
    new_state = Column(String(1000), nullable=True)

    actor = relationship("User", foreign_keys=[actor_id])
    # The SMTP outbox is attached by relationship (rather than copying
    # `action.id`) while an ApprovalAction is still pending.  Oracle assigns
    # identity values only during the flush, so SQLAlchemy must flush this
    # parent first and then populate EmailNotification.approval_action_id.
    email_notifications = relationship(
        "EmailNotification", back_populates="approval_action", cascade="all, delete-orphan"
    )

    @property
    def actor_name(self):
        return self.actor.full_name if self.actor else None

    @property
    def created_by_name(self):
        return self.created_by.full_name if self.created_by else None


class EmailNotification(Base):
    """Durable SMTP outbox item created from an ApprovalAction transaction."""
    __tablename__ = "qap_email_notifications"
    __table_args__ = (UniqueConstraint("approval_action_id", "recipient_email", name="uq_qap_email_action_recipient"),)
    id = pk_column()
    approval_action_id = Column(Integer, ForeignKey("qap_approval_actions.id"), nullable=False)
    recipient_email = Column(String(320), nullable=False)
    subject = Column(String(255), nullable=False)
    body = Column(Text, nullable=False)
    # HTML alternative for a readable, branded workflow notification. The
    # plain-text body remains the durable fallback for older mail clients.
    html_body = Column(Text, nullable=True)
    status = Column(String(16), nullable=False, default="PENDING")
    attempts = Column(Integer, nullable=False, default=0)
    next_attempt_at = Column(DateTime, nullable=True)
    last_attempt_at = Column(DateTime, nullable=True)
    sent_at = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=now, nullable=False)

    approval_action = relationship("ApprovalAction", back_populates="email_notifications")


class AssignmentHistory(Base):
    """Normalized assignment tenure for every governed assignee change.

    Current assignee columns remain the fast operational lookup.  This table
    preserves who held a role, when the tenure began/ended, who performed
    each change, and the associated reasons.  One entity can have several
    simultaneous active rows (for example Functional QA testers), while
    single-assignee roles naturally have one active row.
    """
    __tablename__ = "qap_assignment_history"
    id = pk_column()
    entity_type = Column(String(32), nullable=False)
    entity_id = Column(Integer, nullable=False)
    assignment_role = Column(String(40), nullable=False)
    assignee_id = Column(Integer, ForeignKey("qap_users.id"), nullable=False)
    assigned_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    assigned_at = Column(DateTime, default=now, nullable=False)
    assignment_reason = Column(Text, nullable=True)
    unassigned_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    unassigned_at = Column(DateTime, nullable=True)
    unassignment_reason = Column(Text, nullable=True)

    assignee = relationship("User", foreign_keys=[assignee_id])
    assigned_by = relationship("User", foreign_keys=[assigned_by_id])
    unassigned_by = relationship("User", foreign_keys=[unassigned_by_id])

    @property
    def assignee_name(self):
        return self.assignee.full_name if self.assignee else None

    @property
    def assigned_by_name(self):
        return self.assigned_by.full_name if self.assigned_by else None

    @property
    def unassigned_by_name(self):
        return self.unassigned_by.full_name if self.unassigned_by else None

    __table_args__ = (
        CheckConstraint(
            "unassigned_at IS NULL OR unassigned_at >= assigned_at",
            name="ck_qap_asgh_time_order",
        ),
    )


class AuditLog(Base):
    """Immutable, security-focused application audit trail.

    ApprovalAction records business workflow decisions.  This table is wider:
    it records authentication, API access, data mutations and access-control
    changes.  No update/delete API is intentionally provided for these rows.
    Request/response bodies are never stored, preventing passwords, tokens and
    uploaded content from leaking into the audit trail.
    """
    __tablename__ = "qap_audit_logs"
    id = pk_column()
    event_type = Column(String(40), nullable=False, index=True)
    action = Column(String(80), nullable=False, index=True)
    outcome = Column(String(20), nullable=False, index=True)
    # No longer index=True on its own -- superseded by the composite
    # ix_qap_audit_actor_created below (same leading column, plus created_at).
    actor_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    actor_username = Column(String(150), nullable=True, index=True)
    actor_name = Column(String(150), nullable=True)
    actor_roles = Column(String(500), nullable=True)
    method = Column(String(10), nullable=True)
    path = Column(String(500), nullable=True, index=True)
    status_code = Column(Integer, nullable=True)
    target_type = Column(String(64), nullable=True)
    target_id = Column(String(100), nullable=True)
    target_name = Column(String(255), nullable=True)
    details = Column(Text, nullable=True)
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(500), nullable=True)
    request_id = Column(String(64), nullable=True, index=True)
    created_at = Column(DateTime, nullable=False, default=now, index=True)

    actor = relationship("User", foreign_keys=[actor_id])


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
    SUPPRESSION / SIGNOFF / COMMENT_IMAGE / TEST_EXEC_IMAGE), so
    (module, request_id) is always unambiguous.
    Files are stored on disk under backend/app/uploads/<request's own
    request_id string>/<module>/<filename> -- see UPLOAD_ROOT in documents.py."""
    __tablename__ = "qap_module_documents"
    id = pk_column()
    # module no longer index=True on its own -- superseded by the composite
    # ix_qap_moddocs_req_uploaded below (same leading column, plus
    # request_id and uploaded_at). request_id's own single-column index is
    # kept -- see that block's comment for why.
    module = Column(String(20), nullable=False)
    request_id = Column(Integer, nullable=False, index=True)
    file_name = Column(String(255), nullable=False)
    stored_path = Column(String(500), nullable=False)   # relative to UPLOAD_ROOT
    content_type = Column(String(150))
    file_size = Column(Integer)
    uploaded_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    uploaded_at = Column(DateTime, default=now)


# ---------------------------------------------------------------------------
# Module 8: QA Clearance Management
# ---------------------------------------------------------------------------
class QASignOff(Base):
    __tablename__ = "qap_signoffs"
    id = pk_column()
    certificate_id = Column(String(40), unique=True, default=gen_id_default(BUSINESS_ID_PREFIXES["SIGNOFF"]))
    certificate_date = Column(Date, default=today_ist)
    certificate_type = Column(String(32))
    testing_type = Column(String(16))
    # Perf tuning (2026-08) -- indexed via explicit short-named Index()
    # (ix_qap_signoff_testreq) near the end of this file, not inline
    # index=True -- see SuppressionRequest.department's own comment for why
    # (this table's name plus column name would also exceed the 30-byte
    # limit as an auto-generated name). source_functional_request's own
    # primaryjoin below and list_signoffs' department-scope join both match
    # on this column against FunctionalRequest.request_id (already
    # unique-indexed via its own unique=True).
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

    # COE - Quality Assurance Engineer raises the certificate -> COE - Quality Assurance Lead approves it ->
    # Executive  gives the final approval that issues it -- see
    # constants.SIGNOFF_STATUSES. Replaces the old, much simpler Draft/Issued
    # flow (a QA Lead alone could draft and immediately sign/issue); existing
    # rows at the old "Draft"/"Issued" string values need a one-time data
    # migration, see ORACLE_MIGRATION_2026-07.md.
    status = Column(String(32), default="DRAFT")
    requester_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)   # Requested By (QA Team)
    reviewed_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)  # Approved By (QA Lead)
    approved_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)  # Approved By (Executive )
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

    # Business/request department used for cross-department visibility and
    # filtering. `department` above remains the QA approval owner (COE - Quality Assurance),
    # while this view-only relationship resolves the Functional Request whose
    # business ID was recorded in testing_request_id.
    source_functional_request = relationship(
        "FunctionalRequest",
        primaryjoin=lambda: QASignOff.testing_request_id == foreign(FunctionalRequest.request_id),
        viewonly=True,
        uselist=False,
    )

    @property
    def request_department(self):
        return self.source_functional_request.department if self.source_functional_request else None

    @property
    def request_id(self):
        """Alias so a QASignOff can be serialized through the same
        LinkedRequestRef shape (id/request_id/status/priority/risk_...)
        already used for the 4 relationship-backed linked-request types --
        QASignOff's own business ID column is certificate_id, not
        request_id. See routers/qa_requests.py list_requests' batched
        linked_signoffs attach, added so a CR-number lookup surfaces every
        request tied to that CR, Sign-off included."""
        return self.certificate_id

    # Two-hop delegation (QASignOff -> source_functional_request ->
    # qa_request.change_description) -- QASignOff has no qa_request_id of
    # its own, only a view-only link to the FunctionalRequest it was raised
    # from, so it has to go through that request's own delegated property.
    @property
    def change_description(self):
        if not self.source_functional_request:
            return None
        return self.source_functional_request.change_description


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
#
# 2026-08 "Test Management Revamp" (uploaded SRS: "Test Management Revamp --
# Business Requirements and Software Requirements Specification"). Full
# document delivered end-to-end per that spec's own phase breakdown (section
# 14.2): Foundation (immutable versions + pinned cycle items), Governance
# (review workflow + project membership), cycle lifecycle,
# Experience/Reporting (frontend), Hardening (validation,
# concurrency, audit). See test_management_migration.py for the one-time
# migration of every pre-existing row into the new versioned structures. That
# revamp predates the later Alembic adoption; current schema changes must ship
# as reviewed Alembic revisions. Pre-revamp columns that
# are superseded are kept as backward-compatible MIRRORS of the new
# versioned data (exact same pattern already established by
# TestExecution/TestExecutionRun below -- TestExecution's own columns mirror
# only the latest TestExecutionRun so old readers keep working unchanged;
# TestCase's own content columns now work the same way, mirroring whichever
# TestCaseVersion is "current" for that identity).
#
# Core architectural change (SRS section 1, "principal traceability risk"):
# a Test Cycle's execution slot (TestExecution, which already served as the
# de-facto "cycle item" join row -- see its own docstring) used to reference
# TestCase live, so editing/re-approving a testcase after it had been added
# to a cycle silently changed what a historical cycle displayed. Every
# testcase's actual content now lives in immutable TestCaseVersion rows
# (VER-001/VER-006); TestCase itself becomes an identity record pointing at
# whichever version is currently approved and/or in draft
# (current_approved_version_id/current_draft_version_id); and each
# TestExecution now pins the exact TestCaseVersion selected at the moment it
# was added to a cycle (pinned_version_id, CYC-004) -- so a closed cycle's
# reporting is reproducible forever regardless of what happens to the
# testcase afterward.
# ---------------------------------------------------------------------------
class TestProject(Base):
    __tablename__ = "qap_test_projects"
    id = pk_column()
    project_key = Column(String(40), unique=True, default=gen_id_default(BUSINESS_ID_PREFIXES["TEST_PROJECT"]))
    name = Column(String(150), nullable=False)
    application_master_id = Column(Integer, ForeignKey("qap_application_master.id"), nullable=True)
    # Perf tuning (2026-08) -- indexed via explicit short-named Index()
    # (ix_qap_proj_dept) near the end of this file -- see
    # SuppressionRequest.department's own comment for why not inline
    # index=True.
    department = Column(String(150))
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    # SRS PRJ-001 "owner" -- the one person routers/test_projects.py treats
    # as authorized to add/remove members (PRJ-005) without needing the
    # app-wide QA_LEAD role; QA_LEAD/Admin always bypass this check too, same
    # pattern as every other owner-vs-role gate in this router. Nullable so
    # a project can never fail to save if this is momentarily unset;
    # test_management_migration.py backfills it from created_by_id for
    # every pre-revamp project on first startup after this column exists.
    owner_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    # Reported directly: "Project Activation, deactivation should need
    # approval from QA lead." pending_is_active is the *requested* new value
    # while it awaits QA Lead sign-off -- None means no request is pending.
    # Set by update_test_project when a QA Engineer (not QA Lead/Admin, who
    # both apply immediately -- see the same router) asks to activate or
    # deactivate; cleared by routers/test_projects.py::review_project_activation
    # (approve applies it to is_active, reject just discards it) or by a
    # QA Lead/Admin's own direct toggle superseding it.
    pending_is_active = Column(Boolean, nullable=True)
    pending_requested_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    pending_requested_at = Column(DateTime, nullable=True)
    # SRS PRJ-003 "Projects shall support Active, Inactive and Archived
    # states. Inactive and Archived projects shall reject new authoring and
    # execution." -- Archived is deliberately layered on top of the existing
    # is_active boolean rather than replacing it with a 3-way enum column
    # (additive-only constraint for this revamp): archiving always also
    # forces is_active False in the same action (see routers/
    # test_projects.py::archive_test_project), so every existing
    # `if not project.is_active` authoring/execution gate throughout the
    # codebase already rejects an Archived project with zero further
    # changes. is_archived is the one extra bit that distinguishes "plainly
    # Inactive, can be reactivated any time" from "Archived, a more
    # deliberate retirement" for the UI and for reporting.
    is_archived = Column(Boolean, default=False)
    archived_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    archived_at = Column(DateTime, nullable=True)
    archived_reason = Column(Text, nullable=True)
    # APR-001, 2026-08 "Test Approval Workflow" refactor -- project-level
    # default Author/Reviewer/QA Lead assignment. Author isn't stored here
    # since it's inherently per-version (TestCaseVersion.author_id, whoever
    # created/last materially edited it); these two are the ones a project
    # needs a *default person* for, copied onto each TestCaseVersion at
    # submission time and reassignable per item afterward -- see
    # TestCaseVersion.assigned_reviewer_id/assigned_qa_lead_id.
    default_reviewer_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    default_qa_lead_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)

    application_master = relationship("ApplicationMaster", foreign_keys=[application_master_id])
    owner = relationship("User", foreign_keys=[owner_id])
    created_by = relationship("User", foreign_keys=[created_by_id])
    pending_requested_by = relationship("User", foreign_keys=[pending_requested_by_id])
    archived_by = relationship("User", foreign_keys=[archived_by_id])
    default_reviewer = relationship("User", foreign_keys=[default_reviewer_id])
    default_qa_lead = relationship("User", foreign_keys=[default_qa_lead_id])
    folders = relationship("TestFolder", back_populates="project", cascade="all,delete-orphan")
    test_cases = relationship("TestCase", back_populates="project", cascade="all,delete-orphan")
    cycles = relationship("TestCycle", back_populates="project", cascade="all,delete-orphan")
    cycle_folders = relationship("TestCycleFolder", back_populates="project", cascade="all,delete-orphan")
    members = relationship("TestProjectMember", back_populates="project", cascade="all,delete-orphan")
    view_grants = relationship("TestProjectViewGrant", back_populates="project", cascade="all,delete-orphan")

    @property
    def owner_name(self):
        return self.owner.full_name if self.owner else None

    @property
    def pending_requested_by_name(self):
        return self.pending_requested_by.full_name if self.pending_requested_by else None

    @property
    def archived_by_name(self):
        return self.archived_by.full_name if self.archived_by else None

    @property
    def default_reviewer_name(self):
        return self.default_reviewer.full_name if self.default_reviewer else None

    @property
    def default_qa_lead_name(self):
        return self.default_qa_lead.full_name if self.default_qa_lead else None


class TestProjectMember(Base):
    """SRS PRJ-005/GOV-001 -- project-scoped membership, deliberately
    separate from the app-wide Role enum: a project owner can add a member
    with a project-level role (see constants.TEST_PROJECT_ROLES) without
    granting that person any broader system role. Repository/cycle/report
    access is meant to be constrained by this membership (plus the existing
    department scope every other module already enforces), not just by
    holding QA_ENGINEER/QA_LEAD generally -- see routers/test_projects.py's
    own membership endpoints for how this is enforced."""
    __tablename__ = "qap_test_project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_qap_tpm_project_user"),)
    id = pk_column()
    project_id = Column(Integer, ForeignKey("qap_test_projects.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("qap_users.id"), nullable=False, index=True)
    project_role = Column(String(30), nullable=False, default="Tester")
    added_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    added_at = Column(DateTime, default=now)

    project = relationship("TestProject", back_populates="members")
    user = relationship("User", foreign_keys=[user_id])
    added_by = relationship("User", foreign_keys=[added_by_id])

    @property
    def user_name(self):
        return self.user.full_name if self.user else None

    @property
    def user_email(self):
        return self.user.username if self.user else None

    @property
    def added_by_name(self):
        return self.added_by.full_name if self.added_by else None


class TestProjectViewGrant(Base):
    """2026-08 -- reported directly: "one logged in user can [only] show
    projects which are under that user department only. now add one
    functionality to add view only access to department as well as
    particular user ... it will help if any project cross departmental."
    Grants read-only visibility into ONE specific Test Project (its Test
    Execution/Repository/Reports, plus -- per the same requirement's
    follow-up decision -- its linked Defects) to a department or user who
    isn't otherwise in scope for it via TestProject.department. Deliberately
    per-project, not a blanket department-to-department grant, matching "if
    ANY PROJECT is cross departmental" -- most projects never need this;
    it's an exception for the specific ones that do.

    Exactly one of `department`/`user_id` is set per row (enforced in
    routers/test_projects.py, not at the DB level -- same
    application-layer-only convention as this app's other "must be exactly
    one of" rules, e.g. auth.py's department/departments payload
    resolution). A department grant covers every current AND future member
    of that department (checked live against User.departments at read time,
    same as every other department-scoped check in this app); a user grant
    covers that one account regardless of their own department(s).

    This is READ-ONLY by design -- it only ever widens which projects a
    scoped user's LIST/aggregate queries include (see
    deps.py::viewable_project_ids), never any create/edit/execute
    permission, all of which stay gated by this app's existing role-based
    checks (QA_ENGINEER/QA_LEAD/etc.) exactly as before. A grant recipient
    who happens to also hold one of those roles is not, by virtue of this
    grant alone, able to mutate the granted project -- same as how holding
    those roles alone was never sufficient without also being in-department
    prior to this feature."""
    __tablename__ = "qap_test_project_view_grants"
    # Same Oracle NULL-handling fix as TestCycleFolderAccess above (see that
    # model's docstring for the full explanation) -- this table has carried
    # the identical latent bug since the initial schema baseline: a second
    # department-only or user-only grant on the same project would raise
    # ORA-00001 the same way. Fixed alongside the reported TestCycleFolder
    # incident rather than left for whoever hits it here next. See
    # ORACLE_MIGRATION_2026-07.md section 155 and alembic revision
    # 9b1f4d7c2a63.
    __table_args__ = (
        Index("uq_qap_tpvg_project_department",
              text("(CASE WHEN department IS NOT NULL THEN project_id END)"), "department", unique=True),
        Index("uq_qap_tpvg_project_user",
              text("(CASE WHEN user_id IS NOT NULL THEN project_id END)"), "user_id", unique=True),
    )
    id = pk_column()
    project_id = Column(Integer, ForeignKey("qap_test_projects.id"), nullable=False, index=True)
    department = Column(String(150), nullable=True)
    user_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True, index=True)
    granted_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)

    project = relationship("TestProject", foreign_keys=[project_id])
    user = relationship("User", foreign_keys=[user_id])
    granted_by = relationship("User", foreign_keys=[granted_by_id])

    @property
    def user_name(self):
        return self.user.full_name if self.user else None

    @property
    def granted_by_name(self):
        return self.granted_by.full_name if self.granted_by else None


class TestFolder(Base):
    """Hierarchical folder tree within one Project's Test Repository --
    self-referential parent_id for nesting (e.g. 'Regression' > 'Login').
    A test case may sit directly under the Project with no folder at all
    (folder_id NULL on TestCase) -- folders are an organizing convenience,
    not mandatory."""
    __tablename__ = "qap_test_folders"
    id = pk_column()
    # Perf tuning (2026-08) -- indexed; every Test Repository folder-tree
    # query (list_folders and friends in test_repository.py) filters by
    # project_id first. TestCase.project_id already has its own composite
    # coverage (see the IDX-001..007 block near the end of this file) but
    # TestFolder never got the equivalent.
    project_id = Column(Integer, ForeignKey("qap_test_projects.id"), nullable=False, index=True)
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
    """A single reusable test case's *permanent identity* in the Test
    Repository (SRS TC-001) -- project-scoped, independent of any one
    version. Columns mirror the fixed xlsx upload template plus CR
    traceability (Test Case ID, Epic ID, CR Number, Feature ID, User Story
    ID, Test Type, Module Name, Test Scenario, Pre-Condition, Test Case
    Description, Priority) -- see routers/test_repository.py's
    import_test_cases for the parser.

    2026-08 revamp: actual definition content, steps, and review status now
    live in immutable TestCaseVersion/TestCaseVersionStep rows below (SRS
    VER-001) -- this class's own content columns
    (epic_id/cr_number/.../priority/status/version_major/version_minor) are
    now a MIRROR of whichever version is "current" for display/list-view
    backward compatibility, exactly the same pattern TestExecution already
    uses to mirror its latest TestExecutionRun. "Current" means: the draft
    version if one exists (current_draft_version_id), else the approved
    version (current_approved_version_id) -- see
    routers/test_repository.py's _sync_case_mirror for exactly when/how this
    mirror is refreshed. Folder placement and tags stay at this identity
    level (not per-version) -- SRS section 16 "Tag versioning" leaves this
    an open decision; identity-level was chosen here since a testcase
    doesn't usually need different tags/folder per revision, and it avoids
    every version-approval also having to re-decide where the case lives.
    Steps in the legacy TestStep table below are no longer written to by
    new code (kept only so any pre-revamp row that was never migrated still
    has somewhere to read from) -- see TestCaseVersionStep for the real,
    version-scoped steps used by everything going forward."""
    __tablename__ = "qap_test_cases"
    id = pk_column()
    test_case_key = Column(String(60), unique=True, nullable=False)
    project_id = Column(Integer, ForeignKey("qap_test_projects.id"), nullable=False)
    folder_id = Column(Integer, ForeignKey("qap_test_folders.id"), nullable=True)
    epic_id = Column(String(60))
    cr_number = Column(String(64))
    feature_id = Column(String(60))
    user_story_id = Column(String(60))
    test_type = Column(String(60))
    module_name = Column(String(150))
    test_scenario = Column(String(255))
    pre_condition = Column(Text)
    description = Column(Text)
    priority = Column(String(16))
    # Mirror of the current version's own status -- see constants.
    # TEST_CASE_STATUSES (Draft/In Review/Review Completed/Returned/
    # Approved/Rejected/Archived, 2026-08 "Test Approval Workflow" refactor,
    # plus TEST_CASE_NEW_STATUSES -- Recommendation Pending/QA Lead Approval
    # Pending/Returned by QA/Returned by QA Lead -- added by the 2026-08
    # "Simplified Test Management Review and Approval" requirement). The
    # API, not a client edit form, controls transitions -- see
    # routers/test_repository.py's review workflow. "QA Lead Approval
    # Pending" is the longest value at 24 chars -- ORA-12899 (String(20) was
    # too narrow for it, hit in production; String(30) leaves headroom for
    # future values). Widening an EXISTING Oracle column needs a manual
    # ALTER TABLE -- create_all() never alters existing columns -- see
    # scripts/2026-08_widen_test_case_status_columns.sql.
    status = Column(String(30), default="Draft")
    # Mirror of the current version's own version_major/version_minor.
    # Major represents a materially changed intent, minor a compatible
    # refinement (SRS VER-004); both live authoritatively on
    # TestCaseVersion now -- see that class's own docstring for the
    # increment policy.
    version_major = Column(Integer, nullable=False, default=1)
    version_minor = Column(Integer, nullable=False, default=0)
    # SRS VER-002 "identify one current approved version while allowing a
    # separate draft revision" -- at most one of each may be set at a time;
    # both may be set together (an approved baseline with a newer draft
    # revision in progress), or only current_draft_version_id (brand new
    # testcase, never yet approved), or only current_approved_version_id (no
    # revision currently in progress). post_update=True on both breaks the
    # circular INSERT dependency with TestCaseVersion.test_case_id below (a
    # version can't be inserted until its TestCase exists, but TestCase's
    # pointer to that version is only known after the version is inserted).
    # Intentional cycle: versions belong to a testcase, while the testcase
    # keeps pointers to its current draft/approved versions. Defer these two
    # pointer constraints until both tables exist; TestCaseVersion.test_case_id
    # remains the normal inline parent FK.
    current_approved_version_id = Column(Integer, ForeignKey(
        "qap_test_case_versions.id", name="fk_qap_tc_current_approved", use_alter=True,
    ), nullable=True)
    current_draft_version_id = Column(Integer, ForeignKey(
        "qap_test_case_versions.id", name="fk_qap_tc_current_draft", use_alter=True,
    ), nullable=True)
    created_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)
    # Explicit, SharePoint-style checkout lock. Reported directly: "check in
    # checkout option should be available for testcases, otherwise multiple
    # people can edit at once, if checkout, the testcase is locked for
    # editing by that user." Set/cleared only via routers/test_repository.py
    # ::checkout_test_case / checkin_test_case; update_test_case,
    # delete_test_case, bulk_update_test_cases, and bulk_delete_test_cases
    # all refuse to touch a case someone else holds the checkout on (see
    # _enforce_checkout_lock -- Admin always bypasses). Review/approval is a
    # separate QA Lead workflow step, not an author edit, so it is
    # deliberately NOT gated by this lock.
    checked_out_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    checked_out_at = Column(DateTime, nullable=True)
    # 2026-08 "Recycle Bin" requirement -- delete_test_case/
    # bulk_delete_test_cases (governed cases -- ever Approved/Archived/
    # Rejected -- were already, and remain, permanently blocked from this
    # entirely; only a still-pre-approval case can ever reach here) now soft-
    # delete instead of a real `db.delete()`: this flag set True, the row
    # otherwise untouched and excluded from every normal list/summary query,
    # recoverable via restore_test_case_from_recycle_bin until an authorized
    # QA Lead Group member permanently purges it (purge_test_case/
    # bulk_purge_test_cases -- the only code path that still issues a real
    # `db.delete()`). New columns on an EXISTING production table --
    # `create_all()` never alters existing columns, so this requires the
    # companion manual `ALTER TABLE`, see
    # scripts/2026-08_add_test_case_recycle_bin_columns.sql.
    is_deleted = Column(Boolean, default=False, nullable=False)
    deleted_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    deleted_at = Column(DateTime, nullable=True)
    deleted_reason = Column(String(1000), nullable=True)
    tag_rows = relationship("TestCaseTag", back_populates="test_case", cascade="all,delete-orphan")

    @property
    def tags(self):
        return [row.tag for row in self.tag_rows]

    # PAG-005 -- the list endpoint serializes TestCaseListOut, which carries
    # this count instead of the full `steps` array (each step's text/
    # expected_result is only ever needed once a case is actually opened).
    # `self.steps` (the legacy TestStep mirror, kept in sync with the
    # current version's real TestCaseVersionStep rows by every write path --
    # see routers/test_repository.py's _replace_draft_steps and friends) is
    # already what TestCaseOut.steps itself reads, so this stays consistent
    # with whatever count the full detail view would show.
    @property
    def steps_count(self):
        return len(self.steps)

    project = relationship("TestProject", back_populates="test_cases")
    folder = relationship("TestFolder")
    created_by = relationship("User", foreign_keys=[created_by_id])
    checked_out_by = relationship("User", foreign_keys=[checked_out_by_id])
    deleted_by = relationship("User", foreign_keys=[deleted_by_id])
    steps = relationship("TestStep", back_populates="test_case", cascade="all,delete-orphan",
                         order_by="TestStep.step_no")
    executions = relationship("TestExecution", back_populates="test_case", cascade="all,delete-orphan")
    versions = relationship("TestCaseVersion", back_populates="test_case", cascade="all,delete-orphan",
                             foreign_keys="TestCaseVersion.test_case_id", order_by="TestCaseVersion.id")
    current_approved_version = relationship("TestCaseVersion", foreign_keys=[current_approved_version_id],
                                             post_update=True)
    current_draft_version = relationship("TestCaseVersion", foreign_keys=[current_draft_version_id],
                                          post_update=True)

    @property
    def folder_name(self):
        return self.folder.name if self.folder else None

    @property
    def created_by_name(self):
        return self.created_by.full_name if self.created_by else None

    @property
    def checked_out_by_name(self):
        return self.checked_out_by.full_name if self.checked_out_by else None

    @property
    def deleted_by_name(self):
        return self.deleted_by.full_name if self.deleted_by else None

    @property
    def current_draft_author_id(self):
        """Author of the version currently moving through review.

        Exposed on TestCaseOut so the UI can suppress maker-checker actions
        for the author before the backend's GOV-002 check is reached.
        """
        return self.current_draft_version.author_id if self.current_draft_version else None

    # 2026-08 "Simplified Test Management" GOV-002 gap fix -- the author
    # isn't the only person a NEW-path stage can block from acting again:
    # whoever SUBMITTED the draft (draft.submitted_by_id, which may be a
    # different QA_ENGINEER than the content's author -- authoring/checkout
    # is a broad team-tier permission, not locked to one person) is blocked
    # from recording that same draft's Stage 1 decision, and whoever
    # recorded Stage 1 (draft.reviewed_by_id) is blocked from also recording
    # Stage 2. Exposed here, same reasoning as current_draft_author_id
    # above, so the UI can suppress the button before the backend's own
    # (authoritative) check in review_test_case/bulk_recommend_test_cases/
    # bulk_approve_test_cases is reached.
    @property
    def current_draft_submitted_by_id(self):
        return self.current_draft_version.submitted_by_id if self.current_draft_version else None

    @property
    def current_draft_reviewed_by_id(self):
        return self.current_draft_version.reviewed_by_id if self.current_draft_version else None

    # Reported directly: "Pending with author, give details who have
    # uploaded" -- pending_with_user_name is intentionally None for a
    # never-submitted Draft (nothing is actually pending review yet, see
    # that property's own docstring above), so the Workflow column's
    # fallback previously showed the bare, name-less word "Author" with no
    # way to tell WHICH author still needs to submit it. Exposed here so the
    # UI can show the real name in that one fallback case specifically.
    @property
    def current_draft_author_name(self):
        return self.current_draft_version.author_name if self.current_draft_version else None

    # Reported directly, alongside the "Pending with" author-name fix above:
    # "along with Pending with details, show submitted by as well" -- the
    # Workflow column previously only ever showed WHO the item is pending
    # WITH (a group, or an author on Returned), never WHO submitted it into
    # its current pending state. Exposed here the same way as
    # current_draft_author_name so the frontend doesn't need a second
    # round-trip.
    @property
    def current_draft_submitted_by_name(self):
        return self.current_draft_version.submitted_by_name if self.current_draft_version else None

    # Reported directly: "Add Recommended By once recommended" -- once a
    # NEW-path draft clears Stage 1 (status moves to "QA Lead Approval
    # Pending"), draft.reviewed_by_id records who made that recommend
    # decision (see review_test_case/bulk_recommend_test_cases, which both
    # set it). Exposed the same way as current_draft_submitted_by_name so
    # the Workflow column can show "Recommended by" alongside "Submitted
    # by" without a second round-trip. None before Stage 1 has actually
    # been decided (nothing to attribute yet) -- same "only show once it's
    # true" shape as submitted_by_name for a never-submitted Draft.
    @property
    def current_draft_reviewed_by_name(self):
        return self.current_draft_version.reviewed_by_name if self.current_draft_version else None

    @property
    def version(self):
        return f"{self.version_major}.{self.version_minor}"

    # APR-006 "The current assignee, pending action and elapsed time shall
    # be visible on the test-case details page." Bridges through whichever
    # version is current for display -- see TestCaseVersion.
    # pending_with_user_id/name for the actual per-stage logic. None once
    # there's no draft in progress (Approved with nothing pending, or a
    # brand-new case that's still an un-submitted Draft with only an author
    # pending, not yet routed to anyone).
    @property
    def pending_with_user_id(self):
        return self.current_draft_version.pending_with_user_id if self.current_draft_version else None

    @property
    def pending_with_user_name(self):
        return self.current_draft_version.pending_with_user_name if self.current_draft_version else None

    @property
    def pending_since(self):
        """Elapsed-time basis for APR-006 -- whichever timestamp started the
        CURRENT pending stage: submitted_at while In Review, reviewed_at
        (the Reviewer's recommend timestamp) while Review Completed, and
        reviewed_at/qa_lead_decided_at (whichever is set) while Returned."""
        draft = self.current_draft_version
        if not draft:
            return None
        if draft.status == "In Review":
            return draft.submitted_at
        if draft.status == "Review Completed":
            return draft.reviewed_at
        if draft.status == "Returned":
            return draft.qa_lead_decided_at or draft.reviewed_at
        return None


class TestCaseTag(Base):
    """Reusable labels attached to test cases for repository filtering."""
    __tablename__ = "qap_test_case_tags"
    __table_args__ = (UniqueConstraint("test_case_id", "tag", name="uq_qap_test_case_tag"),)
    id = pk_column()
    test_case_id = Column(Integer, ForeignKey("qap_test_cases.id"), nullable=False, index=True)
    tag = Column(String(80), nullable=False, index=True)
    test_case = relationship("TestCase", back_populates="tag_rows")


class TestStep(Base):
    """Legacy, pre-revamp step storage -- kept only for backward
    compatibility (see TestCase's own docstring). No code path written
    after the 2026-08 revamp writes to this table; new/edited testcases use
    TestCaseVersionStep below instead, scoped to an immutable version rather
    than the mutable identity."""
    __tablename__ = "qap_test_steps"
    id = pk_column()
    test_case_id = Column(Integer, ForeignKey("qap_test_cases.id"), nullable=False)
    step_no = Column(Integer, nullable=False)
    step_text = Column(Text)
    expected_result = Column(Text)

    test_case = relationship("TestCase", back_populates="steps")


class TestCaseVersion(Base):
    """SRS VER-001..006 -- an immutable snapshot of one TestCase's full
    definition at one version number. Created the moment a draft is first
    saved (status Draft) and NEVER modified in place again once it has ever
    been submitted for review -- editing after that point (VER-003) always
    creates a brand-new TestCaseVersion row rather than touching this one,
    which is exactly what makes historical cycle reporting reproducible
    (AC-01/AC-02): a TestExecution's pinned_version_id always points at one
    specific, permanently-frozen row here, so nothing that happens to the
    testcase afterward can retroactively change what an already-pinned
    cycle item displays.

    Numbering (VER-004): version_major stays fixed unless a QA Lead
    explicitly elects a major bump with justification (materially changed
    intent); version_minor auto-increments by default (compatible
    refinement). See routers/test_repository.py's _next_version_numbers for
    the exact policy, and review_comments/submit_note for where the
    justification is recorded.

    Review lifecycle, 2026-08 "Test Approval Workflow" refactor (Test_
    Approval_Workflow_Requirements.docx sections 3/6) -- a strict two-stage
    chain, Author -> Reviewer -> QA Lead:
      Draft -> In Review (Author submits) -> Review Completed (Reviewer
      recommends) -> Approved (QA Lead approves & activates) -> a later edit
      spins off a NEW Draft version while this one remains the approved
      baseline (TestCase.current_approved_version_id keeps pointing here)
      until the new draft is itself approved.
      Correction path: In Review (Reviewer) or Review Completed (QA Lead)
      -> Returned (mandatory comment at either stage) -> Draft-like editing
      -> In Review again.
      Termination path: Review Completed -> Rejected (QA Lead only,
      mandatory comment) -- terminal; cannot be executed, added to a cycle,
      or edited in place. routers/test_repository.py::update_test_case
      spins a fresh Draft off a Rejected version's content instead (same
      mechanic as editing an Approved baseline) -- the Rejected version
      itself stays frozen/immutable in history for traceability, same as
      Approved/Archived.
      Archived is a terminal state reachable from Approved (case-level
      archive, applied to whichever version was the approved baseline at
      that time) -- unrelated to Rejected, which is reachable only from
      Review Completed and never from Approved.
    reviewed_by_id/reviewed_at/review_comments below record the REVIEWER's
    stage-1 decision (recommend or return); qa_lead_decided_by_id/
    qa_lead_decided_at/qa_lead_decision_comments record the QA LEAD's
    stage-2 decision (approve, return, or reject) -- kept as separate field
    triples so both stages' last-known outcome stay independently visible
    without one overwriting the other (the full turn-by-turn history is the
    separately append-only ApprovalAction table; these are convenience
    summary fields for APR-006's "current assignee, pending action, elapsed
    time" display)."""
    __tablename__ = "qap_test_case_versions"
    __table_args__ = (UniqueConstraint("test_case_id", "version_major", "version_minor",
                                        name="uq_qap_tcv_case_version"),)
    id = pk_column()
    test_case_id = Column(Integer, ForeignKey("qap_test_cases.id"), nullable=False, index=True)
    version_major = Column(Integer, nullable=False, default=1)
    version_minor = Column(Integer, nullable=False, default=0)
    # See TestCase.status above for the full status vocabulary and the
    # ORA-12899/String(30) note -- this is the authoritative copy; TestCase's
    # own status is just a mirror of whichever version is current.
    status = Column(String(30), nullable=False, default="Draft")
    # Immutable content snapshot -- see TestCase's own former column
    # docstrings for what each of these means; identical shape, just scoped
    # to one frozen version instead of the mutable identity.
    epic_id = Column(String(60))
    cr_number = Column(String(64))
    feature_id = Column(String(60))
    user_story_id = Column(String(60))
    test_type = Column(String(60))
    module_name = Column(String(150))
    test_scenario = Column(String(255))
    pre_condition = Column(Text)
    description = Column(Text)
    priority = Column(String(16))
    author_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    # REV-001: submission releases checkout and records author/timestamp/
    # optional note.
    submitted_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    submitted_at = Column(DateTime, nullable=True)
    submit_note = Column(Text, nullable=True)
    # REV-002 -- the REVIEWER's stage-1 decision (recommend or return).
    reviewed_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    reviewed_at = Column(DateTime, nullable=True)
    review_comments = Column(Text, nullable=True)
    # REV-003 -- the QA LEAD's stage-2 final decision (approve & activate,
    # return, or reject). Separate from reviewed_* above so a version that
    # passed through both stages keeps both outcomes independently visible.
    qa_lead_decided_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    qa_lead_decided_at = Column(DateTime, nullable=True)
    qa_lead_decision_comments = Column(Text, nullable=True)
    # APR-001 -- project-level default Reviewer/QA Lead (TestProject.
    # default_reviewer_id/default_qa_lead_id) copied here at submission
    # time, with optional per-item reassignment afterward (see
    # routers/test_repository.py::reassign_test_case_approvers). Drives
    # APR-006's "current assignee" and APR-007's personal Pending Approval
    # filtering and identifies the user who owns each stage decision.
    # Project-role authorization remains a prerequisite, while the selected
    # assignee is the stage-specific decision maker (Admin retains oversight).
    assigned_reviewer_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    assigned_qa_lead_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    # TC-005 "record the source testcase/version" on clone, and reused for
    # VER-005 version-compare's own ancestry display.
    source_version_id = Column(Integer, ForeignKey("qap_test_case_versions.id"), nullable=True)

    test_case = relationship("TestCase", back_populates="versions", foreign_keys=[test_case_id])
    author = relationship("User", foreign_keys=[author_id])
    submitted_by = relationship("User", foreign_keys=[submitted_by_id])
    reviewed_by = relationship("User", foreign_keys=[reviewed_by_id])
    qa_lead_decided_by = relationship("User", foreign_keys=[qa_lead_decided_by_id])
    assigned_reviewer = relationship("User", foreign_keys=[assigned_reviewer_id])
    assigned_qa_lead = relationship("User", foreign_keys=[assigned_qa_lead_id])
    source_version = relationship("TestCaseVersion", remote_side=[id], foreign_keys=[source_version_id])
    steps = relationship("TestCaseVersionStep", back_populates="version", cascade="all,delete-orphan",
                          order_by="TestCaseVersionStep.step_no")

    @property
    def version(self):
        return f"{self.version_major}.{self.version_minor}"

    @property
    def author_name(self):
        return self.author.full_name if self.author else None

    @property
    def submitted_by_name(self):
        return self.submitted_by.full_name if self.submitted_by else None

    @property
    def reviewed_by_name(self):
        return self.reviewed_by.full_name if self.reviewed_by else None

    @property
    def qa_lead_decided_by_name(self):
        return self.qa_lead_decided_by.full_name if self.qa_lead_decided_by else None

    @property
    def assigned_reviewer_name(self):
        return self.assigned_reviewer.full_name if self.assigned_reviewer else None

    @property
    def assigned_qa_lead_name(self):
        return self.assigned_qa_lead.full_name if self.assigned_qa_lead else None

    # APR-006 "current assignee" -- whichever role's action is currently
    # pending, per this version's own status. None once terminal
    # (Approved/Rejected/Archived) or while still an unsubmitted Draft.
    # 2026-08 "Simplified Test Management Review and Approval" requirement --
    # extended to the 4 NEW-path statuses (constants.TEST_CASE_NEW_STATUSES):
    # "Recommendation Pending"/"QA Lead Approval Pending" have no individual
    # assignee (group routing is authoritative), so pending_with_user_id
    # stays None for those -- the frontend falls back to
    # constants.ts::TEST_CASE_PENDING_WITH's group label, rendered as a
    # clickable RoleGroupLink (QA Group/QA Lead Group) rather than a plain
    # string, same UX as pending_with_user_id being a real person elsewhere.
    # "Returned by QA"/"Returned by QA Lead" DO have a real pending person
    # (the author, same as OLD "Returned") -- reported directly: "Pending
    # with author, give details who have uploaded" was previously blank for
    # these two NEW-path Returned statuses (only literal OLD "Returned" was
    # handled), which fell back to the generic unclickable "Author" label
    # with no actual name.
    @property
    def pending_with_user_id(self):
        if self.status == "In Review":
            return self.assigned_reviewer_id
        if self.status == "Review Completed":
            return self.assigned_qa_lead_id
        if self.status in ("Returned", "Returned by QA", "Returned by QA Lead"):
            return self.author_id
        return None

    @property
    def pending_with_user_name(self):
        if self.status == "In Review":
            return "QA Reviewer Group"
        if self.status == "Review Completed":
            return "CM QA / AGM QA"
        if self.status == "Recommendation Pending":
            return "QA Group"
        if self.status == "QA Lead Approval Pending":
            return "QA Lead Group"
        if self.status in ("Returned", "Returned by QA", "Returned by QA Lead"):
            return self.author_name
        return None


class TestCaseVersionStep(Base):
    """Ordered steps for one immutable TestCaseVersion -- see that class's
    own docstring. Replaces TestStep as the real, version-scoped step
    storage going forward."""
    __tablename__ = "qap_test_case_version_steps"
    __table_args__ = (UniqueConstraint("version_id", "step_no", name="uq_qap_tcvs_version_step"),)
    id = pk_column()
    version_id = Column(Integer, ForeignKey("qap_test_case_versions.id"), nullable=False, index=True)
    step_no = Column(Integer, nullable=False)
    step_text = Column(Text)
    expected_result = Column(Text)

    version = relationship("TestCaseVersion", back_populates="steps")


class TestCycleFolder(Base):
    """Flat (non-nested, by design) organizational folder for a Project's
    Test Cycles, plus an OPTIONAL access restriction (see
    TestCycleFolderAccess below). Unlike TestFolder (Test Repository), which
    is purely organizational and always inherits its Project's own access
    rules, a TestCycleFolder with at least one TestCycleFolderAccess row
    becomes visible ONLY to the department(s)/user(s) it names (plus the
    project owner, this folder's own creator, and the QA Lead Group/Admin,
    who bypass every governance gate in this module already) -- everyone
    else who can otherwise execute in this project is excluded, even though
    they could see every OTHER (unrestricted) folder and every Unfiled
    cycle. A folder with zero access rows is unrestricted -- visible to
    anyone who can already execute in the project, same as an Unfiled cycle
    today. Reported directly: "Create Test Cycle Folder, in which I can give
    access department based or user level, same behaviour like project
    has." This is deliberately the OPPOSITE of TestProjectViewGrant (which
    only ever WIDENS a project's visibility, never restricts it) -- see
    deps.py::can_view_cycle_folder for the actual check, and
    ORACLE_MIGRATION_2026-07.md section 147 for the full design decision
    (restrict, not widen; flat, not nested; existing cycles land in an
    Unfiled pseudo-folder rather than a migrated default folder)."""
    __tablename__ = "qap_test_cycle_folders"
    id = pk_column()
    project_id = Column(Integer, ForeignKey("qap_test_projects.id"), nullable=False, index=True)
    name = Column(String(150), nullable=False)
    created_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)

    project = relationship("TestProject", back_populates="cycle_folders")
    created_by = relationship("User", foreign_keys=[created_by_id])
    cycles = relationship("TestCycle", back_populates="folder")
    access_grants = relationship("TestCycleFolderAccess", back_populates="folder", cascade="all,delete-orphan")

    @property
    def created_by_name(self):
        return self.created_by.full_name if self.created_by else None


class TestCycleFolderAccess(Base):
    """One department-or-user access grant on a TestCycleFolder -- see that
    model's own docstring for the restrict-not-widen semantics. Exactly one
    of `department`/`user_id` is set per row, enforced in
    routers/test_execution.py, same application-layer-only convention as
    TestProjectViewGrant and this app's other "exactly one of" rules (e.g.
    auth.py's department/departments payload resolution).

    Reported directly (live Oracle traceback): a SECOND department-only
    grant on the same folder raised ORA-00001 on what used to be a plain
    UniqueConstraint("folder_id", "user_id") -- Postgres treats every NULL
    in a composite unique index as distinct from every other NULL, so any
    number of rows can share (folder_id=1, user_id=NULL); Oracle only skips
    creating an index entry when EVERY indexed column is NULL, and folder_id
    is never null, so Oracle enforced uniqueness across (folder_id, NULL)
    instead -- capping each folder at exactly one department grant and one
    user grant, total. Fixed via two function-based unique indexes below
    instead: each one's first expression collapses to NULL whenever the row
    isn't actually that grant type, so Oracle's own "skip when every column
    is NULL" rule excludes it from that index entirely -- reproducing
    Postgres' behaviour without changing the "exactly one of
    department/user_id" application-layer rule. See
    ORACLE_MIGRATION_2026-07.md section 155 and alembic revision
    9b1f4d7c2a63."""
    __tablename__ = "qap_test_cycle_folder_access"
    __table_args__ = (
        Index("uq_qap_tcfa_folder_department",
              text("(CASE WHEN department IS NOT NULL THEN folder_id END)"), "department", unique=True),
        Index("uq_qap_tcfa_folder_user",
              text("(CASE WHEN user_id IS NOT NULL THEN folder_id END)"), "user_id", unique=True),
    )
    id = pk_column()
    folder_id = Column(Integer, ForeignKey("qap_test_cycle_folders.id"), nullable=False, index=True)
    department = Column(String(150), nullable=True)
    user_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True, index=True)
    granted_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)

    folder = relationship("TestCycleFolder", back_populates="access_grants")
    user = relationship("User", foreign_keys=[user_id])
    granted_by = relationship("User", foreign_keys=[granted_by_id])

    @property
    def user_name(self):
        return self.user.full_name if self.user else None

    @property
    def granted_by_name(self):
        return self.granted_by.full_name if self.granted_by else None


class TestCycle(Base):
    """Test Execution module -- a named run (e.g. 'Sprint 12 Regression',
    'CR-XX UAT Cycle 1') under a Project. Test cases are explicitly added to
    a cycle (creating a Not-Executed TestExecution row each) and then run
    against it -- the same case can be added to several different cycles
    over time, each getting its own independent execution history.

    `status` follows the controlled Draft -> Ready -> In Progress workflow,
    with In Progress -> Blocked -> In Progress and In Progress -> Completed.
    Completed is terminal. Every transition is validated and recorded by
    routers/test_execution.py instead of accepting arbitrary free text."""
    __tablename__ = "qap_test_cycles"
    id = pk_column()
    cycle_key = Column(String(40), unique=True, default=gen_id_default(BUSINESS_ID_PREFIXES["TEST_CYCLE"]))
    project_id = Column(Integer, ForeignKey("qap_test_projects.id"), nullable=False)
    name = Column(String(150), nullable=False)
    description = Column(Text)
    status = Column(String(20), default="Draft")
    start_date = Column(Date, nullable=True)
    end_date = Column(Date, nullable=True)
    created_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    # SRS LNK-003 "Linked cycles shall identify type so Smoke, Functional,
    # Regression and Retest results are distinguishable" -- free-text by
    # design (same latitude TestCase.test_type already has), not a fixed
    # enum, since a project may want its own cycle-type vocabulary.
    cycle_type = Column(String(30), nullable=True)
    environment = Column(String(60), nullable=True)
    build = Column(String(100), nullable=True)
    owner_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    # Reported directly: "Create Test Cycle Folder... Under this folder
    # create test cycle." Nullable -- a cycle with no folder is "Unfiled",
    # same convention as TestCase.folder_id in the Test Repository. See
    # TestCycleFolder's own docstring for the (optional) access restriction
    # a folder can carry.
    folder_id = Column(Integer, ForeignKey("qap_test_cycle_folders.id"), nullable=True, index=True)

    project = relationship("TestProject", back_populates="cycles")
    created_by = relationship("User", foreign_keys=[created_by_id])
    owner = relationship("User", foreign_keys=[owner_id])
    folder = relationship("TestCycleFolder", back_populates="cycles")
    executions = relationship("TestExecution", back_populates="cycle", cascade="all,delete-orphan")
    child_request_link = relationship("TestCycleChildRequestLink", back_populates="cycle", cascade="all,delete-orphan", uselist=False)

    @property
    def folder_name(self):
        return self.folder.name if self.folder else None

    @property
    def linked_request_id(self):
        return self.child_request_link.child_id if self.child_request_link else None

    @property
    def linked_request_key(self):
        return self.child_request_link.child_key if self.child_request_link else None

    @property
    def linked_request_type(self):
        return self.child_request_link.child_type if self.child_request_link else None

    @property
    def owner_name(self):
        return self.owner.full_name if self.owner else None

class TestCycleChildRequestLink(Base):
    """Optional Functional/SAST/DAST/Performance child association."""
    __tablename__ = "qap_test_cycle_child_links"
    id = pk_column()
    cycle_id = Column(Integer, ForeignKey("qap_test_cycles.id"), nullable=False, unique=True)
    child_type = Column(String(20), nullable=False)
    child_id = Column(Integer, nullable=False, index=True)
    child_key = Column(String(40), nullable=False, index=True)
    cycle = relationship("TestCycle", back_populates="child_request_link")


class TestExecution(Base):
    """One test case's *slot* within one cycle -- created (status defaults to
    Not Executed) the moment a test case is added to a cycle. A case is very
    often run more than once before it's genuinely done (e.g. Fail with
    evidence attached, the defect gets fixed, then a Pass on retest), so this
    row's own status/actual_result/test_run_artifacts/defect_id/
    executed_by_id/executed_at are a denormalized mirror of the single most
    recent attempt only -- kept so every existing list/filter/report that
    reads these columns directly keeps working unchanged. The authoritative,
    never-overwritten history of every attempt (including each attempt's own
    attached evidence) lives on the child TestExecutionRun rows below -- see
    routers/test_execution.py's _record_attempt/_migrate_legacy_result_if_needed.
    Field names mirror the xlsx template's own execution-time columns
    (Actual Result, Status, Test Run Artifacts, Defect ID) so the same shape
    is used whether a result was typed in the UI or came in via Excel import.

    2026-08 revamp (SRS CYC-004/CYC-006, the "principal traceability risk"
    fix): pinned_version_id is the exact TestCaseVersion selected at the
    moment this slot was added to the cycle -- once at least one
    TestExecutionRun exists against this slot, pinned_version_id is
    permanently frozen (CYC-006 "Executed items shall remain pinned");
    before any attempt exists, an authorized user may explicitly upgrade it
    to a newer approved version (routers/test_execution.py's
    upgrade_execution_version). This is what makes a closed cycle's
    reporting reproducible regardless of what happens to the testcase
    afterward -- see TestCaseVersion's own docstring. run_version supports
    SRS EXE-007 "optimistic concurrency" -- incremented every time a new
    attempt is recorded; a client that read this slot before a concurrent
    save must refresh rather than blindly overwrite (see
    routers/test_execution.py's _record_attempt)."""
    __tablename__ = "qap_test_executions"
    __table_args__ = (UniqueConstraint("cycle_id", "test_case_id", name="uq_qap_test_exec_cycle_case"),)
    id = pk_column()
    cycle_id = Column(Integer, ForeignKey("qap_test_cycles.id"), nullable=False)
    test_case_id = Column(Integer, ForeignKey("qap_test_cases.id"), nullable=False)
    pinned_version_id = Column(Integer, ForeignKey("qap_test_case_versions.id"), nullable=True)
    status = Column(String(20), default="Not Executed")
    actual_result = Column(Text)
    test_run_artifacts = Column(String(255))
    defect_id = Column(String(60))
    assigned_to_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True, index=True)
    assigned_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    assigned_at = Column(DateTime, nullable=True)
    executed_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    executed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=now)
    run_version = Column(Integer, nullable=False, default=0)
    # 2026-08 "Remove from cycle" permission requirement, Scenario 1:
    # "tester add testcase in lifecycle, but not executed it, just added ...
    # system should allow to remove from lifecycle as there are no test
    # execution history." Resolution (asked directly): whoever added a
    # testcase to a cycle may remove their OWN addition themselves, but only
    # while it still has zero execution history -- self-correcting a same-
    # person, zero-consequence mistake, without needing a QA Lead. Nullable
    # since it didn't exist before this column was added -- an existing slot
    # created before this ships simply falls back to "QA Lead Group/Admin
    # only" (see routers/test_execution.py's _execution_removal_block_reason),
    # same as if nobody in particular were recorded as the adder.
    added_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)

    cycle = relationship("TestCycle", back_populates="executions")
    test_case = relationship("TestCase", back_populates="executions")
    pinned_version = relationship("TestCaseVersion", foreign_keys=[pinned_version_id])
    assigned_to = relationship("User", foreign_keys=[assigned_to_id])
    assigned_by = relationship("User", foreign_keys=[assigned_by_id])
    executed_by = relationship("User", foreign_keys=[executed_by_id])
    added_by = relationship("User", foreign_keys=[added_by_id])
    runs = relationship("TestExecutionRun", back_populates="execution",
                         cascade="all,delete-orphan", order_by="TestExecutionRun.attempt_no")
    # Every governed Defect (defects.py) linked to this specific execution
    # slot via Defect.execution_id. Used to lock/gate status changes -- see
    # routers/test_execution.py's _execution_status_gate. One-directional
    # viewonly relationship (same pattern as FunctionalRequest.
    # test_cycle_links above) rather than a back_populates pair --
    # Defect.execution_id is the only column actually written to.
    linked_defects = relationship(
        "Defect",
        primaryjoin=lambda: TestExecution.id == foreign(Defect.execution_id),
        viewonly=True,
    )

    @property
    def assigned_to_name(self):
        return self.assigned_to.full_name if self.assigned_to else None

    @property
    def assigned_by_name(self):
        return self.assigned_by.full_name if self.assigned_by else None

    @property
    def executed_by_name(self):
        return self.executed_by.full_name if self.executed_by else None

    @property
    def added_by_name(self):
        return self.added_by.full_name if self.added_by else None

    @property
    def run_count(self):
        return len(self.runs)

    @property
    def pinned_version_label(self):
        return self.pinned_version.version if self.pinned_version else None

    @property
    def is_pinned_stale(self):
        """True when the testcase's current approved version has moved on
        from what this slot pinned -- surfaces SRS "Version impact" report
        (cycles on old versions) and the upgrade-available affordance in the
        UI. Deliberately never used to silently change pinned_version_id."""
        if not self.pinned_version_id or not self.test_case:
            return False
        current = self.test_case.current_approved_version_id
        return bool(current) and current != self.pinned_version_id


class TestExecutionRun(Base):
    """One concrete, immutable attempt at running a test case within a
    cycle. Reported directly: the previous design overwrote TestExecution's
    own result columns in place on every run, so a Fail (with its attached
    evidence) was silently destroyed the moment a later retest was logged as
    a Pass -- there was no way to see that the case had ever failed at all.
    Every save now inserts a new row here instead (attempt_no 1, 2, 3, ...),
    and TestExecution's own columns are updated to mirror only the newest
    one. Each attempt's own screenshots are stored the same way as before
    (models.RequestDocument, module "TEST_EXEC_IMAGE") but keyed by this
    row's own id instead of the parent TestExecution's -- so attempt 1's
    evidence and attempt 2's evidence never mix."""
    __tablename__ = "qap_test_execution_runs"
    __table_args__ = (UniqueConstraint("execution_id", "attempt_no", name="uq_qap_test_run_attempt"),)
    id = pk_column()
    execution_id = Column(Integer, ForeignKey("qap_test_executions.id"), nullable=False)
    attempt_no = Column(Integer, nullable=False)
    status = Column(String(20), nullable=False)
    actual_result = Column(Text)
    test_run_artifacts = Column(String(255))
    defect_id = Column(String(60))
    executed_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    executed_at = Column(DateTime, default=now)

    execution = relationship("TestExecution", back_populates="runs")
    executed_by = relationship("User", foreign_keys=[executed_by_id])
    defects = relationship("TestRunDefect", back_populates="run", cascade="all,delete-orphan",
                           order_by="TestRunDefect.created_at")

    @property
    def executed_by_name(self):
        return self.executed_by.full_name if self.executed_by else None


class TestRunDefect(Base):
    """A structured defect link owned by one concrete execution attempt.

    One failed run may uncover several defects and the same testcase may link
    different defects on later retests. This replaces the single free-text
    defect_id field as the authoritative relationship; that legacy field is
    retained only as the latest-run summary for compatibility.
    """
    __tablename__ = "qap_test_run_defects"
    __table_args__ = (UniqueConstraint("run_id", "defect_key", name="uq_qap_run_defect_key"),)
    id = pk_column()
    run_id = Column(Integer, ForeignKey("qap_test_execution_runs.id"), nullable=False, index=True)
    defect_key = Column(String(100), nullable=False)
    defect_url = Column(String(500), nullable=True)
    title = Column(String(255), nullable=True)
    defect_status = Column(String(40), nullable=True)
    notes = Column(Text, nullable=True)
    linked_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)

    run = relationship("TestExecutionRun", back_populates="defects")
    linked_by = relationship("User", foreign_keys=[linked_by_id])

    @property
    def linked_by_name(self):
        return self.linked_by.full_name if self.linked_by else None


class Defect(Base):
    """Governed defect with request/cycle/testcase/execution traceability."""
    __tablename__ = "qap_defects"
    id = pk_column()
    defect_key = Column(String(40), unique=True, nullable=False, index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=False)
    status = Column(String(20), nullable=False, default="New", index=True)
    qa_request_id = Column(Integer, ForeignKey("qap_requests.id"), nullable=False, index=True)
    # These three links are optional at creation time. A governed defect can
    # be opened first, then attached to a Failed/Blocked execution later.
    cycle_id = Column(Integer, ForeignKey("qap_test_cycles.id"), nullable=True, index=True)
    primary_test_case_id = Column(Integer, ForeignKey("qap_test_cases.id"), nullable=True, index=True)
    execution_id = Column(Integer, ForeignKey("qap_test_executions.id"), nullable=True, index=True)
    application_name = Column(String(150), nullable=False)
    module_feature = Column(String(150), nullable=False)
    environment = Column(String(60), nullable=False)
    severity = Column(String(20), nullable=False, index=True)
    priority = Column(String(20), nullable=False, index=True)
    steps_to_reproduce = Column(Text, nullable=False)
    expected_result = Column(Text, nullable=False)
    actual_result = Column(Text, nullable=False)
    reporter_id = Column(Integer, ForeignKey("qap_users.id"), nullable=False, index=True)
    reported_at = Column(DateTime, default=now, nullable=False)
    # No longer index=True on its own -- superseded by the composite
    # ix_qap_defects_assignee_upd below (same leading column, plus status
    # and updated_at) -- "my assigned defects, newest first" is exactly the
    # Defect Management module's own personal-queue view.
    assignee_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    assigned_team = Column(String(150), nullable=True)
    assigned_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    assigned_at = Column(DateTime, nullable=True)
    assignment_remarks = Column(Text, nullable=True)
    retest_tester_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    device_details = Column(String(255), nullable=True)
    build_version = Column(String(100), nullable=True)
    api_endpoint = Column(String(500), nullable=True)
    request_response_details = Column(Text, nullable=True)
    log_details = Column(Text, nullable=True)
    related_cr_number = Column(String(64), nullable=True)
    external_defect_id = Column(String(100), nullable=True)
    remarks = Column(Text, nullable=True)
    labels = Column(String(500), nullable=True)
    resolution_type = Column(String(60), nullable=True)
    resolution_summary = Column(Text, nullable=True)
    root_cause = Column(Text, nullable=True)
    fix_details = Column(Text, nullable=True)
    fixed_build_version = Column(String(100), nullable=True)
    resolved_at = Column(DateTime, nullable=True)
    retest_result = Column(String(20), nullable=True)
    retest_at = Column(DateTime, nullable=True)
    tested_build_version = Column(String(100), nullable=True)
    retest_actual_result = Column(Text, nullable=True)
    retest_remarks = Column(Text, nullable=True)
    reopen_reason = Column(Text, nullable=True)
    reopen_count = Column(Integer, nullable=False, default=0)
    deferral_reason = Column(Text, nullable=True)
    deferral_approved_by = Column(String(150), nullable=True)
    target_release = Column(String(100), nullable=True)
    expected_resolution_date = Column(Date, nullable=True)
    rejection_reason = Column(Text, nullable=True)
    duplicate_of_id = Column(Integer, ForeignKey("qap_defects.id"), nullable=True)
    # 2026-08 -- reported directly: "implement not a defect cycle, which is
    # missing as per defect cycle standard." A new terminal status, "Not a
    # Defect" (routers/defects.py's STATUSES/TRANSITIONS), reachable only
    # from "New" -- same triage-time slot as Rejected/Duplicate, distinct
    # from Rejected (which can mean duplicate/invalid/won't-fix) in that the
    # reported behavior was investigated and found to be expected/working as
    # designed, not an application defect at all. Mirrors rejection_reason's
    # own pattern exactly (a single required free-text reason, no FK like
    # Duplicate's duplicate_of_id needs). New column on an EXISTING Oracle
    # table -- create_all() never alters existing columns (additive-only,
    # no-Alembic convention, see database.py's own docstring) -- see
    # backend/scripts/2026-08_add_defect_not_a_defect_column.sql, which
    # STILL NEEDS TO BE RUN BY HAND against the live Oracle schema before
    # this code is deployed.
    not_a_defect_reason = Column(Text, nullable=True)
    closure_remarks = Column(Text, nullable=True)
    closed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=now, nullable=False)
    updated_at = Column(DateTime, default=now, onupdate=now, nullable=False)

    qa_request = relationship("QARequest", foreign_keys=[qa_request_id])
    cycle = relationship("TestCycle", foreign_keys=[cycle_id])
    primary_test_case = relationship("TestCase", foreign_keys=[primary_test_case_id])
    execution = relationship("TestExecution", foreign_keys=[execution_id])
    reporter = relationship("User", foreign_keys=[reporter_id])
    assignee = relationship("User", foreign_keys=[assignee_id])
    assigned_by = relationship("User", foreign_keys=[assigned_by_id])
    retest_tester = relationship("User", foreign_keys=[retest_tester_id])
    duplicate_of = relationship("Defect", remote_side=[id], foreign_keys=[duplicate_of_id])
    test_case_links = relationship("DefectTestCaseLink", back_populates="defect", cascade="all,delete-orphan")
    # Reported directly: the "Link existing defect" picker only ever offered
    # never-linked defects (execution_id IS NULL), so a QA engineer who
    # spotted the SAME already-governed defect failing a different
    # execution had no way to trace it there too -- "instead of [unlinked
    # only], show linked defect as well." execution_id/cycle_id/
    # primary_test_case_id above stay this defect's single PRIMARY
    # execution, unchanged; execution_links is every ADDITIONAL execution
    # it's also been traced to, mirroring test_case_links'/
    # DefectTestCaseLink's own established "primary field + separate
    # many-to-many table for extra links" pattern exactly.
    execution_links = relationship("DefectExecutionLink", back_populates="defect", cascade="all,delete-orphan")

    @property
    def reporter_name(self):
        return self.reporter.full_name if self.reporter else None

    @property
    def assignee_name(self):
        return self.assignee.full_name if self.assignee else None

    @property
    def assigned_by_name(self):
        return self.assigned_by.full_name if self.assigned_by else None

    @property
    def qa_request_key(self):
        return self.qa_request.request_id if self.qa_request else None

    @property
    def cycle_key(self):
        return self.cycle.cycle_key if self.cycle else None

    @property
    def project_id(self):
        return self.cycle.project_id if self.cycle else None

    # 2026-08 -- reported directly: "During assigning defect, department
    # should be auto populated based on linked request or Failed / Blocked
    # Test Execution." The linked Test Cycle's own Project.department is
    # the "which team actually owns the failing area" signal -- more
    # specific than the QA Request's own department, which the frontend
    # already offers as a fallback default (see Defects.tsx's TransitionModal
    # -- requestDepartment). None whenever no execution/cycle is linked
    # (e.g. a defect opened standalone, not from a Failed/Blocked execution).
    @property
    def project_department(self):
        return self.cycle.project.department if self.cycle and self.cycle.project else None

    @property
    def test_case_key(self):
        return self.primary_test_case.test_case_key if self.primary_test_case else None

    @property
    def duplicate_of_key(self):
        return self.duplicate_of.defect_key if self.duplicate_of else None

    @property
    def linked_test_case_ids(self):
        return [link.test_case_id for link in self.test_case_links]

    @property
    def linked_test_case_keys(self):
        return [link.test_case.test_case_key for link in self.test_case_links if link.test_case]


class DefectTestCaseLink(Base):
    __tablename__ = "qap_defect_case_links"
    __table_args__ = (UniqueConstraint("defect_id", "test_case_id", name="uq_qap_def_case"),)
    id = pk_column()
    defect_id = Column(Integer, ForeignKey("qap_defects.id"), nullable=False, index=True)
    test_case_id = Column(Integer, ForeignKey("qap_test_cases.id"), nullable=False, index=True)
    defect = relationship("Defect", back_populates="test_case_links")
    test_case = relationship("TestCase")


class DefectExecutionLink(Base):
    """An ADDITIONAL execution a governed Defect has been traced to, beyond
    its one primary execution (Defect.execution_id) -- see Defect.
    execution_links' own comment. Added so routers/defects.py's
    link-execution endpoint can attach the SAME governed defect to a second
    (or third...) Failed/Blocked execution -- e.g. the same underlying bug
    also failed a different test case -- without moving or overwriting the
    defect's original primary link, which stays the one used for
    assignment/closure/retest workflow. Deliberately excludes the primary
    execution itself (routers/defects.py never creates a row here for
    execution_id == Defect.execution_id, only for genuinely additional
    ones) so this table and the primary FK never disagree about which
    execution is "the" primary."""
    __tablename__ = "qap_defect_execution_links"
    __table_args__ = (UniqueConstraint("defect_id", "execution_id", name="uq_qap_def_exec"),)
    id = pk_column()
    defect_id = Column(Integer, ForeignKey("qap_defects.id"), nullable=False, index=True)
    execution_id = Column(Integer, ForeignKey("qap_test_executions.id"), nullable=False, index=True)
    linked_by_id = Column(Integer, ForeignKey("qap_users.id"), nullable=True)
    created_at = Column(DateTime, default=now)
    defect = relationship("Defect", back_populates="execution_links")
    execution = relationship("TestExecution", foreign_keys=[execution_id])
    linked_by = relationship("User", foreign_keys=[linked_by_id])

    @property
    def cycle_id(self):
        return self.execution.cycle_id if self.execution else None

    @property
    def cycle_key(self):
        return self.execution.cycle.cycle_key if self.execution and self.execution.cycle else None

    @property
    def project_id(self):
        return self.execution.cycle.project_id if self.execution and self.execution.cycle else None

    @property
    def test_case_key(self):
        return self.execution.test_case.test_case_key if self.execution and self.execution.test_case else None

    @property
    def status(self):
        return self.execution.status if self.execution else None


# ---------------------------------------------------------------------------
# Performance optimization indexes (IDX-001..007)
# ---------------------------------------------------------------------------
# Composite indexes for the query patterns every paginated list endpoint
# actually runs: filter by department/status (RBAC scoping + PAG-001's
# `status` param), sorted newest-first (PAG-004's stable `created_at DESC,
# id DESC`). Grouped here at module end, rather than scattered as
# `__table_args__` on each class, so the whole set (and the redundant
# single-column indexes removed alongside them -- see the comment left on
# each affected column above) can be reviewed together against IDX-005
# ("shall not create redundant indexes whose leading columns are already
# adequately covered by another index").
#
# Every name is verified <= 30 bytes (Oracle's hard identifier limit --
# this project has hit ORA-00972 from a too-long identifier before, see
# ORACLE_MIGRATION_2026-07.md's own note on it).
#
# These indexes were originally introduced by the historical manual SQL in
# backend/scripts/2026-08_add_performance_indexes.sql. Current deployments are
# Alembic-managed; all new index changes must be represented in a reviewed
# revision and applied with `alembic upgrade head`.
Index("ix_qap_req_dept_status_created", QARequest.department, QARequest.status, QARequest.created_at)
Index("ix_qap_req_bugfix_source", QARequest.bug_fix_source_request_id)
Index("ix_qap_del_req_status", QARequestDelegation.qa_request_id, QARequestDelegation.status)
Index("ix_qap_del_user_status", QARequestDelegation.assigned_to_id, QARequestDelegation.status)
Index("ix_qap_del_target_status", QARequestDelegation.target_type, QARequestDelegation.target_id, QARequestDelegation.status)
Index("ix_qap_func_status_created", FunctionalRequest.status, FunctionalRequest.created_at)
Index("ix_qap_sast_status_created", SASTRequest.status, SASTRequest.created_at)
Index("ix_qap_dast_status_created", DASTRequest.status, DASTRequest.created_at)
Index("ix_qap_perf_status_created", PerformanceRequest.status, PerformanceRequest.created_at)
Index("ix_qap_appract_entity_created", ApprovalAction.entity_type, ApprovalAction.entity_id, ApprovalAction.created_at)
# Dashboard recent activity is an unfiltered newest-first feed.  The entity
# index above cannot support that ordering because its leading key is type.
Index("ix_qap_appract_created_id", ApprovalAction.created_at, ApprovalAction.id)
Index("ix_qap_email_outbox", EmailNotification.status, EmailNotification.next_attempt_at, EmailNotification.created_at)
Index(
    "ix_qap_asgh_entity_active",
    AssignmentHistory.entity_type, AssignmentHistory.entity_id,
    AssignmentHistory.assignment_role, AssignmentHistory.unassigned_at,
)
Index("ix_qap_asgh_user_time", AssignmentHistory.assignee_id, AssignmentHistory.assigned_at)
Index("ix_qap_tc_proj_folder_created", TestCase.project_id, TestCase.folder_id, TestCase.created_at)
# 2026-08 -- added after the IDX-001..007 pass above, alongside the Recycle
# Bin feature's is_deleted column (models.py's own comment on that column).
# Every list/summary query in test_repository.py filters
# `project_id == X AND is_deleted == True/False` together (list_test_cases,
# get_test_case_summary x3, list_all_test_cases_for_project,
# _selected_project_cases, list_recycle_bin) -- is_deleted itself was never
# indexed at all, so every one of those queries index-range-scans by
# project_id via ix_qap_tc_proj_folder_created above and then falls back to
# a table-access-by-rowid to evaluate is_deleted on each candidate row. This
# composite serves the actual filter pair directly instead. Not a dup of
# ix_qap_tc_proj_folder_created under IDX-005 -- different second column
# (is_deleted vs folder_id), so it covers a distinct filter combination
# rather than a subset of it.
Index("ix_qap_tc_proj_deleted_created", TestCase.project_id, TestCase.is_deleted, TestCase.created_at)
Index("ix_qap_cyc_proj_status_created", TestCycle.project_id, TestCycle.status, TestCycle.created_at)
# Cursor/candidate access paths. Kept as explicit short names for Oracle's
# identifier limit and mirrored by Alembic revision 20260815_0001.
Index("ix_qap_tc_proj_del_id", TestCase.project_id, TestCase.is_deleted, TestCase.id)
Index("ix_qap_te_cyc_id", TestExecution.cycle_id, TestExecution.id)
Index("ix_qap_te_cyc_stat_id", TestExecution.cycle_id, TestExecution.status, TestExecution.id)
Index("ix_qap_te_cyc_asgn_id", TestExecution.cycle_id, TestExecution.assigned_to_id, TestExecution.id)
# Management contribution dashboard access paths. These pair the actor used
# for aggregation with the period timestamp used by every dashboard query.
Index("ix_qap_tc_author_created", TestCase.created_by_id, TestCase.created_at)
Index("ix_qap_run_actor_executed", TestExecutionRun.executed_by_id, TestExecutionRun.executed_at)
Index("ix_qap_def_reporter_at", Defect.reporter_id, Defect.reported_at)
Index("ix_qap_def_retester_at", Defect.retest_tester_id, Defect.retest_at)
Index("ix_qap_readiness_func_req", ReadinessChecklistItem.functional_request_id)
Index("ix_qap_moddocs_req_uploaded", RequestDocument.module, RequestDocument.request_id, RequestDocument.uploaded_at)
Index("ix_qap_audit_actor_created", AuditLog.actor_id, AuditLog.created_at)
Index("ix_qap_audit_target", AuditLog.target_type, AuditLog.target_id)
Index("ix_qap_defects_assignee_upd", Defect.assignee_id, Defect.status, Defect.updated_at)

# IDX-008, 2026-08 -- reported directly: "some of the apis are taking lot of
# timing, do some fine tuning." Follow-up pass over columns the IDX-001..007
# sweep above didn't reach: department on the two module tables that never
# got it (Suppression, Test Projects -- QARequest/FunctionalRequest/etc.
# already covered above), and the parent-request FK on the four child-
# request tables (qa_request_id), which every one of their own list/join
# queries filters or joins on and which had no index at all until now.
# Explicit short names here rather than inline `index=True` on the column,
# same reason as everywhere else in this block -- e.g. SQLAlchemy's default
# auto-generated name for SuppressionRequest.department would be
# `ix_qap_suppression_requests_department` (38 bytes), over Oracle's
# 30-byte identifier limit this file already flags above.
Index("ix_qap_sup_dept", SuppressionRequest.department)
Index("ix_qap_proj_dept", TestProject.department)
Index("ix_qap_func_qa_req", FunctionalRequest.qa_request_id)
Index("ix_qap_sast_qa_req", SASTRequest.qa_request_id)
Index("ix_qap_dast_qa_req", DASTRequest.qa_request_id)
Index("ix_qap_perf_qa_req", PerformanceRequest.qa_request_id)
Index("ix_qap_signoff_testreq", QASignOff.testing_request_id)

# Deliberately NOT added, with reasons (IDX-005/IDX-006 diligence):
#   - TestExecution(cycle_id, test_case_id): already exactly covered by the
#     UniqueConstraint("cycle_id", "test_case_id", name="uq_qap_test_exec_
#     cycle_case") on TestExecution above -- Oracle backs a unique
#     constraint with a unique index on precisely those columns in that
#     order, so a second, non-unique index on the same leading columns
#     would be purely redundant.
#   - "Pending Approval: approver, status, entity type" (IDX-002's own
#     table) -- there is no dedicated PendingApproval table with an
#     `approver` column in this schema; every pending-approval screen
#     queries the underlying module tables (QARequest/FunctionalRequest/
#     SASTRequest/DASTRequest/PerformanceRequest/TestCase review state)
#     directly by status/role, which the composites above already cover.
#   - "Assignment: assignee, status, updated date" beyond Defect -- the only
#     other assignment-shaped column in the schema is TestExecution.
#     assigned_to_id, which already has its own index=True and no
#     corresponding `status`/`updated_at` pair on that same row (status
#     lives on the row already, but there's no separate "assignment updated"
#     timestamp distinct from the row's own created_at) to usefully compose
#     with -- revisit if/when that module gains one.
