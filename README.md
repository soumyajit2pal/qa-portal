# QualityOps — Enterprise Quality Operations Platform

A full-stack quality operations platform built from the **"Centralized QA Portal Creation"** change request
(Bank of Maharashtra, Information Technology Department, FY 2026-27).

- **Frontend:** a single React 18 + Vite SPA (one build, one deploy). Internally organized by
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
  docker-compose.static-ip.yml # stable nginx address for trusted-proxy deployments
  .env.dev.example, .env.uat.example, .env.prod.example
  README.md
```

## Database setup

This application connects to **Oracle only** — `app/database.py` reads `DATABASE_URL` at
startup and raises an error immediately if it is missing or not an `oracle+oracledb://` URL.
The SQLAlchemy models use portable column types, so no Oracle-specific SQL was needed, but
no other database backend is supported or tested.

### Option A — point at your bank's Oracle instance

```bash
export DATABASE_URL="oracle+oracledb://QA_PORTAL:your_password@dbhost:1521/?service_name=ORCLPDB1"
```

The `QA_PORTAL` user needs `CREATE TABLE`/`CREATE SEQUENCE` privileges the first time you run
`alembic upgrade head`. Existing environments that predate Alembic may need to adopt the baseline once; see
[`backend/MIGRATIONS.md`](backend/MIGRATIONS.md) before applying or generating migrations.

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

## Quickstart (local dev, no Docker)

Requires Python 3.10+, Node 24 LTS, and a reachable Oracle database (see above).

### 1. Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp ../.env.dev.example ../.env.dev
# Edit ../.env.dev: DATABASE_URL and SECRET_KEY are required placeholders.
export APP_ENV=dev              # selects ../.env.dev via the root-profile fallback

alembic upgrade head             # creates or upgrades the schema
DEMO_SEED_PASSWORD='<unique temporary password>' python -m app.seed
                                 # seeds demo users, departments, and Default Workspace
# Continue using `alembic upgrade head` before every deployment.
uvicorn app.main:app --reload --port 8000
```

The API is now at `http://localhost:8000`, with interactive docs at
`http://localhost:8000/docs`.

### Configuration profiles

The backend supports Spring-style configuration profiles through `APP_ENV`.
For direct Uvicorn, seed, and Alembic runs, configuration is loaded in this
order (highest precedence first): process environment,
`backend/.env.<APP_ENV>`, `backend/.env`, then typed application defaults. If
the backend-specific profile does not exist, the matching repository-root
`.env.<APP_ENV>` file is used, allowing the same complete UAT profile to run
under Compose or direct Uvicorn. When `backend/.env` is absent, the
unprofiled root `.env` may select `APP_ENV`; its other values are deliberately
not loaded by direct host runs because they may contain container-only paths.
Profile names may contain letters, numbers, underscores, and hyphens.

```bash
cd backend
cp ../.env.uat.example ../.env.uat
# Populate required database, secret, hostname, certificate and key settings.
# One-time direct-host key provisioning (the generator refuses to overwrite):
python -m app.generate_login_key login-private.pem
APP_ENV=uat uvicorn app.main:app --port 8000 --proxy-headers --forwarded-allow-ips=127.0.0.1
APP_ENV=uat alembic upgrade head
```

UAT application traffic requires HTTPS. The Uvicorn command above is a private
upstream for a trusted loopback TLS proxy, not a browser URL. For local Vite UAT,
set `TLS_CERT_HOST_PATH` in the selected environment file to the directory containing
`qualityops.crt` and `qualityops.key`, and run `npm run dev -- --mode uat` from
frontend. Relative certificate directories resolve from the repository root,
matching Compose. Vite builds do not require certificate files. Open `https://localhost:5173`
using a certificate that includes localhost. Vite derives forwarded scheme from
the actual TLS socket. See `UAT_HTTPS_Recovery.md` for direct and Compose cases.

The active profile is included as `profile` in `/api/health` without exposing
any configuration values or secrets.

