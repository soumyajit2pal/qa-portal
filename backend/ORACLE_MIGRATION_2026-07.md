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
