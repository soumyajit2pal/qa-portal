# Centralized QA Portal

A full-stack application built from the **"Centralized QA Portal Creation"** change request
(Bank of Maharashtra, Information Technology Department, FY 2026-27).

- **Frontend:** a single React 18 + Vite application (see
  [Frontend architecture](#frontend-architecture)). Functional, Security, Specialised Testing,
  and Governance are route-level areas within the one app/build/deploy, not separate
  applications.
- **Backend:** FastAPI + SQLAlchemy (used purely as the Oracle query/ORM layer, not for
  database portability), JWT authentication, RBAC across 9 roles. One deployable API.
- **Database:** Oracle only. The app reads `DATABASE_URL` and refuses to start without an
  Oracle connection string — there is no SQLite or other fallback (see
  [Database setup](#database-setup)).

## Module coverage

Reflects the routers actually registered in `backend/app/main.py` and the frontend area
that renders each one (see `frontend/src/modules/`).

| Backend router | Frontend area | What it covers |
|---|---|---|
| `auth.py` | Login | JWT login, `/auth/me`, user directory, Admin CRUD |
| `qa_requests.py` | QA Requests | The cross-module request gateway/inbox — raise a request, pick its type, route it |
| `functional.py` | **Functional** | Functional QA request lifecycle: SM/dept-head decisions, readiness checklist, walkthroughs, planning → test design → execution → defects → retest → regression → sign-off, documents, history |
| `sast_dast.py` | **Security** | SAST and DAST request lifecycle: readiness, scan configuration/execution, findings, walkthroughs, documents, history |
| `suppression.py` | **Security** | False-positive/suppression requests: app-owner and dept-head decisions, security-team decision, walkthroughs, documents, history |
| `automation.py` | **Specialised Testing** | Automation request lifecycle: feasibility, engineer assignment, script development, review, CI/CD integration, sign-off |
| `performance.py` | **Specialised Testing** | Performance testing lifecycle: readiness, baseline, load test, result analysis, defect fix/retest, report, sign-off |
| `approvals.py` | **Governance** | Cross-module approval/audit feed (`/approvals`, `/approvals/pending-mine`) |
| `signoff.py` | **Governance** | Formal QA sign-off issuance, history, documents |
| `dashboard.py` | **Governance** (Dashboards) | Project-wise, QA-wise, security, suppression, and 3W ("what's pending, where, since when") dashboards |
| `reports.py` | **Governance** (Reports) | Operational/security/management report data (QA summary, SAST/DAST scan, vulnerability trend, severity distribution, suppression register, monthly KPI, quality scorecard, audit evidence) |
| `export.py` | **Governance** (Reports) | Excel/PDF/CSV export of the above, with RBAC |
| `departments.py` | QA Requests + Admin | Department master data used across request forms |

Every write endpoint is RBAC-checked via `app/deps.require_roles`, and every state change is
written to the `approval_actions` audit table. JWT auth stands in for AD/LDAP integration —
real LDAP bind support is already implemented (see
[Authentication & the Admin section](#authentication--the-admin-section)), not just a stub.

## Frontend architecture

The frontend is a **single React + Vite application** at `frontend/` — one `package.json`, one
`vite.config.ts`, one build, one Docker image:

```
frontend/
  package.json
  vite.config.ts
  src/
    main.tsx              # entry point — BrowserRouter + AuthProvider + <App/>
    App.tsx                # routes, incl. auth guard (Protected) and route-level lazy() chunks
    Login.tsx, Dashboard.tsx, QARequests.tsx   # cross-cutting pages
    components/
      Layout.tsx            # app chrome — sidebar/topbar/nav
    modules/                # one folder per domain area — plain route-level code, no
                             # federation, no separate build
      functional/           # Functional QA
      security/             # SAST, DAST, Suppression
      specialisedTesting/   # Automation, Performance
      governance/           # Sign-off, Approvals, Reports, Admin
    shared/                 # api.ts, types.ts, constants.ts, AuthContext, index.css, and the
                             # common widgets (Table incl. the filter popover, SearchableSelect,
                             # UserAssignSelect, RequestDocuments, Icons) — imported via the
                             # `@qa-portal/shared` alias (see vite.config.ts / tsconfig.json)
```

Each domain area under `src/modules/` is loaded with ordinary `React.lazy()` + `<Suspense>`
(see `App.tsx`) purely for route-based code-splitting — this is a normal dynamic `import()`
resolved at build time by Vite, not a runtime remote fetch. There is no Module Federation, no
per-module `Dockerfile`/`nginx.conf`, and no build-time-baked remote URL to keep in sync: a
change to any module ships as part of the same single build/deploy as everything else.

> This project previously used a Module Federation micro-frontend split (a shell +
> 4 independently-built/deployed remotes). That added real operational cost — 5 images, 5
> deploys, remote URLs baked in at the shell's build time — without a corresponding benefit,
> since the app ships as one unit in practice. It was collapsed back into this single app;
> see the git history if you need to reference the old structure.

## Repository layout

```
qa-portal/
  backend/
    app/
      main.py              # FastAPI app, router registration
      models.py            # SQLAlchemy models targeting Oracle
      schemas.py           # Pydantic request/response schemas
      auth.py, deps.py     # JWT auth + RBAC dependency
      constants.py         # Roles, statuses, dropdown options (mirrors the CR doc)
      documents.py         # Shared multi-file upload/list/download helper (all modules)
      seed.py               # Demo data loader
      routers/               # One router per module (see coverage table above)
      uploads/                # Uploaded documents land here at runtime (gitignored)
    requirements.txt
    .env.example
    Dockerfile
  frontend/                 # single React + Vite app (see Frontend architecture)
    package.json
    vite.config.ts
    Dockerfile, nginx.conf
    src/
  docker-compose.yml         # convenience orchestration for backend + frontend
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
`python -m app.seed` (it calls `Base.metadata.create_all()`, see the migrations note below).

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
(this is already the default in `backend/.env.example`). This Oracle container is deliberately
**not** part of `docker-compose.yml` — it's a one-time local dev prerequisite, not something to
tear down/recreate alongside the app services.

## Quickstart (local dev, no Docker)

Requires Python 3.10+, Node 18+, and a reachable Oracle database (see above).

### 1. Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env            # edit DATABASE_URL / SECRET_KEY

python -m app.seed              # creates tables in Oracle + seeds demo users/data
uvicorn app.main:app --reload --port 8000
```

The API is now at `http://localhost:8000`, with interactive docs at
`http://localhost:8000/docs`.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev              # http://localhost:5173, proxies /api/* to http://localhost:8000
```

That's it — one dev server for the whole app. `npm run dev` gives fast HMR across every page,
including the Functional/Security/Specialised Testing/Governance areas under `src/modules/`;
there's no separate build/preview step needed to see them wired up, since they're just
route-level code in this same app.

`npm run build` (`tsc --noEmit && vite build`) produces the production bundle in `dist/`;
`npm run preview` serves that build locally on port 5173.

### Demo accounts

Seeded by `python -m app.seed`, password **`Password@123`** for all:

| Username | Role |
|---|---|
| `requester1` | Requester (Developer) |
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

```bash
docker build -f backend/Dockerfile -t qa-portal-backend backend
docker build -f frontend/Dockerfile -t qa-portal-frontend frontend
```

One frontend image, one backend image — a bugfix anywhere in the frontend ships as a new
`qa-portal-frontend` image and a single redeploy.

### Running everything together (docker-compose)

```bash
docker compose up --build
# Frontend: http://localhost:8080
# API:      http://localhost:8000
```

Point `DATABASE_URL` at your Oracle instance via an env var or `.env` file next to
`docker-compose.yml` (defaults to `host.docker.internal`, which reaches an Oracle container or
host-installed Oracle from inside Docker on Mac/Windows; on Linux use the host's real IP or
`--add-host`).

**docker-compose is not a requirement to deploy this way** — both images can equally be pushed
to a registry and deployed on Kubernetes/ECS/whatever the bank's platform is.

### Verification status

- ✅ `npm install` + `npm run build` (`tsc --noEmit && vite build`) run clean for the single
  frontend app, producing route-level code-split chunks per module page under `dist/assets/`.
- ⚠️ **Not verified in this environment**: `docker build`/`docker compose up` (no Docker
  daemon available here) and any authenticated end-to-end flow through the UI (no reachable
  Oracle instance available here) — please smoke-test both on your own machine before relying
  on this in production.

## Authentication & the Admin section

Every user account has a `login_type` of either **Standard** or **LDAP**:

- **Standard** accounts store a local bcrypt password hash and log in the usual
  username/password way.
- **LDAP** accounts have no local password at all — every login attempt is verified live
  against your directory server (`app/auth.py::ldap_authenticate`). Configure the connection
  via the `LDAP_*` variables in `backend/.env.example` (two binding strategies are supported:
  search-then-bind with a service account, or a direct DN template). Seeded demo users are all
  Standard; there's no seeded LDAP account since it depends on a real directory to test against.

**LDAP accounts are provisioned just-in-time, not pre-created.** An admin does *not* need to
create an LDAP user up front. The first time someone logs in with a username the app doesn't
recognize, it attempts an LDAP bind with the credentials they supplied; if that succeeds, a
local `User` row is created automatically (`login_type=LDAP`, profile fields best-effort filled
from the directory's `displayName`/`mail`/`department` attributes) and the person is logged in
immediately with the default, lowest-privilege role (`DEFAULT_LDAP_PROVISION_ROLE` in
`app/constants.py`, currently Requester). That new account is flagged `needs_role_review=True`
so it shows up at the top of the Admin section's user table with a "Needs Review" badge — an
admin then assigns the role the person actually needs, which clears the flag. If the
credentials don't authenticate against LDAP, the login simply fails with the same
"Invalid username or password" as any other bad login (no account is created).

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

- Replace `Base.metadata.create_all()` (used for convenience here) with **Alembic**
  migrations before going to production, so Oracle schema changes are versioned.
- Add MFA at the identity-provider layer for LDAP/AD-backed logins, per the non-functional
  requirements (5.1) — this app only performs the LDAP bind, not step-up/MFA.
- Supporting documents are uploaded (multiple files per request, every module) and stored on
  local disk under `backend/app/uploads/<module>/<request_id>/` (see `app/documents.py`). For
  production, point this at shared/durable storage (network share, S3-compatible object store)
  instead of local disk, and mount it as a volume as `docker-compose.yml`/`backend/Dockerfile`
  already do for the local-disk case.
- Set `SECRET_KEY` to a long random value via environment variable/secrets manager, never
  the placeholder in `.env.example`.
- Tune `pool_size`/`max_overflow` in `app/database.py` to your Oracle session limits and
  expected concurrent user count (NFR 5.2).

## API overview

All endpoints are under `/api/*` and require a bearer token from `POST /api/auth/login`
except login itself. Full interactive documentation (request/response schemas, try-it-out)
is auto-generated by FastAPI at `/docs` once the backend is running.

Key endpoint groups:

- `POST /api/auth/login`, `GET /api/auth/me`, `GET /api/auth/users`
- `/api/qa-requests` — CRUD + `/submit`, `/cancel`, `/history`, `/export`, `/documents`
  (multi-file upload/list), `/documents/{id}/download`
- `/api/functional-requests` — CRUD + decision/lifecycle actions, `/checklist`,
  `/walkthroughs` (+ `/acknowledge`), `/history`, `/export`, `/documents`
- `/api/sast-requests`, `/api/dast-requests` — CRUD + decision/lifecycle actions, `/findings`
  (+ `/resolve`), `/walkthroughs` (+ `/acknowledge`), `/history`, `/export`, `/documents`
- `/api/suppressions` — CRUD + `/sm-decision`, `/dept-head-decision`,
  `/security-team-decision`, `/walkthroughs`, `/history`, `/export`, `/documents`
- `/api/automation-requests`, `/api/performance-requests` — CRUD + decision/lifecycle actions,
  `/checklist`, `/walkthroughs`, `/history`, `/export`, `/documents`
- `/api/signoffs` — CRUD + `/issue`, `/history`, `/export`, `/documents`
- `/api/approvals`, `/api/approvals/pending-mine` — cross-module audit/decision feed
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
- RBAC is enforced per-endpoint (who can perform which action); if you need row-level
  visibility restrictions (e.g., a Requester should only see their own department's
  requests), add query filters in the relevant router's `list_*` functions.
- See [Verification status](#verification-status) above: `docker build`/`docker compose up`
  and authenticated end-to-end UI flows have not been executed in this environment and should
  be smoke-tested before relying on this in production.
