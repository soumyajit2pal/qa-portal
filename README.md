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
  database portability), JWT authentication, RBAC across 9 roles. One deployable API.
- **Database:** Oracle only. The app reads `DATABASE_URL` and refuses to start without an
  Oracle connection string — there is no SQLite or other fallback (see
  [Database setup](#database-setup)).

## Module coverage

Reflects the routers actually registered in `backend/app/main.py` and the frontend package
that renders each one.

| Backend router | Frontend area | What it covers |
|---|---|---|
| `auth.py` | `src/Login.tsx` | JWT login, `/auth/me`, user directory, Admin CRUD |
| `qa_requests.py` | `src/QARequests.tsx` | The cross-module request gateway/inbox — raise a request, pick its type, route it |
| `functional.py` | **Functional** (`src/modules/functional/`) | Functional QA request lifecycle: SM/dept-head decisions, readiness checklist, planning → test design → execution → defects → retest → regression → clearance, documents, history |
| `sast_dast.py` | **Security** (`src/modules/security/`) | SAST and DAST request lifecycle: readiness, scan configuration/execution, findings, documents, history |
| `suppression.py` | **Security** (`src/modules/security/`) | False-positive/suppression requests: app-owner and dept-head decisions, security-team decision, documents, history |
| `automation.py` | **Specialised Testing** (`src/modules/specialised-testing/`) | Automation request lifecycle: feasibility, engineer assignment, script development, review, CI/CD integration, clearance |
| `performance.py` | **Specialised Testing** (`src/modules/specialised-testing/`) | Performance testing lifecycle: readiness, baseline, load test, result analysis, defect fix/retest, report, clearance |
| `approvals.py` | **Governance** (`src/modules/governance/`) | Cross-module workflow-decision feed (`/approvals`, `/approvals/pending-mine`) |
| `audit.py` | **Governance** (`src/modules/governance/AuditLog.tsx`) | Immutable authentication, API-access, data-change and access-management audit trail |
| `signoff.py` | **Governance** (`src/modules/governance/`) | Formal QA Clearance issuance, history, documents |
| `dashboard.py` | `src/Dashboard.tsx` | Project-wise, QA-wise, security, suppression, and 3W ("what's pending, where, since when") dashboards |
| `reports.py` | **Governance** (`src/modules/governance/Reports.tsx`) | Operational/security/management report data (QA summary, SAST/DAST scan, vulnerability trend, severity distribution, suppression register, monthly KPI, quality scorecard, audit evidence) |
| `export.py` | **Governance** (`src/modules/governance/Reports.tsx`) | Excel/PDF/CSV export of the above, with RBAC |
| `departments.py` | Used across request forms + Admin | Department master data |

Every write endpoint is RBAC-checked via `app/deps.require_roles`, and every state change is
written to the `approval_actions` workflow-history table. Security and operational activity is
captured separately in the immutable `qap_audit_logs` table. JWT auth stands in for AD/LDAP integration —
real LDAP bind support is already implemented (see
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
    Login.tsx, Dashboard.tsx, QARequests.tsx      # cross-cutting pages (not owned by
                                                   # one domain area)
    modules/
      functional/       Functional.tsx
      security/          SAST.tsx, DAST.tsx, Suppression.tsx
      specialised-testing/ Automation.tsx, Performance.tsx
      governance/           SignOff.tsx, Approvals.tsx, Reports.tsx, Admin.tsx
```

`src/App.tsx` loads each `modules/<area>/*` page with `React.lazy()` + `<Suspense>` — a normal
Vite code-splitting boundary, not a network fetch to another deployed app. This still gives a
real, measurable benefit (visiting `/sast` never downloads the Governance or Automation bundle),
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
    package.json
    vite.config.ts
    Dockerfile, nginx.conf.template   # nginx.conf itself kept only as a reference (see "Enable HTTPS")
    src/                    # see Frontend architecture above
  docker-compose.yml         # backend + frontend, 2 services
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
`python -m app.seed`. Existing environments must then adopt the Alembic baseline once; see
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

python -m app.seed              # first empty DB only: creates tables + seeds demo data
alembic stamp head              # first empty DB only: records the Alembic baseline
# Existing baseline adopted: use `alembic upgrade head` on every deployment.
uvicorn app.main:app --reload --port 8000
```

The API is now at `http://localhost:8000`, with interactive docs at
`http://localhost:8000/docs`.

### Logging modes

Backend logging is controlled centrally from `backend/.env`:

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

Two images, backend and frontend, each with a standalone `Dockerfile`:

```bash
docker build -f backend/Dockerfile -t qualityops-backend backend
docker build -f frontend/Dockerfile -t qualityops-frontend frontend
```

The frontend image's nginx (`frontend/nginx.conf.template`, see the "Enable HTTPS" section below
for why it's a template) reverse-proxies `/api/*` to a `backend` host same-origin, so the browser
never talks to the API on a different origin and there's no CORS configuration needed anywhere.
That proxy target assumes the two containers share a Docker network with the backend reachable at
the hostname `backend` (true when run via `docker-compose.yml` below, or when deployed as two
Services in the same Kubernetes namespace with the backend Service named `backend`). If your
topology differs, either edit the `proxy_pass` target in `nginx.conf.template`, or skip the proxy
entirely by rebuilding with `--build-arg VITE_API_BASE_URL=https://your-api-host` to bake in a
direct API URL instead.

### Running everything together (docker-compose)

```bash
docker compose up --build
# App:  http://localhost:8080
# API:  http://localhost:8000
```

Point `DATABASE_URL` at your Oracle instance via an env var or `.env` file next to
`docker-compose.yml` (defaults to `host.docker.internal`, which reaches an Oracle container or
host-installed Oracle from inside Docker on Mac/Windows; on Linux use the host's real IP or
`--add-host`).

The backend runs 4 worker processes by default (`WEB_CONCURRENCY`, see `backend/Dockerfile`) and
a `redis` service is included and wired up by default (`REDIS_URL`) -- required for cache
correctness (dashboard summary + reference-data caching, see `backend/app/cache.py`) and for the
one-time startup migration to run once per deployment instead of once per
worker (see `backend/app/main.py`'s startup-lock comment) whenever more than one worker is
running. The app still runs fine without Redis reachable -- caching and the startup lock both
degrade to a no-op/permissive fallback -- but then each of the 4 workers keeps its own cache and
the startup task can run up to 4 times.

### Enable HTTPS

Out of the box (`docker compose up --build`, above) the app is HTTP-only, reachable at
`http://localhost:8080`. Both paths below terminate TLS in this stack's own nginx (`frontend`)
container, write their certificate into the same place, and need no `frontend/nginx.conf.template`
changes either way -- only which bootstrap script you run differs. Pick based on how this server
is reached:

- **Have a real domain, and the server is reachable from the public internet on it?** Use
  [Path A](#path-a--public-domain-lets-encrypt) -- a trusted, browser-recognized certificate that
  renews itself automatically, no per-device setup for anyone visiting the app.
- **Only have an IP address, no domain (yet), and/or the server is only reachable on a private
  network (VPN/office LAN)?** Use [Path B](#path-b--ip-address--private-network-self-signed) --
  Let's Encrypt cannot help here at all (it only ever validates domain ownership over the real
  public internet, so a private/IP-only server can never qualify no matter what), but a private
  certificate authority gets you real end-to-end TLS with a one-time trust step per device instead.

#### Path A -- public domain (Let's Encrypt)

1. **Point DNS at this host first.** The domain's A/AAAA record must already resolve to this
   server's public IP, and ports **80** and **443** must be reachable from the internet on it --
   Let's Encrypt validates ownership over the real internet, not just inside the Docker network.
2. **Add two variables to the root `.env`** (next to `DATABASE_URL`, `SECRET_KEY`, etc.):
   ```
   DOMAIN_NAME=qa-portal.example.com
   CERTBOT_EMAIL=you@example.com
   ```
   `CERTBOT_EMAIL` is only used by Let's Encrypt for expiry/security notices -- it's never shown
   to app users.
3. **Run the one-time bootstrap script**, before starting the rest of the stack:
   ```bash
   ./scripts/init-letsencrypt.sh
   ```
   This solves the classic nginx/Certbot chicken-and-egg problem: nginx won't start without a
   certificate file to point at, but Certbot can't issue the first certificate until something is
   already serving its HTTP challenge on port 80 -- so the script briefly gives nginx a throwaway
   self-signed certificate just to get it running, requests the real one from Let's Encrypt against
   that running nginx, then swaps it in and reloads. Safe to re-run if it fails partway through. Set
   `CERTBOT_STAGING=1` in `.env` first to test against Let's Encrypt's staging environment (issues a
   certificate your browser won't trust, but doesn't count against the real service's rate limits)
   before doing a real run.
4. **Bring up the rest of the stack** as usual: `docker compose up -d`. The app is now reachable at
   `https://qa-portal.example.com`; plain `http://` requests to the same domain (port 80) are
   redirected to HTTPS automatically. The pre-existing `http://localhost:8080` mapping still works
   too, unchanged, for local/dev access without a domain.

**Certificate renewal (Path A only):** the `certbot` service in `docker-compose.yml` checks every
~12h and renews automatically once the certificate is within 30 days of expiring (Let's Encrypt
certificates are valid 90 days). It does **not** reload nginx on its own, though -- nginx only
picks up a renewed certificate file when told to. Add a host cron entry to reload it periodically
(safe to run even when nothing renewed):
```
0 3 * * 1 cd /path/to/qa-portal && docker compose exec frontend nginx -s reload
```
If you skip this, the certificate still renews on disk, but nginx keeps presenting the old one
until it's next restarted/redeployed some other way -- which will eventually expire and start
failing in browsers.

#### Path B -- IP address / private network (self-signed)

`scripts/init-selfsigned.sh` generates a small private Certificate Authority (once) plus a
certificate for `DOMAIN_NAME` signed by it -- deliberately not a single bare self-signed cert.
The difference matters: you install/trust the **CA** once on each device that needs to reach this
server, and every certificate that CA ever issues (this one, and any future rotation) is then
trusted automatically with no more warnings -- a bare self-signed cert would need every device to
individually click through (or bypass) a warning, and re-approve it again on every rotation.

1. **Add `DOMAIN_NAME` to the root `.env`** -- for this path it's the IP address or internal
   hostname you and your team will actually type into a browser, e.g.:
   ```
   DOMAIN_NAME=192.168.1.50
   ```
   `CERTBOT_EMAIL` is not needed for this path (nothing here talks to Let's Encrypt at all).
2. **Run the one-time bootstrap script**:
   ```bash
   ./scripts/init-selfsigned.sh
   ```
   Creates the local CA and a certificate for `DOMAIN_NAME` (valid 10 years by default -- override
   with `SELFSIGNED_DAYS` in `.env`; self-signed/private-CA certificates aren't subject to the
   shorter validity windows public CA root programs enforce, since nothing here relies on an OS/
   browser trusting it out of the box), starts/reloads nginx, and saves the CA certificate to
   `./certs/qa-portal-local-ca.crt`. Safe to re-run -- it reuses the existing CA if one is already
   there, so previously-trusted devices stay trusted; only the leaf certificate regenerates.
3. **Install `./certs/qa-portal-local-ca.crt` on every device** that will access the app, so
   browsers stop showing a trust warning:
   - **Windows:** double-click the `.crt` file → *Install Certificate* → *Local Machine* →
     *Place all certificates in the following store* → *Trusted Root Certification Authorities*.
   - **macOS:** double-click the `.crt` file to open it in *Keychain Access*, then in the
     certificate's *Get Info* panel set *When using this certificate* → *Always Trust*.
   - **Linux (Debian/Ubuntu):** `sudo cp qa-portal-local-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`.
   - **Firefox** (keeps its own trust store separate from the OS on every platform):
     Settings → Privacy & Security → *View Certificates* → *Authorities* tab → *Import*.
   - **iOS/Android:** install as a profile/CA certificate via device Settings, then (iOS only) also
     enable it under Settings → General → About → Certificate Trust Settings.

   Until a device has done this, `https://192.168.1.50` still works (traffic is genuinely
   encrypted), it just shows an interstitial trust warning first.
4. **Bring up the rest of the stack**: `docker compose up -d`. Plain `http://192.168.1.50`
   redirects to HTTPS automatically; `http://localhost:8080` still works unchanged.

**No automatic renewal on this path** -- there's no ACME/Certbot involved, so nothing renews this
certificate on a schedule. Re-run `./scripts/init-selfsigned.sh` before it expires (10 years by
default) to issue a new leaf certificate off the same trusted CA; no device needs to re-trust
anything when you do.

#### Neither path -- HTTPS terminated elsewhere, or not wanted at all

If TLS is (or will be) terminated outside this stack entirely -- an external load balancer or
ingress that already handles HTTPS and talks plain HTTP to this container -- skip both paths
above; `frontend/nginx.conf.template`'s port-80 behavior is a hard redirect to HTTPS, which would
conflict with an external terminator forwarding plain HTTP. See `frontend/nginx.conf` (kept as a
reference, no longer built by default) for a plain HTTP-only config to point the Dockerfile back
at instead, and just make sure your external terminator forwards `X-Forwarded-Proto` (it already
does in most LB/ingress setups) -- the backend and frontend nginx config both already read/forward
that header where relevant.

### Verification status

This project was authored and Docker/Compose files written in a sandboxed environment with
**no Docker daemon and no npm registry access** (`docker` isn't installed there;
`npm view react version` returned `403 Forbidden`). As a result:

- ✅ Verified in-sandbox: `tsc --noEmit` passes cleanly against the full `src/` tree — source-
  level TypeScript correctness, including every import path rewritten during the monorepo →
  single-app consolidation, is confirmed.
- ⚠️ **Not verified anywhere**: an actual `npm install` against a real npm registry, `vite
  build` producing a real `dist/`, and any `docker build`/`docker compose up` execution. These
  were written by hand following standard Vite/Docker/nginx patterns, but **please run a real
  `npm install` + `npm run build` and a `docker compose up --build` smoke test on your own
  machine** before relying on this in production.

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
initially with the temporary default role (`DEFAULT_LDAP_PROVISION_ROLE` in
`app/constants.py`, currently Requester). At the mandatory first-login department confirmation,
users selecting **COE - Quality Assurance** receive **QA Engineer** as their default role;
users selecting any other department remain **Requester**. That new account is still flagged `needs_role_review=True`
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

- Apply versioned Oracle schema changes with **Alembic** before starting API
  containers; see `backend/MIGRATIONS.md`.
- Testcase/repository and execution lists use primary-key cursor pagination;
  cycle candidates are evaluated with SQL `NOT EXISTS` and are loaded only
  when the Add Test Cases dialog opens. Revision `20260815_0001` installs the
  supporting Oracle indexes and must be applied with `alembic upgrade head`.
- Large cycle additions (more than 500 rows), testcase Excel imports, and
  repository/lifecycle Excel exports run as background jobs. Job status and
  generated artifacts live under `<configured upload root>/.jobs`; therefore
  every API worker must use the same durable shared upload root in production.
- Configure `TRUSTED_PROXY_CIDRS` with only the actual load-balancer, ingress or
  reverse-proxy networks. Login and action audit records will then store the
  original client from `X-Forwarded-For` instead of the proxy's address. The
  supplied nginx configuration already forwards `X-Real-IP` and
  `X-Forwarded-For` (and, once HTTPS is enabled per the section above,
  `X-Forwarded-Proto`, useful if you later add HTTPS-only logic on the backend).
- Add MFA at the identity-provider layer for LDAP/AD-backed logins, per the non-functional
  requirements (5.1) — this app only performs the LDAP bind, not step-up/MFA.
- Supporting documents are uploaded (multiple files per request, every module) and stored on
  local disk under the configured upload root (see `app/documents.py`). Docker mounts durable
  storage at `/data/qualityops/uploads`; use that path (or one of its subfolders) in Admin >
  Upload Storage. Set `UPLOAD_STORAGE_HOST_PATH=/absolute/host/or/nfs/path` in the root Compose
  `.env` to replace the default `qa_portal_uploads` named volume, then recreate the backend
  container. A path entered in the UI is a container path—it cannot add a new host mount to an
  already-running container.
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
  `/history`, `/export`, `/documents`
- `/api/sast-requests`, `/api/dast-requests` — CRUD + decision/lifecycle actions, `/findings`
  (+ `/resolve`), `/history`, `/export`, `/documents`
- `/api/suppressions` — CRUD + `/sm-decision`, `/dept-head-decision`,
  `/security-team-decision`, `/history`, `/export`, `/documents`
- `/api/automation-requests`, `/api/performance-requests` — CRUD + decision/lifecycle actions,
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
- RBAC is enforced per-endpoint (who can perform which action); if you need row-level
  visibility restrictions (e.g., a Requester should only see their own department's
  requests), add query filters in the relevant router's `list_*` functions.
- See [Verification status](#verification-status) above: `npm install`, `vite build`, and
  `docker build`/`docker compose up` have not been executed in the authoring environment and
  should be smoke-tested before relying on this in production.
