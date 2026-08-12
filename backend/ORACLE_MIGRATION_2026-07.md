# QA Portal — Fix/Change Log

The original `ORACLE_MIGRATION_2026-07.md` (which had grown to 215 numbered
sections tracking every fix and refactor made to this app) was deleted in
commit `8e77c98` ("defect fix, along with application upload:") on
2026-08-06, outside of this log's own maintenance process. This file starts
a fresh log from section 1, documenting fixes and changes going forward.

## 1. Sidebar navigation groups now default to closed

**Reported:** the sidebar's navigation groups (Overview, Request Management,
Functional, Test Management, Security, Specialized Testing, Governance,
Administration, Help & Support) were all expanded by default on load —
requested that they default to closed instead.

**Fix:** `frontend/src/components/Layout.tsx` — `expandedGroups` state
(the `Set<string>` backing each group's open/closed toggle button) now
initializes empty instead of pre-populated with every group's label. The
existing effect that auto-expands whichever group contains the current
route (keyed off `activeGroup?.label`) is unchanged, so the active section
is still never hidden on load — only the other groups now start collapsed
instead of everything being expanded up front.

**Verified:** `npx tsc --noEmit -p .` — clean. Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/uploads leftovers differ).

## 2. Fixed "Custom Fields not working" — two Oracle 30-char identifier violations

**Reported:** "currently Custom Fields not working" — no other detail given.

**Investigation:** dispatched a research pass across the whole Custom Fields feature
(`backend/app/models.py`'s `CustomFieldValue`, `backend/app/schemas.py`'s `CustomFieldCreate`/
`CustomFieldUpdate`/`CustomFieldOut`, `backend/app/routers/custom_fields.py`'s full CRUD, and
`frontend/src/components/CustomFields.tsx` plus its 10+ integration points across Functional/SAST/DAST/
Performance/QA Request/Suppression/SignOff/Test Projects/Test Repository/Test Execution). The router logic,
schema validation, and frontend component were all internally correct — no mismatched endpoints, no inverted
permission checks, no disconnected save handler.

**Root cause:** `models.py`'s `CustomFieldValue` (table `qap_custom_field_values`) tripped Oracle's classic
30-byte identifier limit (`ORA-00972: identifier is too long`, unless the schema has 12.2+ extended identifiers
enabled) in two places, both of which were the *only* offenders anywhere in the schema:
1. Its `UniqueConstraint` on `(entity_type, entity_id, field_name)` had an explicit name,
   `uq_qap_custom_field_record_name` — 31 characters, one over the limit.
2. `entity_type`/`entity_id` used plain `Column(..., index=True)`, which lets SQLAlchemy auto-generate the
   index name as `ix_<tablename>_<colname>` — for this table that resolved to
   `ix_qap_custom_field_values_entity_type` (38 chars) and `ix_qap_custom_field_values_entity_id` (36 chars),
   both also over the limit.

`main.py` runs `Base.metadata.create_all(bind=engine)` unguarded at import time, before the FastAPI app is even
constructed. SQLAlchemy validates identifier length client-side while compiling DDL, before ever sending SQL to
Oracle — so a bad identifier on this table's `CREATE TABLE` statement means `qap_custom_field_values` never
actually got created in the schema, and every one of the 4 Custom Fields endpoints
(`GET`/`POST /api/custom-fields/{entity_type}/{entity_id}`, `PATCH`/`DELETE /api/custom-fields/{field_id}`)
would 500 with "table or view does not exist".

**Fix:**
- Shortened the unique constraint name to `uq_qap_cfv_scope_name` (21 chars).
- Replaced the inline `index=True` on `entity_type`/`entity_id` with two explicit, short-named `Index()`
  entries in `__table_args__` — `ix_qap_cfv_entity_type` / `ix_qap_cfv_entity_id` — instead of letting
  SQLAlchemy auto-generate names.
- Confirmed via a length scan across every `name="..."` in `models.py` that no other identifier exceeds 30
  characters — this table was the only offender, consistent with it being a newer, not-yet-deployed addition
  (everything else was presumably already created against Oracle before this limit could bite it).

**Note for next deploy:** since the table was very likely never created at all, the next backend startup's
`create_all()` should create it cleanly now that both identifiers are short enough — no manual DDL/cleanup
should be needed, but worth confirming no `ORA-00972` appears in the startup log on the next restart.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` — clean; scripted length check confirms zero
identifiers over 30 chars anywhere in `models.py`. Documents and outputs copies re-synced and confirmed
identical via `diff -rq` (only the standard `.env`/uploads leftovers differ).

## 3. Added real logging infrastructure — no global exception handler or log file existed anywhere

**Reported, as a direct follow-up to section 2:** "then why it's not showing any error, it means application
does not have proper error handling/log management." A fair challenge — worth checking honestly rather than
just re-asserting the previous diagnosis.

**What was actually true before this fix:** every informational message in the whole backend was a bare
`print()` — `database.py`'s `Using DATABASE_URL: ...` line (which also printed the **raw** connection string,
password included) and `main.py`'s `Migrated N upload(s)...` line. There was no log file anywhere, no
`logging` module usage at all, and no global exception handler registered on the FastAPI app. Concretely, this
meant:
- If `Base.metadata.create_all(bind=engine)` (which runs unguarded at import time, before the FastAPI `app`
  object even exists) had thrown on a bad identifier, the entire process would crash on startup with a
  traceback visible **only** to whoever happened to be watching the exact terminal it was running in at that
  moment — gone forever the instant that terminal scrolled or closed, or never seen at all if the process runs
  under a supervisor without captured stdout.
- If a route handler threw an unexpected (non-`HTTPException`) exception at request time, Starlette's default
  behavior returns a bare "Internal Server Error" to the client and again only prints to whatever console is
  attached. The existing `application_audit_middleware` in `main.py` does record that a request failed (status
  500) and the exception's *class name* to the `qap_audit_log` table — but never the actual message or
  traceback, which is what's actually needed to diagnose a bug rather than just notice one happened.

So the honest answer to "why did it not show any error" is: this app genuinely had no durable place for a
startup or request-time crash to land — not a Custom-Fields-specific gap, an app-wide one.

**Fix — new `backend/app/logging_config.py`:**
- `configure_logging()`: a `qa_portal` logger writing to both the console (unchanged local `uvicorn --reload`
  experience) and a new rotating file, `backend/logs/app.log` (10 MB × 5 backups, so a crash-looping process
  can never fill the disk). Also attaches the same file handler to uvicorn's own `uvicorn.error`/
  `uvicorn.access` loggers, so uvicorn-level failures (e.g. "address already in use") land in the same file.
  Idempotent, since `--reload` re-executes module bodies on every code change. `backend/logs/` added to
  `.gitignore` (log files should never be committed).
- `mask_database_url()`: strips the password out of a `DATABASE_URL` before it's ever logged — needed now that
  output is persisted to disk instead of only an ephemeral terminal.

**Fix — `backend/app/database.py`:** calls `configure_logging()` first (before anything else logs), replaced
the raw-password `print()` with `logger.info(...)` over the masked URL, and added `logger.critical(...)` before
each of the two existing startup `RuntimeError`s (missing/non-Oracle `DATABASE_URL`) so those are captured to
the log file too, not just whatever's watching the terminal.

**Fix — `backend/app/main.py`:**
- `Base.metadata.create_all(bind=engine)` is now wrapped in `try`/`except Exception`, logging
  `logger.critical(..., exc_info=True)` (full traceback) before re-raising — the app still can't run without
  its schema, so this still refuses to start on a real DDL failure, but now the *specific* failing
  table/constraint is captured to `backend/logs/app.log` first, instead of only ever being visible live.
- Added `@app.exception_handler(Exception)` — catches any unhandled (non-`HTTPException`) exception from any
  route, logs the full traceback plus the request's method/path and its existing `X-Request-ID` (the app
  already generates one per request for the audit trail), and returns a clean JSON body,
  `{"detail": "An unexpected server error occurred... reference: <request_id>", "request_id": "..."}`, instead
  of Starlette's bare "Internal Server Error" text. Deliberately registered for the base `Exception` class only
  — FastAPI resolves the most specific handler first, so the many existing deliberate `raise HTTPException(400/
  403/404, ...)` calls throughout the app are completely unaffected and still return exactly as before. Since
  `application_audit_middleware` sits outside `ExceptionMiddleware` in Starlette's stack, `call_next()` now
  returns a normal 500 response (rather than raising) for these cases, so the existing audit-log write still
  runs unchanged — this is additive, not a replacement for it.
- Replaced the remaining `print(f"Migrated ...")` with `logger.info(...)`.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` — clean. Smoke-tested `logging_config.py`
standalone — confirmed the log file is created, a log line is written with the expected format, and
`mask_database_url` correctly hides the password segment only. `npx tsc --noEmit -p .` — clean (no frontend
files needed changes). Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the
standard `.env`/uploads leftovers differ; `backend/logs/` itself is gitignored and excluded from the sync).

**Live confirmation:** the user's own running backend picked up sections 2 and 3 via `--reload` — its own
`backend/logs/app.log` shows `Database schema verified/created successfully` at startup, followed by
successful `GET`/`POST`/`DELETE /api/custom-fields/...` calls across several entity types (SIGNOFF, TEST_CASE,
TEST_CYCLE, FUNCTIONAL). The `qap_custom_field_values` table exists and Custom Fields works end-to-end.

## 4. Fixed "failure in test lifecycle and testcases" — creating a Test Cycle always crashed

**Reported:** "failure in test lifecycle and testcases, basically on test management" — no other detail given.

**Root cause:** `backend/app/schemas.py`'s `TestCycleCreate` was missing the `linked_request_type`/
`linked_request_id` fields that `routers/test_execution.py::create_cycle` reads unconditionally
(`if payload.linked_request_id is not None:` at line 266) — those two fields were only ever added to
`TestCycleUpdate`/`TestCycleOut` (both already correct) when the "Linked Child Request" feature was built,
never to `TestCycleCreate`, which still carried a vestigial `qa_request_id` field that `create_cycle` never
actually reads. Since Pydantic v2 defaults to `extra="ignore"`, the frontend's `linked_request_type`/
`linked_request_id` fields sent on every "Create Cycle" submission (see `TestExecution.tsx`'s `CycleModal.
submit`, which builds one identical payload shape for both create and edit) were silently dropped instead of
stored — so `payload.linked_request_id` didn't evaluate to `None`, it raised `AttributeError: 'TestCycleCreate'
object has no attribute 'linked_request_id'` immediately, unconditionally, on every single `POST /api/
test-execution/projects/{project_id}/cycles` — a Test Cycle (this codebase's own term for one full "test
lifecycle") could never be created, whether or not a linked request was selected. Editing an existing cycle was
unaffected, since `TestCycleUpdate` already declared both fields correctly.

**Fix:** added `linked_request_type: Optional[str] = None` / `linked_request_id: Optional[int] = None` to
`TestCycleCreate`, matching `TestCycleUpdate`/`TestCycleOut`, and removed the vestigial, never-read
`qa_request_id` field (confirmed via a repo-wide grep that nothing else — frontend or backend — reads or sends
it).

**Investigation notes:** before finding this, re-ran the section-2 identifier-length scan and a new
cross-table duplicate-constraint-name scan across all of `models.py` (both came back clean — this was not
another DDL/identifier issue), and manually verified every `relationship()`/`back_populates`/`ForeignKey` pair
across the Test Management models (`TestProject`, `TestFolder`, `TestCase`, `TestCaseTag`, `TestStep`,
`TestCycle`, `TestCycleChildRequestLink`, `TestExecution`, `TestExecutionRun`, `TestRunDefect`) for a mapper
configuration error — none found. Test Repository's own "Tags" feature (a similarly-shaped recent addition)
was checked the same way and is wired correctly end-to-end, `TestCaseCreate`/`TestCaseUpdate`/
`TestCaseBulkUpdate` all declare every field their router reads.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` — clean. `npx tsc --noEmit -p .` — clean (no
frontend files needed changes; the frontend was already sending the correct payload shape, the schema was the
only thing behind). Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the
standard `.env`/uploads leftovers differ).

## 5. Fixed "upload storage not working... reverting old one" + "file is missing on disk" downloads

**Reported:** "upload storage not working, though updating the path, its reverting old one, and whileing trying
to download documents getting file is missing on disk".

**Root cause:** `backend/app/storage_config.py`'s active upload root and legacy-roots list used to be plain
module-level globals (`_active_root`/`_legacy_roots`), set once at process/import time and refreshed only by a
`PATCH /api/system-settings/storage` handled by that exact process. The DB write itself
(`routers/system_settings.py::update_storage_settings`) was never buggy — `db.commit()` always persisted the
new path to `qap_system_settings` correctly. But in any deployment running more than one backend process
(multiple uvicorn workers, multiple replicas/containers, or simply a process restart between an admin's save
and a later request), every OTHER process kept serving its own stale in-memory copy indefinitely — with no
mechanism to ever learn a save had happened elsewhere. That produces both reported symptoms as one shared bug:
- An admin's save commits fine, but the next `GET` (or the same admin reloading the page) can land on a
  different process that never saw the `PATCH` and still reports the old path — looks exactly like it
  "reverted," even though nothing was ever actually lost.
- A file uploaded via the process that picked up the new path is later looked up for download by a different
  process still using the old active-root/legacy-roots list — `resolve_upload_path()` searches roots that don't
  include where the file actually landed, and reports "file is missing on disk" even though the file exists on
  shared storage, just under a root that process doesn't know about.

**Fix — `backend/app/storage_config.py`:** `get_upload_root()`/`get_legacy_roots()`/`resolve_upload_path()` now
re-read the DB-authoritative `qap_system_settings` rows on every call, bounded by a 2-second in-process TTL
cache (`_ensure_fresh()`) so a tight loop resolving many files in one request (e.g.
`qa_requests.py::_finalize_child_requests`, which walks a whole raised request's worth of evidence paths in one
pass) doesn't turn into one DB round-trip per file. `configure_upload_storage()` (still called at startup via
`load_storage_settings`, and right after a successful `PATCH`) immediately refreshes the process that actually
handled the change, so that process's own next read is instant rather than waiting out the TTL; every other
process converges within 2 seconds regardless. A DB read failure during the refresh is swallowed (never raises)
so a transient DB hiccup can't break every file operation in the app — the process just keeps using its last
successfully-read value until the next refresh succeeds.

**Also added — `frontend/src/modules/governance/Admin.tsx`'s `UploadStorageCard`:** a short note under the
existing description warning that if the backend runs as more than one process, the configured path must point
at storage that's persistent and identically shared across all of them — otherwise files written by one process
can look "missing on disk" to another for reasons outside this app's own code (e.g. a Docker volume mounted at
only the default path, not a custom one). This is a documented, deliberately out-of-scope companion cause the
investigation surfaced (this repo's own `docker-compose.yml` only declares a persistent volume for the default
upload path, not any custom path an admin might configure) — not fixed here since it depends on the actual
deployment topology, which this session doesn't have visibility into.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` — clean. `npx tsc --noEmit -p .` — clean.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard `.env`
leftover differs).

## 6. Increased sidebar navigation font size and made it scale with viewport

**Reported:** "Navigation font size need to be increase, adjust as per viewport."

**Context:** `frontend/src/components/Layout.tsx` applies four shell-variant classes to the same root element
at once — `"app-shell redesigned-shell navigation-v2 navigation-v3 navigation-v4"` — left over from iterative
navigation redesign work. Every variant styles the exact same `.sidebar nav a` selector at equal CSS
specificity, so plain cascade order (not intentional layering) decides which one actually renders — `.navigation-v4`'s
rules, being last in `index.css`, are the ones genuinely in effect over `.navigation-v2`/`.navigation-v3`/the
base `.sidebar` rule above them. Its nav-item font-size was a fixed `11.5px` with no viewport-based scaling.

**Fix:** `frontend/src/index.css`, `.navigation-v4 .sidebar nav a`'s `font-size` changed from a fixed `11.5px`
to `clamp(13px, 0.6vw + 11px, 15.5px)` — roughly 13px on a narrow/tablet-width viewport, ~14.5px on a typical
laptop screen, capped at 15.5px on very wide monitors instead of growing unbounded. `.navigation-v4
.nav-group-toggle` (section headers like "Overview"/"Governance") and `.nav-workspace-label` were bumped the
same way with a smaller clamp, `clamp(9px, 0.5vw + 7px, 10.5px)` (up from a fixed 8px), scaled down
proportionally so they still read as category labels above the actual nav items rather than competing with
them. The existing `min-height: 39px` on each nav row comfortably fits the new max font size without any
overflow.

**Verified:** `npx tsc --noEmit -p .` — clean (CSS-only change). Documents and outputs copies re-synced and
confirmed identical via `diff -rq` (only the standard `.env` leftover differs).

## 7. Test Management Revamp — backend Foundation phase (models, migration, Repository + Projects routers)

**Requested:** full rebuild of Test Management per an uploaded SRS (`Test_Management_Revamp_Requirements.docx`,
16 sections + 3 appendices) — user explicitly chose **"Everything, end to end"** (all 6 phases: Foundation,
Governance, Planning, Experience, Reporting, Hardening) and **"Keep using create_all() for now"** (no Alembic —
every schema change below is strictly additive: new tables/columns only, nothing dropped or renamed).

**Architecture decision:** testcase content/steps now live in immutable `TestCaseVersion` /
`TestCaseVersionStep` rows instead of being mutated in place on `TestCase`. `TestCase`'s own columns
(status/version/content) become a **mirror** of whichever version is "current" — same pattern this codebase
already used for `TestExecution` mirroring `TestExecutionRun`. `TestCase.current_draft_version_id` /
`current_approved_version_id` point at the in-progress draft and the approved baseline respectively (resolved
via SQLAlchemy `post_update=True` for the mutual FK dependency between the two tables).

**models.py:**
- New `TestProjectMember` (`qap_test_project_members`, unique on project+user) — project-scoped membership
  with its own role vocabulary (`constants.TEST_PROJECT_ROLES`), separate from the app-wide `Role` enum.
- New `TestCaseVersion` / `TestCaseVersionStep` — the immutable version records described above.
- `TestCase`: status default `Active`→`Draft`; added `current_approved_version_id`/`current_draft_version_id`.
- `TestCycle`: status default `Not Started`→`Draft`; added `cycle_type`, `environment`, `build`,
  `owner_id`, `closed_by_id`/`closed_at`/`close_reason`, `reopened_by_id`/`reopened_at`/`reopen_reason`.
- `TestExecution`: added `pinned_version_id` + `run_version` so a cycle keeps showing the exact steps/expected
  results that were selected at add-to-cycle time, even after later testcase edits (the SRS's stated
  "principal traceability risk").
- `TestProject`: added `owner_id` (SRS PRJ-001 requires an owner at creation — this column didn't exist before
  this section and was added here), and `is_archived`/`archived_by_id`/`archived_at`/`archived_reason` (SRS
  PRJ-003's 3-state model — layered additively on the existing `is_active` boolean rather than replacing it:
  archiving always also sets `is_active=False` in the same action, so every existing `if not project.is_active`
  gate across the app already rejects an archived project with no further changes needed elsewhere).
- All new constraint/index names manually verified under Oracle's 30-byte identifier limit (e.g.
  `uq_qap_tpm_project_user`, `uq_qap_tcv_case_version`, `uq_qap_tcvs_version_step`).

**app/test_management_migration.py (new):** idempotent startup migration, same pattern as
`documents.py::migrate_legacy_document_layout` — called once from `main.py` inside the existing
`with SessionLocal() as migration_db:` block (previously written but not yet wired in; wired in this section).
Backfills: every pre-revamp `TestCase` gets its first `TestCaseVersion` (old status `Active/Draft/Deprecated` →
new `Approved/Draft/Archived`, reviewer history best-effort recovered from existing `ApprovalAction` rows);
every `TestExecution` gets `pinned_version_id` set to what it was already implicitly showing; every `TestCycle`
status is normalized into the new 7-value vocabulary; every `TestProject` missing the new `owner_id` gets it
backfilled from `created_by_id`.

**routers/test_repository.py (full rewrite):** `create_test_case`/xlsx import/folder-copy now all create a
version-1.0 Draft alongside the `TestCase` row (shared `_create_case_with_first_draft` helper). `update_test_case`
implements SRS VER-003 — editing an approved case spins off a new Draft version rather than touching the
approved baseline; editing an already-in-progress Draft updates it in place; editing is blocked while a version
is "In Review". New endpoints: `submit` (REV-001, validates non-empty/non-duplicate steps before allowing
submission), `review` (rewritten — Approve/Return now act on the draft version, GOV-002 blocks an author from
approving their own draft with no admin bypass), `checkout-override` (TC-004, requires a reason), `archive`/
`restore` (TC-006 — preserves version/execution history, blocks future cycle selection), `clone` (TC-005 — new
identity, fresh 1.0 Draft, cross-project allowed), `versions`/`versions/{id}`/`versions-compare` (VER-005).
Hard delete is now blocked once a testcase has ever been approved (must Archive instead); bulk-approve blocks
self-approval per case.

**routers/test_projects.py (extended):** `create_test_project` now requires/defaults an `owner_id` and
auto-adds the owner as a `TestProjectMember` with role "Owner"; `update_test_project` supports reassigning
ownership. New endpoints: `archive`/`unarchive` (QA-Lead-only, PRJ-003), member CRUD (`members` — PRJ-005,
restricted to the project's own owner or a QA Lead, owner's own membership can't be demoted/removed without
reassigning ownership first).

**main.py:** wired `test_management_migration.migrate_test_management_versioning(migration_db)` into the
existing startup migration block, right after `migrate_legacy_document_layout`.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. Every new model field/relationship,
schema class, and helper cross-checked line-by-line against the actual codebase via a dedicated research pass
(not just compiled — no sandbox network/DB access, so this is careful manual review in place of live
`configure_mappers()`/runtime validation); real runtime behavior can only be confirmed via the user's own live
backend process and `backend/logs/app.log`. Documents and outputs copies re-synced and confirmed identical via
`diff -rq` (only the standard `.env`/`logs` exclusions differ).

**Not yet done (remaining phases, tracked in this session's task list):** `test_execution.py` (pinned-version
cycle items, 7-state cycle lifecycle, defect-linking) is in progress; reporting endpoints and the entire
frontend (project workspace, Repository/version UI, Test Cycles, My Executions, Reports) has not been
started yet.

**Known pre-existing issue, not touched:** `main.py` is missing the `custom_fields` router import/registration,
and `app/routers/custom_fields.py` / `frontend/src/components/CustomFields.tsx` no longer exist on disk — removed
by an external commit outside this session, unrelated to the Test Management work. Flagged to the user earlier
this session; left alone pending their instruction.

## 8. Test Management Revamp — cycle lifecycle, pinned execution, and reporting (Governance/Planning/Reporting phases)

**Continuation of section 7.** Completed `test_execution.py` and `test_projects.py` governance/planning
features, then added a new `test_reports.py` router for SRS section 11.

**routers/test_projects.py:**
- `create_test_project` now requires/defaults an owner (`TestProject.owner_id` — new column, SRS PRJ-001)
  and auto-adds the owner as a `TestProjectMember` with role "Owner"; `update_test_project` supports
  reassigning ownership.
- New `TestProject.is_archived`/`archived_by_id`/`archived_at`/`archived_reason` columns (SRS PRJ-003's
  3-state model) layered additively on the existing `is_active` boolean — archiving always also sets
  `is_active=False` in the same action, so every existing `if not project.is_active` gate across the app
  already rejects an archived project with no further changes needed.
- New endpoints: `archive`/`unarchive` (QA-Lead-only), member CRUD under `/members` (PRJ-005 — restricted to
  the project's own owner or a QA Lead; the owner's own membership can't be demoted/removed without
  reassigning ownership first).
- `test_management_migration.py`: added `_migrate_project_owners` to backfill `owner_id` from
  `created_by_id` for every pre-revamp project; wired into `main.py`'s existing startup migration block
  alongside `migrate_legacy_document_layout` (previously written but not yet called — now is).

**routers/test_execution.py (7-state cycle lifecycle, CYC-001..009):**
- `create_cycle` now actually persists `cycle_type`/`environment`/`build`/`owner_id` (previously
  accepted by the schema but silently dropped by the router).
- New `_require_open_cycle` helper blocks any mutation while `cycle.status` is Closed/Cancelled
  (`constants.TEST_CYCLE_LOCKED_STATUSES`) — applied to every mutating endpoint in the file (cycle edit,
  add/remove testcases, assign, record result, defect link/unlink, evidence delete, reset, and the
  previously-missed `unlink_cycle_request`).
- New `_require_scope_change_permission` helper (CYC-007): once a cycle has any recorded execution
  attempt, adding/removing testcase slots becomes QA-Lead/Admin-only.
- New `close_cycle`/`reopen_cycle` endpoints (CYC-008) — close available to the normal execution roles;
  reopen restricted to QA Lead and requires a non-blank reason, per the SRS. The original close record is
  never cleared on reopen, so a full close→reopen→close history stays visible.
- `add_test_cases_to_cycle`: replaced the stale `case.status != "Active"` check (old 3-value vocabulary)
  with SRS CYC-003's actual rule — a case is only selectable when it has a `current_approved_version` whose
  own status is "Approved" (excludes both never-approved and Archived cases) — and now sets
  `pinned_version_id = case.current_approved_version_id` on every new `TestExecution` row (CYC-004).
- `_prepare_execution_update`: removed the same stale status re-check at execution time entirely — a slot
  that was validly pinned when added stays executable regardless of what the live testcase does afterward
  (that's the whole point of pinning); now just verifies `pinned_version_id` is set.
- New `upgrade_execution_version` endpoint (CYC-006) — re-pins an unexecuted slot to a newer Approved
  version; rejected once any attempt exists.
- `_record_attempt` now increments `TestExecution.run_version` on every attempt; `update_execution` checks
  a caller-supplied `expected_run_version` and returns 409 if it's stale (SRS EXE-007 optimistic
  concurrency — the field existed on the schema already but was never enforced).
- `bulk_update_execution_results`: replaced the same stale `"Active"` check with a `pinned_version_id`
  presence check, consistent with the single-execution path.
- `reset_test_cycle`: now blocked while the cycle is Closed/Cancelled, resets each execution's
  `run_version` to 0, and sets the cycle back to `"Draft"` (was the old vocabulary's `"Not Started"`).

**routers/test_reports.py (new) — SRS section 11, all 8 report views:** Repository health, Review SLA,
Requirement coverage, Cycle progress, Defect quality, Version impact, Project portfolio, Audit evidence.
Registered in `main.py`. Every endpoint has a **typed Pydantic `response_model`** (new "Test Management
Reporting" section in `schemas.py`: `RepositoryHealthOut`, `ReviewSlaOut`, `RequirementCoverageOut`,
`CycleProgressOut`, `DefectQualityOut`, `VersionImpactOut`, `ProjectPortfolioOut`, `AuditEvidenceOut`, and
shared `ReportFilterRef`/`ReportCountRow`/`ReportStatusCountRow`) — matching this app's existing
router-wide convention, rather than returning untyped dicts. List-shaped reports (review SLA items,
requirement coverage, version impact, audit evidence) take `limit`/`offset` query parameters (default 50,
max 500) and report both `total_items` (full population) and `returned_items` (this page), per the app's
"database pagination for high-volume lists" NFR. Each report documents its own population/exclusions/date
basis in a `population_note` string (RPT-001); every grouped row carries a `filters` object describing how
the frontend reproduces that exact slice via the existing list endpoints (RPT-002) rather than this router
returning raw underlying rows. All aggregate reads pull from pinned versions and immutable attempt/audit
rows already established in sections 7's Foundation phase, so results for a Closed cycle are reproducible
regardless of later testcase edits (RPT-003).

One real correctness bug caught while wiring the typed contract for `requirement_coverage`: the "approved
cases" count had been checking `TestCase.status` (the mirror column, which reflects whichever version is
"current for display" — the in-progress draft if one exists) instead of `current_approved_version_id`. A
case with a draft revision in progress would have under-counted as not-approved even though its earlier
Approved baseline is still fully valid and selectable for cycles (VER-002). Fixed to check
`current_approved_version_id` directly.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean throughout. Every new/changed field,
relationship, and schema cross-checked against the actual codebase via dedicated research passes (not just
compiled) — no live DB/network access in this sandbox, so this is careful manual review in place of live
`configure_mappers()`/runtime response validation; real runtime behavior (including FastAPI's
`response_model` validation on the new reporting endpoints) can only be confirmed via the user's own live
backend process and `backend/logs/app.log`. Documents and outputs copies re-synced and confirmed identical
via `diff -rq` (only the standard `.env`/`logs` exclusions differ).

**Backend Foundation + Governance + Planning + Reporting phases are now complete.** Remaining work per the
SRS's own phased delivery plan: Phase 4 Experience (project workspace shell, Repository + version panel +
Review Queue UI, Test Cycles UI, My Executions, Defects tab) and Phase 5 Reporting UI (the 8 report
views built above have no frontend yet) — i.e. the entire frontend for this revamp — plus Phase 6 Hardening
(load/security/recovery testing, out of scope for this development session). Nothing in the existing
frontend has been touched yet, so the current UI still reflects the pre-revamp Test Management screens.

## 9. Test Management Revamp — frontend Experience + Reporting phases (Phases 4 and 5)

**Continuation of sections 7-8.** Built the entire frontend for the revamped Test Management module under
`frontend/src/modules/test-management/`, wired to every backend endpoint added in sections 7-8:

- `TestProjects.tsx` — project workspace shell: create/edit/archive a project, member management (add/
  remove/change role against `TEST_PROJECT_ROLES`), navigation into a project's Repository/
  Execution/Reports tabs.
- `TestRepository.tsx` — folder tree + test case list, the version-aware detail/edit modal (Draft vs.
  Approved vs. In Review vs. Rework Required vs. Archived states per VER-003), submit/review/checkout/
  checkout-override/archive/restore/clone actions, version history + compare (VER-005), Excel import.
- `TestExecution.tsx` — Test Cycle CRUD, the 7-state lifecycle (create/close/reopen/reset per CYC-008),
  add/remove test cases against a cycle, runner assignment, defect link/unlink.
- `MyExecutions.tsx` — the individual tester's queue: record a result (single/bulk/rich with screenshots),
  upgrade a stale pinned version (CYC-006), evidence upload/delete.
- `TestReports.tsx` — all 8 report views from section 8's `test_reports.py` (Repository health, Review SLA,
  Requirement coverage, Cycle progress, Defect quality, Version impact, Project portfolio, Audit evidence),
  each reading its `population_note`/`filters` contract to stay reproducible against the underlying list
  endpoints (RPT-001/002).

**Verified:** `npx tsc --noEmit -p .` clean throughout; each screen cross-checked against its backend
endpoint's actual request/response schema (not just compiled). Documents and outputs copies re-synced and
confirmed identical via `diff -rq` (only the standard `.env`/`logs` exclusions differ).

**All 6 SRS phases (Foundation, Governance, Planning, Experience, Reporting; Hardening explicitly out of
scope for this session) are now complete.** The Test Management module is fully revamped end to end,
backend and frontend.

## 10. Project-role permission enforcement — restricting Repository/Execution actions to a project's own members

**Motivation:** sections 7-9 introduced `TestProjectMember`/`TEST_PROJECT_ROLES` as data (who's on a
project, in what role) but nothing yet used that data to actually restrict anything — every system
`QA_ENGINEER`/`QA_LEAD` could author, review, or execute against *any* project regardless of whether they
were ever added as a member, or what role they were added with. This section wires the role data to actual
enforcement.

**Design — `backend/app/deps.py`, new "Test Management -- project-scoped role enforcement" section:**
- **Backward-compatible / opt-in rule:** a user who is *not* a member of a given project keeps their full
  system-role-derived access, unchanged — most existing projects have no members configured yet, so nothing
  regresses for them. A user who *is* a member gets restricted to what their project role permits, even if
  their system role would otherwise allow more. System `QA_LEAD`/Admin always bypass every check below,
  member or not.
- `get_project_member_role(db, project_id, user_id)` — looks up the caller's `TestProjectMember.project_role`
  for one project, or `None` if not a member.
- `_project_role_permits(db, project_id, current_user, allowed: set)` — the shared "not a member, or a
  member with an allowed role" check every capability below is built from.
- Four capability sets, each mapping a project role to what it unlocks: `_REPOSITORY_AUTHOR_ROLES` (Author +
  project-lead-tier + Owner) for create/edit/submit/delete/checkout/clone/import in the Repository;
  `_REPOSITORY_REVIEW_ROLES` (Reviewer + project-lead-tier + Owner) for approve/return/archive/restore/
  checkout-override; `_EXECUTION_WRITE_ROLES` (Tester + project-lead-tier + Owner) for recording results,
  runner assignment, defect linking; `_EXECUTION_GOVERNANCE_ROLES` (project-lead-tier + Owner only) for
  reopen/reset/delete a cycle.
- `can_manage_project`/`require_can_manage_project` — a separate, narrower check used only for a project's
  own detail record (name/department/owner) and membership management: system `QA_LEAD`/Admin, or the
  project's actual `owner_id` — deliberately **not** derived from `TEST_PROJECT_ROLES` membership, since
  editing the project record itself and managing who's on it are Owner-tier concerns even for someone
  holding the project-lead-tier role.
- **Deliberate exception (CYC-007):** `test_execution.py`'s `_require_scope_change_permission` (scope
  changes once a cycle already has recorded execution attempts) does **not** use the backward-compatible
  helper above — it checks `get_project_member_role()` directly and requires literal project-lead-tier or
  Owner, because the normal helper's "not a member = unrestricted" fallback would let a non-member
  `QA_ENGINEER` bypass this specific lock, which the SRS requires to always need Lead-tier approval.

**Wired into every mutating endpoint** across `test_repository.py` (Repository actions) and
`test_execution.py` (Execution actions) via `require_can_*` dependencies; read/list endpoints stay
unrestricted (view access was never gated by project role).

**Frontend:** project role + the four derived permission flags are now surfaced on the project workspace
response so `TestRepository.tsx`/`TestExecution.tsx` can hide/disable actions the current user's project
role doesn't permit, instead of relying solely on a 403 from the backend.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`logs` exclusions differ).

## 11. Fixed misleading "Unavailable until QA Lead approval" text in the Test Case detail modal

**Reported:** "In test repository, under table it is showing Workflow as Draft, and pending with Author, but
on click of that test case it's showing Workflow Status Draft, Unavailable until QA Lead approval — neither
QA lead able to approve, what is the process or any bug."

**Investigation:** the Repository table's own "pending with" column was already correct (`Draft` → `Author`,
via `TEST_CASE_PENDING_WITH`). The detail modal's separate "Workflow Status" note, however, only ever
checked `current_approved_version_id` — so a never-submitted Draft (nothing to approve yet) rendered the
exact same "Unavailable until QA Lead approval" text as a genuinely-submitted In Review case, with no way
to tell the two apart. There was no backend bug — the case was correctly sitting in Draft, awaiting the
author's own submit action, exactly as designed; the copy was just wrong about why.

**Fix — `frontend/src/modules/test-management/TestRepository.tsx`:** added a `workflowStatusNote(existing)`
helper switching on the actual version `status` (In Review / Rework Required / Approved / Archived /
Draft — with a further check on whether it's a first-ever draft vs. a new draft off an approved baseline),
replacing the old single broken ternary at the "Workflow Status" field. A Draft now correctly reads along
the lines of "Draft — not yet submitted for review" instead of implying review is already pending.

**Verified:** `npx tsc --noEmit -p .` clean. Documents and outputs copies re-synced and confirmed identical
via `diff -rq`.

## 12. Bulk submit-for-review + fixed import/clone falsely logging "submitted" without transitioning status

**Reported, direct follow-up to section 11:** "now thing i have 100 testcases, so it is not possible to do
manually edit one by one by author to submit."

**Fix — bulk submit:** extracted the single-submit logic in `test_repository.py` into a shared
`_submit_draft(db, case, draft, current_user, note, extra_comment=None)` helper, and added
`POST /projects/{project_id}/test-cases/bulk-submit` (`bulk_submit_test_cases`, new
`schemas.TestCaseBulkSubmit`) — validates the **entire** selection's draft-readiness and TC-003 step
completeness before mutating anything, all-or-nothing (matching the existing `bulk_approve_test_cases`/
`bulk_delete_test_cases` convention), then submits each via `_submit_draft`. Frontend: new `BulkSubmitModal`
in `TestRepository.tsx`, a "Submit for review (N)" bulk-toolbar button gated on the selection actually being
Draft/Rework-Required.

**Real bug found while building this:** `_clone_folder_subtree` and `import_test_cases` (Excel import) both
wrote an `ApprovalAction` audit entry claiming "...submitted to the QA Lead for verification" without ever
actually transitioning the new version's status off `Draft` — so every bulk-imported or folder-cloned test
case silently required a manual one-by-one submit despite the activity feed lying that submission had
already happened. This directly explains the user's original section-11 report too (test cases stuck in an
apparently-already-submitted-looking Draft). Fixed by routing both paths through `_submit_draft` when
`_validate_steps()` passes; when it doesn't (incomplete steps), the audit note now honestly says the case
was left in Draft rather than claiming a submission that didn't happen.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 13. Restricted editing a Test Project's own details to its Owner (or system QA Lead/Admin)

**Reported:** "Why QA Lead able to update in test proeject?" — questioning why any system `QA_ENGINEER`/
`QA_LEAD` could edit any Test Project's own record (name/department/linked application/description/owner)
regardless of ownership, once section 10's project-role model existed. Confirmed with the user via a direct
question before changing enforcement on a production/bank system; they chose restricting to the project's
Owner or system `QA_LEAD`/Admin.

**Design nuance caught before implementing:** `update_test_project` is also the endpoint PRJ-004 uses for
"any `QA_ENGINEER` may request activation/deactivation" — gating the whole endpoint would have broken that
unrelated, deliberately-unrestricted flow. Fixed by scoping the new check to only fire when the payload
touches `_DETAIL_FIELDS = {"name", "department", "application_master_id", "description", "owner_id"}` (via
Pydantic's `model_fields_set`), leaving is_active-only activation-request payloads untouched.

**Fix — `test_projects.py`:** `if _DETAIL_FIELDS & payload.model_fields_set: require_can_manage_project(obj,
current_user)`, using the `can_manage_project`/`require_can_manage_project` helpers added in section 10
(Owner `owner_id` match, or system `QA_LEAD`/Admin — deliberately not derived from project-role membership).

**Also produced, in response to "give me full ownership modal who and what can do":** new
`backend/TEST_MANAGEMENT_PERMISSIONS.md` — a full plain-language reference of the two-layer permission
model (system roles vs. project roles), the backward-compatible rule, and complete action matrices for Test
Projects/Repository/Execution, plus a "Known gaps" section flagging what's deliberately not yet restricted
by project role (all 8 Reports views and archive staying system-`QA_LEAD`-only).

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. Independently re-verified via a
dedicated research subagent doing line-by-line correctness review of the new gating, given the production/
bank context — no issues found. Documents and outputs copies re-synced and confirmed identical via
`diff -rq`.

## 14. Renamed the project role "QA Lead" to "Project Lead" — fixed confusion with the system role QA_LEAD

**Reported:** "creating confusion QA lead, system QA lead keep as Keep lead, but project qa lead rename to
something else to proper understand" — the project-scoped role value `"QA Lead"` (one of
`TEST_PROJECT_ROLES`, introduced in section 7) shared its exact display name with the app-wide system role
`Role.QA_LEAD` (pre-existing, used throughout the rest of the app), even though they are two unrelated
mechanisms — one person's role on one specific project vs. a role active everywhere. The name collision was
flagged as confusing (already called out defensively in section 13's `TEST_MANAGEMENT_PERMISSIONS.md`, but
that only explained the collision rather than removing it). Per the user's explicit instruction, the system
role keeps its existing name; only the project role was renamed, to **"Project Lead"**.

**Scoping the rename:** the string `"QA Lead"` appears dozens of times across this app's prose, error
messages, and unrelated features (system-role labels, `WORKFLOW_STEPS` display data, QA Request/Security/
Performance workflow "pending with" labels, `Login.tsx` demo account labels) that must never be touched — a
naive global find-and-replace would have corrupted all of them. Used a dedicated research pass to classify
every occurrence file-by-file as either "project-role value" (rename) or "system-role/unrelated prose"
(leave alone) before editing anything.

**Renamed (project-role value only):**
- `backend/app/constants.py` — `TEST_PROJECT_ROLES` list value.
- `backend/app/deps.py` — the four capability sets (`_REPOSITORY_AUTHOR_ROLES`, `_REPOSITORY_REVIEW_ROLES`,
  `_EXECUTION_WRITE_ROLES`, `_EXECUTION_GOVERNANCE_ROLES`) and every `require_can_*` error message's
  suggested-role text.
- `backend/app/routers/test_execution.py` — `_require_scope_change_permission`'s (CYC-007) literal role
  check, `in ("QA Lead", "Owner")` → `in ("Project Lead", "Owner")`.
- `frontend/src/constants.ts` — `TEST_PROJECT_ROLES` array (the Members-modal role dropdowns render this
  list dynamically, so they picked up the new name with no further frontend changes needed).
- `backend/TEST_MANAGEMENT_PERMISSIONS.md` — every table/prose reference to the project role.

**New one-time data migration — `backend/app/test_management_migration.py`:** added
`_migrate_project_lead_role_name(db)`, following the file's existing idempotent-startup-pass pattern
(`_migrate_project_owners` etc.) — renames any `TestProjectMember` row already saved with
`project_role == "QA Lead"` to `"Project Lead"`, so members added before this rename keep their elevated
project role under the new name instead of silently falling back to an unrecognized value. Wired into
`migrate_test_management_versioning()`, called from `main.py`'s existing startup migration block; row count
logged alongside the file's other migration counters.

**Left unchanged (confirmed system-role or unrelated, not this rename's concern):** `Role.QA_LEAD` and every
prose reference to it throughout `deps.py`/`test_execution.py`/`test_projects.py`/`dashboard.py`/
`signoff.py`/frontend; `constants.py`'s `WORKFLOW_STEPS["TEST_CASE"] = ["Author", "Reviewer", "QA Lead"]`
(unrelated display-only step-label data, not wired to `project_role` anywhere — verified directly rather
than trusting the research pass's own uncertainty flag on this one); `TEST_CASE_PENDING_WITH`'s `"In
Review": "QA Lead"` (a generic "who can act next" display label, not a literal comparison against
`project_role`).

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Repo-wide grep confirms zero remaining `"QA Lead"` occurrences anywhere used as a live project-role
comparison or label — every remaining hit is legitimate system-role prose or an unrelated feature. Documents
and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`logs`
exclusions differ).

## Current Test Cycle lifecycle — controlled five-state workflow

The current requirement supersedes the earlier seven-state cycle design documented above. Test Cycles now
support only `Draft`, `Ready`, `In Progress`, `Blocked`, and terminal `Completed`. The backend permits only
`Draft → Ready`, `Ready → In Progress`, `In Progress → Blocked`, `Blocked → In Progress`, and
`In Progress → Completed`; all other transitions return the prescribed invalid-transition error. Blocking
requires a reason, every successful transition creates a Lifecycle audit entry, and results can be recorded
only while the cycle is `In Progress`. The UI now presents named actions rather than a free status selector
and confirms completion. The former close, reopen, and lifecycle-reset API/UI paths were removed. Existing
`Closed` or `Cancelled` rows are normalized to terminal `Completed` during the idempotent startup migration.

## 15. Widened repository review-tier actions to project role Reviewer/Project Lead/Owner, not just system QA Lead

**Reported, direct follow-up to sections 10/14's permission work:** "one user is QA engineer, and mark him
as Project lead, so he cant approve?" — a fair challenge to what section 10 had actually shipped. The honest
answer at the time was yes, he still couldn't: `review_test_case`, `checkout_override`, `archive_test_case`,
`restore_test_case`, `bulk_approve_test_cases`, and the folder-delete endpoint in `test_repository.py` were
all gated at the **router level** with `Depends(require_roles(Role.QA_LEAD))` — a hard floor requiring
system role `QA_LEAD`/Admin, checked before the project-role logic built in section 10 ever ran. A
`QA_ENGINEER` marked `"Project Lead"`/`"Reviewer"`/`"Owner"` on a project was rejected at the door every
time, which directly contradicted `TEST_MANAGEMENT_PERMISSIONS.md`'s own "Project Lead" row claiming "same
practical capability as Owner... even if your system role is only QA_ENGINEER." Confirmed with the user
(via a direct question, given the maker-checker/production-banking context) whether to fix the documentation
to match the stricter code, or change the code to match the documented intent — they chose the latter.

**The risk that shaped the fix:** simply relaxing the router-level dependency to admit `QA_ENGINEER` would
not have been enough on its own — `can_review_repository` (the function these endpoints call internally)
was built on the same `_project_role_permits` helper as `can_author_repository`/`can_execute_project`, which
treats a **non-member** as unrestricted (falls back to whatever their system role already grants). Reusing
that helper here would have let **any** `QA_ENGINEER` approve **any** project that simply has no members
configured yet — most existing projects, per section 10's own note — which is far broader than "a
QA_ENGINEER who is specifically this project's Reviewer/Project Lead/Owner."

**Fix — `deps.py`:** rewrote `can_review_repository(db, project_id, current_user)` to check membership
directly instead of going through `_project_role_permits`: system `QA_LEAD`/Admin always pass
(`current_user.has_role(Role.QA_LEAD)`, which already bypasses for Admin); anyone else must be an actual
`TestProjectMember` of that project with `project_role` in `{"Reviewer", "Project Lead", "Owner"}` — a
non-member gets no fallback at all. Same reasoning, and structurally the same shape, as section 8's CYC-007
`_require_scope_change_permission` exception. `require_can_review_repository`'s 403 message updated to
describe both paths. The "Role -> capability mapping" comment block updated to call out this one exception
explicitly, so it doesn't get silently re-broken by a future change that assumes every capability here
follows the same backward-compatible pattern.

**Fix — `test_repository.py`:** relaxed the router-level dependency on all six endpoints listed above from
`require_roles(Role.QA_LEAD)` to `require_roles(*_AUTHOR_ROLES)` (the existing `(Role.QA_ENGINEER,
Role.QA_LEAD)` tuple already used for authoring endpoints) — this only admits `QA_ENGINEER` past the door;
the real, now-corrected restriction is the existing `require_can_review_repository(...)` call already inside
each function body. Docstrings updated to describe both qualifying paths. GOV-002 self-approval blocks
(`review_test_case`, `bulk_approve_test_cases`) were not touched and remain unconditional regardless of role.

**Fix — `test_projects.py`:** no code change needed — the `can_review_repository` flag it surfaces to the
frontend calls the same function, so it picked up the corrected (wider but still membership-gated) semantics
automatically.

**Fix — `frontend/src/modules/test-management/TestRepository.tsx`:** `canReview`/`canDeleteFolder` were
independently gating on `hasRole(user, 'QA_LEAD')` client-side, which would have kept hiding these buttons
from a `QA_ENGINEER` regardless of what the corrected backend flag said. Changed both to
`hasRole(user, ...CAN_AUTHOR_ROLES)` (matching `canAuthor`'s existing pattern) so the frontend defers to the
`myAccess.can_review_repository` flag instead of independently re-blocking the same role. One info-banner
string ("A QA Lead/Administrator can override the checkout above") corrected since it's no longer accurate
about who can act. `TestProjects.tsx`'s own, unrelated `canReview` (gating project archive/activation
approval, which stays system-`QA_LEAD`-only by design) was confirmed untouched — out of scope for this fix.

**Also updated:** `TEST_MANAGEMENT_PERMISSIONS.md` — the Repository action matrix and a new explicit
exception note in "The backward-compatible rule" section, since this is the second deliberate exception to
that rule (after CYC-007) and needed to be documented as clearly as the first one already was.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Given the maker-checker/production-banking context, dispatched an independent research subagent to
re-verify the change by reading the actual code rather than trusting this description — confirmed: the
non-member rejection path works correctly, all six endpoints correctly pair the relaxed router gate with the
unchanged strict internal check, GOV-002 self-approval logic is untouched, no other endpoint elsewhere in
the app was accidentally widened, and no stale frontend role checks remain. No bugs found. Documents and
outputs copies re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`logs` exclusions
differ).

## 17. Test Approval Workflow refactor — strict two-stage review (Reviewer recommends, QA Lead gives final approval), Returned/Rejected states, per-item assignment, in-app notifications

**Source:** `Test_Approval_Workflow_Requirements.docx` (QA Governance Specification, uploaded directly),
treated as the sole source of truth for this refactor per explicit instruction — implement it precisely and
completely rather than litigate whether any individual gap was "technically" pre-existing behavior.

**What changed, and why each choice was made:**

1. **Two-stage decision chain, not one.** The old single-stage flow let anyone with review-tier rights
   (project role Reviewer/Project Lead/Owner, or system QA_LEAD/Admin — section 15 above) both recommend
   *and* finalize a test case in one action. The spec requires a Reviewer to recommend and a QA Lead to give
   *separate, final* approval — a Reviewer alone can never reach Approved. Implemented as a new, strictly
   narrower gate: `deps.can_give_final_approval`/`require_can_give_final_approval` (project role **Project
   Lead**/**Owner** only, or system QA_LEAD/Admin — deliberately excludes plain **Reviewer**, same
   strict-membership pattern as `can_review_repository`, no non-member fallback). `review_test_case` now
   branches on the draft's current status: `In Review` only accepts `RECOMMEND`/`RETURN` under
   `require_can_review_repository` (Stage 1); `Review Completed` only accepts `APPROVE`/`RETURN`/`REJECT`
   under `require_can_give_final_approval` (Stage 2). Self-approval stays blocked at both stages (GOV-002).
2. **Status vocabulary grew from 5 to 7 values** (`constants.TEST_CASE_STATUSES`): `Draft, In Review, Review
   Completed, Returned, Approved, Rejected, Archived`. `"Rework Required"` is renamed `"Returned"` to match
   the spec's exact wording (mechanically identical — author edits in place, resubmit moves back to `In
   Review`); backfilled by `test_management_migration.py::_migrate_rework_required_status_name` (idempotent,
   same pattern as the section-14 Project Lead rename). `Review Completed` is new (Stage-1 recommended,
   awaiting Stage-2). `Rejected` is new and **terminal**: QA-Lead-only, mandatory comment, blocks hard delete
   (same tier as Approved/Archived), blocks cycle-add and blocks a cycle's Ready transition (see point 4) —
   but is not frozen from ever progressing again: editing a Rejected version spins a **new Draft** off its
   content rather than mutating it in place, the same mechanic already used for editing an Approved baseline,
   so the rejected version itself stays immutable/readable for traceability while still letting the author
   get back on track.
3. **Per-item and per-project assignment (APR-001), routing-only.** `TestProject` gained
   `default_reviewer_id`/`default_qa_lead_id`; `TestCaseVersion` gained `assigned_reviewer_id`/
   `assigned_qa_lead_id` (defaulted from the project on submission, overridable per item via the new `PATCH
   /test-repository/test-cases/{id}/approvers`, Author-tier). This is deliberately **not** an authorization
   gate — anyone holding the right project role can still act regardless of assignment; it only decides the
   default notification target and the "Pending with" display (`TestCaseOut.pending_with_user_id/name`,
   `TestCaseVersion.pending_with_user_id/name`, computed from current status). Confirmed by the independent
   review pass below that the auth checks never consult these fields.
4. **Cycle readiness validation (spec section 7).** `test_execution.py::_validate_cycle_ready` now checks all
   5 conditions before a cycle may transition into `Ready` — wired into `update_cycle` so it validates the
   **fully-updated** cycle object (after link changes in the same request), not stale pre-update
   state; a `Rejected` test case in the cycle is one of the blocking conditions.
5. **In-app notifications (spec section 10).** New `Notification` model + `routers/notifications.py`
   (`fire()`, `sweep_overdue_approvals()` for configurable reminder/escalation business-day thresholds,
   default 2/5, Admin-configurable via `GET/PATCH /system-settings/approval-notifications`). **In-app only —
   no email/SMTP delivery exists anywhere in this app**, confirmed by a repo-wide search before building
   this; going further was explicitly declined by the user in favor of shipping the rest of the spec first.
   The sweep runs once at backend startup (no scheduler/cron infrastructure exists), so the reminder/
   escalation clock effectively only advances on backend restart, not continuously in real time — a known,
   documented limitation, not a bug.
6. **Audit trail (APR-005).** `ApprovalAction` gained optional `previous_state`/`new_state` columns
   (additive, nullable), populated only by Test Case workflow calls — NULL on every other entity type's rows,
   which is expected, not a gap.
7. **Pending Approvals aggregator (APR-007).** `pending_approvals.py`'s own docstring had explicitly flagged
   Test Case review as a deliberately excluded gap. Closed it with `_test_case_items`, gated by the exact
   same `can_review_repository`/`can_give_final_approval` calls `review_test_case` itself uses — not a
   parallel/approximate mechanism.
8. **`review_sla` report bug caught proactively.** After the two-stage split, this report's existing query
   only covered `status == "In Review"`, which would have silently missed every `Review Completed` item —
   roughly half the real pending population, and a direct, silent correctness consequence of the schema
   change. Fixed to cover both statuses with a `stage`/`pending_with` field per row before it ever shipped
   broken.
9. **Deferred by explicit user choice, not an oversight:** delegation (APR-012) — build everything else
   first; emergency self-approval override stays hard-blocked with no configurable toggle, matching current
   behavior exactly.
10. **Frontend** (`TestRepository.tsx`, `TestProjects.tsx`, `Common.tsx`, new `NotificationBell.tsx`,
    `Layout.tsx`, `Admin.tsx`): stage-aware review modal with explicit action labels (Recommend Approval /
    Approve & Activate / Return for Correction / Reject) and confirmation copy stating the resulting status
    and next owner (spec section 9), mandatory-vs-optional comment enforcement (Return/Reject mandatory,
    Recommend/Approve optional), a new `canGiveFinalApproval` permission flag defaulting **closed** (unlike
    the app's other permission flags, which default open while `myAccess` is still loading — deliberately
    conservative since this is a strictly higher-trust gate), per-item Reviewer/QA Lead reassignment UI,
    dual Stage-1/Stage-2 decision columns in version history, a "Pending with" column preferring the real
    assignee over the generic role label, an in-app notification bell (unread count, mark-read/mark-all,
    deep-links into Test Repository), and an Admin settings card for the reminder/escalation thresholds.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Given the production-banking, authorization-sensitive nature of this change, dispatched an independent
review subagent (no prior context, told to be skeptical) to re-read the actual authorization code rather
than trust this description. Findings: **no authorization/security bugs**, **no correctness bugs** — every
claim above (Stage-2 gate narrowness, self-approval blocking at both stages, Rejected immutability/terminal
status, `pending_approvals` gate parity, assignment being non-authoritative, migration idempotency) was
independently confirmed by reading the code. Only cosmetic notes were raised (reassignment doesn't validate
the target user's project role, since it's non-authoritative; the frontend doesn't pre-hide review buttons
from an author reviewing their own work, relying on the backend's existing 403). Documents and outputs
copies re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`logs` exclusions differ).

## 18. Test Management user pickers scoped to a configurable department list, not a hardcoded COE - Quality Assurance check per site

**Reported:** "everywhere in test management whenever asking for users/members just show only user from
COE - Quality Assurance, and make as list, so that in future if I want to add any other team like TCS-QA along with COE - Quality Assurance
that can work, rather than long code change."

**Before:** every Test Management user picker (Project owner, Project members, default Reviewer/default QA
Lead, per-item Reviewer/QA Lead reassignment, Cycle owner, runner assignment) fetched the app-wide `GET
/api/auth/users` — the same unfiltered list every other module (SAST/DAST/Functional/Performance/
Suppression/Sign-off/QA Requests/Approvals) uses, since those modules legitimately need users outside
COE - Quality Assurance (Requesters, Department Heads, Business Analysts, etc.). Separately, `test_execution.py`'s runner
eligibility check (`_runner_or_404`) and its assignment-manager gate (`_require_qa_assignment_manager`) each
hardcoded a single `!= QA_DEPARTMENT` comparison.

**Fix:**
- `constants.py`: new `TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS = [QA_DEPARTMENT]` — a list, not a single
  string, positioned right next to `QA_DEPARTMENT` with a docstring explaining it's the one place to widen
  Test Management to another team later (e.g. append `"TCS-QA"`).
- `test_projects.py`: new `GET /api/test-projects/eligible-users` — same shape as `GET /api/auth/users`
  (`schemas.UserOut[]`), filtered to `User.is_active == True` and `User.department.in_(TEST_MANAGEMENT_
  ELIGIBLE_DEPARTMENTS)`. Declared in `test_projects.py` since it's already "the single entry point every
  Test Management screen picks a project from" (see `list_test_projects`'s own docstring) — same
  reasoning extends to picking a user.
- `test_execution.py`: `_runner_or_404` and `_require_qa_assignment_manager` now check membership in
  `TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS` instead of equality against the single `QA_DEPARTMENT` constant.
  Their user-facing error messages were also de-hardcoded from "COE - Quality Assurance" to generic "Test Management team"
  wording so they don't go stale the moment a second department is added.
- Frontend (`TestProjects.tsx`, `TestRepository.tsx`, `TestExecution.tsx`): all three user-list fetches
  switched from `/api/auth/users` to `/api/test-projects/eligible-users`. No other module's user pickers
  were touched — they still intentionally see the full user list.

**Net effect:** adding a second team later is a one-line change (`TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS =
[QA_DEPARTMENT, "TCS-QA"]`) — every Test Management picker and both runner-eligibility checks pick it up
automatically, with no per-screen or per-endpoint code change. Behavior today is unchanged (the list still
contains only `"COE - Quality Assurance"`), so this is a pure refactor, not a behavior change, for existing users.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`logs` exclusions differ).

## 19. Fixed "can't compare offset-naive and offset-aware datetimes" -- shared `models.as_aware()` helper

**Reported:** a live traceback --
```
File ".../app/routers/test_reports.py", line 396, in project_portfolio
    if not cycle.created_at or cycle.created_at < six_months_ago:
TypeError: can't compare offset-naive and offset-aware datetimes
```

**Root cause:** every `created_at`/`submitted_at`/`reviewed_at`/etc. column in this app is a plain
`Column(DateTime)` (no `timezone=True`) written via `models.now()`, which returns a timezone-**aware** IST
datetime -- but on Oracle (and most other backends) a plain `DateTime` column round-trips values as
**naive** on read, silently dropping the tzinfo the row was written with. Any later `now() -
some_row.created_at`, or `some_row.created_at < some_now_derived_value`, mixes an aware value with a naive
one and raises exactly this error -- only once live data actually exists old enough to be compared, which
is why it survives `py_compile`/`tsc` and even manual testing against an empty database.

This exact class of bug had already been hit and fixed once before, in `dashboard.py`'s own `_age_days`
helper (its comment already documented the cause) -- but that fix was local to `dashboard.py` and never
extracted, so the same mistake reappeared independently in three more places:
- `test_reports.py::repository_health` -- `(now - case.created_at).days` (average testcase age)
- `test_reports.py::review_sla` -- `(now - (since or version.created_at)).days` (pending-review age/breach)
- `test_reports.py::project_portfolio` -- `cycle.created_at < six_months_ago` (the one actually reported)
- `notifications.py::_business_days_between` -- `end <= start`, called by `sweep_overdue_approvals` at
  every backend startup once any testcase has been sitting `In Review`/`Review Completed` long enough

**Fix:** added `models.as_aware(dt)` -- a small shared helper next to `models.now()` itself -- that returns
`None` unchanged, an already-aware value unchanged, and attaches `Asia/Kolkata` tzinfo to a naive value
(treating it as already being in IST, which is what it actually is, since that's what `now()` wrote). All
four vulnerable call sites above now route through it, and `dashboard.py::_age_days` was refactored to call
the same shared helper instead of its own inline copy of the fix -- one implementation instead of four (and
counting), so the next place that does `now()`-based datetime math doesn't have to rediscover this the hard
way.

**Verified:** wrote a standalone repro isolating the exact bug (a naive datetime compared against a
`models.now() - timedelta(...)` value) -- confirmed it reproduces the reported `TypeError` without the fix,
and resolves cleanly with `as_aware()` applied. Grepped the entire `backend/app` tree for every remaining
`now()`-based subtraction/comparison against a database-sourced datetime to confirm no other site was
missed. `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean. Documents
and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`logs`
exclusions differ).

## 20. Defect Management (`defects.py`) had no department/project scoping anywhere -- traced and closed

**Reported:** "trace the defect management and debug is there any loophole, bug."

**What was found, tracing the whole module against the rest of the app's own established conventions:**

Every other module in this app scopes its list endpoints by department (`dashboard_department_scope`,
used by `qa_requests.py`, `functional.py`, `sast_dast.py`, `performance.py`, `suppression.py`,
`signoff.py`, `approvals.py`, `test_projects.py`, `test_reports.py`) and sources a new record's own
department from the creator's profile server-side rather than trusting client input
(`qa_requests.py::create_request`'s own comment: "Department is always sourced from the requester's own
user profile... ignore whatever the payload sent"). `defects.py` had none of this:

1. `list_defects`, `defect_dashboard`, `export_defects` -- completely unscoped. Any authenticated user of
   any role (Requester, Business Analyst, Application Owner -- not just QA staff) could browse, chart, or
   export every governed defect in the entire org, including steps-to-reproduce, API endpoints, and log
   details for defects with no connection to them at all.
2. `create_defect` -- accepted any client-supplied `qa_request_id` with zero check the caller had any
   relationship to it, unlike `create_request`'s explicit server-side department sourcing.
3. `create_defect` (when `execution_id` was supplied at creation time) and `link_defect_execution` (the
   dedicated endpoint) both gated on `has_role(*CREATE_ROLES)` -- a broad set of common system roles
   (QA_ENGINEER, QA_LEAD, Chief Manager QA, Security Analyst, Requester, Business Analyst, Application
   Owner) -- OR'd against a project-membership check, but the broad role check alone was enough to pass
   regardless of project or department, so the membership check barely restricted anyone. `create_defect`'s
   own execution-linking path additionally had NO authorization check at all -- the check only existed on
   the separate `link-execution` endpoint, so linking at creation time was an unchecked bypass of it.
4. `upload_attachments` -- only ever blocked uploads once a defect was `Closed`; for every other status, any
   authenticated user (no relationship to the defect, its project, or its department) could attach files to
   it, unlike every sibling module's own `_can_upload_documents`-style gate.

**Fix:**
- New `_scoped_defects(db, current_user)` -- joins `Defect` to its always-present `QARequest` (Defect has no
  department column of its own) and applies `dashboard_department_scope`, same semantics as everywhere
  else. Wired into `list_defects`/`defect_dashboard`/`export_defects`.
- `create_defect` -- added the same `dashboard_department_scope` check against the target QA Request's
  department (QA/Security/Executive-COE roles and Admin stay unrestricted, matching their existing
  cross-department mandate; a Requester/BA/Application Owner may now only report defects against their own
  department's requests).
- New shared `_require_execution_link_access(db, cycle, current_user)` -- a Tester/Project Lead/Owner
  member of the specific project may always link (regardless of personal department, same override every
  other project-role check in this app grants); otherwise `has_role(*CREATE_ROLES)` AND the caller's
  department scope must include the execution's project. Called from BOTH `create_defect`'s inline linking
  path and `link_defect_execution`, closing the bypass.
- `upload_attachments` -- added `_can_touch_defect` (reporter, current assignee, retest tester, or a
  manager) alongside the existing Closed-status block.
- `models.gen_defect_id` -- unrelated smaller finding while tracing: its docstring said the format was
  "DEF-YYYY-NNNNN" and computed a `year` local that was never actually used, while the real returned value
  has always been `TQA-DEF-{n:05d}` (confirmed via full git history -- no committed version ever produced a
  year-based id). Fixed the docstring and dropped the dead `year` variable; no behavior change.

**Flagged, not changed (judgment calls for you to weigh in on, not clear-cut bugs):** (1) `_is_tester`
treats the original reporter as an eligible "tester" for the Retest/Closed transitions, and a defect's
`retest_tester_id` defaults to the reporter's own id when nothing else is supplied -- in the common case
this lets a reporter resolve, retest, and close their own defect with no independent verification, which
sits oddly next to this app's otherwise strict GOV-002 "no self-approval" convention (test case review,
sign-off) but may be intentional for a smaller QA team's self-testing workflow. (2) `_can_defer`'s
`Role.APPLICATION_OWNER` bypass isn't scoped to the specific application a defect belongs to -- but this
matches an app-wide limitation (Application Owner is a free-text field, not an FK-backed per-application
relationship, anywhere in this codebase), not a defects-specific regression, so it wasn't touched.

**Verified:** dispatched an independent, skeptical review subagent (no prior context) to re-check all five
changes against the actual diffs -- specifically stress-tested for the failure mode that matters most here
(a legitimate QA_ENGINEER/QA_LEAD/Tester wrongly blocked from acting outside their own department/project,
which would be a regression, not a fix) -- confirmed no such regression, all five changes correct.
`python3 -m py_compile app/*.py app/routers/*.py` clean. Documents and outputs copies re-synced and
confirmed identical via `diff -rq` (only the standard `.env`/`logs`/`uploads` exclusions differ).

## 21. Pending Approvals -- pending Test Cases now group under their Test Project, folder-wise, instead of each rendering as its own standalone card

**Reported (with a screenshot):** "In Pending Approval Section, Parent Section should be Project Name, the
Folder wise testcase segregation." Every pending Test Case review (e.g. TQA-TC-42/43/44) was rendering as
its own "STANDALONE REQUEST" card -- `_test_case_items` never set `parent_request_id`, so each one fell
through to the `PendingApprovals.tsx` grouping logic's standalone fallback (keyed by its own `display_id`)
instead of grouping with sibling test cases from the same project.

**Fix -- `backend/app/schemas.py`:** added two new optional fields to `PendingApprovalItem`:
`parent_label` (lets a category override the generic "Parent QA Request"/"Standalone Request" header wording
-- `None` keeps every existing category's display exactly as before) and `folder_name` (a second-level
grouping key inside a parent card, `None`/absent for every category except Test Case).

**Fix -- `backend/app/routers/pending_approvals.py`:** `_item()` helper extended to accept/return both new
fields; `_test_case_items` rewritten to populate `parent_request_id`/`parent_path` from the test case's own
`TestProject` (key + name, linking to that project in Test Repository) instead of leaving them unset,
`parent_label="Test Project"`, and `folder_name` from the case's folder (falling back to `"Unfiled"` for
cases not filed under any folder).

**Incidental bug fixed in the same pass:** the pre-existing `_test_case_items` deep link used
`f"/test-repository?project={case.project_id}&case={case.id}"` -- `case=` is not a query param
`TestRepository.tsx` ever reads (confirmed via grep -- only `project=` and `open=<test_case_key>` are
consumed), so clicking "Review" landed on the right project but never actually opened the specific test
case. Changed to `open={case.test_case_key}`, the actually-supported deep-link param.

**Fix -- frontend (`types.ts`, `PendingApprovals.tsx`):** `PendingApprovalItem` interface picks up the two
new optional fields. The existing parent-grouping `reduce` now also carries `parentLabel` per group. New
`folderBuckets(items)` helper sub-groups a group's own children by `folder_name` (every other category
leaves this null on every item, which collapses to a single unlabeled bucket -- i.e. today's flat list,
byte-for-byte unchanged for every non-Test-Case category). The group-card header now shows a "TP" icon and
"Test Project" label when `parentLabel === 'Test Project'`, else the original "PR"/"RQ" + "Parent QA
Request"/"Standalone Request" logic, untouched. The children list now renders `folderBuckets()`'s buckets in
order, each preceded by a folder sub-heading (skipped when the bucket key is empty), with the tree-branch
connector (`└`/`├`) computed per-bucket instead of across the whole group. Page subtitle updated to mention
Test Project/folder-wise grouping. New CSS (`frontend/src/index.css`): `.pending-approval-folder-heading`
(+ `-icon`/`-count`), matching the existing `.pending-approval-*` visual conventions in the same file.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`logs`/`uploads` exclusions differ).

## 22. Fixed `ORA-00001` on `UQ_QAP_DEF_CASE` -- create_defect could insert the same DefectTestCaseLink twice in one request

**Reported (live traceback):** `IntegrityError ... ORA-00001: unique constraint (QA_PORTAL.UQ_QAP_DEF_CASE)
violated ... row with column values (DEFECT_ID:21, TEST_CASE_ID:101) already exists`, raised from a single
`INSERT INTO qap_defect_case_links ... executemany` call whose own parameter list contained **two** rows
with the identical `(defect_id, test_case_id)` -- i.e. the same request tried to insert the same link twice
against itself, not against a pre-existing row.

**Root cause:** `database.py`'s `SessionLocal` runs with `autoflush=False` app-wide. In
`defects.py::create_defect`, when a defect is created with an execution link (`execution_id`/`cycle_id`/
`test_case_id` all supplied together, the normal "report a defect straight from a failed/blocked execution"
path), the primary `test_case_id` is always included in `case_ids` (prepended before dedup), so:
1. The `case_ids` loop (`for case_id in case_ids: db.add(DefectTestCaseLink(...))`) `db.add()`s a link row
   for the primary test case -- pending, not flushed.
2. `_link_to_execution` is then called, whose own "does this link already exist?" logic ran
   `db.query(DefectTestCaseLink).filter_by(defect_id=..., test_case_id=...).first()` -- because autoflush
   is off, this query never saw step 1's still-pending insert, so it found nothing and `db.add()`ed a
   second, byte-for-byte-identical row for the same `(defect_id, test_case_id)`.

Both pending inserts sat in the session together until the final `db.commit()` flushed them in one batch,
at which point Oracle's `UQ_QAP_DEF_CASE` constraint (unique on `defect_id, test_case_id`) rejected the
duplicate -- every defect reported directly from a failed/blocked Test Execution hit this 500 error.

**Fix -- `backend/app/routers/defects.py`:** new shared `_ensure_case_link(db, defect_id, test_case_id)`
helper -- checks the session's own pending `db.new` objects for a matching `DefectTestCaseLink` first
(catches the same-request, not-yet-flushed case that a DB-only query misses under `autoflush=False`), then
falls back to the existing DB query (catches a link created in an earlier, already-committed request).
Replaced both ad hoc "check then add" call sites -- the `case_ids` loop in `create_defect` and the
inline check inside `_link_to_execution` -- with calls to this one helper, so neither can add a duplicate
regardless of call order or how many times it's invoked in the same request.

**Follow-up sweep:** dispatched a dedicated research pass across the rest of the backend for the same bug
class -- any "query to check existence, then `db.add()`" guard where a matching row could plausibly already
be `db.add()`-ed-but-unflushed earlier in the same request, given `autoflush=False` app-wide. Found one more
real instance: `test_projects.py::_ensure_default_member_role` is called twice per request (once for the
default Reviewer, once for the default Project Lead/CM-QA) from both `create_test_project` and
`update_test_project`, with no flush between the calls. Nothing prevents both defaults from being set to the
same user, and when they are (and that user isn't already a project member), the same duplicate-insert
pattern hits `TestProjectMember`'s `uq_qap_tpm_project_user` constraint. Fixed the same way -- the helper now
checks `db.new` for a matching pending `TestProjectMember` before querying the DB, upgrading the pending
object's `project_role` in place (respecting the existing Owner/Project-Lead protected-role rule) instead of
adding a second row. Every other "check then add" site in the codebase was traced and confirmed safe (roles
sync in `auth.py` explicitly flushes between delete and re-add; `test_execution.py`'s attempt/defect-link
helpers flush internally or operate on a fresh per-iteration key; `checklist_config.py` is already hardened
with a SAVEPOINT + `IntegrityError` catch; tag/version/step handling elsewhere uses relationship-collection
replacement, not manual check-then-add).

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`logs`/`uploads` exclusions
differ).

## 23. Fixed defect assignment showing only QA-team users regardless of the selected Department

**Reported:** "select responsible user based on Department while assigning defect, currently showing QA team
user which is not correct."

**Root cause:** `frontend/src/modules/test-management/Defects.tsx` fetched its `users` list from
`/api/test-projects/eligible-users` -- the Test Management picker introduced in section 1 of this log's IT-QA/
TCS-QA config work, which is deliberately restricted to `TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS` (currently just
`"IT - QA"`). `TransitionModal`'s "Assigned" step used that same fixed IT-QA-only list for its Assignee
picker regardless of what the adjacent "Department" field was set to -- so routing a defect to, say,
Development still only ever offered QA team members as the responsible user. The backend transition endpoint
itself (`defects.py::transition_defect`) was never the problem -- it already accepts any active user id for
`assignee_id` with no department restriction; the bug was entirely in which candidates the frontend offered.

**Fix -- `Defects.tsx`:**
- Switched the fetch from `/api/test-projects/eligible-users` to `/api/auth/users` (the full active-user
  directory across every department, already used this way elsewhere in the app -- see its own docstring,
  "used throughout the app for pickers"), since `users` in this file is only ever consumed by the defect
  Assignee picker, not anything Test-Management-specific.
- `TransitionModal`: reordered the "Assigned" fields so **Department is chosen first**, then added a
  `departmentUsers = values.assigned_team ? users.filter(u => u.is_active && u.department === values.assigned_team) : []`
  derivation, passed to `UserAssignSelect` instead of the full list. Picking a department now clears any
  previously chosen assignee (`set('assignee_id', null)` on department change) so a stale cross-department
  selection can never be silently submitted. The Assignee control is disabled with a "Select a department
  first…" placeholder until a department is chosen.

**Verified:** `npx tsc --noEmit -p .` clean. Documents and outputs copies re-synced and confirmed identical
via `diff -rq` (only the standard `.env`/`logs`/`uploads` exclusions differ).

## 24. Functional Testing Request workflow -- Mark QA Complete now waits on the linked Test Cycle; manual Defect/Retest stages retired once a cycle is linked

**Reported:** "after test design, while start execution is asking for linking test cycle, until cycle marked
as complete, Mark QA Complete should not be allowed, and other stages like raise defect, start retest
currently not required as everything is linked with test cycle, so design based on the current process."

**Context:** Start Execution (`functional.py::start_execution`) already offers linking a Test Cycle
(`payload.link_test_cycle`/`test_cycle_id`), and still supports starting without one. Once execution/defect/
retest work moves into a linked Test Cycle, it's tracked there via Test Execution and the Defects module
(both already scoped to the cycle) -- so Functional Request's own parallel Defect Raised -> Waiting For Fix
-> Retesting states, and its `complete_qa` gate (which previously only checked the request's own status, not
whether the cycle it's linked to had actually finished), were both out of step with how testing is really
being run now.

**Fix -- `backend/app/routers/functional.py`:**
- `complete_qa`: new gate -- every `TestCycle` linked to the request (`obj.linked_test_cycles`) must have
  `status == "Completed"` before Mark QA Complete is allowed; blocked with a 400 naming every still-open
  cycle and its status. A request that was started without linking a cycle has nothing to wait on and keeps
  its existing behavior unchanged.
- New `_require_no_linked_cycle_for_manual_defect_flow(obj, action)`, called from `raise_defect`: once a
  Test Cycle is linked, Raise Defect is rejected with a 400 pointing at Test Execution / the Defects module
  instead. `mark_waiting_for_fix`/`start_retesting` are left as-is (no new gate) -- they're only reachable via
  `raise_defect`, which is now itself blocked once linked, so this one entry-point check is sufficient; a
  request already legitimately sitting in `DEFECT_RAISED`/`WAITING_FOR_FIX` from before this change (or from
  the still-supported unlinked path) is not stranded.
- `QAStatus.DEFECT_RAISED`/`WAITING_FOR_FIX`/`RETESTING` and their transition endpoints are left in place,
  not deleted -- still the only defect-tracking mechanism for a request that was deliberately started without
  a linked cycle, and still needed to let any already-in-flight legacy request finish its own history.

**Fix -- `frontend/src/modules/functional/Functional.tsx`:**
- `canRaiseDefect` now also requires no linked Test Cycle (`hasLinkedCycle`), mirroring the backend gate --
  the button no longer appears once a cycle is linked. `canMarkWaitingForFix`/`canStartRetest` untouched
  (same reasoning as the backend: unreachable going forward once linked, but not stranding legacy rows).
- `canCompleteQA` now also requires zero `openLinkedCycles` (linked cycles not yet `"Completed"`). Added a
  `completeQABlockedByCycle` banner (same inline-style convention as the existing "Cannot Sign/Approve yet"
  block) naming the still-open cycle(s) and pointing at Test Execution / the Defects module, so a blocked
  tester sees why rather than just losing the button.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`logs`/`uploads` exclusions differ).

## 25. Test Execution -- 'Pass' blocked once a defect is linked; 'Retest Passed' requires it to be Deferred or Closed first

**Reported:** "if Deferred or Closed then only linked testcase can be mark as retest pass, and if defect
linked then Pass option should be blocked."

**Design:** for a given `TestExecution` slot, its linked governed Defect(s) (defects.py, not the free-text
per-attempt `TestRunDefect`) are every `Defect` row with `execution_id` pointing at that slot. Two rules,
checked only against `Pass`/`Retest Passed` (Fail/Blocked/NA untouched):
- If any defect is linked at all, `Pass` is blocked outright, regardless of that defect's status --
  `Retest Passed` is the only route back to a passing result once a defect has ever been linked.
- `Retest Passed` additionally requires every linked defect to be `Deferred` or `Closed` -- any defect still
  in New/Assigned/In Progress/Resolved/Retest/Reopened blocks it.
- **Flagged, not decided:** `Rejected`/`Duplicate` are also terminal governed-defect statuses but were
  deliberately left OUT of the "clears Retest Passed" set, since the request named "Deferred or Closed" only
  -- worth confirming whether a Rejected/Duplicate defect should also unblock retesting, or whether that's
  intentionally meant to force a manual unlink/re-triage first.

**Fix -- `backend/app/models.py`:** new `TestExecution.linked_defects` viewonly relationship (every `Defect`
with `execution_id` pointing at this slot) -- one-directional, no `back_populates`, deliberately matching the
existing `FunctionalRequest.test_cycle_links` pattern in this same file (a `viewonly=True`/`primaryjoin`
relationship paired with `back_populates` against a writable relationship was avoided as an untested
combination this sandbox has no way to verify against a live mapper configuration -- no network access to
install sqlalchemy locally, so this was checked by close reading against the codebase's own already-working
precedent rather than a live `configure_mappers()` run).

**Fix -- `backend/app/routers/test_execution.py`:** new `_defect_gate_violation(db, execution_id,
status_value)` -- returns a reason string or `None`. Wired into `_prepare_execution_update` (covers both
`update_execution` and `update_rich_execution_result`, the two single-slot result-recording endpoints) and
into `bulk_update_execution_results` (checked for the whole selection up front, consistent with that
endpoint's existing "validate everything before writing anything" convention -- reports every blocked
testcase by key in one combined error rather than a partial bulk save).

**Fix -- `backend/app/schemas.py`:** new `LinkedGovernedDefectRef` (`id`, `defect_key`, `status`), added as
`TestExecutionOut.linked_defects` so the frontend can pre-emptively disable the blocked option and explain
why, without waiting on a round-trip 400.

**Fix -- frontend:** new `defectGateViolation(linkedDefects, status)` in `constants.ts` (mirrors the backend
helper exactly, same excluded-Rejected/Duplicate caveat), added `TestExecutionOut.linked_defects` /
`LinkedGovernedDefectRef` to `types.ts`. Wired into every place a result can be recorded: `TestExecution.tsx`'s
`InlineExecutionActions` (quick-run buttons) and its "Log New Attempt" form (`<select>` options), its
`BulkExecutionModal` (blocks advancing past Review with a combined error naming every blocked testcase, same
shape as the backend's), and `MyExecutions.tsx`'s `QuickResultActions`. New `.tm-inline-defect-gate-note` /
`.tm-inline-result-options button:disabled` CSS in `index.css`, matching this module's existing `.tm-inline-*`
conventions.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean. The
new SQLAlchemy relationship itself could not be exercised against a live mapper/DB in this sandbox (no
network to install sqlalchemy, no Oracle connection) -- worth watching `backend/logs/app.log` on the next
restart for any mapper configuration error, though the pattern used has a working precedent already running
elsewhere in this exact file. Documents and outputs copies re-synced and confirmed identical via `diff -rq`
(only the standard `.env`/`logs`/`uploads` exclusions differ).

## 26. Defect Reopen (from Closed) now also allowed for the reporter, not just a lead

**Reported:** "Defect Reopen option should be enabled for reporter as well."

**Context:** `defects.py::transition_defect`'s `Reopened` branch already allowed the assigned tester (reporter/
retest_tester/execution's assigned runner, via `_is_tester`) or a manager to reopen a defect sitting in
`Retest` -- but reopening from `Closed` specifically was restricted to `QA_LEAD`/`CHEIF_MANAGER_QA` (Admin
bypasses `has_role` regardless), excluding the reporter even though they're exactly who'd notice a "fixed"
defect still reproducing.

**Fix -- `backend/app/routers/defects.py`:** the `Closed` branch of the `Reopened` check now also allows
`obj.reporter_id == current_user.id`. Deliberately scoped to just the reporter, not the full `_is_tester` set
(retest_tester/execution's assigned runner) -- those roles are specific to one retest cycle and may no longer
be current by the time a Closed defect resurfaces, whereas the reporter is a stable, always-relevant party.

**Fix -- `frontend/src/modules/test-management/Defects.tsx`:** `allowedTransitions`'s `Reopened` case mirrors
the same rule -- `defect.reporter_id === user?.id` now also unlocks the button when `defect.status ===
'Closed'`.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`logs`/`uploads` exclusions differ).

## 27. Test Execution -- a second, separate defect can no longer be linked to an attempt that already has one

**Reported:** "testcase already failed, and defect also linked, then why again allowing to marked failed."
Clarified via follow-up (options offered): the concern is linking a **second, separate** defect to the same
already-linked attempt, not recording a fresh Fail on a genuinely new attempt (retest) -- that stays allowed,
since it's the normal "retested after a fix, still broken" path and already produces its own separate
`TestExecutionRun`.

**Root cause:** both defect-linking paths only ever checked for a duplicate of the *same* defect key on a
run, not whether the run already had *any* defect linked:
- `test_execution.py::_link_defect` (used by `update_execution`'s inline linking, `bulk_update_execution_
  results`, `update_rich_execution_result`, and `add_run_defect` -- the "Link existing"/"Link external"
  actions) checked `TestRunDefect.filter_by(run_id=run.id, defect_key=key)`.
- `defects.py::_link_to_execution` (governed Defect creation/linking against an execution) checked
  `TestRunDefect.filter_by(run_id=latest_run.id, defect_key=obj.defect_key)`.

Either path let a different defect key be linked to the same attempt with no limit -- nothing stopped two,
three, or more separate defects piling up on one Fail/Blocked attempt.

**Fix:** both now query `TestRunDefect.filter_by(run_id=...)` (no `defect_key` filter) first. If a link
already exists for a *different* key, the request is rejected with a 400 naming the already-linked defect and
pointing at recording a new attempt instead. Re-linking the *exact same* key stays a clean no-op in
`_link_to_execution` (idempotent, matches its pre-existing behavior) and a clear "already linked" error in
`_link_defect` (matches its own pre-existing behavior for that case).

**Fix -- frontend:** `TestExecution.tsx`'s `InlineExecutionActions.latestCanLinkDefect` and `MyExecutions.
tsx`'s `QuickDefectLink` both now also require the latest run to have zero `defects` before offering "Raise
defect"/"Link existing"/"Link external" -- the already-linked defect remains visible in Attempt History
either way, so hiding the buttons doesn't hide the information, just the now-blocked action.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`logs`/`uploads` exclusions differ).

## 28. Test Execution -- full lock while a linked defect is active; permanent Pass/N/A block after any Fail; repeat Fail requires a defect action (supersedes section 25's simpler gate)

**Reported, as a complete spec** (full acceptance-criteria text supplied): while any linked defect is not
Closed/Deferred, the execution shall stay locked (status frozen, every result option disabled, blocked
through UI/API/bulk, linked defect id + status + an explanatory message shown). Once every linked defect
clears, the slot unlocks for retesting: Retest Passed enabled, Fail still enabled (may fail again), Pass/N/A
permanently disabled, Blocked available for a fresh blocker. Once a slot has failed at least once, plain
'Pass' is gone for the rest of its history -- success is always 'Retest Passed' from then on. If it fails
again, the tester must reopen the existing defect, link another active one, or create a new one before that
Fail can be recorded, and the slot re-locks. This fully supersedes section 25's narrower rule (which only
blocked Pass/Retest Passed based on a linked defect's status) -- section 27 (blocking a second defect on the
same attempt) stays valid and complementary, since the full lock below doesn't touch the free-text quick-link
mechanism's own per-run dedup.

**Design decisions made explicit (asked via follow-up, and flagged rather than guessed where genuinely
open):**
- The lock/gate is driven by **governed Defects only** (`models.Defect.execution_id`), not the free-text
  quick-link `TestRunDefect` -- consistent with section 25 and this whole session's governed-Defect-Management
  focus.
- A repeat Fail's required "reopen/link/create a defect" action is enforced by requiring the payload's
  `defect_key` to resolve to an **existing governed Defect that is not itself Deferred/Closed** -- i.e. the
  tester must have already reopened it (or linked/created a different active one) in Defect Management
  *before* coming back to record this Fail. Deliberately **not** auto-reopened from inside
  `test_execution.py` -- that would mutate `defects.py`'s own `Defect.status` state machine and audit trail
  as a side effect of an execution save, a bigger and riskier change than this endpoint owning. Flagged to
  confirm this manual-first-then-record order matches intent, versus an auto-reopen-on-relink alternative.
- "Prevent status modification through imports" -- traced; `test_repository.py::import_test_cases` declares
  an `imported_executions` counter but never actually imports execution results anywhere in its code (dead/
  reserved field, confirmed by grep) -- no real import path exists today to gate.

**Fix -- `backend/app/routers/test_execution.py`:**
- New `_execution_lock_state(db, execution_id)` -- returns `(active_defects, has_prior_fail)`:
  `active_defects` is every governed Defect on this slot not in `_DEFECT_RETEST_CLEAR_STATUSES` (`Deferred`,
  `Closed`, unchanged from section 25); `has_prior_fail` is whether any `TestExecutionRun` on this slot was
  ever `Fail`.
- New `_execution_status_gate(db, execution_id, status_value, defect_key="")` -- replaces section 25's
  `_defect_gate_violation` entirely. `active_defects` non-empty -> blocks every status
  (Pass/Fail/Blocked/NA/Retest Passed), naming the defect(s) and quoting the reported message. Otherwise, if
  `has_prior_fail`: `Pass`/`NA` permanently blocked; `Fail` requires `defect_key` to resolve to a governed
  Defect that isn't Deferred/Closed (three-tier error: no key given / key not a known defect / key still
  Deferred-or-Closed); `Retest Passed`/`Blocked` unrestricted.
- Wired into all three result-recording endpoints: `_prepare_execution_update` (now takes `defect_key`,
  covering `update_execution` and `update_rich_execution_result` -- both reordered to compute `defect_key`
  *before* calling it, so the gate can see it) and `bulk_update_execution_results` (per-execution loop,
  combined error naming every blocked testcase, same all-or-nothing convention as section 25/27).

**Fix -- `backend/app/schemas.py` / `models.py`:** no schema changes needed -- section 25's
`TestExecutionOut.linked_defects` (all governed Defects on the slot, with status) already carries everything
this gate needs; `has_prior_fail` is derived from the existing `runs` history. Docstrings on
`LinkedGovernedDefectRef` and `TestExecution.linked_defects` updated to describe the fuller rule and point at
the renamed `_execution_status_gate`.

**Fix -- frontend:** `constants.ts`'s `defectGateViolation` replaced with `executionStatusGate(linkedDefects,
runs, status, defectKeyInput?)`, mirroring the backend exactly (the "does defectKeyInput resolve to an active
governed Defect" sub-check can't be done client-side without a round trip -- that part is server-authoritative
only, same limitation as every other client-side gate in this app). Wired into every result-recording site:
`TestExecution.tsx`'s `InlineExecutionActions` quick-run buttons, its "Log New Attempt" form (`<select>`
options plus the Defect Key field's label switching between "Optional" and "Required" once a repeat Fail is
selected), its `BulkExecutionModal`, and `MyExecutions.tsx`'s `QuickResultActions`. Added a prominent
`info-banner` (not just a disabled-button tooltip) to the execution detail modal, quoting the exact reported
lock message when a defect is active, and the exact reported "please retest" message once it clears --
"Display an explanatory message to the tester" was one of the explicit requirements, not just an
implementation detail.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`logs`/`uploads` exclusions differ).

## 29. Defect creation form -- screenshots could not be attached

**Reported:** "in Defect form screenshots upload not working though there are fields which support rich
text." Root cause: `Defects.tsx`'s `CreateDefectModal` explicitly passed `allowImages={false}` to all three
`JiraRichTextField` instances (Steps to Reproduce / Actual Result / Expected Result), which strips the
component's image button, hidden file input, and paste-a-screenshot handler entirely -- text formatting
(bold/lists/tables/links) still worked, which is why it looked like "rich text works, screenshots don't."
The only working screenshot path was the separate "+ Add evidence" uploader, which only exists in the defect
detail view (`DefectDetail`) -- i.e. only reachable after the defect had already been saved once, with no
equivalent on the create form itself. Confirmed the same `JiraRichTextField` component's image support works
correctly elsewhere in the app (Test Execution's Actual Result field, defect comments) -- this was a feature
flag left off on this one form, not a broken upload pipeline.

User confirmed, when asked, that both fixes were wanted together: inline paste-a-screenshot in the rich-text
fields, AND the "+ Add evidence" picker surfaced directly on the create form (not just after first save).

**Fix -- frontend only, `Defects.tsx`'s `CreateDefectModal`:**
- All three `JiraRichTextField` instances now default to `allowImages={true}` (dropped the explicit `false`)
  with real `onImagesChange` handlers (`stepsImages`/`actualImages`/`expectedImages`), matching Test
  Execution's own field exactly.
- Added an "Evidence & Attachments" block to the create form itself (same `.defect-evidence`/`.defect-files`
  styling as the detail view) with its own "+ Add evidence" file picker (`evidenceFiles`), so files can be
  staged before the defect exists, with per-file removal.
- `POST /api/defects` (JSON body, `schemas.DefectCreate`) is deliberately left untouched -- converting it to
  multipart would mean rewriting a ~20-field Pydantic-validated endpoint into individual `Form(...)`
  parameters (the pattern `update_rich_execution_result` uses), a materially bigger and riskier change to an
  endpoint with an existing contract, for a form that only produces optional attachments. Instead, `submit()`
  now runs as two steps: create the defect via the existing JSON POST (unchanged), then -- only once an id
  exists -- upload every staged image/file (`stepsImages` + `actualImages` + `expectedImages` +
  `evidenceFiles` combined) via the existing, already-permission-checked `POST /api/defects/{id}/attachments`
  endpoint (`doc_store.save_documents`, module `DEFECT`), the same call `DefectDetail`'s own "+ Add evidence"
  already makes. No backend code changed at all.
- Handled the create-succeeds-but-attach-fails case explicitly rather than papering over it: the created
  defect is kept in state (`createdDefect`) so a second click of the form doesn't re-POST a duplicate defect.
  On attachment failure the form shows "`<key>` was created, but evidence could not be attached: `<reason>`"
  with two explicit actions -- "Retry attaching evidence" (re-runs just the upload step) or "Continue without
  evidence" (closes out to the defect detail view, where "+ Add evidence" can attach it manually later, same
  endpoint either way).

**Fix -- `backend/app/schemas.py` / `models.py` / any router:** none needed -- `POST /api/defects/{id}/
attachments` (defects.py:574) was already correct (right field name `files`, right permission gate via
`_can_touch_defect`, right upload-dir handling via `documents.py::save_documents`); this was purely a
frontend feature flag plus a missing "attach at creation time" affordance, not a wiring or backend bug.

**Verified:** `npx tsc --noEmit -p .` clean (no backend files touched, so `py_compile` re-run only as a
no-op sanity check -- also clean). Documents and outputs copies re-synced and confirmed identical via
`diff -rq` (only the standard `.env`/`logs`/`uploads` exclusions differ).

## 30. Defect Management -- no way to edit a defect's content

**Reported:** "There are no option to edit defect content." Investigation found the backend has always
supported this -- `PATCH /api/defects/{id}` (`update_defect`, defects.py:434) accepts Title, Description,
Module/Feature, Environment, Steps to Reproduce, Actual Result, and Expected Result (Severity/Priority too,
manager-gated), restricted to a defect still in `New` status and to the reporter or a manager (Admin/QA
Lead/Chief Manager QA/the defect's own Project Lead or Owner) -- but `Defects.tsx` never called it. There was
no Edit button and no edit form anywhere in the module; once a defect was reported, its content was
effectively frozen (only workflow actions -- Assign/Resolve/Retest/etc. -- could add further information).

**Fix -- frontend only, `Defects.tsx`:**
- New `EditDefectModal` component: a form for Title, Description, Module/Feature, Environment, Steps to
  Reproduce, Actual Result, Expected Result (all editable by the reporter or a manager), plus Severity/
  Priority (manager-only -- shown read-only otherwise, matching the backend's own restriction). Submits via
  `api.patch('/api/defects/{id}', {...})`.
- Built with the same screenshot support just added to the create form (section 29) -- all three rich-text
  fields default to `allowImages={true}`, and an "Evidence & Attachments" picker lets more files be staged
  and attached via the existing `POST /api/defects/{id}/attachments` right after the PATCH succeeds, with the
  same "Retry attaching evidence / Continue without it" handling if that second step fails.
- `DefectDetail`'s header now shows an "Edit" button when `defect.status === 'New'` and the current user is
  the reporter or a manager -- mirroring the backend's own gate exactly so the button doesn't appear only to
  403 when clicked. A banner in the modal explains the "only while New" scope, so it's clear why the button
  disappears once the defect is Assigned (workflow actions take over from there, each with its own audit
  entry, which is the existing design this deliberately did not change).

**Fix -- backend:** none needed -- `update_defect` and its permission checks were already correct and
unchanged; this was purely a missing frontend affordance.

**Verified:** `npx tsc --noEmit -p .` clean. Documents and outputs copies re-synced and confirmed identical
via `diff -rq` (only the standard `.env`/`logs`/`uploads` exclusions differ).

## 31. Pasted screenshots always named "actual-result-...", even in Steps/Expected Result

**Reported:** "image uploading name is not correct, if i am uploading on expected result then also uploading
as actual result." Root cause: `JiraRichTextField.tsx` (shared by every rich-text field added across sections
25/28/29/30 -- Steps to Reproduce, Actual Result, Expected Result, Test Execution's own Actual Result) calls
`useRichTextImages` with a literal, hardcoded `filenamePrefix: 'actual-result'` -- it was originally written
for just the one field (Test Execution's Actual Result) and never parameterized this by which field it's
actually mounted in. So `RichTextEditor.tsx::pasteImages`, which names a pasted (clipboard, no inherent
filename) screenshot `${filenamePrefix}-${timestamp}-${n}.<ext>`, produced `actual-result-...png` no matter
which of the three Defect fields -- or even Test Execution's field -- the screenshot was actually pasted
into. (Manually-picked files via "Upload images" keep their own original filename regardless -- only
clipboard-pasted screenshots go through this generated-name path, which is why the wrong name specifically
showed up when pasting.) The `tooMany` limit message and the `ErrorText` title had the same hardcoded
"Actual Result" wording, same root cause.

**Fix -- frontend only, `components/JiraRichTextField.tsx`:** derived a `fieldSlug` from the field's own
`ariaLabel` prop (already passed correctly and distinctly at every call site -- "Steps to Reproduce"/"Actual
Result"/"Expected Result") via `ariaLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
|| 'result'`, and used that as `filenamePrefix` instead of the literal string. The `tooMany` message and the
`ErrorText` title now interpolate `ariaLabel` directly too, so every field's own name shows up correctly
everywhere a message references it. One shared component, one root-cause fix -- covers Steps to Reproduce,
Actual Result, and Expected Result on both the Defect create form (section 29) and the new Edit form (section
30), plus Test Execution's own Actual Result field, without needing to touch any of those call sites.

**Verified:** `npx tsc --noEmit -p .` clean; `python3 -m py_compile app/*.py app/routers/*.py` clean (no
backend files touched, re-run as a no-op sanity check). Documents and outputs copies re-synced and confirmed
identical via `diff -rq` (only the standard `.env`/`logs`/`uploads` exclusions differ).

## 32. Every Defect Management text field converted to rich text with image upload

**Reported:** "make everywhere in defect text field as rich text with image uploading." Sections 29/30 only
covered Steps to Reproduce/Actual Result/Expected Result on the create and edit forms. Every other free-text
field in the module was still a plain `<textarea>`: Description on both the create and edit forms, and --
depending on which workflow action is being taken -- Resolution Summary, Root Cause, Fix Details, Retest
Actual Result, Retest Remarks, Closure Remarks, Reopening Reason, Deferral Reason, Rejection Reason, and the
generic Remarks fallback, all inside `TransitionModal`.

**Fix -- frontend only, `Defects.tsx`:**
- `CreateDefectModal` and `EditDefectModal`'s Description field is now a `JiraRichTextField` with its own
  `descriptionImages` staging array, folded into the same "create/save, then attach" flow as Steps/Actual/
  Expected (section 29/30) -- one combined attachment upload, one combined retry-safe error/continue UI, no
  new endpoint calls added. Create's Description requirement (previously enforced only by the removed
  `<textarea required>`) now has an explicit `!description.trim()` check alongside the existing Steps/Actual/
  Expected one.
- `TransitionModal` converts all nine conditional textareas plus the generic Remarks fallback the same way.
  Since these fields only ever appear a few at a time (gated by `target`, e.g. Resolved vs. Closed vs.
  Rejected), their staged images are tracked in one `imageValues: Record<string, File[]>` keyed by field name
  rather than nine separate `useState`s. `JiraRichTextField` has no native `required` attribute (unlike the
  textareas it replaces), so a `validateRichFields()` check was added covering exactly the fields that were
  previously `<textarea required>` for each `target`; every other still-plain input/select keeps its native
  `required` and needs no extra check. The transition POST and the attachment upload are two separate calls
  (same reasoning as sections 29/30): if the transition itself succeeds but attaching evidence then fails, the
  form must not resubmit the transition (could 400 on an already-applied status change, or double-count things
  like `reopen_count`) -- it now holds the already-transitioned `DefectOut` and offers "Retry attaching
  evidence" / "Continue without evidence" instead, wrapped in a `<fieldset disabled={!!savedDefect}>` (plus an
  explicit `disabled` prop on each `JiraRichTextField`, since fieldset-disable doesn't reach a contentEditable
  div) so the form visibly locks once the transition has gone through.
- `DefectDetail`'s own display updated to match: `defect.description` and the Workflow Details section
  (Resolution, Root cause, Retest, Reopened, Deferred, Rejected) now render through `<MarkdownComment>`
  instead of raw `{value}` interpolation -- these fields store markdown now, so without this change the raw
  `**bold**`/`- list`/etc. syntax would show up literally instead of being formatted. Restructured each from
  `<p><strong>Label:</strong> {value}</p>` to a `<div className="defect-workflow-item">` wrapper (new CSS in
  `index.css`) since `MarkdownComment` returns block-level markup (`<div className="jira-markdown">`) that
  isn't valid nested inside a `<p>`.
- New `.defect-transition-fieldset` (border/padding/margin reset -- browsers draw a default border and inset
  padding around `<fieldset>`) and `.defect-workflow-item` rules added to `index.css`.

**Fix -- backend:** none needed -- every one of these fields (`DefectCreate.description`,
`DefectUpdate.description`, and every field on `DefectTransition`) was already a plain `Optional[str]` column;
storing formatted markdown instead of plain text is schema-compatible, exactly like sections 25/28's Steps/
Actual/Expected fields already proved. `POST /api/defects/{id}/attachments` handles every field's staged
images the same way regardless of which field or which workflow action they came from.

**Verified:** `npx tsc --noEmit -p .` clean; `python3 -m py_compile app/*.py app/routers/*.py` clean (no
backend files touched, re-run as a no-op sanity check). Documents and outputs copies re-synced and confirmed
identical via `diff -rq` (only the standard `.env`/`logs`/`uploads` exclusions differ).

## 33. QA Sign-off Certificate -- screenshots in rich text + "Save Draft Certificate not working"

**Reported:** "While new Qa sign off certificate is raising with screenshots uplaod in rich text, save raft
certificate not working." `SignOff.tsx`'s three rich-text fields (Exit Criteria Validation Notes, Open Defect
Review Summary, Residual Risk Documentation) -- on both `NewSignOffModal` and `EditSignOffModal` -- had
`allowImages={false}`, the exact same flag that was disabling screenshots across the Defect module before
sections 29-32 fixed it.

The likely link to "Save Draft Certificate not working": with `allowImages={false}`,
`JiraRichTextField` doesn't just hide its image button -- it also leaves `onPaste` unbound entirely (see
`JiraRichTextField.tsx`: `onPaste={allowImages ? pasteImages : undefined}`), so a pasted screenshot isn't
cleanly blocked, it falls through to the browser's own default contentEditable paste behaviour instead. For
an image on the clipboard, Chrome/Edge's default behaviour is typically to embed it directly as a multi-
megabyte base64 `<img>` inside the DOM. That would make the editor (and the whole modal, and possibly the
tab) heavy and sluggish right before the user clicks Save -- a very plausible explanation for a save button
that appears to stop responding, without any actual backend error. (The pasted image itself was never part of
the saved value either way -- `editorContentToMarkdown` doesn't serialize `<img>` nodes -- so nothing was
being silently saved wrong, it just wasn't being saved at all, while bloating the live DOM.) Checked
`create_signoff`/`update_signoff` (routers/signoff.py) and their schemas for an independent bug and found
none -- role/department gating, required fields, and the payload shape all matched correctly.

**Fix -- frontend only, `SignOff.tsx`:**
- Both modals now leave `allowImages` at its default (`true`) on all three fields, with real
  `onImagesChange` handlers (`exitCriteriaImages`/`openDefectImages`/`residualRiskImages`) -- this alone stops
  the raw browser paste from ever reaching the DOM, since `pasteImages` calls `event.preventDefault()` before
  routing the image through the same File-staging path as every other `JiraRichTextField` in the app.
- `NewSignOffModal`: staged images are combined with the existing "Supporting Documents" file picker's
  `files` and uploaded together via the certificate's existing `POST /api/signoffs/{id}/documents` right
  after creation succeeds -- same best-effort convention already in place there (a failed upload doesn't
  block `onCreated`; the certificate's own Documents tab can always retry).
- `EditSignOffModal` had no upload step at all before (Edit only ever touched form fields) -- now, if any
  images were staged, they're uploaded via the same endpoint right after the `PUT` succeeds, same best-effort
  handling as Create.

**Fix -- backend:** none needed -- `POST /api/signoffs/{id}/documents` (signoff.py:381) already existed for
Supporting Documents and needed no changes; it's the same generic `doc_store.save_documents` (module
`"SIGNOFF"`) every other module's document upload already uses.

**Verified:** `npx tsc --noEmit -p .` clean; `python3 -m py_compile app/*.py app/routers/*.py` clean (no
backend files touched, re-run as a no-op sanity check). Documents and outputs copies re-synced and confirmed
identical via `diff -rq` (only the standard `.env`/`logs`/`uploads` exclusions differ).

## 34. Removed "Review SLA" and "Requirement Coverage" reports entirely

**Reported:** "remove 'Review SLA', 'Requirement Coverage' -- all codes and database related thing should be
removed. no unwanted code." Both were 2 of the Test Management Revamp's 8 "SRS section 11" reporting views
(section covering the original reporting batch, further down this file) -- self-contained, read-only
aggregate report endpoints computed on the fly from `TestCaseVersion`/`TestCase`/`TestExecution`, with **no
dedicated database columns, tables, or migrations** backing either one (confirmed via a full grep of
`models.py` -- zero hits for either feature before removal). Nothing else in the codebase referenced either
report's schemas/endpoint/component -- both removed cleanly with no remaining call sites.

**Removed -- `backend/app/schemas.py`:** `ReviewSlaItemOut`, `ReviewWorkloadRow`, `ReviewSlaOut`,
`RequirementCoverageItemOut`, `RequirementCoverageOut`. `ReportFilterRef` (shared by 5+ other report schemas)
was left untouched.

**Removed -- `backend/app/routers/test_reports.py`:** the `_REVIEW_SLA_DAYS = 3` module constant, the
`GET /projects/{project_id}/review-sla` endpoint (`review_sla`), and the
`GET /projects/{project_id}/requirement-coverage` endpoint (`requirement_coverage`) -- both entire functions,
including their population-note strings and query logic. Updated the module's own docstring ("Eight report
views" -> "Six report views"; dropped the "review SLA items, requirement coverage" mention from the
list-shaped-reports paragraph).

**Removed -- `frontend/src/types.ts`:** `ReviewSlaItemOut`, `ReviewWorkloadRow`, `ReviewSlaOut`,
`RequirementCoverageItemOut`, `RequirementCoverageOut` interfaces.

**Removed -- `frontend/src/modules/test-management/TestReports.tsx`:** the `ReviewSlaOut`/
`RequirementCoverageOut` imports; `'review-sla'`/`'coverage'` from the `ReportTab` union; their two rows in
the `TABS` array; the `ReviewSlaPanel` and `RequirementCoveragePanel` components entirely (each was
self-contained -- its own `useState`/`useEffect`/fetch, no shared state with the other 6 panels); their two
render lines; updated the page subtitle to drop "review SLA, coverage". The shared report-page building
blocks (`Badge`, `CountBars`, `StatCard`, `PopulationNote`, `Pager`, and the `tm-report-*`/`simple-table` CSS
classes) are all still used by the remaining 6 reports and were left untouched -- confirmed no
`tm-report-sla`/`tm-report-coverage`-specific CSS ever existed to clean up either.

**Removed -- `frontend/src/components/Layout.tsx`:** updated the `/test-reports` nav item's comment (8 views
-> 6, dropped the two names); the nav link itself is unchanged since 6 reports remain.

**Explicitly NOT touched (flagged to avoid a careless `grep -ri sla`/`coverage` sweep):** the unrelated "3W
Project Governance" ageing-day-band SLA concept in `Dashboard.tsx`/`routers/dashboard.py` (`slaWithin`/
`slaNear`/`slaBreached`, generic 0-7/8-15/16+ day pending-item ageing, nothing to do with `TestCaseVersion`
review turnaround); the DAST/SAST "Scan Coverage" dashboard metric (`scan_coverage`, scanned-application
count); the `"Performance SLA"` checklist-item label string in `constants.py`'s Performance Testing readiness
checklist. All three are independent features that only share a word with what was asked to be removed.

**Verified:** `npx tsc --noEmit -p .` clean; `python3 -m py_compile app/*.py app/routers/*.py` clean. Grepped
the entire repo afterward for `ReviewSla`/`ReviewWorkloadRow`/`RequirementCoverage`/`review_sla`/
`requirement_coverage`/`review-sla`/`_REVIEW_SLA_DAYS` -- zero remaining hits outside this changelog's own
historical entries (an append-only record of past work, left as-is). Documents and outputs copies re-synced
and confirmed identical via `diff -rq` (only the standard `.env`/`logs`/`uploads` exclusions differ).

## 35. Removed "Audit Evidence" (Test Management report) -- the 8th and last SRS section 11 view

**Reported:** "Also comment 'Audit Evidence' related code, ui and backand. no unwanted api call" -- clarified
via a follow-up question that this meant full removal (same treatment as section 34), not commenting the
code out and leaving it inert. This closes out the original "8 report views" batch from the Test Management
Revamp (repository health, review SLA [removed §34], requirement coverage [removed §34], cycle progress,
defect quality, version impact, project portfolio, audit evidence) -- 5 views now remain.

**Important distinction found during investigation, NOT touched:** there is a second, unrelated "Audit
Evidence" report living in the separate Reports/Export Centre module -- `routers/reports.py`'s
`GET /audit-evidence` (registered in `REPORT_REGISTRY`) and its `constants.ts` `REPORTS` entry
(`{ key: 'audit-evidence', label: 'Audit Evidence Report', group: 'Management' }`). It shares only the label
with the Test Management report just removed -- different endpoint, different router, different response
shape (untyped dict list vs. the Pydantic `AuditEvidenceOut` removed below), feeds the CSV/PDF export
pipeline instead of the Test Reports page. Left completely alone, along with `deps.py::resolve_entity_department`
(shared with `approvals.py`, referenced only in a docstring example) and the general governance audit-trail
system (`audit_service.py`, `audit.router`, `application_audit_middleware`, `ApprovalAction`/`_audit`/`_log`
helpers used everywhere) -- none of that is "the Audit Evidence report," it's the underlying data and logging
infrastructure every module (including the one that was removed) reads from or writes to.

**Removed -- `backend/app/schemas.py`:** `AuditEvidenceItemOut`, `AuditEvidenceOut`.

**Removed -- `backend/app/routers/test_reports.py`:** the `GET /projects/{project_id}/audit-evidence`
endpoint (`audit_evidence`) -- the last function in the file, so removing it left the file ending cleanly
after `project_portfolio`. Updated the module docstring: "Six report views" -> "Five report views"; dropped
", audit evidence" from the list-shaped-reports pagination paragraph (only "version impact" is still
list-shaped/paginated). `_DEFAULT_PAGE_SIZE`/`_MAX_PAGE_SIZE`/`_get_project_or_404` all stayed -- shared with
`version-impact`, `repository-health`, and `defect-quality`.

**Removed -- `frontend/src/types.ts`:** `AuditEvidenceItemOut`, `AuditEvidenceOut` interfaces.

**Removed -- `frontend/src/modules/test-management/TestReports.tsx`:** the `AuditEvidenceOut` import;
`'audit'` from the `ReportTab` union; its `TABS` row; the `AuditEvidencePanel` component (self-contained --
its own decision-filter input, pagination, table); its render line; updated the page subtitle (dropped ", and
audit evidence"); fixed two comments left stale by both this and the prior removal ("SRS section 11 -- the 6
Test Management reporting views" -> "5", and the `CountBars` helper's "across all 8 reports" -> "5").

**Removed -- `frontend/src/components/Layout.tsx`:** updated the `/test-reports` nav item's comment (6 views
-> 5, dropped "audit evidence"); the nav link itself is unchanged.

**Verified:** `npx tsc --noEmit -p .` clean; `python3 -m py_compile app/*.py app/routers/*.py` clean. Grepped
the entire repo for `AuditEvidenceOut`/`AuditEvidenceItemOut`/`AuditEvidencePanel` -- zero remaining hits
outside this changelog's own historical entries. Confirmed the separate Reports/Export Centre `audit-evidence`
endpoint (`routers/reports.py:228`) and its `constants.ts` entry are both still present and unmodified.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`logs`/`uploads` exclusions differ).

## 36. Codebase-wide duplication and dead-code cleanup

**Reported:** "In this source code, there are lots of double code, there are lots of chance to reuse, no
duplication, along with that dead code also there which is not using. now refresh my code base." Ran two
read-only audit passes first (one over `backend/app/`, one over `frontend/src/`) to build a concrete,
file:line inventory before changing anything, then acted on every confirmed finding plus two real bugs
surfaced along the way.

**Backend -- duplication removed:**
- `datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata"))` was
  reimplemented inline 23 times across `applications.py`, `export.py`, `functional.py`, `performance.py`,
  `qa_requests.py`, `sast_dast.py`, `signoff.py`, `suppression.py`, instead of calling `models.now()` --
  the existing helper that does exactly this, already used 40+ places elsewhere. All 23 replaced with
  `models.now()`; the now-unused `import datetime` / `from zoneinfo import ZoneInfo` lines removed from
  each of those 8 files (2 of the 8 kept `import datetime` -- `export.py` and `sast_dast.py` still use it
  for something else).
- `_get_project_or_404(db, project_id)` was defined byte-identically in three routers
  (`test_execution.py`, `test_reports.py`, `test_repository.py`). Consolidated into one
  `deps.get_project_or_404`; all three routers now import it aliased back to `_get_project_or_404` so no
  call site needed to change.
- `test_projects.py` had the exact same "Test Project not found" lookup pattern inlined 8 more times (never
  factored into its own helper at all, unlike the three routers above) plus 5 more one-off
  "get record or raise 404" blocks (Application, selected owner x2, User). Added a generic
  `deps.get_or_404(db, model, id, label)` and converted all of these, plus 17 similar plain lookups in
  `test_repository.py` (11 TestCase, 4 Folder), to use it.
- `deps.get_or_404` is not retrofitted onto every "get or 404" block in the app (dozens more exist across
  other routers) -- many have entity-specific logic between the lookup and the raise that a blind
  mechanical sweep could silently change; only sites that were a plain lookup-or-404 with nothing else
  were converted. The helper is available for any router to adopt incrementally going forward.

**Backend -- dead code removed:**
- `models.py` imported `Index` from `sqlalchemy` (leftover from a `CustomFieldValue` feature removed
  outside this changelog's process, per section 2's own note) but never called it -- removed.
- `test_projects.py::_get_default_cm_qa` -- a whole function, never called (its only two call sites were
  themselves commented out, so its return value was never even used). While removing it, found it also
  contained a leftover `print(user.roles)` debug statement and a real logic bug: `if not user.is_active or
  Role.CHEIF_MANAGER_QA or Role.QA_LEAD not in user.roles:` -- `Role.CHEIF_MANAGER_QA` is a non-empty
  string, so due to Python's `or`/`in` precedence this condition was **always true**, meaning the function
  would have rejected every valid input had it ever been re-enabled. Since it was fully dead (both call
  sites commented out, nothing depended on its result), removed the function and the two commented-out
  call sites entirely rather than fixing and re-enabling unreviewed validation logic.

**Frontend -- duplication removed:**
- `frontend/src/modules/test-management/Defects.tsx` -- `CreateDefectModal` and `EditDefectModal` each
  duplicated ~20 lines of "stage screenshots + an explicit file picker, then upload everything as one
  attachment call right after the defect is created/saved, with retry-if-it-fails semantics" almost
  verbatim. Extracted a `useStagedEvidence` hook (evidence-file state, add/remove handlers, the
  attach-with-retry function) used by both modals; the per-field image arrays
  (`descriptionImages`/`stepsImages`/etc., one per `JiraRichTextField`) stayed in each modal since those
  are parallel structure, not copy-paste duplication. `frontend/src/modules/governance/SignOff.tsx`'s
  similar-looking pattern was deliberately NOT merged into the same hook -- it's a best-effort,
  fire-and-forget upload (no retry gating, no "record already created" state machine), a genuinely
  different UX flow that would have been forced together only cosmetically.

**Frontend -- dead code removed (`index.css`):** confirmed zero usage via grep across every `.ts`/`.tsx`
file (not just `.tsx`) before deleting anything, including a check for dynamic `className` construction
(`` `prefix-${variable}` ``) to avoid false positives -- this check caught that
`.security-control-repository-url`/`-git-branch`/`-commit-id`/`-technology-stack`/`-build-number` (flagged
as "maybe dead" by the first grep pass) are actually built dynamically in `QARequests/steps/SastStep.tsx`
from `SAST_COMPONENT_FIELDS`' keys and are genuinely live -- left untouched. Confirmed dead and removed:
`.sidebar-section-label`, `.icon-btn` (topbar notification-bell styling with no remaining bell button),
`.badge-pink`, `.checkbox-list` (base rule and its `.qa-wizard`-scoped variant), `.login-error`,
`.brand-version`, `.checklist-row`/`.checklist-row-header`/`.checklist-check` (base rules and their
`.qa-wizard`-scoped variants -- superseded by the `.security-checklist-row`/`.security-checklist-check`
classes actually in use), `.logo-mark` (all 5 variant rules -- superseded by `.brand-emblem`/`.bank-logo`),
`.jira-editor-error`/`.jira-comment-error` (superseded by the shared `<ErrorText>` modal),
`.topbar-user-popover-logout` (the logout control is a plain unstyled button now), `.dashboard-brief*` and
`.live-indicator` (an entire hero-banner-style widget, including its dark-theme and mobile overrides),
`.dashboard-action-queue`/`.queue-icon`/`.queue-priority` (another whole widget, including its responsive
override), `.defect-kpis`/`.defect-insights` (a KPI-card grid, including its two responsive breakpoints).

**Verified:** `npx tsc --noEmit -p .` clean; `python3 -m py_compile app/*.py app/routers/*.py` clean after
every step. Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the
standard `.env`/`logs`/`uploads` exclusions differ).

**Not touched, considered and deliberately left alone:** `main.py`'s comments referencing the historical
"Custom Fields" incident (section 2) -- they explain why the `create_all()` try/except and the global
exception handler exist, which is still true and useful even though the feature they reference is gone;
trimming them would remove real context for no functional benefit. `models.py`'s `IdCounter` ORM class is
never referenced by name in Python, but its backing table is written/read via raw SQL in
`_claim_business_seq` -- the class itself likely only exists so `Base.metadata.create_all()` emits its
DDL at startup, so it was left alone rather than risk a table that already exists in a live Oracle schema
losing its SQLAlchemy-side definition. A comment in `Common.tsx` mentions a
`.security-checklist-row-scoped` rule "below" that does not actually exist under that exact selector --
left alone since it's prose describing intent/behavior achieved through other existing rules, not a real
orphaned CSS rule to delete.

## 37. Performance optimization Phase 4, part 1 -- Oracle pool config, API error/correlation standard, audit efficiency

**Context:** first slice of a much larger "QA Portal Performance Optimization" requirement document (server-side
pagination/dashboard summary is its own separate, still-in-progress body of work -- see the pagination rollout
tasks). This slice covers the parts implementable as pure code in this environment, with no live Oracle instance,
Redis, or multi-worker deployment to validate against: DBP-001..006 (connection pool), Section 8 API standards
(correlation id, standard error envelope), and AUD-001/005/008 (audit classification, structured content, redundant
lookup removal). The async-audit-via-message-broker item (AUD-003) was explicitly deferred by the user ("stay SYNC")
since the existing `BackgroundTask`-based audit write (added earlier, see main.py's `application_audit_middleware`)
already keeps audit writes off the response's critical path without needing new infrastructure.

**DBP-001..006 (`database.py`):** the engine's pool settings (`pool_size`, `max_overflow`, previously hardcoded to
10/20) are now environment-configurable via `DB_POOL_SIZE`/`DB_MAX_OVERFLOW`/`DB_POOL_TIMEOUT`/`DB_POOL_RECYCLE`/
`DB_POOL_PRE_PING`, all documented in `.env.example` with the defaults matching prior hardcoded behavior exactly (no
behavior change until someone sets one). Also added `DB_QUERY_TIMEOUT_MS` (default 0 = disabled), wired to
python-oracledb's per-connection `call_timeout` via a SQLAlchemy `connect` event -- caps how long a single query can
hold a pooled connection.

**Section 8 (`main.py`):**
- Added `X-Request-ID` alongside the pre-existing `X-Audit-Request-ID` response header (same value) -- the former is
  the more conventional header name a client would expect; the latter is kept for any existing caller relying on it.
- Added exception handlers for `StarletteHTTPException` and `RequestValidationError` so every error response (not
  just unhandled 500s, which already had this via `unhandled_exception_handler`) carries a `request_id` and
  `status_code` alongside the existing `detail` key. `detail` was kept as-is (not renamed/nested) since
  `frontend/src/api.ts`'s error parsing and every router's `raise HTTPException(detail=...)` already depend on it;
  the new fields are purely additive.

**AUD-001/005/008 (`main.py`, `deps.py`):**
- AUD-008: `deps.get_current_user` now stashes the resolved `User` on `request.state.current_user` after decoding
  the JWT and querying it once. `main.py::_write_request_audit` (which runs as a `BackgroundTask` on that same
  `Request` object, after the response is sent) now reuses that instead of decoding the JWT and querying `User` a
  second time on every single API request. Requests that never went through `get_current_user` (login, invalid/
  missing/expired token) still fall back to the original decode-and-query path.
- AUD-001/005: added `_classify_module()`, a path-prefix lookup (`/api/qa-requests` -> `QA_REQUEST`,
  `/api/defects` -> `DEFECT`, etc., 26 modules covering every registered router) and folded `module`/`method`/`path`
  into the audit `details` JSON alongside the existing `duration_ms`/`error_type`. Deliberately did NOT touch
  `event_type` itself (stays exactly `ACCESS` / `DATA_CHANGE` / `ACCESS_MANAGEMENT`) -- `AuditLog.tsx`'s event-type
  filter dropdown is hardcoded to that 3-value set, and `details` is already rendered as free-form JSON in the audit
  detail panel, so enriching it is safe/additive while changing `event_type` would have required a matching
  frontend change.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. No frontend changes in this slice.

## 38. Performance optimization Phase 4, part 2 -- Redis cache infrastructure, multi-worker deployment, reference-data caching

**Context:** continues section 37. Covers INF-001..006 (multi-worker), CAC-001..007 (reference-data caching), and the
Redis infrastructure both depend on -- the user's explicit decision was "Add Redis now for both" (Dashboard summary
caching, still pending -- see the separate pagination/dashboard tasks -- and reference-data caching, done here),
superseding an earlier in-process-cache plan once INF-001's 4-worker target made an in-process cache
cross-worker-inconsistent by construction.

**`backend/app/cache.py` (new):** a thin Redis wrapper (`get_json`/`set_json`/`delete`/`delete_prefix`/
`try_acquire_lock`/`ping`/`available`) that is a safe no-op in every "Redis isn't there" case -- package not
installed, `REDIS_URL` unset, or the server unreachable -- logging once and returning harmless defaults (`None`/
`False`/`0`) rather than raising, exactly as CAC-006 requires. Verified this degrade path directly in-sandbox (no
`redis` package and no live Redis available here): every function returned its safe default with one warning logged,
nothing raised. Every key is namespaced under `qa_portal:` so a shared Redis instance can't collide with another
app's keys. `requirements.txt` gained `redis==5.0.8` (optional at runtime, real once `REDIS_URL` is set).

**INF-001..006 (`backend/Dockerfile`, `docker-compose.yml`, `main.py`):**
- `Dockerfile`'s `CMD` now runs `uvicorn --workers ${WEB_CONCURRENCY}` (default 4, shell-form so the env var expands,
  `exec`'d so uvicorn stays PID 1 for clean `SIGTERM` shutdown).
- `docker-compose.yml` gained a `redis:7-alpine` service (with a named volume) and wired `WEB_CONCURRENCY`/
  `REDIS_URL` into the backend service's environment, plus commented DB-pool overrides for reference.
- Multiple workers means `main.py`'s module-level startup code runs once per worker process, not once per
  deployment -- `load_storage_settings` (sets this worker's own in-memory upload-root config) still runs in every
  worker since that's genuinely process-local, but `migrate_legacy_document_layout` and the two overdue-notification
  sweeps (`sweep_overdue_approvals`/`sweep_overdue_defects`) are one-time-per-deployment side effects (file moves,
  `Notification` row creation) that would otherwise fire once per worker -- e.g. 4 duplicate overdue-notification
  batches on a fresh 4-worker boot. Gated behind `cache.try_acquire_lock("startup-migrations-and-sweeps")`: with
  Redis reachable, only the first worker to start does this work; without Redis it's permissive (every worker
  proceeds, same as before this lock existed) rather than silently skipping real startup work in an unconfigured
  environment.
- `GET /api/health` (INF-003) now checks live DB connectivity (`SELECT 1 FROM DUAL`) and reports last-known Redis
  connection state, returning `{"status": "ok"|"degraded", "database": "ok"|"unreachable", "cache": "connected"|
  "disabled"|"unreachable"}` instead of a bare `{"status": "ok"}`.
- `README.md`'s Docker Compose section documents the new `WEB_CONCURRENCY`/`redis` defaults and what happens without
  Redis reachable.

**CAC-001..007 (`departments.py`, `applications.py`, `checklist_config.py`):** cached the three clearest
near-static/read-heavy/write-rare reference-data endpoints: `GET /api/departments` (active departments, read by every
department picker), `GET /api/application-names` (approved names, the QA Request wizard's dropdown), and
`GET /api/checklist-config/{module}` (active checklist items, read on every wizard step and most readiness-checklist
screens -- cached per-module, not one blanket key, so editing one module doesn't invalidate another's). Each follows
the same pattern: read-through cache with a 300s TTL and a versioned key (`...:v1`, `...:v1:{module}`) so a future
schema change can be invalidated fleet-wide by bumping the version; every mutation endpoint for that data (create/
update/toggle-active for departments, every approve/reject/bulk-seed path for application names, create/update/
delete/restore-defaults for checklist items) calls a matching `_invalidate_*_cache()` right after `db.commit()`
(CAC-004). Deliberately did NOT cache `GET /api/departments/all`, `/api/application-names/pending*`, or
`/api/checklist-config/{module}/all` -- these are Admin-only management views (low traffic, and correctness there
matters more than shaving a DB round-trip off a rarely-hit screen). Users/roles/test-projects (also listed as
CAC-001 candidates) were left uncached in this pass -- they're higher-traffic-per-write and/or already covered by
the pagination rollout's own per-request caching strategy; revisit once that rollout reaches them.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. `cache.py`'s no-Redis degrade path exercised
directly (see above). No frontend changes in this slice.

## 39. Performance optimization Phase 4, part 3 -- database indexes (IDX-001..007)

**Context:** completes the sandbox-implementable slice of the performance optimization document (the remaining
items -- AUD-003 async audit broker, DSH dashboard summary endpoint, and the full PAG-001..010 pagination rollout --
are tracked separately; DSH/PAG are still in progress, AUD-003 was explicitly descoped by the user to stay SYNC).
No live Oracle instance is available in this sandbox (same constraint noted throughout this project), so this pass
is a careful manual review against IDX-002's candidate column list and every existing model definition, in place of
IDX-001's "finalize using actual Oracle execution plans" -- flagged here explicitly so the DBA/infra team knows to
validate with real execution plans (IDX-001, IDX-006, IDX-007) before/after deploying, per the requirement.

**`backend/app/models.py`:** added 13 composite indexes covering IDX-002's candidate list (QA Request, Functional/
SAST/DAST/Performance Request, Approval History, Test Case, Test Cycle, Checklist Item, Document, Audit Event,
Defect assignment) -- see the "Performance optimization indexes" block near the end of the file for the full list
and reasoning. Two candidates were deliberately NOT added, with the reasoning left inline: TestExecution(cycle_id,
test_case_id) is already exactly covered by that table's existing `UniqueConstraint("cycle_id", "test_case_id")` --
Oracle backs a unique constraint with a unique index on precisely those columns, so a second index would be purely
redundant (IDX-005); and "Pending Approval: approver, status, entity_type" has no corresponding table -- there is no
dedicated PendingApproval/approver-scoped table in this schema, every pending-approval screen queries the underlying
module tables directly by status, which the new composites already cover.

**IDX-005 (duplicate-index prevention):** 5 of the 13 composites share their leading column with a pre-existing
single-column `index=True` on that same column (FunctionalRequest.status, ApprovalAction.entity_type,
AuditLog.actor_id, RequestDocument.module, Defect.assignee_id) -- since a composite index can already serve any
query the single-column index served (same leading column), keeping both would be exactly the redundant pair
IDX-005 prohibits. Removed `index=True` from each of those 5 columns, with a comment left on each pointing at the
composite that supersedes it. Every other existing single-column index (QARequest.status, ApprovalAction.entity_id,
RequestDocument.request_id, Defect.status, AuditLog's several others, etc.) was deliberately left alone -- none of
them share a leading column with a new composite, so removing them would lose real query coverage (e.g.
QARequest.status is still useful for an admin-wide status filter with no department scoping, which the new
`(department, status, created_at)` composite -- department-leading -- can't serve as an equality-only lookup).

**Oracle identifier length:** every new index name was verified <= 30 bytes before use (this project has hit
ORA-00972 from a too-long identifier once already, see section 2) -- computed and checked programmatically rather
than by eye, given how easy that is to get wrong by a character or two.

**`backend/scripts/2026-08_add_performance_indexes.sql` (new):** this app has no Alembic/migration tool (see
`database.py`'s own docstring) -- `Base.metadata.create_all()` only emits DDL for tables that don't exist yet, so a
brand-new deployment gets these indexes automatically but an EXISTING Oracle schema needs them added by hand, same
convention already used for new columns needing a manual `ALTER TABLE`. This script has the equivalent `CREATE
INDEX` statements, each guarded to be a safe no-op on re-run, plus commented-out (opt-in, not automatic) `DROP
INDEX` statements for the 5 now-superseded single-column indexes and an IDX-007 reminder to refresh optimizer
statistics afterward per the approved DBA procedure.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. No `sqlalchemy` package is available in this
sandbox (same constraint noted for `cache.py`'s Redis testing above), so unlike a normal change here there was no
way to actually import `models` and confirm `Base.metadata` builds the 13 new `Index(...)` objects without a name
collision or bad column reference -- that was instead checked by careful manual review: every column referenced by
name against the live model source, and every index name's length verified programmatically (see above). Please run
`python -c "from app import models"` against a real environment with `sqlalchemy` installed before deploying, as a
final sanity check this review didn't miss. No frontend changes in this slice.

## 40. Performance optimization Phase 3 -- pagination rollout for Functional, SAST, DAST, Performance (PAG-005/006)

**Context:** continues the PAG-001..010 rollout (task tracked separately from Phase 4's DBP/CAC/IDX work above),
following the same reference pattern already established for QA Requests: a lightweight `*ListOut` schema for the
list endpoint (PAG-005), and a "fetch full detail on open" pattern on the frontend (PAG-006) so the detail modal's
dozens of rarely-needed fields never have to ride along in a paginated list response.

**`backend/app/schemas.py`:** added `FunctionalListOut`, `SASTListOut`, `DASTListOut`, `PerformanceListOut` --
each mirrors its own list table's exact column needs, not the full `*Out` shape. `SASTListOut`/`DASTListOut`
include a new `findings_count: int` field instead of the full `findings` array (see `models.py` below).
`DASTListOut` deliberately excludes `targets` (so DAST's credential-masking, `_dast_out` in
`routers/sast_dast.py`, stays a concern only for the single-record detail endpoint, never the list). All four
also carry `department`/`application_owner` where relevant even though the list tables don't always render them
-- both are already eager-loaded (see below) at zero extra query cost, and are needed by cross-module consumers
that browse these lists without opening any individual record (Dashboard.tsx's "My Department" filter,
Suppression.tsx's SAST/DAST request picker -- see both further down).

**`backend/app/models.py`:** added a `findings_count` `@property` (`len(self.findings)`) to both `SASTRequest`
and `DASTRequest`, with a comment noting the list router eager-loads `findings` via `selectinload` (a second
batched query, not a per-row lazy-load) specifically so this property doesn't trigger an N+1.

**`backend/app/routers/functional.py`, `sast_dast.py`, `performance.py`:** each list endpoint (`list_functional`,
`list_sast`, `list_dast`, `list_performance`) rewritten onto the shared `pagination` module (same
`apply_search`/`apply_status_filter`/`apply_department_filter`/`apply_sort`/`paginate`/`to_page_response` used by
QA Requests), each with `joinedload(*.qa_request).joinedload(QARequest.application_master)` -- all four request
types delegate `department`/`application_name`/`application_master_status` etc. via Python `@property` reading
`self.qa_request`, so a list without this eager-load would N+1 once per row. `list_sast`/`list_dast` additionally
`selectinload(*.findings)` for the new `findings_count` property. **Every join converted from the previous
conditional `if scope: q = q.join(...)` to an unconditional `isouter=True` (LEFT JOIN)** -- search/sort on a
delegated field needs the join unconditionally, but an INNER join would have silently dropped every
standalone/legacy row with `qa_request_id IS NULL` for ALL users, not just scoped ones. Caught and fixed before
shipping, explicitly commented in each router.

**New detail endpoints:** `GET /api/sast-requests/{req_id}` and `GET /api/dast-requests/{req_id}` did not exist
in the codebase at all before this slice -- added as new endpoints (DAST's applies the same `_dast_out` credential
masking the existing endpoints already use). `GET /api/performance-requests/{req_id}` also added, reusing the
existing `_get_or_404` helper that was already there.

**`frontend/src/types.ts`:** added matching `FunctionalListOut`, `SASTListOut`, `DASTListOut`, `PerformanceListOut`
interfaces. `CombinedSecurityRequest` (Suppression.tsx's cross-module SAST/DAST picker type) changed from
`(SASTOut | DASTOut) & {_kind}` to `(SASTListOut | DASTListOut) & {_kind}`.

**`frontend/src/modules/functional/Functional.tsx`, `security/SAST.tsx`, `security/DAST.tsx`,
`specialised-testing/Performance.tsx`:** each list component rewritten onto `usePaginatedList<XListOut>` +
an `openRequest`/`openEligibleRequest`-style async callback that does `GET /{id}` for the full record before
showing the detail modal, matching QA Requests' reference implementation exactly (PAG-006). Request ID column
shows "Opening…" while a row's detail fetch is in flight. `onChanged`/`onSaved` handlers now call `reload()`
(re-fetches the current page) instead of the old unpaginated `load()`.

**Pre-existing bug fixed in `SAST.tsx`/`DAST.tsx`:** `addFinding`/`resolveFinding` previously re-fetched the
*entire* unpaginated list and did `.find(r => r.id === req.id)` just to refresh one row, discarding the rest.
Harmless while the list was unpaginated; would have started silently failing to refresh whenever the target row
wasn't on the paginated list's first page. Replaced with a direct `GET /api/{sast,dast}-requests/{id}` call using
the newly-added detail endpoints.

**`frontend/src/modules/governance/SignOff.tsx`:** its `TestingRequestIdSearch` picker needed fields beyond
`FunctionalListOut` (full form-prefill needs `cr_number`/`technology_stack`/`release_version`/`build_number`/
`environment`/`target_promotion_environment`, none of which belong in a lightweight list schema). Resolved the
same way as PAG-006 itself: added a `selectEligibleRequest` callback that fetches the full `FunctionalOut` via
`GET /{id}` before prefilling the certificate form, rather than bloating the list schema for one rarely-used
consumer. The picker's own eligible-request fetch also switched to server-side multi-value `status` query params
instead of client-side filtering an unpaginated list.

**`frontend/src/modules/security/Suppression.tsx`:** `NewSuppressionModal`'s cross-module SAST/DAST autosuggest
(`Promise.all([api.get('/api/sast-requests'), api.get('/api/dast-requests')])`) would have silently broken once
those endpoints returned `Page<XListOut>` instead of a bare array. Fixed to fetch `PageOut<SASTListOut>`/
`PageOut<DASTListOut>` with `page_size=100` and unwrap `.items` (this picker filters/searches client-side across
the whole candidate set rather than being a paginated table itself, so a large page size is correct here, not a
`usePaginatedList` table). `selectRequest`'s DAST label previously read `targets?.[0]?.application_url`, which
isn't part of the lightweight list schema (`DASTListOut` deliberately excludes `targets`) -- switched to
`application_name`, which is already delegated and is what DAST's own list table displays for the same row.

**`frontend/src/Dashboard.tsx`:** the remaining `SASTOut[]`/`DASTOut[]`/`PerformanceOut[]` fetches (feeding
`CommandCentre`/`MyRequestsTab`'s unified "My Requests & My Department" table, alongside the already-fixed
`functionalRequests`) switched to `PageOut<XListOut>` + `page_size=100` + `.items` unwrap. `toUnifiedDast`
simplified to match (drops the now-unavailable `targets[0].application_url` fallback, same reasoning as
Suppression.tsx above). Discovered while checking `toUnified`'s generic row shape against `PerformanceListOut`:
Performance's list schema had no `department` field at all (only `application_master_status` was delegated into
it), which would have silently emptied Performance out of the "My Department" filter for every user (the filter
is a strict `r.department === user.department` equality check) -- added `department` to `PerformanceListOut`
(backend + frontend) since it's already eager-loaded by `list_performance`'s existing join, same zero-cost
reasoning as the SAST/DAST `department`/`application_owner` additions above.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean together
(one real mistake caught by `tsc` during this pass -- a botched edit in `Suppression.tsx`'s `selectRequest` that
dropped the `setForm((f) => ({` wrapper line, immediately fixed). Documents and outputs copies re-synced and
confirmed identical via `diff -rq` (only the standard `.env`/`logs`/`uploads` leftovers differ).

## 41. Performance optimization Phase 3 -- pagination rollout for Test Management (Test Projects, Test Cases, Test Cycles, Test Executions)

**Context:** continues the PAG-001..010 rollout (task #60). Unlike the flat-table modules covered in section 40,
two of these four entities turned out not to be simple "browse a table" screens: Test Cases (Repository) renders
as a folder tree that needs the full case list to build, and Test Executions (per Cycle) drives bulk
select-all/select-visible actions plus per-status summary tabs and assignment tabs, all computed client-side from
the full in-cycle list. Given the choice between skipping pagination on these two, bolting on pagination while
keeping full-fetch behavior, or a genuine redesign, the explicit decision was to redesign both for real server
pagination.

**The pattern adopted for both Test Cases and Test Executions:** three complementary backend primitives replace
"fetch everything, compute stats/counts/trees client-side":

1. A paginated, server-filtered main list (`GET .../test-cases`, `GET .../executions`), using a new lightweight
   list schema (`TestCaseListOut` drops `pre_condition`/`description`/`steps` in favor of `steps_count`) paired
   with PAG-006's "fetch full detail on open" pattern -- opening a row now does `GET /{id}` for the full record
   before showing its edit/detail modal, via a new `openingCaseId`/`openingId`-style in-flight state.
2. A dedicated summary/aggregate endpoint (`GET .../test-cases/summary`, `GET .../executions/summary`), computed
   via SQL `COUNT`/`GROUP BY`, replacing every client-side `.filter().length` that used to feed folder counts,
   tag lists, status tabs, assignment-tab counts, and the "total run count" stat -- never a full-row fetch.
3. A deliberately unpaginated bulk-candidate endpoint for the one workflow that genuinely needs the complete
   candidate set at once (PAG-010): `GET .../test-cases/all` (folder tree + Test Execution's "Add Test Cases to
   Cycle" picker) and `GET .../executions/case-ids` (the same modal's "already in this cycle" exclusion set).

**Selection state under pagination:** "visible" now means "on the current page." Both screens clear any held
multi-select whenever the page, filters, or scope (project/folder/cycle) changes, matching the precedent already
set for SAST/DAST's own bulk bars in section 40.

**Mutation handling under pagination:** every mutation (create/update/delete/bulk action) now triggers a
`reload()` of the current page (+ a summary reload where relevant) instead of trying to patch a full-detail API
response into a lightweight list row's local state -- sidesteps `TestCaseOut` vs `TestCaseListOut` type mismatches
entirely.

**`backend/app/models.py`:** added a `steps_count` property to `TestCase` (`len(self.steps)`) backing the new
list schema's count field.

**`backend/app/schemas.py`:** added `TestCaseListOut`, `TestCaseSummaryOut`, `TestExecutionSummaryOut`; added
`steps_count` to the existing `TestCaseOut`.

**`backend/app/routers/test_repository.py`:** `list_test_cases` rewritten onto `pagination.Page[TestCaseListOut]`
with `folder_id`/`priority`/`tag` filters, search across the case's key/scenario/epic/CR/feature/user-story/module
fields, status filter, and sort on key/status/priority/updated_at. Added `GET .../test-cases/summary` and the
PAG-010 `GET .../test-cases/all`.

**`backend/app/routers/test_execution.py`:** `list_executions` rewritten onto `pagination.Page[TestExecutionOut]`
with an `assignment=mine|unassigned` filter, status filter, and stable id-ordered sort. Added
`GET .../executions/summary`, the PAG-010 `GET .../executions/case-ids`, and a new `GET /executions/{id}` (needed
once the list itself stopped being a bare array the old `?execution=<id>` deep-link could search client-side).

**Test Projects + Test Cycles (task #82):** unlike Test Cases/Executions, neither of these two entities is ever
consumed through the app's real paginated `<Table server={...}>` pattern anywhere in the app -- Test Projects
renders as a card gallery in `TestProjects.tsx`, and Test Cycles is always fetched as a complete picker/aggregation
source (cycle sidebar, reports, MyExecutions' cross-project fan-out). Both are also naturally bounded by real-world
department/project size, unlike the genuinely unbounded lists pagination exists for. Rather than force a UI
redesign neither entity needs, `list_test_projects` and `list_cycles` were wrapped in the standard
`pagination.Page[T]` envelope purely for API-contract consistency with the rest of the app (the original
`is_active desc, name` two-column ordering on Test Projects doesn't map onto `apply_sort`'s single-column +
id-secondary shape, so it's kept as an explicit `order_by` rather than going through that helper). Every frontend
consumer of these two endpoints now requests `page_size=100` (or, for `TestProjects.tsx`'s per-project cycle-count
stat card, `page_size=25` + reads `.total` -- a real COUNT unaffected by page size, standing in for a dedicated
cycles-summary endpoint that doesn't exist) and unwraps `.items` instead of treating the response as a bare array.
11 call sites across `MyExecutions.tsx`, `TestExecution.tsx`, `TestProjects.tsx`, `TestRepository.tsx`,
`TestReports.tsx`, and `Defects.tsx` were found via grep and updated the same way.

**Known accepted scope cut:** `TestExecution.tsx`'s `_LIST_EXECUTION_EAGER_LOADS` eager-loads `test_case` itself
but not that test case's own nested relations, which still lazy-load per row -- documented in the router as a
partial N+1 mitigation rather than a full fix, since those nested fields aren't used by the execution list view.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean together
(one real mistake caught by `tsc` -- a leftover pre-rename `c` reference in `TestExecution.tsx`'s `loadCycles`,
immediately fixed). Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the
standard `.env`/`logs`/`uploads` leftovers differ).

## 42. Performance optimization Phase 3 -- pagination rollout for Defects, Pending Approvals, Approval History

**Context:** continues the PAG-001..010 rollout (task #61). Defect Management's register (`Defects.tsx`) has the
same "queue tabs computed from the whole list" shape as Test Executions did in section 41, plus its own
Counter-over-`.all()` `/api/defects/dashboard` endpoint; Pending Approvals and Approval Workflow Log are two very
different screens sharing one underlying `ApprovalAction` feed, and only one of them turned out to need
pagination at all.

**`backend/app/schemas.py` / `routers/defects.py`:** added `DefectListOut` (PAG-005 -- drops description, steps/
expected/actual result, log/request details, resolution/root-cause/fix writeups, etc., everything only read once
a defect is actually opened). `list_defects` (`GET /api/defects`) rewritten onto `pagination.Page[DefectListOut]`
with a new `queue=attention|mine|unlinked|retest|closed` param mirroring Test Executions' own `assignment=mine`
convention, plus the existing single-value `status`/`severity`/`priority`/`cycle_id`/etc. filters kept as-is and
PAG-001's own multi-value `status`/`search` layered on top. Added `_LIST_DEFECT_EAGER_LOADS` (qa_request/cycle/
primary_test_case/reporter/assignee) so the list's `@property`-backed `qa_request_key`/`cycle_key`/`test_case_key`/
`reporter_name`/`assignee_name` fields don't N+1. Added `GET /api/defects/by-key/{defect_key}` (mirrors
`test_repository.py`'s own `/test-cases/by-key/{key}` pattern) so Defects.tsx's `?open=<defect_key>` deep-link can
resolve a single record without the old full-list `.find()`.

**`defect_dashboard`** (`GET /api/defects/dashboard`) rewritten from a full `_scoped_defects(...).all()` fetch +
Python `Counter()` into real SQL `GROUP BY` aggregates for `by_status`/`by_severity`/`by_priority`/
`by_application`/`by_assignee` (the last via an `outerjoin` + `coalesce(User.full_name, 'Unassigned')`, since
`assignee_name` is a Python property, not a column) -- matching `TestCaseSummaryOut`/`TestExecutionSummaryOut`'s
own "SQL COUNT/GROUP BY, never a full-row fetch" discipline from section 41. `by_ageing`/`closure_trend` stay
computed in Python (the age-bucket computation doesn't translate cleanly across this app's SQLite/Oracle dialect
split) but now select only `(reported_at, closed_at)` instead of hydrating full `Defect` ORM rows. Four new fields
-- `attention_count`, `mine_count`, `unlinked_count`, `retest_count` -- back Defects.tsx's queue tabs, which used
to be `.filter().length` over the whole (now-paginated) list; `retest_count` is free (sum of two already-grouped
`by_status` buckets), the other three are compound conditions needing their own indexed `COUNT`.

**`frontend/src/modules/test-management/Defects.tsx`:** rewritten onto `usePaginatedList<DefectListOut>` +
`server={{...}}` table, PAG-006 `openDefect(id | defect_key)` fetch-on-open (shows "Opening…" on the clicked row),
and the queue-tab/health-strip counts read straight off `DefectDashboardOut` instead of client-side `.filter()`.
The one picker that still needed a broad candidate set -- `TransitionModal`'s "Original Defect ID" duplicate
picker (`SearchableSelect` has no async/server-search mode) -- is now sourced from a dedicated
`page_size=100`-capped fetch, documented as the same "effectively all of them" compromise used by every other
full-list `SearchableSelect` picker in this rollout, explicitly *not* a PAG-010 unpaginated endpoint (the defect
register has real unbounded growth, unlike Test Cases' folder tree).

**Downstream consumers of `/api/defects` fixed:** `TestExecution.tsx`'s cycle-completion gate (now
`PageOut<DefectListOut>?cycle_id=...&page_size=100`) and its `LinkExistingDefectModal` (now
`queue=unlinked&status=<every non-terminal status>&page_size=100`, reproducing the old client-side
`!execution_id && status not in (Closed,Rejected,Duplicate)` filter server-side); `components/LinkedDefects.tsx`
(now `PageOut<DefectListOut>` + `page_size=100` + `.items`, used by every module's own "defects linked to this
record" panel).

**Pending Approvals (`GET /api/pending-approvals`) -- deliberately left unpaginated.** Investigated as part of
task #61 but not converted: every one of its ~7 category queries already filters to "genuinely awaiting THIS
user's decision right now," which self-bounds the result the same way `MyExecutions.tsx`'s own "assigned to me"
queue does -- an item leaves the list the moment it's acted on, so it's a live personal action queue, not a
growing historical register. Silently truncating it to one page could hide a real pending approval from the one
person who needs to act on it, a worse outcome for a governed QA portal than one unpaginated fetch. Documented
directly in `routers/pending_approvals.py`'s own module docstring.

**Approval Workflow Log / Approval History (`routers/approvals.py`) -- split into two endpoints instead of
changing the existing one.** `GET /api/approvals` (bare array) has ~13 call sites across the app
(`Defects.tsx`, `TestRepository.tsx`, `TestProjects.tsx`, `TestExecution.tsx` alone has 9, `JiraActivity`'s own
per-entity feed, `Dashboard.tsx`'s Recent Activity widget) that all pass an explicit `entity_type`+`entity_id`
pair -- each of those feeds is inherently bounded (one record's own approval history never grows past what that
one record could accumulate), so wrapping the existing endpoint in `Page[T]` would have broken all 13 for no
benefit. Instead, the shared filtering/scoping logic (department scope via `resolve_entity_department`, the
Draft/Cancelled QA_REQUEST hiding, the 500-row cap) was extracted into `_filtered_approval_rows()`, and a new
`GET /api/approvals/history` endpoint -- `pagination.Page[ApprovalActionOut]`, `entity_type`-only filter, no
`entity_id` -- was added purely for `modules/governance/Approvals.tsx`'s "Approval Workflow Log," the one screen
that genuinely browses this feed page by page. `GET /api/approvals` itself is completely unchanged. Department
scoping can't be pushed into the SQL query itself for either endpoint -- `ApprovalAction.entity_type` is
heterogeneous (QA_REQUEST/SAST/DAST/.../DEFECT, each resolved via `resolve_entity_department`'s own per-row
lookup against a different table, not one joinable column) -- so `list_approval_history` paginates the
already-Python-filtered result rather than running a true SQL `COUNT`/`OFFSET`; its `total`/`total_pages` reflect
the same 500-row ceiling `list_approvals` already had before this endpoint existed, not a true unbounded count.
Properly fixing that would mean denormalizing a `department` column onto `ApprovalAction` at write-time across
every router that creates one -- called out as out of scope for this rollout, same reasoning as Test
Cases/Executions' own documented scope cuts in section 41.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean together.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`logs`/`uploads` leftovers differ).

## 43. Performance optimization Phase 3 -- pagination rollout for Documents, Users, Audit Log

**Context:** continues the PAG-001..010 rollout (task #62).

**Documents -- investigated, no change needed.** There is no standalone "Documents" browsing screen anywhere in
the app; every `GET .../documents`/`.../attachments` endpoint (`qa_requests.py`, `functional.py`, `sast_dast.py`,
`performance.py`, `signoff.py`, `suppression.py`, `defects.py`, `approvals.py`'s comment attachments,
`test_execution.py`'s run/result images) is scoped to exactly one parent record's own uploads -- inherently
bounded by how many files one QA Request/defect/comment could ever accumulate, not a candidate for the
unbounded-growth problem pagination exists to solve.

**Users.** `backend/app/routers/auth.py` has three separate user-list endpoints with very different growth
shapes:
- `GET /api/auth/users` (active-only) -- left unpaginated. 9 separate call sites across the app use it purely as
  a name-lookup/assignee-picker source needing the complete active directory at once, the same reference-data
  role `/api/departments`/`/api/application-names` already play. Documented directly in the endpoint's own
  docstring.
- `GET /api/auth/users/all` (Admin Users, `Admin.tsx`) -- the one genuine org-wide browse table, and the one that
  was actually doing the "fetch everything, filter/paginate client-side" thing this whole rollout replaces.
  Rewritten onto `pagination.Page[UserOut]` with a new `account_filter=active|disabled|review` param
  (encapsulating Admin.tsx's existing tri-state dropdown exactly, mirroring the `queue=`/`assignment=` convention
  from Defects/Test Executions) plus `login_type` and `search` (full_name/username/email/department -- role-label
  search dropped, since `roles` is a many-to-many join, not a plain column). Added `GET /api/auth/users/summary`
  (`UserSummaryOut`: total/active_count/ldap_count/review_count, four indexed `COUNT`s) backing the account-summary
  strip and sidebar badge Admin.tsx used to compute via `.filter().length` over the whole directory.
  `Admin.tsx` rewritten onto `usePaginatedList<UserOut>` + `server={{...}}` table; every inline mutation
  (department/roles/admin_managed_only/is_active toggle, create user, password reset) now calls a shared
  `refreshUsers()` (reload current page + summary) instead of patching a locally-held full array.
- `GET /api/auth/local-admin/users` (Department Coordinator roster, `DepartmentAdmin.tsx`) -- deliberately left
  unpaginated. Scoped to one department's own headcount (excluding admins/confidential roles), naturally bounded
  the same way Test Cycles/Test Projects and Pending Approvals were left alone earlier in this rollout. Documented
  in both the endpoint's own docstring and a matching comment in `DepartmentAdmin.tsx`.

**Audit Log (`backend/app/routers/audit.py`, `frontend/src/modules/governance/AuditLog.tsx`).** Unlike almost
everything else in this rollout, `GET /api/audit` already did real SQL `OFFSET`/`LIMIT` pagination with a genuine
`COUNT` -- it just predated `pagination.py` and had its own bespoke contract (`page_size` default 5, range 5-200,
a `{rows, total, page, page_size, summary}` envelope) instead of the shared one. Migrated for consistency, not
correctness: `list_audit_logs` now takes `pagination.PageParams` and returns `pagination.Page[AuditLogOut]`
(standard 25/50/100 `page_size`); the three summary counts (`failed`/`authentication`/`access_management`) moved
to a new `GET /api/audit/summary` endpoint accepting the same filters, matching the `DefectDashboardOut`/
`TestCaseSummaryOut`/`UserSummaryOut` pattern used everywhere else in this rollout. `event_type`/`outcome` stay
plain query params (two independent dimensions, don't map onto `apply_status_filter`'s single-column IN-filter
shape). The now-dead `schemas.AuditLogPage`/`frontend/src/types.ts`'s `AuditLogPage` (superseded by `Page[T]`) and
its own hand-rolled Previous/Next footer (`AuditLog.tsx`'s `.audit-pagination` CSS, now unused) were removed;
`AuditLog.tsx` rewritten onto `usePaginatedList<AuditLogOut>` + `<Table server={{...}}>`, the same pattern as
every other paginated screen in the app.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean together.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`logs`/`uploads` leftovers differ).

## 44. PAG-010 verification -- export endpoints confirmed unrestricted

**Context:** task #63 of the PAG-001..010 rollout -- an explicit audit (not a code change) confirming that no
export/CSV/XLSX-generation endpoint was accidentally capped to one page while converting its sibling *list*
endpoint to `pagination.Page[T]` throughout sections 40-43.

**Audited:** every route whose path contains "export" across `audit.py`, `defects.py`, `functional.py`,
`performance.py`, `qa_requests.py`, `sast_dast.py` (SAST + DAST), `signoff.py`, `suppression.py`,
`test_execution.py`, `test_repository.py` -- 11 endpoints total. Each one still runs an unrestricted `.all()`
fetch of its fully-filtered/scoped query (the same `_filtered_query()`/`_scoped_defects()`-style helpers their
now-paginated list siblings also use, just without `pagination.paginate()` applied on top) -- confirmed PAG-010
compliant, none accidentally truncated.

**Noted, not changed:** `reports.py::audit_evidence` (the separate Reports/Export Centre "Audit Evidence Report,"
unrelated to both this rollout's `routers/audit.py` and the removed Test Management "Audit Evidence" view from
sections 33-37) has a pre-existing hardcoded `.limit(1000)` on its `ApprovalAction` query -- present before this
rollout began, not introduced or touched by it. Left as-is; changing a report's own data-completeness semantics
without being asked is out of scope for a pagination-consistency pass.

**Verified:** read-only audit via `grep`/targeted reads, no code changes this section.

## 45. Dashboard summary endpoint + Redis caching + invalidation (DSH-001..007)

**Context:** a separate Performance Optimization initiative (DSH-001..007), following the pagination rollout
(sections 40-44). `Dashboard.tsx`'s Command Centre tab had its own in-repo comment already naming the intended
fix: computing four derived numbers -- active/child request counts, nearing-release count, critical-pending
count -- plus the Functional lifecycle breakdown, by fetching 4-5 complete `page_size=100` request collections
into the browser and filtering/counting them client-side, every time the tab was viewed.

**Backend (`routers/dashboard.py`):** added `GET /api/dashboard/summary`, returning
`{child_requests_total, active_requests_count, nearing_release_count, critical_pending_count,
functional_status_counts}`. `child_requests_total`/`active_requests_count` are computed via `COUNT()` over each
of the four child-request models (Functional/SAST/DAST/Performance), respecting `date_from`/`date_to` and
department scope the same way `project-wise`/`3w` already do. `nearing_release_count` (QARequest with
`target_release_date` in the next 14 days) and `critical_pending_count` (Critical-priority Functional requests
at one of the 4 pending-approval statuses) deliberately do *not* apply the date range, matching CommandCentre's
own pre-existing all-time behavior for those two numbers (the "Raised" range filter was found to be dead/
hardcoded to `'all'` with no UI control, so this only matters if that control is ever reintroduced).
`functional_status_counts` is a raw `GROUP BY status` dict, not pre-bucketed into the 6 lifecycle stages --
`Dashboard.tsx`'s own `STATUS_STAGE_INDEX`/`lifecycleDistribution()` stays the single source of truth for stage
grouping, avoiding a second, driftable copy of that mapping on the backend.

**Caching (DSH-005/006):** read-through Redis cache via `cache.py` (`get_json`/`set_json`, 60s TTL), keyed
`dashboard:summary:v1:{department-scope}:{date_from}:{date_to}` so every distinct scope/range combination caches
independently. Degrades to computing on every request if Redis is absent/unreachable -- `cache.py` was already
designed for that.

**Invalidation (DSH-007, `main.py`):** rather than threading a `cache.delete_prefix()` call through the ~30
individual create/transition/update endpoints spread across `qa_requests.py`/`functional.py`/`sast_dast.py`/
`performance.py` (high blast radius, easy to miss one), hooked into the existing `application_audit_middleware`
-- which already runs on every `/api` request and already classifies each request's module for audit logging.
Added `_DASHBOARD_SUMMARY_INVALIDATING_MODULES = {QA_REQUEST, FUNCTIONAL_REQUEST, SAST_REQUEST, DAST_REQUEST,
PERFORMANCE_REQUEST}`; after a successful (`status_code < 400`) POST/PUT/PATCH/DELETE against any of those
modules, the middleware calls `cache.delete_prefix("dashboard:summary:")` once, invalidating every cached
scope/range variant together rather than trying to work out which one variant a given write could have affected.
Runs inline on the request path (not via `BackgroundTask`) since `delete_prefix` is a fast, never-raising
best-effort call by its own contract.

**Frontend (`Dashboard.tsx`):** `CommandCentre` now fetches `/api/dashboard/summary` alongside its existing
`project-wise`/`3w`/`approvals` calls and reads `activeRequestsCount`/`nearingRelease`/`criticalPending`/the
4th stat card's footline straight off the response, instead of deriving them from `requests`/
`functionalRequests`/`sastRequests`/`dastRequests`/`performanceRequests` props. `LifecycleStepper` and
`lifecycleDistribution()` were changed to take a `Record<string, number>` status-count dict
(`summary.functional_status_counts`) instead of a full row array. `CommandCentre` no longer takes those five
request-list props at all -- they're still fetched once at the `Dashboard` level (unchanged) because
`MyRequestsTab` still needs the real rows for its own genuine "browse my/my department's requests" table, which
was explicitly out of scope for this summary endpoint. Added `DashboardSummaryOut` to `types.ts`.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`logs`/`uploads`/`venv` leftovers differ).

## 46. Fix ORA-00979 on `GET /api/defects/dashboard`'s by-assignee aggregate

**Reported directly** (live Oracle error, not caught locally -- this app has no live Oracle in the sandbox used
for the rest of this session's verification):

```
ORA-00979: "QAP_USERS"."FULL_NAME": must appear in the GROUP BY clause or be used in an aggregate function
[SQL: SELECT coalesce(qap_users.full_name, :coalesce_2) AS coalesce_1, count(qap_defects.id) AS count_1
FROM qap_defects JOIN qap_requests ... LEFT OUTER JOIN qap_users ...
GROUP BY coalesce(qap_users.full_name, :coalesce_3)]
```

**Root cause:** section 42's `defect_dashboard` rewrite (`by_assignee`) called `func.coalesce(models.User.full_name,
"Unassigned")` twice -- once building the `.with_entities(...)` select list, once building `.group_by(...)`. Each
call constructs its own bind parameter for the `"Unassigned"` literal (`:coalesce_2` vs `:coalesce_3` above), so
even though the two expressions are textually/semantically identical, oracledb's thin driver doesn't recognize
the `GROUP BY` clause as covering the `SELECT` list's `full_name` reference and rejects the query. SQLite (used
for local/sandbox verification all session) is lenient about this and never surfaced it, which is why
`py_compile`-only verification missed it -- this endpoint was never actually executed against a real Oracle
instance until now.

**Fix (`routers/defects.py::defect_dashboard`):** build the coalesce expression once
(`assignee_label = func.coalesce(models.User.full_name, "Unassigned")`) and pass that same object to both
`.with_entities(assignee_label, ...)` and `.group_by(assignee_label)`, so SQLAlchemy compiles one shared bind
parameter instead of two. No behavior change -- same grouping, same "Unassigned" fallback -- purely a
same-object-reuse fix so Oracle's GROUP BY validation matches it to the SELECT list.

**Verified:** `python3 -m py_compile app/routers/defects.py` clean; no live Oracle available in this environment
to re-run the query directly, so this was verified by code inspection against the documented SQLAlchemy/Oracle
behavior (reusing one `ColumnElement` instance across `with_entities`/`group_by` is the standard fix for this
exact class of ORA-00979). Recommend the person exercising this against their live Oracle instance confirm
`GET /api/defects/dashboard` now returns 200.

## 47. Fix DetachedInstanceError on `actor.roles_csv` in the audit background task

**Reported directly** (live traceback): every request was crashing its post-response audit-write background
task with `sqlalchemy.orm.exc.DetachedInstanceError: Parent instance <User ...> is not bound to a Session; lazy
load operation of attribute 'role_assignments' cannot proceed`, raised from `models.py::User.roles` (via
`roles_csv`) inside `audit_service.write_audit`, called from `main.py::_write_request_audit`.

**Root cause:** AUD-008 (section 70, an earlier session) stashes the `User` object `get_current_user` (deps.py)
already loaded onto `request.state.current_user`, so `_write_request_audit` -- which runs as a `BackgroundTask`
after the response has been sent, using its own fresh `SessionLocal()` -- can reuse it instead of decoding the
JWT and querying `User` a second time. That's fine for plain columns (`username`, `id`, `full_name`, ...), which
SQLAlchemy already loaded into the object's `__dict__` as part of the original `SELECT`. It is not fine for the
`role_assignments` relationship: that's lazy-loaded, so it's only populated if something during the original
request happened to touch `current_user.roles`/`.has_role(...)`. Whenever a request's own handler never touched
roles (many read-only endpoints don't need a role check beyond the auth dependency itself), `role_assignments`
was still unloaded by the time the background task ran -- and by then the *original* request-scoped `db` session
(from `Depends(get_db)`) was already closed, so the lazy load had no session to use and raised
`DetachedInstanceError`. This wasn't introduced by the pagination/dashboard work in sections 40-46; it's a
latent gap in AUD-008 that this traceback surfaced.

**Fix (`deps.py::get_current_user`):** eagerly load `role_assignments` via
`.options(selectinload(models.User.role_assignments))` on the same query that already fetches the user, so the
relationship is always materialized in memory before the object is stashed on `request.state` -- regardless of
whether anything in the actual request handler happens to touch `.roles`/`.has_role()`. `selectinload` (a second
targeted `SELECT ... WHERE user_id IN (...)`, not a join) was chosen over `joinedload` to avoid fanning out the
main `User` row across however many roles a user holds.

**Defense in depth (`audit_service.py::write_audit`):** the function's own docstring says "Best-effort append...
must never break the action," but the existing `try/except` only wrapped `db.add()`/`db.commit()` -- the
`actor.roles_csv`/`.full_name`/`.id`/`.username` reads used to build the `AuditLog(...)` row happened *before*
that `try`, so any exception reading them (this one, or a future one) escaped uncaught, contradicting the
function's own contract. Widened the `try` to cover the whole row construction, not just the DB write, so a
failure to log an audit entry can never again surface as an unhandled exception in the request/background-task
path.

**Verified:** `python3 -m py_compile app/deps.py app/audit_service.py` (and the full `app/*.py app/routers/*.py`
sweep) clean. No live server in this sandbox to reproduce the original traceback directly; the fix was verified
by tracing the exact attribute-access chain in the reported stack trace (`write_audit` → `actor.roles_csv` →
`User.roles` → `self.role_assignments`) against the eager-load change. Documents and outputs copies re-synced
and confirmed identical via `diff -rq`.

## 48. Fix silent request undercount on Dashboard's "My Requests" tab

**Context:** raised directly after a walkthrough of every `page_size=100` "fetch effectively all of it" compromise
introduced across the pagination rollout (sections 40-46), to separate genuine live risk from accepted
picker-convenience trade-offs.

**Root cause:** `Dashboard.tsx`'s `MyRequestsTab` took `requests`/`functionalRequests`/`sastRequests`/
`dastRequests`/`performanceRequests` as props -- a single Dashboard-level fetch of each request type's
department-scoped page 1 (`?page_size=100`, `sort_order` defaulting to `desc`), originally hoisted up from both
`CommandCentre` and `MyRequestsTab` to avoid double-fetching. It then filtered that shared list client-side to
`requester_id === user.id` ("My Requests") or `department === user.department` ("My Department"). Because the
fetch itself was already capped at the 100 *most recent* requests of each type across the user's whole
department, a user's own older request would silently vanish from their own "My Requests" tab -- with no error,
no indication -- as soon as their department raised more than 100 requests of that one type after it was
submitted. For an unrestricted-scope role (QA Lead, QA Engineer, Security Analyst, the three Executive-COE
roles, Scale 6+ -- see `dashboard_department_scope`), the underlying fetch wasn't even department-scoped, so
"My Department" could undercount as soon as the *organization* crossed 100 requests of one type, not just the
user's own department. DSH-001..004 (section 45) already removed `CommandCentre`'s need for this fetch entirely
(it now uses `/api/dashboard/summary`), but explicitly left `MyRequestsTab`'s row-browsing fetch untouched as
out of scope -- the truncation risk itself was never addressed until now.

**Backend (`qa_requests.py`, `functional.py`, `sast_dast.py` ×2, `performance.py`):** added an optional
`requester_id: Optional[int] = None` query param to each of the 5 list endpoints (`list_requests`,
`list_functional`, `list_sast`, `list_dast`, `list_performance`), filtering `Model.requester_id == requester_id`
when present. Applied after the existing status/search/department filters and the unconditional
`dashboard_department_scope` authorization filter, so it's a pure additional narrowing, not a bypass of either.
All 5 response schemas (`QARequestListOut`/`FunctionalListOut`/`SASTListOut`/`DASTListOut`/`PerformanceListOut`)
already carried `requester_id`; the column already existed on every one of the 5 tables (a real column on
Functional/SAST/DAST/Performance, not a delegated property) -- this was purely a missing query parameter, not a
schema or model change. The existing `department=` param (already wired via `pagination.apply_department_filter`
on all 5) needed no backend change -- it was already correct, just unused by this particular screen.

**Frontend (`Dashboard.tsx`):** `MyRequestsTab` no longer takes the 5 request-list props at all. It now owns two
independent fetches on mount: `requester_id=<user.id>&page_size=100` per type for "My Requests", and (when the
user has a department) `department=<user.department>&page_size=100` per type for "My Department" -- both still
capped at 100 rows per type, but now that cap means "one person's, or one department's, total lifetime volume of
a single request type," the same class of accepted "practical ceiling" already used elsewhere in this rollout
(`MyExecutions.tsx`'s `assignment=mine`, Pending Approvals' bounded personal queue), not an arbitrary,
wrongly-scoped page 1. The Dashboard-level `requests`/`functionalRequests`/`sastRequests`/`dastRequests`/
`performanceRequests`/`requestsLoaded`/`requestsError` state and its shared `useEffect` were removed entirely --
nothing else in the file used them once `MyRequestsTab` became self-contained (matching how every other Dashboard
tab -- `SecurityTab`, `SuppressionTab`, `ThreeWTab`, `TesterOverviewTab` -- already owns its own fetch,
re-running each time the tab is mounted). This also means these 10 API calls (5 types × 2 scopes) now only fire
when a visitor actually opens the "Requests" tab, instead of unconditionally on every Dashboard page load.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean. Documents
and outputs copies re-synced and confirmed identical via `diff -rq`.

## 49. Section 47's fix was incomplete -- actual fix: snapshot, don't reuse the ORM object

**Reported directly** (a second live traceback, same background task, after section 47 shipped):

```
File "main.py", line 248, in _write_request_audit
    actor_username = actor.username if actor else None
sqlalchemy.orm.exc.DetachedInstanceError: Instance <User at 0x10d7959d0> is not bound to a Session;
attribute refresh operation cannot proceed
```

**Why section 47 didn't fully fix it:** that fix eager-loaded `role_assignments` so `actor.roles_csv` would never
need to lazy-load a relationship off a detached object. It correctly fixed *that* failure mode. This second
traceback is a different one, on a plainer attribute: `actor.username` -- a scalar column that was already
loaded (part of the original `SELECT`), not lazy at all. The actual mechanism: SQLAlchemy's `Session` defaults to
`expire_on_commit=True`, which marks *every* attribute on *every* object touched by that session as expired the
moment `db.commit()` runs anywhere in the request -- e.g. any of the many mutating (`POST`/`PUT`/`PATCH`/
`DELETE`) endpoint handlers that write and commit. An expired attribute silently re-fetches from the database on
next access, using its own session -- fine while the request is still in flight, but by the time
`_write_request_audit` runs as a `BackgroundTask`, that original session (from `Depends(get_db)`) is already
closed, so the re-fetch has nowhere to go and raises `DetachedInstanceError`. Eager-loading a relationship only
ever prevents *that one relationship's* lazy-load; it does nothing about a wholesale post-commit expiry of
everything else on the object. There is no set of "preload enough columns" that reliably survives this -- the
object is fundamentally unsafe to read outside the session that (re)loaded it, full stop.

**Actual fix -- stop reusing the ORM object across the session boundary entirely:**

- **`deps.py::get_current_user`:** immediately after loading `user` (still inside its own valid, unexpired `db`
  session), captures a plain `dict` snapshot -- `{"id", "username", "full_name", "roles_csv"}` -- onto
  `request.state.current_user_snapshot`. `request.state.current_user` (the live ORM object) is still stashed too,
  since nothing else needed changing there, but the snapshot is what's meant to survive to the background task.
- **`main.py::_write_request_audit`:** now reads `request.state.current_user_snapshot` instead of
  `request.state.current_user`. Every value it needs (`actor_username`/`actor_id`/`actor_name`/`actor_roles`)
  comes straight out of that plain dict -- no ORM attribute access on a possibly-detached object anywhere in this
  function any more. The pre-existing fallback path (JWT decode + fresh `db.query(...)` when no snapshot exists,
  e.g. login/public routes) is untouched and was always safe, since that query uses this function's own,
  currently-open `db` session.
- **`audit_service.py::write_audit`:** gained three new optional keyword params -- `actor_id`, `actor_name`,
  `actor_roles` -- alongside the pre-existing `actor_username`. Every other caller of `write_audit` in the
  codebase (all in `routers/auth.py`, login/logout/user-management flows) passes a live, *same-session* `actor=`
  object and is completely unaffected; `actor=`, when given, still wins over the plain-value params. Only
  `_write_request_audit`'s snapshot path now uses the new params instead of `actor=`.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. No live server in this sandbox to
reproduce the original traceback directly; verified by re-tracing the exact same attribute-access chain from
both reported tracebacks (`_write_request_audit` → `actor.username` / `actor.roles_csv`) and confirming neither
code path touches the detached object any more. Documents and outputs copies re-synced and confirmed identical
via `diff -rq`.

## 50. Group-Based QA Assignment spec -- discovered mostly implemented; consolidated the QA Executive roles

**Context:** handed a full "Group-Based QA Assignment and Approval Requirement" spec asking for individual
QA Lead/Executive assignment to be replaced with role-based "any active group member can act" assignment.
Investigated the current codebase before writing any code, per this session's standing discipline.

**Finding:** the spec's core mechanic was already live, not a gap. Every approval gate that matters (QA Lead
review, Department Head Approval, Executive COE/Sign-off) was already authorized via `require_roles(...)` --
role membership, never an individually-assigned user. `functional.py`'s `_require_assigned_qa_lead` function
name is stale relative to what it does -- it only checks `user.has_role(Role.QA_LEAD)`. The individual-assignee
columns (`qa_lead_id`, `security_lead_id`, `engineer_id`) still exist on `FunctionalRequest`/`SASTRequest`/
`DASTRequest`/`PerformanceRequest` but every write path already nulls them out unconditionally -- dead columns,
not a missing mechanism. The frontend already replaced any individual picker with `RoleGroupLink.tsx`
("Any member of this group can act on work assigned to {label}"), used identically across Functional/SAST/
DAST/Performance. An in-app notification system with a group-fanout helper (`notifications.fire()`) already
exists. Confirmed directly with the person who supplied the spec; no code changes were made for the
already-implemented mechanics -- this section documents the actual gap instead.

**The real, confirmed gap: two overlapping "QA Executive" role pairs causing genuine confusion.**
`CHEIF_MANAGER_COE`/`CHEIF_MANAGER_QA`/`AGM_COE` (3 roles, all identical authority at the Executive COE / QA
Sign-off checkpoint -- a 2026-08 split from a single old `DEPARTMENT_HEAD_COE` role purely so approval logs
could show CM vs AGM) coexisted with `CHEIF_MANAGER_QA`/`AGM_QA` (the pair already used for Test Management
Stage 2 final approval). Confirmed directly ("no ther pair is required, creating lots of confusion"): consolidate
down to exactly one QA Executive Group -- `CHIEF_MANAGER_QA` and `AGM_QA` -- used consistently everywhere.
`CHEIF_MANAGER_COE` and `AGM_COE` are retired entirely. `CHEIF_MANAGER_QA`'s own spelling ("Cheif") is also
corrected to `CHIEF_MANAGER_QA`, baked into the constant's value itself, not just its label.

**Backend:**
- `constants.py`: `Role.CHEIF_MANAGER_QA` renamed to `Role.CHIEF_MANAGER_QA` (name and value both corrected).
  `Role.CHEIF_MANAGER_COE` and `Role.AGM_COE` removed entirely. `ALL_ROLES`/`ROLE_LABELS` updated to match.
- Every authorization check, role set, and comment across `deps.py` (`DASHBOARD_DEPARTMENT_UNRESTRICTED_ROLES`,
  `can_give_final_approval`, project-membership checks), `routers/notifications.py`, `routers/audit.py`
  (`AUDIT_ROLES`), `routers/dashboard.py` (`qa_tester_workload`'s team check), `routers/defects.py`,
  `routers/test_execution.py`, `routers/test_repository.py`, `routers/auth.py` (local-admin assignable-role
  logic and both local-admin `require_roles(...)` gates), `routers/pending_approvals.py`, and --
  the one place this is a genuine authorization-narrowing change, not just a rename -- `routers/signoff.py`'s
  `executive_coe_decision` and `_can_view_signoff` (the Executive COE / QA Sign-off checkpoint) now check
  `Role.CHIEF_MANAGER_QA, Role.AGM_QA` (2 roles) instead of `Role.CHEIF_MANAGER_COE, Role.CHEIF_MANAGER_QA,
  Role.AGM_COE` (3 roles) -- confirmed directly this is the intended checkpoint the "Executive Group" describes.
  `seed.py`'s demo users consolidated from 3 (`cm1`/`cheifmanagerqa1`/`agm1`) to 2.
- `TEST_MANAGEMENT_PERMISSIONS.md` (live documentation, not changelog history) updated to match.
- **New: `app/migrate_role_consolidation_2026_08.py`** -- this app has no Alembic (additive-only schema, see
  `database.py`'s own docstring), and the role values above are *data* already stored on live `qap_user_roles`
  rows, not schema `create_all()` would ever touch. This one-time, idempotent, safe-to-re-run script (run via
  `python -m app.migrate_role_consolidation_2026_08`) renames existing rows: `CHEIF_MANAGER_QA` (misspelled) ->
  `CHIEF_MANAGER_QA`, `CHEIF_MANAGER_COE` -> `CHIEF_MANAGER_QA`, `AGM_COE` -> `AGM_QA`, deleting rather than
  double-inserting when a user already holds the merge target (`qap_user_roles` has
  `UniqueConstraint(user_id, role)`). **This must be run by hand against the live database after deploying this
  code** -- not run in this session, since no live database exists in this sandbox.

**Frontend:** `constants.ts` (`ROLE_LABELS`, `ALL_ROLES`, `DASHBOARD_DEPARTMENT_UNRESTRICTED_ROLES`), plus every
component with a hardcoded role check: `DepartmentAdmin.tsx` (`isQAAdmin`), `SignOff.tsx`
(`canExecutiveCoeDecide`), `TestExecution.tsx`, `Defects.tsx`, `Layout.tsx` (Audit Log nav gate, Department
Coordinator nav gate), `TestRepository.tsx`, `Dashboard.tsx` (`REQUESTS_TAB_HIDDEN_ROLES`,
`showTesterOverviewTab`) -- same rename/consolidation applied throughout.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean. Repo-wide
grep confirms zero remaining live-code references to `CHEIF_MANAGER_QA`/`CHEIF_MANAGER_COE`/`AGM_COE` (only
explanatory comments and the migration script's own literal old-value strings remain). Documents and outputs
copies re-synced and confirmed identical via `diff -rq`.

**Not yet done (deliberately out of this pass, no user request yet):** the spec's "first valid action wins"
concurrency conflict message, the structured audit-field list in its Section 9, and its exact Pending Approvals
column set were not implemented -- the person's answers scoped this pass specifically to the role consolidation
and the "which stage is the Executive Group" mapping; those other items weren't confirmed as wanted yet.

## 51. "Assigned Group" showed "QA Lead" unconditionally, regardless of actual workflow stage

**Reported:** on a Functional Request still sitting at SM Approval Pending, the detail page's People section
showed "Assigned Group: QA Lead (2)" -- screenshot with "sm aprroval not completed but still QA Lead assigned".

**Root cause:** `Functional.tsx`, `SAST.tsx`, `DAST.tsx`, and `Performance.tsx` each rendered this field (and
the identically-named list column) as a hardcoded literal --
`<RoleGroupLink users={users} role="QA_LEAD" label="QA Lead" />` / `render: () => 'QA Lead'` -- never reading
`req.status` at all. Every request showed "QA Lead" from the moment it was created, including while still with
the requester, SM, or Department Head. Apparently copy-pasted boilerplate from whichever module got
`RoleGroupLink` first, never made status-aware in the other three.

**Fix:** added a per-module `assignedGroupFor(status)` helper to each of the four files, used by both the
detail-view field and the list column. Rather than hand-deriving a fresh status list per module (risking a
second, differently-wrong mapping), each helper is built directly on top of that module's existing, already
backend-verified "Pending With" table (`QA_PENDING_WITH` / `SAST_DAST_PENDING_WITH` / `PERFORMANCE_PENDING_WITH`
in `constants.ts`, each already kept in sync with its router's `require_roles(...)` gates and already driving
the list's own "Pending With" column) -- translating the small set of group-owned labels ("SM", "Department
Head", "QA Lead", "Security Analyst", "QA") into `{role, label}` pairs for `RoleGroupLink`, and returning `null`
(rendered as "--") for every requester-owned or terminal status ("Requester", "--"). `RoleGroupLink.tsx` was
widened to accept `role: string | string[]` to support Department Head's two roles
(`DEPARTMENT_HEAD_CM`/`DEPARTMENT_HEAD_AGM`) and Functional/Performance's joint QA_LEAD+QA_ENGINEER "QA" stages.

An early draft of the SAST/DAST helper (before this reuse-the-existing-table approach) had independently
listed `WAITING_FOR_FIX` under Security Analyst -- wrong, per `SAST_DAST_PENDING_WITH`'s own comment: that
stage is genuinely "Requester" (the analyst has handed the finding back for a fix), even though an analyst or
admin may also click "Mark Fixed". Building the helper on top of the existing table instead of a fresh status
list caught and avoided shipping that mistake.

Left untouched: the `extraControl={<RoleGroupLink ... role="QA_LEAD" label="QA Lead" />}` shown only inside
Functional's Department-Head-decision approval buttons (a "here's who picks this up next if you approve"
preview, correct as-is, not the same field as the bug).

**Verified:** `npx tsc --noEmit -p .` clean (frontend-only change, no backend edits needed). Documents and
outputs copies re-synced and confirmed byte-identical via `diff` on all 5 touched files
(`RoleGroupLink.tsx`, `Functional.tsx`, `SAST.tsx`, `DAST.tsx`, `Performance.tsx`).

## 52. "What was the behaviour earlier?" moved from Start Execution to Readiness Passed (and Start Execution's version reverted)

**Corrected:** the original request -- "while start qa execution, system should ask tester, what was the
behaviour earlier" -- had been placed at the Functional Request's "Start Execution" step (see the now-reverted
first draft of this section, previously numbered 52). Follow-up: "revert the changes, and encorporate below.
While QA lead verify the readiness, then he will assign tester, this was the system behaviour earlier" --
i.e. the question belongs at Readiness Verification, asked of the QA Lead, before they hand off to Assign
Tester (Planning -> Assign Tester -> Tester Assigned), not at Start Execution (which happens much later, after
Test Design). The Start Execution draft (required `earlier_behaviour` field on `StartFunctionalExecutionIn`,
the matching `StartExecutionModal` textarea, and the "Behaviour earlier: ..." audit log line) was fully
reverted -- `schemas.py`, `functional.py`, and `Functional.tsx` all back to their pre-section-52 state.

**Fix, correctly scoped this time:** `readiness_decision` (`functional.py`) now rejects a `"Passed"` decision
with 400 ("Describe what the behaviour was earlier before readiness can pass") unless `payload.comments` is
non-blank -- `ReadinessDecisionIn.comments` already existed as an optional field, no schema change needed.
Only `"Passed"` is gated (leads into Planning/Assign Tester); `"Failed"` returns to the requester, a different
flow this note isn't part of.

On the frontend, this incidentally surfaced a pre-existing dead-state bug scoped to this one action: the
`comments` state `Functional.tsx` already threads into `readiness-decision`, `raise-defect`,
`mark-waiting-for-fix`, `start-retesting`, and `complete-qa` calls had no textarea anywhere in the component --
it was always `""`. A textarea (labelled "What was the behaviour earlier? (required before Readiness Passed)",
using the shared `.form-field` style) is now rendered specifically inside the `canReadinessDecide` block, and
"Readiness Passed" is disabled until it's non-blank. The other four call sites sharing this same `comments`
state were deliberately left alone (still no textarea for them) -- out of scope for this fix, not something to
silently sweep in.

**Verified:** `npx tsc --noEmit -p .` and `python3 -m py_compile app/*.py app/routers/*.py` both clean.
Documents and outputs copies re-synced and confirmed byte-identical via `diff` on all 3 touched files
(`schemas.py`, `functional.py`, `Functional.tsx`).

**Correction:** "this is not required !!!!!!!!!!" -- the field should capture the note when the QA Lead has
one, not block the workflow when they don't. Removed the 400 guard in `readiness_decision` (`functional.py`)
entirely (back to `ReadinessDecisionIn.comments` being purely optional, as it always was) and removed the
`disabled={!!busyAction || !comments.trim()}` gate on "Readiness Passed" (back to `disabled={!!busyAction}`).
Label changed from "(required before Readiness Passed)" to "(optional)". The textarea itself stays -- that
part of the ask (surfacing the field at all) was correct, only the "required" enforcement was not.

## 53. Redefined the "QA" / "QA Lead" / "Executive" role-group membership (and fixed a real Executive COE gating bug found along the way)

**Requested** (following a screenshot question, "why is agm missing?", about the "QA" group tile on a
Functional Request): "QA group limit to QA_Engineer only / QA_LEAD different Group where Chief manager and
AGM both can come if assigned / Executive also Chief Manager and AGM only." Three role-group membership rules,
all about which users a `RoleGroupLink` tile lists as members -- not an authorization/require_roles() change:

- **"QA" execution-stage tile** (Functional/Performance, shown at TESTER_ASSIGNED/TEST_DESIGN/
  EXECUTION_IN_PROGRESS/RETESTING / ENVIRONMENT_SETUP/SCRIPT_DEVELOPMENT/BASELINE/LOAD_TEST_EXECUTION): was
  `[QA_LEAD, QA_ENGINEER]`, now `QA_ENGINEER` only.
- **"QA Lead" tile** (all 4 modules' own `assignedGroupFor`, plus the Department-Head-decision "who picks
  this up next" `extraControl` preview in all 4): was `QA_LEAD` only, now also lists `CHIEF_MANAGER_QA`/
  `AGM_QA` -- "if assigned", i.e. only accounts that actually hold `QA_LEAD` (whether or not they also hold
  one of the executive roles) show up; the executive roles alone don't qualify someone for this tile.
- **"Executive" checkpoint** (SignOff.tsx's Executive COE decision): unchanged by request -- already
  `CHIEF_MANAGER_QA`/`AGM_QA` only, no `QA_LEAD`.

New shared constants in `constants.ts`, `QA_LEAD_GROUP_ROLES = ['QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA']` and
`QA_EXECUTION_GROUP_ROLE = 'QA_ENGINEER'`, imported into `Functional.tsx`/`SAST.tsx`/`DAST.tsx`/
`Performance.tsx` rather than hand-duplicating the role list across 8 call sites -- this session already hit
one real bug (SAST/DAST's `WAITING_FOR_FIX`, section 51) from independently-derived duplicate lists drifting
apart, so this one is centralized instead.

**Bug found while verifying the "Executive" claim:** `SignOff.tsx`'s `canExecutiveCoeDecide` read
`hasRole(user, 'AGM_QA')` only -- `CHIEF_MANAGER_QA` was missing entirely, even though the backend's
`executive_coe_decision` (`signoff.py`) already `require_roles(Role.CHIEF_MANAGER_QA, Role.AGM_QA)`'d both
(since the section-50 role consolidation). A Chief Manager - QA account could never see the Approve/Return
buttons at this checkpoint -- fixed to `hasRole(user, 'CHIEF_MANAGER_QA', 'AGM_QA')`, matching the backend.

**Verified:** `npx tsc --noEmit -p .` clean (frontend-only change, no backend edits needed). Documents and
outputs copies re-synced and confirmed byte-identical via `diff` on all 6 touched files (`constants.ts`,
`Functional.tsx`, `SAST.tsx`, `DAST.tsx`, `Performance.tsx`, `SignOff.tsx`).

## 54. Debugging pass: every CHIEF_MANAGER_QA/AGM_QA check in the codebase, hunting for asymmetry

**Requested:** "debug the code and if you find any ambiguity regarding AGM_QA, CHIEF_MANAGER_QA check and fix
the code" -- following the Executive-COE gating bug found in section 53. Grepped every backend and frontend
reference to both roles (~50 call sites) and read each one in context. Two real bugs fixed, one doc
inaccuracy corrected, and one deliberately-asymmetric cluster left alone with reasoning written down so it
reads as a decision, not an oversight, if anyone re-checks this later.

**Fixed -- `test_repository.py::_validate_stage2_assignee`:** rejected `AGM_QA` outright ("Stage 2 must be
assigned to a QA Lead or Chief Manager - QA"), directly contradicting `_stage2_approver_ids` nine lines above
it in the same file ("All active CM QA and AGM QA users; either one may complete Stage 2"). Since the
`eligible-users` picker isn't role-filtered, an admin could actually select an AGM_QA-only user as a test
case's Stage 2 approver in the UI and get a 400 on save. Now accepts `QA_LEAD`/`CHIEF_MANAGER_QA`/`AGM_QA`,
matching the rest of the file; error message updated to mention AGM - QA.

**Fixed -- `deps.py::_project_role_permits`:** the "don't give CM-QA the legacy non-member Test Management
access" carve-out only named `CHIEF_MANAGER_QA`. An `AGM_QA`-only account (no `QA_ENGINEER`/`QA_LEAD`) fell
through to unrestricted access on every project -- the exact "legacy QA staff" shortcut this check exists to
deny CM-QA. This was a real over-privilege, not just a gap: AGM_QA had *more* access than CM-QA here, backwards
from every other place the two roles are compared. Now both roles get the identical restriction.

**Fixed -- doc/comment accuracy, no behavior change:** `test_repository.py`'s `_AUTHOR_ROLES` comment said "QA
Engineer + QA Lead both author" without mentioning the `CHIEF_MANAGER_QA`/`AGM_QA` already in the tuple.
`TEST_MANAGEMENT_PERMISSIONS.md`'s system-role list and CM-QA row didn't mention `AGM_QA` at all, even though
the code already gives it identical Author-tier and Stage 2 standing -- updated to state plainly what's shared
(Author tier, Stage 2 approval, the project-entry restriction above) versus what isn't (see next paragraph).

**Investigated, left as-is (deliberate, not a bug):** `defects.py`'s `CREATE_ROLES`/`_is_manager` (who can
create a defect / bypass rules as a "manager"), the reopen-a-Closed-defect check, and `test_execution.py`'s
residual-defect cycle-completion override all treat `QA_LEAD`/`CHIEF_MANAGER_QA` as "manager"-tier but
deliberately exclude `AGM_QA` -- consistently, on both backend and its frontend mirrors (`TestExecution.tsx`'s
`CAN_EXEC_ROLES`, `Defects.tsx`'s manager checks). This reads as a genuine, pre-existing, well-commented
design distinct from the Aug-2026 Executive-role consolidation (which only ever claimed "identical authority
at the Executive COE / QA Sign-off checkpoint," never blanket parity everywhere) -- not something to widen
without being asked, since it's a real authorization change in a banking app. Flagging in case the intent is
actually full parity: if so, the fix is adding `Role.AGM_QA` to `defects.py`'s `CREATE_ROLES`/`_is_manager`
(both call sites) and `test_execution.py`'s residual-defect override, plus the two frontend mirrors.
`test_execution.py::_runner_or_404`'s runner-eligibility role set (`QA_ENGINEER`/`QA_LEAD`/`CHIEF_MANAGER_QA`,
no `AGM_QA`) was also checked and left alone -- an AGM-tier account being hands-on-assigned as a test runner
doesn't fit the role's purpose, so this one reads as correct rather than ambiguous.

**Also confirmed clean:** repo-wide grep for the retired `CHEIF_MANAGER_QA`/`CHEIF_MANAGER_COE`/`AGM_COE`
spellings -- zero remaining live-code references anywhere (backend or frontend); every hit is either a
historical comment or the migration script's own intentional literal old-value strings.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. Documents and outputs copies re-synced
and confirmed byte-identical via `diff` on all 3 touched files (`deps.py`, `test_repository.py`,
`TEST_MANAGEMENT_PERMISSIONS.md`).

## 55. "Application Owner" made a clickable RoleGroupLink, scoped to the request's department

**Requested:** "Application Owner Approval Pending -> HERE IN APPLICATION OWNER CREATE A LINK SO THAT ON CLICK
A MODAL OPEN WHO EVER APPLICATION ONWER ON THAT DEPARTMENT SHOULD SHOW."

**Context:** while a Functional/SAST/DAST/Performance request's own `status` is still `SM_APPROVAL_PENDING`
but its Application Name is a brand-new "Other" entry awaiting the Application Owner
(`application_master_status === 'PENDING_APP_OWNER'`), the Status badge already shows "Application Owner
Approval Pending" via `applicationNameAwareStatusLabel` (Common.tsx) -- but the "Assigned Group" field/column
next to it (People section) never accounted for this sub-state at all: it called `assignedGroupFor(req.status)`
directly, which -- since the underlying status is still `SM_APPROVAL_PENDING` -- showed a clickable "SM" group
instead, actively wrong while the request is genuinely sitting with the Application Owner. SAST/DAST's
"Assigned Group" *list column* had the same gap (their "Pending With" column already special-cased this, but
"Assigned Group" didn't).

**Fix:** `assignedGroupFor` in all 4 modules now takes two more (optional) parameters,
`applicationMasterStatus` and `department`, and checks `applicationNameAwareStatusLabel(status,
applicationMasterStatus)` first, ahead of the normal status-driven mapping -- returning `{ role:
'APPLICATION_OWNER', label: 'Application Owner', department }` whenever that sub-state applies. Every detail-
view call site now passes `req.application_master_status, req.department`; every list-column call site passes
`r.application_master_status` (list rows don't render a clickable link, so `department` isn't needed there --
see below).

`RoleGroupLink.tsx` gained an optional `department` prop: when set, it further filters the member list to
`user.department === department`, on top of the existing role filter. Application Owner is enforced
server-side by `require_same_department` (`decide_app_owner_name`), so without this, the modal would list
every Application-Owner-role-holder company-wide, including people who could never actually decide this
specific request's name -- misleading given the modal's own copy ("Any member of this group can act on work
assigned to..."). The empty-state and summary copy both mention the department now too when scoped.

**Deliberately not changed:** the "Assigned Group" *list column* stays plain text (`.label`), not a clickable
link -- consistent with how every other group (SM, Department Head, QA Lead, ...) has always rendered in that
column; only the *label text itself* needed fixing there (was wrongly showing "SM"), not its interactivity.
The other `RoleGroupLink` consumers (SM, Department Head, QA Lead, Security Analyst, Executive, QA) were left
un-scoped by department -- SM and Department Head are also department-enforced server-side and would benefit
from the same treatment, but that's a separate, unrequested change; flagging it in case it's wanted next.

**Verified:** `npx tsc --noEmit -p .` clean (frontend-only change, no backend edits needed). Documents and
outputs copies re-synced and confirmed byte-identical via `diff` on all 5 touched files (`RoleGroupLink.tsx`,
`Functional.tsx`, `SAST.tsx`, `DAST.tsx`, `Performance.tsx`).

## 56. Correction: the Application Owner link belonged on the QA Request gateway page, not the child requests

**Corrected:** "I AM ASKING HERE" -- with a screenshot of the master QA Request gateway's own Overview tab
(`QARequests/RequestDetail.tsx`), Application & Change section, Application Name field -- not the child
Functional/SAST/DAST/Performance pages section 55 touched. This is where `ApplicationNameBanner`/the
"Application Owner Approval Pending" status pill genuinely live (per its own comment: "the actual App
Owner/SM decision banner... now lives on this one master QA Request page instead of being duplicated across
every linked ... request's own page"). That pill was a plain, non-interactive
`<span className="badge badge-yellow">Application Owner Approval Pending</span>`.

**Fix:** `RoleGroupLink.tsx` gained an optional `renderTrigger?: (count, onClick) => ReactNode` prop -- every
other consumer of this component (including section 55's own new usage) is fine with its default "{label}
{count}" button, but this pill needed to open the exact same members modal while keeping its own existing
pill styling/wording completely unchanged. The pill is now a `<button>` (same `badge badge-yellow` classes,
plus `border: none`/`font: inherit` inline so it doesn't pick up native button chrome in the browser's default
stylesheet) wrapped in `RoleGroupLink` with `role="APPLICATION_OWNER"` and `department={req.department}` --
same department-scoped member list as section 55, on the page actually being asked about this time.

**Verified:** `npx tsc --noEmit -p .` clean. Documents and outputs copies re-synced and confirmed byte-identical
via `diff` on both touched files (`RoleGroupLink.tsx`, `QARequests/RequestDetail.tsx`).

## 57. "QA Readiness Verification Pending" (and its SAST/DAST/Performance equivalents) now also surface in Pending Approvals

**Reported:** "While QA Readiness Verification Pending, that should also come as Pending Approval section."

**Root cause:** `pending_approvals.py::_readiness_items` (`_READINESS_MODULES`) only ever queried each module's
*second* QA-Lead-group checkpoint -- `READINESS_VERIFICATION` / `SECURITY_READINESS` / `READINESS` (the
"Readiness Passed/Failed" decision) -- never the *first* one: `QA_LEAD_ASSIGNED` / `SECURITY_LEAD_ASSIGNED` /
`ENGINEER_ASSIGNED` (the "Start Readiness Verification" click that precedes it). `QA_LEAD_ASSIGNED` is
literally labelled "QA Readiness Verification Pending" in `QA_STATUS_LABELS` -- the exact phrase reported --
so a request sitting at that status (QA Lead assigned, not yet started) never appeared in Pending Approvals at
all, even though the assigned QA Lead group can act on it right now via
`functional.py::start_readiness_verification`.

Confirmed this affects all four request types identically, not just Functional: `start_readiness_verification`
/ `sast_dast.py::_start_readiness` / `performance.py::start_readiness` and their respective
`readiness_decision`/`_readiness_decision` all gate on the exact same `_require_assigned_qa_lead`, which (per
its own current body, `if not user.has_role(Role.QA_LEAD): raise HTTPException(403, ...)`) is a flat
group-membership check with no per-request assignee restriction -- so both stages are, and always were,
equally "pending" for the whole QA Lead group, and per the file's own top-of-file design principle (a
category's inclusion must mirror its real endpoint's authorization exactly), both belong in the queue.

**Fix:** `_READINESS_MODULES` gained a second status column per module (`assigned_status` alongside the
existing `verification_status`: `QA_LEAD_ASSIGNED`, `SECURITY_LEAD_ASSIGNED` x2, `ENGINEER_ASSIGNED`).
`_readiness_items` now queries `model.status.in_([assigned_status, verification_status])` instead of a single
equality check, and labels each resulting item's category as "Start Readiness Verification" or "Readiness
Verification" depending on which of the two statuses it actually matched, so the two stages remain
distinguishable in the Pending Approvals filter chips rather than collapsing into one. `status_label` for both
new statuses was already present in each module's own labels map (`QA_STATUS_LABELS["QA_LEAD_ASSIGNED"] = "QA
Readiness Verification Pending"`, `SAST_DAST_STATUS_LABELS["SECURITY_LEAD_ASSIGNED"] = "Security Readiness
Verification Pending"`, `PERFORMANCE_STATUS_LABELS["ENGINEER_ASSIGNED"] = "Readiness Verification Pending"`) --
no label-map changes needed.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. Documents and outputs copies re-synced
and confirmed byte-identical via `diff` on the one touched file (`pending_approvals.py`). Backend-only change;
`PendingApprovals.tsx` already renders whatever categories/status labels the endpoint returns with no
hardcoded list, so no frontend edit was needed.

## 58-59. CHIEF_MANAGER_QA/AGM_QA get an Executive bypass on QA Lead actions -- kept OUT of the "QA Lead group" display

**Reported (3 messages, same thread):**
1. Screenshot of a SAST request, "AGM QA 1 not able to assign security analyst, where Chief Manager QA able to
   do the same."
2. Screenshot of the resulting "QA Lead group members" modal listing AGM QA 1 + Chief Manager QA: "only the
   show whose role assigned as QA Lead."
3. "AGM QA / Chief Manager QA does not need to assign QA lead separately as they [a]re the executive[s], ...
   they have super power."

**Iteration history (all three within this session, final design below is what shipped):** first pass widened
BOTH the "QA Lead group" *display* (`RoleGroupLink`/`assignedGroupFor`, via a new `QA_LEAD_GROUP_ROLES`
constant) and the *action* authorization to include CHIEF_MANAGER_QA/AGM_QA -- but action authorization had
actually never been widened to match the (separately, earlier-session) redefined display group, which is what
report #1 exposed (a CM-QA test account happened to also hold a literal QA_LEAD role; the AGM-QA account
didn't). Report #2 then said the *display* should go back to literal QA_LEAD only. Taken alone, `AskUserQuestion`
confirmed a full revert (both display AND actions back to QA_LEAD-only) -- but report #3 arrived immediately
after, clarifying the real intent: CHIEF_MANAGER_QA/AGM_QA should keep the ability to act (an "Executive"
super-user bypass, the same way Administrator already bypasses every `has_role()` check), just without being
listed as members of the "QA Lead group" itself. Confirmed via a second `AskUserQuestion` before finalizing.

**Final design:**
- **Action authorization** (backend `require_roles(...)`/`_require_assigned_qa_lead`-style helpers, frontend
  `isQALead`/`isAssignedQALead`/`canQALeadDecide`/`canReview`/`canEditProjectDetails`) -- CHIEF_MANAGER_QA and
  AGM_QA are accepted alongside QA_LEAD, everywhere a QA-Lead-gated workflow action is checked:
  `functional.py`'s `_require_assigned_qa_lead` + 6 `require_roles` decorators (start-readiness-verification,
  readiness-decision, begin-planning, assign-tester, confirm-signoff, checklist item update); `sast_dast.py`'s
  `_require_assigned_qa_lead` (shared SAST+DAST) + 10 decorators (start-readiness, readiness-decision,
  start-configuration, assign-security-analyst, checklist item update, x2 each); `performance.py`'s
  `_require_assigned_qa_lead` + `_require_performance_execution_owner` + 8 plain decorators + 5
  `Role.QA_LEAD, Role.QA_ENGINEER` decorators; `signoff.py`'s `update_signoff` edit-window check, the
  `qa-lead-decision` endpoint decorator, and `_can_upload_documents`'s `SM_APPROVAL_PENDING` branch;
  `test_projects.py`'s `activation-review`/`archive`/`unarchive` decorators and `is_qa_lead_or_admin`;
  `deps.py::can_manage_project`; and `pending_approvals.py`'s `_readiness_items`, `_signoff_items`'s QA Lead
  checkpoint, and `_test_project_items` (each kept mirroring its real endpoint's authorization exactly, per
  this file's own stated design principle for that module).
- **Display** (who shows up as a "QA Lead group member") -- kept to literal `QA_LEAD` only: `RoleGroupLink`
  "QA Lead group members" modal, `assignedGroupFor`'s `"QA Lead"` case in `Functional.tsx`/`SAST.tsx`/
  `DAST.tsx`/`Performance.tsx` (now `{ role: "QA_LEAD", ... }`, not `QA_LEAD_GROUP_ROLES`), and the
  Department-Head-decision `extraControl` preview in all four modules. `QA_LEAD_GROUP_ROLES` in `constants.ts`
  is now purely an action-authorization set (still used by `SignOff.tsx`/`TestProjects.tsx`'s action gates),
  re-documented accordingly; it is deliberately NOT used for anything display-facing anymore.

**Deliberately NOT widened -- Test Management's own, separately-audited internal permission scheme** (see
section 54's own debugging pass and `TEST_MANAGEMENT_PERMISSIONS.md`, which already documents CM-QA/AGM-QA as
identical in some Test Management contexts and deliberately different in others, predating this session):
`deps.py::can_review_repository` (Stage-1 repository review, strict membership + system QA_LEAD only by
design, no non-member fallback -- `can_give_final_approval` right below it already has its own correct,
separate CM-QA/AGM-QA handling for Stage 2), `test_projects.py::_is_project_owner_or_lead` (PRJ-005/GOV-001
membership management, and its frontend mirror `TestProjects.tsx`'s `canManageMembers`), `test_execution.py`'s
CYC-007 `_require_scope_change_permission` and the defect-unlink QA_LEAD-or-linker check, and the residual
Medium/Low-defect cycle-completion "manager" override (already reviewed in section 54 and deliberately kept
CHIEF_MANAGER_QA-only, distinct from AGM_QA). None of these are the "assign/readiness/planning" style request
workflow actions the report was about, and re-opening them risks contradicting decisions already made
deliberately and documented.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean at every
intermediate step and at the final design. Documents and outputs copies re-synced and confirmed byte-identical
via `diff` on all touched files (`deps.py`, `functional.py`, `sast_dast.py`, `performance.py`, `signoff.py`,
`pending_approvals.py`, `test_projects.py`, `constants.ts`, `Functional.tsx`, `SAST.tsx`, `DAST.tsx`,
`Performance.tsx`, `SignOff.tsx`, `TestProjects.tsx`).

## 60. "Simplified Test Management Review and Approval" requirement -- Test Management's entire project-membership model replaced with QA Group / QA Lead Group system roles

**Reported:** a full, formal SRS-style specification document ("Simplified Test Management Review and
Approval Requirement," 15 sections plus 20 acceptance criteria) pasted in full, covering: a Simplified Role
Model (QA Group does Stage 1 recommendation, QA Lead Group does Stage 2 final approval, no individual
reviewer/QA-Lead selection anywhere, no project member-management UI), Project Requirements, Test Case
Creation/Upload, the two-stage Approval Workflow, a new status vocabulary, Concurrency/Bulk Upload/Approved-
Modification/Notification/Audit requirements. This replaces the entire pre-existing `TestProjectMember`
project-role model (Owner/Project Lead/Author/Tester/Reviewer/Viewer, opt-in per project -- sections 10, 12,
13, 14, 15, 17 of this log) with a flat, system-role-based two-group model.

**Scope decisions (`AskUserQuestion`, 3 questions before implementation):**
1. **Scope: whole module (not just test-case approval).** Project-membership gating is removed everywhere in
   Test Management -- test execution, Test Project activation approval, Defect Management's manager override
   -- not only test-case Stage 1/Stage 2.
2. **Role mapping: reuse existing system roles.** QA Group = `QA_ENGINEER`. QA Lead Group =
   `QA_LEAD`/`CHIEF_MANAGER_QA`/`AGM_QA` (the same set section 59 above just finished establishing as the
   Executive-bypass action-authorization group) -- no new roles introduced.
3. **Migration: new cases only, not migrate-in-place.** A `TestCaseVersion` already sitting at `"In Review"`/
   `"Review Completed"`/`"Returned"` (the OLD, pre-existing "Test Approval Workflow" refactor's vocabulary,
   section 17) keeps running that exact logic, completely unchanged, to completion. Only a case still in
   `Draft`, or resubmitting from a NEW-vocabulary Returned status, follows the new workflow. Both paths run
   through the *same* endpoints, branched by the draft's current status at the moment of the action -- not
   separate endpoints, and not a data migration.

**Design principle used throughout:** distinguish STATEFUL items (a `TestCaseVersion`, whose `status` column
itself encodes which workflow generation it belongs to -- old vs. new statuses are the discriminator) from
STATELESS current-moment permission checks (test execution, Defect Management's manager override, Test
Project lifecycle, repository-governance actions not tied to review status). Only the stateful review chain
needed a dual-path design; everything stateless moved to the new group model immediately, no
migration/dual-path complexity.

**New status vocabulary** (`backend/app/constants.py::TEST_CASE_NEW_STATUSES`, mirrored in
`frontend/src/constants.ts::TEST_CASE_NEW_STATUSES`): `"Recommendation Pending"` (NEW Stage 1, QA Group),
`"QA Lead Approval Pending"` (NEW Stage 2, QA Lead Group), `"Returned by QA"`, `"Returned by QA Lead"` (NEW
Returned variants, so a resubmission can tell which generation it's rejoining). `_OLD_WORKFLOW_STATUSES =
{"In Review", "Review Completed", "Returned"}` in `test_repository.py` is the discriminator switch.

**Backend -- `test_repository.py` (Test Case Stage 1/Stage 2 rewrite):**
- New `_qa_group_ids`/`_qa_lead_group_ids` helpers (active users holding the respective group's roles,
  excluding the draft's author) replace individual-assignee routing for the NEW path.
- `_submit_draft`/`submit_test_case`/`bulk_submit_test_cases` -- branch `is_old_path = previous_state ==
  "Returned"` (the OLD literal string only); a fresh Draft always enters the NEW path.
- `review_test_case` -- one endpoint, now four branches by `draft.status`: NEW Stage 1
  (`"Recommendation Pending"`, `QA_ENGINEER` gate), NEW Stage 2 (`"QA Lead Approval Pending"`, QA Lead Group
  gate), OLD Stage 1 (`"In Review"`, unchanged), OLD Stage 2 (`"Review Completed"`, unchanged). GOV-002
  self-authorship block applies identically to all four.
- `bulk_recommend_test_cases`/`bulk_approve_test_cases` -- same dual-path pattern: validate against both the
  OLD and NEW target status for that stage, compute the set of statuses actually present in the selection,
  reject (400) a selection mixing an OLD-path and a NEW-path row ("select one group at a time"), then branch
  authorization/notify-recipients/target-status by whichever single generation is present.
- `reassign_test_case_approvers` (`PATCH .../approvers`) -- now unconditionally returns 409, "Individual
  reviewer assignment is disabled; test cases use automatic role-based group routing." (Already effectively
  dead code before this change -- confirmed via grep that `TestCaseSubmit`/`TestCaseBulkSubmit` schemas never
  had reviewer/QA-Lead picker fields to begin with, so this mostly formalizes an existing state.)
- `delete_folder`/`checkout_override`/`archive_test_case`/`restore_test_case` -- these are repository-
  governance actions with no old/new-status concept of their own (they don't act on a case's review-in-
  progress status). Switched from `require_can_review_repository` (project-membership-aware) to a new
  `require_can_manage_repository_governance` (QA Lead Group, plain role check) -- **not** the same function
  `bulk_recommend_test_cases`'s OLD-path branch still calls, which is deliberately left alone.

**Backend -- `deps.py`:**
- `can_author_repository` -- now always `True` (a no-op). Every caller already sits behind
  `require_roles(*_AUTHOR_ROLES)` at the router level, so the project-membership check on top of it was pure
  narrowing that no longer applies.
- New `can_manage_repository_governance`/`require_can_manage_repository_governance` -- QA Lead Group, plain
  role check. Explicitly documented as separate from `can_review_repository`/`require_can_review_repository`
  right above it, which are left **completely unmodified** -- they remain the OLD-path-only helper
  `bulk_recommend_test_cases` still calls for its `"In Review"` branch.
- `can_give_final_approval`/`require_can_give_final_approval` -- left completely unmodified (OLD-path-only,
  same reasoning).
- `can_execute_project` -- now `current_user.has_role(QA_ENGINEER, QA_LEAD, CHIEF_MANAGER_QA, AGM_QA)`, no
  membership.
- `can_manage_execution_governance` -- now QA Lead Group, no membership.
- `can_manage_project` -- unchanged from section 59 (already Executive-bypass-aware; checks `owner_id`
  directly, never read `TestProjectMember`, so nothing to change here).

**Backend -- `test_execution.py`:** `_require_scope_change_permission` (CYC-007) and the inline residual-
Medium/Low-defect cycle-completion "manager" check both dropped their "or a Project Lead/Owner member of this
project" carve-out -- QA Lead Group system role is the sole authority now. Removed the now-unused
`get_project_member_role` import.

**Backend -- `defects.py`:** `_is_manager` dropped its project-membership carve-out -- now
`user.has_role(QA_LEAD, CHIEF_MANAGER_QA, AGM_QA)` only (previously `QA_LEAD`/`CHIEF_MANAGER_QA` only via
membership fallback, which also silently excluded `AGM_QA` from ever qualifying as a project's own Project
Lead/Owner -- that gap is closed as a side effect). `_require_execution_link_access` dropped its "Tester/
Project Lead/Owner member of this project acts regardless of department" escape hatch -- QA staff already get
equivalent unrestricted access through `dashboard_department_scope`'s own QA/Security/Executive-COE carve-out,
so the separate membership-based one was redundant once membership itself is no longer assigned.

**Backend -- `test_projects.py`:**
- `_ensure_default_member_role` deleted -- `create_test_project`/`update_test_project` no longer auto-create
  a Reviewer/Project Lead `TestProjectMember` row from `default_reviewer_id`/`default_qa_lead_id`. Those two
  columns are kept purely as legacy metadata (still read by the OLD-path Stage 2 notify list for projects with
  in-flight pre-existing drafts).
- `add_project_member`/`update_project_member`/`remove_project_member` -- now unconditionally 409, same
  pattern as `reassign_test_case_approvers`. `list_project_members` stays a working, read-only historical
  view. `_is_project_owner_or_lead` (now unused) deleted.

**Frontend:**
- `constants.ts` -- `TEST_CASE_STATUSES` extended with `TEST_CASE_NEW_STATUSES`;
  `TEST_CASE_STATUS_LABELS`/`TEST_CASE_PENDING_WITH`/`TEST_CASE_PENDING_DECISION_STATUSES` all extended to
  cover the 4 new statuses, mirroring `constants.py` exactly.
- `TestProjects.tsx` -- `ProjectMembersModal` and its "Members" button/state removed entirely (TM-PROJ-002).
  `NewProjectModal`/`EditProjectModal` never had default-Reviewer/default-QA-Lead pickers to begin with
  (TM-PROJ-004 was already satisfied there); the project-card stat display of `default_reviewer_name`/
  `default_qa_lead_name` is left as read-only legacy info, not a selection control.
- `TestRepository.tsx` -- the single-case review panel, decision-outcome/lock-context copy, archive/restore/
  checkout-override gating, folder-delete gating, and the bulk recommend/approve eligibility filters and
  status quick-filter buttons (`Review queue`/`Final approval queue`, which count OLD+NEW together via
  `TestCaseSummaryOut`) were all extended to recognize and correctly gate the 4 new statuses alongside the old
  ones, using two new plain-role consts (`canQAGroupNewPath` = `QA_ENGINEER`, `canManageRepoGovernance` = QA
  Lead Group) that intentionally do **not** reuse the OLD-path, `myAccess`-derived `canReview`/
  `canGiveFinalApproval` props for anything status-independent (archive/restore/checkout-override/delete-
  folder), since those two props stay OLD-path-only on the backend.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed byte-identical via `diff` on all touched files.
`TEST_MANAGEMENT_PERMISSIONS.md` rewritten from scratch to describe the new model (superseding the
project-membership document it replaced), including the dual-path OLD-path exception.

## 61. ORA-12899 -- the new test-case status values overflowed the `STATUS` column's VARCHAR2(20)

**Reported:** a live stack trace, submitting a test case under the new (section 60) workflow --
`sqlalchemy.exc.DatabaseError: (oracledb.exceptions.DatabaseError) ORA-12899: value too large for column
"QA_PORTAL"."QAP_TEST_CASES"."STATUS" (actual: 22, maximum: 20)` -- while writing `status='Recommendation
Pending'` (22 characters) on `UPDATE qap_test_cases`.

**Cause:** `TestCase.status`/`TestCaseVersion.status` (`models.py`) were both `Column(String(20), ...)`,
sized for the pre-existing "Test Approval Workflow" vocabulary where `"Review Completed"` (17 chars) was the
longest value -- the comment on `TestCase.status` said as much at the time. Section 60 above added four new
values (`TEST_CASE_NEW_STATUSES`) without checking them against that limit: `"Recommendation Pending"` (22),
`"Returned by QA"` (15), `"Returned by QA Lead"` (19), and `"QA Lead Approval Pending"` (24 -- the new
longest). `constants.py`'s own string lists have no length enforcement, so nothing caught this until Oracle
did, at write time.

**Fix:**
- `models.py` -- both `TestCase.status` and `TestCaseVersion.status` widened `String(20)` -> `String(30)`
  (room to spare past the current longest value, 24 chars, for any future addition).
- New `backend/scripts/2026-08_widen_test_case_status_columns.sql` -- `ALTER TABLE ... MODIFY (status
  VARCHAR2(30))` for both `qap_test_cases` and `qap_test_case_versions`. Needed because `create_all()` never
  alters an existing column's size on a table that already exists (additive-only convention, same reasoning
  as every other manual-`ALTER TABLE` script in `backend/scripts/`) -- widening the Python model alone does
  nothing for an already-deployed schema. **Must be run against the production/any pre-existing Oracle schema
  before (or as part of) deploying this fix** -- a fresh/new schema gets `VARCHAR2(30)` automatically from
  `create_all()`. Widening a `VARCHAR2` column is a fast, in-place, metadata-only operation in Oracle (no
  table rewrite) since the new size is larger than the old one; the script is safe to re-run.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. Documents and outputs copies re-synced
and confirmed byte-identical via `diff` on `models.py` and the new script.

## 62. "Pending with Author" showing no name, clickable pending group, and a real GOV-002 gap (submitter could immediately record their own Stage 1 decision)

**Reported, four related points in one message:** (1) "Pending with author, give details who have uploaded" --
the Workflow column just said "Author" with no actual name; (2) "also show the group name where pending
approval, on click of group name, members will be visible" -- for the new (section 60) group-pending statuses;
(3) "tester 1 is author, now tester 2 logged in, able to submit for review, is it right behaviour?"; (4) "if
right then i saw i am able to submit for review and also recommend for qa lead approval which is not correct
i think."

**Point 3 -- investigated, confirmed as intended, not a bug:** `checkout_test_case`/`submit_test_case` were
checked directly. Neither restricts the action to the draft's own author -- any Author-tier user
(QA_ENGINEER/QA_LEAD/CM-QA/AGM-QA) can check out and submit *any* other person's draft. This is deliberate,
team-based authoring (matches how the QA Group/QA Lead Group model in section 60 is scoped to teams, not
individuals) -- Tester 2 submitting Tester 1's draft is correct, existing behavior. No code change for this
point.

**Point 4 -- confirmed as a real GOV-002 gap.** Every self-authorship check in `test_repository.py`
(`review_test_case`, `bulk_recommend_test_cases`, `bulk_approve_test_cases`) only ever compared against
`draft.author_id` -- the person who originally wrote the content. It never checked who had performed the
*submit* action, or (for the Stage 2 decision) who had performed the *Stage 1 recommend* action. Since point 3
confirms submitting someone else's draft is allowed by design, Tester 2 could submit Tester 1's draft and then
immediately record the Stage 1 (or, after that, Stage 2) decision on the very item they'd just acted on --
maker and checker being the same person, which is exactly what GOV-002 exists to prevent. Scoped strictly to
the section-60 NEW workflow path only; the pre-existing "Test Approval Workflow" (OLD path,
`_OLD_WORKFLOW_STATUSES`) already had its own correct author-only GOV-002 check and was left untouched.

**Fix -- `backend/app/routers/test_repository.py`:**
- `review_test_case` -- two new checks added after the existing author check: if `draft.status ==
  "Recommendation Pending"`, blocks `draft.submitted_by_id == current_user.id` from recording the Stage 1
  decision; if `draft.status == "QA Lead Approval Pending"`, blocks whoever was either the submitter
  (`submitted_by_id`) or the Stage 1 reviewer (`reviewed_by_id`) from recording the Stage 2 decision.
- `bulk_approve_test_cases` / `bulk_recommend_test_cases` -- same rule applied per-row, gated behind `if not
  is_old_path:`, rejecting the whole batch (all-or-nothing, matching this codebase's existing bulk-endpoint
  convention) with the offending test case keys named in the error if any selected row was acted on earlier by
  the same caller.

**Fix -- `backend/app/models.py`, `TestCase`:** three new properties mirroring the existing
`current_draft_author_id` pattern -- `current_draft_submitted_by_id`, `current_draft_reviewed_by_id`,
`current_draft_author_name` -- so the frontend can know who acted at each stage without a round trip, and
proactively hide/disable actions rather than only ever discovering the block from a 403. Exposed through
`schemas.py`'s `TestCaseOut`/`TestCaseListOut` and `frontend/src/types.ts`'s matching interfaces.

**Fix -- points 1 & 2, "Pending with Author" / clickable group -- `models.py`,
`TestCaseVersion.pending_with_user_name`:** extended to return `"QA Group"` for `"Recommendation Pending"` and
`"QA Lead Group"` for `"QA Lead Approval Pending"` (previously fell through to `None` for both -- these are the
two new group-pending statuses from section 60 and had never been wired into this property at all). The
Returned family (`"Returned"`, `"Returned by QA"`, `"Returned by QA Lead"`) already resolved to
`self.author_name`; a never-submitted `Draft` still isn't covered by this per-version property (it has no
draft *action* pending yet), so the frontend falls back to the new `current_draft_author_name` for that one
case, giving a real name instead of the bare word "Author".

**Fix -- `frontend/src/modules/test-management/TestRepository.tsx`:**
- Workflow column now renders, for the two group-pending statuses, the existing `RoleGroupLink` component
  (already used the same way for Functional/SAST/DAST/Performance's "Assigned Group") via a new
  `TEST_CASE_PENDING_GROUP_ROLES` map (`'Recommendation Pending' -> QA_ENGINEER`, `'QA Lead Approval Pending'
  -> QA_LEAD_GROUP_ROLES`) -- clicking the group name opens the members modal, purely client-side against the
  page's already-fetched `users` list. Left the two OLD-path statuses ("In Review"/"Review Completed") as
  plain text, since eligibility there is role-*or*-project-membership based and a pure role list would
  misrepresent who's actually eligible.
- New `isBlockedFromNewStage1`/`isBlockedFromNewStage2` flags (author, or submitter, or -- for stage 2 --
  Stage-1 reviewer) replace the old `isCurrentDraftAuthor`-only disabled check on both the single-case action
  buttons and the bulk "Recommend"/"Approve" selection filters, with the lock-reason message now naming
  whichever specific stage the current user already acted on.
- Also fixed in passing: the single-case "Submit for review" button's status check was missing the two NEW-path
  Returned statuses (`'Returned by QA'`, `'Returned by QA Lead'`) -- an author whose new-path draft was
  returned could resubmit via bulk submit (already correct) but not via the single-case modal. Widened to an
  array `.includes()` covering all four resubmittable statuses.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed byte-identical via `diff` on every touched file
(`models.py`, `schemas.py`, `test_repository.py`, `types.ts`, `TestRepository.tsx`, `index.css`).

## 63. Login "pending approvals" notice, and reminder/escalation notifications, never fired for the NEW test-case workflow

**Reported:** "earlier notification was there in pending approval, if any testcase review pending it shows a
notification on login, where the functionality gone?"

**Investigation:** the notification system itself was never removed. Two layers exist: the bell/toast feed
(`models.Notification` + `routers/notifications.py`'s `fire()` calls + `NotificationBell.tsx`) already fires
correctly on submit/recommend/return/reject/approve under the NEW workflow -- not broken. The actual "on
login" feature the user meant is `frontend/src/components/PendingApprovalsNotice.tsx`, mounted once per
sign-in from `App.tsx`, which calls `GET /api/pending-approvals` and pops an "N approvals awaiting your
action" modal if the count is non-zero. That component was also intact and correctly wired.

**Root cause:** `backend/app/routers/pending_approvals.py`'s `_test_case_items()` -- the aggregator
`GET /api/pending-approvals` actually calls -- only ever queried the two OLD "Test Approval Workflow" status
strings, `"In Review"` and `"Review Completed"`. When section 60's "Simplified Test Management" rewrite
introduced the NEW workflow's `"Recommendation Pending"` / `"QA Lead Approval Pending"` statuses (which every
fresh submission routes to exclusively -- project membership no longer exists as a routing signal), this
checkpoint list was never updated to include them. Since virtually all live test-case submissions go through
the NEW path now, `_test_case_items()` returns an empty list for essentially every QA Group / QA Lead Group
user, so `/api/pending-approvals` reports 0 items and `PendingApprovalsNotice.tsx` silently no-ops on login --
not because the feature was removed, but because its backend query stopped matching any real data the moment
section 60 shipped. `routers/notifications.py`'s `sweep_overdue_approvals()` (the separate reminder/escalation
sweep behind "notify after N business days waiting") had the identical gap -- its own status filter was the
same two OLD-path strings only.

**Fix -- `pending_approvals.py`:** added two new checkpoints to `_test_case_items()`'s `checkpoints` tuple --
`"Recommendation Pending"` (new `_qa_group_checker`, `Role.QA_ENGINEER`) and `"QA Lead Approval Pending"` (new
`_qa_lead_group_checker`, `can_manage_repository_governance` -- QA_LEAD/CHIEF_MANAGER_QA/AGM_QA), mirroring
exactly what `review_test_case`/`bulk_recommend_test_cases`/`bulk_approve_test_cases` already check for these
two statuses. Also added the NEW-path GOV-002 self-action exclusions from section 62 (excludes the submitter
from seeing their own Stage 1 item; excludes the submitter and Stage 1 reviewer from seeing their own Stage 2
item) so the login notice never invites a user to a decision they're not actually allowed to make. The OLD
path's two checkpoints and their existing filtering (including the pre-existing `"In Review"` +
`not has_role(QA_LEAD)` extra gate) were left completely untouched.

**Fix -- `notifications.py`'s `sweep_overdue_approvals()`:** extended the status filter to all four statuses;
`stage_started`/recipient-selection logic now branches four ways instead of two (`stage1_statuses = ("In
Review", "Recommendation Pending")` determines whether elapsed time is measured from `submitted_at` or
`reviewed_at`), with NEW-path recipients drawn from the QA Group / QA Lead Group role sets and the same
GOV-002 exclusions as above, instead of the OLD path's literal `Role.QA_LEAD` / `{CHIEF_MANAGER_QA, AGM_QA}`
checks.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. No frontend changes needed --
`PendingApprovalsNotice.tsx`/`NotificationBell.tsx` were already correct and just needed real data from the
backend. Documents and outputs copies re-synced and confirmed byte-identical via `diff` on
`pending_approvals.py` and `notifications.py`.

## 64. Bulk "Recommend"/"Approve" buttons hidden for QA Group/QA Lead Group users outside the testcase detail modal

**Reported, direct follow-up to section 63:** "QA 2 submitted TC-01 for shared QA review, now QA 1 logged in,
and on click of that testcase inside getting 'Recommend for approval' [the Stage 1 decision panel's
Recommend Approval/Return for Correction/Reject buttons], but outside also should be visible for those
testcases whom QA 1 are eligible for recommend" -- i.e. opening TC-01's detail modal correctly showed QA 1 as
eligible to act, but the list view's own bulk-action toolbar (select the row's checkbox, act without opening
the modal) showed nothing for the same eligible testcase.

**Root cause -- `frontend/src/modules/test-management/TestRepository.tsx`:** `recommendSelectedIds`/
`finalApproveSelectedIds` (the arrays actually deciding which selected rows are eligible) were already correct
-- both include the NEW-path branch (`status === 'Recommendation Pending' && canQAGroupNewPath && ...` /
`status === 'QA Lead Approval Pending' && canManageRepoGovernance && ...`). But the two buttons that render
from those arrays, `Bulk recommend pending (N)` / `Bulk approve pending (N)`, were still gated on the
OLD-path-only `canReview` / `canGiveFinalApproval` flags alone -- never updated to also admit
`canQAGroupNewPath` / `canManageRepoGovernance`, unlike the "Review queue"/"Final approval queue" filter
buttons a few lines above them in the same toolbar, which already did exactly that OR. A QA Group member with
no OLD-path project access (the normal case now that project membership no longer routes anything, per
section 60) could correctly select an eligible NEW-path testcase's checkbox, but the button to act on the
selection simply never rendered.

**Fix:** `(canReview || canQAGroupNewPath) && recommendSelectedIds.length > 0` and `(canGiveFinalApproval ||
canManageRepoGovernance) && finalApproveSelectedIds.length > 0` -- matching the pattern already used by the
queue-filter buttons.

**Verified:** `npx tsc --noEmit -p .` clean. Documents and outputs copies re-synced and confirmed
byte-identical via `diff` on `TestRepository.tsx`.

## 65. Bulk Return/Reject, "Submitted by" in the Workflow column, Bulk update hidden while pending approval, and per-row checkbox eligibility for bulk recommendation

**Reported, several related points plus a formal "Bulk Test Case Recommendation - Checkbox Validation
Requirements" spec pasted in full:**
1. Follow-up to section 64's screenshot ("Pending QA Recommendation" / "Pending with QA Group 2"): "same Return
   for Correction and Reject as well" -- the single-case Stage 1/2 decision panel already offered Recommend
   Approval/Return for Correction/Reject, but only Recommend/Approve had bulk equivalents.
2. "if testcase under pending approval then bulk update button should not be visible."
3. "along with Pending with details, show submitted by as well."
4. A detailed spec requiring per-row checkbox eligibility (disabled + tooltip for anyone not currently
   entitled to act, GOV-002-aware), an eligibility-aware Select All with an indeterminate state, and the
   selected count/bulk-button state/API payload staying in sync with actual eligibility rather than raw
   checkbox clicks.

**Fix 1 -- bulk Return/Reject, NEW-path only (`test_repository.py`):** new `POST .../test-cases/bulk-return`
and `POST .../test-cases/bulk-reject` (schemas `TestCaseBulkReturn`/`TestCaseBulkReject`, mandatory
`comments`), sharing a new `_bulk_new_path_decision_rows()` helper factored out of the same validation
`bulk_recommend_test_cases`/`bulk_approve_test_cases` already run (homogeneous-stage selection, matching group
role, GOV-002 author/submitter/reviewer exclusions). Acts on whichever NEW-path stage the selection is at --
"Recommendation Pending" -> "Returned by QA" or terminal "Rejected"; "QA Lead Approval Pending" -> "Returned by
QA Lead" or terminal "Rejected". OLD-path rows stay single-case-only, unchanged, same "new cases only"
convention as every other NEW-path-only addition this migration. Frontend: one shared `BulkDecisionModal`
(action="return"|"reject") replacing what would otherwise be two near-duplicate modals, two new toolbar
buttons gated on `(canQAGroupNewPath || canManageRepoGovernance) && returnRejectSelectedIds.length > 0`.

**Fix 2 -- Bulk update button hidden while any selected testcase is pending approval:** root cause was the
exact same class of bug fixed repeatedly this migration -- `selectedCasesIncludeWorkflowLock` (the flag that
disables field-editing while a workflow decision is in flight) only ever checked the two OLD-path statuses
("In Review"/"Review Completed"), never the NEW-path pair. Fixed to reuse the existing, already-complete
`TEST_CASE_PENDING_DECISION_STATUSES` constant (all four statuses) instead of a separately hand-maintained
two-status list -- the same constant the modal's own internal per-row lock and the single-case panel already
relied on. Also removed `canBulkUpdateAssignments`'s blanket carve-out that let a self-authored pending-review
testcase's "assignment" fields stay editable regardless of workflow lock.

**Fix 3 -- "Submitted by" alongside "Pending with":** new `TestCase.current_draft_submitted_by_name` model
property (mirrors the existing `current_draft_author_name`, bridging through `TestCaseVersion.submitted_by_name`),
exposed on `TestCaseOut`/`TestCaseListOut`/`types.ts`. Workflow column now shows a second line, "Submitted by
{name}", whenever the current draft has actually been submitted (absent for a never-submitted Draft).

**Fix 4 -- per-row checkbox eligibility (the pasted spec):** new `checkboxEligibility(testCase)` in
`TestRepository.tsx`, evaluated per row rather than only against the current selection -- for the four review
checkpoints (In Review/Review Completed OLD-path, Recommendation Pending/QA Lead Approval Pending NEW-path) it
mirrors the exact predicates already used by `recommendSelectedIds`/`finalApproveSelectedIds`/
`returnRejectSelectedIds`, returning `{ eligible, reason }`; every other status (Draft/Returned/Approved/
Archived/Rejected) stays unrestricted, since Submit/Delete/Bulk update aren't per-row GOV-002-gated the way
the four review checkpoints are and disabling those would have been a regression, not a fix. The row checkbox
is now `disabled` with a `title` tooltip explaining the specific reason (author, wrong group, or already acted
at an earlier stage) whenever ineligible -- since a disabled checkbox can never be toggled, `selectedCaseIds`
can now only ever contain ids the eligibility check already approved, so the selected count, bulk-button
enablement, and the eventual API payload stay consistent by construction rather than needing a separate
recalculation step. Select All (`toggleAllVisible`) now operates only over `eligibleOnPageIds`, is disabled
outright when the current page has zero eligible rows, and renders an indeterminate (dash) state via a ref
when some but not all eligible rows are selected. A new `useEffect` keyed on `cases` prunes any previously
selected id that's still on the current page but has since become ineligible (e.g. another user just acted on
it) -- ids selected on a different page are left alone, matching this list's existing across-page selection
behavior. Backend validation (the all-or-nothing atomic rejection with named offending keys, already in place
per section 62) is unchanged and remains the authoritative check -- this frontend work prevents the
now-far-less-likely race from reaching the user as a raw 403 in the first place, rather than replacing that
check with the spec's proposed partial-success/skipped-ids response shape, which would have been a much larger
change to this app's established "bulk operations are atomic" convention across every other bulk endpoint.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed byte-identical via `diff` on every touched file
(`schemas.py`, `test_repository.py`, `models.py`, `types.ts`, `TestRepository.tsx`).

## 66. "Final-Approved Test Case Deletion and Archive Requirement" -- hardening around what was already mostly correct

**Reported:** a formal requirements document for governed test cases (once "Approved," must never be hard-
deletable; Archive/Restore instead; mandatory archive reason; bulk behavior; 409 on every delete path; full
audit trail). An investigation pass first confirmed most of the core rule was already correctly built (sections
7/60-62): `delete_test_case`/`bulk_delete_test_cases` already blocked any ever-approved/archived/rejected case,
`restore_test_case` already returned straight to Approved with no re-approval, and cycle assignment already
excluded Archived cases. The gaps below are what the audit actually found.

**409 instead of 400, clearer messages:** both `delete_test_case` and `bulk_delete_test_cases` now raise `409
Conflict` (was `400`) -- correct semantics, since the request is well-formed but conflicts with the test case's
own governed state. `detail` stays a plain string, not the spec's proposed nested `{"message":...,
"test_case_id":...}` -- this app's own Section 8 API standard (`main.py::http_exception_handler`) keeps
`detail` a string every existing router and the frontend's error parsing already depend on; the envelope
(`request_id`/`status_code`) is added uniformly by that same handler already.

**Mandatory archive reason:** `schemas.TestCaseArchive.reason` changed `Optional[str] = None` -> `str`,
`archive_test_case` now rejects a blank/whitespace-only reason explicitly. Frontend: the single-case Archive
modal's field relabeled "Archive reason *" (was "Reason (optional)"), now `required`, with the confirmation
copy matching the spec's own wording.

**Bulk-archive, new:** `POST .../test-cases/bulk-archive` (schema `TestCaseBulkArchive`) -- archives several
Approved test cases in one action, same mandatory-reason rule, silently skips an already-Archived row in the
same selection rather than failing the batch. New `BulkArchiveModal` + "Archive selected (N)" toolbar button.

**Bulk delete now differentiates eligibility instead of all-or-nothing:** new `deletableSelectedIds` (never
governed) / `governedSelectedIds` (ever approved/archived/rejected) on the frontend, built the same way as
every other bulk-eligibility array this migration (`recommendSelectedIds` etc.) -- "Bulk delete" only ever
targets `deletableSelectedIds` and shows its count in the button label; a governed case in the same selection
is called out separately ("N eligible for deletion" style breakdown per the spec's own UX example) with
"Archive selected" offered alongside it instead of rejecting the whole batch. The backend's existing atomic
all-or-nothing check remains in place as the authoritative race-condition guard (same reasoning as section 65's
identical decision for bulk-recommend), now just far less likely to ever actually be hit from the UI.

**Archive/Restore audit rows now record previous_state/new_state:** `_case_workflow_action` already supported
these fields (used everywhere else in this file) but the Archive/Restore call sites never passed them --
`archive_test_case`/`bulk_archive_test_cases` now pass `previous_state="Approved", new_state="Archived"`,
`restore_test_case` passes the reverse.

**Archived test cases were still editable:** `update_test_case` had no guard on `current_approved_version.
status == "Archived"` -- without an in-progress draft, editing silently spun a brand-new Draft off the archived
content, bringing it back into active editing without ever going through Restore. Now explicitly blocked
("This test case is archived -- restore it before editing").

**Archived test cases are now excluded from the default list:** `list_test_cases` now filters out `status ==
"Archived"` whenever the caller hasn't specified a status filter at all -- an explicit filter (including
picking "Archived" from the existing status dropdown, which already satisfied "available under an archive
filter") is untouched. Deliberately done as a backend default rather than hard-coding the status enumeration
into the frontend's exclusion list, since `frontend/src/constants.ts`'s `TEST_CASE_STATUSES` would need to be
kept in perfect sync with every current and future status value to do that safely -- see the note below about
what was actually found on that front.

**Single-case Delete button visibility fixed to match the backend rule exactly:** was gated only on
`current_approved_version_id` being unset, which missed a Rejected-and-never-approved case (backend already
blocked deleting it, UI didn't know). Now also excludes `status === 'Rejected'`.

**Deliberately not built, with reasoning:**
- **"Source screen or API" on every audit row** -- `ApprovalAction` has no such column, and adding one is an
  ALTER TABLE on an existing Oracle table (this app's `create_all()`-only, no-Alembic constraint means that's a
  manual SQL script the user runs themselves, per the established `backend/scripts/` convention) for a field
  with no other consumer anywhere in the app. Not built this round; flagging it here so it isn't silently
  forgotten if it's actually needed.
- **A literal per-row action-menu dropdown (View/Clone/Archive, no Delete)** -- this app's existing pattern is
  clicking a row to open the full detail modal, where View/Clone/Archive/Delete already live as buttons (now
  correctly gated per the rules above) rather than a separate menu duplicating them. Building a second,
  parallel row-level menu was judged to be UI duplication rather than a functional gap, given Delete is already
  correctly hidden wherever it must be.
- **Found in passing, not fixed:** `frontend/src/constants.ts`'s `TEST_CASE_STATUSES` (the status filter
  dropdown's option list) only has the 7 OLD-workflow status values -- it's missing all four NEW-path statuses
  (`Recommendation Pending`, `QA Lead Approval Pending`, `Returned by QA`, `Returned by QA Lead`) introduced in
  section 60, so none of them can currently be picked from that dropdown as an explicit filter. Out of scope for
  this section (unrelated to the archive/delete requirement), flagged here for a future pass.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed byte-identical via `diff` on every touched file
(`schemas.py`, `test_repository.py`, `TestRepository.tsx`).

## 67. "Create Recycle bin and Archive folder" -- soft-delete with restore, QA-Lead-only permanent purge, and an Archive shortcut

**Reported requirement (verbatim):** "Create Recycle bin and Archieve folder. All archieve testcases will go to
Archieve folder. and Create Recycle bin any delete testcases before approve will go to recycle bin. only QA
lead can clear from recycle bin."

Two asks bundled together: (1) deleting a pre-approval test case should no longer be an irreversible
`db.delete()` -- it should land in a recoverable Recycle Bin, permanently cleared only by an authorized QA
Lead; (2) both "Archived" and "Recycle Bin" should be first-class, discoverable views in the Repository
sidebar rather than something only reachable via the status filter dropdown.

**Delete converted from hard-delete to soft-delete.** `TestCase` gained four columns: `is_deleted` (Boolean,
default False), `deleted_by_id` (FK to `qap_users`), `deleted_at`, `deleted_reason`. `delete_test_case`
(single) and `bulk_delete_test_cases` no longer call `db.delete()` -- they set `is_deleted=True`,
`deleted_by_id`, `deleted_at`, and log a `"Moved to Recycle Bin"` audit row via the existing
`_case_workflow_action` helper. The pre-existing 409 rule from section 66 (a test case that has ever been
Approved/Archived/Rejected can never be deleted, full stop) is unchanged and still enforced first -- soft-delete
only applies to the same pre-approval cases that hard-delete used to apply to. A case already in the Recycle
Bin now 400s with "This test case is already in the Recycle Bin" if deleted again.

**`_selected_project_cases` hardened once, benefiting every bulk endpoint.** Rather than adding an
`is_deleted` guard to each of the ~8 existing bulk endpoints individually, the shared helper now filters
`is_deleted.is_(False)` by default and takes an `include_deleted: bool = False` opt-in, used only by the two
recycle-bin-specific bulk endpoints below. Every other existing and future bulk endpoint (approve, reject,
return, archive, update...) automatically treats a soft-deleted row as "not found" with no per-endpoint change
required. `list_test_cases`, `list_all_test_cases_for_project`, and `get_test_case_summary` all now exclude
`is_deleted=True` rows the same way they already excluded nothing before -- deleted cases disappear from every
normal list and count.

**New Recycle Bin endpoints, mirroring the Archive endpoints' shape:**
- `GET /projects/{project_id}/test-cases/recycle-bin` -- paginated, searchable, sorted by `deleted_at` by
  default.
- `POST /test-cases/{case_id}/restore-from-recycle-bin` + bulk `.../test-cases/bulk-restore-from-recycle-bin`
  -- Author-tier (`require_can_author_repository`, same tier that could delete in the first place), clears all
  four soft-delete columns and logs `"Restored from Recycle Bin"`.
  `DELETE /test-cases/{case_id}/purge` + bulk `.../test-cases/bulk-purge` -- gated to QA Lead Group only
  (`require_can_manage_repository_governance`, matching "only QA lead can clear from recycle bin" exactly), the
  only remaining code path in the app that issues a real `db.delete()`. The audit row (`"Purged from Recycle
  Bin"`) is logged *before* the delete, which is safe because `ApprovalAction.entity_id` is a plain
  unconstrained Integer with no FK -- the audit trail survives the row it describes being gone.

**New Oracle columns require a manual ALTER.** Per this app's no-Alembic, additive-only (`create_all()`)
convention, `backend/scripts/2026-08_add_test_case_recycle_bin_columns.sql` was added
(`is_deleted NUMBER(1) DEFAULT 0 NOT NULL`, `deleted_by_id`, `deleted_at`, `deleted_reason`). **This still needs
to be run by hand against the live Oracle schema** (`sqlplus ... @2026-08_add_test_case_recycle_bin_columns.sql`)
before deploying this app code -- deploying first would 500 every Repository list/delete/restore/purge call
with ORA-00904.

**Sidebar: two new pinned pseudo-folder shortcuts.** Following the exact pattern already established by the
`UNFILED` sentinel (a virtual entry pinned above the real folder tree, not a real `TestFolder` row),
`ARCHIVE_VIEW` and `RECYCLE_BIN` sentinels were added the same way -- deliberately not implemented as either
(a) physically moving cases into a real folder, which would destroy their original folder context, or (b)
leaving this as "pick Archived from the status dropdown," which was the actual reported discoverability
complaint. Clicking "Archived" filters `status=['Archived']` against the normal list endpoint; clicking
"Recycle Bin" switches the data source entirely to the new `.../recycle-bin` endpoint. Both show live counts
(`archived_count`, `recycle_bin_count`, added to `TestCaseSummaryOut` alongside the existing folder counts).

**New `RecycleBinPanel` component**, deliberately not reusing the main list's `Table` column configuration
(Workflow badges, checkout state, GOV-002-aware checkbox eligibility -- all meaningless for an already-deleted
case). Own local selection state; columns for test case, status-when-deleted, deleted-by, deleted-on; row-level
and bulk Restore (visible to any author) and "Clear permanently" / "Empty selected" (visible only to QA Lead
Group, wrapped in a destructive `ConfirmModal`).

**Delete confirmation copy corrected for the new reversible behaviour.** Both the single-case delete modal
(`TestCaseModal`) and the bulk-delete modal previously said "permanently delete... cannot be undone," which
became inaccurate the moment delete became a soft-delete. Both now say the case moves to the Recycle Bin and
can be restored or later purged by a QA Lead. The Recycle Bin panel's own purge confirmations correctly kept
the "permanently... cannot be undone" wording, since purge is the one remaining truly irreversible action.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed byte-identical via `diff` on every touched file
(`models.py`, `schemas.py`, `test_repository.py`, `types.ts`, `TestRepository.tsx`, the new `.sql` script).

**Outstanding manual action:** `backend/scripts/2026-08_add_test_case_recycle_bin_columns.sql` has not been run
against the live Oracle database yet -- required before this code is deployed.

## 67a. Fix: ORA error on every `is_deleted` filter (`IS 0`/`IS 1` rejected by Oracle)

The user hit this against a live Oracle DB immediately after section 67 shipped:
`qap_test_cases.is_deleted IS 0` -- Oracle's `IS` operator only accepts `NULL`/`TRUE`/`FALSE` (23c+), not a bare
numeric literal, so every one of the seven `models.TestCase.is_deleted.is_(False)` / `.is_(True)` filters added
in section 67 (`list_test_cases`, `get_test_case_summary` x3, `list_all_test_cases_for_project`,
`_selected_project_cases`, `list_recycle_bin`) 500'd on first real use. This exact footgun was already
documented in this same file's `_stage1_reviewer_ids` (`models.User.is_active == 1`, "Oracle stores SQLAlchemy
Boolean as NUMBER(1); `.is_(True)` emits `IS 1`, which Oracle rejects with ORA-00908. Equality emits `= 1`.") --
missed when writing the new Recycle Bin filters. Fixed by switching all seven to `== False` / `== True` (with
`# noqa: E712`, matching the equality-comparison convention already used everywhere else in this codebase --
`departments.py`, `auth.py`, `test_projects.py`, `functional.py`, `notifications.py`).

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. Documents and outputs copies re-synced,
`test_repository.py` confirmed byte-identical via `diff`.

## 67b. Fix misleading checkbox tooltip + add "Recommended By" to the Workflow column

Two small follow-ups reported while using the bulk-recommend checkboxes added in section 63/126:

**Misleading disabled-checkbox reason.** A row disabled for QA 2 because QA 2 authored its content (GOV-002:
the author may never act on their own draft, full stop -- independent of who actually submitted it, since
authoring/checkout is a broad team-tier permission and a different QA_ENGINEER can pick up and submit someone
else's draft) showed the tooltip "You cannot recommend a test case submitted by you," which is simply wrong
when the author and the submitter are different people. `checkboxEligibility`'s `Recommendation Pending`
branch now says "You authored this test case. Another QA Group member must record its Stage 1 decision,"
matching the wording already used by the other three checkpoints (`In Review`, `Review Completed`, `QA Lead
Approval Pending`).

**No visibility into WHO authored a case, only who submitted it.** Same root cause as the above -- the
Workflow column showed "Submitted by X" but never "Authored by Y," so a disabled checkbox with author != submitter
was inexplicable from the list alone. Added a conditional "Authored by" line, shown only when it differs from
"Submitted by" (avoids a redundant restatement on the common case where the same person authored and submitted).

**"Add Recommended By once recommended."** Once a NEW-path draft clears Stage 1 (status moves to "QA Lead
Approval Pending"), `TestCaseVersion.reviewed_by_id` records who made that recommend decision -- already set by
both `review_test_case` and `bulk_recommend_test_cases`, just never surfaced. Added
`TestCase.current_draft_reviewed_by_name` (mirrors `current_draft_submitted_by_name`'s existing pattern exactly),
exposed on both `TestCaseOut`/`TestCaseListOut` and `types.ts`, rendered as a new "Recommended by" line in the
Workflow column -- naturally absent while still at "Recommendation Pending" (nothing decided yet) and appears
once it moves on.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed byte-identical via `diff` on every touched file
(`models.py`, `schemas.py`, `types.ts`, `TestRepository.tsx`). No new Oracle column -- `reviewed_by_id` already
existed on `qap_test_case_versions` (used by the pre-existing OLD-path Stage 1/Stage 2 flow), so no SQL script
needed this round.

## 67c. Fix ORA-00001 editing a Rejected test case with no approved baseline

Reported directly, with the full Oracle traceback: editing TQA-TC-50 (test_case_id 540) 500'd with
`ORA-00001: unique constraint (UQ_QAP_TCV_CASE_VERSION) violated ... row with column values (TEST_CASE_ID:540,
VERSION_MAJOR:1, VERSION_MINOR:0) already exists`.

**Root cause.** `_next_provisional_version_numbers` assigned a brand-new draft's version number by asking "does
this case have an approved baseline?" -- no baseline meant "nothing has ever existed for this case, start at
1.0," which was true the first time but stops being true after a Reject: `review_test_case`'s REJECT branch
sets `draft.status = "Rejected"` but -- unlike APPROVE, which explicitly clears `obj.current_draft_version_id
= None` -- deliberately leaves `current_draft_version_id` pointing at the now-Rejected version (Rejected is
terminal/frozen-in-history, not cleared, so `current_draft_version` keeps resolving to it for
`update_test_case`'s `rejected_base` handling, same doc comment). So a case that's been rejected once already
has a real row sitting at `(1, 0)` in `qap_test_case_versions` with NO approved baseline. Editing it again
(`update_test_case`'s `rejected_base` path, or `bulk_update_test_cases`) spun off a fresh draft, asked for
"the next version number," got told `(1, 0)` again (since "no approved" was the only signal it looked at), and
tried to INSERT a second row at that same key -- guaranteed collision, on literally the very next edit after
any rejection.

**Fix.** `_next_provisional_version_numbers` now falls back to the case's actual version history
(`case.versions`, the ORM relationship, not just `current_approved_version`) when there's no approved baseline:
if any version rows exist at all, the next number is one past the highest `(version_major, version_minor)`
among them; only a case with truly zero version rows (can't happen post-creation, but defensively kept) still
starts at `(1, 0)`. Same fix protects both call sites (`update_test_case`'s Rejected-edit path and
`bulk_update_test_cases`'s no-draft path) since both go through this one shared helper.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. Documents and outputs copies re-synced,
`test_repository.py` confirmed byte-identical via `diff`. No schema change -- this is a pure application-logic
fix, no SQL script needed. The failed insert that produced the reported traceback rolled back cleanly (Oracle
rejected the whole INSERT), so there's no bad data left behind to clean up.

## 68. "Remove from cycle" restricted to QA Lead + blocked once execution history exists; Administration supersedes

Reported directly, verbatim: "'Remove from cycle' should be available only for QA lead, also once execution
history created then remove from cycle should not be enable for everyone. Same for Test Cycle, once execution
history created then remove option should not be there for QA lead. Administration can supersede everything."

Two rules bundled together, applied to both "remove a testcase from a cycle" and "delete a whole cycle": (1)
role -- QA_ENGINEER can no longer remove/delete, only the QA Lead Group (QA_LEAD/CHIEF_MANAGER_QA/AGM_QA) can;
(2) once recorded -- even a QA Lead loses the ability the moment there's execution history to protect; only an
Administrator may still act. Admin supersedes both rules everywhere, per "Administration can supersede
everything."

**`remove_execution` (single, `DELETE /executions/{execution_id}`) and `bulk_remove_executions`
(`POST .../executions/bulk-remove`).** Router-level role narrowed from `_EXEC_ROLES` (included QA_ENGINEER) to
`require_roles(QA_LEAD, CHIEF_MANAGER_QA, AGM_QA)` (Admin still bypasses via `has_role`'s standing ADMIN
short-circuit). New helper `_require_can_remove_execution` blocks removal of a SPECIFIC execution slot once it
has any recorded attempt (`TestExecutionRun` row) -- deliberately per-slot, not cycle-wide like the pre-existing
`_require_scope_change_permission` (still used, unchanged, by `add_test_cases_to_cycle` only -- not touched by
this change, since the report was specifically about removal), so other still-untouched slots in the same
cycle stay removable by a QA Lead. `bulk_remove_executions` applies the same per-slot check across the whole
selection and stops the entire batch (all-or-nothing, matching this codebase's established atomic bulk
convention) if any selected slot already has history and the caller isn't an Administrator.

**`delete_cycle` (`DELETE /cycles/{cycle_id}`).** Was already QA-Lead-Group-gated via
`require_can_manage_execution_governance`, and already blocked deleting any NON-EMPTY cycle regardless of role
(stricter than "once history exists" -- blocks even an empty-of-history cycle that still has un-executed
testcase slots in it) -- both already satisfied the reported rule for QA Lead. What was missing: Admin
couldn't override it either. An Administrator can now delete a non-empty cycle outright; doing so cascades to
every execution slot, its full attempt history, and its evidence documents in one step (same cleanup
`bulk_remove_executions` performs per-slot, reused here for the whole cycle), logged as a single
`ApprovalAction` audit row (`entity_type="TEST_CYCLE"`, decision "Deleted (Administrator override)") before the
cycle itself is removed. Files are only deleted from disk after the database commit succeeds, matching the
existing pattern.

**Frontend (`TestExecution.tsx`).** New `QA_LEAD_GROUP_ROLES` constant (`QA_LEAD`/`CHIEF_MANAGER_QA`/`AGM_QA`,
matching the backend exactly) replaces the previous `CAN_EXEC_ROLES`-based role check for `canDeleteCycle` --
which, in passing, fixes a pre-existing bug: `CAN_EXEC_ROLES` never included `AGM_QA` even though
`myAccess.can_manage_execution_governance` already correctly reflected AGM_QA on the backend, so an AGM_QA user
never actually saw the Delete Cycle button despite having the right on the backend. New
`removeFromCycleEligibility(execution)` (mirrors `TestRepository.tsx`'s `checkboxEligibility` pattern) drives:
the single-execution "Remove from Cycle" button in `RecordResultModal` (now shown/enabled based on eligibility,
with the blocked reason surfaced as help text when hidden); the bulk toolbar "Remove from cycle" button
(re-gated on the new `canManageExecutionGovernance` flag instead of the broader `canManageRunners`); and
`BulkRemoveModal`, which now splits the selection into removable vs. blocked-by-history, shows the blocked
testcase keys explicitly in the confirmation dialog, and only submits the removable subset (same "silently
exclude what the backend would reject anyway" pattern as `TestRepository.tsx`'s bulk delete). The Delete Cycle
confirmation copy now explains the Administrator override explicitly.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed byte-identical via `diff` on both touched files
(`test_execution.py`, `TestExecution.tsx`). No schema change -- pure application-logic/permission change, no
SQL script needed.

## 69. Scenario 1 refinement: the original adder may self-remove a not-yet-executed testcase

Reported directly, as a follow-up scenario to section 68: "tester add testcase in lifecycle, but not executed
it, just added, means no execution history. might be by mistake that testcases has been added. now system
should allow to remove from lifecycle as there are no test execution history." Section 68 had restricted
"Remove from cycle" to the QA Lead Group only, with no exception -- which meant a QA_ENGINEER could no longer
undo their own same-session, zero-consequence mistake without escalating to a QA Lead. Asked directly which
of three options to implement; confirmed: the ADDER may remove their own addition, but only while it still has
no execution history -- not any tester, not once anything's been recorded against it.

**New column: `TestExecution.added_by_id`.** No prior column recorded who added a testcase slot to a cycle.
Added (nullable FK to `qap_users`), set to `current_user.id` in `add_test_cases_to_cycle` (the only place
`TestExecution` rows are created). A slot created before this column existed simply has `added_by_id = NULL`
and falls back to "QA Lead Group/Admin only" removal, same as if the feature didn't exist for it. New
`backend/scripts/2026-08_add_test_execution_added_by_column.sql` -- **still needs to be run by hand** against
the live Oracle schema, same manual-ALTER convention as every other schema change this cycle.

**`_execution_removal_block_reason` (renamed/rewritten from section 68's `_require_can_remove_execution`)**
now has three tiers instead of two, checked in order: (1) Admin -- always allowed. (2) Any recorded attempt on
this specific slot -- QA Lead Group loses the ability too now (same as section 68); Admin only. (3) No
attempt yet -- QA Lead Group may remove any slot; a plain QA_ENGINEER may remove only a slot where
`added_by_id == current_user.id`; anyone else is still blocked. Router-level role on `remove_execution`/
`bulk_remove_executions` widened back to include `QA_ENGINEER` (was QA Lead Group only) so path 3's self-remove
case can even reach the function -- the actual gate lives entirely in this one helper, not the router
decorator. `bulk_remove_executions`'s per-item history check was replaced with a call to this same helper, so
a mixed bulk selection (some added-by-me-unexecuted, some added-by-someone-else, some with history) is
evaluated identically to the single-item path.

**Frontend.** `removeFromCycleEligibility` (`TestExecution.tsx`) mirrors the backend's three-tier priority
exactly, reading the new `added_by_id`/`added_by_name` fields (added to `TestExecutionOut` on both ends). The
bulk toolbar "Remove from cycle" button is now visible to any exec-capable user (not just QA Lead Group),
since a QA_ENGINEER may now have something eligible to remove too -- `BulkRemoveModal` takes the eligibility
function directly (was a plain `isAdmin` boolean) and filters/labels removable vs. blocked exactly like the
single-item case.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` both clean.
Documents and outputs copies re-synced and confirmed byte-identical via `diff` on every touched file
(`models.py`, `schemas.py`, `test_execution.py`, `types.ts`, `TestExecution.tsx`, the new `.sql` script).

**Outstanding manual action:** `backend/scripts/2026-08_add_test_execution_added_by_column.sql` has not been
run against the live Oracle database yet -- required before this code is deployed.

## 70. "Admin and Scale 6+ Access-Control Requirement" -- Admin department-scoping bug, reversing an earlier explicit decision

Reported directly, as a full formal spec: "Currently, a user assigned the `ADMIN` role cannot view system data
or perform administrative actions unless the same user is also assigned the `SCALE_6_PLUS` role... The `ADMIN`
role must operate independently and must not depend on `SCALE_6_PLUS`, department membership, QA role,
Executive role, or any other business role."

**Root cause, confirmed real.** `deps.py::dashboard_department_scope` -- the single function every
department-scoped list/dashboard endpoint in the app calls to decide "confine this query to one department, or
show everything" -- checked `set(current_user.roles) & DASHBOARD_DEPARTMENT_UNRESTRICTED_ROLES` (QA_LEAD/
QA_ENGINEER/SECURITY_ANALYST/CHIEF_MANAGER_QA/AGM_QA/SCALE_6_PLUS) directly against the raw roles list, NOT
`has_role()`. `ADMIN` was never a member of that set, so a user whose only role is `ADMIN` fell through to
`return current_user.department or None` -- scoped to their own single department exactly like a plain
business user, unless they ALSO held `SCALE_6_PLUS` (or one of the QA/Security roles). This is a real,
system-wide defect: every one of this function's 30+ call sites was affected in one shot (`dashboard.py`,
`qa_requests.py`, `defects.py`, `test_projects.py`, `test_reports.py`, `functional.py`, `performance.py`,
`sast_dast.py`, `suppression.py`, `signoff.py`, `approvals.py`, `reports.py`).

**Notable: this reverses an earlier, explicitly "confirmed directly" decision in this same codebase's history.**
The function's own comment (now rewritten) used to say: "Checked directly against the raw roles list... NOT
has_role() -- has_role() treats ADMIN as satisfying any role check, which would incorrectly also exempt an
Admin account from this scoping even though Admin is one of the roles that IS meant to be scoped here
(confirmed directly)." That was a deliberate choice made and explicitly confirmed earlier in this project's
history. This new, much more detailed formal requirement is unambiguous on the exact same point in the
opposite direction ("The system shall grant administrative access without checking... Department") and
explicitly frames the OLD behavior as "a critical role-mapping and authorization defect." Implemented as
requested -- flagging the reversal here rather than silently overwriting the earlier decision's reasoning.

**Fix.** `dashboard_department_scope` now checks `current_user.has_role(Role.ADMIN)` first and returns `None`
(unrestricted) immediately if true -- before the `DASHBOARD_DEPARTMENT_UNRESTRICTED_ROLES` check, matching the
pattern `deps.py::require_same_department` (the per-record, action-level department check) already used
unconditionally. Every other role's behavior is unchanged: `SCALE_6_PLUS`, QA/Security roles, and plain
business users are scoped exactly as before.

**Verified already satisfied elsewhere (spec Section 4.2, "Admin can act at any workflow stage"), no further
change needed.** Audited for the same "AND-with-another-role" coupling bug pattern across the rest of the
backend (`grep` for raw `set(current_user.roles)`-style checks, since `has_role()` itself already
short-circuits on ADMIN and is used almost everywhere) -- the dashboard/list-scope function above was the only
place an Admin's OWN access was gated on anything besides the `ADMIN` role itself. Every action-level
permission helper (`require_roles`, `can_manage_repository_governance`, `can_manage_execution_governance`,
`require_same_department`, etc.) is built on `has_role()`, which has always treated `ADMIN` as satisfying any
role check -- an Admin can already approve/recommend/assign/reassign/return/reject/archive/restore at any
workflow stage across every module in this app without needing `SCALE_6_PLUS` or a matching department. The
one unrelated `current_user.department != ...` inline check found (`auth.py::_require_own_department_target`)
governs a deliberately narrow "local Department Admin" self-service feature (a business Department Head/QA
Executive managing users within their own department), not the global system `ADMIN` role's own access --
out of scope for this defect.

**Explicitly NOT built this round -- large net-new features, not bug fixes, flagged here rather than silently
skipped:**
- **Section 5 -- a dedicated department-selection landing screen for `SCALE_6_PLUS` users, plus a persistent
  department switcher in the header/nav** that refreshes dashboards/lists/counts and cancels in-flight
  requests on change. No such UI exists anywhere in the frontend today (confirmed via search) -- `SCALE_6_PLUS`
  currently gets the SAME "no restriction, show everything at once" list/dashboard behavior as the QA roles it
  was modeled on, with no forced single-department landing step or in-app switcher. This is a genuine new UX
  flow across essentially every list/dashboard screen, not a fix to existing code.
- **Section 8 -- an "All Departments" / per-department context selector for Admin.** Same reasoning: no
  department-selector UI exists for any role today.
- **Section 5.3's exact 403 JSON shape** (`{"message": "Scale 6+ access is read-only..."}`) for mutation
  attempts. Not needed for correctness -- `SCALE_6_PLUS` was never included in any write-permission role tuple
  anywhere in the backend (confirmed via search), so mutations by a Scale 6+-only user already 403 today, just
  with each endpoint's own generic "None of your roles are permitted" message rather than this specific one.
- **Section 4.3 -- structured "administrative override" audit rows** (e.g. "approved by Admin User through
  administrative override. Original assigned group: X") and **mandatory override-reason capture for sensitive
  Admin actions.** Existing `ApprovalAction` audit rows already record actor/actor_role/decision/comments/
  timestamp for every governed action Admin performs, but do not currently distinguish "Admin acting as the
  assigned party" from "Admin overriding an assignment restriction," and there's no dedicated override-reason
  prompt in the UI.
- **Section 9's full audit field set** (IP/session, IP/session for department-switch events) -- not currently
  captured anywhere in this app's audit trail.

These four are substantial, cross-cutting builds (a new onboarding/navigation flow, a new UI component reused
across every list screen, and an audit-schema extension) rather than defect fixes -- flagging them for an
explicit decision on priority/scope rather than attempting a partial, unreviewed implementation of all of them
in the same pass as the confirmed critical bug above.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. Documents and outputs copies re-synced
and confirmed byte-identical via `diff` on the touched file (`deps.py`). No schema change, no SQL script
needed -- pure application-logic fix in one shared function.

## 71. SM / Department Head group member list showed every department, not just the request's own

Reported directly, with a screenshot: a request raised under one department (Agriculture) showed an "SM 2"
assigned-group pill; clicking it listed SM users from a DIFFERENT department, not Agriculture. "SM mapping
should be based on department level... check the defect and debug through all group if any miss other group
like department head as well."

**Confirmed backend authorization was already correct.** `functional.py::sm_decision`/`department_head_
decision`, `performance.py`, and `sast_dast.py`'s equivalents all already call `require_same_department`
before allowing an SM/Department Head decision -- an SM from another department could never actually act on
this request. This was a pure frontend DISPLAY bug: `RoleGroupLink` (`components/RoleGroupLink.tsx`) has
supported an optional `department` prop since the Application Owner group-link work (filters its member list
to a matching department when provided) -- but each module's local `assignedGroupFor()` helper, which decides
what role/label/department to pass it per status, only ever passed `department` through for the Application
Owner branch. The SM and Department Head branches returned `{ role: 'SM', label: 'SM' }` /
`{ role: [...], label: 'Department Head' }` with no `department` at all, so the modal fell back to showing
every active SM / Department Head in the entire system, not just the ones who could actually act on this
specific request.

**Confirmed across every module that has this pattern** (checked directly, per the "debug through all
groups" ask) -- the exact same two-line omission existed in all four request modules that share this
copy-pasted `assignedGroupFor` shape: `Functional.tsx`, `Performance.tsx`, `SAST.tsx`, `DAST.tsx` (SAST and
DAST share one backend router, `sast_dast.py`, and near-identical frontend structure). `Suppression.tsx` was
checked too -- no `assignedGroupFor`/`RoleGroupLink` usage there at all, not affected. Fixed all 4 files (SM
and Department Head branches in each, 8 call sites total) to pass `department` through, exactly matching the
already-correct Application Owner branch immediately above each one.

**Verified:** `npx tsc --noEmit -p .` clean. Documents and outputs copies re-synced and confirmed
byte-identical via `diff` on every touched file (`Functional.tsx`, `Performance.tsx`, `SAST.tsx`,
`DAST.tsx`). No backend change -- authorization was already correct; this was display-only.

## 72. NameError crash report + API slowness investigation

**Reported:** a live-server traceback -- `NameError: name 'removed_attempt_count' is not defined` at
`test_execution.py` line 1793 in `bulk_remove_executions`, plus a general "API calls too slow" complaint,
both under a multi-worker deployment.

**NameError -- root cause is a stale deployment, not a current code bug.** The reported line number (1793)
does not match this function's current structure at all. Confirmed directly: in the current file,
`removed_attempt_count = sum(len(execution.runs) for execution in ordered)` is computed and assigned well
before its only use in the `TestExecutionBulkRemoveResult(...)` return statement, with no branch in between
that could skip the assignment -- the ordering is correct and has been throughout this function's several
edits this session (Recycle Bin work, the QA-Lead-only restriction, the Scenario 1 self-remove change). The
traceback's line number is consistent with an OLDER copy of this file still running on the live server (most
likely a worker process that wasn't restarted, or a partial/rolling deploy that left some workers on stale
code while others got the update). Action needed on the live server: stop all worker processes and restart
them from the currently deployed file, rather than restarting one at a time -- a partial restart would leave
some workers serving the old, broken code alongside the fixed one, causing exactly this kind of intermittent
failure. Separately: this crash was already being handled safely by design -- `main.py`'s
`unhandled_exception_handler` logs the full traceback (to `backend/logs/app.log`, correlated by request ID)
and returns a clean generic-500 JSON to the client rather than leaking a raw stack trace, so the traceback
appearing in logs is the intended diagnostic path working correctly, not a sign that clients received a raw
crash.

**Slowness -- three concrete findings, in priority order (no live DB access in this sandbox, so these are
diagnosable/actionable leads, not a single confirmed root cause):**

1. **DB connection pool sizing vs. worker count.** `database.py`'s pool defaults are `DB_POOL_SIZE=10` +
   `DB_MAX_OVERFLOW=20` = up to 30 Oracle connections per worker process, and each worker gets its own pool
   (`database.py`'s own comment already flags this: "scaled down per-worker once running with multiple API
   workers"). With the Dockerfile's default `WEB_CONCURRENCY=4`, that's up to 120 concurrent Oracle
   connections demanded by the web tier alone. If the Oracle user/schema's actual session or process limit is
   lower than that (common in shared enterprise Oracle instances), requests queue for a connection until
   `DB_POOL_TIMEOUT` (default 30s) -- which presents exactly as "API calls are slow" under concurrent load,
   and eventually as pool-timeout errors. Action: check the live `DB_POOL_SIZE`/`DB_MAX_OVERFLOW`/
   `WEB_CONCURRENCY` env vars against Oracle's actual `PROCESSES`/`SESSIONS` limit for this app's DB user, and
   scale `DB_POOL_SIZE` down per-worker if needed (e.g. `DB_POOL_SIZE=5` with 4 workers instead of the default
   10).
2. **Per-request audit write.** `application_audit_middleware` (`main.py`) fires `_write_request_audit` as a
   background task on every single `/api` request (not just mutations -- GETs too, anything except
   `/api/health` and the login/logout endpoints). Each call opens its own `SessionLocal()`, does a query (if
   no user snapshot) plus an INSERT and commit, then closes. This doesn't block the client response (it's a
   `BackgroundTask`, runs after the response is already sent), but it is a full extra DB round-trip per API
   call, and it competes for the same connection pool covered in (1) under high concurrency. Not something to
   change without a decision from the user (audit completeness is presumably a deliberate compliance
   requirement, not just an oversight), but worth knowing as a contributing factor if (1) turns out to be
   under-provisioned.
3. **Missing index on `TestCase.is_deleted` -- fixed in this pass.** `is_deleted` was added for the Recycle
   Bin feature after the IDX-001..007 indexing pass (section 39) and was never itself indexed, despite being
   filtered on nearly every test-case query alongside `project_id` (`list_test_cases`,
   `get_test_case_summary` x3, `list_all_test_cases_for_project`, `_selected_project_cases`,
   `list_recycle_bin` -- all filter `project_id == X AND is_deleted == True/False` together, confirmed by
   grep). `project_id` alone is already covered by the existing `ix_qap_tc_proj_folder_created` composite, so
   this was a secondary rather than catastrophic gap (Oracle can still range-scan by `project_id`), but every
   one of those queries was falling back to a table-access-by-rowid to evaluate `is_deleted` on each candidate
   row instead of filtering it from the index directly.

**`backend/app/models.py`:** added `Index("ix_qap_tc_proj_deleted_created", TestCase.project_id,
TestCase.is_deleted, TestCase.created_at)` (26 bytes, within Oracle's 30-byte identifier limit). Not a
duplicate of `ix_qap_tc_proj_folder_created` under IDX-005 -- different second column (`is_deleted` vs.
`folder_id`), so it covers a distinct filter combination rather than a subset of it.

**`backend/scripts/2026-08_add_test_case_deleted_index.sql` (new):** same no-op-safe `CREATE INDEX`
convention as the original performance-indexes script, since this app has no Alembic and `create_all()` only
emits DDL for tables that don't exist yet -- an existing Oracle schema needs this run by hand.

**Not yet done / needs the user's live server, not this sandbox:** confirming which specific endpoints are
actually slow (this pass diagnosed structural risk factors, not a measured bottleneck), checking real Oracle
session counts under load, and checking whether `DB_POOL_SIZE` has already been tuned down from its default
in the live `.env`.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. Documents and outputs copies re-synced
and confirmed byte-identical via `diff` on `models.py` and the new SQL script.

## 73. Separate connection pool for audit writes

**Context:** direct follow-up to section 72's finding #2 (per-request audit write competing with real request
handling for the same DB connection pool). Asked directly which of four options to implement (separate pool /
in-memory batching / Redis-backed queue / audit fewer things) -- chose the separate-pool option: lowest risk,
no change to durability, timing, or what gets audited, just stops audit writes and real request handling from
fighting over the same `DB_POOL_SIZE`/`DB_MAX_OVERFLOW` budget.

Worth noting for context: a fuller async/message-broker audit design (AUD-003) was already proposed once
before (section 37/39) and explicitly descoped by the user at the time ("stay SYNC"), on the reasoning that
the existing `BackgroundTask`-based write already kept audit off the response's critical path without new
infrastructure. That reasoning still holds -- this change doesn't revisit it. It only fixes the part that
reasoning didn't cover: the background write still pulled from the *same* pool as live request handling, so
under concurrent load it could still make real requests wait for a connection.

**`backend/app/database.py`:** added a second, independent engine/pool (`audit_engine`/`AuditSessionLocal`),
same `DATABASE_URL` and same `DB_POOL_TIMEOUT`/`DB_POOL_RECYCLE`/`DB_POOL_PRE_PING`/`DB_QUERY_TIMEOUT_MS` as
the main engine, but its own pool size via new `AUDIT_DB_POOL_SIZE` (default 3) / `AUDIT_DB_MAX_OVERFLOW`
(default 5) env vars -- deliberately small, since an audit write holds its connection only briefly (one
INSERT + commit). Logged alongside the main pool's own startup log line for visibility.

**`backend/app/main.py`:** `_write_request_audit` (the function `application_audit_middleware` schedules as a
`BackgroundTask` on every `/api` request) now opens its session via `AuditSessionLocal()` instead of the main
`SessionLocal()`. Nothing else in the function changed -- same fallback-user-lookup path, same `write_audit()`
call, same close-in-`finally`.

**`backend/.env.example`:** documented the two new optional env vars alongside the existing pool settings.

**Not a fix for section 72's finding #1** (overall pool sizing vs. worker count / Oracle session limit) --
that's a live-environment tuning question this sandbox can't answer, still open. This change only stops audit
writes specifically from contributing to that contention.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean; both edited files also parsed with
`ast.parse` directly as an extra check since this touches engine/session construction at import time. No
`sqlalchemy` package available in this sandbox to actually instantiate the new engine end-to-end (same
constraint noted elsewhere in this log) -- please run `python -c "from app import database"` against a real
environment before deploying, as a final sanity check. No new schema/table, so no manual SQL script needed.

## 74. Bulk "Restore from Archive" for the Archive view

**Requested directly:** "Add Bulk 'Restore from Archive' while testcases are Archived." The single-case
restore (Archived -> Approved, `restore_test_case`) and bulk archive (`bulk_archive_test_cases`) already
existed; only the bulk counterpart of restore was missing, so an authorized user archiving/restoring several
testcases at once from the Archive view had to restore them one at a time.

**`backend/app/schemas.py`:** added `TestCaseBulkRestoreFromArchive(ids: List[int])` -- no reason field,
matching the single-case `/restore` endpoint (only the Archive direction requires a documented reason;
reversing it back to Approved isn't a governance decision the way archiving or deleting is).

**`backend/app/routers/test_repository.py`:** added `bulk_restore_test_cases`
(`POST /projects/{project_id}/test-cases/bulk-restore-from-archive`), mirroring `bulk_archive_test_cases`'s
own shape exactly -- same `require_can_manage_repository_governance` (QA Lead Group/Admin) gate,
`_selected_project_cases` lookup, and per-row `_case_workflow_action` audit trail (`"Restored"`,
`previous_state="Archived"`, `new_state="Approved"`, same wording the single-case endpoint already uses).
Rows in the selection that aren't currently Archived are silently skipped rather than failing the whole
batch -- mirrors bulk-archive's own "already Archived isn't a meaningful conflict" reasoning, just in the
opposite direction, so a row restored by someone else a moment earlier doesn't block the rest of the batch.

**`frontend/src/modules/test-management/TestRepository.tsx`:**
- `restorableSelectedIds` -- same shape as `archivableSelectedIds`, gated on `canManageRepoGovernance`, only
  ever includes currently-`Archived` rows. Naturally empty outside the Archive view (or an "All test cases"
  selection filtered to `status=Archived`), same as `archivableSelectedIds` isn't gated to any one view either.
- `BulkRestoreFromArchiveModal` -- new component, mirrors `BulkArchiveModal`'s confirm/progress/success/error
  shape and CSS classes (`tm-operation-state`/`tm-progress-track`/`tm-operation-error`, same as
  `BulkApproveModal`) exactly, minus the mandatory reason field.
- "Restore selected (N)" button added to the bulk action bar next to "Archive selected", calling
  `POST .../bulk-restore-from-archive`; on success, `refreshCases()` + clears selection, same as Archive's own
  `onArchived` callback.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean; `npx tsc --noEmit -p .` clean. No schema
change, so no manual SQL script needed.

## 75. Test Project names must be unique

**Reported directly:** "while creating project with same project name you can not create project, project
should be unique as well." `TestProject.name` had no uniqueness enforcement at all -- two projects could be
created with the identical name.

**`backend/app/routers/test_projects.py`:** added `_require_unique_project_name(db, name, exclude_id=None)`
and call it from both `create_test_project` and `update_test_project` (only when the name is actually
changing, in the update case). Case-insensitive and whitespace-trimmed comparison (`func.lower(...)`) --
"MILTON" and "milton " collide, matching what a person would actually mean by "unique," not a byte-for-byte
match. Checks every project regardless of Active/Inactive/Archived status, same as `Department.name` and
`ApplicationMaster.name`, both of which are already DB-level `unique=True` with no such carve-out. Raises 409
with the colliding project's actual name in the message.

**Enforced at the application layer, not a DB constraint.** `TestProject.name` stays `nullable=False` with no
`unique=True` added -- this app has no Alembic (`create_all()` only emits DDL for tables that don't exist
yet), and retrofitting a hard `UNIQUE` constraint onto an existing, already-populated production table risks
failing outright at deploy time if any duplicate names already exist there today. The application-layer check
gives the same guarantee for every new create/rename going forward without that risk; this matches how this
router already hand-checks other "must be valid" rules (e.g. department-must-exist-and-be-active) rather than
leaning on DB constraints for them.

**No frontend change needed** -- both the create and edit project forms already render any thrown error
generically via `<ErrorText error={error} />`, so the new 409 message surfaces automatically.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. No schema/migration script needed
(application-layer check only).

## 76. One active Test Project per Application

**Follow-up, discussed directly rather than assumed:** "also under one application create one project only.
more than one project under same application should not be allowed? what do you say" -- reasoning shared back
first (the model's own header comment already documents "one TestProject maps to one Application" as an
explicit product decision, but that was only ever enforced in the FK direction), then the user confirmed the
exact rule to implement: block a second project for an application only while an existing project for that
application is still active -- i.e. not yet Archived. A merely Inactive-but-not-Archived project still counts
as "the" current project for that application (SRS PRJ-003's three states) and still blocks a duplicate; only
Archiving frees the application up for a fresh project.

**`backend/app/routers/test_projects.py`:** added `_require_no_active_project_for_application(db,
application_master_id, exclude_id=None)`. No-ops when `application_master_id` is `None` -- projects with no
application link (a nullable field; plenty of department-only projects have none) don't collide with each
other just for both being unlinked. Checks `is_archived == False OR is_archived IS NULL` rather than a bare
`!= True` -- `is_archived` is nullable, and Oracle's three-valued boolean logic means `!= True` would silently
evaluate to NULL/unknown (and so be excluded) for a legacy row that's NULL rather than False; the explicit
`OR is_(None)` treats "no explicit archive flag" as "not archived," matching the existing Python-side `not
project.is_archived` checks elsewhere (test_reports.py's project-count summary).

Wired into three places:
- `create_test_project` -- checked right after `application_master_id` resolves.
- `update_test_project` -- checked only when `application_master_id` is actually present in the payload and
  different from the project's current value (editing any other field on a project doesn't re-trigger this).
- `unarchive_test_project` -- closes a gap the other two alone would leave open: Archive project A for
  application X (frees X up) -> create project B for X (now allowed) -> Unarchive A without this check would
  leave X with two non-archived projects again, exactly what create/update block up front.

Same "application layer, not a DB constraint" reasoning as section 75's name-uniqueness fix -- no
`unique=True` added to `application_master_id`, since retrofitting that onto an existing, already-populated
production table risks failing outright at deploy time if any application already has more than one
non-archived project today.

**No frontend change needed** -- same as section 75, both the create and edit project forms already render
any thrown error generically via `<ErrorText error={error} />`.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean. No schema/migration script needed
(application-layer check only).

## 77. Target Promotion Environment could be left blank and still pass Next

**Reported directly, with a screenshot:** "'Select Target Promotion Environment' is getting as selection. If
i am selecting there are no other option to select environment, still it's allowing to go next." Two related
gaps in the New QA Request wizard's "Release & Environment" step (`DetailsStep.tsx`), both in
`validation.ts`'s `detailsStepError`:

1. **The actual reported bug:** `detailsStepError`'s own header comment claimed every mandatory select
   "always defaults to a real (non-blank) value, so they can't be left empty through the UI" -- true for
   Deployment Environment (no blank option ever rendered), but false for Target Promotion Environment, whose
   `<select>` always renders a real `<option value="">Select Target Promotion Environment</option>`
   placeholder alongside the real choices (`DetailsStep.tsx` line ~275). Nothing explicitly checked for that
   blank value, so it could stay selected and Next/Submit still passed -- confirmed the same gap exists
   server-side too (`schemas.py`'s `target_promotion_environment: Optional[str] = None`, and
   `constants.py::validate_environment_promotion` deliberately "silently passes if either value isn't a
   recognised pipeline stage," i.e. blank). Left the backend as-is here, matching this codebase's existing
   pattern for this step's other mandatory fields (`CR_NUMBER_REGEX`/`EPIC_NUMBER_REGEX` are likewise
   frontend-only gates, not independently re-checked server-side at submit).
2. **A latent edge case the fix for #1 would otherwise have collided with:** `validTargetPromotionOptions`
   returns an empty list when Deployment Environment is already `"Production"` -- the final stage in
   `SIT -> UAT -> Pre-Production -> Production` -- since there's nowhere later left to promote to. The field
   is marked mandatory (`"Target Promotion Environment *"`), so simply adding a blank-value check would have
   made the form impossible to complete for any Production deployment instead of just under-validated.

**`frontend/src/QARequests/validation.ts`:** added the explicit check -- `if
(validTargetPromotionOptions(f.environment).length > 0 && !f.target_promotion_environment) return 'Please
select a Target Promotion Environment.'` -- only enforced when there's actually a valid choice to make,
addressing #1 without reintroducing #2.

**`frontend/src/QARequests/steps/DetailsStep.tsx`:** Target Promotion Environment's `<Field>` now computes
`targetOptions`/`hasTargetOptions` from the same `validTargetPromotionOptions(form.environment)` call and
uses it to disable the `<select>` and drop the `"*"` from its own label when Deployment Environment is
Production, with the placeholder option's text changing to "Not applicable -- Production is the final stage"
instead of "Select Target Promotion Environment" -- so the UI's own required-ness signal always matches what
`detailsStepError` is actually enforcing at that moment.

**Deliberately not touched:** `Functional.tsx`'s "Edit Details" modal has the same two fields, but neither is
marked mandatory there (no `"*"` on either label) and its own submit path has no equivalent gate to fix --
left alone as out of scope for this report, which was specifically about the New Request wizard.

**Verified:** `npx tsc --noEmit -p .` clean. No backend change, no schema/migration script needed.

## 78. Production removed as a selectable Deployment Environment, everywhere the pairing exists

**Follow-up, reported directly:** "There Should not be any option Production in deployment Environemnt. and
this replicate everywhere where the target promotion and deployment environment scnarios present." Rationale:
a QA Request/certificate/testing record is raised to plan the path TO Production, not deployed straight to
it -- Production only makes sense as a Target Promotion Environment (the pipeline's final destination), never
as the Deployment Environment a record starts from.

**`frontend/src/constants.ts`:** added `DEPLOYMENT_ENVIRONMENTS = ENVIRONMENT_PIPELINE_ORDER.slice(0, -1)` --
`['SIT', 'UAT', 'Pre-Production']`, i.e. every pipeline stage except the last -- as the one shared source of
truth every "Deployment Environment"-equivalent dropdown now reads from, instead of each screen hand-filtering
`ENVIRONMENTS` (`['Dev', 'SIT', 'UAT', 'Pre-Production', 'Production']`) locally. `ENVIRONMENT_PIPELINE_ORDER`
itself is untouched -- Target Promotion Environment dropdowns still correctly offer Production as a valid
target.

**Every location with a Deployment/Environment-Tested + Target Promotion Environment pairing, found by
grepping for `target_promotion_environment` across the frontend and checking each match for an actual
editable counterpart field (not just a read-only mirror):**
- `QARequests/steps/DetailsStep.tsx` -- New QA Request wizard's "Deployment Environment" (the field the
  original report's screenshot was about).
- `modules/functional/Functional.tsx` -- "Edit Details" modal's "Deployment Environment".
- `modules/governance/SignOff.tsx` -- "Environment Tested" on both the standalone Create Certificate form and
  the create-from-request form (2 occurrences -- same field, different modal).
- `modules/specialised-testing/Performance.tsx` -- Edit modal's "Environment" field, paired with its own
  "Target Promotion Environment" further down the same form.

All four switched from `ENVIRONMENTS.map(...)` (or an inline `.filter((e_) => e_ !== "Dev")`) to
`DEPLOYMENT_ENVIRONMENTS.map(...)`.

**Deliberately left alone, confirmed not part of this pairing:**
- `modules/security/DAST.tsx`'s per-target "environment" select (Targets repeatable rows) -- a different
  concept entirely (which environment a scan target URL lives in), no paired Target Promotion Environment
  field alongside it.
- `modules/security/SAST.tsx` and `DAST.tsx`'s "Deployment Environment"/"Target Promotion Environment"
  `DetailField`s -- read-only mirrors of the parent QA Request's own values (`req.deployment_environment`/
  `req.target_promotion_environment`), not independent editable dropdowns -- they already reflect whatever
  the (now-fixed) QA Request contains, with nothing further to change.
- `DastStep.tsx`/`PerformanceStep.tsx`'s own wizard "environment" pickers -- already restricted to
  `POST_SIT_ENVIRONMENTS` (UAT/Pre-Production only, no Dev, no Production) for an unrelated reason (DAST scans
  and Performance tests are never run against Dev/SIT/Production at all), so already correct.

**Incidental effect on section 77's fallback:** `DetailsStep.tsx`'s "Target Promotion Environment has zero
valid options" edge case (`validTargetPromotionOptions('Production') === []`) can no longer be reached via any
FRESH selection now that Production isn't offered as a Deployment Environment choice at all -- the
disabled-field/dropped-`"*"` fallback added in section 77 stays in place purely as a safety net for any
pre-existing Draft saved with `environment='Production'` before this change; comment updated in place to say
so rather than removing the fallback outright.

**Not changed:** no backend enum/allowed-value validation added for `environment` (`schemas.py`'s
`environment: Optional[str] = None` stays a free string) -- matches this codebase's existing pattern for this
same field pairing (dropdown option lists are the enforcement layer client-side; the backend only checks
cross-field *ordering*, via `validate_environment_promotion`, not the individual value's membership in any
particular allowed set). A stale pre-existing record with `environment='Production'` already saved is
therefore unaffected by this change and remains readable/displayable as-is.

**Verified:** `npx tsc --noEmit -p .` clean. No backend change, no schema/migration script needed.

## 79. Tester reassignment: QA Lead group AND the current tester(s) can now hand off to another QA member, at any point after initial assignment

Reported directly: "after qa lead readiness, lead assigning to tester, current problem is once assigned
there are no other option to reassign the tester or modify the tester. give qa lead to reassign as well as
the current assign people can reasign to another qa member."

**Before:** `assign-tester` (Functional) / `complete-planning` (Performance) were each callable exactly once,
only while `status === PLANNING`, only by the QA Lead group. Once a tester was assigned and the request moved
on, there was no way to change who was assigned -- not even for the QA Lead, and not for the tester themself
to hand off to a colleague.

**After, both modules:** the action is now callable across the entire active-testing window, by either the
QA Lead group OR whoever is currently assigned:
- Functional -- `TESTER_REASSIGNABLE_STATUSES` (new, `constants.py`): `PLANNING, TESTER_ASSIGNED, TEST_DESIGN,
  EXECUTION_IN_PROGRESS, DEFECT_RAISED, WAITING_FOR_FIX, RETESTING`.
- Performance -- `PERFORMANCE_TESTER_REASSIGNABLE_STATUSES` (new, `constants.py`): every
  `PERFORMANCE_STAGE_ORDER` entry from `PLANNING` onward (`PLANNING` through `REPORT`).

**Status handling, both modules:** calling the action while `status` is still exactly `PLANNING` is treated as
the *initial* assignment and behaves exactly as before (Functional advances to `TESTER_ASSIGNED`; Performance
advances straight to `ENVIRONMENT_SETUP`, same fused assign+advance mechanic it always had). Calling it at any
later status in the reassignable window is a pure *reassignment* -- the tester list is updated but `status` is
left untouched, so a request mid-`LOAD_TEST_EXECUTION` (say) stays there after a tester swap instead of
regressing back to an earlier stage. The audit log records "Tester Assigned"/"QA Tester Assigned" for the
initial case and "Tester Reassigned"/"QA Tester Reassigned" for the rest, against the correct current-stage
label (`QA_REQUEST_STATUS_LABELS`/`PERFORMANCE_STATUS_LABELS`).

**Backend (`routers/functional.py`):**
- New `_require_assigned_qa_lead_or_current_tester(obj, user)` -- passes for the QA Lead group (with the usual
  CM-QA/AGM-QA Executive bypass) or for any user ID currently in `obj.assigned_tester_ids`.
- `assign_tester`'s route dependency widened to also accept `Role.QA_ENGINEER` (previously QA Lead group
  only) -- the permission check itself is still done by the helper above, this just lets a plain QA Engineer
  reach the endpoint at all.
- `_require(obj, TESTER_REASSIGNABLE_STATUSES, "Assign tester")` replaces the old single-status check.

**Backend (`routers/performance.py`):** identical shape --
`_require_assigned_qa_lead_or_current_performance_tester` (deliberately a separate function from the
pre-existing `_require_performance_execution_owner`, which gates the request's own execution-step actions --
"who may change WHO is assigned" is a different concern from "who may act on the request's own steps," kept
separate so one can't silently change the other), `complete_planning`'s route dependency widened to add
`Role.QA_ENGINEER`, `_require(obj, PERFORMANCE_TESTER_REASSIGNABLE_STATUSES, "Assign QA Tester")`.

**Frontend, both `Functional.tsx` and `Performance.tsx`:**
- `canAssignTester`/`canCompletePlanning` widened from `isAssignedQALead && status === 'PLANNING'` to
  `(isAssignedQALead || isAssignedTester) && <reassignable-statuses>.includes(status)`.
- The tester picker is pre-filled with the currently-assigned tester(s) (via a `useEffect` keyed on
  `req.id`/`req.assigned_tester_ids`) whenever this is a reassignment rather than the initial assignment, so
  reassigning defaults to "hand off from the current roster" instead of starting blank.
- Button/placeholder copy switches to "Reassign Tester(s)..." / "Reassign Tester(s)" (Functional) and
  "Reassign QA Tester(s)..." / "Reassign Tester(s)" (Performance, dropping "& Complete Planning" since status
  no longer advances on a reassignment) once past the initial-assignment case.
- `TESTER_REASSIGNABLE_STATUSES` / `PERFORMANCE_TESTER_REASSIGNABLE_STATUSES` added to `constants.ts`,
  mirroring the two new backend constants exactly (same dual-mirroring convention as
  `ENVIRONMENT_PIPELINE_ORDER`).

**Not changed:** no schema/migration script -- no new columns, `assigned_tester_ids` (comma-separated string)
already existed and is simply overwritten on reassignment, same as it always was on initial assignment.

**Verified:** `python3 -m py_compile` clean on `functional.py`/`performance.py`/`constants.py`;
`npx tsc --noEmit -p .` clean.

## 80. Test Cycle Blocked/Resumed now auto-syncs its linked Functional request's status

Reported directly: "If test lifecycle is Blocked, then automatically mark linked QA request
WAITING_FOR_FIX and again lifecycle marked as In Progress then linked qa request again marked as
EXECUTION_IN_PROGRESS."

**Where:** `routers/test_execution.py`'s `update_cycle` (`PATCH /api/test-execution/cycles/{cycle_id}`) --
the same endpoint that already validates and records every Test Cycle lifecycle transition
(`_ALLOWED_CYCLE_TRANSITIONS`/`_CYCLE_TRANSITION_ACTIONS`). New helper
`_sync_linked_functional_request_status(db, cycle, transition_action, current_user)` is called right after
the existing "Lifecycle" `ApprovalAction` is written, only for the two transitions that matter:
`"Block Execution"` (`In Progress -> Blocked`) and `"Resume Execution"` (`Blocked -> In Progress`).

**Rule:**
- **Block Execution:** if the linked Functional request's status is currently `EXECUTION_IN_PROGRESS`, set it
  to `WAITING_FOR_FIX` and record an audit row (`entity_type="FUNCTIONAL_REQUEST"`) noting which cycle caused
  it.
- **Resume Execution:** if the linked Functional request's status is currently `WAITING_FOR_FIX`, restore it
  to `EXECUTION_IN_PROGRESS` -- but only if none of that request's *other* linked Test Cycles are still
  `Blocked` (a Functional request can have several cycles linked at once -- see
  `FunctionalRequest.linked_test_cycles` / `complete_qa`'s pre-existing "every linked cycle must be Completed"
  gate for the same multi-cycle pattern). If another cycle is still Blocked, the request correctly stays at
  `WAITING_FOR_FIX`.
- The guard on both directions (only firing from the *specific* status the sync itself would have produced)
  means it can never clobber an unrelated, manually-reached status -- e.g. `QA_COMPLETED`, or `DEFECT_RAISED`
  sitting in the separate manual (unlinked-cycle) defect flow.

**Scope:** Functional requests only. A Test Cycle can structurally link to SAST/DAST/Performance requests too
(`TestCycleChildRequestLink.child_type`), but only Functional's status vocabulary has this exact
Execution-In-Progress / Waiting-For-Fix pair -- Performance's own lifecycle folds that concern into a single
`DEFECT_FIX_RETEST` status with no direct equivalent, so it's deliberately left out of this pass rather than
guessing a mapping; SAST/DAST don't use Test Cycles/Executions at all. The sync no-ops immediately (`link.child_type != "Functional"`) for any other linked type.

**Not changed:** no schema/migration script -- reuses the existing `TestCycleChildRequestLink`/
`FunctionalRequest.status` columns and the existing `ApprovalAction` audit table.

**Verified:** `python3 -m py_compile` clean on `test_execution.py`.

## 81. QA Lead can now raise "Request Sign-off" on behalf of an unavailable tester

Reported directly: "'Request Sign Off' button is not enable[d] for QA lead, sign off as well as from
request section, if tester [is] no[t] available then at least [o]n behalf of QA he can raise the request."

**The bug had three layers, all pointing the same way -- a QA Lead was blocked at every one of them, not
just the frontend button:**

1. **`routers/functional.py`'s `request_signoff`** (`POST /{req_id}/request-signoff`) -- its route decorator
   already allowed `Role.QA_LEAD`, but an in-function call to `_require_assigned_tester(obj, current_user)`
   silently overrode that and 403'd anyone but the literal assigned tester (or Admin). Swapped for the
   already-existing `_require_assigned_qa_lead_or_current_tester` helper (added for tester reassignment, see
   section 79) -- generalized to take an `action` string for its error message rather than a hardcoded
   "reassign the tester(s)..." wording, since it's now shared by two different actions.
2. **`routers/signoff.py`'s `create_signoff`** (`POST /api/signoffs`, the call `NewSignOffModal` actually makes
   first to create the certificate) -- its role gate was `require_roles(Role.QA_ENGINEER)` only, with no
   `QA_LEAD` at all (contrary to a stale frontend comment that claimed it already matched
   `request-signoff`'s gate). Widened to `require_roles(Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA,
   Role.AGM_QA)`. Self-approval is still blocked further down the certificate's own approval chain
   (`qa_lead_decision`'s existing `require_not_requester` check) -- a QA Lead who drafts a certificate still
   cannot be the one who later approves it as QA Lead.
3. **Frontend, `Functional.tsx`'s `canRequestSignoff`** -- only checked `isAssignedTester`; widened to
   `(isAssignedTester || isAssignedQALead)`, same shape as the existing `canAssignTester`.
4. **Frontend, `SignOff.tsx`'s `canCreate`** (gates the standalone "+ New Sign-off Certificate" button on the
   Sign-off module's own list page -- the "sign off ... section" half of the report) -- widened from
   `QA_ENGINEER`-only to `hasRole(user, 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA')`.

**Not changed:** the certificate/request picker inside `NewSignOffModal` -- it was never filtered by assigned
tester, so no change needed there; a QA Lead already saw every eligible request in the picker, they just
couldn't previously submit.

**Verified:** `python3 -m py_compile` clean on `functional.py`/`signoff.py`; `npx tsc --noEmit -p .` clean.

## 82. Defect Management register restricted to the QA team

Reported directly: "other than QA team, for others there should not be any option to open any defects."

Before this, `GET /api/defects` (list) was department-scoped but not role-scoped (any authenticated user
could browse their own department's defects), and `GET /api/defects/{id}` / `GET /api/defects/by-key/{key}`
(detail) had **no scoping of any kind** -- any authenticated user who knew or guessed a defect id/key could
open it. There was no nav, route, or page-level gate either -- "Defect Management" showed for every logged-in
user.

Given the user's own reported tradeoff (asked and confirmed directly): rather than also touching who may
*report/link* a defect (`CREATE_ROLES` in `defects.py`, which stays exactly as-is -- Requester/Business
Analyst/Application Owner can still report and link a defect same as before) or trying to preserve a
reporter's ability to see just their own defect, this pass locks down the **register/browsing surface and the
page itself**, accepting that non-QA users lose the Defect Management page entirely (including its create
buttons) rather than partially.

**Backend:**
- New shared `QA_TEAM_ROLES` constant (`constants.py`): `QA_ENGINEER, QA_LEAD, CHIEF_MANAGER_QA, AGM_QA,
  SECURITY_ANALYST` (plus the standard ADMIN bypass via `has_role()`) -- Security Analyst included per direct
  confirmation, since SAST/DAST findings also flow into this module.
- `defects.py`'s `list_defects` (`GET /api/defects`), `defect_dashboard` (`GET /api/defects/dashboard`), and
  `export_defects` (`GET /api/defects/export-xlsx`) now depend on `require_roles(*QA_TEAM_ROLES)` instead of
  plain `get_current_user`.
- **Deliberately unchanged**: `get_defect`, `get_defect_by_key`, and the attachment endpoints stay open to any
  authenticated user -- a direct deep link (e.g. from a notification) still opens for whoever already has one,
  matching the confirmed "least change" option.

**Frontend:**
- New shared `DEFECT_MANAGEMENT_ROLES` constant (`constants.ts`), mirroring `QA_TEAM_ROLES` exactly.
- `Layout.tsx`'s "Defect Management" nav item is now conditionally rendered (`...(hasRole(user,
  ...DEFECT_MANAGEMENT_ROLES) ? [...] : [])`), same pattern as the existing Audit Log nav gate.
- `Defects.tsx` gets an Admin.tsx-style page-level gate: an "Access Restricted" `Card` returned after every
  hook (so the Rules of Hooks aren't violated) instead of the register, for anyone outside
  `DEFECT_MANAGEMENT_ROLES`. `load()` itself also short-circuits at the top for the same check, so a non-QA
  user's page load doesn't even fire the page's data-fetch burst in the first place.

**Verified:** `python3 -m py_compile` clean on `defects.py`/`constants.py`; `npx tsc --noEmit -p .` clean.

## 83. Defect Management's page-load API burst collapsed from O(projects + cycles) calls to 2

Reported directly, with a DevTools screenshot: "lot's of api call, if there are 30 project then 30 api call
i don't think a good approach same for cycles, executions."

**Root cause:** `Defects.tsx`'s `load()` fetched every active project's `/my-access` (N calls), then every
active project's `/cycles` (another N calls), then -- for every cycle returned by every one of those -- a
further `/executions?status=Fail&status=Blocked` call. Total calls scaled as `N + N + (total in-progress
cycles across all N projects)`, worse than linear as cycle counts grow, purely to build (a) a per-project
capability lookup only ever consulted for whichever ONE defect is currently open, and (b) the "pick a
Failed/Blocked execution" dropdown used when creating or linking a defect.

**Fix, two independent pieces:**

1. **`/my-access` -- eager-for-all became on-demand-for-one.** `GET /api/test-projects/{id}/my-access`'s own
   docstring already says it's meant to be called "once per project selection," and its other two callers
   (`TestExecution.tsx`, `TestRepository.tsx`) already do exactly that. `Defects.tsx` was the outlier, fetching
   it for every project eagerly at page load even though the result (`can_give_final_approval`) is only ever
   read for whichever defect happens to be open. Replaced the eager `Record<projectId, TestProjectMyAccessOut>`
   fan-out with a single `useEffect` keyed on `selected?.project_id` that fetches on demand only when a defect
   with a project is actually opened -- 0-1 calls per defect-open instead of N calls at every page load,
   regardless of how many defects get opened in the session.

2. **Cycles + executions -- N+1-of-N+1 became one batch endpoint.** New `GET
   /api/test-execution/executions/blocked-or-failed` (`test_execution.py::list_blocked_failed_executions`)
   joins `TestProject -> TestCycle -> TestExecution` server-side in one query (active projects only, status
   in `Fail`/`Blocked`, department-scoped via `dashboard_department_scope` -- though QA team roles are already
   department-unrestricted, so this is defense in depth rather than a behavior change for the actual callers),
   returning one flattened row per execution via the new `DefectLinkableExecutionOut` schema (`project` +
   `cycle` + `execution`, deliberately shaped to match `Defects.tsx`'s own pre-existing local `ExecutionContext`
   interface exactly, which is now just a type alias for it) -- so no consumer-side logic in `CreateDefectModal`/
   `LinkExecutionModal`/the "Other affected Test Cases" picker needed to change, only where the data comes from.
   Gated to `QA_TEAM_ROLES` (defense in depth, since only the now QA-team-only Defects.tsx page calls it) and no
   longer needs a separate `/api/test-projects` fetch at all -- that was only ever used to drive this fan-out.

**Net effect:** `Defects.tsx`'s page load now makes 2 fixed API calls for this data (one batch executions call,
plus dashboard/register calls unrelated to this fix) regardless of project or cycle count, instead of scaling
with both. Combined with section 82's access restriction, this endpoint and this page are now only ever
reached by QA team accounts in the first place.

**Not changed:** no schema/migration script -- no new columns, purely new read-only endpoints/queries.

**Verified:** `python3 -m py_compile` clean on `test_execution.py`/`schemas.py`; `npx tsc --noEmit -p .` clean.

## 84. Correction to section 82 -- Defect Management reopened to Requester/Business Analyst/Application Owner

Reported directly, same day as section 82: "you are correct defect can be raised by requster, business
analyst application owner too so defect management tool should be available for them as well."

Section 82 locked Defect Management down to "QA team only" (`QA_ENGINEER`/`QA_LEAD`/`CHIEF_MANAGER_QA`/
`AGM_QA`/`SECURITY_ANALYST`). That was too narrow -- `defects.py`'s own pre-existing `CREATE_ROLES` already
lets Requester/Business Analyst/Application Owner report and link a defect, so locking the whole module away
from them left no UI path to actually use that ability.

**Fix:** the shared role constant (backend `constants.py`, frontend `constants.ts`) is renamed from
`QA_TEAM_ROLES` to `DEFECT_MANAGEMENT_ROLES` and broadened to add `REQUESTER`, `BUSINESS_ANALYST`, and
`APPLICATION_OWNER` -- i.e. every role in `CREATE_ROLES` plus `AGM_QA` (the one Executive-bypass role
`CREATE_ROLES` itself doesn't separately list). No other logic changed: `list_defects`/`defect_dashboard`/
`export_defects` (`defects.py`), `list_blocked_failed_executions` (`test_execution.py`), and the frontend
nav/page gate (`Layout.tsx`/`Defects.tsx`) all just pick up the broader set automatically since they already
referenced the shared constant by name. The department-scoping on the new batch executions endpoint (section
83) now does real work for these three roles too, since they -- unlike QA team -- are NOT in
`dashboard_department_scope`'s unrestricted set, so their own picker/register is correctly narrowed to their
own department, same as everywhere else they already see department-scoped data.

Still excluded: SM, Department Head (CM/AGM), SCALE_6_PLUS -- roles with no legitimate stake in defects at
all, matching the original report's intent.

**Verified:** `python3 -m py_compile` clean on `constants.py`/`defects.py`/`test_execution.py`; `npx tsc
--noEmit -p .` clean.

## 85. Defect assignment auto-populates Department from the linked request or Failed/Blocked execution

Reported directly: "During assigning defect, department should be auto populated based on linked request or
Failed / Blocked Test Execution."

**Before:** the "Assigned" transition's Department field (`TransitionModal` in `Defects.tsx`) only ever
prefilled from `requestDepartment` -- the linked QA Request's own department -- passed down from `Defects.tsx`
as `requests.find((r) => r.id === selected.qa_request_id)?.department`.

**After:** a new, more specific signal is checked first -- `models.Defect.project_department` (new property,
`models.py`): `self.cycle.project.department if self.cycle and self.cycle.project else None`, i.e. the
department of the Test Project that owns the linked Test Cycle, only ever set once this defect is linked to a
Failed/Blocked execution (via `cycle_id`). Exposed as `DefectOut.project_department` (`schemas.py`, mirrored
in `types.ts`).

**Priority order** (`TransitionModal`'s new `autoDepartment`): `defect.project_department` (linked execution's
project) -> `requestDepartment` (linked QA Request) -> `defect.assigned_team` (whatever it was previously set
to, for re-assigning). The project department is prioritized because it's the more specific "which team
actually owns the failing area" signal; the request department remains the fallback for a defect opened
standalone (no execution ever linked). The hint text under the field now names which of the two sources
actually supplied the value ("Defaulted from the linked Failed / Blocked Test Execution's project" vs.
"Defaulted from the linked QA Request").

**Not changed:** the Department field itself -- still a normal editable `SearchableSelect`, this only changes
its starting value; the user can still pick a different department before assigning. No schema/migration
script -- `project_department` is a computed property/response field, not a new column.

**Verified:** `python3 -m py_compile` clean on `models.py`/`schemas.py`; `npx tsc --noEmit -p .` clean.

## 86. "Report Defect from Execution" QA Request picker filtered to the linked request, with Other + manual fallback

Reported directly: "if defect open from 'report defect from execution', currently showing all request id,
logically it should be filter based on request linked with that test cycle, else also give Other, and add
one field for free to text."

**Before:** `CreateDefectModal`'s "QA Request ID *" `SearchableSelect` always listed every QA Request in the
system (up to the page's own 100-row fetch), regardless of which execution/Test Cycle the defect was actually
being raised from. A `linkedRequest` value was already computed (matching the selected execution's Test
Cycle's `linked_request_type`/`linked_request_id` against each QA Request's own linked child requests) and
used to *pre-select* the right one, but the dropdown's full option list never reflected that -- nothing
stopped a reporter from picking an unrelated QA Request instead.

**Now, in `Defects.tsx`'s `CreateDefectModal`:**
- `findLinkedRequests()` (renamed/generalized from the old single-`find()` `linkedRequest`, now a `.filter()`)
  returns every QA Request whose own linked child requests include the one this Test Cycle is linked to --
  normally 0 or 1.
- When at least one linked request is found (and this isn't the standalone "Open Defect" flow), the picker
  shows **only** that request (or requests), plus an appended **"Other (choose a different QA Request)"**
  option (sentinel `OTHER_REQUEST`, same pattern as `DetailsStep.tsx`'s existing Application Name "Other"
  flow). Picking "Other" flips `showAllRequests` to `true`, which swaps the option list to every QA Request in
  the system -- the previous, unfiltered behavior, now opt-in rather than the default.
- When no linked request is found at all (cycle isn't linked to any child request, or standalone mode), the
  picker falls back to the full list automatically -- nothing to filter by.
- **New**: a manual free-text input ("or type the QA Request ID directly, e.g. TQA-REQ-07") sits below the
  picker. Since `POST /api/defects` requires a real `QARequest.id` integer FK (confirmed: no backend
  lookup-by-request_id-string endpoint exists anywhere in `qa_requests.py`), this resolves what's typed
  client-side against the already-fetched `requests` list (case-insensitive match on `request_id`) -- a match
  immediately sets the real `requestId` and switches to "showing all" mode; no match shows a small inline "No
  QA Request found with this ID" hint rather than silently failing at submit.
- Switching the selected execution now always re-derives (and resets the manual text field) instead of only
  updating `requestId` when a link was found -- fixes a pre-existing bug where switching to an execution with
  no linked request left the *previous* execution's request selection stale in the field.
- New CSS (`index.css`): `.defect-request-picker`/`.defect-request-manual`/`.defect-request-manual-hint`,
  scoped to this one field wrapper so it doesn't affect any other `Field` elsewhere in the app.

**Not changed:** backend `create_defect` -- still just resolves whatever integer `qa_request_id` it's given;
no new endpoint, no schema/migration script.

**Verified:** `npx tsc --noEmit -p .` clean.

## 87. Simplified #86: dropped the "Other" option and manual free-text field, just auto-populate

Immediate follow-up feedback on #86, after seeing it live: "no need of textbox, just auto populate the
linked request id. nothing others, creating so much complexity otherwise."

**Before (#86):** picker pre-filtered to the linked request(s) but still rendered as an editable
`SearchableSelect` (with an appended "Other" option to escape to the full list) plus a separate manual
free-text input below it for typing a QA Request ID directly.

**Now:** when `CreateDefectModal` is opened from an execution (`!standalone`) and `findLinkedRequest()` finds
the QA Request tied to that execution's Test Cycle, the "QA Request ID" field renders as a plain read-only
`<input>` showing `request_id · application_name` -- same treatment as the existing read-only Application
field right next to it -- with `requestId` locked to that value. No dropdown, no "Other", no free-text box.
The `SearchableSelect` (full `requests` list) only reappears for the standalone "Open Defect" flow, or the
rare case where the selected execution's Test Cycle isn't linked to any child request at all (nothing to
auto-populate).

**Removed:** `OTHER_REQUEST` sentinel, `showAllRequests`/`manualRequestKey` state, the `requestOptions`
"Other" append, the manual-entry match/hint logic, and the `.defect-request-picker`/`.defect-request-manual`/
`.defect-request-manual-hint` CSS added in #86. `findLinkedRequests` (plural, `.filter()`) is now
`findLinkedRequest` (singular, `.find()`) since only ever the first match was used.

**Verified:** `npx tsc --noEmit -p .` clean.

## 88. Test Cycle "Unlink QA Request" now uses ConfirmModal/InfoModal instead of window.confirm

Reported directly: "Unlink request id in test cycle not working sometime, opening as javascript alert
window. show as proper alert window like other places have, and send confirmation message if succesful."

**Before:** `TestExecution.tsx`'s `unlinkCycleRequest()` (the "Unlink" button next to a Test Cycle's
"Linked <Functional/SAST/DAST/Performance>" sidebar chip) gated the whole action behind a raw browser
`window.confirm(...)` -- native `confirm`/`alert` popups are exactly the kind that some browsers suppress or
auto-dismiss under certain popup-blocking/embedding policies, which lines up with the "not working
sometime" report. There was also no success feedback of any kind afterward -- the link chip just silently
disappeared from the sidebar if it worked.

**Now:** the button (`onClick={() => setPendingUnlinkCycleRequest(true)}`) opens the same `ConfirmModal`
component used for every other confirmation on this page (e.g. `cycleToDelete` right above it) -- "Unlink QA
Request?" / "Unlink \<key\> from \<cycle\>? ... will remain unchanged." / Unlink · Cancel. `unlinkCycleRequest()`
itself now runs only from `onConfirm`, no longer reads `window.confirm`'s return value, and on success shows
an `InfoModal` ("Request unlinked" / "\<key\> has been unlinked from \<cycle\>.") -- new `InfoModal` import,
matching the existing "OK, got it" acknowledgement pattern used elsewhere (e.g. QA Sign-off Save Draft). On
failure the existing `ErrorText`/`setError(err)` path is unchanged.

New state: `pendingUnlinkCycleRequest` (boolean, drives the ConfirmModal), `unlinkedCycleRequestNotice`
(string | null, drives the InfoModal). No backend or schema changes -- `DELETE
/api/test-execution/cycles/{id}/request-link` itself was already working correctly; this was purely a
frontend confirmation/feedback UX fix.

**Verified:** `npx tsc --noEmit -p .` clean.

## 89. Defect "Assigned" remark was captured but never displayed anywhere + added a "currently assigned to" label

Reported directly: "whenever assigning defect to requester, system asking for remark, that remark not showing
any where in the ui. also add current assign lebel which show the name whom currently assigned."

**Root cause (remark):** the "Assigned" transition's Remarks field was already being saved correctly to
`models.Defect.assignment_remarks` (`defects.py`'s `transition` endpoint), and `DefectOut` already exposed
that column -- but the value was never actually used anywhere downstream. It wasn't folded into the audit
trail `details` text (unlike every other transition, e.g. Retest's `details = remarks or "Retesting
started."`), so it didn't show up in the existing Activity feed either. And `assignment_remarks` was flat-out
missing from the frontend's `DefectOut` interface (`types.ts`), so even a future UI read of it would've been
a silent `undefined`. Net effect: typed, saved, and then genuinely unreachable.

**Fixed in three places:**
1. `defects.py`'s Assigned branch: `details` now appends `" -- {remarks}"` when a remark was entered, so it
   surfaces immediately in the Activity feed (`GET /api/approvals?entity_type=DEFECT&entity_id=...`, already
   rendered by `JiraActivity` in `DefectDetail`) -- no schema or endpoint change needed for this half.
2. `types.ts`: added the missing `assignment_remarks?: string | null` to `DefectOut`.
3. `Defects.tsx`'s `DefectDetail`: Workflow Details section now includes an "Assignment" item (labelled with
   `assigned_by_name` when available) whenever `defect.assignment_remarks` is set -- same
   `MarkdownComment`/rich-text rendering as Resolution/Retest/Reopened/Deferred/Rejected already get.

**"Currently assigned to" label:** `TransitionModal`'s Assigned block (`target === 'Assigned'`) now opens with
`{defect.assignee_name && <p className="defect-assignment-current">Currently assigned to <strong>{defect.
assignee_name}</strong>{...department...}.</p>}`, above the Department/Assignee pickers -- so a lead
re-assigning or reopening-then-reassigning a defect can see who currently holds it before picking someone
new. Empty (nothing rendered) on a defect's first-ever assignment, since there's no current assignee yet. New
CSS `.defect-assignment-current` (amber, distinct from the existing teal `.defect-assignment-default`
"defaulted from..." hint, since this reflects actual current state rather than a suggested default).

**Also:** moved the Assigned transition's own dedicated Remarks field (previously falling through to the
generic `!['Resolved','Closed',...].includes(target)` catch-all at the bottom of the fieldset) up into the
Assigned block itself, directly under the auto-department hint -- same field, just now excluded from the
generic fallback (`'Assigned'` added to that exclusion list) so it isn't accidentally duplicated.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean; `npx tsc --noEmit -p .` clean.

## 90. Closing a defect opened from Test Execution's "Cycle Defects" panel now returns to that Test Cycle

Reported directly (with a screenshot): clicking a defect in Test Execution's "Cycle Defects" panel opens the
defect page, and closing it left the user stranded on the Defects register instead of back on the Test
Execution page/cycle they came from.

**Root cause:** `LinkedDefects.tsx` (the shared "linked defects" panel used by Test Execution's Cycle Defects,
Test Repository's per-testcase defects, and QA Request's linked defects) opens a defect via a full-page
navigation, `navigate('/defects?open=<key>')` -- not a same-page modal. `Defects.tsx`'s `DefectDetail`
`onClose` only ever did `setSelected(null); setSearchParams({})`, which clears the `open` param but stays on
the `/defects` route -- there was never any memory of which page the click originated from.

**Fix:** `LinkedDefects` gained an optional `returnTo?: string` prop; when supplied, it's carried through as
`&return=<encoded url>` on the navigation to `/defects?open=...`. `Defects.tsx`'s top-level component now
also calls `useNavigate()`, and `DefectDetail`'s `onClose` checks `searchParams.get('return')` first --
if present, `navigate(returnTo)` (back to the originating page); otherwise falls back to the original
clear-params-and-stay-on-register behavior (unchanged for row clicks within the Defects page itself, or
`open=` deep links from Global Search/notifications, which never set `return`).

**Wired up for:** `TestExecution.tsx`'s Cycle Defects panel only --
`returnTo={\`/test-execution?project=${projectId}&cycle=${selectedCycle.id}\`}`, matching the same
`?project=&cycle=` URL shape `DefectDetail`'s own trace-grid "Test Cycle" button already navigates to.
`LinkedDefects`'s other two call sites (`TestRepository.tsx`'s per-testcase panel, `QARequests/RequestDetail.
tsx`'s per-request panel) were left as-is -- same latent "doesn't return you" behavior remains there, since
`returnTo` is optional and off by default; worth the same treatment later if reported.

**Verified:** `npx tsc --noEmit -p .` clean.

## 91. Test Case modal's Save button no longer closes the modal

Reported directly: "On save button click of testcase closing the modal, it should not close the modal."

**Before:** `TestCaseModal`'s `submit()` (`TestRepository.tsx`) already called `onSaved(saved)` with the saved
`TestCaseOut`, but the call site (`onSaved={() => { refreshCases(); setEditingCase(null) }}`) discarded that
value and always closed the modal via `setEditingCase(null)` -- Save was the only action in this modal that
closed it; checkout, Submit for review, and every review decision all leave it open.

**Now:** `onSaved={(saved) => { refreshCases(); setEditingCase(saved) }}` -- the list refreshes in the
background, but the modal stays open against the now-saved record. This also fixes the mechanics for a
brand-new test case: `existing` (was `null` while `editingCase === 'new'`) becomes the real saved record, so
a second Save correctly PATCHes instead of re-POSTing a duplicate, the title switches from "New Test Case" to
`Test Case <key>`, and the version-history/activity `useEffect` (keyed on `existing`) now fires to load them.
Since there's no other visual cue that Save succeeded once the modal doesn't close, added a small "Saved"
label (`justSaved` state, self-clears after 2.5s, new `.tm-save-confirm` CSS) next to the Save button.

**Backend follow-on (`test_repository.py`'s `create_test_case`):** `_create_case_with_first_draft` (shared
with import/clone, which shouldn't auto-lock every case to whoever ran that bulk action) never sets
`checked_out_by_id`, so a brand-new case reads back as unreserved -- previously invisible, since the modal
always closed straight after create. With the modal now staying open, that would have forced the form
straight into "Read-only until reserved" the instant a new case was saved, right out from under the person
who just wrote it. Fixed by setting `obj.checked_out_by_id = current_user.id` in `create_test_case` itself
(single-case endpoint only, not the shared helper) -- a freshly created case is now auto-reserved to its own
author, same as if they'd clicked Start editing, so authoring can continue without an extra click.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean; `npx tsc --noEmit -p .` clean.

## 92. Reassignment Requirement -- Assign now has a Reassign counterpart everywhere, app-wide

Formal CR, quoted in full: everywhere the system offers an Assign option (Assign Tester, Assign Defect,
Assign QA Lead, Assign Analyst), it must also offer Reassign. Reassignment is permitted only to the current
assignee, the Department Head of the current assignee's department, or an Admin. During reassignment: only
eligible users are shown, a reason is mandatory, the new assignee is notified, the previous assignee loses
action permission, the record's existing status/history stays unchanged, and the audit trail captures
previous assignee, new assignee, reassigned by, date/time, and reason. Department Head mapping: COE - Quality
Assurance uses Chief Manager - QA / AGM - QA; every other department uses Chief Manager - Department / AGM -
Department (`Role.DEPARTMENT_HEAD_CM`/`Role.DEPARTMENT_HEAD_AGM`).

**Shared backend helper (`app/reassignment.py`, new file):** every module below calls into this instead of
duplicating eligibility/audit/notification logic -- directly serving the CR's own "must be implemented
consistently across all modules" line. `department_head_roles(department)` returns the CM/AGM role pair for
a department (QA gets `CHIEF_MANAGER_QA`/`AGM_QA`; everything else gets `DEPARTMENT_HEAD_CM`/
`DEPARTMENT_HEAD_AGM`). `require_can_reassign(current_user, current_assignee_id, department)` 403s unless
Admin, the current assignee, or a Department Head of that department (scoped to their own department, same
as every existing Department Head checkpoint). `require_reason(reason)` 400s on a blank reason. `record_
reassignment(...)` writes one `ApprovalAction` row (decision="Reassigned", `previous_state`/`new_state` as
plain label strings -- not `User` objects, so multi-assignee modules can pass comma-joined name lists).
`notify_new_assignee(...)` fires one notification to the new assignee via the existing `notifications.fire`.

**Rolled out to six flows, each following the same first-assignment-stays-broad /
reassignment-narrows-to-current-assignee-or-department-head-or-admin split:**

- **Functional tester** (`functional.py` `assign_tester`, multi-assignee) -- reassigning one of the
  currently-assigned testers now requires a mandatory reason and is gated to a current tester or QA
  Department Head (was: any Assigned QA Lead or current tester, no reason). `Functional.tsx` gained a
  conditional reason input, gated Save button, and narrowed `canAssignTester` once already assigned.
- **Performance tester** (`performance.py` `complete_planning`) -- identical pattern; `Performance.tsx` mirrors
  Functional.tsx exactly.
- **SAST/DAST Security Analyst** (`sast_dast.py` `_assign_security_analyst`) -- brand-new capability: this was
  previously single-shot, PLANNING-status-only, QA-Lead-Group-only. Now reassignable across every "live" scan
  status (`SAST_DAST_ANALYST_REASSIGNABLE_STATUSES`, PLANNING through SECURITY_COMPLETE), and the endpoint's
  own role gate widened to let the currently-assigned analyst self-handoff. `SAST.tsx`/`DAST.tsx` both gained
  the reason input + narrowed gate, button label toggling "Assign"/"Reassign Security Analyst".
- **Test Execution runner** (`test_execution.py` `assign_execution` + `bulk_assign_executions`) -- explicit
  unassignment while currently assigned is treated as a reassignment too (mandatory reason, same gate), closing
  a two-step bypass (unassign under the broad gate, then anyone reassigns fresh). Bulk assign splits rows into
  previously-assigned vs. fresh per request, checking eligibility per distinct previous owner. Frontend
  (`TestExecution.tsx`): the inline per-row picker and `RecordResultModal`'s runner control now hold the picked
  value and prompt for a reason before firing when the slot is already assigned (a small `ReassignRunnerModal`-
  style confirm for the row picker; an inline confirm block for `RecordResultModal`); the bulk-assign bar shows
  a reason input and relabels to "Reassign (n)" whenever any selected row already has a runner.
- **Test Cycle owner** (`test_execution.py` `update_cycle`) -- owner changes used to fold into the generic
  multi-field PATCH with no dedicated reason/eligibility/notification. Now: changing (or clearing) an
  already-set owner is detected against the pre-mutation snapshot, gated, reasoned, and separately audited/
  notified (`step_name="Owner Reassignment"`), on top of the existing generic "Cycle Details" change log.
  `CycleModal` (`TestExecution.tsx`) shows the Owner picker only to eligible users once one is already set
  (read-only otherwise), with a conditional mandatory-reason field.
- **Defect assignee** (`defects.py`, brand-new `POST /{id}/reassign` endpoint) -- previously there was no way
  at all to change a defect's assignee once assigned: `transition_defect`'s "Assigned" status is only
  reachable from New/Reopened/Deferred (`TRANSITIONS`), so a defect already In Progress/Resolved/Retest/
  Reopened/Deferred was stuck with its original assignee. New `DEFECT_REASSIGNABLE_STATUSES` constant
  (`Assigned`/`In Progress`/`Resolved`/`Retest`/`Reopened`/`Deferred`) and dedicated `DefectReassign` schema/
  endpoint change only the assignee (and optionally `assigned_team`), leaving status/history untouched exactly
  as required. Defects are the one flow where the current assignee's department isn't always QA (assigned_team
  can route to any active department), so this is also the first flow using the general Department Head
  mapping rather than hardcoding `CHIEF_MANAGER_QA`/`AGM_QA` -- added `departmentHeadRoles(department)` and
  `canReassign(user, currentAssigneeId, currentAssigneeDepartment)` to the frontend's `constants.ts` for this
  (widened the existing `RoleBearer` interface with optional `id`/`department`). `Defects.tsx`'s `DefectDetail`
  gained a "Reassign" action (new `ReassignDefectModal`) alongside the existing Assigned/status-transition
  buttons, visible only when eligible.

**Scope exclusions, decided with the user up front (not unilateral):** the vestigial `qa_lead_id`/
`security_lead_id`/`engineer_id`-style fields on Functional/SAST/DAST/Performance requests are never actually
set to a real person anywhere in the app (only ever reset to `None`) -- confirmed out of scope, left as-is.
Test Case reviewer/QA Lead individual reassignment (`PATCH /api/test-repository/test-cases/{id}/approvers`)
stays disabled -- it was deliberately replaced by automatic role-based group routing in the recent "Simplified
Test Management Review and Approval" refactor (section 91 and earlier), and reversing that now would undo a
recent, intentional decision; confirmed to leave it disabled.

**Known, deliberate behavior narrowing (flagging since it's a real change, not just additive):** applying the
CR's literal eligibility list (current assignee / Department Head / Admin) to Functional, Performance, and
SAST/DAST reassignment is strictly narrower than what a plain `QA_LEAD` could do before in those three flows.
Previously any Assigned QA Lead could reassign a tester or security analyst; now, once the first assignment
has happened, a plain `QA_LEAD` (as opposed to `CHIEF_MANAGER_QA`/`AGM_QA`) can no longer do so, since
`QA_LEAD` itself is not a "Department Head" per the CR's own clarification table. First assignment is
unaffected -- a QA Lead can still make the initial assignment in every one of these flows exactly as before.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean; `npx tsc --noEmit -p .` clean, across
every phase of this rollout.

## 93. Reassignment Requirement follow-up -- QA_LEAD restored, Test Execution runner reassignment widened to any QA user

Two corrections reported directly right after section 92 shipped, both about the same narrowing flagged in
that section's own "Known, deliberate behavior narrowing" note.

**QA_LEAD restored across Functional/Performance/SAST-DAST reassignment:** "add QA_LEAD as well, QA_LEAD also
required." `_require_can_reassign_tester` (`functional.py`), `_require_can_reassign_performance_tester`
(`performance.py`), and `_require_can_reassign_security_analyst` (`sast_dast.py`) each gained a
`user.has_role(Role.QA_LEAD)` bypass alongside the existing Admin/current-assignee/QA-Department-Head checks
-- restoring parity with each flow's own first-assignment gate (`_require_assigned_qa_lead_or_current_tester`
/ `_require_assigned_qa_lead_or_current_performance_tester` / `_require_assigned_qa_lead`), all of which
already treat plain `QA_LEAD` as sufficient. `Functional.tsx`/`Performance.tsx`/`SAST.tsx`/`DAST.tsx`'s own
`canReassign*` variables each gained the matching `|| hasRole(user, 'QA_LEAD')`.

**Test Execution runner reassignment widened further, to any QA user:** "for test execution reassignment of
testcase can be perform by any QA user, otherwise it will be hectic for qa lead." Rather than adding QA_LEAD
as one more exception (as above), this flow drops the CR's narrow eligibility list entirely and reuses the
SAME broad gate as first assignment (`_require_qa_assignment_manager` -- any QA_ENGINEER/QA_LEAD/
CHIEF_MANAGER_QA member of COE - Quality Assurance, or Admin) for both `assign_execution` and
`bulk_assign_executions`; only the mandatory reason (once a runner is already assigned) still distinguishes
reassignment from first assignment. `TestExecution.tsx`'s `canReassignExecution` now simply returns
`canManageRunners` regardless of the execution passed in (kept as a function since every call site already
expects one); the bulk-assign bar's now-always-true eligibility check and its associated tooltip were removed
as dead weight rather than left silently unreachable. This matches wording that was already sitting in
`RecordResultModal`'s own read-only banner ("Any COE - Quality Assurance QA Engineer or QA Lead can reassign
the testcase when needed") -- section 92's narrowing had drifted away from that existing, correct copy without
noticing.

**Deliberately NOT widened:** Test Cycle owner reassignment and Defect assignee reassignment keep the CR's
literal eligibility list (current assignee / Department Head / Admin, no QA_LEAD carve-out) -- neither report
mentioned them, and QA_LEAD isn't a natural fit for either: a Test Cycle owner can be any active user org-wide
(not QA-role-scoped), and a Defect's assignee can be routed to any active department, not just QA.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` clean; `npx tsc --noEmit -p .` clean.

## 94. Test Execution runner reassignment reason had no visible log anywhere

Reported directly, right after section 93's "any QA user" widening: "there are not logging, it should be
required right?" -- the mandatory reason itself was never actually at risk (confirmed both frontend and
backend still require and store it: `TestExecutionAssign`/`TestExecutionBulkAssign`'s `reason` field,
`reassignment.require_reason` in `assign_execution`/`bulk_assign_executions`, both still called unconditionally
whenever `is_reassignment`/`previously_assigned`). The actual gap was visibility -- `reassignment.
record_reassignment` was writing the reason into `ApprovalAction` with `entity_type="TEST_CASE"` all along, but
nothing in the Test Execution module ever displayed it: `RecordResultModal` only shows `AttemptHistory` (run
results, not assignment history), and the page's own "Test Cycle Activity & Audit History" panel deliberately
filters to `entity_type="TEST_CYCLE"` only (comments, details, request links, lifecycle -- not per-testcase
events). The only place this audit trail was ever reachable was Test Repository's own test case activity tab,
which isn't where someone reassigning a runner from Test Execution would think to look.

**Fix (`TestExecution.tsx`'s `RecordResultModal`, frontend only -- no backend change needed, the data already
existed):** added a `reassignmentHistory` state, fetched via the same `GET /api/approvals?entity_type=TEST_CASE
&entity_id=...` endpoint Test Repository already uses (open to any authenticated user, no extra role gate),
filtered to `decision === 'Reassigned'`, and re-fetched immediately after a successful reassignment (`assign()`
now calls `loadReassignmentHistory()` whenever a `reason` was sent). Rendered as a new "Reassignment history"
section directly under the runner panel -- previous → new assignee, actor, timestamp, and the reason itself --
same visibility principle as an earlier defect assignment-remarks fix (a value was being captured correctly
but never shown anywhere in the UI). New `.tm-reassignment-history` CSS, styled after `.defect-workflow-item`.

**Verified:** `npx tsc --noEmit -p .` clean; `python3 -m py_compile app/*.py app/routers/*.py` clean (unchanged,
included for completeness since no backend file was touched in this section).
