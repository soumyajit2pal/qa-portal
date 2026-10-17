# QualityOps — Enterprise Quality Operations Platform

A full-stack quality operations platform built from the **"Centralized QA Portal Creation"** change request
(Bank of Maharashtra, Information Technology Department, FY 2026-27).

- **Frontend:** a single React 19 + Vite SPA (one build, one deploy). Internally organized by
  domain area — Functional, Security, Specialised Testing, Governance — as plain folders under
  `src/modules/`, code-split via `React.lazy()` so each area only downloads its own JS when
  visited, without the operational overhead of separately deployed micro-frontends (see
  [Frontend architecture](#frontend-architecture) for why this project tried, then backed away
  from, a Module Federation split).
- **Backend:** FastAPI + SQLAlchemy (used purely as the Oracle query/ORM layer, not for
  database portability), revocable session authentication, and role/workspace authorization. The core workflow API
  and the high-volume Document Portal API run as separate deployable services.
- **Database:** Oracle only. The app reads `DATABASE_URL` and refuses to start without an
  Oracle connection string — there is no SQLite or other fallback (see
  [Database setup](#database-setup)).

## Module coverage

Reflects the routers actually registered in `backend/app/main.py` and the frontend package
that renders each one.

| Backend router | Frontend area | What it covers |
|---|---|---|
| `auth.py` | `src/Login.tsx` | Encrypted login, revocable cookie sessions, `/auth/me`, user directory, Admin CRUD |
| `qa_requests.py` | `src/QARequests/` | The cross-module request gateway/inbox — raise a request, pick its type, route it |
| `functional.py` | **Functional** (`src/modules/functional/`) | Functional QA request lifecycle: SM/dept-head decisions, readiness checklist, planning → test design → execution → defects → retest → regression → clearance, documents, history |
| `sast_dast.py` | **Security** (`src/modules/security/`) | SAST and DAST request lifecycle: readiness, scan configuration/execution, findings, documents, history |
| `suppression.py` | **Security** (`src/modules/security/`) | False-positive/suppression requests: app-owner and dept-head decisions, security-team decision, documents, history |
| `performance.py` | **Specialised Testing** (`src/modules/specialised-testing/`) | Performance testing lifecycle: readiness, baseline, load test, result analysis, defect fix/retest, report, clearance |
| `approvals.py` | **Governance** (`src/modules/governance/`) | Cross-module workflow-decision feed (`/approvals`, `/approvals/pending-mine`) |
| `audit.py` | **Governance** (`src/modules/governance/AuditLog.tsx`) | Immutable authentication, API-access, data-change and access-management audit trail |
| `signoff.py` | **Governance** (`src/modules/governance/`) | Formal QA Clearance issuance, history, documents |
| `signatures.py` | **Governance** (`src/modules/governance/SignatureVerification.tsx`) | Signature evidence and uploaded PDF integrity verification, with approval visibility checks |
| `dashboard.py` | `src/Dashboard.tsx` | Project-wise, QA-wise, security, suppression, and 3W ("what's pending, where, since when") dashboards |
| `reports.py` | **Governance** (`src/modules/governance/Reports.tsx`) | Operational/security/management report data (QA summary, SAST/DAST scan, vulnerability trend, severity distribution, suppression register, monthly KPI, quality scorecard, audit evidence) |
| `export.py` | **Governance** (`src/modules/governance/Reports.tsx`) | Excel/PDF/CSV export of the above, with RBAC |
| `departments.py` | Used across request forms + Admin | Department master data |
| `applications.py` | Admin + request forms | Governed application-name master data and owner decisions |
| `qa_workspaces.py` | Workspace selector + Admin | Workspace hierarchy, membership, sharing and policy administration |
| `test_projects.py` | **Test Management** | Test-project lifecycle and workspace sharing |
| `test_repository.py` | **Test Management** | Folder/repository hierarchy, testcase versions, approvals, imports and exports |
| `test_execution.py` | **Test Management** | Cycles, assignment, execution results and evidence |
| `test_reports.py` | **Test Management** | Test-management analytics and exports |
| `defects.py` | **Test Management** | Defect lifecycle, assignment, evidence and execution traceability |
| `pending_approvals.py` | Header/approval notices | Role- and workspace-scoped pending-action feed |
| `checklist_config.py`, `request_type_config.py` | Admin + request forms | Governed checklist and request-type configuration |
| `jobs.py` | Imports/exports | Background-job status and generated artifact retrieval |

Write endpoints combine role checks with target-record workspace/department ownership checks, and
workflow state changes are written to the `approval_actions` history table. Security and operational
activity is captured separately in `qap_audit_logs`. Browser authentication uses revocable,
HttpOnly server sessions with CSRF protection; real LDAP bind support is implemented (see
[Authentication & the Admin section](#authentication--the-admin-section)), not just a stub.

## Frontend architecture

The frontend is a **single React + Vite app** at `frontend/`:

```
frontend/
  package.json
  vite.config.ts
  src/
    api.ts, types.ts, constants.ts, index.css   # shared plumbing
    context/AuthContext.tsx
    components/                                  # shared UI: Table (incl. the filter
                                                   # popover), SearchableSelect,
                                                   # UserAssignSelect, RequestDocuments,
                                                   # Icons, Layout, ModuleBoundary
    Login.tsx, Dashboard.tsx, QARequests/          # cross-cutting pages (not owned by
                                                   # one domain area)
    modules/
      functional/       Functional.tsx
      security/          SAST.tsx, DAST.tsx, Suppression.tsx
      specialised-testing/ Performance.tsx
      governance/           SignOff.tsx, Approvals.tsx, Reports.tsx, Admin.tsx
```

`src/App.tsx` loads each `modules/<area>/*` page with `React.lazy()` + `<Suspense>` — a normal
Vite code-splitting boundary, not a network fetch to another deployed app. This still gives a
real, measurable benefit (visiting `/sast` never downloads the Governance or Performance bundle),
and keeps the codebase organized by domain area exactly like before, but it's all one build:
one `npm install`, one `npm run dev`, one `npm run build`, one Docker image, one deploy.

**This project previously used true Module Federation** — 4 domain areas as separately built,
separately deployed apps (own `package.json`/`Dockerfile`/image each), wired together at
runtime via `@originjs/vite-plugin-federation`. That was reverted back to this single app
after running into real friction in practice:

- `@originjs/vite-plugin-federation` only serves a working `remoteEntry.js` from a *production
  build* (`vite build` + `vite preview`/nginx) — its remotes never worked against `vite dev`,
  which made local development confusing (a blank screen with no obvious cause the moment you
  ran the "wrong" command for a module).
- Remote URLs were resolved at the shell's *build* time, not runtime, so pointing the shell at
  a module that moved host/port required rebuilding and redeploying the shell too — undercutting
  some of the independence the split was meant to buy.
- 5 separate images, 5 separate `nginx.conf`s (with cross-origin CORS headers), and
  cross-app React/React-DOM version-pinning discipline added real operational overhead that
  wasn't worth it at this project's current size/team structure.

If independent per-area deployability becomes a real requirement again (e.g. genuinely separate
teams shipping on separate schedules), Module Federation or a similar approach is still the
right tool — it's just more machinery than this project currently needs.

## Repository layout

```
qualityops/
  backend/
    app/
      main.py              # FastAPI app, router registration
      models.py            # SQLAlchemy models targeting Oracle
      schemas.py           # Pydantic request/response schemas
      auth.py, deps.py     # session auth + scoped authorization dependencies
      constants.py         # Roles, statuses, dropdown options (mirrors the CR doc)
      documents.py         # Shared multi-file upload/list/download helper (all modules)
      seed.py               # Demo data loader
      routers/               # One router per module (see coverage table above)
      uploads/                # Uploaded documents land here at runtime (gitignored)
    requirements.txt
    Dockerfile
  frontend/
    package.json
    vite.config.ts
    Dockerfile, nginx.conf       # production SPA + same-origin TLS reverse proxy
    src/                    # see Frontend architecture above
  docker-compose.yml         # core API, isolated Document Portal API, frontend and Redis
  .env.dev.example, .env.uat.example, .env.prod.example
  README.md
```

## Database setup

This application connects to **Oracle only** — `app/database.py` reads `DATABASE_URL` at
startup and raises an error immediately if it is missing or not an `oracle+oracledb://` URL.
The SQLAlchemy models use portable column types, so no Oracle-specific SQL was needed, but
no other database backend is supported or tested.

### Option A — point at your bank's Oracle instance

Set the Oracle listener hostname, port, and service name in `DATABASE_URL`:

```bash
export DATABASE_URL="oracle+oracledb://QA_PORTAL:your_password@oracle.example.com:1521/?service_name=ORCLPDB1"
```

The `QA_PORTAL` user needs `CREATE TABLE`/`CREATE SEQUENCE` privileges the first time you run
`alembic upgrade head`. Existing environments that predate Alembic must review and adopt the
appropriate baseline before applying migrations.

All tables are prefixed `qap_` (e.g. `qap_users`, `qap_requests`, `qap_module_documents`) so
this app's schema won't collide with any other application's tables (like a generic `users`
table) that may already exist in a shared Oracle instance/schema.

### Option B — local Oracle for development (Docker)

If you don't have an Oracle instance handy, run Oracle Database Free locally:

```bash
docker run -d --name oracle-free \
  -p 1521:1521 \
  -e ORACLE_PWD=YourStrongPassw0rd \
  gvenzl/oracle-free:23-slim

# wait ~1-2 minutes for "DATABASE IS READY TO USE" in `docker logs -f oracle-free`,
# then create the app's schema/user:
docker exec -it oracle-free sqlplus sys/YourStrongPassw0rd@//localhost:1521/FREEPDB1 as sysdba <<'SQL'
CREATE USER qa_portal IDENTIFIED BY qa_portal_pwd;
GRANT CONNECT, RESOURCE, CREATE VIEW, UNLIMITED TABLESPACE TO qa_portal;
SQL
```

Then set `DATABASE_URL=oracle+oracledb://qa_portal:qa_portal_pwd@localhost:1521/?service_name=FREEPDB1`
in your local profile. This Oracle container is deliberately
**not** part of `docker-compose.yml` — it's a one-time local dev prerequisite, not something to
tear down/recreate alongside the app services.

## SAST repository workflow

One SAST request retains all repositories selected in its QA Request. In **Findings**,
the repository progress table shows each repository's code reference and state, including
repositories that have not been scanned. Initial Fortify result retrieval can select one
or more repositories at a time. The assigned Security Analyst validates the retrieved
results for selected repositories; zero findings become Clear and nonzero findings remain
Waiting for fix. Retrieving a partial batch never marks the other repositories clear.

The requester or active delegate can select only repositories whose fixes are ready and
submit their latest commit/hash. Those repositories enter Ready for rescan; other fixes
remain pending. The assigned Security Analyst can retrieve and validate selected ready
rescans while the requester continues work on other repositories. Every import and fix
submission retains a repository-specific history. Unchanged clear results are retained;
a changed repository URL, branch or commit makes the previous result stale.

Retrieval imports existing, processed Fortify SSC results; it does not launch the scanner.
The analyst must select the completed SSC application/version corresponding to the displayed
repository and code reference. Final completion, reports and QA Clearance require validated,
current, clear results for every repository in scope. A pending suppression approval still
blocks fix submission for the request because existing suppressions are linked to requests,
not individual repositories.

## Reconsidering rejected application names

On a Draft QA request with a rejected application name, select **Resubmit application
name for approval** and provide a reason describing the discussion outcome and BCP
policy compliance. The request returns to Submitted for a fresh Application Owner
decision within its workspace, regardless of department. The submitter cannot decide
their own proposal, including when they also hold Administrator and Application Owner
roles. Required readiness checks and evidence still apply.

The existing request ID, staged details, documents, and prior decisions are retained.
Approval creates linked requests only for submitted gateways; older Draft, Cancelled,
or previously rejected linked requests are not automatically restarted. Saving a draft
or entering the same rejected name on another request does not reopen the rejection.
Every reconsideration reason and subsequent decision remains in Activity.
Admin manual entry and workbook seeding leave reconsideration rounds pending; the
fresh decision must be made through the Application Owner action on the QA request.

Users who also hold Administrator and Requester roles can reconsider a global name
previously proposed in another department through their own eligible Draft request.
Other department and workspace restrictions remain enforced. When email is enabled,
resubmission notifies eligible Application Owners and rejection notifies the requester
to choose an existing name or request reconsideration. Cancelling an older draft sharing
the name does not send an approval task for that cancelled request.

Before starting the updated backend, apply migration `f4a1c9d8e730` through the existing
deployment's `alembic upgrade head` procedure, then deploy backend and frontend together.
The migration adds a nullable application-name reference, foreign key, and index to the
approval history. Existing history is not rewritten, and interrupted upgrades can be
retried. Rollback retains the history references.

## Moving test cases between projects

The Test Repository supports **Move to another project…** from an individual
testcase's More actions and from the selected-testcase toolbar. Select an active,
writable project in the same workspace, choose a destination folder or Unfiled,
and provide a reason. Review shows eligible cases and per-case blocking reasons;
users may explicitly select only eligible cases and review that reduced selection.
Confirmation validates the complete selection again and moves it in one transaction.

Only Draft cases that have never entered review and have no test-cycle, execution,
or defect links can move. QA authors can move their own cases; QA Lead Group and
Administrators with an eligible QA workflow role can move other authors' cases
within their existing workspace and department permissions. Another user's checkout,
inactive projects, foreign workspace content/folders, and duplicate definitions
(including destination Recycle Bin entries and duplicates within the selection)
block the move. Each operation accepts up to 500 cases. Reviewed or historical
cases should use Clone to create a new Draft in the destination project.

Moves preserve testcase IDs, definitions, versions, tags, creators, attachments,
and prior Activity, and append an Activity record with source, destination, actor,
timestamp and reason. Excel import prominently displays its destination project
key/name and folder throughout the upload. Deploy backend and frontend together;
this change uses existing schema and requires no new database migration.

## QA request module names

The Application & Change Details step includes an optional searchable Module Name
dropdown beside Application Name. Select a saved module or choose **Other (new
module)** and enter a name. New names are saved when the QA request is saved as a
Draft, with no module approval workflow. Modules are shared only within the same
application and workspace; capitalization and extra whitespace do not create
duplicates. Changing Application Name clears the selected module. Leave it blank
for a request covering the whole application. Saved modules appear on the QA
request list, detail view, and request PDF; the list search also matches modules.
Application Name approval continues to apply independently. Module Name is also
inherited by linked Functional, SAST, DAST, and Performance requests and by their
suppression requests. It appears in their detail/edit screens, registers, PDF
exports, and report/spreadsheet exports when provided on the parent QA request.

The clearance certificate form displays the source module as a locked field.
Evidence capture freezes Module Name in the certificate snapshot; certificate
views, revisions, registers, and PDF exports use that captured value. Existing
reviewed snapshots without module metadata are not rewritten. Refresh an editable
certificate's evidence and complete its normal approvals to include the module.
This propagation uses existing parent links and certificate snapshot JSON, so it
does not require another database migration.

Apply migration `d7c2a9e4b610` with the existing `alembic upgrade head` deployment
procedure before starting the updated backend, then deploy backend and frontend
together. Existing requests retain a blank module name.

## DAST target workflow

DAST follows the same independent workflow for each application URL. The
**Findings** target progress table includes unscanned URLs and their current
scan, validation, remediation, and rescan states. QA can retrieve and validate
a selected batch while the requester or active developer delegate fixes other
URLs. Fix submissions select only ready targets and record the latest deployed
commit or artifact hash; unfinished fixes remain assigned to the requester or
delegate. QA can rescan the ready targets without waiting for those other fixes.

Every URL requires its own current, validated clear result before the request
can complete or support QA Clearance. Changes to a target's URL, environment,
authentication settings, credentials, or recorded code hash invalidate older
evidence. Older scans without an attributable target snapshot require fresh
retrieval and validation. Existing request-level suppression approvals still
block fix submission while pending; they do not block QA from retrieving other
eligible targets. Apply migration `9d4e6f8a2b13` with `alembic upgrade head` and
deploy backend and frontend together.

Bug Fix QA requests can capture an optional **Defect Number (Raised By Business)**
alongside the previous completed request reference. It accepts up to 64 characters,
is retained when drafts are reopened, and is cleared when the change type is no
longer Bug Fix. Apply migration `e3b8c5d1a902` with `alembic upgrade head` before
starting the updated backend; it adds a nullable `business_defect_number` column
to `qap_requests` and leaves existing requests unchanged.

Returned Functional Requests use the same business defect field as QA request
creation. Selecting Bug Fix in Edit Details reveals the optional field immediately;
saving stores it on the linked QA request, and reopening or resubmitting retains
the number. Changing to New or Enhancement clears it. The Functional update API
enforces the same 64-character limit and normalization as intake, with the existing
requester/reviewer permissions and return stages unchanged. This correction needs
matching frontend/backend deployment and no additional migration. Regression
evidence: `validation/returned-bug-fix-2026-10-15/report.json`.

If Oracle reports `ORA-00904` for `BUSINESS_DEFECT_NUMBER`, the updated model
is running against a schema that has not received this column. This can affect
request lists and linked modules even for non-Bug-Fix records, because their
queries load the parent QA request. Apply `alembic upgrade head` using the same
environment file and database schema as the API, then restart the workers.
Verify the deployed schema before opening traffic:

```sql
SELECT column_name, data_type, char_length, nullable
FROM user_tab_columns
WHERE table_name = 'QAP_REQUESTS'
  AND column_name = 'BUSINESS_DEFECT_NUMBER';
-- Expected: one row, VARCHAR2, 64 characters, nullable Y.
```

Apply migration `7b8c2d4e6f10` through the existing deployment's `alembic upgrade head`
procedure before starting the updated backend, then rebuild/restart both services. The
migration adds durable repository queue, validation and fix-submitter references. Older
scans without a recorded code identity and validation are shown as stale; retrieve and
validate current results before using them for new clearance. If an older repository is
missing its branch or commit, the assigned analyst can capture those missing references
from the completed scan during retrieval; existing nonempty references cannot be overwritten
through that dialog. Existing issued certificate
snapshots remain frozen. For an older completed SAST request with missing or stale repository
evidence, the assigned analyst can reverify selected repositories; a successful retrieval
reopens the request for validation and records the reason in its history. Already-clear
completed repositories and rejected approval stages cannot be reopened this way.
Rollback retains the new evidence columns.

## Signature verification

Open **Governance → Verify Signature**, use the top-bar shortcut, or follow **Verify this
signature** from QA Clearance. Enter an `ESIG-...` ID to check the recorded signer,
decision, timestamp and approval evidence. Upload the original portal PDF (up to 20 MB)
to also check every byte against the exported document. Results distinguish integrity
from approvals that have since been replaced, reset or placed under review. Dates use IST.
Verification requires login and the same workspace/department access as the approval log;
uploaded files are not retained.

New approval signatures receive a server-generated HMAC-SHA256 seal on insertion. New
request-detail PDFs containing signatures carry a keyed proof of their exact exported
bytes and the referenced approval seals. Older approval records are never sealed
retroactively: their integrity is shown as unconfirmed. A PDF without a proof is also
unconfirmed. These are portal integrity checks; PDF viewers do not treat them as PKI signatures.

Before starting the updated backend, apply migration `6f2a9c8d1b40` using the existing
deployment's `alembic upgrade head` procedure, then rebuild/restart backend and frontend.
The migration adds three nullable approval-evidence columns and a unique signature-ID
constraint. It preserves existing records; rollback also preserves those evidence columns.
The signature and SAST repository migrations check for existing columns and constraints,
so retrying an interrupted Oracle upgrade or upgrading again after an evidence-preserving
rollback does not recreate existing objects. Offline Oracle scripts include the same checks.
Optionally set `SIGNATURE_INTEGRITY_KEY` to a dedicated secret of at least 32 characters
in the deployment secret store **before issuing protected signatures**. Keep it stable,
back it up, and use the same value in every backend worker. If omitted, the seal key is
derived from `SECRET_KEY`. Changing the effective key makes earlier signatures/PDFs
unverifiable, so retain the original key when rotating unrelated authentication secrets.

## Application name approval

When System Admins enable new application creation, names proposed through **Other (new application)** in a QA Request
are decided by any user with the **Application Owner** role and operational access
to that request's workspace, regardless of department. The pending list, approval
count, approver directory, and notification routing use this same scope. Drafts
and cancelled requests remain private, and a proposer cannot approve their own
name. Approval creates the linked requests for their usual SM workflow. Deploy
the backend and rebuilt frontend together; no database migration is required.

## Global search suggestions

Global search shows up to 10 matching records after typing two characters, with a
short debounce. Matches include request/application names, record IDs, CR/EPIC/IN
references, defects, projects, test cases and cycles. Exact IDs and change references
rank first. Click a suggestion or use Arrow Up/Down and Enter to open that record.
Enter without a selected suggestion retains the existing search behavior, including
exact change-reference matching. Escape closes Spotlight.

Suggestions use the active workspace and existing record access rules, including
private drafts, delegates, invited suppression reviewers and restricted cycle
folders. Input changes and closing the dialog cancel superseded lookups. The new
`GET /api/search/suggestions` endpoint requires no database migration; deploy the
backend together with the updated frontend.

## Activity mentions

Type `@` in the shared Activity comment editor and search by name or username.
Choose a user with the mouse or Arrow Up/Down and Enter; Escape closes the picker.
Posting a comment containing `@username` queues an email with the comment and the
existing direct link to that record. SMTP must be enabled and configured as below.
The picker returns up to 20 eligible users; type more of a name to narrow the search.

Recipients must be active, have completed account/email setup, have a notification
email, and already have access to the record. Mentions do not grant access. The
server checks access again when posting, including workspace boundaries, private
drafts, active delegates and invited suppression reviewers. Repeated tags or users
sharing a mailbox create one email per posted comment; the author is excluded.
Email addresses, URLs and code examples do not count as mentions. Ordinary tags use
usernames containing letters, digits, dots, underscores or hyphens (up to 64 characters).
For email-style or domain-qualified directory usernames, the picker inserts the
explicit `@[username]` form, which also supports these identities without treating
a pasted email address as a tag.

The comment, attachments and mention emails share one database transaction. A failed
save does not create mail; ordinary workflow emails are not triggered by a comment.
Existing comments are not reprocessed, and this feature requires no new migration.

## Activity attachments

The shared Activity composer accepts multiple files through **Attach files** or drag and
drop. Supported extensions are PNG, JPG/JPEG, GIF, WebP, PDF, DOC/DOCX, XLS/XLSX, CSV,
TXT and LOG. Each comment can contain up to eight files in total, including inline
screenshots, with a 10 MB limit per file. Files can be posted with or without comment
text and removed from the draft before posting.
File posts use a bounded ten-minute upload deadline; text-only comments keep the normal
request deadline. Failed posts retain the draft so the result can be checked before retrying.

Pasted screenshots keep their inline position. Other attachments appear as file cards
with filename, type and size; PDFs can be previewed in a new browser tab and all files
can be downloaded. Documents load on demand through authenticated endpoints rather
than being downloaded with the whole activity feed. Comment text and attachments save
together, retain their uploader and timestamps, and remain immutable after posting.
Existing record and workspace access rules apply. Discussion attachments do not replace
mandatory checklist or workflow evidence.

This change reuses the existing document table and comment attachment storage, including
older image attachments. No database migration is required; rebuild/redeploy backend
and frontend together.

## Quickstart (local dev, no Docker)

Requires Python 3.14.x, Node 26.x, and a reachable Oracle database (see above).

### 1. Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp ../.env.dev.example ../.env.dev
# Edit ../.env.dev: DATABASE_URL and SECRET_KEY are required placeholders.
export APP_ENV_FILE=.env.dev    # resolved relative to the repository root

alembic upgrade head             # creates or upgrades the schema
DEMO_SEED_PASSWORD='<unique temporary password>' python -m app.seed
                                 # seeds demo users, departments, and Default Workspace
# Continue using `alembic upgrade head` before every deployment.
uvicorn app.main:app --reload --port 8000
```

The API is now at `http://localhost:8000`, with interactive docs at
`http://localhost:8000/docs`.

### Configuration profiles

`APP_ENV_FILE` is the explicit configuration-file selector for both Compose
and direct Python runs. Configuration precedence is: process environment,
the selected `APP_ENV_FILE`, then typed application defaults. Relative file
paths resolve from the repository root. When Compose is used, it reads the
host file, injects its values, and mounts the same file read-only at
`/run/config/qualityops.env` in each Python container. `APP_ENV` still
identifies the runtime profile and may contain letters, numbers, underscores,
and hyphens.

For backward compatibility only, when `APP_ENV_FILE` is unset the backend
retains legacy implicit discovery of `backend/.env.<APP_ENV>`, repository-root
`.env.<APP_ENV>`, and `backend/.env`. New deployments should always set
`APP_ENV_FILE` so no implicit `.env` file can compete with the intended source.

```bash
cd backend
cp ../.env.uat.example ../.env.uat
# Populate required database, secret, hostname, certificate and key settings.
# One-time direct-host key provisioning (the generator refuses to overwrite):
python -m app.generate_login_key login-private.pem
APP_ENV_FILE=.env.uat uvicorn app.main:app --port 8000 --proxy-headers --forwarded-allow-ips=127.0.0.1
APP_ENV_FILE=.env.uat alembic upgrade head
```

UAT application traffic requires HTTPS. The Uvicorn command above is a private
upstream for a trusted loopback TLS proxy, not a browser URL. For local Vite UAT,
set `TLS_CERT_HOST_PATH` in the selected environment file to the directory containing
`qualityops.crt` and `qualityops.key`, and run `npm run dev -- --mode uat` from
frontend. Relative certificate directories resolve from the repository root,
matching Compose. Vite builds do not require certificate files. Open `https://localhost:5173`
using a certificate that includes localhost. Vite derives forwarded scheme from
the actual TLS socket.

Audit records store the client address visible at the trusted HTTPS edge. A
browser opened at `https://localhost:5173` is genuinely connected over loopback,
so its Client IP is `127.0.0.1` (or `::1`). To verify a workstation/LAN address,
open Vite through a certificate-covered hostname or LAN IP from that client,
for example `https://<uat-host-ip>:5173`. In production, use the real portal DNS
name. NAT and VPN gateways may make their egress address the network-visible
client IP; the application must not accept a browser-supplied replacement.

The active profile is included as `profile` in `/api/health` without exposing
any configuration values or secrets.

### Logging modes

Backend logging is controlled by the active environment profile:

Portal screens, PDF/Excel/CSV exports, and application/Uvicorn logs use IST
(Asia/Kolkata), regardless of the browser or server timezone. Log timestamps
include the `IST` label. API timestamps use the equivalent `+05:30` offset.
Containers also use `TZ=Asia/Kolkata`, including nginx. Rebuild the images and
restart the services to apply these settings; existing log lines retain their
original timestamps.

```dotenv
DEEP_LOGGING=false
LOG_DIR=logs
LOG_FILE_NAME=app.log
LOG_MAX_BYTES=10485760
LOG_BACKUP_COUNT=5
SLOW_REQUEST_MS=2000
```

`DEEP_LOGGING=false` is the normal production mode. It records startup,
access, audit-related operational events, slow requests, warnings, errors and
full unhandled-exception tracebacks. `DEEP_LOGGING=true` temporarily adds
DEBUG application events, request start/completion timings, SQL text with all
bind values hidden, and SQLAlchemy connection-pool activity. Request bodies,
authorization headers, cookies and SQL parameter values are never included.

Restart every API worker after changing the flag. Deep mode creates much more
I/O and should be disabled again after the diagnostic window:

```bash
sudo systemctl restart qualityops-backend
tail -f backend/logs/app.log
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The Vite dev server proxies `/api/*` to `http://localhost:8000`
(see `vite.config.ts` → `server.proxy`), so no CORS configuration is needed locally. Every
domain area (Functional, Security, Specialised Testing, Governance) is part of this same dev
server — no separate processes to start.

### Troubleshooting: blank module screen

A blank white page after navigating to a module (instead of a normal error) means a lazy-loaded
chunk failed to load — as of this version that's caught and shown as an in-app message (see
`src/components/ModuleBoundary.tsx`) rather than a silent blank screen. If you're still seeing a
truly blank page with nothing in it, you're likely on a build from before that fix. The most
common real-world cause is a stale tab: the app was redeployed while the tab was open, and the
browser is holding a reference to a chunk file that no longer exists on the server — a hard
reload fixes it. Otherwise, check the browser console/Network tab for the specific failed
request.

### Demo accounts

Seeded by `DEMO_SEED_PASSWORD='<unique temporary password>' python -m app.seed`. The seed refuses to run without an explicit password of at least 12 characters:

| Username | Role |
|---|---|
| `requester1` | Requester |
| `ba1` | Business Analyst |
| `qa1` | QA Engineer |
| `qalead1` | QA Lead (CM-QA) |
| `pm1` | Project Manager (AGM-QA) |
| `security1` | Security Analyst |
| `appowner1` | Application Owner |
| `depthead1` | Department Head (Scale IV+) |
| `admin` | Administrator |

Try logging in as `requester1` to raise a QA request, then `qalead1` to approve it, allocate
`qa1`, and walk it through the readiness checklist and test execution.

## Deployment

### Building each image

Two images, backend and frontend, each with a standalone `Dockerfile`:

```bash
docker build -f backend/Dockerfile -t qualityops-backend backend
docker build -f frontend/Dockerfile -t qualityops-frontend frontend
```

The frontend image copies `frontend/nginx.conf`. Nginx serves the SPA over TLS, terminates that
TLS connection, sends
`/api/document-portal/*` to the isolated `document_portal` service, and sends the remaining
`/api/*` traffic to `backend`. The browser therefore uses one origin and never receives a direct
Python-service address. The three services must share a container network where those two service
names resolve, as they do in the supplied Compose files. A different topology must provide an
equivalent reverse-proxy configuration and trusted-proxy address. Nginx connects to the private
Python services over HTTP on port 8000.

### Running everything together (docker-compose)

```bash
# Local development profile (still served through nginx TLS)
cp .env.dev.example .env.dev
# Populate DATABASE_URL, SECRET_KEY, certificate path, login-key settings,
# FORWARDED_ALLOW_IPS, and TRUSTED_PROXY_CIDRS for the actual nginx source IP.
# One-time Compose key provisioning (the generator refuses to overwrite):
mkdir -p secrets
chmod 700 secrets
(cd backend && python -m app.generate_login_key ../secrets/login-private.pem)
docker compose -f docker-compose.yml --env-file .env.dev up --build

# UAT/deployed profile.
cp .env.uat.example .env.uat
# Replace every placeholder and configure the actual trusted proxy addresses.
docker compose -f docker-compose.yml --env-file .env.uat up --build -d

# Portal and same-origin API: https://localhost:8080
# `backend` and `document_portal` are internal-only; no Python port is
# published on the host.
```

The supplied Compose file does not assign nginx a fixed container IP. Set
`FORWARDED_ALLOW_IPS` to nginx's actual source address and `TRUSTED_PROXY_CIDRS`
to its matching host CIDR through the deployment's network configuration. Keep
both values synchronized if that address changes; the example profiles leave
them blank because there is no default fixed address.

Each root profile file is a complete Compose environment and includes both
`APP_ENV=uat` and `APP_ENV_FILE=.env.uat` (using the matching profile name).
Compose requires `APP_ENV_FILE`, uses it as each Python service's `env_file`,
and mounts it read-only inside those containers at `/run/config/qualityops.env`.
There is no hidden `.env` default at the service boundary. Variables set
directly by the deployment environment continue to take precedence. Use
`.env.dev.example`, `.env.uat.example`, and `.env.prod.example` as safe
templates, and do not commit populated profile files containing secrets.

Set `DATABASE_URL` explicitly in the selected profile; there is no database-host default. The
hostname in that URL must be reachable from the backend containers. `localhost` inside a container
means that container itself, not the Docker host or a separately running Oracle instance. The
`/api/health` endpoint checks connectivity with `SELECT 1 FROM DUAL`.

The core backend runs 4 worker processes by default (`WEB_CONCURRENCY`, see `backend/Dockerfile`).
Compose now runs two Redis services on its private network:

- `redis` / `REDIS_URL` is an optional, evictable read cache (`allkeys-lru`). Dashboard summary,
  project-wise, 3W, SAST, DAST and suppression analytics use permission-aware keys and a configurable
  30-second TTL (`DASHBOARD_CACHE_TTL_SECONDS`, capped at five minutes).
  Departments, approved applications, checklists and request types use five-minute TTLs. Generation
  changes after committed ORM/bulk writes prevent older readers from repopulating invalidated data;
  owner-token fill leases coalesce concurrent misses. Cache outages fall back to Oracle. The default
  pool is 32 connections per API process with 250 ms connect/command timeouts and no hidden retries.
  An invalidation missed during an outage is retried locally before cache reuse; other replicas can
  retain the previous response until its original TTL expires. Oracle remains authoritative.
- `redis_coordination` / `REDIS_COORDINATION_URL` stores job dispatch, login windows, scheduler
  leases and wake hints. It uses `noeviction`, a durable named volume and AOF with `appendfsync always`.
  Job submissions and Redis-mode login checks return retryable HTTP 503 when this service is down;
  they never silently bypass coordination. The optional `CACHE_ENABLED` switch does not disable it.

Each Redis defaults to a 256 MB dataset limit in a 512 MB container. Size these separately with
`REDIS_CACHE_MAXMEMORY`, `REDIS_CACHE_CONTAINER_MEMORY`, `REDIS_COORDINATION_MAXMEMORY` and
`REDIS_COORDINATION_CONTAINER_MEMORY`. Leave room for allocator, persistence and replication
overhead. Separate logical Redis database numbers do not isolate eviction; the configuration
rejects sharing the same cache and coordination host/port when durable modes are enabled.
Startup file maintenance continues to use a shared-filesystem lock.

Administrators can inspect `/api/operations/redis` and scrape `/api/operations/redis/metrics` using
an authenticated Admin session. Diagnostics include actual application cache hits/misses/bypasses,
errors, operation timings, circuit state, API latency histograms and approximate p95, Redis memory/evictions/connections/CPU, queue pending work,
retry/failure/completion counts and worker health. Application counters are per process and include
the PID; Redis INFO metrics cover each server. Server keyspace hit ratios also include generation
and lease reads, so use application hit counters when judging response reuse. No Redis URLs, keys,
credentials or task payloads are exposed. Baseline endpoint p95 latency and Oracle pool/SQL load
alongside these metrics before increasing memory, pool limits or TTLs. Liveness does not issue INFO.

### Defect application modules

Defects capture an optional **Module Name** next to **Application**, using the
same application/workspace module picker as QA requests. It defaults from a
linked QA request or stays blank (Whole application); a testcase area never
supplies or creates an application-module value. Explicit module selections,
including Whole application, remain snapshots of the reported
issue. The register has an **Application / Module** column; module names are also
searchable and included in defect details and Excel reports. **Feature / Area**
retains the existing free-text `module_feature` field for the specific affected
feature and defaults only from the execution's pinned testcase version. An empty
or missing pinned value requires reporter input rather than a later testcase
draft. Reporter edits to Feature / Area remain independent of Module Name.
Linking a QA request after saving preserves the saved module choice, including
Whole application. The testcase editor, bulk update and version comparison use
the **Feature / Area** label; their stored `module_name` key and existing import
template headers are retained for compatibility. New module names are reusable
without an approval step. Apply migration
`e8b3d7c2a610` with `alembic upgrade head` before restarting the updated backend;
it adds a nullable field and fills historical linked defects from matching QA
requests, preserving existing feature descriptions and explicitly saved modules.
The module/area mapping correction uses existing columns and needs no additional
database migration; deploy frontend and backend together.

### Defect rejection and Not a Defect review

Developers/resolvers propose **Not a Defect** to an independent QA reviewer;
the proposal remains open until QA confirms it, reopens the investigation, or
converts it to a Change Request. Only explicit `QA_ENGINEER`, `QA_LEAD`,
`CHIEF_MANAGER_QA`, or `AGM_QA` roles can **Reject defect**, including when a
requester owns the investigation. Resolver, reporter, department-head, and
administrator access alone do not grant rejection authority. Both current and
legacy workflow APIs require a rejection reason and supporting evidence (an
attachment or evidence reference), recorded in the audit trail. Current workflow
attachments must be explicitly linked to the rejection action. No migration is
needed; deploy the backend and frontend together.

Workflow menus use explicit operational roles, including for accounts that also
hold Administrator access. The blocker creator or QA Lead Group can clear a
defect blocker after reassignment. Execution defect unlinking has a separate
permission from recording a result: the original QA linker or QA Lead Group can
unlink within a writable, active project and open cycle, preserving attempt
history. Independent Not a Defect reviewers exclude the proposer/resolver. The
clearance approval queue excludes the previous QA approver from final Executive
approval for every account.

For an Oracle-enforced read-only check of live records, workflow owners and
pending approval coverage, run `venv/bin/python -m scripts.check_system_workflow_readonly`
from `backend/` with the intended database profile. Handler regression coverage
is in `backend/tests/test_system_workflow_paths.py`; missing live sample records
are reported as zero counts and are not evidence of a tested live flow.

### Multiple defects per execution attempt

An execution's latest **Fail** or **Blocked** attempt can retain multiple distinct
defects through **Raise defect**, **Link existing**, or **Link external**. Adding
another finding does not create a new test attempt or replace earlier defect links.
The existing link table enforces one reference per defect key per attempt; duplicate
requests are rejected. An explicit governed selection may convert a matching external
reference into a governed link, retaining that link's identity and auditing the change.

Retest checks evaluate every governed defect linked to the execution, including
additional execution traces. Each must satisfy its existing disposition or environment
verification rules. Every retained external reference must be marked **Resolved** or
**Closed** before another attempt is recorded. In Attempt History, the assigned QA
runner can use **Update status** to record an external tracker's confirmed status with
a mandatory reason/reference; the status update is audited and leaves result/evidence
history intact. Missing or unknown external statuses remain blocking. Updating an
external reference does not update the external tracker itself.

Linking and external status changes require an active project and an open cycle,
with existing workspace, department and execution permissions. Individual unlinking
preserves other defects and attempts; a governed execution trace remains while that
defect still has another attempt link on the same execution. Links, conversions,
status changes and removals appear in Activity. Existing reports/export sheets retain
all references. Deploy backend and frontend together; no new schema migration is
required for multiple linking.

### Defect action notes and fresh verification

Routine triage, start-work, start-QA, handoff, deployment and duplicate actions
accept optional comments. Structured requirements remain: triage owner/department
and impact, root cause and fix details for a QA handoff, build/deployment reference,
and a canonical defect for duplicates. Optional notes and extra evidence are
collapsed in the modern workflow form. Legacy resolution summaries are optional;
fix details provide the summary when one is not supplied.

Deferral, rejection, reopening, Not a Defect proposals/decisions, enhancement
conversion, risk acceptance, blockers and new occurrences still require a specific
reason. Changing production impact requires an explanation; confirming the same
assessment or clearing a blocker accepts an optional comment.

Users can explicitly select evidence already attached to the same defect or
provide a reference. Selected documents must still exist on that defect when the
action saves. Each action records the selected IDs/names in its history or audit
record, and previous events remain intact. Selecting evidence does not grant a
passing verification or silently reuse a previous test result.

Every new passed QA, business or production verification requires
`verification_confirmed: true`, a tested build and relevant evidence. The checkbox
starts unchecked and clears on action, build or defect-revision changes. Narrative
verification and closure notes are optional for a pass; reopening still requires
the failure/reconsideration reason and evidence. Existing verification history is
preserved, and a reopened fix needs fresh confirmation even for the same build.
The separate regression-testing confirmation remains optional.

Legacy closure requires the current `revision` and the same explicit verification
confirmation; legacy transitions now increment the existing workflow revision so
an earlier closure request cannot be replayed after a new fix/retest cycle. Deploy
the frontend and backend together. No database migration is required.

### Defect CC followers

Defects have an optional searchable CC multi-select covering active, selectable
members of the defect's exact workspace across all departments and roles. CC can
be set when creating or editing a New defect, and managed through **Manage CC**
throughout the lifecycle by the reporter, responsible users, and authorized QA staff.
CC changes are audited, retained on reopen, and included in the defect register export.

When a defect is raised, email goes only to its requester (the defect reporter),
its named assignee when set, and selected CC users. The reporter receives the
creation confirmation even when they raised the defect themselves. No QA-group
broadcast or automatic notification to the linked QA Request's requester is sent.
Recipients still need an active account, notification email and workspace access;
overlapping selections receive one email per creation action. Before delivery,
pending/retry creation messages are checked against this list, so old broadcasts
and recipients who lose access or are removed from CC are suppressed. Deploy the
backend API and notification worker together; no new schema migration is needed
for this recipient-rule change.

CC members can read and comment on the followed defect within their workspace;
they receive informational emails for creation, workflow changes, field edits,
comments, and CC changes when SMTP is enabled. This does not confer assignment
or approval authority. Membership and account activity are rechecked for
notifications, and overlap with the working owner does not send a second email.

Apply `alembic upgrade head` (migration `c1f7a9b4d203`) before starting the updated
backend and deploying the frontend. The normalized CC table starts empty for
existing defects; no manual record edits or reimports are needed.

### QA tester occupancy history

The Capacity & Occupancy dashboard includes a per-tester trend for the selected
reporting period: time-weighted daily average, daily peak, and days averaging at
least 80%. It uses the same eight-point capacity model as the current table.
These figures estimate assigned workload; they are not timesheet hours.

Run `alembic upgrade head` (migration `b9e5d7f3a102`) before starting the updated
backend workers, then deploy the frontend. The migration creates an append-only
request-load event table and records the existing request state at migration time.
Offline Oracle scripts obtain the baseline timestamp when executed, so generating
deployment SQL earlier does not backdate the start of reliable tracking.
Subsequent Functional, Performance, SAST, and DAST state/assignment changes are
recorded in the source transaction, including closures, reassignments, and deletes.
Historical loads and capacity weights are retained with each observation. Current
request visibility scopes every history query; reading a trend performs no writes.
Previously assigned testers remain in the historical report after deactivation,
role changes, or leaving the workspace, using only assignments on visible requests.

The migration does not backdate today's state: dates before reliable tracking
began are unavailable. Partial days use only recorded time, and future dates are
unavailable. Existing free-text workflow logs cannot reliably reconstruct the
prior weighted occupancy. The live table continues to show current assignments.

### Production Oracle pool capacity

The Oracle pool is **per backend worker**, not per deployment. Before production rollout, set the
connection budget in the deployment `.env` based on Oracle's allowed application sessions:

```text
maximum possible Oracle sessions = WEB_CONCURRENCY ×
  ((DB_POOL_SIZE + DB_MAX_OVERFLOW) + (AUDIT_DB_POOL_SIZE + AUDIT_DB_MAX_OVERFLOW))
```

For example, the current `8 + 4` main pool and `3 + 4` audit pool with four backend workers can
open up to 76 Oracle sessions. Leave capacity for Oracle administration and other applications;
do not raise pool values blindly. The API health response and slow-request logs include the local
worker's checked-in/checked-out pool counts, and a pool timeout is returned as retryable HTTP 503
with a request ID rather than an opaque HTTP 500.

The application keeps access-control lookups short-lived and limits dashboard fan-out so normal
dashboard traffic does not retain guard connections or create a large burst of simultaneous list
queries. If pool pressure remains after deployment sizing, investigate slow Oracle SQL/indexes and
the logged pool counters before increasing the connection limit.

Long-running imports and exports execute in the dedicated `job_worker` service. Its
`BACKGROUND_JOB_WORKERS` (default `2`) threads are capped across the deployment by
`BACKGROUND_JOB_GLOBAL_CONCURRENCY` (default `2`), rather than multiplied by API worker count.
Include the dedicated job and notification services' Oracle pools in the budget, plus Document
Portal's separate pools. Both dedicated services default to a `2 + 1` main pool and `1 + 0` audit
pool. Tune `JOB_WORKER_DB_POOL_SIZE` / `JOB_WORKER_DB_MAX_OVERFLOW` and
`NOTIFICATION_WORKER_DB_POOL_SIZE` / `NOTIFICATION_WORKER_DB_MAX_OVERFLOW` deliberately.

### Redis workers and rollout

Deploy the updated backend image and run `alembic upgrade head` before starting the new workers.
The `a47c2e9d6b10` migration adds Oracle background-job receipts. Versioned JSON task manifests and
uploads/artifacts remain under the durable shared upload root; Redis carries task IDs and bounded
dispatch state. Workers reconstruct the current user/workspace and recheck roles and record access.
Export downloads also recheck the downloader's current workspace and project/cycle read access.
Import/cycle-addition writes and their receipt commit in the same transaction, so a delivery after
an interrupted worker returns the original result rather than repeating committed writes.
Unacknowledged deliveries are reclaimed; renewable owner-token leases and global slots fence
execution. Workers reconcile unfinished JSON manifests every 60 seconds, including after a Redis
restart, and repair missing dispatch entries without submitting another business operation.
Terminal Redis status/specification keys expire after seven days (`BACKGROUND_JOB_RETENTION_SECONDS`);
Oracle receipts and durable files remain available. Completed/failed job status can be read from
those files during a Redis outage. Old pre-upgrade callable jobs cannot be reconstructed and require manual review after
an interruption. They are never automatically replayed.

Compose starts `job_worker` and `notification_worker` using the same backend image, environment and
shared upload mount. The worker healthchecks check their own recent heartbeat. Stop signals prevent
new claims and allow active work to drain; imports interrupted before commit roll back and can be
retried. Keep the shared storage available to every API/job replica. The durable Redis volume must
also be preserved across upgrades; do not use `down -v` to redeploy.

Notifications retain the Oracle outbox and its atomic claim/retry rules. Dedicated mode sends
best-effort Redis wake hints after commit and periodically scans Oracle, so Redis downtime never
discards email. A renewable shared lease and next-run marker coordinate the hourly SLA scan across
replicas. Embedded API pollers are disabled in dedicated mode.

Redis login mode atomically reserves admission slots and records the existing five-failures / 15-minute
username-and-IP window. Successful login clears the current IP; administrator unlock invalidates
all of that username's IP buckets. Aborted requests have expiring reservations. Redis downtime fails
closed with HTTP 503; switching to an empty Oracle window would bypass already recorded failures.
During rollout, switch every API replica together. The first Redis admission for a username/IP
bucket atomically imports its existing Oracle failure window; later admissions use Redis directly.
Successful login and administrator unlock also clear those legacy rows. Do not mix limiter backends
across replicas. A rollback to database mode requires quiescing login for the existing 15-minute
window, because new Redis failures are not copied back into Oracle.

For standalone development without these worker services, explicitly set `JOB_QUEUE_BACKEND=local`,
`NOTIFICATION_WORKER_MODE=embedded`, and `LOGIN_RATE_LIMIT_BACKEND=database`. Local job mode still
uses a bounded number of per-process worker threads and serializable task manifests. Production Compose defaults to
Redis jobs/login and dedicated notifications even when upgrading an older populated env file.
The safe profile templates document all capacity settings; populated secrets are not rewritten.

### Workflow email notifications

When SMTP is enabled, workflow approval and assignment actions are placed into
a durable database outbox in the same transaction as the audit action. SMTP
delivery is disabled until the deployment supplies a relay; no emails are
queued or backfilled while it is disabled. When the details are available,
add these values to the deployment `.env` and restart the backend:

```env
SMTP_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USERNAME=qualityops@example.com
SMTP_PASSWORD=your-secret
SMTP_FROM_ADDRESS=qualityops@example.com
SMTP_FROM_NAME=QualityOps
SMTP_STARTTLS=true
SMTP_SSL=false
PORTAL_BASE_URL=https://qualityops.example.com
```

Use exactly one TLS mode: STARTTLS (normally port 587) or implicit SSL/TLS
(normally port 465, set `SMTP_SSL=true` and `SMTP_STARTTLS=false`). Delivery
retries transient failures with bounded backoff and does not roll back a
business action when a relay is unavailable. The outbox notifies request
participants, assignees, and role-eligible approvers at their workflow step;
users without an email address are skipped.

Daily approval reminders use the same outbox and run at **09:00 IST** by default.
Each eligible approver receives one digest covering their current Pending
Approvals across accessible workspaces, including SM, Department Head,
Application Owner, readiness, clearance, and testcase approval checkpoints.
Empty queues, inactive accounts, incomplete account/email setup and read-only
profiles are skipped. Maker-checker and workspace rules remain those of the
Pending Approvals queue. The email includes record links and an Open Pending
Approvals action; long queues show the first 50 records and the remaining count.

```env
APPROVAL_REMINDERS_ENABLED=true
APPROVAL_REMINDER_TIME=09:00
```

The time is always IST and accepts `HH:MM`. Deploy the updated backend and
notification worker with SMTP enabled to activate delivery. Embedded development
mode also schedules reminders. A restart after the scheduled time catches up
today's unsent digests without backfilling previous days. The transactional
daily receipt prevents duplicate queueing across workers and restarts, and the
existing SMTP retry policy applies. Before sending, the worker refreshes the
digest against current approvals and suppresses resolved, unauthorized or
previous-day reminders. No database migration is required.

### Enable HTTPS

The frontend accepts browser TLS in nginx and publishes unprivileged container port 8443 on host
port 8080. TLS terminates at nginx; nginx connects to the private Python services over HTTP and the
backend connects to the private Redis service with `redis://`. Keep the browser-facing certificate
and private key outside the image. Set its directory in the environment file selected at deploy time:

```env
# .env.uat
TLS_CERT_HOST_PATH=./certs/

# .env.prod (relative to the directory containing docker-compose.yml)
TLS_CERT_HOST_PATH=./certs/
```

The directories and all required files must already exist before `compose up`. Compose mounts the
two edge files individually rather than exposing every file in that host directory. Nginx runs as
non-root UID/GID 101, so grant that identity read-only access to the certificate and private key
with a host ACL or an equivalent deployment-time group mapping; do not make the private key
world-readable. The backend and document services run as root because this deployment does not
permit assigning the required ownership to mounted storage and log directories:

```text
certs/
├── qualityops.crt                       # browser-facing leaf/full chain
└── qualityops.key                       # browser-facing private key
```

The required-variable check in `docker-compose.yml` stops early when `TLS_CERT_HOST_PATH` is
omitted. The same frontend image can therefore be promoted unchanged; the certificate and private
key are mounted at runtime and excluded from both source control and Docker build contexts.

For a real DNS name or network IP, obtain a certificate with the correct subject alternative name
from the organization's certificate process and place the resulting files under the configured
host directory using the two required filenames.

This repository does not contain certificate-issuance/renewal automation, an HTTP listener, or an
HTTP-to-HTTPS redirect. Nginx listens only on container port 8443, mapped by Compose to host port
8080, so the Compose URL is `https://<host>:8080`. Certificate issuance and renewal are operator
responsibilities; after replacing a mounted certificate, recreate or reload the frontend container.
If an external load balancer terminates public TLS, it must forward to this nginx TLS listener or
the deployment must supply and review a different frontend configuration. The Python
services must remain private, and their `FORWARDED_ALLOW_IPS` value must trust only the actual
nginx/reverse-proxy peer. The supplied nginx configuration treats its direct TCP peer as the
client and overwrites inbound forwarding headers. When a controlled load balancer sits in front,
configure nginx's `real_ip` module with only that balancer's CIDRs so `$remote_addr` becomes the
validated original client before it is forwarded. Without that explicit trust configuration, the
audited Client IP will correctly be the load balancer address rather than an untrusted header.

### Verification status

The full local regression run on 13 October 2026 passed all 157 checked-in backend
unittest cases and all 484 frontend Node tests, with zero failures or skips.
Coverage includes single and bulk testcase moves, recipient filtering for newly
raised defects, multiple defects on an execution attempt, duplicate prevention,
retest checks across all linked defects, external status updates and audit history.
This run added six ASGI API tests for execution defect linking and three component
tests that keep the import destination visible before, during and after imports,
including failed imports.

All 187 Python source files compiled, TypeScript passed, and the Vite production
build and production bundle security audit passed (52 files, 29 reviewed API
families). The existing main JavaScript chunk exceeds Vite's 500 KB advisory limit.
Isolated OpenAPI generation validated all schema references and unique operation
IDs for both the core API and dedicated Document Portal. The offline 1,000-record
handler benchmark retained the documented query-count bounds. Backend fixtures
use isolated SQLite and supplied identities; SMTP delivery is mocked or disabled.

Deployment validation remains incomplete. The configured Oracle listener refused
connections, so fresh live workflow/schema audits and signed-in browser acceptance
could not complete. Container inspection was declined. The local Python environment
passed `pip check`, but 12 installed versions differ from `backend/requirements.txt`
and Redis is absent. Pinned deployment dependencies, Oracle concurrency and real
SMTP, LDAP and Fortify integrations still require validation. This run did not
deploy or restart services. Results and evidence are in
`validation/full-regression-validation-2026-10-13.json`; the historical module
regression remains in `regression-results/module-regression-2026-10-10.json`.

The subsequent defect-lifecycle revalidation is recorded separately in
`validation/defect-lifecycle-validation-2026-10-13.json`, with the updated local
suite counts and coverage for optional notes, exception reasons, evidence reuse
and fresh verification confirmation.

The subsequent module/area mapping regression passed 176 backend tests and 501
frontend tests, TypeScript, the production build, bundle security audit and offline
API schema checks. Results are in
`validation/defect-module-area-validation-2026-10-13.json`.

## Authentication & the Admin section

Default Workspace is the automatic fallback for users without another active
workspace membership. Adding a user to an active workspace removes their Default
Workspace membership; removing their last active assignment returns them to Default
Workspace. A default-only membership is shown as **Automatic** in the workspace
member editor. To move that user out, add them to the destination workspace.
System Administrators remain required members of every workspace.

Every user account has a `login_type` of either **Standard** or **LDAP**:

- **Standard** accounts store a local bcrypt password hash and log in the usual
  username/password way.
- **LDAP** accounts have no local password at all — every login attempt is verified live
  against your directory server (`app/auth.py::ldap_authenticate`). System Administrators manage
  the effective connection under **Administration → System tools → LDAP configuration**. The
  `LDAP_*` values supplied by `APP_ENV_FILE` are bootstrap/recovery defaults only: once the Admin
  page is saved, its database record is authoritative and changes apply without an application restart.
  Two binding strategies are supported: search-then-bind with a service account, or a direct DN
  template. Seeded demo users are all Standard; there's no seeded LDAP account since it depends on
  a real directory to test against.

For real directory authentication, use certificate-verified LDAPS:

```env
LDAP_SERVER_URI=ldaps://directory.example:636
LDAP_USE_SSL=true
# Optional bootstrap/recovery path inside the backend host or container:
LDAP_CA_CERT_FILE=/run/secrets/qualityops/ldap-ca.pem
LDAP_BASE_DN=dc=example,dc=com
LDAP_USER_SEARCH_FILTER=(sAMAccountName={username})
LDAP_BIND_DN=cn=qualityops-bind,ou=service-accounts,dc=example,dc=com
LDAP_BIND_PASSWORD=secret-store-value
```

The Admin page accepts a CA certificate upload in PEM or DER format with a `.cer`, `.crt`, or
`.pem` filename. It stores the certificate bytes with the database-backed LDAP configuration;
that uploaded certificate takes precedence over `LDAP_CA_CERT_FILE` and requires no writable
certificate mount. A path from the administrator's workstation cannot be used because the backend
cannot read the browser's local filesystem. Upload only public CA certificates: private keys,
PFX/PKCS#12, and PKCS#7 files are unsupported.

The TLS client sends the directory hostname as SNI and verifies it using Python's native
certificate checks. Use a DNS hostname present in the directory certificate's Subject
Alternative Name; an IP URI requires a matching IP Subject Alternative Name. A CA upload
cannot correct a hostname mismatch. An explicitly uploaded issuing/intermediate CA can
anchor the verified chain, and a root-plus-intermediate PEM bundle also works when the
directory omits its intermediate certificate. Chain signatures, validity dates, hostname
validation and TLS 1.2 or newer remain required.

Connection failures distinguish certificate validation from TLS protocol negotiation. The
error guidance identifies hostname mismatch, an untrusted issuer, expired/not-yet-valid
certificates, invalid CA constraints, or weak certificate keys/signatures without exposing
directory names, paths or credentials. `LDAP_TLS_HANDSHAKE_ERROR` means to check the
LDAPS port and TLS/cipher support rather than repeatedly uploading a different certificate.

The Admin page also provides a connection-and-user test that evaluates the unsaved form values. Test
credentials are never stored. The service-account bind password is write-only in the UI and is
stored with authenticated encryption derived from the deployment `SECRET_KEY`; keep that key
stable. After an intentional key rotation, re-enter and save the LDAP bind password. Every save
and test is recorded in the audit log without credentials. Keep at least one active Standard
System Administrator account for recovery from directory or configuration failures.

`LDAP_CA_CERT_FILE` remains an optional bootstrap/recovery or legacy server-side path to a PEM CA
bundle used to verify the directory server's certificate and hostname. It must name a path visible
to the backend host or container, not a client-workstation path. If neither an uploaded certificate
nor this path is configured, the backend uses the operating-system trust store. For the optional
Compose file-based approach, place `ldap-ca.pem` in `LOGIN_ENCRYPTION_KEY_HOST_DIR`; the existing
read-only mount exposes it at `/run/secrets/qualityops/ldap-ca.pem`.
`LDAP_USE_SSL=true` with an `ldaps://` URI is strongly recommended and uses modern
client defaults (TLS 1.2 or newer). Administrators may explicitly save a plaintext
LDAP configuration, but the Admin page presents a prominent risk warning and requires
confirmation because bind credentials and user passwords will lack transport encryption.

**LDAP accounts are provisioned just-in-time, not pre-created.** An admin does *not* need to
create an LDAP user up front. The first time someone logs in with a username the app doesn't
recognize, it attempts an LDAP bind with the credentials they supplied. A successful bind creates
a local `User` row (`login_type=LDAP`, with profile fields filled from the directory when available)
without granting an application role. Before continuing, the user confirms the LDAP-provided
notification email or corrects it in the same textbox; a missing email can be added. This is
confirmation by the user, not an email OTP or mailbox ownership check. The confirmed address is
saved locally and later LDAP sign-ins do not overwrite it. The user then selects a department and submits an access request,
then remains blocked at the sign-in screen until a System Administrator or a coordinator for that
department assigns the permitted roles and approves the request. Approval also places the user in
the active workspace selected by the reviewer. Failed LDAP credentials return the same
"Invalid username or password" response as any other failed sign-in and do not create an account.

When SMTP is enabled, completing first-login department selection notifies that department's
active coordinators. If no active coordinator in an active workspace has a notification email,
the request is emailed to active System Administrators instead, with the user's details and a
link to Users & Access for assigning roles and workspace access. Repeated sign-ins do not send
the onboarding request again. External Document Portal accounts retain their existing immediate
System Administrator notification on first login.

New LDAP accounts created by an Administrator also require this one-time email confirmation.
Confirmation does not approve roles or change department/workspace access. After confirmation,
later email corrections remain managed by an Administrator or Department Coordinator; existing
approved LDAP users with no email retain their self-service add-email option. Existing accounts
with an email are not reprompted by the migration. Deployments must run `alembic upgrade head`
from `backend` before starting the updated API to add `qap_users.needs_email_confirmation`.

### Non-production mock LDAP

Development and UAT can exercise the complete first-login workflow without a directory server.
Add these settings to the active non-production environment file and restart the backend:

```env
LDAP_MOCK_ENABLED=true
LDAP_MOCK_USERNAME_PREFIX=bmock
LDAP_MOCK_PASSWORD=QualityOps-Mock-LDAP-2026!
```

Sign in with any new username beginning with `bmock` (for example `bmock01`) and the configured
password. Each distinct username creates a fresh LDAP-style account and follows the real sequence:
department selection, pending role review, Department Coordinator/System Administrator approval,
workspace placement, and normal access. Production startup rejects mock authentication even if it
is accidentally enabled there.

The **Admin** section (visible in the sidebar only to the `admin` demo user / any account with
the Administrator role, part of the Governance module) is a full user directory at `/admin`:

- **Create User** — set username, profile fields, role, and login type. Standard accounts
  require a password at creation; LDAP accounts don't (the username must match their LDAP
  identity).
- **Assign role** — change any user's role inline from the table; takes effect on their next
  request.
- **Activate/Deactivate** — disabled accounts can't log in (an admin can't disable their own
  account).
- **Reset Password** — available for Standard accounts only; LDAP accounts are "Managed via
  LDAP" since their password lives in the directory, not this app.

Backing endpoints: `GET/PATCH /api/auth/users/{id}`, `GET /api/auth/users/all`,
`POST /api/auth/users/{id}/reset-password` (all Admin-only).

## Production notes

- Apply versioned Oracle schema changes with **Alembic** before starting API
  containers.
- Request QA Lead attribution requires migration `8c3d5e7f9a12` (included in
  `alembic upgrade head`). Functional, SAST, DAST, and Performance requests now
  save the QA Lead group member who starts readiness and update that assignment
  to the member who makes the readiness decision. PDF exports display that saved
  person's name. The migration recovers missing assignments from the most recent
  readiness history after the latest Department Head approval, preserving existing
  assignments. Requests with no attributable readiness action remain unassigned;
  ambiguous legacy `SAST_DAST` history is excluded. Deploy the backend changes and
  run the migration before regenerating PDFs for previously approved requests.
- Conditional Clearance requires the `a6d9c2e4f801` migration (included in
  `alembic upgrade head`) for mitigation, responsible owner, and target date.
  Full and Conditional Clearance both require an eligible Functional Request,
  completed cycles in the tested environment, and recorded execution evidence.
  Conditional certificates additionally require conditions (manual observations
  or captured open defects), residual-risk remarks, and mitigation
  before submission and each approval. Responsible owner and target date are optional.
  Existing incomplete conditional drafts
  must be edited and recaptured; issued certificates are not automatically revoked.
- QA Lead Group members can use **Complete for Conditional Clearance** with a
  reason to complete cycles containing failed, blocked, or unexecuted tests and
  unresolved Critical/High defects. At least one result must be recorded. Existing
  defect Target Release requirements remain in force. This action is audited,
  freezes the cycle, and does not issue a certificate or bypass its approvals.
- QA certificates show **Prepared by**, with a Bank Staff, Vendor, or Standard
  account badge and the vendor organization where applicable. Final Executive
  approval saves the current certificate owner's name, username, account type,
  and organization in the existing certificate snapshot envelope. Issued,
  held, and superseded certificates retain these values after profile or
  organization changes. Each revised certificate captures its own preparer.
  PDFs separately identify **PDF exported by**, including the exporting user's
  account type, organization where applicable, and export time. Older terminal
  certificates without captured identity display **Not recorded on this
  certificate**. No backfill or schema migration is required.
- Testcase/repository and execution lists use primary-key cursor pagination;
  cycle candidates are evaluated with SQL `NOT EXISTS` and are loaded only
  when the Add Test Cases dialog opens. Apply every versioned schema/index
  change with `alembic upgrade head`; do not target or stamp an undocumented revision.
- Large cycle additions (more than 500 rows), testcase Excel imports, and
  repository/lifecycle Excel exports run as background jobs. Job status and
  generated artifacts live under `<configured upload root>/.jobs`; therefore
  every API worker must use the same durable shared upload root in production.
- Configure `TRUSTED_PROXY_CIDRS` with only the actual load-balancer, ingress or
  reverse-proxy networks. Login and action audit records will then store the
  original client from `X-Forwarded-For` instead of the proxy's address. The
  supplied nginx configuration already forwards `X-Real-IP` and
  `X-Forwarded-For` from its observed TCP peer and sets `X-Forwarded-Proto`;
  Uvicorn accepts that scheme only from
  `FORWARDED_ALLOW_IPS`, allowing the deployed backend's HTTPS guard to reject spoofed traffic.
- Add MFA at the identity-provider layer for LDAP/AD-backed logins, per the non-functional
  requirements (5.1) — this app only performs the LDAP bind, not step-up/MFA.
- Supporting documents are uploaded (multiple files per request, every module) and stored under
  the deployment-controlled upload root (see `app/documents.py`). Docker always writes to
  `/data/qualityops/uploads`. Set `UPLOAD_STORAGE_HOST_PATH=/absolute/host/or/nfs/path` in the
  selected Compose profile to bind that container directory to a host/NFS folder; the Compose
  default is the repository-local `./storage/uploads` bind path. Recreate the backend container after changing the
  host path. The upload location cannot be changed from the application UI.
- The authenticated **Document Portal** runs in its own `document_portal` API container and is
  reverse-proxied at the same `/api/document-portal` URL. It has its own worker pool, log volume,
  multipart temporary directory, and persistent storage mount, so large uploads, downloads, ZIP
  creation, searches and filesystem scans cannot consume the core workflow API workers or its
  upload disk. Its Oracle pool is separately capped by
  `DOCUMENT_PORTAL_DB_POOL_SIZE`/`DOCUMENT_PORTAL_DB_MAX_OVERFLOW`, so upload sessions cannot
  exhaust core workflow connections. Set `DOCUMENT_PORTAL_STORAGE_HOST_PATH=/absolute/dedicated/disk-or-nfs-path` in
  the selected Compose profile for production; the default is the repository-local
  `./storage/document-portal` bind path.
  The service stores repository files beneath that mount's `repository/` folder and temporary
  multipart data beneath `work/`. Before the first isolated deployment, copy existing files from
  the old `<UPLOAD_STORAGE_ROOT>/document-portal` location into `repository/`; do not delete the
  old data until the migrated repository has been verified and backed up. The portal supports
  nested folders, uploads (including uploaded folder hierarchy), search, downloads/ZIP, rename
  and move, and intentionally exposes no delete operation.
- Set `SECRET_KEY` to a long random value via environment variable/secrets manager, never
  leave the empty placeholder from the root profile examples.
- Tune `pool_size`/`max_overflow` in `app/database.py` to your Oracle session limits and
  expected concurrent user count (NFR 5.2).

## API overview

All protected endpoints are under `/api/*` and use the opaque HttpOnly session cookie issued by
`POST /api/auth/login`; the browser sends it with `credentials: include`, and mutating requests
also send the CSRF cookie value in `X-CSRF-Token`. No authentication credential is returned to or
stored by JavaScript; authentication remains entirely cookie-backed. Interactive FastAPI
documentation is available at `/docs` only in development; UAT and
production disable the docs, ReDoc, and OpenAPI routes.

Key endpoint groups:

- `POST /api/auth/login`, `GET /api/auth/me`, `GET /api/auth/users`
- `/api/document-portal` — authenticated shared document repository (folders, upload, search,
  download/ZIP, rename and move; deletion is intentionally unavailable)
- `/api/qa-requests` — CRUD + `/submit`, `/cancel`, `/history`, `/export`, `/documents`
  (multi-file upload/list), `/documents/{id}/download`
- `/api/functional-requests` — CRUD + decision/lifecycle actions, `/checklist`,
  `/history`, `/export`, `/documents`
- `/api/sast-requests`, `/api/dast-requests` — CRUD + decision/lifecycle actions, `/findings`
  (+ `/resolve`), `/history`, `/export`, `/documents`
- `/api/suppressions` — CRUD + `/sm-decision`, `/dept-head-decision`,
  `/security-team-decision`, `/history`, `/export`, `/documents`
- `/api/performance-requests` — CRUD + decision/lifecycle actions,
  `/checklist`, `/history`, `/export`, `/documents`
- `/api/signoffs` — CRUD + `/issue`, `/history`, `/export`, `/documents`
- `/api/approvals`, `/api/approvals/pending-mine` — cross-module audit/decision feed
- `/api/audit`, `/api/audit/export` — protected application/access audit log and CSV evidence export
- `/api/dashboard/*` — project-wise, security (SAST/DAST), suppression, and the `/3w`
  ("what's pending, where, since when") dashboards
- `/api/reports/*` and `/api/export/{report_key}?format=xlsx|pdf|csv` — operational, security,
  and management reports; PDF exports show a severity-level issue-count summary rather than
  full per-finding detail
- `/api/departments` — department master data (Admin-managed)

## Known limitations / next steps

- Ageing in the 3W dashboard is computed from `updated_at` timestamps (a reasonable proxy
  for "since when it has been pending"); wire in SLA thresholds/escalation matrices per your
  bank's policy if you need automatic escalation emails.
- See [Verification status](#verification-status) above: run an Oracle-backed container smoke
  test in the target environment before promotion.

### Active sessions

Login creates an opaque random session secret and a separate CSRF secret. Only SHA-256 hashes are
stored in `qap_auth_sessions`. The session secret is sent in a host-only HttpOnly, SameSite=Lax
cookie; JavaScript can read only the companion CSRF cookie. UAT and production use Secure
`__Host-` cookie names. Every non-safe request must provide the matching `X-CSRF-Token` value, and
browser-identified cross-site mutations are rejected.

- `SESSION_IDLE_MINUTES` is the server-enforced inactivity limit (default 30 minutes).
- `SESSION_MAX_MINUTES` is the absolute lifetime from login (default 480 minutes/eight hours).
- Authenticated requests refresh `last_seen_at` at most once per minute. `POST /api/auth/renew`
  validates the same cookie session and returns current identity data; it does not issue a browser
  credential, replace the session cookie, or extend the absolute deadline.
- Logout revokes the server-side row and clears both cookies. A non-secret local-storage marker
  synchronizes logout across tabs; credentials are never placed in localStorage or sessionStorage.
- Disabling a user or changing live role assignments takes effect through the database-backed
  identity checks. Expired and revoked sessions require another sign-in.

Cookie/CSRF frontend regression checks are in `frontend/tests/token-renewal.cjs`.
Backend session handling is implemented in `backend/app/session_security.py`;
a dedicated backend session-security test suite remains a coverage gap.


### Login payload encryption

Login now requires encrypted JSON. Deploy backend/frontend images together and provision the private RSA key before starting the release; see `Login_Encryption_Deployment.md`. Compose mounts `LOGIN_ENCRYPTION_KEY_HOST_DIR` (default `./secrets`) read-only in backend, separate from uploads. The old plaintext form API is rejected. HTTPS and a trusted proxy allowlist remain required.

## Performance review — v1.0.3

The October 7, 2026 review identified and corrected repeated database reads in
Spotlight suggestions, Activity mentions, approval history and the pending-work
(3W) dashboard. Search now selects compact candidate labels and checks the actual
record permissions in final ranking order until the result list is full.
Project visibility is reused only within that same user/workspace request.
Mentions reuse the target and its workspace; typing lookups cancel when superseded,
use an eight-second deadline, skip retries and caching, and avoid the page-wide
loading indicator. Approval history batches record references and actors and
resolves each entity's department once. The 3W dashboard batches parent requests
and suppression items rather than loading them separately for every row.

An isolated SQLite fixture contained 1,000 QA requests, 1,000 SAST requests,
1,000 projects, 120 users, 500 approval events and 10 KB request descriptions.
The measured handler database-query counts were:

| Handler | Before | After |
| --- | ---: | ---: |
| Application search suggestions | 104 | 70 |
| Empty @user picker (20 results) | 115 | 58 |
| Approval-history search (25 displayed events) | 1,034 | 12 |
| Pending-work dashboard (1,000 pending requests) | 1,010 | 12 |

At 10,000 records **per source**, suggestions and approval-history query counts
remained unchanged; dashboard queries rose to 30 because parent loading uses
batches. Warm median handler times on this development machine were about 113 ms
for application suggestions, 66 ms for an ID search, 9 ms for the @user picker,
5 ms for approval-history search and 306 ms for the pending-work dashboard.
These are sequential handler measurements, excluding HTTP transport,
authentication, response serialization, audit writes, Oracle network latency and
concurrent users. They are not production latency guarantees.

Reproduce the offline probe from `backend/`:

```sh
python3 scripts/benchmark_interactive_reads.py
python3 scripts/benchmark_interactive_reads.py --records 10000 --samples 3
```

This script creates an in-memory SQLite database and disables SMTP in its own
process. It does not connect to the configured database, LDAP or mail servers.
Current query-count evidence comes from this offline benchmark. A dedicated
backend query-count regression test suite remains a coverage gap; the checked-in
frontend suite includes privacy, workspace, delegation and navigation checks.

The historical local application logs also contain slow dashboard/request-list
and export calls, including a dashboard requests call lasting 23.5 seconds and a
Performance request-list call lasting 15.3 seconds. Those measurements do not
establish the cause or show that these changes introduced the delays. Production
Oracle execution plans, deployed indexes/migrations, pool pressure and concurrent
load still require verification. Substring autocomplete predicates may scan many
rows as the directory grows; the pending-work response still includes all pending
items; approval history retains its existing 2,000-candidate/500-visible-event
ceiling. The build retains its existing warning about a JavaScript chunk above
500 KB. No database pool or production cache settings were changed by this review.


### SAST/DAST obstacles after readiness

During planning, configuration, scanning, validation and remediation, the assigned Security Analyst or a QA Lead can return affected repositories/targets to the requester for correction or open an internal hold with a named Security Analyst/QA Lead owner. An empty selection pauses the whole request; partial selections leave other scope actionable. Overlapping active obstacles are rejected. Analyst ownership, completed approvals, checklist evidence, scan results and findings remain intact.

The requester (or active input delegate) submits corrections to affected scope rows and may add repositories under the permission rules below. Internal hold owners submit their resolution without changing requester inputs. Every submission requires fresh review by a different assigned analyst or workspace QA Lead; previous confirmations cannot be reused. Routine notes are optional, but obstacle reasons, required corrections and return reasons are mandatory. Source/deployed/credential changes invalidate current scan coverage while retaining historical imports. Repository/branch/technology or URL/environment/authentication scope changes also require Department Head scope reapproval and explicit fresh readiness confirmation. Existing valid approvals are retained; scope approval does not reset analyst assignment. Credential values are never copied into obstacle history or notification metadata.

Obstacle actions appear in SAST/DAST details and the pending action queue. Audit records retain actor, time, previous/new obstacle phase, affected IDs, changed field names and review confirmation. Handoff email goes only to the current input/hold owner, the assigned analyst (or independent QA Lead reviewer where needed), or eligible Department Head approvers for scope reapproval. All obstacle corrections and decisions use a revision check under the request row lock, and unresolved obstacles prevent request completion/QA clearance.

Deploy migration `a31d8e6c2f90_security_obstacles.py` before starting the updated backend, and publish the updated frontend alongside it. The migration adds `qap_security_obstacles`; it is restartable and keeps audit records on rollback. No migration or deployment is performed by local regression tests.


### Repository additions during SAST corrections

SAST requester corrections reuse the request creation repository cards, labels, Git URL guidance and required fields. Existing repository IDs are retained; affected repositories are editable and unaffected repositories are read only. Only unsaved additions expose Remove. Correction notes are optional; a short scope reason is mandatory when adding repositories. DAST continues to use protected credential updates, with credential guidance shown only in DAST.

Whole-request returns permit adding repositories. A return limited to selected repositories requires an explicit permission from the assigned Security Analyst or a workspace QA Lead. Permission can be recorded while creating a return, or changed on an existing open return through Manage repository additions, with a reason and revision check. Internal holds cannot add or alter requester scope.

Corrections patch existing rows and append new repository IDs atomically. Repository/branch combinations are checked against the proposed corrected scope and other additions; host casing, whitespace, trailing slashes and the conventional .git suffix are normalized while repository path and branch case are preserved. New repositories are associated with the originating obstacle, start without scan coverage, and cannot be scanned or clear the request until Department Head scope approval and fresh independent QA readiness review are complete. Existing valid evidence, approvals, findings and immutable scan history remain intact, and analyst ownership is preserved. An added repository returned for correction keeps its submitted ID and remains in the audit record.

Deploy migration `b47e2a9c6d13_security_scope_additions.py` after `a31d8e6c2f90_security_obstacles.py` before starting the updated backend. It adds scope permissions and repository provenance to the obstacle record, defaults existing returns to restricted additions (whole-request returns still permit additions), and retains those columns on rollback. Regression tests apply migrations only to isolated SQLite; Oracle DDL is checked offline.

Open requester obstacles support delegation even while other repositories/targets continue scanning. Completing a different target's fix retains that delegation while another requester obstacle is open. The assigned analyst or workspace QA Lead can use Change action owner / routing to replace an unavailable internal owner or correct a mistaken requester/internal handoff. A reason and current revision are required; only open obstacles can change routing. Scope, evidence, approvals and analyst ownership are retained, and fresh submission and independent QA review remain required.

The first analyst assignment remains available during a planning hold and resumes configuration after review. Review notifications fall back to eligible independent QA Leads if the analyst is inactive or no longer eligible. Stale or timed-out correction dialogs offer Refresh latest request, which bypasses the read cache and discards unsaved dialog edits. DAST corrections use the same UAT/Pre-Production environments as intake, retain protected credentials by default and allow explicit clearing when authentication is No.

Run `venv/bin/python -m scripts.check_security_scope_schema_readonly` and `venv/bin/python -m scripts.check_system_workflow_readonly` from `backend/` to inspect the configured Oracle deployment in read-only transactions, without importing application startup. The first compares migration heads and required security columns; the second validates existing responses, pending approvers and each active obstacle's next owner. Validation evidence for the October 14 recovery review is in `validation/security-integrity-validation-2026-10-14.json`.

### Admin control of new application creation

Admin → Applications includes New application creation with an Enable “Other (new application)” checkbox and Save setting. It applies across all workspaces and defaults to disabled. The setting persists in the existing `qap_system_settings` table under `application_creation.v1`; no new migration is required. Only System Admins can update it, and changes record the previous/new values and actor in the system configuration audit. Updates require the current revision; a conflicting admin edit loads the latest saved value before another save.

When disabled, Other remains visible with disabled styling. Clicking it or activating it with Enter/Space opens a modal: “New application creation is disabled. Select an application from the existing list or contact an administrator to add a new application.” The selected listed application is retained. Enabling restores the existing BCP warning and Application Owner approval workflow. The wizard rechecks the setting when Other is activated and before continuing with a new name; backend enforcement also rejects stale or direct creation/edit requests that introduce an unlisted application. Existing catalogue names, saved proposals, pending approvals and history remain usable. Admin manual additions and Excel seeding of approved applications remain available while requester creation is disabled.

Authenticated users read `GET /api/system-settings/application-creation`; only System Admins may `PUT` `{enabled, expected_revision}`. Responses use no-store headers. The shared name resolver enforces the policy across QA intake and linked Functional/SAST/DAST/Performance application edits. Validation evidence is in `validation/application-creation-validation-2026-10-14.json`.

### Late historical linking of Closed defects

Testcase Execution's Link existing picker includes active and Closed defects, with a status filter. Select a defect and click Link Defect once. Attempt History uses the same one-step linking operation. Defect Management's Link testcase action uses the shared Closed-defect reference dialog with one execution selector and one submit. Attempt selection, late-linking reasons and extra confirmation dialogs are no longer required.

The backend locks the defect and execution, chooses active linking or a Closed-defect reference, checks access and prevents duplicates. Workspace, department, application, QA request and cycle-folder visibility remain enforced. The UI sends the current closure revision in the background. A single eligible earlier failure may be retained automatically as context; multiple, missing, undated or later attempts produce an execution-only reference without inventing an original failure. A reference can be added after closure and does not claim that the closed defect caused a new failure. A recurring issue still needs an active/reopened defect for its current fix and verification. Completed/Blocked cycles and inactive projects continue to require workspace QA Lead Group authority. Legacy explicit-attempt API calls remain supported and enforce their original pre-closure attempt checks.

Historical links and execution references retain the Closed snapshot, closure revision, actor and timestamp. The reason is optional; audit history records the association automatically. These links never move the primary trace, reopen the defect, change owners/results, grant verification or clear active/external blockers. A previous Failed/Blocked attempt still requires a fresh Retest Passed result. Later reopening does not rewrite the Closed-at-link snapshot. References cannot be removed using ordinary Unlink, and existing Admin permanent-removal governance remains unchanged.

The execution drawer and Defect Management linked-execution directory display Closed references with their provenance. Unlinked/incomplete queues, Functional Request filters and execution/cycle/testcase filters recognize these associations. Defect and cycle exports include a separate Closed Defect References sheet. References do not enter active cycle completion/clearance gates or current defect retest aggregates. Future certificate captures retain them as reference metadata, separate from active defect counts. Audit events on the defect, testcase and cycle preserve frozen issued certificates, cycle data and original approval history.

The original historical-attempt migration `c58f3b7a2d91` remains part of the migration chain. Simplified linking adds restartable migration `f81b2c6d9a30` after `e7a91c4d8b20`, creating `qap_defect_exec_refs` without changing existing attempt or defect records. Downgrade retains reference data. Apply the latest migration before deploying matching frontend/backend versions. This workspace's configured Oracle database was upgraded to `f81b2c6d9a30`; full regression evidence and live validation limits are in `validation/simplified-defect-linking-2026-10-15/report.json`.


### Department-only defect reassignment and routing recovery (2026-10-14)

Resolver reassignment stays inside the department established during triage. The UI and candidate API use the same backend policy. A user's other departments or workspace QA role cannot expand that pool. Same-department reassignment remains available before Start work; it changes ownership and leaves the lifecycle stage unchanged. QA handoffs continue through Ready for QA / Resolved, and QA, business and release stages update their dedicated owner fields.

The responsible department and latest resolver are saved in existing workflow state. Earlier modern defects derive their department from immutable triage history; older legacy records use their persisted team until an explicit recovery records a verified department. Reassignment and recovery lock the defect row and require the current revision and prior owner, preventing stale forms from overwriting newer ownership or lifecycle changes. Independent QA reviewer checks also apply during reassignment.

Defect Actions now includes **Recover resolver routing** for administrators and the workspace QA Lead Group, plus the recorded responsible department's head when a trusted routing snapshot exists. This is a governed correction, with a mandatory reason and shared warning confirmation. It retains the current stage, effective QA/business/release ownership, verification history, blockers, evidence and fresh retest requirements. Closed and terminal defects cannot use recovery. Where original routing is known, recovery is confined to that active department; where old records have no original snapshot, an administrator or workspace QA lead explicitly selects the department after reviewing history. Inactive departments require administrator attention.

Both owner-change actions append workflow audit events and preserve normalized assignment tenures. Recovery records previous/new resolver, previous/new department, actor, time, reason and retained stage. The dialog handles loading failures, stale records and duplicate clicks, and prevents resubmission when the mutation saved but the parent view failed to refresh.

The frontend and backend should be deployed together: `/api/defects/{id}/reassign` now requires `expected_revision` and `expected_owner_id`. The fresh selection endpoint is `/api/defects/{id}/assignment-context`; governed recovery uses `/api/defects/{id}/recover-routing`. No additional database migration is introduced by this change; the earlier c58f3b7a2d91 migration remains part of the existing deployment prerequisites. No live migration or service restart was performed during validation.

Validation: 280 backend tests and 569 frontend tests passed, including 27 focused backend routing/recovery cases and 15 frontend dialog/ownership cases. Production typechecking, build and bundle audit passed. Offline OpenAPI validation checked 440 paths, 500 operations, 319 schemas and 1,181 references without database connections or startup maintenance. See `validation/defect-reassignment-validation-2026-10-14.json` and its evidence directory.


### Full system blockage review (2026-10-14)

The full regression and read-only Oracle review found and repaired two ownership paths: QA executive reassignment now resolves the workspace from the linked QA Request on older defects, and current business/release owners can see their named stage responsibility across departments inside their authorized workspace. Their records appear in the My Issues queue and its dashboard count. The stage ownership exception ends when ownership or stage changes and never broadens workspace access or resolver department eligibility. Enterprise Viewer candidates are also explicitly rejected for defect ownership.

Oracle stage-owner JSON predicates use constant literal JSON paths; owner IDs remain bind parameters. This was exercised against Oracle in read-only transactions, alongside isolated scope and mutation tests. The live audit now checks defect visibility for operational users and validates current stage owners' role, workspace access and record reachability.

The final local regression passed 285 backend tests, 569 frontend tests, production typecheck/build/bundle audit and offline API/Oracle contracts. Python source compilation checked 203 files without execution. The live audit covered 13 workflow records, three pending approval checkpoints and one open security correction; no missing active owners or approvers were detected.

**Deployment is still blocked by the existing historical-link migration:** UAT remains at `b47e2a9c6d13`, while the source requires `c58f3b7a2d91`. `qap_test_run_defects` is missing `is_historical`, `governed_defect_id` and `linked_workflow_revision`. Consequently the updated `DefectOut.historical_execution_links` response fails validation against that database. Apply the existing migration with `venv/bin/python -m alembic upgrade head` from `backend`, then deploy/restart the matching frontend and backend and rerun the read-only audits. No migration, live record correction or service restart was performed during this review.

The review does not claim the current deployment is free of blockage. Modules with no live data were exercised through isolated handlers and HTTP tests; real LDAP/SMTP/scanner interactions and production-load concurrency were not run. See `validation/system-blockage-validation-2026-10-14.json` and its evidence directory.


### Functional Request defect traceability (2026-10-14)

Defect Management has a searchable, server-paged **Functional Request** filter. It includes completed requests, **All Functional Requests**, and **No Functional Request linked**. The selection remains in the URL when a defect opens or closes, and applies to every queue count and workbook export. The request detail provides **View linked defects**. Traceability shows clickable Functional Request IDs separately from the parent QA Request ID.

Associations are exact: direct Functional Request links, primary cycles/executions, additional executions, and Closed-defect historical attempt links. The SQL predicate uses existence checks so multiple paths count a defect once. An application name or shared parent QA Request alone does not associate a defect with a Functional Request. Request options use the existing Functional register's workspace, department-unit and delegation visibility rules.

**Link Functional Request** uses the shared selector and warning confirmation. The backend checks scope, matching application/workspace/department, parent QA Request compatibility, duplicates across all association paths, and the current defect revision. A reason and confirmation are mandatory. Reporter/resolver/QA lead permissions apply to active defects; a QA lead must approve links to closed or terminal defects. Read-only users and inherited workspace viewers cannot link. Each direct association records the actor, timestamp, reason and previous revision, and appends both defect and Functional Request audit history. It preserves lifecycle, closure, stage ownership and retest evidence, and does not provide an execution result or bypass fresh retest checks. Traceability audit events do not produce workflow handoff emails.

Future certificate captures include direct Functional Request links and historical defect references in the matching execution environment. Existing issued certificate snapshots are not rewritten. Full regression also exposed a pending-email duplicate-key collision: an action-local token now prevents recycled Python memory addresses from suppressing a distinct reminder, while repeated delivery for the same action/recipient stays deduplicated.

Deploy migration **d69a4c8e2f10_defect_functional_request_links.py**, after **c58f3b7a2d91**, before starting the updated backend, and publish the frontend alongside it. From `backend`, run `venv/bin/python -m alembic upgrade head` in the intended deployment environment. The migration adds `qap_defect_func_links` with a composite primary key, foreign keys and a request index; it is restartable and retains audit data on rollback. No live migration, service restart, email delivery or scanner operation was performed by these local checks.

Validation: 313 backend tests and 578 frontend tests passed. These include 15 new backend request-link/filter/certificate/migration cases and 9 frontend selector/dialog/filter cases. Production typechecking, build and bundle security audit passed, with the existing large main-chunk warning. Offline checks validated 442 API paths, 502 operations, 323 schemas and 1,191 references, plus Oracle migration and filter SQL without database access. See `validation/functional-request-defects-validation-2026-10-14.json` and its evidence directory. These results do not establish real LDAP, SMTP or SSC connectivity; the separate integration report remains applicable.

### Execution retest observations and verification (2026-10-15)

After a Failed or Blocked attempt, **Retest linked defects** records a new attempt before linked-defect verification is complete. The shared control is available in Testcase Execution, quick execution and My Executions. Defect Management's **Review testcase retests** opens the same evidence and verification control. An assigned runner records the observed testcase result, actual result, tested build and a Passed, Failed, Blocked or Not tested outcome for each linked finding. Passed and Failed outcomes require attached evidence or an evidence reference; other outcomes require a reason. New or In Progress findings cannot be marked Passed before a fix is submitted, but another ready fix can be retested while those findings remain open.

A passing observation is stored as **Retest Pending**. It retains the pinned testcase version, actual cycle environment, tested build, per-defect status and fix-iteration snapshots, evidence and author. The assigned QA reviewer independently confirms each fix using a fresh confirmation and current revision; execution assignment and defect review ownership can belong to different people. A failed QA retest atomically records the failed attempt and reopens the affected internal defect to its resolver, preserving the saved QA owner and other findings' lifecycle stages. Legacy defect flows retain their existing handoffs. External failures update the locally tracked reference and audit history; external tracker state must be checked separately.

**Confirm final retest** requires another fresh confirmation, an unchanged execution context, outcomes for every currently linked finding, and all existing verification, external-status and approved-disposition checks. It creates a separate Retest Passed attempt linked to the original observation; the original result and evidence remain unchanged. Pending retests cannot pass through ordinary single, bulk, rich-result or imported-result controls, cycle completion, Full Clearance or Conditional Clearance. Environment or fix changes invalidate stale verification; build numbers remain audit evidence and need not equal the cycle build. Required business/release stages and self-verification restrictions remain enforced. The execution export includes a **Retest Outcomes** worksheet.

Deploy migration **e7a91c4d8b20_execution_retest_observations.py**, after **d69a4c8e2f10**, before starting the updated backend, with the matching frontend. From `backend`, run `venv/bin/python -m alembic upgrade head` in the intended deployment environment. The migration creates `qap_test_retests` and `qap_retest_outcomes`, is restartable, and retains audit records on rollback. **This migration has not been applied to UAT by this implementation task.**

Validation passed: **342 backend tests**, **589 frontend tests**, production typechecking/build/bundle audit, and offline OpenAPI/Oracle DDL checks covering 447 API paths, 507 operations, 330 schemas and 1,207 references. The added tests cover the retest sequence, separate runner/reviewer permissions, failed-fix reopening, rollback, evidence retention, stale contexts, all-linked-defect checks, pending clearance guards, exports and migration restartability. See `validation/execution-retests-validation-2026-10-15.json`. These are isolated regression checks; real LDAP, SMTP, scanner connectivity and deployed Oracle execution of this new migration were not exercised.

### Retest system recheck (2026-10-15)

The subsequent full rerun passed all 342 backend tests, 589 frontend tests, production typechecking/build/bundle audit and offline API/Oracle contracts. No product source changed during this recheck. The retest tests cover observations before verification, independent QA review, failed-fix reopening, immutable evidence, stale-context rejection and final pass/clearance guards alongside the existing workflow suites.

Read-only UAT inspection now confirms migration **e7a91c4d8b20** is applied, all 71 mapped tables have the expected columns, and the new retest tables have their target constraints, foreign keys and run index. All 117 current workflow records serialized successfully; the owner/approver audit found no issues. Register filters passed 78 checks across 15 authorized actor/workspace contexts. All three currently assigned executions with prior failures returned valid retest contexts, and `/api/health` reported the application and database healthy. No retest observations exist in UAT yet, so retest writes and final confirmation were exercised in isolated API tests. The recheck applied no migration and changed no business records.

Real LDAP remains disabled/unconfigured, SMTP remains disabled/unconfigured, and both configured SSC endpoints refused connections. The defect participant audit found no unrelated role groups in the creation route, but no live email delivery was attempted. Public OpenAPI access over local plain HTTP returned 426; UAT documentation is disabled by configuration, and contracts were validated offline. These deployment/integration limits are separate from the passing retest regression. See `validation/retest-system-recheck-validation-2026-10-15.json` and `validation/retest-system-recheck-2026-10-15/` for evidence.

### Simplified execution retesting (2026-10-15)

Retesting now appears inside the existing **Record Result → Log New Attempt** form. The same rich actual-result editor, attachment control and artifact reference fields serve first runs and retests. Quick execution and My Executions use one Run action; Defect Management opens the same saved evidence and review controls. The separate "Retest linked defects" form and repeated per-defect reason fields have been removed.

Findings that have no submitted fix show **Awaiting fix**. When none is ready, the form retains the current execution result and shows that status instead of asking for a new passing observation. For a ready fix, select only the findings tested, enter the attempt result and evidence once, and optionally provide a different outcome or specific details for an individual finding. Untouched findings retain their lifecycle, owner and prior evidence without a manufactured Not tested outcome. A failed finding uses the shared actual result as its reopening reason unless more specific details are supplied. Existing Change Request/NA disposition entry remains available.

Partial retests retain separate immutable attempts. Each finding's latest observation supersedes its earlier observations; valid proof for untouched findings is reused across partial attempts in the same execution, pinned version, environment and fix iteration. Reviewers can verify an earlier finding after another finding has been tested. Verification uses the recorded evidence, including authenticated downloads from the original execution attempt, rather than asking for another upload. Reopened findings wait for a fresh submitted fix; changed fixes, stale contexts, missing evidence and later failed outcomes cannot reuse earlier success. External tracker status and approved-disposition rules remain in force.

The latest passing observation still needs explicit final confirmation. The backend checks every currently linked finding using current verification and evidence, then writes a separate Retest Passed attempt with the source outcome receipt IDs in audit history. Ordinary result APIs cannot bypass the pending retest guard. Cycle completion and Full/Conditional Clearance guards are preserved. Deploy the matching frontend and backend together; **no additional migration is required** beyond the existing `e7a91c4d8b20` retest tables.

Validation passed: 356 backend tests, 596 frontend tests, production typecheck/build/bundle audit, 212 Python source compilations, and offline API/Oracle contracts. Read-only Oracle checks validated 118 current workflow records, four assigned execution contexts, current migration `e7a91c4d8b20`, and active owner/approver reachability. See `validation/simplified-retest-validation-2026-10-15.json`. Retest writes were exercised in isolated API tests; this check changed no live business records and did not re-probe external LDAP, SMTP or scanner connectivity.

### Closed-defect Run correction (2026-10-15)

When linked findings have cleared the execution's verification requirements, **Run** now uses the normal result buttons, including **Retest Passed**. It no longer routes every previously failed testcase with a linked defect into the observation form. An unfinalized retest or unresolved finding still uses the governed retest flow. Older readiness responses are normalized so omitted presentation fields do not produce a false Awaiting fix message. If the table row is stale but a freshly loaded context permits ordinary results, the open result view exposes Retest Passed with fresh confirmation and the current execution revision.

Read-only inspection confirmed the reported `TQA-DEF-00004` is Closed/Fixed and its verification covers execution `TQA-TC-04`; the backend's ordinary retest gate returns no blocker. The fix preserves closure, original failed attempts, pending final confirmation, environment verification and certificate guards. Validation passed 359 backend tests, 601 frontend tests, the production build/bundle audit and offline contracts. No additional migration or live business-record correction was performed. See `validation/closed-retest-run-validation-2026-10-15.json`.

### Cycle planning and reviewed request links (2026-10-15)

Planned End Date is optional when creating/editing a cycle and during Ready,
execution, completion and clearance. Start Date stays required; an end date,
when supplied, must be on or after it. Existing dates and immutable completed
cycle evidence remain intact. The database column was already nullable, so no
additional migration is needed.

The shared cycle request picker searches request ID, application, CR/EPIC,
change type and business defect reference. Preview opens the existing Functional
Request drawer in read-only mode. Selecting **Use this request** records an audit
confirmation and returns a signed receipt scoped to the user, project, cycle
(when editing), request and current request details. Receipts expire after one
hour and are applied once, atomically with the cycle/link save. Changed request
details, expired receipts and another user's/request's/project's/cycle's receipt
require a fresh preview. Confirmation and application are retained as separate
append-only audit events and do not send workflow reminders.

Create Cycle, changed request links (including completed-cycle trace recovery)
and Functional **Link & Start Execution** enforce the receipt in the backend.
Standalone cycles, unlinking, unrelated metadata edits and starting an existing
link do not need a new preview. Governed clearance re-execution keeps its inherited
request link and immutable lineage. Existing workspace/application/stage/owner,
retest, completion and certificate checks remain enforced. Deploy matching
frontend/backend versions together. Regression evidence and scope limits are in
`validation/cycle-preview-2026-10-15/report.json`.

### Functional testing handoff visibility (2026-10-15)

After tester assignment, the normal Functional Request drawer shows the testing
path through Test Design, Execution, QA Completed and Clearance. At Tester
Assigned and Test Design it names the assigned testers and the next action.
Start Test Design and Start Execution remain available to the current assigned
testers; QA managers retain their existing reassignment and clearance authority.
The cycle request preview stays read-only. No backend permission or lifecycle
transition was changed. Regression evidence and the read-only inspection of
`TQA-FUNC-02` are in `validation/functional-testing-handoff-2026-10-15/report.json`.

### Admin Recovery & Corrections (2026-10-16)

Open **Admin → Recovery & Corrections** in the owning workspace. System
Administrators can preview and apply a same-workspace project migration or a
named request recovery, with a required reason and an atomic recovery receipt.
The request picker opens the existing shared request viewer for full context.

Project migration **relocates existing records**, rather than creating copies
or merely adding destination references. Moved testcases and cycles disappear
from the source project's content lists and appear only in the destination.
IDs, testcase versions, pinned versions, execution slots, attempts, retest
outcomes, attachments, defect links, closure and stage owners are preserved.
Whole-project migration also moves repository/cycle folders and their existing
access rules. Partial selections expand to include connected cases, cycles and
re-execution lineage. Restricted cycle folders move with all their cycles and
access rules. Other partial selections become Unfiled in the destination, with
original folder locations retained in the receipt.

The preview rejects foreign-workspace content, inactive projects, destination
duplicates, shared records outside the connected move, incompatible request
applications and reviewed/issued certificate dependencies. Correcting an
application classification requires an explicit acknowledgement that the
recorded testing was performed for the destination application. It does not
turn testing performed against another application into valid evidence. The
utility supports up to 5,000 connected testcases and 25,000 watched records in
one interactive operation; larger populations need independent selections.

Request recovery offers **Return to requester**, **Recover responsible owner**,
**Return to fresh QA review**, and SAST/DAST **Internal hold**, only at eligible
stages. The Raised gateway retains its child workflows. Recovery uses their
existing return/resubmit and security-obstacle flows, preserves analyst/tester
assignments and evidence, and resets applicable readiness verification for
fresh review. It cannot fabricate approvals or set arbitrary completion,
closure or certificate states. Active security obstacles use their existing
review/routing controls. Certificates remain subject to the established
clearance review/amendment process.

Previews expire after 30 minutes. Applying requires the original administrator,
current workspace authorization and an unchanged dependency fingerprint. Row
locks fail promptly when work is busy; retries cannot apply a committed job
twice. History records the administrator, reason, impact and before/after
classification or stage values. An applied migration can be reversed only
while its affected project records remain unchanged; reversal is also audited.
Ordinary project ownership and business workflow permissions remain enforced.

Deploy matching frontend/backend versions and apply additive, restartable
migration `a41d9e7c2b60` after `f81b2c6d9a30`. Migration rollback retains recovery
receipts. Validation evidence is in `validation/admin-recovery-2026-10-16/`.

### Bank Staff and vendor organization profiles

User type is derived on the server: LDAP login IDs beginning with `b` (case
insensitive) are **Bank Staff**; other LDAP identities are **Vendor**. Standard
local accounts, including existing QA and Administrator test accounts, retain
their existing login and profile behavior and display **Standard account**.
Classification is identity metadata and grants no roles, approval authority or
workspace access. No existing usernames, passwords, roles or assignments are
rewritten by migration `b72e6a9c4d30` (after `a41d9e7c2b60`).

Vendors without an organization complete profile setup after the existing email
and department steps, before entering the portal. The shared picker shows a
searchable list of active organizations and a separate **Add organization**
action. An empty directory opens the organization-name field directly, with
guidance that the name is added when the profile is saved. Setup keeps its save
action in the form and provides explicit logout. New names are normalized for
Unicode, capitalization and whitespace to avoid duplicate organizations.
Selection/creation and the profile audit commit
together. Reloading an established profile does not prompt again. Logout and
retry remain available during setup. The core API and separate Document Portal
enforce the same setup boundary while leaving self-service setup reachable.

Admin → People shows **User Type** and **Vendor Organization**, supports user type
filtering and organization-name search, and offers **Vendor profile** corrections
for vendor LDAP users only. Reasons and original profile values are required for
audited corrections, clearing an organization or granting/removing a system/test
profile exemption. This exemption affects only organization setup. Standard
accounts and Bank Staff cannot be changed through this endpoint. LDAP user
creation and first-login provisioning otherwise retain their existing access
review policies.

Admin → System tools → **Vendor organizations** creates, renames, deactivates or
reactivates organization names. Rename/status changes require a reason and the
current revision; stale edits are rejected. Deactivation prevents new selection
while retaining existing affiliations and audit history. Organizations are not
deleted. The user access workbook includes user type, organization and pending
setup/exemption metadata. The directory starts empty; no vendor names are seeded.

API routes: `/api/vendor-organizations`,
`PATCH /api/auth/me/vendor-organization`, and admin-only
`PATCH /api/auth/users/{user_id}/vendor-profile`. Validation evidence is in
`validation/vendor-profiles-2026-10-16/`.