### Logging modes

Backend logging is controlled by the active environment profile:

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

The frontend image copies `frontend/nginx.conf`. Nginx serves the SPA over TLS, sends
`/api/document-portal/*` to the isolated `document_portal` service, and sends the remaining
`/api/*` traffic to `backend`. The browser therefore uses one origin and never receives a direct
Python-service address. The three services must share a container network where those two service
names resolve, as they do in the supplied Compose files. A different topology must provide an
equivalent TLS reverse-proxy configuration and trusted-proxy address.

### Running everything together (docker-compose)

```bash
# Local development profile (still served through nginx TLS)
cp .env.dev.example .env.dev
# Populate DATABASE_URL, SECRET_KEY, certificate path, and login-key settings.
# One-time Compose key provisioning (the generator refuses to overwrite):
mkdir -p secrets
chmod 700 secrets
(cd backend && python -m app.generate_login_key ../secrets/login-private.pem)
docker compose --env-file .env.dev up --build

# UAT/deployed profile. The static overlay gives nginx the exact address
# configured in FORWARDED_ALLOW_IPS.
cp .env.uat.example .env.uat
# Replace every placeholder and review PORTAL_SUBNET before starting.
docker compose -f docker-compose.yml -f docker-compose.static-ip.yml \
  --env-file .env.uat up --build -d

# Portal and same-origin API: https://localhost:8080
# `backend` and `document_portal` are internal-only; no Python port is
# published on the host.
```

Each root profile file is a complete Compose environment and includes both
`APP_ENV=uat` and `APP_ENV_FILE=.env.uat` (using the matching profile name).
Compose uses `APP_ENV_FILE` as each Python service's `env_file`; variables set
directly by the deployment environment continue to take precedence. Use
`.env.dev.example`, `.env.uat.example`, and `.env.prod.example` as safe
templates, and do not commit populated profile files containing secrets.

Set `DATABASE_URL` explicitly in the selected profile; there is no database-host default. The
hostname in that URL must be reachable from the backend containers. `localhost` inside a container
means that container itself, not the Docker host or a separately running Oracle instance.

The core backend runs 4 worker processes by default (`WEB_CONCURRENCY`, see `backend/Dockerfile`) and
a `redis` service is included and wired up by default (`REDIS_URL`) for shared dashboard and
reference-data caching across workers (see `backend/app/cache.py`). If Redis is unavailable, cache
operations safely become misses; correctness does not depend on stale per-process caches. Startup
file maintenance is coordinated separately with a lock on the shared upload filesystem.

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

Long-running imports and exports are also queued with `BACKGROUND_JOB_WORKERS` (default `2`) per
backend worker. Those jobs each use their own database session, so include this bounded number in
operational capacity planning and keep it below the main request pool size.

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
SMTP_USERNAME=qa-portal@example.com
SMTP_PASSWORD=your-secret
SMTP_FROM_ADDRESS=qa-portal@example.com
SMTP_FROM_NAME=QA Portal
SMTP_STARTTLS=true
SMTP_SSL=false
PORTAL_BASE_URL=https://qa-portal.example.com
```

Use exactly one TLS mode: STARTTLS (normally port 587) or implicit SSL/TLS
(normally port 465, set `SMTP_SSL=true` and `SMTP_STARTTLS=false`). Delivery
retries transient failures with bounded backoff and does not roll back a
business action when a relay is unavailable. The outbox notifies request
participants, assignees, and role-eligible approvers at their workflow step;
users without an email address are skipped.

### Enable HTTPS

The frontend terminates TLS in nginx and publishes container port 443 on host port 8080. Keep the
certificate and private key outside the image. Set one host directory in the environment file
selected at deploy time; that directory must contain `qualityops.crt` and `qualityops.key`:

```env
# .env.uat
TLS_CERT_HOST_PATH=./certs/

