# Centralized QA Portal

A full-stack application built from the **"Centralized QA Portal Creation"** change request
(Bank of Maharashtra, Information Technology Department, FY 2026-27). It covers all 11
functional modules and the non-functional requirements described in that document.

- **Frontend:** React 18 + Vite (single-page app, role-aware navigation)
- **Backend:** FastAPI + SQLAlchemy (used purely as the Oracle query/ORM layer, not for
  database portability), JWT authentication, RBAC across 9 roles
- **Database:** Oracle only. The app reads `DATABASE_URL` and refuses to start without an
  Oracle connection string — there is no SQLite or other fallback (see
  [Database setup](#database-setup)).

## Module coverage

| # | Module (from CR doc) | Backend | Frontend |
|---|---|---|---|
| 1 | QA Request Management (request form, readiness checklist, walkthroughs, workflow) | `app/routers/qa_requests.py` | `QA Requests` page |
| 2 | Test Case Repository (attributes, versioning, review workflow) | `app/routers/test_cases.py` | `Test Case Repository` page |
| 3 | Test Execution Management (test runs, execution status, metrics) | `app/routers/test_runs.py` | `Test Execution` page |
| 4 | SAST Request Management | `app/routers/sast_dast.py` | `SAST Requests` page |
| 5 | DAST Request Management | `app/routers/sast_dast.py` | `DAST Requests` page |
| 6 | False Positive / Suppression Management | `app/routers/suppression.py` | `Suppression` page |
| 7 | Approval Workflow Engine | `app/models.ApprovalAction` + decision endpoints on each module | `Approval Workflow Log` page |
| 8 | QA Sign-off Management | `app/routers/signoff.py` | `QA Sign-off` page |
| 9 | Dashboard & Analytics (project-wise, QA-wise, security, suppression, 3W) | `app/routers/dashboard.py` | `Dashboards` page |
| 10 | Reports (operational / security / management) | `app/routers/reports.py` | `Reports & Export Centre` page |
| 11 | Download & Export Centre (Excel/PDF/CSV, metadata, RBAC) | `app/routers/export.py` | `Reports & Export Centre` page |

Non-functional requirements: JWT-based auth stands in for AD/LDAP integration (swap the
`authenticate` call in `app/routers/auth.py` for an LDAP bind when ready), RBAC is enforced
on every write endpoint via `app/deps.require_roles`, and every state change is written to
the `approval_actions` audit table for retention/audit-trail purposes.

## Repository layout

```
qa-portal/
  backend/
    app/
      main.py            # FastAPI app, router registration
      models.py           # SQLAlchemy models targeting Oracle
      schemas.py           # Pydantic request/response schemas
      auth.py, deps.py    # JWT auth + RBAC dependency
      constants.py         # Roles, statuses, dropdown options (mirrors the CR doc)
      seed.py               # Demo data loader
      routers/               # One router per module (see table above)
    requirements.txt
    .env.example
  frontend/
    src/
      pages/                # One page per module
      components/           # Shared UI (Layout, Table, Modal, etc.)
      context/AuthContext.jsx
      api.js                # Fetch wrapper + JWT handling
    package.json
    vite.config.js
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

All tables are prefixed `qap_` (e.g. `qap_users`, `qap_requests`, `qap_test_cases`) so this
app's schema won't collide with any other application's tables (like a generic `users` table)
that may already exist in a shared Oracle instance/schema.

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
(this is already the default in `backend/.env.example`).

## Quickstart

Requires Python 3.10+, Node 18+, and a reachable Oracle database (see above). This project
was authored in a sandboxed environment without PyPI/npm/Oracle access, so dependencies have
**not** been installed and the app has **not** been executed — install and run it on your
own machine.

### 1. Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate


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
npm run dev
```

Open `http://localhost:5173`. The Vite dev server proxies `/api/*` to
`http://localhost:8000` (see `vite.config.js`), so no CORS configuration is needed locally.

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
the Administrator role) is a full user directory at `/admin`:

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
- QA Request supporting documents are uploaded (multiple files per request) and stored on
  local disk under `backend/app/uploads/<request_id>/`. For production, point this at shared/
  durable storage (network share, S3-compatible object store) instead of local disk — see
  `UPLOAD_ROOT` in `app/routers/qa_requests.py`. The SAST source-code and DAST supporting-doc
  fields on other modules still store a path string only and would need the same treatment.
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
- `/api/qa-requests` — CRUD + `/lead-decision`, `/allocate`, `/start-testing`, `/complete`,
  `/checklist`, `/walkthroughs`, `/documents` (multi-file upload/list), `/documents/{id}/download`,
  `/history`
- `/api/test-cases` — CRUD + `/bulk`, `/review`, `/versions`, `/archive`
- `/api/test-runs` — CRUD + `/cases/{id}` (execution status), `/metrics`
- `/api/sast-requests`, `/api/dast-requests` — CRUD + `/decision`, `/findings`, `/close`
- `/api/suppressions` — CRUD + `/app-owner-decision`, `/dept-head-decision`
- `/api/signoffs` — CRUD + `/issue`
- `/api/approvals` — cross-module audit/decision feed
- `/api/dashboard/*` — project-wise, qa-wise, security, suppression, and the `/3w`
  ("what's pending, where, since when") dashboard from section 4.9.8
- `/api/reports/*` and `/api/export/{report_key}?format=xlsx|pdf|csv` — Module 10/11

## Known limitations / next steps

- Ageing in the 3W dashboard is computed from `updated_at` timestamps (a reasonable proxy
  for "since when it has been pending"); wire in SLA thresholds/escalation matrices per your
  bank's policy if you need automatic escalation emails.
- RBAC is enforced per-endpoint (who can perform which action); if you need row-level
  visibility restrictions (e.g., a Requester should only see their own department's
  requests), add query filters in the relevant router's `list_*` functions.
- This was built and syntax-validated without live execution (no PyPI/npm registry access
  and no Oracle instance reachable in the authoring sandbox) — run
  `pip install -r requirements.txt` / `npm install` against a real Oracle database, then
  smoke-test the flows above before relying on it.
