# Centralized QA Portal

A full-stack application built from the **"Centralized QA Portal Creation"** change request
(Bank of Maharashtra, Information Technology Department, FY 2026-27).

- **Frontend:** micro-frontend architecture — a **Workspace shell** plus **4 independently
  built/deployed modules** (Functional, Security, Specialised Testing, Governance), wired
  together with Webpack/Vite **Module Federation** at runtime (see
  [Frontend architecture](#frontend-architecture)). React 18 + Vite throughout.
- **Backend:** FastAPI + SQLAlchemy (used purely as the Oracle query/ORM layer, not for
  database portability), JWT authentication, RBAC across 9 roles. One deployable API — the
  module split is a frontend concern only.
- **Database:** Oracle only. The app reads `DATABASE_URL` and refuses to start without an
  Oracle connection string — there is no SQLite or other fallback (see
  [Database setup](#database-setup)).

## Module coverage

Reflects the routers actually registered in `backend/app/main.py` and the frontend package
that renders each one.

| Backend router | Frontend module | What it covers |
|---|---|---|
| `auth.py` | Shell (Login) | JWT login, `/auth/me`, user directory, Admin CRUD |
| `qa_requests.py` | Shell (QA Requests) | The cross-module request gateway/inbox — raise a request, pick its type, route it |
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
| `departments.py` | Shell + Admin | Department master data used across request forms |

Every write endpoint is RBAC-checked via `app/deps.require_roles`, and every state change is
written to the `approval_actions` audit table. JWT auth stands in for AD/LDAP integration —
real LDAP bind support is already implemented (see
[Authentication & the Admin section](#authentication--the-admin-section)), not just a stub.

## Frontend architecture

The frontend is an **npm workspaces monorepo** at `frontend/`, with 6 independent packages:

```
frontend/
  package.json              # workspaces root — no deps of its own
  packages/
    shared/                 # @qa-portal/shared — NOT a published package, consumed via a
                             # Vite/TS path alias (no install/symlink step needed). Holds
                             # api.ts, types.ts, constants.ts, AuthContext, index.css, and
                             # the truly common widgets (Table incl. the filter popover,
                             # SearchableSelect, UserAssignSelect, RequestDocuments, Icons).
                             # This is the "common things like filter button" that stays
                             # shared so no module has to reimplement or diverge on it.
    shell/                  # @qa-portal/shell — Login, Dashboard shell, QA Requests gateway,
                             # app chrome/Layout/routing. Loads the 4 modules below as Module
                             # Federation *remotes* at runtime.
    functional/              # @qa-portal/module-functional — Functional QA
    security/                 # @qa-portal/module-security — SAST, DAST, Suppression
    specialised-testing/       # @qa-portal/module-specialised-testing — Automation, Performance
    governance/                 # @qa-portal/module-governance — Sign-off, Approvals, Reports, Admin
```

Each of `shell`/`functional`/`security`/`specialised-testing`/`governance` is a **fully
independent Vite project** — its own `package.json`, `vite.config.ts`, `tsconfig.json`,
`Dockerfile`, and version. It can be built, tested, deployed, and rolled back **without
touching the other four**. This directly satisfies "any changes in module will not impact on
other module except common things like filter button etc": a change inside `packages/security`
only ever produces a new `security` image; the shell and the other 3 modules are untouched and
don't need to be rebuilt or redeployed.

Wiring, via [`@originjs/vite-plugin-federation`](https://github.com/originjs/vite-plugin-federation):

- Each module's `vite.config.ts` **exposes** its top-level page components, e.g. security
  exposes `./SAST`, `./DAST`, `./Suppression` and builds a `remoteEntry.js` alongside its
  normal bundle.
- The shell's `vite.config.ts` declares those 4 modules as **remotes** and loads their
  components with ordinary `React.lazy(() => import('security/SAST'))` + `<Suspense>` — from
  the shell's own code, a remote module looks just like a lazy-loaded local one.
- `shared: ['react', 'react-dom', 'react-router-dom']` is set identically on the shell and
  every module, so at runtime they all share one React instance instead of five (required —
  otherwise hooks/context break across the federation boundary).
- Each module can also run **standalone** (`npm run dev` inside `packages/security`) for
  isolated development, since it's a real independent app, not just a folder of components.

**Known limitation — remote URLs are resolved at the shell's *build* time, not at runtime.**
This is a documented limitation of the plugin's basic `remotes` config (true runtime
resolution needs `@module-federation/runtime`, which isn't used here). In practice this means:
redeploying a module (e.g. shipping a new `security` image) does **not** require touching the
shell, but pointing the shell at a *new URL/host* for a module does require rebuilding and
redeploying just the shell with new `VITE_*_REMOTE_URL` build args — see
[Deployment](#deployment). Module code changes are fully independent; module *address*
changes are not.

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
  frontend/
    package.json            # npm workspaces root
    packages/
      shared/                # @qa-portal/shared (see Frontend architecture)
      shell/                  # @qa-portal/shell — the Workspace shell, Dockerfile, nginx.conf
      functional/              # @qa-portal/module-functional — Dockerfile, nginx.conf
      security/                 # @qa-portal/module-security — Dockerfile, nginx.conf
      specialised-testing/       # @qa-portal/module-specialised-testing — Dockerfile, nginx.conf
      governance/                 # @qa-portal/module-governance — Dockerfile, nginx.conf
  docker-compose.yml         # convenience orchestration for all 6 images + notes on limits
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

One `npm install` at the workspace root installs every package (shared + shell + 4 modules)
in one go, since they're all workspaces of the same root `package.json`:

```bash
cd frontend
npm install
```

Then run the shell and however many modules you're actively working on, each as its own dev
server:

```bash
npm run dev:shell                  # http://localhost:5173
npm run dev:functional             # http://localhost:5001
npm run dev:security                # http://localhost:5002
npm run dev:specialised-testing      # http://localhost:5003
npm run dev:governance                # http://localhost:5004
```

Open `http://localhost:5173` — the shell loads each module from the ports above (see
`packages/shell/vite.config.ts`, defaults already point at `localhost:5001`-`5004`) and proxies
`/api/*` to `http://localhost:8000` (see `packages/shell/vite.config.ts` → `server.proxy`), so
no CORS configuration is needed locally. You only need the shell plus the specific module(s)
you're changing running at once — the others can be left stopped if you're not touching them.

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

Every frontend image's build **context must be `frontend/`** (the workspace root), not the
individual package folder — each module needs its sibling `packages/shared` source, and the
shell needs the root `package.json`'s `workspaces` field. Each Dockerfile documents its own
exact command in a header comment; summarized:

```bash
# Backend — standalone, no build args
docker build -f backend/Dockerfile -t qa-portal-backend backend

# Each module — standalone, no build args (nothing module-specific to bake in)
docker build -f frontend/packages/functional/Dockerfile          -t qa-portal-functional          frontend
docker build -f frontend/packages/security/Dockerfile             -t qa-portal-security             frontend
docker build -f frontend/packages/specialised-testing/Dockerfile   -t qa-portal-specialised-testing   frontend
docker build -f frontend/packages/governance/Dockerfile             -t qa-portal-governance             frontend

# Shell — needs the 4 modules' real remoteEntry.js URLs as build args (see the "Known
# limitation" note above); the values below are placeholders, use your real deployed URLs
docker build -f frontend/packages/shell/Dockerfile frontend \
  --build-arg VITE_FUNCTIONAL_REMOTE_URL=https://functional.example.com/assets/remoteEntry.js \
  --build-arg VITE_SECURITY_REMOTE_URL=https://security.example.com/assets/remoteEntry.js \
  --build-arg VITE_SPECIALISED_TESTING_REMOTE_URL=https://specialised-testing.example.com/assets/remoteEntry.js \
  --build-arg VITE_GOVERNANCE_REMOTE_URL=https://governance.example.com/assets/remoteEntry.js \
  --build-arg VITE_BACKEND_URL=https://api.example.com \
  -t qa-portal-shell
```

Each of the 6 images above is independently versioned/tagged/pushed/rolled back — there is no
"one release" for the frontend. A `security`-only bugfix ships as a new `qa-portal-security`
image and a redeploy of just that one container; the shell, functional, specialised-testing,
and governance containers are untouched.

### Running everything together (docker-compose)

`docker-compose.yml` at the repo root builds and runs all 6 services (backend + shell + 4
modules) for convenience — e.g. a local staging environment — using `localhost:500x` as the
remote URLs, which only works because everything is on one machine:

```bash
docker compose up --build
# Shell:   http://localhost:8080
# API:     http://localhost:8000
```

Point `DATABASE_URL` at your Oracle instance via an env var or `.env` file next to
`docker-compose.yml` (defaults to `host.docker.internal`, which reaches an Oracle container or
host-installed Oracle from inside Docker on Mac/Windows; on Linux use the host's real IP or
`--add-host`). See the comments at the top of `docker-compose.yml` for the full explanation of
why remote URLs are browser-resolved, not container-to-container, and why that matters for a
real multi-host deployment (each `VITE_*_REMOTE_URL` must then be a public URL, not
`localhost`).

**docker-compose is not a requirement to deploy this way** — each image can equally be pushed
to a registry and deployed independently on Kubernetes/ECS/whatever the bank's platform is, one
Deployment/Service per image, which is the actual point of splitting them.

### Verification status

This project was authored and Docker/Compose files written in a sandboxed environment with
**no Docker daemon and no npm registry access** (`docker` isn't installed there;
`npm view react version` returned `403 Forbidden`). As a result:

- ✅ Verified in-sandbox: all 5 frontend packages (`shell`, `functional`, `security`,
  `specialised-testing`, `governance`) pass `tsc --noEmit` cleanly — source-level TypeScript
  correctness, including the `@qa-portal/shared` path alias and the Module Federation
  `remotes.d.ts` ambient declarations, is confirmed.
- ⚠️ **Not verified anywhere**: `npm install` for `@originjs/vite-plugin-federation` and the
  rest of the new devDependencies, an actual `vite build` producing a working `remoteEntry.js`,
  and any `docker build`/`docker compose up` execution. These were written by hand following
  well-established, widely-documented patterns for this plugin and for multi-stage Docker
  builds, but **please run a real `npm install` + `npm run build:all` and a
  `docker compose up --build` smoke test on your own machine** before relying on this in
  production.

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
- Each frontend module's `Access-Control-Allow-Origin: "*"` in its `nginx.conf` (needed for the
  shell to fetch `remoteEntry.js` cross-origin) should be tightened to the shell's real origin
  in production rather than left wide open.
- Pin exact versions (not just matching ranges) of `react`/`react-dom`/`react-router-dom`
  across the shell and all 4 modules — Module Federation's `shared` singleton config assumes
  compatible versions; independent deploys make it easy for these to drift apart over time.

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
- Module Federation remote URLs are resolved at the shell's build time, not runtime — see
  "Known limitation" under [Frontend architecture](#frontend-architecture).
- See [Verification status](#verification-status) above: `npm install`, `vite build`, and
  `docker build`/`docker compose up` have not been executed in the authoring environment and
  should be smoke-tested before relying on this in production.
