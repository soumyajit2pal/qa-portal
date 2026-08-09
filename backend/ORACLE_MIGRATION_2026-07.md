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