# .env.prod (relative to the directory containing docker-compose.yml)
TLS_CERT_HOST_PATH=./certs/
```

The directory and both required files must already exist and be readable before `compose up`:

```text
certs/
├── qualityops.crt
└── qualityops.key
```

The required-variable check in `docker-compose.yml` stops early when the directory setting is
omitted. The same frontend image can therefore be promoted unchanged; certificates and private
keys are mounted at runtime and excluded from both source control and Docker build contexts.

For local localhost UAT only, the repository contains one certificate helper:

```bash
python3 scripts/generate-local-uat-tls.py
```

It creates or reuses `certs/qualityops-uat-ca.crt` and its private CA key, backs up an existing
leaf pair, and generates `qualityops.crt`/`qualityops.key` for `localhost`, `127.0.0.1`, and `::1`.
Trust only `qualityops-uat-ca.crt` on the local test device; never distribute either `.key` file.
For a real DNS name or network IP, obtain a certificate with the correct subject alternative name
from the organization's certificate process and place the resulting files under the configured
host directory using the two required filenames.

This repository does not contain certificate-issuance/renewal automation, an HTTP listener, or an
HTTP-to-HTTPS redirect. Nginx listens only on container port 443, mapped by Compose to host port
8080, so the Compose URL is `https://<host>:8080`. Certificate issuance and renewal are operator
responsibilities; after replacing a mounted certificate, recreate or reload the frontend container.
If an external load balancer terminates public TLS, it must either re-encrypt to this nginx TLS
listener or the deployment must supply and review a different frontend configuration. The Python
services must remain private, and their `FORWARDED_ALLOW_IPS` value must trust only the actual
nginx/reverse-proxy peer.

### Verification status

Current verification includes the complete backend pytest suite under the pinned dependencies,
backend compile/import checks, Python dependency auditing, frontend TypeScript and Node tests, the
Vite production build, and base/static-overlay `docker compose config` validation. A real image
build and live Oracle-backed Compose smoke test were not run here and remain required in the target
deployment environment before promotion.

## Authentication & the Admin section

Every user account has a `login_type` of either **Standard** or **LDAP**:

- **Standard** accounts store a local bcrypt password hash and log in the usual
  username/password way.
- **LDAP** accounts have no local password at all — every login attempt is verified live
  against your directory server (`app/auth.py::ldap_authenticate`). Configure the connection
  via `LDAP_*` variables in the selected deployment profile (two binding strategies are supported:
  search-then-bind with a service account, or a direct DN template). Seeded demo users are all
  Standard; there's no seeded LDAP account since it depends on a real directory to test against.

**LDAP accounts are provisioned just-in-time, not pre-created.** An admin does *not* need to
create an LDAP user up front. The first time someone logs in with a username the app doesn't
recognize, it attempts an LDAP bind with the credentials they supplied. A successful bind creates
a local `User` row (`login_type=LDAP`, with profile fields filled from the directory when available)
without granting an application role. The user selects a department and submits an access request,
then remains blocked at the sign-in screen until a System Administrator or a coordinator for that
department assigns the permitted roles and approves the request. Approval also places the user in
the active workspace selected by the reviewer. Failed LDAP credentials return the same
"Invalid username or password" response as any other failed sign-in and do not create an account.

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
  containers; see `backend/MIGRATIONS.md`.
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
  `X-Forwarded-For` and sets `X-Forwarded-Proto`; Uvicorn accepts that scheme only from
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

Cookie/CSRF browser regression checks are in `frontend/tests/token-renewal.cjs`; backend session
coverage is in `backend/tests/test_session_security.py`.


### Login payload encryption

Login now requires encrypted JSON. Deploy backend/frontend images together and provision the private RSA key before starting the release; see `Login_Encryption_Deployment.md`. Compose mounts `LOGIN_ENCRYPTION_KEY_HOST_DIR` (default `./secrets`) read-only in backend, separate from uploads. The old plaintext form API is rejected. HTTPS and a trusted proxy allowlist remain required.
