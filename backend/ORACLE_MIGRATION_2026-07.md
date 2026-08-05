# Oracle migration notes -- Workflow redesign (SM role, SAST/DAST/Suppression lifecycle, DB-backed departments)

> **Update (v2):** Sections 6-9 below cover the second round of changes -- the SAST/DAST lifecycle
> expansion, the two brand-new request types (Automation Testing, Performance Testing), and the
> same-department restriction being extended to every SM/Department Head decision point across all
> five request types. Sections 1-5 above are unchanged and already applied; apply 6-9 on top.
>
> **Update (v3):** Sections 10-13 below cover the third round -- the QA Request is now a pure
> intake/gateway record (no approval workflow of its own), and Functional Testing/Sanity Testing/
> Regression Testing/UAT Support are combined into a brand-new independent `FunctionalRequest`
> entity carrying the full lifecycle that used to live directly on the QA Request. This is the
> largest schema change so far -- read section 10 first, since it explains the shape of the split
> before the DDL/data-migration details in 11-13.
>
> **Update (v4):** Section 15 below covers the fourth round -- new Annexure VIII columns on
> `qap_performance_requests` plus a brand-new `qap_performance_checklist_items` table for the
> 19-item "L1: Pre-Testing Readiness Checklist", both driven by the uploaded QA Performance
> Checklist reference document. The QA Request form itself was also reworked into a multi-step
> wizard (a dedicated page per selected request type) on the frontend only -- no schema impact.
>
> **Update (v5):** Sections 16-21 cover the fifth round -- new mandatory-field columns on
> `qap_requests`, multi-value SAST/DAST components (repeatable "+" rows, initially as comma/
> newline-joined columns), conditional visibility/authorization on DAST Test Credentials, deferring
> linked child-request creation from Draft save all the way to Submit/Raise via a new
> `qap_requests.draft_child_details` staging column, and (section 21, most recent) replacing those
> comma/newline-joined SAST/DAST columns with real child tables (`qap_sast_components`,
> `qap_dast_targets`) -- one row per repository/target instead of packing several values into one
> column. Section 21 is the largest/highest-risk change in this update since it drops columns with
> live data on them -- read it in full and verify the data migration before dropping anything.
>
> **Update (v6):** Section 22 below covers the sixth round -- a real "Assigned To" (assignee) concept
> for Performance Testing requests, mirroring how SAST/DAST assign a Security Lead and Automation
> assigns an Engineer. This is a single new nullable column, no data migration needed. This update
> also exposes `issued_by_id`/`signed_by_id` (already-existing columns on `qap_signoffs`) through the
> API for the first time -- no schema change there at all, so no new section for it.
>
> **Update (v7):** No schema change at all. When the assigned Lead fails a readiness check (Functional's
> Readiness Verification, or SAST/DAST's Security Readiness) and returns the request to the requester,
> they can now choose whether the resubmitted request needs a fresh Department Head approval, or can
> go straight back to them once fixed (the previous, and still default, behavior). This reuses the
> existing `RETURNED_BY_DEPARTMENT_HEAD` / `RETURNED_BY_QA_LEAD` / `RETURNED_BY_SECURITY_LEAD` status
> values and their already-existing resubmit routing -- see `schemas.ReadinessDecisionIn.require_dept_head_reapproval`.
>
> **Update (v8):** No schema change at all -- extends v7's two-option return-to-requester pattern to
> Suppression, Automation, and Performance, the three request types that didn't already have an
> equivalent "assignee finds a discrepancy right after Department Head approval" decision point.
> Three brand-new status *values* only (still plain `VARCHAR2` columns, no DDL): `RETURNED_BY_QA_LEAD`
> on `qap_automation_requests` (Feasibility Assessment can now fail, not just always advance),
> `RETURNED_BY_ENGINEER` on `qap_performance_requests` (Readiness can now fail, not just gate on the
> checklist), and `RETURNED_BY_SECURITY_TEAM` on `qap_suppression_requests` (Security Team Verification
> gained a third "Returned" outcome alongside its existing Accept/Reject). Two renamed endpoints:
> `POST /api/automation-requests/{id}/complete-feasibility` -> `.../feasibility-decision` (now takes
> `{decision: "Passed"|"Failed", ...}` instead of no body), and
> `POST /api/performance-requests/{id}/complete-readiness` -> `.../readiness-decision` (same shape
> change; "Passed" still requires the pre-testing checklist complete, unchanged).
>
> **Update (v9):** Section 24 below covers the ninth round -- Automation Testing gets its own
> "Ready for Automation" readiness checklist (15 items, mirroring the reference checklist supplied
> for this request), via a brand-new `qap_automation_checklist_items` table, seeded only while
> "Automation Testing" is a selected request type on the QA Request wizard (which now shows a
> dedicated, conditionally-visible "Automation Readiness Checklist" step, exactly like the existing
> SAST/DAST/Performance steps). `feasibility_decision`'s "Passed" outcome now also gates on every
> mandatory item being complete, mirroring Functional's Readiness Verification and Performance's
> Readiness gates.
>
> **Update (v10):** Section 25 below covers the tenth round -- Automation Testing, Performance
> Testing, and Suppression/False Positive requests each get an "Overview / Checklist (Suppression:
> N/A) / Walkthroughs / History" tabbed detail page, matching Functional Testing's existing layout.
> Walkthrough session logging (previously Functional-only, via `qap_walkthrough_sessions`) is
> extended via three brand-new, dedicated tables -- `qap_automation_walkthroughs`,
> `qap_performance_walkthroughs`, `qap_suppression_walkthroughs` -- rather than a single shared
> table, consistent with every other per-module concept in this app. A `GET .../history` endpoint
> (backed by the already-existing `qap_approval_actions` log, no schema change) was also added to
> `routers/automation.py` and `routers/performance.py`, which didn't expose one before (Functional
> and Suppression already had theirs). Suppression has no readiness-checklist concept, so its detail
> page only gained Walkthroughs + History, not a Checklist tab.
>
> **Update (v11):** Section 26 below covers the eleventh round -- two Performance Testing
> consistency fixes. First, the QA Request wizard's Performance step no longer re-collects Change
> Type/Vendor-SI Partner/Technology Stack/Release Version/Build Number/Target Promotion
> Environment -- these are already collected once on "Application & Change Details" and are now
> delegated straight from there (Hash Value has no gateway equivalent and is simply filled in later
> on the Performance request's own page). Second, Performance's pre-testing readiness checklist
> gains a `requester_checked` column (new, on the existing `qap_performance_checklist_items` table)
> and the same self-declare/QA-verify split every other module's checklist already has -- the
> requester ticks a self-declaration checkbox on the wizard's Performance step (new), and
> `update_checklist_item` (in `routers/performance.py`) is tightened to QA-only roles plus a
> server-side "must be in READINESS" gate, matching `routers/functional.py`'s real precedent
> (previously it let REQUESTER toggle `is_complete` directly with no stage gate at all -- the same
> over-permissive shape this update also fixes on `routers/automation.py`'s equivalent endpoint,
> which had been copied from Performance's old behavior rather than Functional's).
>
> **Update (v12):** Section 27 below covers the twelfth round -- no schema change. The New Suppression
> / False Positive Request form is redesigned into the same card-style, larger-font layout as the QA
> Request wizard (scoped under a new `.suppression-form` class, not a global style change), and every
> field on it is now mandatory, including the SAST/DAST Request ID link itself -- the previous
> "standalone finding with no linked scan" fallback has been removed. `department`/`application_owner`/
> `risk_assessment` on `SuppressionCreate` and `issue_id`/`description`/`justification` on
> `SuppressionItemIn` go from `Optional[str] = None` to required `str`; `create_suppression`/
> `update_suppression` in `routers/suppression.py` now also reject a payload where neither or both of
> `sast_request_id`/`dast_request_id` are set. Existing DB columns stay nullable (this is API/UI-layer
> validation only, not a DDL change) -- any already-saved "standalone" draft rows with no linked
> request will need a request selected before they can be edited/resubmitted going forward.
>
> **Update (v13):** Section 28 below covers the thirteenth round -- fixes a misleading status. When
> the assigned QA Lead/Security Lead/Engineer fails Readiness Verification/Security Readiness/
> Feasibility Assessment/Readiness with "require Department Head re-approval on return" ticked (see
> v7/v8 above), the request's `status` was being set to `RETURNED_BY_DEPARTMENT_HEAD` -- the exact
> same status value used when the Department Head *themselves* returns a request during their own
> approval step. That's wrong: the Department Head hasn't seen the request at this point, the
> assigned Lead/Engineer is who actually returned it. `status` is now always the accurate
> `RETURNED_BY_QA_LEAD`/`RETURNED_BY_SECURITY_LEAD`/`RETURNED_BY_ENGINEER`, and a new
> `needs_dept_head_reapproval` column (one per request table) separately tracks the re-approval
> choice -- `resubmit` reads it to decide routing, and the frontend shows it as a note next to the
> now-accurate status badge instead of baking it into the status itself.
>
> **Update (v14):** Section 29 below covers the fourteenth round -- no schema change. Automation/
> Performance Testing requests had no way for the requester to update their readiness-checklist
> self-declaration once the request existed -- the only place to tick those items was the QA Request
> wizard at intake time; the "Edit Details" modal on the Automation/Performance request's own page
> didn't expose the checklist at all, even while the request was sitting back with the requester
> (Draft, or returned for changes). Both "Edit Details" modals now include the checklist with
> checkboxes, submitted alongside the rest of the form.
>
> **Update (v15):** Section 30 below covers the fifteenth round -- Priority and Risk Rating/Category
> move off the QA Request gateway and become independent per-request-type fields, since two request
> types raised together from the same QA Request can legitimately need different priorities (e.g.
> Automation Testing Low, Performance Testing High, on the same change). `qap_requests.priority`/
> `risk_rating` are dropped from the SQLAlchemy model (left physically in place on the table, unused,
> rather than DDL-dropped) and each of `qap_functional_requests`, `qap_sast_requests`,
> `qap_dast_requests`, `qap_automation_requests`, `qap_performance_requests` gains its own `priority`
> column (`risk_category`/`risk_rating` already existed on all but Functional -- see section 10).
> Functional Testing also gets a brand-new `PUT /api/functional-requests/{id}` endpoint and wizard
> step, since it previously had neither a way to edit its own descriptive fields nor anywhere to
> collect Priority/Risk independently of the gateway.
>
> **Update (v16):** Section 31 below covers the sixteenth round -- no schema change. Functional
> Testing's own Overview was missing several "Application & Change Details"/"Release & Environment"
> fields that every other request type already showed (CR Number, Change Type, Deployment
> Environment, Target Promotion Environment, Release Version, Build Number), and its "Edit Details"
> (added in v15/section 30) only let Priority/Risk Rating be changed -- there was no way to fix a
> typo in any of those other fields once the QA Request gateway itself left Draft. Both gaps are
> fixed by exposing these as more delegated (read-only-from-the-model's-own-column-perspective,
> writable-through-the-endpoint) properties on `FunctionalRequest`, same pattern as
> `application_name`/`project_name`/etc. already had.
>
> **Update (v17):** Section 32 below covers the seventeenth round -- no schema change. Application
> Name, Project Name and CR Number identify *which* request a Functional/SAST/Automation/Performance
> Testing Request actually is -- once raised, changing one of these three fields is now an
> Administrator-only action (backend-enforced, not just a hidden button), everywhere they're
> editable. Every other field on each module's "Edit Details" is unaffected.

`Base.metadata.create_all()` in `main.py`/`seed.py` uses `checkfirst=True`, so it will create the
brand-new `qap_departments` table automatically on next startup, but it will **not** alter any
existing table (add columns, change defaults, etc). Run the statements below by hand against the
live Oracle database before deploying this change.

> **Update (v18):** Section 33 below covers the eighteenth round -- every request type except the
> Gateway QA Request (which already had its own `qap_request_documents` table/upload flow) can now
> have multiple supporting documents uploaded any time after the request has been raised. Rather than
> adding 7 more near-identical per-module document tables, this adds one brand-new shared/polymorphic
> table, `qap_module_documents`, keyed by `(module, request_id)` -- see section 33 for why this is
> safe (each module gets its own distinct `module` string, unlike `qap_approval_actions.entity_type`,
> where SAST and DAST unsafely share one string despite independent id sequences). Files are stored on
> disk under `backend/app/uploads/<module>/<request's own request_id string>/<filename>`, same
> physical uploads folder as the Gateway's own documents, just namespaced by module.

> **Update (v19):** No schema/API change at all -- frontend-only restructure. `frontend/src/pages/`
> is split into a `shell/` (Login, Dashboard, the QA Request gateway -- cross-cutting, not owned
> by one domain) and 4 `modules/` folders: `functional/` (Functional QA), `security/` (SAST/DAST/
> Suppression), `specialised-testing/` (Automation/Performance), `governance/` (Sign-off/Approvals/
> Admin/Reports). Each module is imported everywhere else only through its own `index.ts` barrel, never
> by reaching into its files directly, and `App.tsx` lazy-loads each module barrel (`React.lazy` +
> `Suspense`), so each module builds as its own separate chunk -- a change inside one module's folder
> can't break another module's bundle. Shared building blocks every module needs (Table + its filter
> icon/popover, Modal, Badge, etc.) deliberately stay put in `components/`, unmoved.

> **Update (v20):** Section 34 below covers the twentieth round -- SAST and DAST get Walkthroughs and
> History tabs, matching every other module (they previously had neither). Two brand-new tables,
> `qap_sast_walkthroughs`/`qap_dast_walkthroughs`, same shape as `qap_walkthrough_sessions`
> (Functional's). The new `GET .../history` endpoints reuse the existing id-collision guard from
> `_sast_dast_history()` (SAST and DAST share the `"SAST_DAST"` `ApprovalAction.entity_type` string
> despite independent id sequences) via a new sibling helper, `_sast_dast_history_rows()`, which
> returns the raw ORM rows instead of PDF-formatted tuples; on a collision it returns an empty list
> rather than risk showing mixed SAST/DAST rows. Also, no schema change: the PDF export's Findings
> section for SAST/DAST now shows a count-by-severity summary instead of every finding's full
> issue-by-issue detail, and the topbar search box's "search doesn't apply if you're already on the
> QA Requests page" bug is fixed (its `search` state was only ever seeded from the URL on first
> mount, so it silently missed subsequent searches typed in from the same page).

## 1. New table: departments

```sql
CREATE TABLE qap_departments (
    id            NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name          VARCHAR2(150) NOT NULL,
    is_active     NUMBER(1) DEFAULT 1,
    created_at    DATE DEFAULT SYSDATE,
    CONSTRAINT uq_qap_departments_name UNIQUE (name)
);
```

This replaces the old hardcoded `constants.DEPARTMENTS` list. `app/seed.py` will backfill it with the
same set of department names the first time it runs against a DB that has this table but no rows in
it yet -- no manual `INSERT`s required, just make sure `python -m app.seed` runs once after the table
exists. After that, departments are managed via Admin > Departments (`/api/departments`).

## 2. New columns on the Suppression table

The Application Owner step was removed from the Suppression flow and replaced with SM + Security Team
steps. `app_owner_decision` / `app_owner_id` / `app_owner_decided_at` are kept (unused) rather than
dropped, so this is additive only:

```sql
ALTER TABLE qap_suppression_requests ADD (
    sm_decision        VARCHAR2(16),
    sm_id              NUMBER,
    sm_decided_at      DATE,
    security_decision  VARCHAR2(16),
    security_id        NUMBER,
    security_decided_at DATE
);

ALTER TABLE qap_suppression_requests ADD CONSTRAINT fk_qap_sup_sm_id
    FOREIGN KEY (sm_id) REFERENCES qap_users(id);
ALTER TABLE qap_suppression_requests ADD CONSTRAINT fk_qap_sup_security_id
    FOREIGN KEY (security_id) REFERENCES qap_users(id);
```

## 3. Status value changes (data migration, not schema)

All `status` columns involved are already wide enough `VARCHAR2` columns -- no column resize is
needed, just be aware some string values used previously are no longer produced by the app and any
existing rows sitting in them should be moved forward manually:

- **`qap_suppression_requests.status`** -- the old value set (`Pending Application Owner`,
  `Pending Department Head`, `Approved`, `Rejected`) is replaced by
  (`Draft`, `SM_APPROVAL_PENDING`, `RETURNED_BY_SM`, `DEPARTMENT_HEAD_APPROVAL_PENDING`,
  `RETURNED_BY_DEPARTMENT_HEAD`, `SECURITY_TEAM_VERIFICATION`, `Done`, `Rejected`). Any existing row
  with `status = 'Pending Application Owner'` or `'Pending Department Head'` or `'Approved'` will no
  longer match anything the UI/API expects. Recommended one-time fixups:
  ```sql
  UPDATE qap_suppression_requests SET status = 'DEPARTMENT_HEAD_APPROVAL_PENDING'
      WHERE status IN ('Pending Application Owner', 'Pending Department Head');
  UPDATE qap_suppression_requests SET status = 'Done' WHERE status = 'Approved';
  ```
  (Adjust the first UPDATE if you'd rather route old in-flight rows through SM again instead of
  skipping straight to Department Head -- use `'SM_APPROVAL_PENDING'` in that case.)

- **`qap_requests.status`** -- three new values were added (`SM_APPROVAL_PENDING`, `RETURNED_BY_SM`,
  `SM_REJECTED`) between `SUBMITTED` and `DEPARTMENT_HEAD_APPROVAL_PENDING`. `SUBMITTED` itself is now
  a transient value the code passes through on its way to `SM_APPROVAL_PENDING` rather than a resting
  state, so if any existing row is sitting at `status = 'SUBMITTED'`, move it forward:
  ```sql
  UPDATE qap_requests SET status = 'SM_APPROVAL_PENDING' WHERE status = 'SUBMITTED';
  ```

- **`qap_sast_requests.status` / `qap_dast_requests.status`** -- old values (`Requested`, `Allocated`,
  `Scanning`, `Report Ready`, `Closed`) are all still valid in the new state machine, so no forced
  fixup is required. Rows previously sitting at `Requested` will need to go through Submit -> SM ->
  Department Head -> Readiness Check -> Allocated now (they used to go straight to a Security
  Team/Approver decision) -- this is a process change, not a data-corruption issue, so no SQL needed,
  just expect existing "Requested" rows to need re-submission through the new flow.

## 4. SM role

At least one user needs the `SM` role assigned for the new approval step to be actionable in
production. `app/seed.py`'s demo data adds a `sm1` user automatically, but for real users, assign it
via Admin > Users & Access (role checkboxes), or directly:

```sql
INSERT INTO qap_user_roles (user_id, role) VALUES (<user_id>, 'SM');
```

## 5. Same-department approval restriction

No schema change -- this is enforced in application code (`deps.require_same_department`) by
comparing the acting user's `qap_users.department` value against the request's `department` column.
Make sure SM and Department Head users have their `department` field populated and matching the
departments of the requesters they're expected to approve for, otherwise they'll get a 403 when
trying to act (by design).

## 6. New columns on the SAST/DAST tables: security_lead_id

The Department Head approval step on SAST/DAST now assigns a named Security Lead (reusing the
existing `SECURITY_ANALYST` role -- there is no separate "Security Lead" role in the system) at the
same time it approves. This is additive only:

```sql
ALTER TABLE qap_sast_requests ADD (security_lead_id NUMBER);
ALTER TABLE qap_dast_requests ADD (security_lead_id NUMBER);

ALTER TABLE qap_sast_requests ADD CONSTRAINT fk_qap_sast_security_lead_id
    FOREIGN KEY (security_lead_id) REFERENCES qap_users(id);
ALTER TABLE qap_dast_requests ADD CONSTRAINT fk_qap_dast_security_lead_id
    FOREIGN KEY (security_lead_id) REFERENCES qap_users(id);
```

## 7. New tables: Automation Testing and Performance Testing requests

These are two brand-new request types, each auto-created as a linked child the moment a QA Request's
`request_types` includes `"Automation Testing"` / `"Performance Testing"` respectively (same pattern
as SAST/DAST auto-linking off a QA Request already in production). They cannot be created standalone.

```sql
CREATE TABLE qap_automation_requests (
    id                    NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    request_id            VARCHAR2(40) NOT NULL,
    application_name      VARCHAR2(200),
    project_name          VARCHAR2(200),
    cr_number             VARCHAR2(80),
    framework             VARCHAR2(120),
    repository_url        VARCHAR2(500),
    ci_cd_pipeline_url    VARCHAR2(500),
    risk_category         VARCHAR2(40),
    status                VARCHAR2(40) DEFAULT 'DRAFT' NOT NULL,
    requester_id          NUMBER,
    engineer_id           NUMBER,
    report_path           VARCHAR2(500),
    qa_request_id         NUMBER NOT NULL,
    created_at            DATE DEFAULT SYSDATE,
    updated_at            DATE DEFAULT SYSDATE,
    CONSTRAINT uq_qap_automation_request_id UNIQUE (request_id),
    CONSTRAINT fk_qap_automation_requester FOREIGN KEY (requester_id) REFERENCES qap_users(id),
    CONSTRAINT fk_qap_automation_engineer FOREIGN KEY (engineer_id) REFERENCES qap_users(id),
    CONSTRAINT fk_qap_automation_qa_request FOREIGN KEY (qa_request_id) REFERENCES qap_requests(id)
);

CREATE TABLE qap_performance_requests (
    id                    NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    request_id            VARCHAR2(40) NOT NULL,
    application_name      VARCHAR2(200),
    project_name          VARCHAR2(200),
    cr_number             VARCHAR2(80),
    tool_used             VARCHAR2(120),
    target_load           VARCHAR2(200),
    environment           VARCHAR2(120),
    risk_category         VARCHAR2(40),
    status                VARCHAR2(40) DEFAULT 'DRAFT' NOT NULL,
    requester_id          NUMBER,
    report_path           VARCHAR2(500),
    qa_request_id         NUMBER NOT NULL,
    created_at            DATE DEFAULT SYSDATE,
    updated_at            DATE DEFAULT SYSDATE,
    CONSTRAINT uq_qap_performance_request_id UNIQUE (request_id),
    CONSTRAINT fk_qap_performance_requester FOREIGN KEY (requester_id) REFERENCES qap_users(id),
    CONSTRAINT fk_qap_performance_qa_request FOREIGN KEY (qa_request_id) REFERENCES qap_requests(id)
);
```

Both tables are picked up automatically by `Base.metadata.create_all(checkfirst=True)` on next
startup since they're brand new (no existing rows to worry about), but creating them by hand ahead of
a production deploy avoids relying on app startup having DDL privileges.

Note `department` and `application_owner` are **not** physical columns on either table -- both are
read-only Python `@property` values derived from the linked `qa_request` at query time, so there's
nothing to migrate for those.

## 8. SAST/DAST status value changes (v1 -> v2 lifecycle expansion)

The SAST/DAST lifecycle grew from 13 short-hand statuses to a ~23-status lifecycle with named
business stages (Security Lead Assigned, Security Readiness, Scan Configuration, Finding Validation,
Remediation sub-stages). The old value set is superseded as follows -- existing rows sitting in a
superseded value need a one-time fixup since the UI/API no longer produce or fully recognize the old
strings:

| Old value (v1)     | New value (v2)                        | Notes |
|--------------------|----------------------------------------|-------|
| `Requested`        | `DRAFT`                                | direct rename |
| `READINESS_CHECK`  | `SECURITY_READINESS`                   | now sits after `SECURITY_LEAD_ASSIGNED`, which is new and has no v1 equivalent -- old rows will need a Security Lead assigned manually via `security_lead_id` before they can proceed |
| `Allocated`        | `CONFIGURATION` (or `PLANNING`)        | v1's single "Allocated" step is now split into `PLANNING` -> `CONFIGURATION`; pick `PLANNING` for safety if unsure which sub-stage a row had reached |
| `Scanning`         | `SCANNING`                             | direct rename (case only) |
| `SECURITY_COMPLETE`| `SECURITY_COMPLETE`                    | unchanged, still reachable, now sits after the new `REMEDIATION`/`ASSIGNED_TO_REQUESTER`/`WAITING_FOR_FIX`/`ASSIGNED_TO_LEAD`/`RESCAN` sub-chain instead of coming directly from `WAITING_FOR_FIX` |
| `Report Ready`      | `REPORT_READY`                         | direct rename (case only) |
| `Closed`            | `CLOSED`                               | direct rename (case only) |

Recommended one-time fixups (adjust the `Allocated` mapping if you have a way to tell which
sub-stage those specific rows were actually in):

```sql
UPDATE qap_sast_requests SET status = 'DRAFT' WHERE status = 'Requested';
UPDATE qap_sast_requests SET status = 'PLANNING' WHERE status = 'Allocated';
UPDATE qap_sast_requests SET status = 'SCANNING' WHERE status = 'Scanning';
UPDATE qap_sast_requests SET status = 'REPORT_READY' WHERE status = 'Report Ready';
UPDATE qap_sast_requests SET status = 'CLOSED' WHERE status = 'Closed';
UPDATE qap_sast_requests SET status = 'SECURITY_READINESS' WHERE status = 'READINESS_CHECK';

UPDATE qap_dast_requests SET status = 'DRAFT' WHERE status = 'Requested';
UPDATE qap_dast_requests SET status = 'PLANNING' WHERE status = 'Allocated';
UPDATE qap_dast_requests SET status = 'SCANNING' WHERE status = 'Scanning';
UPDATE qap_dast_requests SET status = 'REPORT_READY' WHERE status = 'Report Ready';
UPDATE qap_dast_requests SET status = 'CLOSED' WHERE status = 'Closed';
UPDATE qap_dast_requests SET status = 'SECURITY_READINESS' WHERE status = 'READINESS_CHECK';

-- Rows moved to PLANNING/SECURITY_READINESS above will be missing a security_lead_id
-- (that field is new in v2 -- see section 6) and should have one assigned manually,
-- e.g.:
-- UPDATE qap_sast_requests SET security_lead_id = <user_id> WHERE status IN ('PLANNING','SECURITY_READINESS') AND security_lead_id IS NULL;
```

## 9. Same-department restriction extended to Automation/Performance

Section 5's `deps.require_same_department` check is now also called from the SM-decision and
Department-Head-decision endpoints of the new Automation and Performance routers (in addition to QA
Request, SAST/DAST, and Suppression, which already had it). No additional schema change -- same
`qap_users.department` column, same enforcement point in application code. QA-side actions (QA Lead
readiness, Security Analyst scanning/report steps, etc.) remain deliberately exempt, since QA is the
receiving party rather than a department stakeholder in the request.

## 10. QA Request becomes a pure intake/gateway; Functional Testing splits into its own entity

**Why:** the QA Request used to carry the *entire* Draft -> SM -> Department Head -> QA Lead ->
Readiness -> Planning -> Execution -> Defect cycle -> Sign-off -> Closed lifecycle directly on
itself, while SAST/DAST/Automation/Performance were already separate auto-linked child requests each
with their own ID and workflow. Per updated requirements, the QA Request form is now **the gateway
only**: raising it creates the gateway record (`qap_requests`, unchanged table name) plus whichever
independent linked child request(s) the selected `request_types` call for -- and that now includes
Functional Testing/Sanity Testing/Regression Testing/UAT Support, which are combined into one new
`FunctionalRequest` (own table `qap_functional_requests`, own unique ID prefixed `TQA-FUNC-...`)
instead of living on the QA Request itself.

**What moved off `qap_requests` onto `qap_functional_requests`:**
- `status` -- the QA Request's own `status` column is now just Draft/Submitted/Raised/Cancelled (see
  `constants.GatewayStatus`); the full `QAStatus` workflow enum now describes `FunctionalRequest.status`.
- `department_head_id`, `qa_lead_id`, `assigned_tester_ids`, `signoff_id` -- moved as columns.
- The readiness checklist (`qap_readiness_checklist_items`) and walkthrough sessions
  (`qap_walkthrough_sessions`) -- their FK now points at `qap_functional_requests` instead of
  `qap_requests` (column renamed `functional_request_id`, see section 12).

**What stayed on `qap_requests`:** all the descriptive/intake fields (application name, owner, CR
number, project, release, environment, request_types, priority, risk rating, target release date,
remarks, supporting documents) plus `requester_id`. `FunctionalRequest` does **not** duplicate these
-- it delegates them (read-only, via a Python `@property`) from its linked `qa_request`, the same
pattern already used for `SASTRequest.department`/`application_owner` etc.

**Audit log:** gateway-level actions (Drafted/Submitted/Raised/Cancelled) log under
`entity_type = 'QA_REQUEST'` as before (a much shorter list now); the full approval workflow logs
under a new `entity_type = 'FUNCTIONAL_REQUEST'` instead.

## 11. New table: qap_functional_requests

```sql
CREATE TABLE qap_functional_requests (
    id                    NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    request_id            VARCHAR2(40) NOT NULL,
    status                VARCHAR2(32) DEFAULT 'DRAFT' NOT NULL,
    requester_id          NUMBER,
    department_head_id    NUMBER,
    qa_lead_id            NUMBER,
    assigned_tester_ids   VARCHAR2(255),
    signoff_id            NUMBER,
    qa_request_id         NUMBER,
    created_at            DATE DEFAULT SYSDATE,
    updated_at            DATE DEFAULT SYSDATE,
    CONSTRAINT uq_qap_functional_request_id UNIQUE (request_id),
    CONSTRAINT fk_qap_functional_requester FOREIGN KEY (requester_id) REFERENCES qap_users(id),
    CONSTRAINT fk_qap_functional_dept_head FOREIGN KEY (department_head_id) REFERENCES qap_users(id),
    CONSTRAINT fk_qap_functional_qa_lead FOREIGN KEY (qa_lead_id) REFERENCES qap_users(id),
    CONSTRAINT fk_qap_functional_signoff FOREIGN KEY (signoff_id) REFERENCES qap_signoffs(id),
    CONSTRAINT fk_qap_functional_qa_request FOREIGN KEY (qa_request_id) REFERENCES qap_requests(id)
);
```

This table is brand new and will be created automatically by `Base.metadata.create_all(checkfirst=True)`
on next startup, but create it by hand ahead of a production deploy as with the others (see section 7).

## 12. Column changes on qap_requests, qap_readiness_checklist_items, qap_walkthrough_sessions

```sql
-- qap_requests loses the workflow-only columns (now on qap_functional_requests instead).
-- Oracle DROP COLUMN rewrites the whole table -- if that's too heavy/risky for a live
-- production table, an acceptable alternative is to leave these columns in place
-- (unused, ignored by the application going forward) rather than dropping them; the
-- app itself never reads or writes them on qap_requests anymore either way.
ALTER TABLE qap_requests DROP COLUMN department_head_id;
ALTER TABLE qap_requests DROP COLUMN qa_lead_id;
ALTER TABLE qap_requests DROP COLUMN assigned_tester_ids;
ALTER TABLE qap_requests DROP COLUMN signoff_id;

-- Readiness checklist items and walkthrough sessions now belong to the Functional
-- Testing Request, not the QA Request gateway.
ALTER TABLE qap_readiness_checklist_items RENAME COLUMN qa_request_id TO functional_request_id;
ALTER TABLE qap_walkthrough_sessions RENAME COLUMN qa_request_id TO functional_request_id;

-- Drop the old FKs (name may differ in your instance -- check
-- USER_CONSTRAINTS/USER_CONS_COLUMNS if these exact names don't match) and add new
-- ones pointing at qap_functional_requests instead of qap_requests.
ALTER TABLE qap_readiness_checklist_items DROP CONSTRAINT <old_fk_name_if_any>;
ALTER TABLE qap_readiness_checklist_items ADD CONSTRAINT fk_qap_checklist_functional
    FOREIGN KEY (functional_request_id) REFERENCES qap_functional_requests(id);
ALTER TABLE qap_walkthrough_sessions DROP CONSTRAINT <old_fk_name_if_any>;
ALTER TABLE qap_walkthrough_sessions ADD CONSTRAINT fk_qap_walkthrough_functional
    FOREIGN KEY (functional_request_id) REFERENCES qap_functional_requests(id);
```

## 13. Data migration: splitting existing qap_requests rows into qap_functional_requests

Any `qap_requests` row already sitting somewhere in the old QAStatus workflow (i.e. anything past
`DRAFT`) needs a corresponding `qap_functional_requests` row created to carry that state forward --
otherwise that in-flight work becomes invisible once the application code switches over. Rows still
in `DRAFT` don't need one yet (no Functional Testing Request is created until the gateway is first
raised/edited with a qualifying request type, same as any other fresh request going forward).

```sql
-- 1. Create one qap_functional_requests row per existing in-flight qap_requests row,
--    carrying its status and role-assignment columns forward, and pointing back at
--    the same gateway row via qa_request_id.
INSERT INTO qap_functional_requests
    (request_id, status, requester_id, department_head_id, qa_lead_id,
     assigned_tester_ids, signoff_id, qa_request_id, created_at, updated_at)
SELECT
    'TQA-FUNC-' || TO_CHAR(SYSDATE, 'YYYYMMDD') || '-' || TO_CHAR(r.id, 'FM000000'),
    r.status, r.requester_id, r.department_head_id, r.qa_lead_id,
    r.assigned_tester_ids, r.signoff_id, r.id, r.created_at, r.updated_at
FROM qap_requests r
WHERE r.status NOT IN ('DRAFT')
  -- only for rows whose request_types actually included one of the Functional bucket
  -- types -- a request raised purely for SAST/DAST/Automation/Performance never had a
  -- functional workflow to carry forward in the first place.
  AND (r.request_types LIKE '%Functional Testing%' OR r.request_types LIKE '%Sanity Testing%'
       OR r.request_types LIKE '%Regression Testing%' OR r.request_types LIKE '%UAT Support%');

-- 2. Move the readiness checklist items and walkthrough sessions that belonged to
--    each of those gateway rows over to the new qap_functional_requests row instead
--    (do this AFTER step 1, and BEFORE running the column rename in section 12 if
--    you haven't already, adjusting the column name used below accordingly).
UPDATE qap_readiness_checklist_items i
SET i.functional_request_id = (
    SELECT f.id FROM qap_functional_requests f WHERE f.qa_request_id = i.functional_request_id
)
WHERE EXISTS (SELECT 1 FROM qap_functional_requests f WHERE f.qa_request_id = i.functional_request_id);

UPDATE qap_walkthrough_sessions w
SET w.functional_request_id = (
    SELECT f.id FROM qap_functional_requests f WHERE f.qa_request_id = w.functional_request_id
)
WHERE EXISTS (SELECT 1 FROM qap_functional_requests f WHERE f.qa_request_id = w.functional_request_id);

-- 3. Reset the gateway rows themselves to their new minimal status -- everything
--    that had actually been raised (anything past Draft) becomes Raised; anything
--    that was Cancelled stays Cancelled.
UPDATE qap_requests SET status = 'RAISED' WHERE status NOT IN ('DRAFT', 'CANCELLED');
```

Run steps 1-3 in this order, and only after the DDL in sections 11-12 has already been applied. As
with the SAST/DAST rename in section 8, double-check the `request_types` LIKE filters above against
your actual stored values before running this in production -- adjust if your data uses different
separators or casing.

## 14. QA Request form now collects SAST/DAST details up front (no schema change)

When "SAST" or "DAST" is ticked on the QA Request form, it now shows that request's own detail
fields (repository URL/branch/commit/tech stack/build number for SAST; application URL/environment/
auth required/test credentials/target release for DAST) so they can be filled in at raise time
instead of being left as placeholders on the auto-created request. These fields are **not** new
columns anywhere -- they're accepted as extra (non-persisted) fields on the `QARequestCreate`/
`QARequestUpdate` payload purely to seed the already-existing `qap_sast_requests`/`qap_dast_requests`
columns at the moment those rows are created (see `routers/qa_requests.py::_sync_linked_child_requests`).
No migration action needed for this section.

## 15. Performance Testing: Annexure VIII fields + 19-item pre-testing readiness checklist

**Why:** the uploaded "Annexure VIII -- QA Request Form & Checklist (Performance Testing)" reference
document specifies a richer intake form (request type, change type, vendor/SI partner, technology
stack, release/build/hash values, target promotion environment) and a formal 19-item "L1: Pre-Testing
Readiness Checklist" that must be satisfied before a Performance request can leave the Readiness
stage. Both are now captured on `qap_performance_requests` / a new child table, mirroring the same
checklist-gating pattern already used for `FunctionalRequest`/`qap_readiness_checklist_items`.

**New columns on `qap_performance_requests`:**

```sql
ALTER TABLE qap_performance_requests ADD (
    request_type                     VARCHAR2(120),  -- comma-separated: Load/Stress/Spike Testing
    change_type                      VARCHAR2(32),   -- New / Enhancement / Bug Fix
    vendor_si_partner                VARCHAR2(150),
    technology_stack                 VARCHAR2(150),
    release_version                  VARCHAR2(64),
    build_number                     VARCHAR2(64),
    hash_value                       VARCHAR2(255),
    target_promotion_environment     VARCHAR2(32)
);
```

**New table: `qap_performance_checklist_items`** (the 19-item L1 checklist, one row set seeded per
Performance request at creation time):

```sql
CREATE TABLE qap_performance_checklist_items (
    id                      NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    performance_request_id NUMBER NOT NULL,
    item                    VARCHAR2(255) NOT NULL,
    data_required           VARCHAR2(255),
    is_mandatory            NUMBER(1) DEFAULT 1,
    is_complete             NUMBER(1) DEFAULT 0,
    approved_by_id          NUMBER,
    approved_at             DATE,
    CONSTRAINT fk_qap_perf_checklist_request
        FOREIGN KEY (performance_request_id) REFERENCES qap_performance_requests(id),
    CONSTRAINT fk_qap_perf_checklist_approver
        FOREIGN KEY (approved_by_id) REFERENCES qap_users(id)
);
```

Both are additive/new, so `Base.metadata.create_all(checkfirst=True)` will pick up the new table
automatically on next startup, but the `ALTER TABLE ADD` above must be run by hand first since
`create_all` never alters existing tables (same caveat as every other section in this document).

**Workflow gate:** the existing `READINESS -> FEASIBILITY` transition (`complete-readiness` endpoint
in `routers/performance.py`) now checks that every `is_mandatory` checklist item is `is_complete`
before allowing the advance, returning a 400 listing the still-incomplete items otherwise -- same
pattern as `FunctionalRequest`'s `READINESS_VERIFICATION -> QA_ACTIVITY_INITIATED` gate. Unlike the
Functional checklist (QA-Lead-only), this one can also be ticked by the requester/department, since
the annexure frames each item as data the department supplies to QA.

**Data migration:** any existing `qap_performance_requests` row created before this change will have
no checklist rows at all (the seeding only happens at request-creation time going forward). Backfill
them once, using the same 19 items/descriptions as `constants.DEFAULT_PERFORMANCE_CHECKLIST_ITEMS`:

```sql
-- Repeat this INSERT..SELECT once per checklist item (19 total), substituting the
-- item/data_required text from constants.DEFAULT_PERFORMANCE_CHECKLIST_ITEMS, e.g.:
INSERT INTO qap_performance_checklist_items
    (performance_request_id, item, data_required, is_mandatory, is_complete)
SELECT id, 'Application Architecture Diagram', 'Architecture Diagram', 1, 0
FROM qap_performance_requests p
WHERE NOT EXISTS (
    SELECT 1 FROM qap_performance_checklist_items c
    WHERE c.performance_request_id = p.id AND c.item = 'Application Architecture Diagram'
);
-- ...repeat for the remaining 18 items.
```

**Frontend-only change (no schema impact):** the QA Request creation/edit form was also redesigned
from one long scrolling page into a multi-step wizard, adding a dedicated page per selected request
type needing extra detail up front (SAST page, DAST page, and now a Performance Testing page with
the Annexure VIII fields and a read-only preview of the 19-item checklist). This only affects
`frontend/src/pages/QARequests.tsx` -- the payload shape sent to the API, and therefore every backend
change in this section, is unchanged.

## 16. QA Request gateway: mandatory field set + new columns on qap_requests

**Why:** the gateway "Raise QA Request" form's field set (application name, owner, CR number, project
name, release version, environment, priority, risk rating) was missing several fields already
required elsewhere on the same intake -- change type, vendor/SI partner, technology stack, build
number, and a distinct target promotion environment separate from the deployment environment being
tested (same fields already captured for Performance Testing in section 15, now also collected on
the gateway itself since every request type needs them). Most of the existing fields, plus these new
ones, are now enforced as mandatory in the UI (see `REQUIRED_DETAIL_FIELDS` in `QARequests.tsx`) --
only Vendor/SI Partner and Target Release Date remain optional, matching the reference field
specification.

**New columns on `qap_requests`:**

```sql
ALTER TABLE qap_requests ADD (
    change_type                      VARCHAR2(32),   -- New / Enhancement / Bug Fix
    vendor_si_partner                VARCHAR2(150),
    technology_stack                 VARCHAR2(150),
    build_number                     VARCHAR2(64),
    target_promotion_environment     VARCHAR2(32)
);
```

`environment` (pre-existing column) is now surfaced in the UI as "Deployment Environment" and its
dropdown excludes "Dev" (SIT/UAT/Pre-Production/Production only) -- no schema change, just a
narrower set of values the application will write going forward; any existing rows with
`environment = 'Dev'` are unaffected and still display normally.

This is additive-only, so `Base.metadata.create_all(checkfirst=True)` will not touch the existing
table -- the `ALTER TABLE ADD` above must be run by hand first, same caveat as every other section in
this document. No data migration needed: new columns default to NULL on existing rows.

## 17. SAST form: multi-value Repository per component + all fields mandatory

**Why:** a single application can pull from more than one repository, each with its own branch, commit
ID, tech stack and build number -- so the SAST form's "+" now adds one whole repository component (all
5 fields together, see `RepeatableGroupInput` in `Common.tsx`), not just another URL. Used on both the
QA Request wizard's SAST step and the SAST module's own edit form (`SASTFormModal` in `SAST.tsx`). Each
of the 5 fields is stored as a single comma-separated string in its existing column -- the Nth value of
each column belongs to the Nth repository component (same positional-join pattern already used for
`request_types` on `qap_requests`) -- no new table or column needed, just more room in the existing
ones. Every field on the SAST form is mandatory in the UI, and every field of every component row must
be filled in (not just one row).

**Column width increase on `qap_sast_requests`** (existing columns were sized for one value each;
widened to comfortably hold several joined by ", "):

```sql
ALTER TABLE qap_sast_requests MODIFY repository_url VARCHAR2(1000);
ALTER TABLE qap_sast_requests MODIFY git_branch VARCHAR2(500);
ALTER TABLE qap_sast_requests MODIFY commit_id VARCHAR2(500);
ALTER TABLE qap_sast_requests MODIFY technology_stack VARCHAR2(500);
ALTER TABLE qap_sast_requests MODIFY build_number VARCHAR2(300);
```

No data migration needed -- existing single-value rows are valid as-is (a single value is just a
"list" of one), and `MODIFY` to a larger size is safe on populated Oracle columns without a rebuild.

## 18. DAST form: multi-target, dropped `target_release`, Test Credentials only shown when needed

**Why:** three changes to the DAST form (both the QA Request wizard's DAST step and the DAST module's
own edit form, `DASTFormModal` in `DAST.tsx`):

1. **Dropped `target_release`.** It duplicated Target Release Date, which is already collected once at
   QA Request creation time (`qap_requests.target_release_date`). `DASTRequest` now delegates to it via
   a read-only `target_release_date` property (same pattern as `FunctionalRequest.target_release_date`)
   instead of storing its own copy -- shown as a read-only reference on the form and detail view.
2. **Test Credentials only shows once Authentication Required is ticked** (that target's own checkbox,
   since a project can have more than one target URL, each with a different answer).
3. **Multi-target "+".** A project can scan more than one URL, each with its own environment/auth
   requirement/credentials -- the "+" adds one whole target (all 4 fields together, see
   `RepeatableRows` in `Common.tsx`), not just another URL.

**Schema changes on `qap_dast_requests`:**

```sql
-- Column dropped -- target_release_date is now sourced from qap_requests instead.
ALTER TABLE qap_dast_requests DROP COLUMN target_release;

-- application_url/environment/test_credentials widened to comfortably hold several
-- newline-joined values (one per target). authentication_required changes from a
-- true boolean to "Yes"/"No" text, newline-joined the same way -- a plain boolean
-- column can't hold more than one target's answer.
ALTER TABLE qap_dast_requests MODIFY application_url VARCHAR2(2000);
ALTER TABLE qap_dast_requests MODIFY environment VARCHAR2(500);
ALTER TABLE qap_dast_requests MODIFY test_credentials VARCHAR2(2000);
```

`authentication_required` needs a type change (`NUMBER(1)`/boolean -> `VARCHAR2`), which Oracle can't
do with a plain `MODIFY` when the column already holds data. Safest path on a populated table:

```sql
ALTER TABLE qap_dast_requests ADD authentication_required_new VARCHAR2(500);
UPDATE qap_dast_requests SET authentication_required_new = CASE WHEN authentication_required = 1 THEN 'Yes' ELSE 'No' END;
ALTER TABLE qap_dast_requests DROP COLUMN authentication_required;
ALTER TABLE qap_dast_requests RENAME COLUMN authentication_required_new TO authentication_required;
```

**Why newline-joined, not comma-joined (unlike the SAST columns in section 17):** Test Credentials is
free-text and could legitimately contain a comma (e.g. `username, password` pasted as one string) --
joining on `\n` instead avoids splitting a single credential value in two. A single-line browser text
input can't contain a literal newline, so it's a safe, unambiguous separator here.

**Note:** `DASTOut` intentionally never returns `test_credentials` to the client (write-only, same
reasoning as a password field) -- unchanged from before this update, just calling it out since it means
the edit form always starts with blank credentials per target, even when editing.

## 19. DAST Test Credentials: conditionally visible to requester/security team, plus auth-implies-required validation

**Why:** the write-only design in section 18 above meant the security team could never actually see the
credentials they'd need to start a scan. Relaxed (not removed) per request: `test_credentials` is now
returned by the API, but only to the request's own requester or a Security Analyst/Admin -- every other
viewer (SM, Department Head, other requesters) gets it blanked out server-side (`_dast_out` in
`routers/sast_dast.py`, applied to every DAST-returning endpoint). Also added: a target with
Authentication Required ticked now requires Test Credentials to be filled in, client-side, on both the
QA Request wizard's DAST step and `DASTFormModal`.

**No schema change** -- `test_credentials` already existed as a column (widened in section 18); only its
API-level visibility/authorization changed, plus new client-side validation. Nothing to run against the
database for this section.

## 20. QA Request gateway: linked child requests only created on Submit/Raise, not on Draft save

**Why:** creating the gateway record as a Draft (or editing it while still Draft) was immediately
auto-creating its linked Functional/SAST/DAST/Automation/Performance request(s) too -- so "Linked
Requests" showed real, ID-bearing child requests on a request that hadn't even been submitted yet. Per
request, nothing should get its own trackable ID until the requester actually clicks "Submit / Raise".

`_sync_linked_child_requests` (the function that creates the child request(s)) is now called from exactly
one place -- `POST /{id}/submit` -- instead of from `create_request`/`edit_request` as well. Since the
wizard's SAST/DAST/Performance detail-step fields (and the readiness-checklist self-declaration ticks)
still need to survive from Draft creation through to that later Submit call, they're now stashed
JSON-encoded on a new column, `draft_child_details`, on `qap_requests` -- merged in on every Draft-time
edit, read back and cleared the one time `submit` actually raises the request.

**Schema change on `qap_requests`:**

```sql
ALTER TABLE qap_requests ADD (draft_child_details CLOB);
```

No data migration needed -- existing rows simply get `NULL` here (meaning "nothing staged"), which is
fine since it's read as an empty stash by `_unstash_draft_details` when absent. Any already-Raised
existing request is unaffected either way, since this column is only ever read/written while a gateway
is still in `DRAFT`.

## 21. SAST/DAST components become real child tables instead of comma/newline-joined columns

**Why:** sections 17-18 above widened `qap_sast_requests`/`qap_dast_requests` so their
repository/target fields could each hold several comma- or newline-joined values (e.g.
`build_number = "1.1, 1.1"` for a project with two repositories). That worked, but it's fragile to
parse back apart and impossible to query/index properly. Per request, this is now a real one-to-many DB
relationship instead: one row per repository/target, in its own table, referencing the parent SAST/DAST
request by foreign key.

**New tables:**

```sql
CREATE TABLE qap_sast_components (
    id                 NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    sast_request_id    NUMBER NOT NULL REFERENCES qap_sast_requests(id),
    repository_url     VARCHAR2(1000),
    git_branch         VARCHAR2(500),
    commit_id          VARCHAR2(500),
    technology_stack   VARCHAR2(500),
    build_number       VARCHAR2(300)
);

CREATE TABLE qap_dast_targets (
    id                       NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    dast_request_id          NUMBER NOT NULL REFERENCES qap_dast_requests(id),
    application_url          VARCHAR2(2000) NOT NULL,
    environment              VARCHAR2(500),
    authentication_required  VARCHAR2(16) DEFAULT 'No',
    test_credentials         VARCHAR2(2000)
);
```

**Data migration -- split each existing comma/newline-joined row into its own child rows.** Run once,
after creating the tables above and before dropping the old columns. Oracle's `REGEXP_SUBSTR` splits a
delimited string by position; this walks each parent row and inserts one child row per delimited value
(stopping once `repository_url`/`application_url`, the anchor column, runs out of values -- the other
4/3 columns are assumed to have the same number of comma/newline-separated values, which
`_sync_linked_child_requests` and every place that wrote these columns always guaranteed):

```sql
-- SAST: split by ", " (comma-space, matching how the app always joined these)
DECLARE
  v_count NUMBER;
BEGIN
  FOR rec IN (SELECT id, repository_url, git_branch, commit_id, technology_stack, build_number
              FROM qap_sast_requests WHERE repository_url IS NOT NULL) LOOP
    v_count := REGEXP_COUNT(rec.repository_url, ', ') + 1;
    FOR i IN 1..v_count LOOP
      INSERT INTO qap_sast_components (sast_request_id, repository_url, git_branch, commit_id, technology_stack, build_number)
      VALUES (
        rec.id,
        TRIM(REGEXP_SUBSTR(rec.repository_url, '[^,]+', 1, i)),
        TRIM(REGEXP_SUBSTR(rec.git_branch, '[^,]+', 1, i)),
        TRIM(REGEXP_SUBSTR(rec.commit_id, '[^,]+', 1, i)),
        TRIM(REGEXP_SUBSTR(rec.technology_stack, '[^,]+', 1, i)),
        TRIM(REGEXP_SUBSTR(rec.build_number, '[^,]+', 1, i))
      );
    END LOOP;
  END LOOP;
  COMMIT;
END;
/

-- DAST: split by newline (CHR(10))
DECLARE
  v_count NUMBER;
BEGIN
  FOR rec IN (SELECT id, application_url, environment, authentication_required, test_credentials
              FROM qap_dast_requests WHERE application_url IS NOT NULL) LOOP
    v_count := REGEXP_COUNT(rec.application_url, CHR(10)) + 1;
    FOR i IN 1..v_count LOOP
      INSERT INTO qap_dast_targets (dast_request_id, application_url, environment, authentication_required, test_credentials)
      VALUES (
        rec.id,
        TRIM(REGEXP_SUBSTR(rec.application_url, '[^' || CHR(10) || ']+', 1, i)),
        TRIM(REGEXP_SUBSTR(rec.environment, '[^' || CHR(10) || ']+', 1, i)),
        NVL(TRIM(REGEXP_SUBSTR(rec.authentication_required, '[^' || CHR(10) || ']+', 1, i)), 'No'),
        TRIM(REGEXP_SUBSTR(rec.test_credentials, '[^' || CHR(10) || ']+', 1, i))
      );
    END LOOP;
  END LOOP;
  COMMIT;
END;
/
```

**Drop the old columns once every row has been migrated and verified** (compare
`SELECT COUNT(*) FROM qap_sast_components` grouped by `sast_request_id` against each parent's expected
repository count, same idea for DAST, before running these):

```sql
ALTER TABLE qap_sast_requests DROP COLUMN repository_url;
ALTER TABLE qap_sast_requests DROP COLUMN git_branch;
ALTER TABLE qap_sast_requests DROP COLUMN commit_id;
ALTER TABLE qap_sast_requests DROP COLUMN technology_stack;
ALTER TABLE qap_sast_requests DROP COLUMN build_number;

ALTER TABLE qap_dast_requests DROP COLUMN application_url;
ALTER TABLE qap_dast_requests DROP COLUMN environment;
ALTER TABLE qap_dast_requests DROP COLUMN authentication_required;
ALTER TABLE qap_dast_requests DROP COLUMN test_credentials;
```

**API-level note:** `SASTOut`/`DASTOut` now return `components`/`targets` as a list of `{id, ...}`
objects instead of the old flat comma/newline-joined fields; `SASTUpdate.components`/
`DASTUpdate.targets`, when provided, replace the request's *entire* set of child rows wholesale (delete
+ re-insert, via SQLAlchemy's `delete-orphan` cascade) rather than patching individual rows -- simplest
correct semantics for a "+"-driven repeatable list. `test_credentials` masking (section 19) now happens
per-row on `DASTTargetOut.test_credentials`, not on one whole-string field.

## 22. Performance Testing: real "Assigned To" (engineer_id) + new ENGINEER_ASSIGNED stage

**Why:** Performance Testing requests had no assignee concept at all -- Department Head approval went
straight to Readiness with nobody assigned, unlike Functional (`qa_lead_id`), SAST/DAST
(`security_lead_id`), and Automation (`engineer_id`). Per request ("real assign is required"), the
Department Head's approval now also assigns a QA Engineer/Lead, exactly like the SAST/DAST Department
Head decision assigns a Security Lead.

**New column:**

```sql
ALTER TABLE qap_performance_requests ADD (engineer_id NUMBER REFERENCES qap_users(id));
```

No data migration needed -- `NULL` correctly means "not yet assigned" for every existing row (all of
which are already past this point in their lifecycle anyway, since the column is only ever set going
forward from here).

**Lifecycle change:** a new `ENGINEER_ASSIGNED` status is inserted between
`DEPARTMENT_HEAD_APPROVAL_PENDING` and `READINESS`. `status` is a plain `VARCHAR2`, not a DB-level
enum/CHECK constraint, so no DDL is needed for the new status value itself -- only the application code
(now updated) enforces the state machine. Any Performance request currently sitting in
`DEPARTMENT_HEAD_APPROVAL_PENDING` will, once approved after this deploy, require an engineer to be
selected and will land on `ENGINEER_ASSIGNED` (not directly on `READINESS` as before) until a QA
Lead/Engineer clicks "Start Readiness".

**API-level note:** `PerformanceOut` now returns `engineer_id`; `department-head-decision`'s payload
gained a required-on-approval `engineer_id` field (`PerformanceDeptHeadDecisionIn`, mirroring
`SecurityDeptHeadDecisionIn`'s `security_lead_id`); a new `POST /api/performance-requests/{id}/start-readiness`
endpoint (QA Lead/Engineer only) advances `ENGINEER_ASSIGNED -> READINESS`.

## 23. QA Request "Edit Request" now pre-fills previously-saved SAST/DAST/Performance/checklist details

**Why:** Reopening "Edit Request" on a Draft QA Request that already had SAST/DAST/Performance details
(or checklist ticks) saved on an earlier save showed those wizard steps blank again -- the staged data
lived only in `qap_requests.draft_child_details` (a JSON blob, see section 20), which was never
exposed back to the frontend.

**No schema change** -- this is a read-only API addition. `QARequestOut` now exposes four extra
computed (not stored) fields, unstashed from the existing `draft_child_details` column at read time:
`draft_checked_items`, `draft_sast_components`, `draft_dast_components`, `draft_performance`. All four
are always empty once a request has actually been raised (submit clears `draft_child_details` -- see
section 20), so they only ever have content while the gateway is still in `DRAFT`.

## 24. Automation Testing: "Ready for Automation" readiness checklist

**Why:** Automation Testing had no readiness-checklist concept at all -- Feasibility Assessment
either advanced unconditionally or (since v8) failed straight back to the requester, with no gate
in between. The user supplied a 15-item "Ready for Automation" checklist (BRD/FRS availability,
scope finalized, test environment, test data, credentials, UI element identifiers, third-party/OTP
dependencies, etc, one item -- "Manual testing completed..." -- explicitly not mandatory) to be
enforced the same way Functional's `ReadinessChecklistItem` and Performance's
`PerformanceChecklistItem` already gate their own Pass transitions.

**New table: `qap_automation_checklist_items`** (15 fixed items, one row set seeded per Automation
request at creation time -- only while "Automation Testing" is a selected request type on the QA
Request, mirroring exactly when `qap_automation_requests` itself gets created):

```sql
CREATE TABLE qap_automation_checklist_items (
    id                      NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    automation_request_id   NUMBER NOT NULL,
    item                    VARCHAR2(255) NOT NULL,
    owner                   VARCHAR2(150),
    is_mandatory            NUMBER(1) DEFAULT 1,
    requester_checked       NUMBER(1) DEFAULT 0,
    is_complete             NUMBER(1) DEFAULT 0,
    approved_by_id          NUMBER,
    approved_at             DATE,
    CONSTRAINT fk_qap_auto_checklist_request
        FOREIGN KEY (automation_request_id) REFERENCES qap_automation_requests(id),
    CONSTRAINT fk_qap_auto_checklist_approver
        FOREIGN KEY (approved_by_id) REFERENCES qap_users(id)
);
```

This is additive/new, so `Base.metadata.create_all(checkfirst=True)` will pick it up automatically
on next startup -- no `ALTER TABLE` needed for this section.

**Workflow gate:** `POST /api/automation-requests/{id}/feasibility-decision`'s "Passed" outcome now
checks every `is_mandatory` checklist item is `is_complete` before allowing `FEASIBILITY_ASSESSMENT
-> PLANNING`, returning a 400 listing the still-incomplete items otherwise -- same pattern as
Functional's `readiness_decision` and Performance's `readiness-decision`. Like Performance's checklist
(and unlike Functional's, which is QA-Lead-only), the requester can also tick items here
(`requester_checked`, captured on the QA Request wizard's new "Automation Readiness Checklist" step,
which itself only appears while "Automation Testing" is ticked -- same conditional-visibility pattern
as the existing SAST/DAST/Performance steps) -- final `is_complete` verification is still independently
done by QA via `GET`/`PUT /api/automation-requests/{id}/checklist/{item_id}`.

**Data migration:** any existing `qap_automation_requests` row created before this change will have
no checklist rows at all. Backfill them once, using the same 15 items/owners as
`constants.DEFAULT_AUTOMATION_CHECKLIST_ITEMS`:

```sql
-- Repeat this INSERT..SELECT once per checklist item (15 total), substituting the
-- item/owner/is_mandatory values from constants.DEFAULT_AUTOMATION_CHECKLIST_ITEMS, e.g.:
INSERT INTO qap_automation_checklist_items
    (automation_request_id, item, owner, is_mandatory, requester_checked, is_complete)
SELECT id, 'BRD / FRS / approved User Stories available', 'Business / BA', 1, 0, 0
FROM qap_automation_requests a
WHERE NOT EXISTS (
    SELECT 1 FROM qap_automation_checklist_items c
    WHERE c.automation_request_id = a.id AND c.item = 'BRD / FRS / approved User Stories available'
);
-- ...repeat for the remaining 14 items (the "Manual testing completed..." row should use is_mandatory = 0).
```

## 25. Automation/Performance/Suppression: Walkthroughs + History tabs (dedicated walkthrough tables)

**Why:** Functional Testing's detail page has always had a full "Overview / Checklist / Walkthroughs
/ History" tabbed layout, but Automation, Performance, and Suppression only ever had an untabbed
Overview (Automation, Suppression) or Overview + Checklist (Performance) -- no walkthrough logging
and no visible approval-history log, even though the history data itself (`qap_approval_actions`)
already existed for every module. This section brings all three up to the same layout.

**New tables** (one per module, mirroring `qap_walkthrough_sessions` -- Functional Testing's --
rather than introducing a single shared table, consistent with how every other per-module concept
in this app, e.g. checklist items, findings, already gets its own dedicated table):

```sql
CREATE TABLE qap_automation_walkthroughs (
    id                      NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    automation_request_id   NUMBER NOT NULL,
    session_date            DATE DEFAULT SYSDATE,
    conducted_by            VARCHAR2(150),
    participants            CLOB,
    recording_path          VARCHAR2(255),
    document_path           VARCHAR2(255),
    qa_acknowledged_by_id   NUMBER,
    qa_acknowledged_at      DATE,
    notes                   CLOB,
    CONSTRAINT fk_qap_auto_walkthrough_request
        FOREIGN KEY (automation_request_id) REFERENCES qap_automation_requests(id),
    CONSTRAINT fk_qap_auto_walkthrough_qa
        FOREIGN KEY (qa_acknowledged_by_id) REFERENCES qap_users(id)
);

CREATE TABLE qap_performance_walkthroughs (
    id                      NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    performance_request_id  NUMBER NOT NULL,
    session_date            DATE DEFAULT SYSDATE,
    conducted_by            VARCHAR2(150),
    participants            CLOB,
    recording_path          VARCHAR2(255),
    document_path           VARCHAR2(255),
    qa_acknowledged_by_id   NUMBER,
    qa_acknowledged_at      DATE,
    notes                   CLOB,
    CONSTRAINT fk_qap_perf_walkthrough_request
        FOREIGN KEY (performance_request_id) REFERENCES qap_performance_requests(id),
    CONSTRAINT fk_qap_perf_walkthrough_qa
        FOREIGN KEY (qa_acknowledged_by_id) REFERENCES qap_users(id)
);

CREATE TABLE qap_suppression_walkthroughs (
    id                      NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    suppression_request_id  NUMBER NOT NULL,
    session_date            DATE DEFAULT SYSDATE,
    conducted_by            VARCHAR2(150),
    participants            CLOB,
    recording_path          VARCHAR2(255),
    document_path           VARCHAR2(255),
    qa_acknowledged_by_id   NUMBER,
    qa_acknowledged_at      DATE,
    notes                   CLOB,
    CONSTRAINT fk_qap_sup_walkthrough_request
        FOREIGN KEY (suppression_request_id) REFERENCES qap_suppression_requests(id),
    CONSTRAINT fk_qap_sup_walkthrough_qa
        FOREIGN KEY (qa_acknowledged_by_id) REFERENCES qap_users(id)
);
```

All three are additive/new, so `Base.metadata.create_all(checkfirst=True)` will pick them up
automatically on next startup -- no `ALTER TABLE` needed for this section, and no data migration
either (there's nothing to backfill; walkthrough sessions only ever get logged going forward).

**New endpoints** (mirroring `routers/functional.py`'s existing `/walkthroughs` trio exactly):
`GET/POST /api/automation-requests/{id}/walkthroughs`,
`POST /api/automation-requests/{id}/walkthroughs/{wt_id}/acknowledge`,
`GET /api/automation-requests/{id}/history` (new -- Automation didn't have one before); same three
for `/api/performance-requests/{id}/...`; and for Suppression,
`GET/POST /api/suppressions/{id}/walkthroughs` plus the acknowledge endpoint (Suppression's
`/history` already existed). All reuse the existing generic `schemas.WalkthroughCreate` /
`schemas.WalkthroughOut` / `schemas.ApprovalActionOut` schemas unchanged -- no new Pydantic models
were needed since none of these carry module-specific fields.

**Frontend-only note:** `AutomationDetail`/`PerformanceDetail`/`SuppressionDetail` (in
`pages/Automation.tsx`/`Performance.tsx`/`Suppression.tsx`) were each restructured into a tabbed
layout (`Overview` / `Checklist` -- Automation and Performance only / `Walkthroughs` / `History`),
matching `FunctionalDetail`'s existing tab structure in `pages/Functional.tsx`. No API payload shapes
changed for the pre-existing Overview-tab actions -- this is purely additive.

## 26. Performance Testing: stop duplicating gateway fields + unify checklist self-declare/QA-verify behavior

**Why:** Two consistency issues, both raised directly by the user. First, the QA Request wizard's
Performance step asked for Change Type, Vendor / SI Partner, Technology Stack, Release Version,
Build Number, Hash Value and Target Promotion Environment a second time, even though (all but Hash
Value) are already collected once on the wizard's own "Application & Change Details" step. Second,
Performance's pre-testing readiness checklist behaved differently from every other module's: it had
no `requester_checked` self-declaration concept at all, and its `update_checklist_item` endpoint let
the REQUESTER role toggle the binding `is_complete` flag directly with no server-side stage gate --
unlike Functional's checklist (QA-only, gated to `READINESS_VERIFICATION`) and unlike how Automation's
should have behaved too (it had been copied from Performance's old permissive shape instead of
Functional's real precedent -- fixed here as well).

**New column on the existing `qap_performance_checklist_items` table:**

```sql
ALTER TABLE qap_performance_checklist_items ADD (
    requester_checked NUMBER(1) DEFAULT 0
);
```

This must be run by hand (`ALTER TABLE ADD`, same caveat as every other section in this document --
`create_all(checkfirst=True)` never alters existing tables). No other schema changes in this section --
`qap_requests` already had every one of the six duplicated columns (`change_type`, `vendor_si_partner`,
`technology_stack`, `release_version`, `build_number`, `target_promotion_environment`); nothing was
added or removed there.

**Behavior change -- no schema impact:**
- `schemas.QARequestCreate` drops `performance_change_type`, `performance_vendor_si_partner`,
  `performance_technology_stack`, `performance_release_version`, `performance_build_number`,
  `performance_hash_value`, `performance_target_promotion_environment` (7 fields) and gains
  `performance_checked_items: List[str] = []` (self-declaration, same pattern as
  `automation_checked_items`). `performance_request_type` (Load/Stress/Spike Testing) is unaffected --
  it has no gateway equivalent and is still collected on the wizard.
- `routers/qa_requests.py::_sync_linked_child_requests`'s Performance block now delegates
  `change_type`/`vendor_si_partner`/`technology_stack`/`release_version`/`build_number`/
  `target_promotion_environment` straight from the parent `qa_request` (same pattern
  `application_name`/`project_name`/`environment`/`risk_category` already used) instead of reading
  performance-specific duplicate fields; `hash_value` is left `None` at intake and can be filled in
  later on the Performance request's own Edit Details page (same "fill in later" pattern as
  Automation's `framework`/`repository_url`/`ci_cd_pipeline_url`). The checklist-seeding loop now also
  sets `requester_checked=item in performance_checked_set`.
- `_stash_draft_details`/`_unstash_draft_details` extended from a 5-tuple to a 6-tuple (added
  `performance_checked_items`); `QARequestOut` gains `draft_performance_checked_items: List[str] = []`
  for Edit Request pre-fill, mirroring `draft_automation_checked_items`.
- `routers/performance.py::update_checklist_item` -- removed `Role.REQUESTER` from the allowed roles
  (now `QA_LEAD`/`QA_ENGINEER`/`BUSINESS_ANALYST` only) and added a server-side gate: the parent
  Performance request must be in `READINESS` status, otherwise 400. Same fix applied to
  `routers/automation.py::update_checklist_item` (gated to `FEASIBILITY_ASSESSMENT`).

**Frontend-only note:** the QA Request wizard's Performance step now shows only the Request Type
chip-select and a self-declare checkbox list for the 19-item checklist (replacing the old read-only
"--" preview) -- no more duplicate Change Type/Vendor/Tech Stack/Release/Build/Hash/Target Promotion
Environment inputs. `PerformanceDetail`'s Checklist tab now shows "Requester declared" / "QA verified"
columns (matching Functional's/Automation's layout) instead of a single checkbox column anyone could
tick.

## 27. Suppression request form: redesigned + every field mandatory (no schema change)

No DDL at all -- `qap_suppression_requests`/`qap_suppression_items` columns stay exactly as they are
(still nullable at the DB level). This is purely an API-validation and UI change:

- `schemas.SuppressionCreate`: `department`, `application_owner`, `risk_assessment` change from
  `Optional[str] = None` to required `str`.
- `schemas.SuppressionItemIn`: `issue_id`, `description`, `justification` change from
  `Optional[str] = None` to required `str` (`severity` was already required).
- `routers/suppression.py` gains `_require_linked_request(data)`, called from both
  `create_suppression` and `update_suppression`, which 400s unless *exactly one* of
  `sast_request_id`/`dast_request_id` is set -- matching this router's existing style of doing
  business-rule checks in the handler rather than via a pydantic validator (see the decision-endpoint
  checks earlier in the same file). This removes the previous "standalone finding with no linked
  SAST/DAST request" allowance entirely.
- `pages/Suppression.tsx`'s `NewSuppressionModal` is rebuilt into card-style `.form-section` groups
  ("Linked SAST / DAST Request", "Application Details", "Findings to Suppress", "Risk Assessment"),
  matching the QA Request wizard's redesigned look-and-feel but scoped under a new `.suppression-form`
  class in `index.css` (not a global change to `.form-section`/`.form-field`, which are shared by
  many other pages' forms). Scan Type/Application Name/Owner/Department are now always
  auto-filled-and-disabled (derived from the picked SAST/DAST request) rather than conditionally
  editable, since a link is mandatory now; `submit()` blocks and shows an inline error if no request
  is selected, since that field isn't a plain `<input required>` HTML5 can validate on its own.

**Operational note:** if there are already-saved Draft suppression rows in the live DB with neither
`sast_request_id` nor `dast_request_id` set (the old standalone-finding path), those drafts will fail
validation the next time they're edited/resubmitted via `PUT /api/suppressions/{id}` until a request
is linked. Worth a quick check (`SELECT id, suppression_id FROM qap_suppression_requests WHERE status
= 'Draft' AND sast_request_id IS NULL AND dast_request_id IS NULL`) before rolling this out, so any
affected requesters can be given a heads-up.

## 28. Fix misleading "Returned by Department Head" status on Lead/Engineer returns

**The bug:** `readiness_decision`/`feasibility_decision`'s "Failed" branch, across all four modules
that have the "require Department Head re-approval on return" checkbox (Functional, SAST/DAST,
Automation, Performance -- see v7/v8 above), set `status = RETURNED_BY_DEPARTMENT_HEAD` whenever that
checkbox was ticked. But `RETURNED_BY_DEPARTMENT_HEAD` is also the status set when the Department Head
*themselves* returns a request during their own Department Head Approval step (a completely different,
earlier event). Reusing the same status value for both meant the requester would see "Returned by
Department Head" on a request the Department Head had never actually looked at -- it was really the
assigned QA Lead/Security Lead/Engineer who returned it, just with a note that the fix will need a
fresh Department Head sign-off before resuming.

**The fix:** `status` is now always set to the actually-correct value on a "Failed" decision --
`RETURNED_BY_QA_LEAD` (Functional/Automation), `RETURNED_BY_SECURITY_LEAD` (SAST/DAST), or
`RETURNED_BY_ENGINEER` (Performance) -- never `RETURNED_BY_DEPARTMENT_HEAD`. A new boolean column,
`needs_dept_head_reapproval`, tracks the re-approval choice independently of `status`:

```sql
ALTER TABLE qap_functional_requests   ADD (needs_dept_head_reapproval NUMBER(1) DEFAULT 0);
ALTER TABLE qap_sast_requests         ADD (needs_dept_head_reapproval NUMBER(1) DEFAULT 0);
ALTER TABLE qap_dast_requests         ADD (needs_dept_head_reapproval NUMBER(1) DEFAULT 0);
ALTER TABLE qap_automation_requests   ADD (needs_dept_head_reapproval NUMBER(1) DEFAULT 0);
ALTER TABLE qap_performance_requests  ADD (needs_dept_head_reapproval NUMBER(1) DEFAULT 0);
```

- `readiness_decision`/`feasibility_decision`'s "Failed" branch now sets both: the accurate `status`,
  and `needs_dept_head_reapproval = payload.require_dept_head_reapproval` (always overwritten on every
  Fail, so a stale `True` from an earlier cycle can never leak into a later one where the box wasn't
  ticked).
- `resubmit`/`_resubmit` in all four routers now branches on `status == RETURNED_BY_<ACTOR> and
  obj.needs_dept_head_reapproval` (instead of `status == RETURNED_BY_DEPARTMENT_HEAD`) to decide
  whether to route back through `DEPARTMENT_HEAD_APPROVAL_PENDING` or straight back to the
  Readiness/Feasibility stage -- the flag is cleared (`False`) on resubmit either way, since it's been
  consumed. The genuine `RETURNED_BY_DEPARTMENT_HEAD` branch (a real direct return from Department Head
  Approval) is untouched and still routes to `DEPARTMENT_HEAD_APPROVAL_PENDING` the same as before.
- `FunctionalOut`/`SASTOut`/`DASTOut`/`AutomationOut`/`PerformanceOut` all gain
  `needs_dept_head_reapproval: bool = False`, mirrored in `types.ts`. Each module's detail page now
  shows a small "Department Head re-approval required after changes" badge next to the (now-accurate)
  status badge whenever the flag is set, so the information that used to be baked into (and distorted)
  the status itself is now surfaced separately and correctly.

**Data migration:** none needed -- `needs_dept_head_reapproval` defaults to `0`/`False` for every
existing row, which is correct (no in-flight request currently has this pending, since the column
didn't exist before). Any row *currently* sitting in `RETURNED_BY_DEPARTMENT_HEAD` status from before
this fix is ambiguous (it could be a genuine Department Head return, or a Lead/Engineer return that
hit the old bug) -- if that matters operationally, cross-reference `qap_approval_actions` for that
request's most recent step_name ("Department Head Approval" vs. "Readiness Verification"/"Security
Readiness"/"Feasibility Assessment") to tell which case it actually is.

## 29. Automation/Performance: requester can update checklist self-declaration from Edit Details (no schema change)

No DDL -- reuses the existing `requester_checked` column on `qap_automation_checklist_items`/
`qap_performance_checklist_items` (added in sections 24/26). Purely an API + UI gap fix:

- `schemas.AutomationUpdate`/`PerformanceUpdate` gain `checked_items: Optional[List[str]] = None`.
  `None` means "leave the checklist untouched" (so other Edit Details saves that don't touch the
  checklist don't accidentally clear it); a list (including `[]`) means "set `requester_checked = True`
  for exactly these items, `False` for the rest" -- same semantics as the QA Request wizard's
  `automation_checked_items`/`performance_checked_items`.
- `update_automation`/`update_performance` in their respective routers pop `checked_items` out of the
  payload before the generic `setattr` loop (it isn't a column on the request itself) and, when
  provided, sync it onto `obj.checklist_items`. Same requester-or-QA role gate and
  `AUTOMATION_EDITABLE_STATUSES`/`PERFORMANCE_EDITABLE_STATUSES` status gate as the rest of that
  endpoint already had -- no new gating needed since the checklist is just one more field on the same
  "Edit Details" save.
- `AutomationFormModal`/`PerformanceFormModal` (the "Edit Details" modals in `Automation.tsx`/
  `Performance.tsx`) now render the request's `checklist_items` as a checkbox list (pre-checked from
  each item's current `requester_checked`), and include the resulting list as `checked_items` in the
  `PUT` payload. Each row also shows a "QA verified" badge when `is_complete` is already true, purely
  informational -- ticking/unticking here only ever touches `requester_checked`, never QA's own
  `is_complete` verification.

## 30. Priority/Risk Rating move from the QA Request gateway to each linked request type

**The problem:** Priority and Risk Rating used to be collected once, on the QA Request gateway's own
"Classification" section, and copied straight onto every linked child request at creation time. That's
wrong once a single QA Request can raise more than one request type -- e.g. Automation Testing on a
change might reasonably be Low priority while Performance Testing on that same change is High. There
was no way to express that; every linked type was stuck sharing one value.

**The fix:** Priority (and Risk Rating/Risk Category, whichever name that module already used) is now
collected independently on each request type's own step of the QA Request wizard, stored on that
type's own table, and editable afterwards on that type's own "Edit Details" (or, for Functional, its
brand-new equivalent). The shared "Classification" section is removed from the wizard's "Application &
Change Details" step entirely.

```sql
ALTER TABLE qap_functional_requests   ADD (priority VARCHAR2(16));
ALTER TABLE qap_functional_requests   ADD (risk_rating VARCHAR2(16));
ALTER TABLE qap_sast_requests         ADD (priority VARCHAR2(16));
ALTER TABLE qap_dast_requests         ADD (priority VARCHAR2(16));
ALTER TABLE qap_automation_requests   ADD (priority VARCHAR2(16));
ALTER TABLE qap_performance_requests  ADD (priority VARCHAR2(16));
```

`qap_sast_requests`/`qap_dast_requests`/`qap_automation_requests`/`qap_performance_requests` already
had `risk_category` (added in earlier rounds) -- only `priority` is new on those four.
`qap_functional_requests` is the exception: it had neither column before, since Functional Testing's
descriptive fields were entirely delegated (read-only) from the gateway until now, so it gains both
`priority` and `risk_rating`.

**`qap_requests.priority`/`qap_requests.risk_rating` are deliberately NOT dropped.** They're removed
from `models.QARequest` (no longer mapped, no longer read or written by the API) but left physically
in place on the table -- harmless, unused columns -- rather than risking a DDL `DROP COLUMN` against
a live table. They can be dropped in a later cleanup pass once this change has been running safely for
a while:

```sql
-- Optional future cleanup, NOT part of this rollout:
-- ALTER TABLE qap_requests DROP COLUMN priority;
-- ALTER TABLE qap_requests DROP COLUMN risk_rating;
```

**API changes:**

- `schemas.QARequestCreate` drops `priority`/`risk_rating`; gains `functional_priority`/
  `functional_risk_rating`, `sast_priority`/`sast_risk_category`, `dast_priority`/`dast_risk_category`,
  `automation_priority`/`automation_risk_category`, `performance_priority`/`performance_risk_category`.
  `schemas.QARequestOut` drops `priority`/`risk_rating`, gains `draft_classification: dict` (staged
  Draft values, same pre-fill pattern as the existing `draft_checked_items`/`draft_sast_components`/
  etc.).
- `schemas.FunctionalOut`/`SASTOut`/`DASTOut`/`AutomationOut`/`PerformanceOut` each gain `priority:
  Optional[str] = None` (Functional already had `priority`/`risk_rating` as delegated fields -- they're
  now real, independently-editable columns instead, same field names). A new `schemas.FunctionalUpdate`
  (`priority`/`risk_rating` only) backs the new `PUT /api/functional-requests/{id}` endpoint in
  `routers/functional.py`, gated by a new `constants.FUNCTIONAL_EDITABLE_STATUSES` (renamed from a
  pre-existing, previously-unused `QA_REQUEST_EDITABLE_STATUSES` with identical values). `SASTUpdate`/
  `DASTUpdate`/`AutomationUpdate`/`AutomationCreate`/`PerformanceUpdate`/`PerformanceCreate` each gain
  `priority: Optional[str] = None` next to their existing `risk_category` -- no router changes needed
  there, since `update_sast`/`update_dast`/`update_automation`/`update_performance` already apply
  `payload.model_dump(exclude_unset=True)` generically via `setattr`, with no field allowlist.
- `models.QARequest._draft_details()`/`draft_classification` and
  `routers/qa_requests.py::_stash_draft_details`/`_unstash_draft_details` extend the existing
  draft-staging JSON (`draft_child_details`) with one new merged `classification` dict, carrying every
  per-module Priority/Risk key together rather than growing the staging tuple by 8-10 more discrete
  scalar members. `_sync_linked_child_requests` reads each module's own keys back out of that dict
  when creating the linked request at Submit/Raise time (Performance's `performance_priority`/
  `performance_risk_category` are the one exception -- they're already swept into the pre-existing
  `performance_details` dict via its "performance_" prefix match, so they're read from there instead of
  duplicated into the classification dict).
- `schemas.LinkedRequestRef` (the minimal cross-reference shape used by
  `QARequestOut.linked_functional_requests`/`linked_sast_requests`/etc.) gains `priority`,
  `risk_rating`, `risk_category` so the QA Request gateway's own list/detail views can show a
  per-type Priority/Risk breakdown. Only one of `risk_rating` (Functional) / `risk_category` (the
  other four) is ever populated per row -- each model now exposes both as either a real column or a
  `None`-returning `@property`, so the shared schema shape works uniformly without an
  `AttributeError` on whichever one that model doesn't have a real column for.
- `routers/reports.py::qa_request_summary` replaces its single `"Priority"`/`"Risk Rating"` columns
  with one `"Priority / Risk (per type)"` string, joining `"<Type>: <priority>/<risk>"` for every
  request type actually linked to that QA Request.

**Frontend changes:** `QARequests.tsx`'s wizard drops the shared "Classification" section from
"Application & Change Details"; gains a new "Functional Classification" wizard step (shown whenever
Functional/Sanity/Regression Testing/UAT Support is selected) plus a Priority + Risk Category field
pair at the top of the existing SAST/DAST/Automation/Performance steps. `Functional.tsx` gains a new
`FunctionalFormModal` ("Edit Details") and button, gated on `FUNCTIONAL_EDITABLE_STATUSES`. `SAST.tsx`/
`DAST.tsx`/`Automation.tsx`/`Performance.tsx`'s existing "Edit Details" modals each gain a Priority
field next to their existing Risk Category field.

**Data migration:** none needed for the new columns -- they default to `NULL` for every existing row.
Existing linked Functional/SAST/DAST/Automation/Performance requests will show a blank Priority (and
Functional will also show a blank Risk Rating) until someone edits them via the new per-type Edit
Details, since there's no reliable way to backfill "the right" per-type value from the old shared
`qap_requests.priority`/`risk_rating` (that's exactly the ambiguity this change fixes). If a one-time
backfill from the old shared value is wanted as a starting point (better than blank, not necessarily
correct per type), something like:

```sql
UPDATE qap_functional_requests f
   SET (priority, risk_rating) = (
     SELECT r.priority, r.risk_rating FROM qap_requests r WHERE r.id = f.qa_request_id
   )
 WHERE f.qa_request_id IS NOT NULL AND f.priority IS NULL;

UPDATE qap_sast_requests s
   SET priority = (SELECT r.priority FROM qap_requests r WHERE r.id = s.qa_request_id)
 WHERE s.qa_request_id IS NOT NULL AND s.priority IS NULL;

UPDATE qap_dast_requests d
   SET priority = (SELECT r.priority FROM qap_requests r WHERE r.id = d.qa_request_id)
 WHERE d.qa_request_id IS NOT NULL AND d.priority IS NULL;

UPDATE qap_automation_requests a
   SET priority = (SELECT r.priority FROM qap_requests r WHERE r.id = a.qa_request_id)
 WHERE a.qa_request_id IS NOT NULL AND a.priority IS NULL;

UPDATE qap_performance_requests p
   SET priority = (SELECT r.priority FROM qap_requests r WHERE r.id = p.qa_request_id)
 WHERE p.qa_request_id IS NOT NULL AND p.priority IS NULL;
```

## 31. Functional Testing: show and edit the rest of "Application & Change Details"/"Release & Environment"

**No DDL at all** -- every field involved already exists as a real column on `qap_requests`; this is
purely a `models.FunctionalRequest`/`schemas`/router/frontend change, reusing the exact same
delegated-property pattern `application_name`/`project_name`/`department`/`application_owner` already
used.

**The gap:** Functional Testing's Overview only ever showed Department, Project, Target Release Date,
Request Type(s) and the people-assignment fields -- CR Number, Change Type, Deployment Environment,
Target Promotion Environment, Release Version and Build Number were never surfaced at all, even though
SAST/DAST/Automation/Performance's own Overviews already show most of these (each delegates them from
the same `qap_requests` row). Worse, once the QA Request gateway itself leaves `DRAFT` it can no
longer be edited via `PUT /api/qa-requests/{id}` (see `GATEWAY_EDITABLE_STATUSES` = `['DRAFT']`), and
until now Functional's own "Edit Details" (added in section 30) only covered Priority/Risk Rating --
so a typo in, say, CR Number or Release Version had no fix once the request was raised.

**The fix:**

- `models.FunctionalRequest` gains 6 more delegated (read-only `@property`) lookups, same shape as the
  existing ones: `cr_number`, `change_type`, `environment`, `target_promotion_environment`,
  `release_version`, `build_number` -- each reads `self.qa_request.<field>`.
- `schemas.FunctionalOut` gains those same 6 fields.
- `schemas.FunctionalUpdate` gains `project_name`, `cr_number`, `change_type`, `environment`,
  `target_promotion_environment`, `release_version`, `build_number`, `target_release_date` (alongside
  the existing `priority`/`risk_rating`). `routers/functional.py::update_functional` now splits the
  payload: `priority`/`risk_rating` are `setattr` onto the `FunctionalRequest` row itself (real
  columns); everything else is `setattr` onto `obj.qa_request` instead (they're read-only properties
  on `FunctionalRequest`, so writing to `obj` directly would raise `AttributeError` -- no setter).
  Department/Application Name/Application Owner are deliberately still not editable anywhere (fixed to
  the requester's own profile / not meaningfully editable after intake).
- `types.ts`'s `FunctionalOut` and `pages/Functional.tsx` mirror both changes: the Overview grid now
  shows all 6 new fields, and `FunctionalFormModal` ("Edit Details") gains input/select fields for all
  of them plus Project Name and Target Release Date, sent together with Priority/Risk Rating in one
  `PUT` request.

**Data migration:** none -- nothing new is stored; this only changes which existing `qap_requests`
columns are readable/writable from the Functional Testing Request's own page.

## 32. Application Name / Project Name / CR Number become Admin-only to edit once a request exists

**No schema change** -- every field involved already exists; this only tightens who can change them
through the API, and updates the frontend's "Edit Details" modals to match.

**The problem:** Application Name, Project Name and CR Number identify *which* request a given
Functional/SAST/Automation/Performance Testing Request actually is. Their "Edit Details" endpoints
(`PUT /api/functional-requests/{id}`, `/api/sast-requests/{id}`, `/api/automation-requests/{id}`,
`/api/performance-requests/{id}`) previously let the same requester-or-QA role gate that covers every
other field (framework, repository URL, risk category, etc.) also cover these three -- meaning the
requester (or a QA Lead/Engineer) could quietly rename the application or change its CR Number after
the request had already been raised and was moving through approvals, with no extra check. (DAST has
no editable equivalent of these three -- it delegates them read-only from the QA Request gateway --
so it needed no change here.)

**The fix:** Each of the four routers gains a small `_ADMIN_ONLY_FIELDS = {"application_name",
"project_name", "cr_number"}` check, run right after the existing role/status gates and before the
generic field-by-field update:

```python
if not current_user.has_role(Role.ADMIN):
    for f in _ADMIN_ONLY_FIELDS:
        if f in data and data[f] != getattr(obj, f):
            raise HTTPException(403, f"Only an Administrator can change {f.replace('_', ' ').title()}")
```

A submitted value that's identical to the request's current one is let through for anyone -- that's
not actually a change, just the form resubmitting a field it also displays alongside the ones it *is*
allowed to edit. Only a genuine attempt to alter one of the three is blocked. `schemas.FunctionalUpdate`
also gains `application_name` (it wasn't editable there at all before this round, only shown
read-only) -- alongside `project_name`/`cr_number` added in section 30/31 -- so Functional now has the
same three admin-gated fields as SAST/Automation/Performance.

- `routers/functional.py::update_functional`, `routers/sast_dast.py::update_sast`,
  `routers/automation.py::update_automation`, `routers/performance.py::update_performance` each gain
  the check above (Functional's compares against the delegated property, which reads through to
  `qa_request` -- same as the rest of that endpoint already does).
- `Functional.tsx`'s `FunctionalFormModal`, `SAST.tsx`'s `SASTFormModal`, `Automation.tsx`'s
  `AutomationFormModal`, and `Performance.tsx`'s `PerformanceFormModal` each disable (rather than hide)
  the Application Name/Project Name/CR Number inputs for non-Admins, with a short note explaining why
  -- the values are still visible, just locked, and the backend enforces the same rule independently
  of whether the frontend disabled them.

**Data migration:** none.

## 33. New table: qap_module_documents (multi-document upload for every module except the Gateway)

**The ask:** every request type should support uploading multiple supporting documents any time
after the request has been raised -- not just at intake, and not just the Gateway QA Request (which
already had this via `qap_request_documents`/`routers/qa_requests.py`, Module 1 field 4.1.2).

**The design choice:** rather than adding 7 more tables nearly identical to `qap_request_documents`
(one each for Functional/SAST/DAST/Automation/Performance/Suppression/Sign-off), this adds a single
shared table, polymorphic on `(module, request_id)` -- the same pattern `qap_approval_actions` already
uses via `(entity_type, entity_id)`. The one thing this deliberately does differently: every module
here gets its own distinct `module` string (`FUNCTIONAL` / `SAST` / `DAST` / `AUTOMATION` /
`PERFORMANCE` / `SUPPRESSION` / `SIGNOFF`), so `(module, request_id)` is always unambiguous -- unlike
`qap_approval_actions.entity_type`, where SAST and DAST unsafely share the string `"SAST_DAST"`
despite each table having its own independent id sequence (see the collision note on
`_sast_dast_history()` in `routers/sast_dast.py`, added alongside the export feature in section 32's
predecessor round). This table's design avoids repeating that mistake.

```sql
CREATE TABLE qap_module_documents (
    id              NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    module          VARCHAR2(20) NOT NULL,
    request_id      NUMBER NOT NULL,
    file_name       VARCHAR2(255) NOT NULL,
    stored_path     VARCHAR2(500) NOT NULL,
    content_type    VARCHAR2(150),
    file_size       NUMBER,
    uploaded_by_id  NUMBER,
    uploaded_at     DATE DEFAULT SYSDATE,
    CONSTRAINT fk_qap_module_doc_uploader FOREIGN KEY (uploaded_by_id) REFERENCES qap_users(id)
);
CREATE INDEX ix_qap_module_documents_module ON qap_module_documents(module);
CREATE INDEX ix_qap_module_documents_request_id ON qap_module_documents(request_id);
```

This table is brand new and will be created automatically by `Base.metadata.create_all(checkfirst=True)`
on next startup, but create it by hand ahead of a production deploy as with the others (see section 7).

Files are stored on disk under `backend/app/uploads/<module>/<request's own request_id/suppression_id/
certificate_id string>/<filename>` -- the same physical `backend/app/uploads/` folder the Gateway's
own documents already use, just namespaced by module subfolder so filenames never collide across
modules. New shared helper module `backend/app/documents.py` (`list_documents`/`save_documents`/
`get_document_or_404`/`full_path`) implements the list/upload/download logic once; each of the 7
routers (`functional.py`, `sast_dast.py` twice for SAST and DAST, `automation.py`, `performance.py`,
`suppression.py`, `signoff.py`) just adds three thin endpoints -- `GET .../{id}/documents`,
`POST .../{id}/documents`, `GET .../{id}/documents/{doc_id}/download` -- calling into it with their
own module string. Frontend: one new shared `RequestDocuments` component (`components/Common.tsx`)
renders the file list + multi-file upload form, reused as a new "Documents" tab on Functional/SAST/
DAST/Automation/Performance/Suppression's existing tabbed detail views, and as an always-visible
section on Sign-off's (which has no tabs).

**Data migration:** none -- brand new, empty table.

## 34. New tables: qap_sast_walkthroughs, qap_dast_walkthroughs (Walkthroughs + History tabs for SAST/DAST)

**The gap:** every other module (Functional, Automation, Performance, Suppression) already has a
walkthrough table and a History tab; SAST and DAST had neither.

```sql
CREATE TABLE qap_sast_walkthroughs (
    id                     NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    sast_request_id        NUMBER,
    session_date           DATE DEFAULT SYSDATE,
    conducted_by           VARCHAR2(150),
    participants           CLOB,
    recording_path         VARCHAR2(255),
    document_path          VARCHAR2(255),
    qa_acknowledged_by_id  NUMBER,
    qa_acknowledged_at     DATE,
    notes                  CLOB,
    CONSTRAINT fk_qap_sast_wt_request FOREIGN KEY (sast_request_id) REFERENCES qap_sast_requests(id),
    CONSTRAINT fk_qap_sast_wt_ack_by FOREIGN KEY (qa_acknowledged_by_id) REFERENCES qap_users(id)
);

CREATE TABLE qap_dast_walkthroughs (
    id                     NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    dast_request_id        NUMBER,
    session_date           DATE DEFAULT SYSDATE,
    conducted_by           VARCHAR2(150),
    participants           CLOB,
    recording_path         VARCHAR2(255),
    document_path          VARCHAR2(255),
    qa_acknowledged_by_id  NUMBER,
    qa_acknowledged_at     DATE,
    notes                  CLOB,
    CONSTRAINT fk_qap_dast_wt_request FOREIGN KEY (dast_request_id) REFERENCES qap_dast_requests(id),
    CONSTRAINT fk_qap_dast_wt_ack_by FOREIGN KEY (qa_acknowledged_by_id) REFERENCES qap_users(id)
);
```

Both tables are brand new and will be created automatically by `Base.metadata.create_all(checkfirst=True)`
on next startup, but create them by hand ahead of a production deploy as with the others (see section 7).

New endpoints: `GET/POST /api/sast-requests/{id}/walkthroughs`,
`POST /api/sast-requests/{id}/walkthroughs/{wt_id}/acknowledge`, `GET /api/sast-requests/{id}/history`,
and the same four for `/api/dast-requests/...` -- all in `routers/sast_dast.py`, mirroring
`routers/functional.py`'s equivalents. The two `GET .../history` endpoints use a new helper,
`_sast_dast_history_rows()`, sitting alongside the existing `_sast_dast_history()` (used by the PDF
export) -- same id-collision guard (SAST and DAST share the `"SAST_DAST"` `ApprovalAction.entity_type`
string but have independent id sequences), just returning raw ORM rows instead of PDF-formatted tuples
so `schemas.ApprovalActionOut` can serialize them directly for the frontend (which resolves actor names
client-side, same as every other module's History tab). On a collision, returns an empty list rather
than risk mixing SAST/DAST rows.

Frontend: `SAST.tsx`/`DAST.tsx` each gain "Walkthroughs" and "History" tabs plus an `AddWalkthrough`
form component, both copy-pasted from `Functional.tsx`'s equivalents with the request-type-specific
endpoint paths swapped in.

**Also in this round, no schema change:** the PDF export's "Findings" section for SAST/DAST
(`export_sast`/`export_dast` in `routers/sast_dast.py`) previously listed every finding's full
issue_id/severity/status/description -- now a new `_findings_summary()` helper reduces it to a
count-per-severity summary plus an Open/Resolved split, keeping the export short. The Findings tab
itself (on-screen) is unchanged -- still shows full per-finding detail.

**Data migration:** none -- both tables brand new, empty.

## 35. Readiness checklists non-mandatory except SAST/DAST readiness; QA can no longer verify an item the requester didn't self-declare (no schema change)

**Two related behavior changes, no schema change:**

1. Every readiness checklist item is now seeded with `is_mandatory=False`, **except** the Functional
   checklist's conditional "SAST readiness"/"DAST readiness" items (`constants.CONDITIONAL_CHECKLIST_ITEMS`),
   which keep their existing behavior -- mandatory only when SAST/DAST was actually selected as a request
   type. This affects `constants.checklist_item_is_mandatory()` (Functional's `qap_readiness_checklist_items`,
   seeded in `routers/qa_requests.py::_sync_linked_child_requests`), `constants.DEFAULT_AUTOMATION_CHECKLIST_ITEMS`
   (Automation's `qap_automation_checklist_items`, all 15 items now `False`), and the Performance seeding loop
   in the same function (`qap_performance_checklist_items`, all 19 items now `False`, was hardcoded `True`).
   Practically: an unticked item no longer blocks `readiness_decision`/`feasibility_decision`'s "Passed"
   outcome on Functional/Automation/Performance requests -- only the Functional gateway's SAST/DAST
   readiness items still hard-block when applicable.

2. `PUT /api/{functional,automation,performance}-requests/{req_id}/checklist/{item_id}` (the QA-verify
   endpoint) now rejects `is_complete: true` with a 400 if `requester_checked` is `false` on that item --
   the QA Lead/Engineer/BA can only verify an item the requester has already self-declared ready via their
   own Edit Details form, never tick one on the requester's behalf. Un-checking (`is_complete: false`) is
   still always allowed. The frontend mirrors this by disabling that checkbox (`Functional.tsx`/
   `Automation.tsx`/`Performance.tsx`) whenever `!c.requester_checked && !c.is_complete`.

**Existing in-flight requests:** rows already seeded before this change keep whatever `is_mandatory` value
they were created with (this only changes what gets written for *newly created* checklist items going
forward) -- if you want the new non-mandatory behavior applied retroactively to requests already sitting
in Readiness Verification/Feasibility Assessment, run:

```sql
UPDATE qap_readiness_checklist_items SET is_mandatory = 0
  WHERE item NOT IN ('SAST readiness', 'DAST readiness');
UPDATE qap_automation_checklist_items SET is_mandatory = 0;
UPDATE qap_performance_checklist_items SET is_mandatory = 0;
```

Optional -- these gates only ever blocked forward progress, so leaving old rows as-is just means a
request already mid-flight keeps whatever mandatory set it started with.

## 36. Dashboard: "My Requests & My Department" moved out of Dashboard into its own tab (no schema/backend change)

Frontend-only. `Dashboard.tsx`'s Dashboard tab previously embedded a department/personal-scoped
card ("My Requests & My Department", toggling between the logged-in user's own requests and their
department's, capped at 8 rows) alongside the org-wide stats -- moved into a new dedicated top-level
tab, `MyRequestsTab` (labelled "My Requests" in the tab bar), with no row cap. Dashboard's "At a
Glance" row now shows an org-wide "Active requests (org-wide)" stat instead of a "My active requests"
one, so the default dashboard view is unscoped/organization-wide throughout. No backend endpoints
changed -- `dashboard.py`'s endpoints never filtered by department to begin with; this was purely a
frontend layout change.

## 37. QA Sign-off Certificate: raise straight from a Functional Testing Request at QA Completed, auto-populated from it (no schema change)

Implements the workflow requirement that once a Functional Testing Request reaches `QA_COMPLETED`,
the QA Lead can raise its QA Sign-off Certificate directly from that request instead of separately
filling one out from scratch on the Sign-off page, with every field that identifies *which* request
the certificate is for derived from it and locked against editing.

1. **`FunctionalRequest.technology_stack` (new delegated property, `models.py`)** -- `FunctionalRequest`
   already delegated `cr_number`/`change_type`/`environment`/`target_promotion_environment`/
   `release_version`/`build_number` from its parent `qa_request` (section 20) but was missing
   `technology_stack`, which exists on `QARequest`/`SASTRequest`/`SuppressionRequest`. Added as a
   read-only `@property` returning `self.qa_request.technology_stack` -- no new column, nothing to
   migrate. Exposed on `schemas.FunctionalOut.technology_stack` and `types.ts`'s `FunctionalOut`
   the same way every other delegated field already was.

2. **`POST /api/functional-requests/{id}/request-signoff` now accepts an optional `signoff_id`
   (`schemas.RequestSignoffIn`, new schema, no table change)** -- when present, it's checked against
   `qap_signoffs` and written onto `FunctionalRequest.signoff_id` (an existing column) before the
   status moves to `QA_SIGNOFF_PENDING`, so the certificate created moments earlier is linked
   immediately instead of only at `confirm-signoff` time. Passing no body (or omitting `signoff_id`)
   still works exactly as before -- fully backward compatible.

3. **Frontend-only (`SignOff.tsx`, `Functional.tsx`)** -- `NewSignOffModal` (used by both the
   standalone Sign-off page and, now, Functional's own detail view) takes a new optional
   `presetRequest?: FunctionalOut` prop:
   - Without it (Sign-off page's "+ New Sign-off Certificate"), a new `TestingRequestIdSearch`
     component -- modeled on `Suppression.tsx`'s `RequestIdSearch` autosuggest pattern -- lets the
     QA Lead search Functional Testing Requests in QA_COMPLETED/QA_SIGNOFF_PENDING/QA_SIGNED_OFF/
     REQUESTER_VERIFICATION/CLOSED and pick one (with a "Change" option after picking).
   - With it (Functional's own "Request Sign-off" button, now opening this modal instead of
     immediately calling the API), the Testing Request ID is locked to that specific request from
     the start -- no search box shown at all.
   - Either way, selecting/presetting a request auto-populates and **locks** (always-disabled
     inputs) Application Name, Application Owner, Department, and Change Request ID(s) -- these can
     never drift from the request the certificate is actually for. It also auto-populates (but
     leaves editable) Technology Stack, Release Version, Build Number, Testing Type (hardcoded
     "Functional"), Environment Tested, and Target Promotion Environment.
   - Every visible field is now `required`; since disabled inputs are skipped by native HTML
     validation, submit is additionally blocked in JS if no Testing Request has been selected yet.
   - On successful creation, `Functional.tsx` immediately calls `request-signoff` with the new
     certificate's id (`{ signoff_id: cert.id }`, see item 2 above) rather than leaving the two
     steps disconnected.

No `schemas.SignOffCreate` field became backend-required -- "mandatory" is enforced frontend-only
via `required` inputs, matching the existing project convention (see section on Suppression's
all-fields-mandatory redesign) rather than tightening the Pydantic schema.

No DDL changes in this section -- `qap_signoffs`, `qap_functional_requests.signoff_id`, and every
column referenced above already existed.

## 38. SAST/DAST History tab was blank -- ApprovalAction entity_type collision fix (no schema change)

Bug fix, no DDL. `routers/sast_dast.py::_log()` wrote every SAST **and** DAST workflow action to the
generic `qap_approval_actions` audit log under one shared `entity_type` string, `"SAST_DAST"`. But
`SASTRequest` and `DASTRequest` each have their own independent id sequence (`pk_column()`), so a SAST
request and a DAST request very commonly end up with the same numeric id (e.g. both id=5, since both
sequences start at 1 and requests of each type tend to be raised in similar numbers together). The
existing `_sast_dast_history()`/`_sast_dast_history_rows()` helpers already *knew* about this collision
risk and had a guard for it -- but the guard's fallback, on detecting a collision, was to return an
**empty list** instead of the (possibly ambiguous) rows. In practice this meant almost every SAST/DAST
request's History tab came back completely blank, not just the genuinely ambiguous ones, which is what
was reported.

Fixed by logging against a request-type-specific `entity_type` going forward -- `"SAST"` or `"DAST"`,
chosen via `isinstance(obj, models.SASTRequest)` in `_log()` -- so `entity_type` + `entity_id` uniquely
identifies a request again and the collision case can't happen for new rows at all. Old rows already
written under the shared `"SAST_DAST"` string are still read back in via a `_legacy_history_rows()`
fallback, merged into the same result, but only when there's no id collision for that particular
request (same safety check as before, just no longer the *only* code path). `routers/approvals.py`'s
cross-entity Approval Workflow Log (`_resolve_request_ref`) gained explicit `"SAST"`/`"DAST"` branches
alongside the legacy `"SAST_DAST"` one; `Approvals.tsx`'s entity-type filter dropdown now offers `SAST`
and `DAST` as their own filter options (`SAST_DAST` kept in the list too, for filtering to older rows).

No DDL changes -- `qap_approval_actions.entity_type` was already a plain `String(32)` column; this only
changes which string value gets written into existing rows going forward. No backfill needed or
possible (old `"SAST_DAST"` rows genuinely can't be reliably re-attributed to one table or the other
after the fact where a collision existed at the time).

## 39. SAST/DAST: new "Security Readiness" pre-scan checklist (own tables, no existing schema change)

SAST and DAST previously had no checklist concept at all at their own "Security Readiness" step --
unlike Functional (`qap_readiness_checklist_items`), Automation (`qap_automation_checklist_items`), and
Performance (`qap_performance_checklist_items`), which each have one. Added two new tables, mirroring
that same established shape:

```sql
CREATE TABLE qap_sast_checklist_items (
    id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    sast_request_id NUMBER REFERENCES qap_sast_requests(id),
    item VARCHAR2(255) NOT NULL,
    owner VARCHAR2(150),
    is_mandatory NUMBER(1) DEFAULT 0,
    requester_checked NUMBER(1) DEFAULT 0,
    is_complete NUMBER(1) DEFAULT 0,
    approved_by_id NUMBER REFERENCES qap_users(id),
    approved_at TIMESTAMP
);

CREATE TABLE qap_dast_checklist_items (
    id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    dast_request_id NUMBER REFERENCES qap_dast_requests(id),
    item VARCHAR2(255) NOT NULL,
    owner VARCHAR2(150),
    is_mandatory NUMBER(1) DEFAULT 0,
    requester_checked NUMBER(1) DEFAULT 0,
    is_complete NUMBER(1) DEFAULT 0,
    approved_by_id NUMBER REFERENCES qap_users(id),
    approved_at TIMESTAMP
);
```

Seeded with the same 9 fixed items (`constants.DEFAULT_SECURITY_CHECKLIST_ITEMS`) onto every
auto-created SASTRequest/DASTRequest in `routers/qa_requests.py::_sync_linked_child_requests`, same
pattern as the other three checklists. None are mandatory by default (matching the established
convention from section 35 -- self-declared/QA-or-Security-verified for visibility, not a hard gate),
though `routers/sast_dast.py::_readiness_decision` does now check for mandatory pending items before
allowing "Passed", same as Functional's/Automation's readiness gates, in case that default ever changes
per-item.

`requester_checked` (self-declaration) is set via the existing `PUT /api/{sast,dast}-requests/{id}`
Edit Details endpoint's new optional `checked_items` field (mirrors `AutomationUpdate.checked_items`
from section 6) -- no wizard step collects this at QA Request intake time (unlike Functional/
Automation/Performance), so every item starts unticked until the requester revisits Edit Details.
`is_complete` (binding verification) is set via two new endpoints, `GET/PUT
/api/{sast,dast}-requests/{id}/checklist[/{item_id}]`, restricted to QA Lead/Security Analyst, gated to
the `SECURITY_READINESS` status, and carrying the same "can't verify what the requester hasn't
self-declared" 400 guard as every other checklist (section 35, part 2).

Frontend-only additions: a new "Checklist" tab on both `SAST.tsx`/`DAST.tsx` (mirrors
`Performance.tsx`'s Checklist tab), and a "Security Readiness Checklist — Self-Declaration" section
added to both modules' Edit Details modal (mirrors `PerformanceFormModal`'s equivalent section).
`SASTOut`/`DASTOut` gained a `checklist_items` field reusing the existing `ChecklistItemOut` schema
(identical shape to Functional's own checklist item -- no new Pydantic model needed).

## 40. Tester-assignment history log showed raw ids instead of names (no schema change)

Bug fix, no DDL. `routers/functional.py::assign_tester` logged the History tab entry as
`f"Assigned tester user ids: {payload.tester_ids}"` -- e.g. literally `"Assigned tester user ids:
[3]"` -- instead of resolving those ids to the testers' names first. Fixed to look the ids up
(`db.query(models.User).filter(models.User.id.in_(payload.tester_ids))`) and log
`f"Assigned tester(s): {', '.join(tester_names)}"` instead, falling back to `"user #<id>"` for any id
that doesn't resolve to an active user. `models.ApprovalAction.comments` is free text either way -- no
column change.

## 41. Edit Details restricted to requester / SM / Department Head (QA loses edit access) -- no schema change

Frontend+backend-only, no DDL. Across all 5 request types (Functional, SAST, DAST, Automation,
Performance), the "Edit Details" action previously allowed the requester **or** the QA-side role for
that module (`QA_LEAD`/`QA_ENGINEER` for Functional/Automation/Performance, `SECURITY_ANALYST` for
SAST/DAST) to edit, in addition to Admin. Per request, editing a raised request is now a business-side
concern only: **requester, SM (same department as the request), Department Head (same department), or
Admin** -- QA no longer has edit access at all, on any of the five request types.

Backend (`update_functional`/`update_sast`/`update_dast`/`update_automation`/`update_performance`):
the role check changed from
`obj.requester_id != current_user.id and not current_user.has_role(Role.QA_LEAD, Role.QA_ENGINEER/​Role.SECURITY_ANALYST, Role.ADMIN)`
to a two-step check --

```python
if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
    if not current_user.has_role(Role.SM, Role.DEPARTMENT_HEAD):
        raise HTTPException(403, "Only the requester, SM, Department Head, or an admin can edit this request")
    require_same_department(current_user, obj.department)
```

reusing the existing `deps.require_same_department` helper (already used by every module's own SM/
Department Head *approval* checkpoints) so SM/Department Head editors are scoped to their own
department, exactly like their approval actions already are.

The existing `*_EDITABLE_STATUSES` lists (`FUNCTIONAL_EDITABLE_STATUSES` etc.) were **not** changed --
they already only include `DRAFT`/`RETURNED_BY_SM`/`RETURNED_BY_DEPARTMENT_HEAD`/`RETURNED_BY_QA_LEAD`
(or the SAST/DAST/Automation/Performance equivalents), i.e. every status up to and including Department
Head approval, plus "returned to requester" afterward -- so "no edit can be performed from Department
Head approval until it's returned to requester" was already correctly enforced by status alone; this
change only tightens *who*, not *when*.

Frontend: each module's `canEditDetails` boolean changed the same way, e.g. (Functional.tsx):

```tsx
const canEditDetails = (isRequester || hasRole(user, 'ADMIN') || (hasRole(user, 'SM', 'DEPARTMENT_HEAD') && sameDept))
  && FUNCTIONAL_EDITABLE_STATUSES.includes(status)
```

`sameDept` was already computed in every one of these components (it already fed `canSMDecide`/
`canDeptHeadDecide`) -- this just reuses it for the Edit Details gate too. `hasRole(user, 'ADMIN')` is
checked as its own OR branch, not folded into the `SM`/`DEPARTMENT_HEAD` group, so an Admin isn't also
required to pass the `sameDept` check (matching the backend's own admin bypass in
`require_same_department`).

## 42. SAST/DAST Security Readiness checklist split into per-module item lists + mandatory items now gate Submit itself (no schema change)

Frontend+backend-only, no DDL -- `qap_sast_checklist_items`/`qap_dast_checklist_items` (section 39)
already had an `is_mandatory` column; this only changes what gets seeded into it and adds a new place
that column is enforced.

1. **Per-module item lists.** `constants.DEFAULT_SECURITY_CHECKLIST_ITEMS` (one shared 9-item list,
   all non-mandatory, section 39) was replaced with two separate lists matching the exact items/
   mandatory flags supplied:

   `DEFAULT_SAST_CHECKLIST_ITEMS` (3 items):
   - Application/source code repository access provided to the scan team -- **mandatory**
   - Change freeze / business hours confirmed for the scan window
   - Point of contact identified for application/code-level queries during the scan

   `DEFAULT_DAST_CHECKLIST_ITEMS` (7 items):
   - Test environment / application URL accessible and stable -- **mandatory**
   - Test accounts and role-based credentials provided -- **mandatory**
   - Firewall / VPN / IP whitelisting completed for scan tool access -- **mandatory**
   - Change freeze / business hours confirmed for the scan window
   - Backup taken / rollback plan confirmed before scanning starts
   - Third-party services, OTP, CAPTCHA and payment dependencies identified with test-mode or bypass
     mechanisms
   - Point of contact identified for application/code-level queries during the scan

   `routers/qa_requests.py::_sync_linked_child_requests` now seeds each module from its own list with
   the tuple's real `is_mandatory` value (previously always seeded `False` for both).

2. **Mandatory items now block Submit, not just Security Readiness.** New
   `routers/sast_dast.py::_require_checklist_ready(obj)`, called from both `_submit` and the
   `RETURNED_BY_SM` branch of `_resubmit` (shared helpers for both SAST and DAST), raises 400 if any
   mandatory checklist item still has `requester_checked == False`:

   ```python
   pending = [c.item for c in obj.checklist_items if c.is_mandatory and not c.requester_checked]
   if pending:
       raise HTTPException(400, "Cannot submit -- the following mandatory Security Readiness "
                                 "checklist item(s) must be self-declared ready first (Edit Details): "
                                 + ", ".join(pending))
   ```

   This is deliberately keyed on `requester_checked` (the requester's own self-declaration, set via
   `PUT /api/{sast,dast}-requests/{id}`'s `checked_items`), not `is_complete` (Security/QA's
   independent verification, which remains a separate gate at Security Readiness itself -- see
   `_readiness_decision`, section 39). Only the initial `Submit` and the `RETURNED_BY_SM` → re-submit
   path are gated -- resubmitting from `RETURNED_BY_DEPARTMENT_HEAD`/`RETURNED_BY_SECURITY_LEAD`
   doesn't re-check it, since those paths don't go back through SM Approval from scratch.

3. **Frontend (`SAST.tsx`/`DAST.tsx`).** The "Submit for SM Approval" button (and "Re-submit" while
   `RETURNED_BY_SM`) is now disabled while any mandatory checklist item's `requester_checked` is still
   false, with an inline message pointing at Edit Details -- mirrors the backend gate exactly so the
   400 is normally never actually hit in practice (surfaced via `ErrorText` if it somehow is, e.g. two
   browser tabs racing).

**Existing in-flight requests:** SAST/DAST requests already raised before this change keep whatever
`is_mandatory` values their checklist rows were seeded with (all `False`, from section 39) -- this only
changes seeding for *newly created* SAST/DAST requests going forward. Optional backfill for existing
rows, if the new mandatory flags should apply retroactively to requests not yet submitted:

```sql
UPDATE qap_sast_checklist_items SET is_mandatory = 1
  WHERE item = 'Application/source code repository access provided to the scan team';
UPDATE qap_dast_checklist_items SET is_mandatory = 1
  WHERE item IN (
    'Test environment / application URL accessible and stable',
    'Test accounts and role-based credentials provided',
    'Firewall / VPN / IP whitelisting completed for scan tool access'
  );
```

## 43. Functional Testing Request: readiness checklist self-declaration had no way back in after raise (no schema change)

Bug fix, no DDL. Every other module with a readiness checklist (Automation, Performance, and -- as of
section 42 -- SAST/DAST) already let the requester revisit their own checklist self-declaration
(`requester_checked`) from that module's own Edit Details modal after the request was raised, via a
`checked_items` field on the module's `*Update` schema. `FunctionalUpdate` never got this field when
the others did, and `FunctionalFormModal` (Functional's Edit Details modal) had no checklist section at
all -- so once a Functional Testing Request was raised, `requester_checked` was frozen at whatever the
QA Request wizard's checklist step captured at intake time, with no way to fix a mistake or tick an
item that became ready afterward.

Fixed to match the established pattern exactly:

- `schemas.FunctionalOut` gained `checklist_items: List[ChecklistItemOut] = []` (was previously the only
  one of the five `*Out` schemas without it -- reuses the existing `ChecklistItemOut`, same shape as
  Functional's own `ReadinessChecklistItem`, no new Pydantic model).
- `schemas.FunctionalUpdate` gained `checked_items: Optional[List[str]] = None`.
- `routers/functional.py::update_functional` now pops `checked_items` and, when provided, sets
  `requester_checked` on each of `obj.checklist_items` based on membership in that list -- identical to
  `update_automation`'s handling.
- `types.ts`'s `FunctionalOut` gained `checklist_items: ChecklistItemOut[]`.
- `Functional.tsx`'s `FunctionalFormModal` gained a "Readiness Checklist — Self-Declaration" section
  (mirrors `PerformanceFormModal`'s/`SASTFormModal`'s equivalent section) and now sends `checked_items`
  on save; `FunctionalDetail`'s `onSaved` handler also refreshes its own `checklist` tab state from
  `saved.checklist_items` immediately, rather than only picking it up on the next full reload.

No DDL changes -- `qap_readiness_checklist_items.requester_checked` already existed; this only adds a
way to write to it after intake.

## 44. Removed "SAST readiness"/"DAST readiness" from Functional's own checklist (no schema change)

**Why:** Functional's own "Ready for Testing" readiness checklist (`DEFAULT_CHECKLIST_ITEMS`) had two
items literally named "SAST readiness" and "DAST readiness", conditionally treated as mandatory (via
`CONDITIONAL_CHECKLIST_ITEMS`/`checklist_item_is_mandatory()`) whenever SAST/DAST were also selected on
the same QA Request (see section 35, which originally introduced these two conditional items). Now that
SAST and DAST each have their own dedicated Security Readiness checklist with their own mandatory items
(sections 39/42), these two items on Functional's checklist were redundant and misplaced -- per request,
that concern belongs entirely on the SAST/DAST modules, not embedded in Functional's checklist.

Bug fix/cleanup, no DDL:

- `constants.py`: `DEFAULT_CHECKLIST_ITEMS` had the `("SAST readiness", "User dept")` and
  `("DAST readiness", "User dept")` entries removed (10 items -> 8). `CONDITIONAL_CHECKLIST_ITEMS` (the
  dict that made those two items conditionally mandatory) and `checklist_item_is_mandatory(item,
  request_types)` (the function that consulted it) were both removed entirely, since nothing else used
  them.
- `routers/qa_requests.py`: the seeding loop for Functional's checklist rows now hardcodes
  `is_mandatory=False` for every item (matching every other non-SAST/DAST checklist's convention) instead
  of calling the now-removed `checklist_item_is_mandatory(item, request_types)`.
- `frontend/src/constants.ts`: same two items removed from `DEFAULT_CHECKLIST_ITEMS`; the
  `CONDITIONAL_CHECKLIST_ITEMS` export was removed entirely.
- `frontend/src/QARequests.tsx`: the wizard's `buildSteps` no longer shows the "Readiness Checklist" step
  for a SAST/DAST-only request (that step is now Functional-bucket-types-only, since SAST/DAST no longer
  feed into it at all); the `isItemRelevant(item, requestTypes)` helper (which used
  `CONDITIONAL_CHECKLIST_ITEMS` to decide whether to render "SAST readiness"/"DAST readiness" on the
  wizard's checklist step) was removed entirely, and the checklist render call simplified from
  `DEFAULT_CHECKLIST_ITEMS.filter((ci) => isItemRelevant(ci.item, form.request_types)).map(...)` to a
  plain `DEFAULT_CHECKLIST_ITEMS.map(...)`.

**Existing in-flight requests:** any Functional Testing Request already raised before this change keeps
whatever "SAST readiness"/"DAST readiness" checklist rows were already seeded onto it in
`qap_readiness_checklist_items` -- this only stops seeding those two items on *newly created* Functional
requests going forward. Optional retroactive cleanup, if the team wants those old rows removed from
already-raised requests too:

```sql
DELETE FROM qap_readiness_checklist_items WHERE item IN ('SAST readiness', 'DAST readiness');
```

No schema change at all -- `qap_readiness_checklist_items` is unchanged; this is a data-seeding/UI-only
fix, superseding the conditional-mandatory mechanism introduced in section 35.

## 45. QA Request wizard: SAST/DAST had no way to self-declare their own Security Readiness checklist at intake (no schema change), plus a dead prop cleanup

**Why:** section 39 gave SAST and DAST their own dedicated "Security Readiness" checklist
(`qap_sast_checklist_items`/`qap_dast_checklist_items`), and section 44 (above) confirmed that concern
no longer belongs on Functional's checklist at all. But unlike Functional/Automation/Performance --
which each get their own checklist self-declaration step right there on the QA Request wizard at intake
time -- SAST and DAST had no such step: `_sync_linked_child_requests` seeded every SAST/DAST checklist
row with no `requester_checked` value at all (always defaulting to unticked), and there was no code
path anywhere (schema field, staged JSON key, wizard UI) by which a self-declaration made at intake time
could ever reach those rows. Since `DEFAULT_SAST_CHECKLIST_ITEMS`/`DEFAULT_DAST_CHECKLIST_ITEMS` each
mark some items mandatory, and mandatory items block that child request's own Submit (section 42,
`_require_checklist_ready`), every SAST/DAST request created via the wizard required a mandatory extra
trip to that module's own Edit Details modal before it could even be submitted -- this is the "no option
for readiness checklist in SAST/DAST" bug reported.

**Fix -- SAST/DAST wizard steps now include their own Security Readiness Checklist section**, mirroring
Functional's/Automation's/Performance's pattern exactly:

- `frontend/src/constants.ts`: added `DEFAULT_SAST_CHECKLIST_ITEMS`/`DEFAULT_DAST_CHECKLIST_ITEMS`
  (a new `SecurityChecklistItemDef` interface, `{ item, owner, is_mandatory }`) -- these previously only
  existed on the backend (`app/constants.py`), with zero frontend references at all.
- `frontend/src/QARequests.tsx`: `EMPTY_FORM` gained `sast_checked_items`/`dast_checked_items` (both
  `string[]`), with `toggleSastChecked`/`toggleDastChecked` handlers; the SAST step and DAST step each
  gained a "Security Readiness Checklist — Self-Declaration" section (same checkbox-list UI as
  Functional's/Automation's checklist sections), rendering a red "Mandatory" badge next to items that
  block that child request's own Submit. Sent to the backend automatically via the existing `...rest`
  spread in the submit payload (same as `checked_items`/`automation_checked_items` already were).
- `schemas.QARequestCreate` gained `sast_checked_items: List[str] = []` / `dast_checked_items: List[str]
  = []`.
- `routers/qa_requests.py`: `_stash_draft_details`/`_unstash_draft_details` extended from a 7-tuple to a
  9-tuple (added `sast_checked_items`/`dast_checked_items`, both sets, appended at the end to avoid
  reordering every existing call site); `create_request`/`edit_request` now pop `sast_checked_items`/
  `dast_checked_items` explicitly *before* the generic `sast_`/`dast_` prefix sweeps that build
  `classification_details` (same reason `performance_checked_items` is popped before the `performance_`
  sweep -- otherwise these keys would get silently swept into the classification dict instead of kept as
  their own self-declaration sets); `_sync_linked_child_requests` gained `sast_checked_items`/
  `dast_checked_items` parameters, now passed through to `models.SASTChecklistItem`/
  `models.DASTChecklistItem` as `requester_checked=item in {sast,dast}_checked_set` (previously these
  constructor calls passed no `requester_checked` at all).
- `models.py`: `QARequest._draft_details()`'s empty-shell default dict gained `sast_checked_items`/
  `dast_checked_items: []`; two new read-only properties, `draft_sast_checked_items`/
  `draft_dast_checked_items`, mirror the existing `draft_automation_checked_items`/
  `draft_performance_checked_items` pattern so "Edit Request" can pre-fill a still-Draft gateway's
  SAST/DAST self-declaration ticks instead of showing them blank again.
- `schemas.QARequestOut` / `frontend/src/types.ts`'s `QARequestOut` both gained
  `draft_sast_checked_items`/`draft_dast_checked_items: string[]`.
- `QARequests.tsx`'s `NewRequestModal` editing-prefill block reads these two new fields the same way
  `automation_checked_items`/`performance_checked_items` already do:
  `sast_checked_items: editing.draft_sast_checked_items || []` (and the DAST equivalent).

**Bug fix along the way -- dead `checklist` prop.** `NewRequestModalProps.checklist?: ChecklistItemOut[]`
was declared and used in a fallback expression for Functional's `checked_items` pre-fill
(`(checklist || []).filter((c) => c.requester_checked).map((c) => c.item)`), but **neither of the two
call sites of `NewRequestModal` ever passed a `checklist` prop** -- so that fallback always evaluated to
an empty array, dead code from the start. Removed the prop entirely and simplified the `checked_items`
pre-fill to the same clean one-liner every other module's checklist already uses:
`checked_items: editing.draft_checked_items || []`. The now-unused `ChecklistItemOut` import was also
removed from `QARequests.tsx`.

**Cosmetic fix along the way -- asymmetric SAST/DAST mandatory-field labeling.** The SAST step's section
title and Priority/Risk Category fields were marked `"SAST Details *"` / `"Priority *"` / `"Risk Category
*"`, while DAST's equivalent fields had no asterisks at all, despite neither field actually being
browser-enforced as required either way. Both are now consistently `*`-marked (`"DAST Details *"` /
`"Priority *"` / `"Risk Category *"`), matching SAST.

**Existing in-flight requests:** any SAST/DAST request already raised before this change keeps whatever
`requester_checked` value its checklist rows already had (all `False`, since there was previously no code
path to set them at intake) -- this only affects *newly created* SAST/DAST requests going forward, and
Draft gateways not yet submitted (which can now be re-opened and have their SAST/DAST checklist steps
filled in before Submit). No schema change at all -- `qap_sast_checklist_items.requester_checked`/
`qap_dast_checklist_items.requester_checked` (section 39) and `qap_requests.draft_child_details`
(section 20) both already existed as columns; this only adds new JSON keys inside the latter's existing
CLOB payload and a new way to populate the former's existing column at seed time.

## 46. Frontend-only: QARequests.tsx split into a folder of small per-step files (no behavior change)

No backend/API/schema change at all -- purely a frontend code-organization change, done because the
single `frontend/src/QARequests.tsx` file had grown to ~1,360 lines (the wizard's nine steps, the list
page, the detail/edit modal and a handful of helpers all in one file) and was hard to read as a whole.
It's now `frontend/src/QARequests/` (a folder), with `App.tsx`'s existing `import QARequests from
'./QARequests'` resolving automatically to the folder's `index.tsx` -- no import-path changes needed
anywhere else in the app.

**Layout:**
- `index.tsx` -- the list page (default export), same as before.
- `NewRequestModal.tsx` -- the "Raise QA Request" / "Edit Request" wizard shell (step navigation,
  submit, the Draft edit-prefill logic) -- now only renders whichever step component matches the
  current step, instead of inlining all nine steps' JSX itself.
- `RequestDetail.tsx` -- the existing-request detail/view modal (Overview/Documents/History tabs).
- `AddDocuments.tsx` -- the small "add more documents" upload form used on the Documents tab.
- `GatewayPreview.tsx` -- the Draft/Submitted/Raised stepper shown at the top of both modals.
- `types.ts` -- the wizard's form-state shape (`QARequestForm`, `EMPTY_FORM`) and the small SAST/DAST
  component helpers, shared by every step.
- `buildSteps.ts` -- which wizard steps to show, based on selected request types.
- `validation.ts` -- the per-step "did you fill in the mandatory fields" checks.
- `format.ts` -- `userName`/`classificationSummary`, the two small display-formatting helpers used by
  both the list page and the detail modal.
- `steps/DetailsStep.tsx`, `TypeStep.tsx`, `FunctionalStep.tsx`, `SastStep.tsx`, `DastStep.tsx`,
  `PerformanceStep.tsx`, `AutomationStep.tsx`, `ChecklistStep.tsx`, `DocumentsStep.tsx` -- one file per
  wizard step, each just the JSX and small toggle handlers for that one page of the form.

Every step component takes the same two core props, `form` (the whole wizard's current values) and
`set` (updates one field of it), plus a couple of step-specific ones where needed (e.g. `existingSast`
on `SastStep`, so it can show "already raised, edit on its own page" instead of the input fields). The
six separate toggle-checkbox functions that used to all live on `NewRequestModal` itself
(`toggleChecked`, `toggleAutomationChecked`, `toggleSastChecked`, `toggleDastChecked`,
`togglePerformanceType`, `togglePerformanceChecked`) now each live inside the one step component that
actually uses them, since none of them need anything beyond that step's own slice of `form` plus `set`.

This is a pure reorganization -- every field name, validation rule, API payload shape, and rendered
label/copy is unchanged from before. Verified via `tsc --noEmit` (clean) after the split; no `py_compile`
changes needed since no backend file was touched.

## 47. Fixed: clicking outside the QA Request wizard discarded all typed data (no schema change)

**Why:** `Modal` (`components/Common.tsx`) closes on any click on its dimmed backdrop -- fine for
read-only detail drawers, but the QA Request "Raise"/"Edit" wizard can hold several steps' worth of
typed-but-not-yet-saved details, and an accidental click just outside the dialog silently unmounted the
whole form, losing everything. Reported directly: "someone after populated all the details, click
outside, then modal will close and all have to fill from start."

**Fix -- `Modal` gained an opt-in `preventBackdropClose` prop** (`components/Common.tsx`): when set, a
backdrop click no longer calls `onClose` at all -- only the header's "Close" button or whatever
Cancel/Save buttons the caller renders inside the panel can close it. Every other modal in the app
(SAST/DAST/Automation/Performance/Functional/Suppression/Sign-off/Admin/Approvals, the QA Request's own
"View Request" detail modal, etc.) is unaffected -- the prop defaults to off, so their existing
click-outside-to-close behavior is unchanged. Wired on only for `QARequests/NewRequestModal.tsx` (used
for both "Raise QA Request" and "Edit Request" -- the two places typed data was actually at risk).
"View Request" (`RequestDetail.tsx`) deliberately keeps click-outside-closes, since it's read-only and
has nothing to lose.

A blocked backdrop click now also gives a brief shake (`.modal-shake`, `index.css`) so it's clear the
click registered rather than the modal feeling unresponsive.

**Also polished while in there (still no schema/behavior change to the form's actual logic, fields, or
validation):**
- The wizard's Back/Next/Save/Cancel buttons (and any validation error) are now in a sticky footer
  (`.qa-wizard-footer`) that stays pinned to the bottom of the modal while scrolling a long step's
  content (e.g. DAST's target list plus its own checklist) -- previously reaching them, or seeing why a
  step wouldn't advance, required scrolling all the way down every time.

No schema change at all -- purely `components/Common.tsx` (the shared `Modal`), `index.css`, and
`QARequests/NewRequestModal.tsx`. Verified via `tsc --noEmit` (clean).

## 48. "View Request" now opens full screen (no schema change)

**Why:** requested directly -- the QA Request's "View Request" detail (Overview/Documents/History tabs,
several `DetailSection` blocks, linked-request badges, Gateway Actions) was a 860px side drawer
(`wide` on the existing `variant="drawer"`), which felt cramped for how much it actually shows.

**Fix -- `Modal` (`components/Common.tsx`) gained a third variant, `'fullscreen'`**, alongside the
existing `'drawer'`/`'dialog'`: the panel takes over the entire viewport instead of anchoring to a side
or centering as a box. Since the panel covers the whole screen there's no dimmed backdrop left to click
"outside" of, so the overlay has no `onClick` at all in this variant (only the header's own "Close"
button can close it) -- `preventBackdropClose` is simply irrelevant here rather than needing to be set.
Content inside is still capped at a comfortable ~980px reading width and centered (`.fullscreen-body >
*`), rather than stretching every field across an ultrawide monitor.

`QARequests/RequestDetail.tsx`'s `<Modal ... wide>` (drawer) became `<Modal ... variant="fullscreen">`.
No other modal in the app was changed -- every other `variant="drawer"`/`variant="dialog"` usage
(SAST/DAST/Automation/Performance/Functional/Suppression/Sign-off/Admin/Approvals, and the QA Request's
own "Raise"/"Edit" wizard) is untouched.

No schema change at all -- purely `components/Common.tsx`, `index.css`, and
`QARequests/RequestDetail.tsx`. Verified via `tsc --noEmit` (clean).

## 49. Reverted: "View Request" back to its 860px side drawer (section 48 undone)

Requested directly right after section 48 shipped -- reverted back to exactly how it was before. `Modal`
(`components/Common.tsx`) no longer has a `'fullscreen'` variant at all (removed the branch and its
`.modal-overlay-fullscreen`/`.fullscreen-panel`/`.fullscreen-body` CSS in `index.css`), and
`QARequests/RequestDetail.tsx`'s `<Modal ... variant="fullscreen">` is back to `<Modal ... wide>` (the
860px `variant="drawer"` side panel it always was). Confirmed no dangling references to `fullscreen`
remain anywhere in `frontend/src`. Every other change from sections 46-48 (the folder split, the
blocked-backdrop-close + shake on the wizard, and its sticky footer) is unaffected -- only the View
Request panel style itself reverted. No schema change at all. Verified via `tsc --noEmit` (clean).

## 50. First-ever LDAP login: pop-up to select department from the real department list

**Why:** requested directly. `routers/auth.py::login` already just-in-time (JIT) provisions a brand-new
local `User` row the first time an unrecognized username successfully binds against LDAP (no admin
pre-creation needed) -- but `department` on that new row is whatever the directory's own `department`
attribute happened to return, which is free text and often blank, or doesn't exactly match one of our
canonical `qap_departments.name` values (case/wording differences). Since department drives same-
department SM/Department Head approval checks throughout the app (`deps.require_same_department`), an
inaccurate or blank value silently breaks those checks for that person later. Per request, the person is
now prompted once, immediately after that very first LDAP login, to explicitly pick their real department
from the canonical list themselves.

**New column on `qap_users`:**

```sql
ALTER TABLE qap_users ADD (needs_department_selection NUMBER(1) DEFAULT 0);
```

Mirrors the existing `needs_role_review` column exactly (same additive, nullable-with-default shape) --
`Base.metadata.create_all(checkfirst=True)` won't add it to the already-existing `qap_users` table on its
own, so run the `ALTER TABLE` above by hand first, same caveat as every other section in this document.

**Backend (`models.py`, `schemas.py`, `routers/auth.py`):**
- `models.User.needs_department_selection` -- `Boolean, default=False`. Set `True` only at the moment a
  brand-new LDAP account is JIT-provisioned in `login()` (alongside the existing `needs_role_review=True`
  on that same `User(...)` construction) -- **not** set for Standard (non-LDAP) accounts, and not set
  again on that account's later logins (JIT provisioning only ever happens once, the first time).
- `schemas.UserOut` gained `needs_department_selection: bool = False`.
- New `PATCH /api/auth/me` (self-service, `get_current_user`-gated -- **not** admin-only, unlike every
  other user-mutation endpoint in this router): accepts `schemas.DepartmentSelection { department: str }`,
  requires a non-blank value, validates it against the same active-`Department`-row check
  (`_validate_department`) the Admin-only `PATCH /users/{id}` already used, then sets
  `current_user.department` and clears `needs_department_selection`. This is the **only** field a
  non-admin can ever set on their own profile -- everything else about a user (roles, login type,
  active/inactive) still requires an Admin, unchanged.

**Frontend (`types.ts`, `context/AuthContext.tsx`, `components/DepartmentPrompt.tsx`, `App.tsx`):**
- `UserOut` gained `needs_department_selection: boolean`.
- `AuthContext` gained `refreshUser()` (re-fetches `GET /api/auth/me` and updates `user` in place) so the
  popup can clear the flag in context immediately after saving, without a full page reload.
- New `components/DepartmentPrompt.tsx` -- a centered (`variant="dialog"`), `preventBackdropClose` modal
  (see section 47) showing a department picker (`SearchableSelect`, options from `GET /api/departments`)
  with a "Save & Continue" button (calls the new `PATCH /api/auth/me`, then `refreshUser()`) and a "Log
  out instead" escape hatch for someone who doesn't know their department right now or opened this by
  mistake -- the header's own "Close" button is wired to the same log-out action rather than a no-op,
  since there's no third "just dismiss without deciding" option here.
- `App.tsx`'s `Protected` wrapper renders `<DepartmentPrompt />` on top of whatever page the person lands
  on (not instead of it) whenever `user.needs_department_selection` is true -- so it appears right after
  login regardless of which route they're on, and persists across a page reload until resolved (since
  it's driven by the persisted column via `/api/auth/me`, not by anything only known at the moment of the
  `login()` call itself).

**Existing accounts:** every already-provisioned user (Standard or LDAP) defaults to
`needs_department_selection = False` and is completely unaffected -- this only ever fires for a brand-new
LDAP account provisioned from this point forward. Optional retroactive backfill, if the team also wants
this prompt to catch existing LDAP accounts that were auto-provisioned earlier and still have a blank
department (i.e. the directory never supplied one, and no admin has set it since):

```sql
UPDATE qap_users SET needs_department_selection = 1
  WHERE login_type = 'LDAP' AND (department IS NULL OR TRIM(department) = '');
```

## 51. Housekeeping: the copy-sync exclude list's bare `auth.py` was also matching `routers/auth.py`

Not an application change -- a correction to this project's own Documents-vs-scratch-copy sync process,
caught while applying section 50 above (which needed real changes to `routers/auth.py`, the actual
`/api/auth/...` endpoint file). The exclude list used when syncing the two copies has always included a
bare `auth.py`, intended to protect `backend/app/auth.py` (the real LDAP bind/connection module) from
being overwritten between environments. rsync only matches an exclude pattern by filename alone (not full
path) when the pattern contains no `/` -- so that one entry was *also* silently excluding
`backend/app/routers/auth.py`, an unrelated ordinary application file that happens to share the same
filename, every time the two copies were synced. In practice this meant any edit to `routers/auth.py`
was silently never propagated to the scratch copy in earlier rounds of this project (nothing in
`routers/auth.py` had been touched before section 50, so nothing was actually lost -- but the gap was
real and would have bitten the next change to that file). Fixed by anchoring the exclude to the full
relative path, `backend/app/auth.py`, instead of the bare filename, so only the intended LDAP module is
excluded and `routers/auth.py` syncs normally going forward. Re-verified via `diff -rq` with the corrected
exclude list (`DIFF_EXIT:0`) after manually copying the already-made `routers/auth.py` changes over once.

## 52. Explicit "Saved as Draft" / "Request Raised" pop-ups after a QA Request is saved (no schema change)

**Why:** requested directly. Creating (or editing) a QA Request never raises it by itself -- only a
separate "Submit / Raise" click on the request's own detail view does that (see section 20, `POST
/{id}/submit`) -- but there was no explicit confirmation of that either way: after saving, the person
just landed on the detail view with no particular emphasis on "this is still just a Draft, nothing has
happened yet" or, once actually raised, "go do something next." Per request, two new one-button "Got it"
pop-ups (new shared `components/InfoModal.tsx`, built on the existing `Modal`) now call this out
explicitly:

1. **"Saved as Draft"** -- shown right after saving a request (new or edited) whenever the response comes
   back still in `DRAFT` status (which is always true for a brand-new request, and still often true for
   an edit, since `GATEWAY_EDITABLE_STATUSES` is Draft-only anyway). Explains that nothing happens on any
   linked Functional/SAST/DAST/Automation/Performance request until "Submit / Raise" is clicked. Wired in
   `QARequests/index.tsx` (create flow) and `QARequests/RequestDetail.tsx` (edit flow) -- both check
   `result.status === 'DRAFT'` on the object the API just returned, rather than assuming based on
   new-vs-edit.
2. **"Request Raised"** -- shown right after "Submit / Raise" succeeds (`RequestDetail.tsx`'s `act('submit')`).
   Lists exactly which module page(s) to go to next -- one clickable link per request type that actually
   got linked (Functional QA Requests / SAST Requests / DAST Requests / Automation Testing Requests /
   Performance Testing Requests), via a new `format.ts::linkedSections(req)` helper that checks each
   `linked_*_requests` array and maps it to that module's list-page route (`/functional-requests`,
   `/sast`, `/dast`, `/automation`, `/performance`) -- rather than a generic "check your linked requests"
   message.

No schema change at all -- purely new/edited frontend files (`components/InfoModal.tsx`,
`QARequests/format.ts`, `QARequests/index.tsx`, `QARequests/RequestDetail.tsx`). Verified via `tsc
--noEmit` (clean).

## 53. Block raising a QA Request with an unchecked mandatory SAST/DAST checklist item; clearer DAST target-environment placeholder (no schema change)

**Issue 1 -- "Submit / Raise" let mandatory Security Readiness items slip through.** SAST/DAST's own
"Security Readiness" checklist has always had a hard gate at *their own* subsequent Submit (section 42 /
`routers/sast_dast.py::_require_checklist_ready`, called from `_submit`/`_resubmit`) -- but that only
fires once the linked SAST/DAST request already exists, i.e. *after* the gateway has already raised it.
The gateway's own `POST /{id}/submit` (`routers/qa_requests.py::submit_request`) had zero awareness of
the checklist at all, so a requester could tick nothing on the wizard's Security Readiness step, hit
"Submit / Raise," and get a brand-new SAST/DAST request born already eligible for its own Submit despite
mandatory items being unchecked. Fixed by adding the same check one level up:

- **Backend** (`routers/qa_requests.py::submit_request`): right after `_unstash_draft_details` (which
  recovers `sast_checked_items`/`dast_checked_items` from `draft_child_details`) and before
  `_sync_linked_child_requests`, a new block walks `DEFAULT_SAST_CHECKLIST_ITEMS`/
  `DEFAULT_DAST_CHECKLIST_ITEMS` (both already imported) for whichever of SAST/DAST are actually in
  `request_types`, collects any mandatory item not present in the corresponding checked-items set, and
  raises `400` naming every pending item if the list is non-empty -- otherwise behaves exactly as before.
  Scoped to SAST/DAST only, matching the pre-existing asymmetry: Functional/Automation/Performance have
  no submission-time mandatory-checklist gate by design (Automation's mandatory items gate at the later
  Feasibility Decision step instead). Saving as Draft (`create_request`/`edit_request`) is untouched --
  this only blocks the raise action.
- **Frontend** (`QARequests/RequestDetail.tsx`): mirrors the same check client-side so the requester sees
  what's missing before even clicking the button, rather than only from the error afterward. A new
  `pendingMandatory` list is computed from `req.draft_sast_checked_items`/`req.draft_dast_checked_items`
  against `DEFAULT_SAST_CHECKLIST_ITEMS`/`DEFAULT_DAST_CHECKLIST_ITEMS` (constants.ts), filtered by
  whether `req.request_types` actually includes `SAST`/`DAST`. When non-empty: the "Submit / Raise"
  button gets `disabled` (with a title tooltip) and a warning box lists every pending item by name, right
  above the Gateway Actions panel.

**Issue 2 -- DAST wizard's target-environment dropdown said "Same as above" instead of naming the
action.** `QARequests/steps/DastStep.tsx`'s per-target environment `<select>` really does fall back to
the gateway's own Deployment Environment when left blank (`environment=t.get("environment") or
qa_request.environment` in `_sync_linked_child_requests`) -- a genuine, intentional feature, unlike the
standalone `DAST.tsx` module's own Edit Details form (`routers/sast_dast.py::update_dast`), which has no
such fallback and does a straight replace. Rather than blindly copying `DAST.tsx`'s plain "Select
environment..." placeholder (which would silently misdescribe the wizard's real inherit-behavior), the
option label was changed to **"Select Environment (defaults to Deployment Environment)"** -- names the
action the user asked for while still telling them what leaving it blank actually does. No behavior
change -- blank still means "inherit," exactly as before.

No schema change, no migration needed -- backend logic-only change in `routers/qa_requests.py` plus
frontend-only changes in `QARequests/RequestDetail.tsx` and `QARequests/steps/DastStep.tsx`. Verified via
`py_compile` (clean) and `tsc --noEmit` (clean); both the Documents and outputs copies were re-synced and
confirmed identical via `diff -rq`.

## 54. Show request Created / Last Updated timestamps on every request type -- table and view (no schema change)

**Why:** requested directly -- every request (QA Request gateway, Functional, SAST, DAST, Automation,
Performance) needed its own creation and last-update time visible both in the list table and on the
detail/view page. `created_at`/`updated_at` columns (`Column(DateTime, default=now)` /
`Column(DateTime, default=now, onupdate=now)`) already exist on all six underlying models
(`QARequest`, `FunctionalRequest`, `SASTRequest`, `DASTRequest`, `AutomationRequest`,
`PerformanceRequest`) from earlier work -- this was purely a matter of exposing what the DB already
tracks, not adding new columns.

- **Backend (`schemas.py`):** `QARequestOut` and `FunctionalOut` already exposed both `created_at` and
  `updated_at`. `SASTOut`, `DASTOut`, `AutomationOut` and `PerformanceOut` only exposed `created_at` --
  added `updated_at: datetime.datetime` to each, right next to the existing `created_at` field. No
  router changes needed: every list/detail endpoint either returns the ORM object directly via
  `response_model` (FastAPI serializes whatever's on the schema) or, for DAST, goes through
  `_dast_out()`'s `schemas.DASTOut.model_validate(obj)` (routers/sast_dast.py), which picks up the new
  field automatically since it validates straight off the ORM row.
- **Frontend (`types.ts`):** added the matching `updated_at: string` to the `SASTOut`, `DASTOut`,
  `AutomationOut` and `PerformanceOut` interfaces (`QARequestOut`/`FunctionalOut` already had it).
- **List tables:** added a "Created" and "Updated" column (both `new Date(r.created_at /
  r.updated_at).toLocaleString()`) to the end of every request-type list table --
  `QARequests/index.tsx`, `modules/functional/Functional.tsx`, `modules/security/SAST.tsx`,
  `modules/security/DAST.tsx`, `modules/specialised-testing/Automation.tsx`,
  `modules/specialised-testing/Performance.tsx`.
- **Detail/view pages:** added "Created" and "Last Updated" `DetailField`s to the Overview tab's
  "Status" section (right after Priority/Risk/Request Type) on all six -- `QARequests/RequestDetail.tsx`
  plus the same five module files above -- so it's visible on the request's own status summary rather
  than in a separate section.

Note: prior to this, the only "created_at" visible anywhere in the UI was the *History* tab's own
`ApprovalActionOut.created_at` (labelled "When" -- when each approval-log entry happened), which is a
different thing entirely from the request's own creation time -- that tab is unchanged.

No schema/migration change (columns already existed on every model). Verified via `py_compile` (clean,
`schemas.py`/`models.py`/all touched routers) and `tsc --noEmit` (clean); Documents and outputs copies
re-synced and confirmed identical via `diff -rq`.

## 55. SAST/DAST History tab was missing the initial "Requester: Submitted" row that Functional QA has (no schema change)

**Why:** reported directly -- "history maintain in SAST,DAST is not same as Functional QA." Comparing the
two modules' own Submit handlers side by side: `routers/functional.py::submit_request` logs two rows on
Draft -> SM Approval Pending -- `_log(db, obj.id, "Requester", current_user, "Submitted", None)` followed
by `_log(db, obj.id, "SM Approval", current_user, "Pending", "Awaiting SM decision")`. SAST/DAST's shared
`routers/sast_dast.py::_submit` only ever logged the second one -- the requester's own "Submitted" step
was silently skipped, so a SAST/DAST request's History tab jumped straight from nothing to "SM Approval:
Pending" with no record of who actually submitted it or when, while every other request type (Functional,
Automation, Performance -- all of which mirror Functional's two-row pattern on their own Submit) showed
the full sequence.

**Fix:** `_submit` now sets `obj.status = "SUBMITTED"` and logs `_log(db, obj, "Requester", current_user,
"Submitted", None)` first, then proceeds exactly as before (`obj.status = "SM_APPROVAL_PENDING"` +
the existing SM Approval log) -- both status changes happen in memory before a single `commit()`, so the
transient `"SUBMITTED"` state is never actually queryable, only its History row is (same non-issue as
Functional's identical two-step pattern). `"SUBMITTED"` is already a real, labelled status in
`SAST_DAST_STATUSES`/`SAST_DAST_STATUS_LABELS` (constants.py), so no new status needed adding. Scoped to
`_submit` only -- `_resubmit`'s existing behavior (logging only the destination step, no separate
"Requester" row) already matched Functional's `resubmit_request` and was left untouched.

No schema change -- one added `_log` call plus the two-step status assignment in
`routers/sast_dast.py::_submit`. Verified via `py_compile` (clean); Documents and outputs copies
re-synced and confirmed identical via `diff -rq`.

## 56. Same missing "Requester: Submitted" history row, audited and fixed across Automation, Performance, and Suppression too (no schema change)

**Why:** follow-up to section 55 -- asked to check the same thing "everywhere." Audited every module's
own Submit handler against Functional's canonical two-row pattern:

- **`routers/automation.py::submit_automation`** -- same gap as SAST/DAST had: only logged `"SM
  Approval"` / `"Pending"`, no `"Requester"` / `"Submitted"` row first. Fixed the same way -- transient
  `obj.status = "SUBMITTED"` (a real, labelled value in `AUTOMATION_STATUSES`/`AUTOMATION_STATUS_LABELS`)
  plus the missing `_log` call, before proceeding to `SM_APPROVAL_PENDING` exactly as before.
- **`routers/performance.py::submit_performance`** -- identical gap, identical fix (`"SUBMITTED"` is
  likewise a real value in `PERFORMANCE_STATUSES`/`PERFORMANCE_STATUS_LABELS`).
- **`routers/suppression.py::submit_suppression`** -- same gap, but Suppression is slightly different:
  it already logs a `"Requester"` / `"Drafted"` row at *creation* time (`create_suppression`), which none
  of the other five request types do -- but it still had nothing logged for the requester's own
  *Submit* action, jumping straight to `"SM Approval"` / `"Submitted"` (note: Suppression's SM Approval
  step has always used the decision text `"Submitted"` rather than `"Pending"` -- left as-is, only the
  missing row was added). Fixed by adding the `"Requester"` / `"Submitted"` log call right before it.
  Unlike the other four, `SUPPRESSION_STATUSES` has no intermediate `"SUBMITTED"` value at all (goes
  `"Draft"` -> `"SM_APPROVAL_PENDING"` directly) -- so no transient status assignment was added here,
  only the extra history row.
- **`routers/signoff.py` (QA Sign-off)** -- checked and left untouched. Its workflow has no
  requester/SM/Department Head chain to begin with: a QA Sign-off Certificate is created directly by a
  QA Lead/Department Head (CoE) as `"Draft"` (`create_signoff`, no history logged, consistent with every
  other module's own creation step) and the only lifecycle event is the QA Lead's own `"CM-QA Sign-off"`
  / `"Approved"` entry logged in `issue_signoff` -- there's no separate "requester submits, then SM
  approves" step for this module to be missing in the first place, so its History tab was already
  complete and consistent with its own (simpler) workflow.

No schema change -- `_log` calls and matching transient status assignments only, in
`routers/automation.py`, `routers/performance.py`, and `routers/suppression.py`. Verified via
`py_compile` (clean, all four routers together); Documents and outputs copies re-synced and confirmed
identical via `diff -rq`.

## 57. Application Name Master: dropdown + "Other" with SM approval workflow (new table -- schema change)

**Why:** requested directly -- Application Name on the QA Request wizard was a free textbox, which let
duplicate/inconsistent entries pile up (case differences, typos, "SBI" vs "State Bank of India", etc.).
Replaced with a dropdown of standardised, previously-approved names, always paired with an "Other" option
for genuinely new applications -- a new name only becomes a selectable option for everyone once an SM
from the requester's own department approves it. Clarified via `AskUserQuestion` before building: (1)
raising the QA Request is **not** gated on the name being approved -- it proceeds normally in parallel;
(2) the SM decides **from the linked request's own SM Approval screen** (Functional/SAST/DAST/Automation/
Performance), not a separate pop-up or page; (3) same-department scoping as every other SM checkpoint.

**New table -- `models.ApplicationMaster`** (`qap_application_master`): `id`, `name` (unique, always
upper-cased at the point of entry), `status` (`PENDING`/`APPROVED`/`REJECTED`, see new
`constants.APPLICATION_MASTER_STATUSES`/`_LABELS`), `department` (who gets to decide), `requested_by_id`,
`qa_request_id` (which request first introduced it, nullable), `decided_by_id`, `decided_at`,
`comments`, `created_at`.

- **`models.QARequest`** gained `application_master_id` (FK, nullable) + `application_master` relationship
  + a read-only `application_master_status` property. Every one of the 5 linked child models
  (`FunctionalRequest`, `SASTRequest`, `DASTRequest`, `AutomationRequest`, `PerformanceRequest`) gained
  matching `application_master_status`/`application_master_id` properties that delegate through
  `self.qa_request` -- same pattern already used for `application_name`/`department`/etc.
- **`routers/qa_requests.py::_resolve_application_name`** (new helper, called from both `create_request`
  and `edit_request` right before/after the row is built): upper-cases the incoming name and resolves it
  against `ApplicationMaster` -- reuses an existing `APPROVED`/`PENDING` row for that exact name, flips a
  `REJECTED` row back to `PENDING` (treating a resubmission as a fresh proposal), or creates a brand-new
  `PENDING` row. Never blocks Draft save or Submit/Raise either way, per the first `AskUserQuestion`
  answer above.
- **New router `routers/applications.py`** (`/api/application-names`): `GET ""` returns `APPROVED` names
  only (feeds the wizard's dropdown, any authenticated user); `GET /pending` (SM/Admin) lists everything
  still awaiting a decision, department-filtered for an SM, full list for Admin -- mainly an Admin
  housekeeping view, not the SM's day-to-day path (see below); `POST /{id}/decision` (SM only,
  `require_same_department`) approves or rejects, independent of the linked request's own status. Wired
  into `main.py`.
- **`schemas.py`**: new `ApplicationMasterOut`/`ApplicationMasterDecision`; `application_master_id`/
  `application_master_status` added to `QARequestOut`, `FunctionalOut`, `SASTOut`, `DASTOut`,
  `AutomationOut`, `PerformanceOut`.
- **Frontend `QARequests/steps/DetailsStep.tsx`**: Application Name is now a `<select>` populated from
  `GET /api/application-names`, always ending in an "Other (new application)" option. Picking "Other"
  reveals a textbox that upper-cases every keystroke live; re-opening a Draft whose name isn't (yet, or
  no longer) in the approved list automatically falls back to showing that textbox pre-filled, instead of
  silently blanking a value the requester already typed.
- **New shared `components/ApplicationNameBanner.tsx`**: renders nothing unless
  `application_master_status === 'PENDING'` and the viewer has the SM role -- shown inline on the Overview
  tab of `Functional.tsx`, `SAST.tsx`, `DAST.tsx`, `Automation.tsx`, and `Performance.tsx` (gated by the
  same `sameDept || isAdmin` check each of those already computes for their own SM Approval buttons), with
  Approve Name/Reject Name buttons that call the new decision endpoint and refetch just that one request
  afterward. `QARequests/RequestDetail.tsx` also shows a read-only "Pending Approval"/"Rejected" badge
  next to Application Name in its own Overview (no action buttons there, per the design decision above).

**Oracle migration needed:** one new table, `qap_application_master`, plus one new nullable FK column on
the existing `qap_requests` table. `Base.metadata.create_all()` (called on every app startup, see
`main.py`) only creates tables that don't exist yet -- it never alters an existing table, so simply
restarting the app is **not** enough to pick up the new `qap_requests.application_master_id` column on an
already-deployed database. Without running the `ALTER TABLE` below by hand first, every read of an
existing QA Request (and anything that delegates through it -- Functional/SAST/DAST/Automation/
Performance's own `application_master_status`/`application_master_id`) fails with an Oracle
"invalid identifier" error the moment the ORM's generated `SELECT` lists a column that doesn't exist on
the real table yet, surfaced up through SQLAlchemy/Pydantic as a `get_attribute_error`. Run this against
the target schema before starting the app on this version (table first -- `qap_requests`' own new FK
points at it):

```sql
CREATE TABLE qap_application_master (
    id              NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name            VARCHAR2(150) NOT NULL,
    status          VARCHAR2(20) DEFAULT 'PENDING',
    department      VARCHAR2(150),
    requested_by_id NUMBER,
    qa_request_id   NUMBER,
    decided_by_id   NUMBER,
    decided_at      DATE,
    comments        CLOB,
    created_at      DATE DEFAULT SYSDATE,
    CONSTRAINT uq_qap_app_master_name UNIQUE (name),
    CONSTRAINT fk_qap_app_master_requested_by FOREIGN KEY (requested_by_id) REFERENCES qap_users(id),
    CONSTRAINT fk_qap_app_master_qa_request FOREIGN KEY (qa_request_id) REFERENCES qap_requests(id),
    CONSTRAINT fk_qap_app_master_decided_by FOREIGN KEY (decided_by_id) REFERENCES qap_users(id)
);
CREATE INDEX ix_qap_app_master_status ON qap_application_master(status);

ALTER TABLE qap_requests ADD (application_master_id NUMBER);
ALTER TABLE qap_requests ADD CONSTRAINT fk_qap_requests_app_master_id
    FOREIGN KEY (application_master_id) REFERENCES qap_application_master(id);
```

No existing columns changed or dropped -- purely additive.

Verified via `py_compile` (`models.py`, `schemas.py`, `constants.py`, `routers/qa_requests.py`,
`routers/applications.py`, `main.py` -- all clean) and `tsc --noEmit` (clean); Documents and outputs
copies re-synced and confirmed identical via `diff -rq`. The DDL above was not (and cannot be) run from
this environment -- no direct network access to the target Oracle instance -- so it must be applied to
the actual database by whoever administers it before this version is deployed/restarted there.

## 58. Bug fix: `create_request` INSERT failing with `ORA-01400: cannot insert NULL into APPLICATION_NAME`

**Why:** a code bug introduced alongside section 57's Application Name Master feature, not a schema
issue -- no DDL involved. `create_request` had been rewritten to pop `application_name` out of the
incoming payload entirely and only assign `obj.application_name` *after* calling `db.flush()`, so it
could pass the already-flushed row's own `id` into `_resolve_application_name(..., qa_request_id=obj.id)`.
That ordering is wrong: `db.flush()` issues the real `INSERT` immediately, using whatever the object's
attributes are set to *at that moment* -- it does not wait for attribute assignments made afterward.
Since `application_name` is `NOT NULL` on `qap_requests`, every single QA Request creation attempt hit
`ORA-01400`.

**Fix (`routers/qa_requests.py::create_request`):** the incoming name is now upper-cased immediately
after being popped off the payload and passed straight into the `models.QARequest(...)` constructor call
(`application_name=name_upper`), guaranteeing the `NOT NULL` column always has a valid value before any
flush/insert occurs. Only `application_master_id` (nullable, no constraint risk, and genuinely needs the
row's own freshly-generated `id`) is still resolved and assigned after `db.flush()`, unchanged from
before. `edit_request` was already unaffected by this bug -- it `UPDATE`s an existing row where
`application_name` already holds a valid prior value throughout, so there was never a NULL-at-flush risk
there.

**No schema change** -- this is a pure application-code fix. Verified via `py_compile` (clean); Documents
and outputs copies re-synced and confirmed identical via `diff -rq`.

## 59. Bug fix: rejecting an Application Name didn't stop the SM approving the request itself

**Why:** reported directly -- an SM could reject a request's new Application Name via the inline banner
(section 57) and then still separately click Approve on that same request's own SM Approval decision,
sending it on to Department Head under a name that had just been rejected. The two decisions were wired
as fully independent, which was correct for an *Approved* name but wrong for a *Rejected* one -- a
request can't legitimately proceed under an application name the SM just refused.

**Fix (`routers/applications.py::decide_application_name`):** when the decision is `Rejected`, a new
helper, `_auto_reject_linked_requests`, now also force-rejects every linked child request (Functional/
SAST/DAST/Automation/Performance -- via `qa_request.linked_functional_requests`/etc.) that is still
sitting at its own `SM_APPROVAL_PENDING` checkpoint: its `status` is set to `SM_REJECTED` and an
`ApprovalAction` row is logged under that module's own `entity_type` (`FUNCTIONAL_REQUEST`/`SAST`/`DAST`/
`AUTOMATION`/`PERFORMANCE`), step `"SM Approval"`, decision `"Rejected"`, with a comment noting the
application name rejection as the reason. A request that already moved past SM Approval, or hasn't
reached it yet, is left untouched -- this only closes the specific window where both decisions were
sitting open on the same screen at once. Approving the name is unchanged -- it still never touches the
request's own status.

Frontend needed no change beyond an updated comment (`components/ApplicationNameBanner.tsx`) -- each
module's `reloadAfterApplicationNameDecision` already refetches the full request after any name
decision, so the now-`SM_REJECTED` status and its badge appear immediately, and the SM Approve/Reject
panel (gated client-side on `status === 'SM_APPROVAL_PENDING'`) disappears on its own.

**No schema change.** Verified via `py_compile` (`routers/applications.py`, `models.py`) and
`tsc --noEmit` (both clean); Documents and outputs copies re-synced and confirmed identical via
`diff -rq`.

## 60. Bug fix: SAST/DAST/Automation/Performance still reachable for SM Approval after their shared Application Name was rejected

**Why:** reported directly, as a follow-up to section 59. Section 59 only force-rejects a linked
request at the *moment* its Application Name is rejected -- but a QA Request's linked child requests
(Functional/SAST/DAST/Automation/Performance) do not all reach `SM_APPROVAL_PENDING` together. Each one
has its own, separate "Submit" action the requester clicks on that module's own page (see
`routers/qa_requests.py::submit_request` -- raising the gateway only creates the child requests in
`DRAFT`; nothing moves to `SM_APPROVAL_PENDING` until its own module's Submit is called). So the
reported sequence was: requester raises one QA Request covering Functional + SAST + DAST + Automation +
Performance; only Functional had been individually submitted so far; the SM rejected Functional's
Application Name (correctly force-rejecting Functional per section 59, since it alone was
`SM_APPROVAL_PENDING` at that moment); the requester *then* submitted SAST/DAST/Automation/Performance
-- and each landed at a fresh, untouched `SM_APPROVAL_PENDING`, fully approvable, despite sharing the
exact same (already-rejected) Application Name.

**Fix:** each module's own `submit`/`_submit` and `resubmit`/`_resubmit` (`RETURNED_BY_SM` branch)
handler now checks `obj.application_master_status` right where it would otherwise set
`SM_APPROVAL_PENDING`; if it reads `"REJECTED"`, the request lands directly at `SM_REJECTED` instead,
with an `ApprovalAction` logged the same way section 59's auto-reject does. Touched:
`routers/functional.py` (`submit_request`, `resubmit_request`), `routers/sast_dast.py` (shared `_submit`/
`_resubmit`, used by both SAST and DAST), `routers/automation.py` (`submit_automation`,
`resubmit_automation`), `routers/performance.py` (`submit_performance`, `resubmit_performance`).
Suppression has no Application Name Master delegation (see section 57) and is unaffected.

**Also hardened (`routers/applications.py::decide_application_name`):** the section 59 auto-reject
previously only walked the one `qa_request` recorded on `ApplicationMaster.qa_request_id` -- whichever
gateway happened to introduce the name first. If a requester separately raises more than one QA Request
that both resolve to the same "Other" name (reusing an existing PENDING/APPROVED `ApplicationMaster` row
by name, see `_resolve_application_name`), only the first gateway's linked requests were being
force-rejected. Rejecting a name now instead queries every `QARequest` row with that
`application_master_id` and force-rejects each one's linked requests, not just the originating gateway's.

**No schema change.** Verified via `py_compile` (`routers/functional.py`, `routers/sast_dast.py`,
`routers/automation.py`, `routers/performance.py`, `routers/applications.py` -- all clean); Documents and
outputs copies re-synced and confirmed identical via `diff -rq`.

## 61. Bug fix: SM/Department Head could edit a request while it was still in Draft

**Why:** reported directly for SAST/DAST, but the same gap existed on all four editable request types.
`update_sast`/`update_dast`/`update_functional`/`update_automation`/`update_performance` all let an SM or
Department Head of the requester's own department edit a request any time its status was in that
module's own `*_EDITABLE_STATUSES` list -- and that list is `["DRAFT", "RETURNED_BY_SM",
"RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_..."]` for every one of them. The `RETURNED_BY_*` statuses
are genuinely SM/Department Head's own recourse (they reviewed the request, returned it, and may want to
fix a minor detail themselves rather than bounce it back and forth) -- but `DRAFT` is different: the
requester hasn't even submitted it yet, so it has never reached an SM/Department Head checkpoint at all,
and neither role has any business editing it before that point.

**Fix:** each of the five `update_*` endpoints now raises a 403 for a non-requester, non-admin SM/
Department Head as soon as `obj.status` (or `obj.status == QAStatus.DRAFT` for Functional) is `DRAFT`,
before falling through to the existing SM/Department Head/same-department check that still applies to
every other editable status. Touched: `routers/functional.py::update_functional`,
`routers/sast_dast.py::update_sast`/`update_dast`, `routers/automation.py::update_automation`,
`routers/performance.py::update_performance`. Frontend `canEditDetails` in `Functional.tsx`/`SAST.tsx`/
`DAST.tsx`/`Automation.tsx`/`Performance.tsx` now adds the same `status !== 'DRAFT'` condition to the
SM/Department Head branch, so the Edit Details button doesn't even appear for them on a still-Draft
request instead of appearing and then 403ing on click.

**No schema change.** Verified via `py_compile` (all 4 touched router files) and `tsc --noEmit` (both
clean); Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 62. Application Name pending/rejected now blocks Sign/Approve on SM and Department Head decision panels

**Why:** requested directly, tightening the earlier "Proceed normally" gating decision from section 57
(raising a request was never blocked on its Application Name being decided). The request/reject-flow
fixes in sections 59-60 stop a request from sliding through to Department Head *after* its name is
rejected, but they didn't stop an SM (or Department Head) from actively Signing and Approving a request
*while* its Application Name still sat at PENDING (simply not yet decided either way). Per this request,
Sign and Approve should both stay disabled the whole time the name isn't APPROVED -- Return and Reject
stay available either way, so an approver isn't stuck completely unable to act.

**Frontend (`components/Common.tsx`):** `SignField` gained a `disabled` prop; `ApprovalDecisionButtons`
(the shared Sign/Approve/Return/Reject button group used by every SM/Department Head decision panel --
Functional, SAST, DAST, Automation, Performance, Suppression) gained `signBlocked`/`signBlockedMessage`
props -- when `signBlocked` is set, both the Sign button and the Approve button are disabled (Return/
Reject are unaffected), and `signBlockedMessage` renders next to them explaining why.
`Functional.tsx`/`SAST.tsx`/`DAST.tsx`/`Automation.tsx`/`Performance.tsx` each compute
`applicationNameBlocking = !!req.application_master_status && req.application_master_status !== 'APPROVED'`
and pass it as `signBlocked` on both their SM Approval and Department Head Approval panels (a `null`
`application_master_status` -- no `ApplicationMaster` row at all, e.g. an older pre-rollout request --
does not block). Suppression has no Application Name Master delegation (section 57) and is unaffected.

**Backend (defense in depth, not just a UI affordance):** `sm_decision`/`_sm_decision` and
`department_head_decision`/`_department_head_decision` in `routers/functional.py`, `routers/sast_dast.py`
(shared, used by both SAST and DAST), `routers/automation.py`, and `routers/performance.py` now reject an
`"Approved"` decision with a 400 if `obj.application_master_status` is set and isn't `"APPROVED"` --
`"Returned"`/`"Rejected"` are unaffected. This closes the same window server-side (e.g. a stale page, or
a direct API call) rather than relying on the frontend disabling the button.

**No schema change.** Verified via `py_compile` (`routers/functional.py`, `routers/sast_dast.py`,
`routers/automation.py`, `routers/performance.py`) and `tsc --noEmit` (both clean); Documents and outputs
copies re-synced and confirmed identical via `diff -rq`.

## 63. SAST wizard step gains an optional SHA256/MD5 Hash field; QA Request wizard opens semi-full screen

**Why (two unrelated fixes reported together):**

1. `SASTRequest.hash_value` was mandatory (marked `*`) on the SAST request's own "Edit Details" modal,
   but the QA Request wizard's SAST step never collected it at intake -- so every SAST request born from
   the wizard landed with a blank, technically-invalid-looking mandatory field the requester had to go
   fill in immediately afterward on a separate page, for no reason (the value has no bearing on the
   Repository Details it sits next to, it's just a hash of the build/artifact, often not known yet at
   raise time). Fixed by (a) collecting it as an optional field on the wizard's SAST step, right after
   Repository Details, and (b) dropping the mandatory requirement from the SAST request's own Edit
   Details modal to match -- it was never something intake actually captured, so treating it as
   mandatory there was never justified in the first place.
2. The QA Request wizard's modal (`variant="dialog" wide`) was capped at a fixed 960px / min(88vh, 900px)
   -- cramped for a multi-step form with repeatable repository/target rows and checklists. Opens
   noticeably larger now ("semi-full screen": most of the viewport, not literally edge-to-edge).

**Backend:**
- `schemas.QARequestCreate.sast_hash_value: Optional[str] = None` (new field, same "collected on this
  step only while SAST is ticked, not a QARequest column" pattern as `sast_priority`/`sast_risk_category`
  right above it). No separate popping needed in `routers/qa_requests.py` -- it's swept into
  `classification_details` automatically by the existing generic `k.startswith("sast_")` sweep in both
  `create_request` and `edit_request`, same mechanism `sast_priority`/`sast_risk_category` already relied
  on.
- `routers/qa_requests.py::_sync_linked_child_requests`'s SAST creation block now reads
  `hash_value=classification.get("sast_hash_value")` into the new `SASTRequest`, alongside the existing
  `priority`/`risk_category` reads. `SASTRequest.hash_value` itself is an existing, already-nullable
  column (section 7) -- no DDL needed.

**Frontend:**
- `QARequests/types.ts`: `EMPTY_FORM.sast_hash_value: ''`.
- `QARequests/steps/SastStep.tsx`: new (non-mandatory) `Field` for "SHA256/MD5 Hash" placed directly
  under the Repository Details `RepeatableGroupInput` -- a single value for the whole SAST request, not
  per-repository-row (matching the existing single-value column, unlike `SAST_COMPONENT_FIELDS`, which
  really is per-repository).
- `QARequests/NewRequestModal.tsx::buildInitialForm`: pre-fills from `editing.draft_classification?.sast_hash_value`
  when re-opening a still-Draft request's Edit Request (no live-linked-request fallback here, unlike
  `sast_priority`/`sast_risk_category` -- `LinkedRequestRef`, the minimal cross-reference schema shared by
  all 5 linked-request types, deliberately doesn't carry `hash_value`, and this field is only ever
  rendered while the SAST step is still editable in the first place, i.e. before a real SAST request
  exists).
- `modules/security/SAST.tsx`: dropped the `missing.push('SHA256/MD5 Hash')` mandatory check from
  `formError()`, and the field's label/`required` attribute in the "Edit Details" modal ("SHA256/MD5
  Hash *" -> "SHA256/MD5 Hash", `input required` -> `input`). Backend `schemas.SASTUpdate.hash_value` was
  already `Optional[str] = None` -- this was a frontend-only mandatory check, nothing to loosen server-side.
- `index.css`: `.dialog-wide` (only ever used by the QA Request wizard, confirmed -- no other modal passes
  `wide`) changed from a fixed `width: 960px` (inheriting `.dialog`'s `max-height: min(88vh, 900px)`) to
  `width: 92vw; max-width: 1440px; height: 90vh; max-height: 90vh`.

**No schema change** (`SASTRequest.hash_value` already existed, already nullable). Verified via
`py_compile` (`schemas.py`, `routers/qa_requests.py`) and `tsc --noEmit` (clean); Documents and outputs
copies re-synced and confirmed identical via `diff -rq`.

## 64. QA Sign-off Certificate: Tester -> SM -> Department Head COE approval chain replaces the old QA-Lead-only Draft/Issued flow

**Why:** the certificate previously had almost no workflow of its own -- any QA Lead or Department Head
COE could raise one and, while it sat at `Draft`, the same QA Lead role could immediately "Sign & Issue"
it single-handedly. Per request, a certificate is now raised by the Tester (or QA Lead), reviewed by the
SM (who can also modify its details while reviewing), and only becomes final once the Department Head COE
approves it -- the same three-stage shape every other module in this app already uses (Requester -> SM ->
Department Head), just with `DEPARTMENT_HEAD_COE` standing in for the business-side Department Head and
its own Approve action being the terminal "Issued" step. The certificate/report itself must now show three
mandatory names: Requested By (Tester), Reviewed By (SM), Approved By (Department Head COE).

**Who can do what (confirmed with the requester before implementing):**
- **Create:** Tester (`QA_ENGINEER`) or `QA_LEAD` -- `DEPARTMENT_HEAD_COE` no longer creates, since their
  role is now the final approval step rather than authorship. The Testing Request ID search/auto-populate/
  field-locking behavior on the "New Sign-off Certificate" form (section 37) is unchanged.
- **Edit details while in flight:** the Tester (the actual requester, or an Admin) while the certificate is
  `DRAFT`/`RETURNED_BY_SM`/`RETURNED_BY_DEPT_HEAD_COE`, **or** the SM directly while it's sitting at their
  own `SM_APPROVAL_PENDING` review (the "he will have option to modify details" requirement) -- enforced in
  `routers/signoff.py::update_signoff` and mirrored by `SignOff.tsx`'s `canEditDetails`.
- **Functional Testing Request's own "Request/Confirm Sign-off" buttons are unchanged** (still QA-Lead-only,
  per explicit confirmation) -- only the certificate's own internal workflow changed; `functional.py` and
  `Functional.tsx` were not touched.

**New status set** (`constants.SIGNOFF_STATUSES`, replacing the old `Draft`/`Issued`-only pair):
`DRAFT -> SUBMITTED -> SM_APPROVAL_PENDING -> (RETURNED_BY_SM | SM_REJECTED | DEPT_HEAD_COE_APPROVAL_PENDING)
-> (RETURNED_BY_DEPT_HEAD_COE | DEPT_HEAD_COE_REJECTED | ISSUED)`. `RETURNED_BY_SM` and
`RETURNED_BY_DEPT_HEAD_COE` both route back to the Tester for a fix-and-resubmit, landing back at
`SM_APPROVAL_PENDING`/`DEPT_HEAD_COE_APPROVAL_PENDING` respectively (not all the way back to the start).
Named `DEPT_HEAD_COE_APPROVAL_PENDING` (30 chars), not the more literal `DEPARTMENT_HEAD_COE_APPROVAL_PENDING`
(36 chars), to fit the existing `qap_signoffs.status VARCHAR2(32)` column without a width change.

**New columns on `qap_signoffs`:**

```sql
ALTER TABLE qap_signoffs ADD (
    requester_id    NUMBER,
    reviewed_by_id  NUMBER,
    approved_by_id  NUMBER
);

ALTER TABLE qap_signoffs ADD CONSTRAINT fk_qap_signoff_requester
    FOREIGN KEY (requester_id) REFERENCES qap_users(id);
ALTER TABLE qap_signoffs ADD CONSTRAINT fk_qap_signoff_reviewer
    FOREIGN KEY (reviewed_by_id) REFERENCES qap_users(id);
ALTER TABLE qap_signoffs ADD CONSTRAINT fk_qap_signoff_approver
    FOREIGN KEY (approved_by_id) REFERENCES qap_users(id);
```

`issued_by_id`/`signed_by_id` (the old requester/signer columns) are left physically in place, unused --
same "don't drop columns" convention as every other superseded column in this document -- the application
no longer reads or writes them going forward.

**Data migration (old literal `"Draft"`/`"Issued"` status strings -> new uppercase values):** the old code
wrote `status = "Draft"` / `"Issued"` (mixed case, no full workflow in between); the new code only ever
produces the uppercase `DRAFT`/`ISSUED`/etc. values above. Run once, before deploying the new backend code:

```sql
UPDATE qap_signoffs SET status = 'DRAFT'  WHERE status = 'Draft';
UPDATE qap_signoffs SET status = 'ISSUED' WHERE status = 'Issued';

-- Any already-Issued certificate has no requester_id/reviewed_by_id/approved_by_id to backfill
-- automatically (the old flow never distinguished these three roles) -- optionally backfill
-- approved_by_id from the old signed_by_id, and requester_id from the old issued_by_id, as a
-- reasonable best-effort mapping for historical certificates only:
UPDATE qap_signoffs SET approved_by_id = signed_by_id WHERE status = 'ISSUED' AND approved_by_id IS NULL;
UPDATE qap_signoffs SET requester_id = issued_by_id WHERE requester_id IS NULL;
```

No frontend label is registered for the old lowercase `Draft`/`Issued` values (`SIGNOFF_STATUS_LABELS`
only defines the new uppercase keys) specifically to avoid colliding with `SUPPRESSION_STATUS_LABELS`'
own `Draft: 'Draft'` entry in the shared `ALL_STATUS_LABELS` merge (`components/Common.tsx`) -- run the
`UPDATE`s above before deploying so no certificate is ever left showing an unrecognized/unstyled badge.

**Removed endpoint:** `POST /api/signoffs/{id}/issue` no longer exists -- replaced by
`POST /api/signoffs/{id}/department-head-coe-decision` with `{decision: "Approved", ...}`, which sets
`approved_by_id` and moves the certificate straight to `ISSUED` (the terminal state, same as before, just
reached via the same decision-panel shape every other module's Department Head step already uses instead
of a bespoke single button).

**New endpoints (`routers/signoff.py`):** `PUT /{id}` (`update_signoff`, edit while in an editable state --
see permissions above), `POST /{id}/submit`, `POST /{id}/resubmit`, `POST /{id}/sm-decision`,
`POST /{id}/department-head-coe-decision`. `list_signoffs`/`get_signoff`/`signoff_history`/the documents
endpoints are unchanged; `export_signoff`'s PDF now has a "Requested / Reviewed / Approved" section reading
`requester_id`/`reviewed_by_id`/`approved_by_id` instead of the old `issued_by_id`/`signed_by_id` pair.

**Schema (`schemas.py`):** new `SignOffUpdate` (all-optional edit payload). `SignOffOut` gains
`vendor_si_partner`, `technology_stack`, `validity_from`, `validity_to`, `exit_criteria_notes`,
`open_defect_summary`, `residual_risk_notes` -- a pre-existing gap where `SignOffCreate` collected these
but `SignOffOut` never returned them, meaning the frontend could never display or pre-fill them for editing
until now -- plus the new `requester_id`/`reviewed_by_id`/`approved_by_id` and `updated_at`.

**Frontend:** `constants.ts` gains `SIGNOFF_STATUS_LABELS`/`SIGNOFF_EDITABLE_STATUSES`/
`SIGNOFF_TERMINAL_STATUSES` (mirrored from `constants.py`), merged into `Common.tsx`'s `ALL_STATUS_LABELS`.
`SignOff.tsx`: `canCreate` changed from `hasRole(user, 'QA_LEAD', 'DEPARTMENT_HEAD_COE')` to
`hasRole(user, 'QA_ENGINEER', 'QA_LEAD')`; the detail view (`SignOffDetail`) gained Requested By/Reviewed
By/Approved By fields, Submit/Re-submit buttons, an `EditSignOffModal` (reusing the same field set as
creation, minus the locked Testing Request ID/Application Name/Owner/Department), `ApprovalDecisionButtons`-
based SM and Department Head COE decision panels (each gated the same same-department + role + status way
every other module's decision panel already is), and a History tab reading `GET /{id}/history`; the list
table's columns changed from Requester/Assigned To (`issued_by_id`/`signed_by_id`) to Requested By/Reviewed
By/Approved By.

**Verification:** `py_compile` (`routers/signoff.py`, `models.py`, `schemas.py`, `constants.py`) and
`tsc --noEmit -p .` both clean; Documents and outputs copies re-synced and confirmed identical via
`diff -rq`.

## 65. "Project Name" renamed to "Epic Number" everywhere -- column, field, and label rename across 4 tables

**Why:** per request, every occurrence of "Project Name" -- the free-text column originally meant to hold a
project name -- is renamed to "Epic Number" throughout the codebase: the underlying database column, every
Python/TypeScript field name, and every on-screen label. This was a straight rename, not a behavior change --
the column stays the same type/size/nullability, just under a new name, and the same single value (typed
once on the QA Request wizard's "Application & Change Details" step, already labelled "Epic Number" there
before this change) still flows through to every child request the same way it always did.

**Column rename on 4 tables** (`project_name` -> `epic_number`, same `VARCHAR2(150)`, nullable, no data loss --
values carry over automatically with a rename, unlike an add/drop):

```sql
ALTER TABLE qap_requests             RENAME COLUMN project_name TO epic_number;
ALTER TABLE qap_sast_requests        RENAME COLUMN project_name TO epic_number;
ALTER TABLE qap_automation_requests  RENAME COLUMN project_name TO epic_number;
ALTER TABLE qap_performance_requests RENAME COLUMN project_name TO epic_number;
```

`qap_functional_requests` and `qap_dast_requests` have no column of their own to rename -- both only ever
read this value via a read-only Python `@property` delegating to their linked `qap_requests` row (see
`models.FunctionalRequest.project_name`/`models.DASTRequest.project_name`, both renamed to `epic_number` in
lockstep with the property they delegate through). `qap_signoffs` was never in scope -- it has no Project
Name/Epic Number field at all.

**Backend (`models.py`):** the `project_name = Column(String(150))` declaration on `QARequest`,
`SASTRequest`, `AutomationRequest`, `PerformanceRequest` is renamed to `epic_number`; the delegated
`@property def project_name` on `FunctionalRequest` and `DASTRequest` is renamed to `epic_number` (still
returning `self.qa_request.epic_number`).

**Backend (`schemas.py`):** every `project_name: Optional[str] = None` field (across `QARequestCreate`,
`QARequestUpdate`, `QARequestOut`, `SASTOut`, `SASTUpdate`, `AutomationOut`, `AutomationUpdate`,
`PerformanceOut`, `PerformanceUpdate`, `FunctionalOut`, `DASTOut`, etc.) renamed to `epic_number`. Frontend
request/response payloads now use `epic_number` as the JSON key in place of `project_name`.

**Backend (routers):** `qa_requests.py::_sync_linked_child_requests` now seeds each new child request's
`epic_number` from `qa_request.epic_number` (was `project_name` from `project_name`); the topbar/list search
filter (`list_requests`) now matches against `QARequest.epic_number`; every module's PDF export
(`qa_requests.py`, `functional.py`, `sast_dast.py` x2, `automation.py`, `performance.py`) relabels its
"Project"/"Project Name" row to **"Epic Number"**; `reports.py`'s Excel/CSV export column header changes
from `"Project Name"` to `"Epic Number"`; `_ADMIN_ONLY_FIELDS` sets (`functional.py`, `sast_dast.py`,
`automation.py`, `performance.py`) now list `"epic_number"` instead of `"project_name"` -- behavior
unchanged, Epic Number remains Admin-only to edit once a request has been raised, same as Application Name
and CR Number. `dashboard.py`'s 3W ("What/Where/Since When") pending-items endpoint has its
`r.project_name`/`s.application_name` attribute access updated to `r.epic_number` to match (the dashboard's
own generic `project_id`/`project_name`/`active_projects`/"Project-wise Dashboard" terminology is a
**separate, pre-existing concept** -- those keys represent "this row is a piece of work," mapped from each
request's own `request_id`, and were deliberately left untouched since they don't represent the Epic Number
field itself and renaming them would be a disconnected, unrelated change).

**Frontend:** `types.ts` (7 interfaces), `QARequests/types.ts` (`EMPTY_FORM`), `QARequests/NewRequestModal.tsx`,
`QARequests/steps/DetailsStep.tsx`, `QARequests/validation.ts`, `QARequests/index.tsx`,
`QARequests/RequestDetail.tsx`, and each module's own page (`Functional.tsx`, `SAST.tsx`, `DAST.tsx`,
`Automation.tsx`, `Performance.tsx`) all rename the `project_name` field to `epic_number` and relabel every
"Project Name"/"Project" UI text (Edit Details field labels, Overview `DetailField` labels, list table column
headers, the SAST Edit Details modal's required-field validation message) to **"Epic Number"**. The QA
Request wizard's own field already said "EPIC Number" pre-change (inconsistent casing); normalized to "Epic
Number" to match everywhere else.

**Out of scope, deliberately unchanged:** `Dashboard.tsx`'s "Project Visibility & Governance" tab, `Projects`
sub-tab, `ProjectWiseMetrics`/`ProjectWiseOut` types, `/api/dashboard/project-wise` endpoint, and the
`project_id`/"Project"/"Project / Request ID" column headers on its tables. These all refer to "a request,
generically treated as a unit of work" (their `project_id` value is actually each request's own
`request_id`) -- a distinct, older piece of dashboard terminology that predates and is unrelated to the
Epic Number field, so renaming it was out of scope for this request.

**Verification:** `py_compile` across `models.py`, `schemas.py`, and every touched router; `tsc --noEmit -p .`
clean; repo-wide grep for `project_name`/`"Project Name"` confirmed zero remaining hits outside this
migration document's own historical entries; Documents and outputs copies re-synced and confirmed identical
via `diff -rq`.

## 66. Topbar "New QA request" button was visible to every role, not just Requester/Business Analyst/Admin

**Why:** no schema change. `components/Layout.tsx`'s topbar has always had a "+ New QA request" shortcut
(navigates to `/qa-requests` and opens the raise wizard) alongside the QA Requests list page's own
"+ Raise QA Request" button. The list page's button was already correctly gated behind
`canCreate = hasRole(user, 'REQUESTER', 'BUSINESS_ANALYST')` (Admin always passes via `hasRole`'s built-in
bypass), but the topbar shortcut was never gated at all -- it rendered for every logged-in user regardless
of role, including SM, Department Head, QA Lead, QA Engineer, Security Analyst, and Department Head COE,
none of whom `POST /api/qa-requests`/`POST /api/qa-requests/{id}/submit` actually allow
(`require_roles(Role.REQUESTER, Role.BUSINESS_ANALYST)` on the backend). Clicking it as one of those roles
worked (it just opens the wizard), but submitting would always fail server-side -- a dead-end button dressed
up as a live one.

**Fix:** the topbar button is now wrapped in the same `hasRole(user, 'REQUESTER', 'BUSINESS_ANALYST')` check
already used on the QA Requests page, so it only renders for Requester, Business Analyst, or Admin -- the
only roles actually able to raise a QA Request. Business Analyst is kept (not narrowed to Requester/Admin
only) to stay consistent with the backend's existing `require_roles` on `create_request`/`submit_request`
and with the list page's own long-standing `canCreate` gate -- both already treat Business Analyst as a
legitimate requester-equivalent role, so hiding the shortcut from them while leaving the page's own button
visible would just be a confusing inconsistency, not a real access restriction.

**No schema or backend change** -- purely a frontend visibility fix, `components/Layout.tsx` only. Verified
via `tsc --noEmit -p .` (clean); Documents and outputs copies re-synced and confirmed identical via
`diff -rq`.

## 67. Automation Testing removed entirely (code + DB tables); every linked child request now lands directly at SM Approval Pending

**Why:** two related, explicitly-requested changes. First, the Automation Testing module (request type,
workflow, DB tables, and every UI page/nav entry for it) is retired outright -- fully deleted, not just
hidden -- per an explicit decision to drop the data rather than keep it around deprecated. Second, raising a
QA Request no longer leaves its linked Functional/SAST/DAST/Performance requests sitting in their own
`DRAFT` status waiting for someone to separately open each one and click its own "Submit" -- every linked
child request is now created already routed straight to `SM_APPROVAL_PENDING` (or `SM_REJECTED`, if the
shared Application Name was already rejected by the time it's created), the moment the gateway QA Request
itself is raised. All pre-existing gates (the SAST/DAST mandatory Security Readiness checklist
self-declaration, the Application-Name-rejection auto-reject rule) still apply, just enforced at raise time
instead of at each child's own since-removed Submit step.

**Automation Testing removal -- backend:**
- `models.py`: deleted the `AutomationRequest`, `AutomationChecklistItem`, and `AutomationWalkthrough`
  classes outright (tables `qap_automation_requests`, `qap_automation_checklist_items`,
  `qap_automation_walkthroughs`), the `QARequest.linked_automation_requests` relationship, and the
  `draft_automation_checked_items` staging property.
- `schemas.py`: deleted `AutomationCreate`, `AutomationUpdate`, `AutomationOut`,
  `AutomationChecklistItemOut`, `AutomationChecklistItemUpdate`; removed `automation_checked_items`/
  `automation_priority`/`automation_risk_category` from `QARequestCreate` and
  `linked_automation_requests`/`draft_automation_checked_items` from `QARequestOut`.
- `constants.py`: deleted `AUTOMATION_STATUSES`, `AUTOMATION_TERMINAL_STATUSES`,
  `AUTOMATION_EDITABLE_STATUSES`, `AUTOMATION_STATUS_LABELS`, `AUTOMATION_STAGE_ORDER`,
  `DEFAULT_AUTOMATION_CHECKLIST_ITEMS`; removed "Automation Testing" from `REQUEST_TYPES` and the
  `"AUTOMATION"` entry from `WORKFLOW_STEPS`.
- `routers/automation.py` deleted outright (the entire `/api/automation-requests` endpoint set no longer
  exists). `main.py` no longer imports or registers it.
- `routers/qa_requests.py::_sync_linked_child_requests` no longer creates an `AutomationRequest` branch.
- `routers/functional.py::complete_qa` no longer checks Automation's terminal-status set when deciding
  whether sibling requests are still open.
- `routers/applications.py::_auto_reject_linked_requests`, `routers/approvals.py::_resolve_request_ref`,
  `routers/reports.py::qa_request_summary`, `routers/dashboard.py`, `routers/suppression.py`,
  `routers/signoff.py`, `documents.py` -- all had their Automation-specific branch/reference removed
  (`_resolve_request_ref`'s `entity_type == "AUTOMATION"` lookup, the `linked_automation_requests` group in
  the auto-reject list, the `"Automation"` column in the QA Request Summary report, etc.).

**Automation Testing removal -- frontend:** `modules/specialised-testing/Automation.tsx` and
`QARequests/steps/AutomationStep.tsx` deleted outright. Every reference removed from `App.tsx` (route +
lazy import), `components/Layout.tsx` (nav item, nav count, `/api/automation-requests` fetch),
`Dashboard.tsx` (Dashboard and My Requests tab both dropped their Automation fetch/unify/terminal-status
entries), `constants.ts` (`AUTOMATION_STATUSES`/`AUTOMATION_STATUS_LABELS`/`AUTOMATION_TERMINAL_STATUSES`/
`AUTOMATION_EDITABLE_STATUSES`/`DEFAULT_AUTOMATION_CHECKLIST_ITEMS`/`"Automation Testing"` in
`REQUEST_TYPES`), `types.ts` (`AutomationOut`/`AutomationChecklistItemOut`, `linked_automation_requests`/
`draft_automation_checked_items` on `QARequestOut`), `components/Common.tsx` (`AUTOMATION_STATUS_LABELS`
merge, Automation-only badge colour entries -- `SCRIPT_DEVELOPMENT` was kept since Performance's own
lifecycle also uses that exact status name), `QARequests/buildSteps.ts`/`types.ts`/`NewRequestModal.tsx`/
`steps/TypeStep.tsx`/`steps/FunctionalStep.tsx`/`RequestDetail.tsx`/`format.ts`/`index.tsx` (wizard step,
form defaults, linked-request badge/summary/section list), `modules/governance/Approvals.tsx` (`AUTOMATION`
entity-type filter option), and one comment/label fix each in `modules/functional/Functional.tsx`,
`modules/specialised-testing/Performance.tsx`, `components/UserAssignSelect.tsx`,
`components/ApplicationNameBanner.tsx`, `index.css`.

**DDL -- drop the 3 Automation tables** (children first, then the parent, since
`qap_automation_checklist_items`/`qap_automation_walkthroughs` both carry an FK to
`qap_automation_requests`):

```sql
DROP TABLE qap_automation_checklist_items;
DROP TABLE qap_automation_walkthroughs;
DROP TABLE qap_automation_requests;
```

**Data cleanup -- orphaned references in shared/polymorphic tables.** Neither of the tables below has a real
FK to `qap_automation_requests` (both are generic, module-string-keyed tables shared across every request
type -- see `models.RequestDocument`/`models.ApprovalAction`), so dropping the 3 tables above does **not**
cascade-delete these rows; they'd be left silently dangling (pointing at a `request_id` that no longer
resolves to anything) unless cleaned up explicitly:

```sql
-- Supporting documents uploaded against a since-deleted Automation Testing request.
DELETE FROM qap_module_documents WHERE module = 'AUTOMATION';

-- Approval Workflow Log entries logged against a since-deleted Automation Testing request.
DELETE FROM qap_approval_actions WHERE entity_type = 'AUTOMATION';
```

Run the `DELETE`s before (or in the same maintenance window as) the `DROP TABLE`s -- order between the two
doesn't matter functionally (no FK links either way), but doing the cleanup first means a mid-migration
failure never leaves the app pointed at half-dropped Automation data.

**Direct-to-SM change -- backend (`routers/qa_requests.py`):**
- New helper `_raise_child_to_sm(db, child, entity_type, qa_request, current_user)`: logs the same
  "Requester / Submitted" history entry each child's own since-this-change-moot `submit` endpoint used to log,
  then sets `child.status = "SM_REJECTED"` (with a "SM Approval / Rejected" log entry) if the gateway's
  Application Name was already rejected, else `child.status = "SM_APPROVAL_PENDING"` (with a
  "SM Approval / Pending" log entry) -- exactly mirroring the two-step history pattern
  `functional.py::submit_request`/`sast_dast.py::_submit`/`performance.py::submit_performance` each used to
  log once someone got around to clicking their own module's Submit button.
- `_sync_linked_child_requests` now takes a `current_user` parameter and calls `_raise_child_to_sm` right
  after each Functional/SAST/DAST/Performance child is created (and its checklist items seeded) -- every
  child is therefore born at `SM_APPROVAL_PENDING`/`SM_REJECTED`, never at `DRAFT`.
- `submit_request` (the gateway's own raise action) is otherwise unchanged in shape: it still runs the
  mandatory SAST/DAST Security Readiness checklist gate *before* calling `_sync_linked_child_requests` (this
  gate now matters even more, since there's no later per-child Submit step left to catch it), then moves the
  gateway itself through `SUBMITTED` &rarr; `RAISED` exactly as before.

**Direct-to-SM change -- what's now effectively dead code, kept rather than removed:** each child module's
own `POST .../submit` endpoint (`functional.py::submit_request`, `sast_dast.py::_submit`,
`performance.py::submit_performance`) still exists and still requires the request to be in `DRAFT` -- but no
child request is ever created in `DRAFT` anymore, so these endpoints can no longer actually be reached in
the normal flow. Left in place rather than deleted: removing them is a larger, separable cleanup (frontend
Submit buttons, `FUNCTIONAL_EDITABLE_STATUSES`-style constants, etc. would all need a matching pass), and
leaving a permanently-400 endpoint behind is harmless.

**Verification:** `python3 -m py_compile` across every touched backend file (clean); `tsc --noEmit -p .`
clean; repo-wide case-insensitive grep for `automation` across both `backend/app/` and `frontend/src/`
confirmed zero remaining hits; Documents and outputs copies re-synced and confirmed identical via
`diff -rq`.

## 68. Readiness/Security-Readiness "Passed" decisions could be clicked without verifying a single checklist item

**Why:** no schema change -- a business-logic gate bug. Each of Functional's Readiness Verification,
SAST/DAST's Security Readiness, and Performance's own Readiness decision guards its "Passed" transition with
a check of the form `pending = [c.item for c in obj.checklist_items if c.is_mandatory and not c.is_complete]`
-- i.e. only *mandatory* items block Passed. That check was already correct in intent, but every item on
Functional's `DEFAULT_CHECKLIST_ITEMS` and Performance's `DEFAULT_PERFORMANCE_CHECKLIST_ITEMS` ships with
`is_mandatory = False` (a deliberate, earlier decision -- see section on "Make readiness checklists
non-mandatory"), and SAST/DAST's own Security Readiness step reuses `DEFAULT_SAST_CHECKLIST_ITEMS`/
`DEFAULT_DAST_CHECKLIST_ITEMS`, whose mandatory items are already fully enforced earlier, at Submit time (see
`_require_checklist_ready`), before this checklist's own Security-Readiness-stage verification ever comes
into play. Net effect across all three: `pending` was always empty, so the mandatory-only gate was a no-op
-- the QA Lead (or Security Lead, or QA/Engineer on Performance) could click "Passed" the instant Readiness
started, without ever ticking a single checklist item complete.

**Fix:** all three `Passed` gates now require **every** checklist item to be QA-verified
(`is_complete = True`), not just the mandatory ones:
- `functional.py::readiness_decision` -- `pending = [c.item for c in obj.checklist_items if not c.is_complete]`.
- `sast_dast.py::_readiness_decision` (shared SAST/DAST implementation) -- same change.
- `performance.py::readiness_decision` -- same change.

This doesn't introduce a deadlock: `update_checklist_item` on each module already blocks verifying
(`is_complete = True`) an item the requester never self-declared ready (`requester_checked`) in the first
place -- so if a requester left something unticked at intake, the QA Lead/Security Lead/Engineer simply can't
verify it, and the only way forward is a `Failed`/`Return` decision, sending the request back so the
requester can self-declare that item, then resubmit into Readiness again. "Passed" now genuinely means every
item was ticked ready by the requester *and* independently verified by QA/Security, matching what "Readiness
Verification" is supposed to mean.

**No frontend change** -- the Passed/Readiness Passed buttons in `Functional.tsx`/`SAST.tsx`/`DAST.tsx`/
`Performance.tsx` already call the same endpoints and already render whatever error the backend returns via
the existing `ErrorText`, so a still-incomplete checklist now surfaces as "Readiness checklist incomplete:
&lt;item names&gt;" (or the Security/Pre-testing equivalent wording) the same way any other validation error
does elsewhere in the app.

**Verification:** `python3 -m py_compile` across `functional.py`, `sast_dast.py`, `performance.py` (clean);
Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 69. Readiness "Passed" gate narrowed to requester-declared items only; "Not mandatory"/"Optional" checklist labels removed everywhere

**Why:** two follow-up fixes to section 68 above, both reported immediately after that change shipped. First,
section 68's fix required **every** checklist item to be `is_complete` before Passed -- but if a requester
never self-declared a given item ready (`requester_checked = False`) at intake, `update_checklist_item`
already blocks QA/Security from ever verifying that specific item (a pre-existing, intentional gate -- QA
can't confirm something the requester never claimed). Requiring *that* item to be complete too meant such a
request could never reach Passed at all -- a real deadlock, not just a stricter check. Second, every
checklist row across Functional/SAST/DAST/Performance showed a "Not mandatory" (Edit Details modal) or
"Optional" (main checklist tab) badge on every non-mandatory item -- visual noise on every single row, since
almost every item in this app is non-mandatory by design (see section on "Make readiness checklists
non-mandatory").

**Fix 1 -- narrow the Passed gate to requester-declared items:** `functional.py::readiness_decision`,
`sast_dast.py::_readiness_decision`, and `performance.py::readiness_decision` all now compute
`pending = [c.item for c in obj.checklist_items if c.requester_checked and not c.is_complete]` (previously
`if not c.is_complete`, unconditionally). An item the requester never ticked ready simply doesn't count
toward the gate at all -- Passed no longer waits on it, and it's not something QA/Security ever had a way to
verify in the first place. Every item the requester *did* self-declare ready still must be independently
QA/Security-verified before Passed -- the original bug (Passed reachable with zero items verified) stays
fixed, just without the new deadlock section 68 introduced.

**Fix 2 -- drop the non-mandatory label everywhere, keep the mandatory one:** every `{!c.is_mandatory &&
<span className="badge badge-gray">Not mandatory</span>}` / `{!c.is_mandatory && <span className="badge
badge-gray">Optional</span>}` conditional was inverted to `{c.is_mandatory && <span className="badge
badge-gray">Mandatory</span>}` -- so a "Mandatory" badge still calls out the (rare, SAST/DAST-only in
practice) items that block Submit/require self-declaration, but nothing is shown at all for the common,
non-mandatory case. Touched: `Functional.tsx` (Edit Details modal), `SAST.tsx` (Edit Details modal + Security
Readiness tab), `DAST.tsx` (Edit Details modal + Security Readiness tab), `Performance.tsx` (Edit Details
modal + Readiness tab). The QA Request wizard's own SAST/DAST checklist steps
(`QARequests/steps/SastStep.tsx`/`DastStep.tsx`) already only showed a "Mandatory" badge with no
non-mandatory counterpart, so they needed no change. Also fixed the one backend equivalent:
`functional.py::export_functional`'s PDF export appended a literal `" (optional)"` suffix to every
non-mandatory checklist row; changed to append `" (Mandatory)"` only when `is_mandatory` is true, matching
the frontend's new convention.

**No schema change.** **Verification:** `python3 -m py_compile` across `functional.py`, `sast_dast.py`,
`performance.py` (clean); `tsc --noEmit -p .` clean; grep confirmed zero remaining "Not mandatory"/"Optional"
checklist badges; Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 70. Removed the "linked sibling requests must all be terminal" gate on Functional's complete-qa

**Why:** explicitly requested -- every request type (Functional/SAST/DAST/Performance) raised off the same
QA Request gateway runs its own fully independent Draft/Raised-onward workflow ("QA request form is the
gateway only" -- see models.QARequest's own docstring); they were never meant to block on each other.
`functional.py::complete_qa` was the one exception: it refused to mark a Functional Testing Request's QA
activity complete while any sibling SAST/DAST/Performance request raised alongside it (via the same gateway)
hadn't yet reached its own terminal status, e.g. `"QA cannot be marked complete while linked request(s) are
still open: SAST-20260729-08D215. They must reach a terminal (closed) state first."` A repo-wide search
confirmed this was the **only** such gate in the codebase -- `sast_dast.py`/`performance.py`/`qa_requests.py`
have no equivalent check blocking on a *gateway* sibling's status (SAST/DAST's own `_mark_report_ready` gate
is unrelated -- it blocks on a linked **Suppression** request, a different relationship entirely, and is
unaffected by this change).

**Fix:** `complete_qa` no longer inspects `gateway.linked_sast_requests`/`linked_dast_requests`/
`linked_performance_requests` at all -- the `open_security`/`open_performance`/`open_all` computation and the
`HTTPException(400, ...)` it fed are deleted outright. Completing QA now only requires the Functional request
itself to be in `EXECUTION_IN_PROGRESS`/`RETESTING`/`REGRESSION_TESTING` (unchanged), with no dependency on
any other request's status. The now-unused `SAST_DAST_TERMINAL_STATUSES`/`PERFORMANCE_TERMINAL_STATUSES`
imports were removed from `functional.py` too (still used elsewhere, e.g. `constants.py`/`dashboard.py`/
`Layout.tsx`, so nothing else was touched).

**No frontend change needed** -- the "Mark QA Completed" button in `Functional.tsx` was never disabled based
on sibling status client-side; it simply called the endpoint and would have surfaced the now-removed 400 via
the generic error handler. That informational note ("see that request for supporting documents and any
other linked SAST/DAST/Performance requests") is unaffected -- it was never a blocking check, just a pointer
to the sibling requests' own pages.

**No schema change.** **Verification:** `python3 -m py_compile` on `functional.py` (clean); repo-wide grep
confirmed `SAST_DAST_TERMINAL_STATUSES`/`PERFORMANCE_TERMINAL_STATUSES` no longer appear in that file and no
other router has an equivalent gateway-sibling completion gate; Documents and outputs copies re-synced and
confirmed identical via `diff -rq`.

## 71. Bug fix: "Request Sign-off" button never rendered for QA_ENGINEER once QA Completed

**Why:** reported directly -- a Functional Testing Request reached `QA_COMPLETED` and the detail page's
Workflow Actions panel showed only "No actions available for your role at this stage," with no "Request
Sign-off" button, when viewed by the QA_ENGINEER who had actually run QA through to completion (not the
request's assigned QA Lead). The backend was never the problem: both `functional.py::request_signoff`
(`POST /{id}/request-signoff`) and `signoff.py::create_signoff` (`POST /api/signoffs`, which the sign-off
modal calls to create the certificate itself) already gate on
`require_roles(Role.QA_LEAD, Role.QA_ENGINEER)`. Only the frontend's button-visibility check in
`Functional.tsx` was narrower than the API it drives -- `canRequestSignoff` checked `hasRole(user,
'QA_LEAD')` alone, so a QA_ENGINEER who could legally call both endpoints had no way to reach them through
the UI.

**Fix:** widened the gate in `frontend/src/modules/functional/Functional.tsx` to
`hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'QA_COMPLETED'`, matching `canCompleteQA`'s own role
set (QA_LEAD/QA_ENGINEER) immediately above it and both backend endpoints' role gates. `canConfirmSignoff`
(the later "Confirm Sign-off" step, still QA_LEAD-only) is unaffected -- that stage's own backend endpoint
(`confirm_signoff`) is intentionally QA_LEAD-only and wasn't touched.

**No schema change, no backend change.** **Verification:** `npx tsc --noEmit -p .` from `frontend/` (clean);
Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 72. Sign-off raise flow: no document upload provision; certificate detail view missing Exit Criteria/Defect/Residual Risk fields

**Why:** two gaps reported together. First, `NewSignOffModal` (the "Request Sign-off" form, in
`frontend/src/modules/governance/SignOff.tsx`) had no file picker at all -- the backend has supported
supporting-document upload for Sign-off certificates all along (`documents.py`'s shared
module+request_id-keyed `qap_module_documents` table already lists `SIGNOFF` alongside
Functional/SAST/DAST/Performance/Suppression, and `routers/signoff.py` already exposes
`GET/POST /api/signoffs/{id}/documents` and the download endpoint), but the only place that called them was
`RequestDocuments` inside `SignOffDetail` -- reachable only *after* the certificate exists, by opening it back
up from the Sign-off list. There was no way to attach a document at raise time itself. Second,
`SignOffDetail`'s own summary grid -- what actually renders when you click a raised certificate -- never
displayed `exit_criteria_notes`/`open_defect_summary`/`residual_risk_notes` (all three mandatory fields
captured at raise/edit time, see `NewSignOffModal`/`EditSignOffModal`'s own required textareas), nor several
other captured fields (Testing Request ID, Change Request ID(s), Application Owner, Department, Certificate
Date, Vendor/SI Partner, Technology Stack, Validity).

**Fix (both frontend-only, `frontend/src/modules/governance/SignOff.tsx`):**
- `NewSignOffModal` gained a `files: File[]` state and a "Supporting Documents" file-picker field. Since
  there's no certificate id to upload against until `POST /api/signoffs` returns one, `submit()` now creates
  the certificate first, then -- if any files were picked -- immediately calls
  `api.uploadFiles('/api/signoffs/{id}/documents', files)` before handing control back via `onCreated`. A
  failed upload doesn't block certificate creation (the certificate's own Documents tab, via the existing
  `RequestDocuments`/`SignOffDetail`, can always retry), but the error still surfaces via `ErrorText` so the
  user knows to retry.
- `SignOffDetail`'s summary grid gained the missing fields listed above, plus a new "Exit Criteria & Risk"
  section rendering `exit_criteria_notes`/`open_defect_summary`/`residual_risk_notes` in full (these are
  free-text and can run long, so they're broken out of the 2-column grid rather than crammed into it).

**No schema change, no backend change** (the upload/list/download endpoints already existed for `SIGNOFF`).
**Verification:** `npx tsc --noEmit -p .` from `frontend/` (clean); Documents and outputs copies re-synced and
confirmed identical via `diff -rq`.

## 73. Bug fix: document upload had no restriction at all -- any logged-in user could upload to any request

**Why:** reported directly -- every module's `POST .../documents` endpoint accepted a file from any
authenticated user regardless of role, department, or involvement in that specific request.
`qa_requests.py::upload_documents` only checked that the caller held *any* of Requester/Business Analyst/
QA Engineer/QA Lead -- not that they were *this* request's own requester, so e.g. any Requester-role user
could upload to someone else's QA Request. `functional.py`/`sast_dast.py`/`performance.py`/`suppression.py`/
`signoff.py`'s own upload endpoints were worse still -- plain `Depends(get_current_user)` with no role or
ownership check whatsoever, so literally anyone logged in (any role, any department, uninvolved in the
request) could attach a document to any request in the system.

**Fix:** each module gained a `_can_upload_documents(obj, user)` helper, called from that module's own
`POST .../documents` endpoint (list/download endpoints are unaffected -- viewing wasn't the reported problem,
only who can add new files). Every helper follows the same shape: Admin always passes; the request's own
requester (`requester_id`/`created_by_id`) always passes (they may need to attach more evidence at any
point); and beyond that, only whoever the request's *current* status is actually sitting with is allowed --
matching the exact role/department/assignment gate that status's own decision endpoint in the same file
already enforces, not merely "anyone holding that role":

- **`functional.py`:** SM (same department) during `SM_APPROVAL_PENDING`; Department Head (same department)
  during `DEPARTMENT_HEAD_APPROVAL_PENDING`; the specifically assigned QA Lead (`qa_lead_id`) for
  `QA_LEAD_ASSIGNED`/`READINESS_VERIFICATION`/`QA_ACTIVITY_INITIATED`/`PLANNING`; the assigned QA Lead or an
  assigned tester (`assigned_tester_ids`) for every status from `TESTER_ASSIGNED` through
  `QA_SIGNOFF_PENDING` (`TEST_DESIGN`/`EXECUTION_IN_PROGRESS`/`DEFECT_RAISED`/`WAITING_FOR_FIX`/`RETESTING`/
  `REGRESSION_TESTING`/`QA_COMPLETED`/`QA_SIGNOFF_PENDING`).
- **`sast_dast.py`** (shared helper, both SAST and DAST): SM/Department Head the same way, plus the
  specifically assigned Security Lead (`security_lead_id`) for every post-assignment status
  (`SECURITY_LEAD_ASSIGNED` through `SECURITY_COMPLETE`).
- **`performance.py`:** SM/Department Head the same way, plus the specifically assigned Engineer
  (`engineer_id`) for every post-assignment status (`ENGINEER_ASSIGNED` through `SIGNOFF_PENDING`).
- **`suppression.py`:** SM/Department Head the same way, plus any Security Analyst during
  `SECURITY_TEAM_VERIFICATION` -- unlike the other modules' equivalent stage, there's no individual
  assignment to narrow to here (`security_team_decision` itself has no department scoping or per-request
  assignee either, since the Security Team reviews across departments), so this one stays role-only,
  matching that endpoint's own gate exactly.
- **`signoff.py`:** the certificate's own requester, SM (same department) during `SM_APPROVAL_PENDING`, or
  Department Head COE during `DEPT_HEAD_COE_APPROVAL_PENDING` -- role-only, NOT department-scoped (see
  section 74 below, which corrects this same file's department_head_coe_decision endpoint and this helper
  together after the department scoping turned out to block real approvals).
- **`qa_requests.py`** (the gateway QA Request itself): narrowed to just the request's own `requester_id`
  (or admin) -- the gateway has no approval workflow of its own to widen this to (pure intake record, see
  `models.QARequest`'s docstring), so there's no equivalent "current stage owner" concept here the way there
  is for its linked child requests.

Every stage not explicitly listed above (Draft, Submitted, Returned-by-*, Requester Verification, and every
terminal/rejected status) falls through to "nothing pending on anyone but the requester" -- already covered
by the requester check, so no other actor is granted upload access at those points.

**No schema change.** **Verification:** `python3 -m py_compile` on all six changed routers (clean); manually
cross-checked every role/status constant referenced (`Role.SM`/`Role.DEPARTMENT_HEAD`/
`Role.DEPARTMENT_HEAD_COE`/`Role.SECURITY_ANALYST`/`Role.ADMIN`, and every `QAStatus`/`SAST_DAST_STATUSES`/
`PERFORMANCE_STATUSES` value used) directly against `constants.py`; Documents and outputs copies re-synced
and confirmed identical via `diff -rq`.

## 74. Bug fix: Executive COE (Department Head COE) could not approve QA Sign-off Certificates

**SUPERSEDED by section 75 below** -- confirmed directly afterward that department mapping for Department
Head COE is in fact required (an Executive COE from one department must not be able to complete a
certificate belonging to another), so this section's removal of `require_same_department` was wrong and has
been reverted. Left in place below for the record of what was tried and why; do not re-apply this section's
fix.

**Why:** reported directly -- an Executive COE (AGM-QA) user, holding `Role.DEPARTMENT_HEAD_COE`, could not
approve, return, or reject a certificate sitting at `DEPT_HEAD_COE_APPROVAL_PENDING`, the final step of the
QA Sign-off chain. Root cause: `routers/signoff.py::department_head_coe_decision` called
`require_same_department(current_user, obj.department)` -- the same department-match check used by the SM
and (business) Department Head decision endpoints. But `deps.py::require_same_department`'s own docstring is
explicit that this check is for genuine business-side roles "mapped to a specific department" and does NOT
apply to the QA side of the workflow (it names QA_LEAD/QA_ENGINEER/SECURITY_ANALYST as the existing
exemptions). `Role.DEPARTMENT_HEAD_COE` is "Executive COE (CM/AGM-QA)" (see `constants.ROLE_LABELS`) -- a QA
function executive who signs off certificates across the whole QA organization, not a business department
head tied to the requester's own department. Confirmed via `seed.py`: the seeded Executive COE user (`exec1`,
Vikram Joshi) is mapped to department `"QA Team"`, which will never equal a business department like "Digital
Banking Department (DBD)" -- so `require_same_department` silently rejected every real approval this role
was ever asked to make. The frontend had the identical bug: `SignOff.tsx`'s `canDeptHeadCoeDecide` also
required `sameDept || isAdmin`, so the Approve/Return/Reject buttons themselves never rendered for a non-admin
Executive COE either. The upload-permission fix from section 73 (same session, just before this one) had
also carried the same same-department requirement into its own `_can_upload_documents` helper for this
exact status, since it was modeled on the (correctly department-scoped) SM case right above it.

**Fix:** removed the `require_same_department` call from `department_head_coe_decision` entirely -- the
endpoint now only requires `Role.DEPARTMENT_HEAD_COE` (via `require_roles`, unchanged) and the certificate
being in `DEPT_HEAD_COE_APPROVAL_PENDING`. Updated `_can_upload_documents`'s own `DEPT_HEAD_COE_APPROVAL_PENDING`
branch to drop the `user.department == obj.department` comparison, keeping only the role check. Updated
`SignOff.tsx::canDeptHeadCoeDecide` to `hasRole(user, 'DEPARTMENT_HEAD_COE') && status ===
'DEPT_HEAD_COE_APPROVAL_PENDING'`, dropping `sameDept || isAdmin` (both still used elsewhere in the file for
the genuinely department-scoped SM checks, so neither was removed). SM's own department scoping (`sm_decision`,
`update_signoff`'s SM-editing window, `canSMDecide`) is untouched -- SM is a real business-side role and this
restriction is correct there.

**No schema change.** **Verification:** `python3 -m py_compile` on `signoff.py` (clean); `npx tsc --noEmit -p .`
from `frontend/` (clean); confirmed via `seed.py` that the seeded Executive COE account's department
("QA Team") could never have matched a real request's business department, explaining the reported symptom
exactly; Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 75. Revert of section 74 -- Department Head COE department mapping is required after all

**Why:** confirmed directly, immediately after section 74 shipped: department mapping for Department Head
COE ("Executive COE (CM/AGM-QA)") is in fact a required business rule -- "other department can not complete
sign off." Section 74's reasoning (that this role signs off across the whole QA function, org-wide, the same
way QA_LEAD/QA_ENGINEER/SECURITY_ANALYST are exempted from `require_same_department`) was wrong: in the real
deployment, each Executive COE user is mapped to a specific department, same as SM/Department Head, and one
department's Executive COE must not be able to approve another department's certificate. The workflow order
itself (SM Approval -> Department Head COE Approval, i.e. `SM_APPROVAL_PENDING` ->
`DEPT_HEAD_COE_APPROVAL_PENDING`) was never in question and is unchanged.

The original "Executive COE not able to approve" symptom that prompted section 74 was real, but its true
cause was a data-mapping problem, not a code bug: the demo/seed account (`seed.py`'s `exec1`, Vikram Joshi) is
mapped to department `"QA Team"`, which will never equal a real request's business department (e.g. "Digital
Banking Department (DBD)") -- so it could never pass the same-department check regardless of which
certificate it tried to approve. The fix for that is data, not code: every real Executive COE user must be
mapped, via Admin > Users, to the SAME department as the certificates they're expected to approve.

**Fix (reverting section 74's three changes):**
- `routers/signoff.py::department_head_coe_decision` -- restored the `require_same_department(current_user,
  obj.department)` call (removed docstring reasoning about org-wide scope; replaced with a note explaining
  the mapping requirement and pointing at the real (data) cause of the original symptom).
- `routers/signoff.py::_can_upload_documents` -- restored `user.department == obj.department` on the
  `DEPT_HEAD_COE_APPROVAL_PENDING` branch.
- `frontend/src/modules/governance/SignOff.tsx::canDeptHeadCoeDecide` -- restored `&& (sameDept || isAdmin)`.

SM's own department scoping (`sm_decision`, `update_signoff`'s SM-editing window, `canSMDecide`) was never
touched by either section 74 or this revert -- SM has always correctly required department mapping.

**No schema change.** **Verification:** `python3 -m py_compile` on `signoff.py` (clean); `npx tsc --noEmit -p .`
from `frontend/` (clean); Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 76. Fix: Department Head COE department match compared against the wrong side of the workflow

**Why:** section 75's revert restored `require_same_department(current_user, obj.department)` on
`department_head_coe_decision` -- correct in spirit (department mapping is required), but `obj.department` is
the delegated *business* department of the underlying Functional Testing Request (e.g. "Digital Banking
Department (DBD)"), the same field the SM step legitimately matches against a couple of lines up (SM is a
genuine business-side reviewer). Confirmed directly: "Sign off form raised by QA team, so it should be
approved by QA team only" -- the certificate is raised by a Tester/QA Lead, always someone on the QA team, so
Department Head COE approval should match against *the requester's own department*, not the business
department of the change being tested. Comparing against `obj.department` instead would have meant an
Executive COE mapped to "QA Team" could never approve a certificate whose underlying request came from any
business department (DBD, IT, etc.) -- i.e. never, since a certificate's `obj.department` is always a
business department, not "QA Team" -- reproducing the exact original symptom section 74/75 were trying to
fix, just for a different (correct, this time) reason.

**Fix:** added `_requester_department(db, obj)` to `routers/signoff.py` -- looks up the certificate's own
`requester_id` and returns *that user's* `department` (always the QA team's, since only QA_ENGINEER/QA_LEAD
can raise a certificate -- see `create_signoff`'s own role gate). `department_head_coe_decision` and
`_can_upload_documents`'s `DEPT_HEAD_COE_APPROVAL_PENDING` branch now call
`require_same_department(current_user, _requester_department(db, obj))` / compare against it, instead of
`obj.department`. Deliberately looks up the requester's actual department rather than hardcoding the literal
string `"QA Team"`, so this stays correct even if that department is ever renamed or split in Admin >
Departments. Mirrored on the frontend: `SignOff.tsx`'s `SignOffDetail` now computes `requesterDepartment`
(via `users.find((u) => u.id === item.requester_id)?.department`) and a new `sameDeptAsRequester`, and
`canDeptHeadCoeDecide` checks `sameDeptAsRequester || isAdmin` instead of `sameDept || isAdmin` (`sameDept`
itself -- matched against `item.department`, the business department -- is untouched and still correctly used
by `canSMDecide`/the SM-editing window in `canEditDetails`).

**No schema change.** **Verification:** `python3 -m py_compile` on `signoff.py` (clean); `npx tsc --noEmit -p .`
from `frontend/` (clean); Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 77. Bug fix: Functional Testing Request stayed at "QA Sign-off Pending" after its certificate was Issued

**Why:** reported directly -- a QA Sign-off Certificate reached `ISSUED` (Department Head COE's final
approval), but the linked Functional Testing Request kept showing "QA Sign-off Pending" instead of moving on.
Root cause: nothing ever connected the two. The only bridge was `routers/functional.py::confirm_signoff`, a
separate action a QA Lead had to manually trigger themselves (via a "Confirm Sign-off" button on the
Functional Testing Request's own page) -- and that endpoint didn't even check that the linked certificate was
actually `ISSUED` before letting them confirm. Once the certificate's own Tester -> SM -> Department Head COE
approval chain was introduced (see section 64), this manual step became redundant busywork that was easy to
forget, leaving the Functional Testing Request stuck at "QA Sign-off Pending" indefinitely even though the
certificate itself had already finished its own approval.

**Fix:** `routers/signoff.py::department_head_coe_decision` now calls a new
`_sync_linked_functional_request(db, obj, current_user)` immediately after setting the certificate to
`ISSUED` -- it looks up every `FunctionalRequest` with `signoff_id == obj.id` still sitting at
`QA_SIGNOFF_PENDING` and advances it straight to `REQUESTER_VERIFICATION` (via the same two-step
`QA_SIGNED_OFF` -> `REQUESTER_VERIFICATION` transition `confirm_signoff` used to do manually, logging both
steps to the History tab identically, actor now the Department Head COE who approved rather than the QA Lead
who used to click confirm). The frontend's "Confirm Sign-off" button has been removed from
`Functional.tsx` entirely -- `canConfirmSignoff` and its two usages (the button itself, and the two
conditions that referenced it) were deleted, since there's nothing left to manually confirm. While a
certificate is still working through its own chain, the linked request correctly just sits at "QA Sign-off
Pending" showing no available action -- it's genuinely waiting on someone else's decision, not on QA.

`routers/functional.py::confirm_signoff` itself was NOT deleted (per the standing "don't remove things
without being asked" convention) -- its docstring now explains it's superseded for the normal case and kept
only as a manual fallback (e.g. for a certificate that predates this fix, with no `signoff_id` link for the
auto-sync to find). It naturally becomes unreachable for every certificate the auto-sync successfully
handles, since `_require(obj, QAStatus.QA_SIGNOFF_PENDING, ...)` will already have moved past that status by
the time anyone could try to call it.

**No schema change.** **Verification:** `python3 -m py_compile` on `signoff.py`/`functional.py` (clean);
`npx tsc --noEmit -p .` from `frontend/` (clean); grepped the frontend for any remaining
`confirm-signoff`/`canConfirmSignoff` references (none); Documents and outputs copies re-synced and confirmed
identical via `diff -rq`.

## 78. Bug fix: Department dropdown (and other searchable pickers) got clipped inside table rows

**Why:** reported directly, with a screenshot -- the Admin > Users page's Department column uses
`components/SearchableSelect.tsx` inline in each row; opening it showed the option list cut off after only
two or three entries ("Business Development", "Compliance...") instead of the full scrollable list. Root
cause: the panel is a plain `position: absolute` element nested under its trigger (`.searchable-select-panel`
in `index.css`), but that trigger sits inside `.table-wrap`, which is deliberately `overflow-y: hidden` (so
the table's rounded corners stay crisp -- see that rule's own comment). Any absolutely-positioned panel that
would visually extend past `.table-wrap`'s own bottom edge gets hard-clipped by it. This is the exact same
class of bug `.th-filter-popover` (the per-column filter icon's own popover) already had, and was already
fixed for, back in section 46 -- but that fix was never applied to `SearchableSelect.tsx`, since it's a
separate component that happened to reuse the same panel-under-trigger approach.

**Fix:** applied the identical technique used for `.th-filter-popover`: `SearchableSelect.tsx` now computes
the trigger button's on-screen position via `getBoundingClientRect()` the moment it opens (new `toggleOpen()`,
replacing the plain `setOpen((o) => !o)` on the trigger's `onClick`) and renders the panel with a new
`searchable-select-panel-fixed` class (`position: fixed`, top/left/width all set inline from that rect) --
this escapes `.table-wrap`'s overflow clipping entirely, regardless of which row it's opened from. Applied
the same fix to `components/UserAssignSelect.tsx` too (the "Assign Security Lead/QA Lead/Engineer" picker,
which explicitly reuses "the same `.searchable-select*` chrome" per its own comment, and so shares the exact
same latent bug wherever it's used inside a scroll-clipped container). `index.css` gained the
`.searchable-select-panel-fixed` rule alongside the existing `.searchable-select-panel` one (which stays
unchanged, still used as-is by `SignOff.tsx`/`Suppression.tsx`'s own local searchable dropdowns that don't
need this -- they're not used inside a table).

**No schema change, no backend change.** **Verification:** `npx tsc --noEmit -p .` from `frontend/` (clean);
Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 79. Gateway "Linked Requests" becomes a clickable table, navigating to each request's own detail

**Why:** requested directly, with a screenshot of the QA Request gateway's Overview -- "Linked Requests"
was a flat wrapped line of colour-coded badges (`Functional QA TQA-FUNC-... — QA Completed`, `SAST
SAST-... — Returned by Security Lead`, etc.), informational only, with no way to click through to the
request it named. The user asked for a proper table (`Request Type || Request Id || Current Status`)
with each row opening that specific request's own detail page.

**Fix:** `QARequests/RequestDetail.tsx` now builds a `linkedRows` array (one entry per item across all
four `linked_functional_requests`/`linked_sast_requests`/`linked_dast_requests`/`linked_performance_requests`
arrays already on `QARequestOut`) and renders it with the existing `Table` component instead of the old
`<p>` of badges -- three columns, `Request Type` / `Request Id` / `Current Status` (the last using the
existing `Badge` component, which already resolves any request type's status via `ALL_STATUS_LABELS`
internally, so no new label lookup was needed). Each row carries its own module page path
(`/functional-requests`, `/sast`, `/dast`, `/performance`); clicking a row calls a new `openLinked(row)`
which closes the gateway modal (`onClose()`) and navigates to `` `${row.path}?open=${row.request_id}` ``
via `useNavigate`.

**No prior deep-link mechanism existed** to open one specific request's detail view directly from a URL
-- every module list page (`Functional.tsx`/`SAST.tsx`/`DAST.tsx`/`Performance.tsx`) only opens its detail
modal in response to a table row click, with no query-param awareness. Added a matching `useSearchParams`
effect to all four: once that page's own request list has loaded, if an `?open=<request_id>` param is
present, find the row whose `request_id` matches and `setSelected` it exactly as a row click would, then
strip the `open` param from the URL (`replace: true`, so back-navigation/refresh doesn't re-trigger it).
This is a general-purpose deep-link entry point, not specific to the gateway -- any future link (email,
notification, another page) can reuse the same `?open=<request_id>` convention against any of these four
routes.

**No schema change, no backend change.** **Verification:** `npx tsc --noEmit -p .` from `frontend/` (clean);
Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 80. Bug fix: dropdown panel froze in place on scroll (follow-up to section 78)

**Why:** reported directly, with a screenshot, right after section 78 shipped -- "on scroll select position
fixed to the position, so it is not working." Root cause: section 78's `position: fixed` panel had its
coordinates computed exactly once, at the moment it opened (`toggleOpen()`'s single `getBoundingClientRect()`
call). `position: fixed` elements don't move with page scroll on their own, so scrolling the page (or any
scrollable ancestor, e.g. `.table-wrap`) after opening the dropdown left the panel stranded at its original
on-screen coordinates while its trigger button -- and everything else -- scrolled out from under it, visually
detaching the two. Also flagged by the user as showing up "everywhere," including the first-time LDAP-login
department picker (`DepartmentPrompt.tsx`) -- confirmed that page renders the same shared `SearchableSelect`
component, so a single fix in the shared component covers every usage site.

**Fix:** added a second `useEffect` (keyed on `open`) to both `components/SearchableSelect.tsx` and
`components/UserAssignSelect.tsx` that, only while the panel is open, attaches a `scroll` listener to
`window` with `{ capture: true }` plus a `resize` listener, both calling a `reposition()` function that
re-reads `triggerRef.current?.getBoundingClientRect()` and updates `panelPos` state -- keeping the panel glued
to its trigger continuously instead of only at open-time. Both listeners are removed when the panel closes or
the component unmounts. `{ capture: true }` on the scroll listener is required because native `scroll` events
don't bubble to `window`, but they do fire during the capture phase, which is what's needed to catch scrolling
on a nested scrollable ancestor like `.table-wrap` (not just `window` itself scrolling). `toggleOpen()`'s
original open-time `getBoundingClientRect()` call is unchanged -- it still sets the initial position
immediately, before the first scroll/resize event has any chance to fire.

**No schema change, no backend change.** **Verification:** `npx tsc --noEmit -p .` from `frontend/` (clean);
Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 81. Bug fix: Download & Export Centre's PDF export had misaligned/overflowing columns

**Why:** reported directly, with two exported PDFs attached (`qa-request-summary`, `audit-evidence`) --
"columns are not aligned, not fitted properly." Root cause, in `routers/export.py::_rows_to_pdf`: the
`Table(data, repeatRows=1)` call passed no `colWidths` at all, and every cell held a plain Python string
rather than a `Paragraph`. With no fixed column widths and nothing to wrap, reportlab sizes each column
to fit its *longest single unwrapped line* with no page-width ceiling whatsoever -- a handful of long
`Comments`/`Priority / Risk (per type)` values (audit-evidence's history comments, qa-request-summary's
per-type priority/risk breakdown) made the table's total natural width far exceed the actual landscape-A4
page. The excess silently ran off the right edge of the printable area instead of wrapping or shrinking,
which is exactly what the two sample exports showed: `Department` reading as `ent (DBD)` (the start of
"Digital Banking Department (DBD)" pushed past the left content boundary as later columns shifted
everything over) and trailing columns (`Timestamp`, the `TQA-FUNC-...` ID) losing their tail past the right
edge. This is the Download & Export Centre's generic multi-row report export (any of the 9
`REPORT_REGISTRY` reports) -- a different code path from `pdf_export.py`'s per-request "detail
certificate" PDF (used by each module's own Export PDF button), which already wraps cells in `Paragraph`
with fixed `colWidths` and was never affected.

**Fix:** added `_fit_col_widths(headers, rows, available_width)` -- for each column, takes the ~85th
percentile of that column's cell-length distribution (header included) as a proxy for how much room it
typically needs (a percentile rather than the max so one freak 300-character comment doesn't single-handedly
dictate a column's width), turns those into proportional weights clamped to a sane `[42, 190]` point range,
then rescales the whole set so the widths always sum to *exactly* `available_width` -- the landscape-A4 page
width minus margins -- regardless of how many columns a given report has or how verbose its content is.
Every cell (header and data) is now wrapped in a `Paragraph` (small `6.5pt`/`7pt`-ish styles, matching
`pdf_export.py`'s existing convention) instead of a plain string, so any text still too long for its
allotted column width wraps onto additional lines (taller rows) rather than overflowing sideways. Margins
were also tightened from reportlab's 1-inch default to `10mm`/`12mm` to reclaim more usable width. Verified
by rendering both of the user's exact reported reports (`qa-request-summary`'s 10-column shape,
`audit-evidence`'s 8-column shape incl. its long `Comments` field) through the new code standalone and
converting to PNG for visual inspection -- every column now renders fully inside the page with no
clipping, and long values wrap cleanly onto extra lines instead of running off the edge.

**No schema change.** **Verification:** `python3 -m py_compile` on `routers/export.py` (clean); rendered
both reported reports' exact column shapes through the new `_rows_to_pdf`/`_fit_col_widths` standalone and
visually confirmed (via `pdftoppm`) no column clipping/overflow on either; Documents and outputs copies
re-synced and confirmed identical via `diff -rq`.

## 82. Bug fix: SM/Department Head could still edit a request after returning it themselves

**Why:** reported directly, on the SAST module -- "After request returned to requester during SM
approval, though request is return till 'Edit Details' button is showing and SM able to edit." Root
cause, present identically across all four editable request types (`update_sast`/`update_dast` in
`sast_dast.py`, `update_functional`, `update_performance`): once a request left `DRAFT`, the edit-access
check let the *requester or an SM/Department Head in the same department* edit it, for any status in that
module's `*_EDITABLE_STATUSES` list -- which is entirely made up of `DRAFT` plus the various
`RETURNED_BY_*` statuses. So when an SM returned their own request (status -> `RETURNED_BY_SM`), that
same SM still passed the edit-access check and the frontend still showed them an "Edit Details" button.
But `resubmit`/`_resubmit` (the endpoint that actually advances a returned request back into the approval
chain) has always been requester-or-admin-only, with no SM/Department Head path at all -- so an SM editing
a request they'd just returned could change its fields but could never push it forward again themselves,
a dead-end permission that just caused confusion (exactly what got reported).

**Fix:** removed the SM/Department Head edit-bypass entirely, in both the backend permission check and
the frontend's matching `canEditDetails` computation, on all four modules (SAST, DAST, Functional,
Performance) -- editing is now requester-or-admin-only, for every status in that module's own
`*_EDITABLE_STATUSES` list (`DRAFT` and every `RETURNED_BY_*` value), exactly matching who's actually
allowed to resubmit. Returning a request (by SM, Department Head, Security Lead, QA Lead, or Engineer,
depending on module/stage) now consistently means "the ball is with the requester to fix and resubmit" --
the reviewer who returned it no longer also gets a dangling edit permission they can't do anything useful
with. `require_same_department` and the `sameDept` frontend variable are both still used elsewhere on
every one of these files (their own SM/Department Head *decision* endpoints/buttons, which is a genuinely
different, still-correct permission point) -- only the edit-access bypass was removed.

**No schema change.** **Verification:** `python3 -m py_compile` on `sast_dast.py`/`functional.py`/
`performance.py` (clean); `npx tsc --noEmit -p .` from `frontend/` (clean); grepped every touched file to
confirm `require_same_department`/`sameDept` still have a live use elsewhere; Documents and outputs copies
re-synced and confirmed identical via `diff -rq`.

## 83. Follow-up to section 82: SM/Department Head regain edit access while their own decision is pending

**Why:** clarified directly, on the SAST module again -- "edit option only be allowed till department
head approval." Section 82 made editing requester-or-admin-only for every status in each module's
`*_EDITABLE_STATUSES` list, which removed the SM/Department Head's edit access entirely, including while
a request is genuinely sitting with them awaiting their own decision. That went further than intended: the
actual requirement is that a reviewer (SM or Department Head) should be able to open Edit Details, fix
something, and then Approve/Return/Reject while the request is pending *their own* checkpoint -- but lose
that edit access the instant they've decided either way (approved, returned, or rejected). Two follow-up
questions confirmed the exact boundary: readiness-stage returns (Security Lead/QA Lead/Engineer, all of
which happen *after* Department Head has already approved) stay requester-only, unchanged from section 82
-- reviewer edit access never extends past Department Head's own decision.

**Fix:** `SM_APPROVAL_PENDING` and `DEPARTMENT_HEAD_APPROVAL_PENDING` were added to each module's
`*_EDITABLE_STATUSES` list (`FUNCTIONAL_EDITABLE_STATUSES`/`SAST_DAST_EDITABLE_STATUSES`/
`PERFORMANCE_EDITABLE_STATUSES`, both backend `constants.py` and frontend `constants.ts` -- these lists
were previously just `DRAFT` + every `RETURNED_BY_*` value). A new `_can_edit_details(obj, user)` helper
was added to each router (`sast_dast.py` -- shared by both SAST and DAST -- plus `functional.py` and
`performance.py`, mirroring the existing `_can_upload_documents` helper's exact shape/style in each of
those same files) replacing the plain requester-or-admin check from section 82:

- Admin: always.
- `DRAFT`/`RETURNED_BY_SM`/`RETURNED_BY_DEPARTMENT_HEAD`/`RETURNED_BY_SECURITY_LEAD` (SAST/DAST) /
  `RETURNED_BY_QA_LEAD` (Functional) / `RETURNED_BY_ENGINEER` (Performance): requester only -- unchanged
  from section 82, this is "returned to the requester to fix and resubmit."
- `SM_APPROVAL_PENDING`: an SM in the same department as the request -- **new**.
- `DEPARTMENT_HEAD_APPROVAL_PENDING`: a Department Head in the same department -- **new**.
- Any other status (e.g. the SAST/DAST/QA execution/readiness statuses beyond Department Head approval):
  nobody but the requester, and only once/if it's returned back to them.

The frontend's `canEditDetails` in `SAST.tsx`/`DAST.tsx`/`Functional.tsx`/`Performance.tsx` mirrors this
exactly (same four-branch shape, reusing each file's existing `sameDept`/`isRequester`/`hasRole` helpers)
so the "Edit Details" button only ever appears for whoever the backend would actually let edit. Resubmit
itself (`_resubmit`/`resubmit_request`) is unchanged and remains requester-or-admin-only -- an SM/
Department Head editing a pending request doesn't gain the ability to advance its status themselves; they
still make that decision through their own normal Approve/Return/Reject action.

**No schema change.** **Verification:** `python3 -m py_compile` on `constants.py`/`sast_dast.py`/
`functional.py`/`performance.py` (clean); `npx tsc --noEmit -p .` from `frontend/` (clean); Documents and
outputs copies re-synced and confirmed identical via `diff -rq`.

## 84. Fix header/footer scrolling away -- app shell now pins them and scrolls content instead

**Why:** requested directly -- "make header and footer means application name, username logout fix
position." The sidebar's app-name header (`.brand` -- "QualityHub / Centralized QA Portal") and its
username/logout footer (`.sidebar-bottom`), plus the top `.topbar` (search box/status/+New button), were
scrolling away with the rest of the page on any screen with enough content to exceed the viewport height.
Root cause: `.app-shell` only set `min-height: 100vh` (not a fixed `height`), so once `.content` grew
taller than the viewport, the *entire page* -- including the sidebar -- grew and scrolled together via the
normal document/body scrollbar. `.sidebar` had no height of its own to clip against, so its nav's existing
`overflow-y: auto` never actually had a chance to engage; the whole sidebar just scrolled off along with
everything else.

**Fix:** converted the layout into a standard fixed app-shell -- `.app-shell` is now `height: 100vh;
overflow: hidden` (was `min-height`, no overflow control) so the page itself never scrolls. `.sidebar` and
`.main` are both pinned to that same `height: 100vh` with `overflow: hidden`. Inside `.sidebar`, `.brand`
(header) and `.sidebar-bottom` (footer, username/logout) both got `flex-shrink: 0` so they hold their
size, while `.sidebar nav` (the middle scrollable nav list) got `flex: 1; min-height: 0` added alongside
its existing `overflow-y: auto` -- `min-height: 0` is required here because a flex column child's default
min-height is `auto` ("at least as tall as my content"), which silently defeats `overflow-y: auto` unless
overridden. Inside `.main`, `.topbar` got `flex-shrink: 0` (stays fixed) and `.content` got the matching
`flex: 1; min-height: 0; overflow-y: auto` treatment -- `.content` is now the *only* element that actually
scrolls, everything else (brand/app name, nav, username+logout, topbar) stays fixed in the viewport
regardless of how tall a given page's content grows. `.modal-overlay` (`position: fixed; inset: 0`) was
confirmed unaffected -- it was already independent of page scroll, not nested inside `.content`.

**No schema change, no backend change.** **Verification:** `npx tsc --noEmit -p .` from `frontend/`
(clean; full `vite build` couldn't run in this sandbox due to a pre-existing, unrelated native-binary
platform mismatch -- `@rollup/rollup-linux-arm64-gnu` missing -- not something this change touched);
reviewed every touched selector for conflicting/duplicate rules elsewhere in `index.css` (none found);
`.modal-overlay`'s own `position: fixed` confirmed independent of this change; Documents and outputs
copies re-synced and confirmed identical via `diff -rq`.

## 85. Suppression / False Positive: linked SAST/DAST request must have reached Scanning

**Why:** requested directly -- the Suppression / False Positive request's SAST/DAST Request ID picker
should only offer (and only accept) requests whose status is `SCANNING` or later; a request still sitting
anywhere before that -- Draft, any approval-pending/returned/rejected stage, Security Lead Assigned,
Security Readiness, Returned by Security Lead, Planning, or Configuration -- must never appear as a
choice. A suppression/false-positive is a decision about a *finding*, and there's nothing to suppress
until a scan has actually produced findings, which can't happen before `SCANNING`.

**Fix:** added a new explicit `SAST_DAST_PRE_SCANNING_STATUSES` constant listing the 13 pre-scanning
statuses (`DRAFT, SUBMITTED, SM_APPROVAL_PENDING, RETURNED_BY_SM, SM_REJECTED,
DEPARTMENT_HEAD_APPROVAL_PENDING, RETURNED_BY_DEPARTMENT_HEAD, DEPARTMENT_HEAD_REJECTED,
SECURITY_LEAD_ASSIGNED, SECURITY_READINESS, RETURNED_BY_SECURITY_LEAD, PLANNING, CONFIGURATION`) to both
backend `constants.py` and frontend `constants.ts`, listed out explicitly rather than sliced by index off
`SAST_DAST_STATUSES` so it stays correct even if that list is ever reordered.

Backend (`routers/suppression.py`): `_require_linked_request` now takes the `db: Session` in addition to
the submitted `data`, loads the linked `SASTRequest`/`DASTRequest` row, and raises `400` if its `status`
is in `SAST_DAST_PRE_SCANNING_STATUSES` ("The linked {kind} request hasn't reached Scanning yet..."). Both
`create_suppression` and `update_suppression` call this updated helper, so a hand-crafted or stale request
against a pre-scanning SAST/DAST request is rejected server-side regardless of what the UI shows.

Frontend (`Suppression.tsx`, `NewSuppressionModal`): added a `hasReachedScanning(r)` check alongside the
existing `inScope(r)` department/requester scoping, applied to both the SAST and DAST arrays before they're
combined into `combinedRequests` -- so the Request ID autosuggest never lists a pre-scanning request in the
first place. (There's no separate Edit-Suppression modal in the frontend today -- `NewSuppressionModal` is
the only place this picker exists.)

**No schema change.** **Verification:** `python3 -m py_compile` on `constants.py`/`suppression.py`
(clean); `npx tsc --noEmit -p .` from `frontend/` (clean); Documents and outputs copies re-synced and
confirmed identical via `diff -rq`.

## 86. SAST/DAST: findings confirmation pop-up at Complete Scan/Rescan, and a real Closed step

**Why:** requested directly -- the SAST/DAST post-scan workflow wasn't actually walking through all of
its own defined statuses. Complete Scan (at `SCANNING`) unconditionally moved to `FINDING_VALIDATION`
with no pop-up asking whether findings were identified, and nothing anywhere ever transitioned a request
out of `REPORT_READY` into `CLOSED` -- `CLOSED` was defined in `SAST_DAST_STATUSES`/
`SAST_DAST_TERMINAL_STATUSES` but unreachable, so every SAST/DAST request's real terminal state was
`REPORT_READY`. The requested workflow: Complete Scan asks "Are you sure no security findings were
identified during the scan?" -- Yes walks `SECURITY_COMPLETE -> REPORT_READY -> CLOSED`; No moves to
`FINDING_VALIDATION` and switches the UI to the Findings tab so they can be logged, following
`FINDING_VALIDATION -> REMEDIATION -> ASSIGNED_TO_REQUESTER -> WAITING_FOR_FIX -> ASSIGNED_TO_LEAD ->
RESCAN`. After a rescan, the same pop-up repeats: no findings remain -> the same
`SECURITY_COMPLETE -> REPORT_READY -> CLOSED` chain; findings still exist -> back to the Findings tab to
repeat remediation/rescan.

**Fix:**

Backend (`routers/sast_dast.py`, shared by both SAST and DAST as before):

- New `_close_request(db, obj, current_user)`: `REPORT_READY -> CLOSED`, the lifecycle's actual terminal
  step -- previously unreachable.
- New `_auto_close_if_clean(db, obj, current_user, sup_filter_col)`: chains `_mark_report_ready` then
  `_close_request` in one call, used right after the confirmation pop-up confirms no findings. If
  `_mark_report_ready`'s existing suppression gate (any linked Suppression request not yet "Done") raises,
  the chain stops cleanly at `SECURITY_COMPLETE` (already committed) without propagating the error --
  the analyst finishes the remaining hop(s) manually via the existing Mark Report Ready button plus a new
  Close Request button once the suppression is resolved.
- `_complete_scan` now takes `no_findings: bool` (from the new `schemas.ScanCompletionIn` payload,
  `{no_findings, comments}`) and `sup_filter_col`: `True` sets `SECURITY_COMPLETE` and calls
  `_auto_close_if_clean`, skipping `FINDING_VALIDATION`/`REMEDIATION` entirely since the analyst has
  confirmed the scan was clean; `False` sets `FINDING_VALIDATION` as before.
- `_rescan_decision` now also takes `sup_filter_col`: `"Passed"` (no findings remain) sets
  `SECURITY_COMPLETE` and calls `_auto_close_if_clean`, same as a clean Complete Scan; `"Failed"` (findings
  still exist) now routes to `FINDING_VALIDATION` instead of back to `SCANNING` -- matches "return to the
  Findings tab and repeat the remediation and rescan workflow" rather than re-running the full
  Planning/Configuration/Scanning cycle.
- New `/api/sast-requests/{id}/close` and `/api/dast-requests/{id}/close` endpoints (Security Analyst
  role, `REPORT_READY` only) wired to `_close_request`, for the manual fallback above.
- `complete-scan`'s endpoint signature changed from no body to `payload: schemas.ScanCompletionIn` on
  both SAST and DAST -- this is a breaking change to that one endpoint's request shape (previously took no
  body at all).

Frontend (`SAST.tsx`/`DAST.tsx`, both mirrored identically as always):

- New shared `components/ConfirmModal.tsx` -- a small Yes/No dialog-variant `Modal` (`preventBackdropClose`
  so an accidental outside click can't silently pick "No" and lose the confirmation), reusable anywhere a
  Yes/No branch is needed (as opposed to `InfoModal`'s single-button acknowledgement).
- "Complete Scan" and the old separate "Rescan Passed"/"Rescan Failed" buttons now open this pop-up
  ("Rescan Decision" is a single button, replacing the two) instead of calling the API directly. Answering
  Yes calls `complete-scan`/`rescan-decision` with `no_findings: true` / `decision: 'Passed'`; answering No
  calls the same endpoint with the opposite value and then switches `tab` to `'findings'`, so the analyst
  lands straight on the Findings tab to log what was found, matching "the system should navigate to the
  Findings tab" from the request.
- New "Close Request" button at `REPORT_READY` (Security Analyst role) calling the new `/close` endpoint --
  the manual fallback for when `_auto_close_if_clean` stopped short on a pending suppression.

Both backend router-comment docstrings (top of `sast_dast.py`) and the `SAST_DAST_STATUSES` lifecycle
comment in `constants.py` were updated to describe the new branching flow instead of the old linear one.

**No schema change** (`CLOSED` was already a valid value in the existing `status` column -- this only
makes it reachable). **Verification:** `python3 -m py_compile` on `constants.py`/`schemas.py`/
`sast_dast.py` (clean); `npx tsc --noEmit -p .` from `frontend/` (clean); Documents and outputs copies
re-synced and confirmed identical via `diff -rq`.

## 87. SAST/DAST: Security Complete also blocked while a suppression is pending, not just Report Ready

**Why:** requested directly -- Report Ready was already blocked while any linked Suppression / False
Positive request wasn't yet "Done" (see `_mark_report_ready`), but that gate only fired one step later.
A request could still be marked Security Complete with an outstanding suppression sitting against it,
which reads as "security review finished" while a finding's disposition is still an open decision.
Confirmed with the user that the rule should match Report Ready's existing definition of "pending" --
blocked only while a suppression is not yet Done, not permanently blocked if one was ever raised (once
every linked suppression reaches Done, Security Complete becomes reachable again same as before).

**Fix:** in `routers/sast_dast.py`, factored the suppression lookup out of `_mark_report_ready` into two
shared helpers: `_pending_suppression_ids(db, obj, sup_filter_col)` (the query itself) and
`_require_no_pending_suppressions(db, obj, sup_filter_col, action)` (raises 400 with the pending
suppression IDs if any exist, `action` naming whichever checkpoint is being blocked in the message).
`_mark_report_ready` now calls the shared helper instead of inlining the check. The same helper is now
also called immediately before every place that sets `obj.status = "SECURITY_COMPLETE"`:

- `_complete_scan`'s `no_findings=True` branch (Complete Scan confirmed clean).
- `_validate_findings`'s no-open-findings branch (Finding Validation resolves clean after all).
- `_rescan_decision`'s `"Passed"` branch (Rescan confirmed clean).

All three already had `sup_filter_col` threaded through from section 86's work (or gained it here, for
`_validate_findings` -- its two endpoints now pass `models.SuppressionRequest.sast_request_id`/
`dast_request_id` the same way the others do). If blocked, the request stays at its current status
(`SCANNING`/`FINDING_VALIDATION`/`RESCAN` respectively) and the analyst sees the same "suppression
request(s) still pending" message already used at Report Ready, just naming "Security Complete" instead.
No new frontend UI was added -- the existing `ErrorText` display on the Workflow Actions panel already
surfaces this the same way it does every other backend validation error in this app.

**No schema change.** **Verification:** `python3 -m py_compile` on `constants.py`/`schemas.py`/
`sast_dast.py` (clean); no frontend files touched, so the last `npx tsc --noEmit -p .` run (section 86)
still applies; Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 88. Fix: Add Finding button vanished after Complete Scan answered "findings identified"

**Why:** bug report -- selecting "No, findings identified" on the Complete Scan confirmation pop-up (see
section 86) correctly moves the request to `FINDING_VALIDATION` and switches to the Findings tab, but the
Add Finding form itself disappeared. `canAddFinding` in `SAST.tsx`/`DAST.tsx` was still gated to
`status === 'SCANNING'` only -- a leftover from before section 86, when Complete Scan unconditionally
landed on `FINDING_VALIDATION` and findings were expected to already be logged during `SCANNING` itself.
Now that "findings identified" moves the status *out* of `SCANNING` before the analyst has had a chance
to log anything, the form vanished right when it was needed.

**Fix:** `canAddFinding` now also allows `FINDING_VALIDATION`: `hasRole(user, 'SECURITY_ANALYST') &&
['SCANNING', 'FINDING_VALIDATION'].includes(status)`. The other half of the request -- findings must stay
blocked when "Yes, no findings" is answered -- already holds with no extra change needed: that path skips
straight past `FINDING_VALIDATION` to `SECURITY_COMPLETE` (see `_complete_scan`'s `no_findings=True`
branch from section 86), so the status is never one `canAddFinding` matches once that's confirmed. The
backend's own `add_sast_finding`/`add_dast_finding` endpoints were already unrestricted by status (no
`_require` call in `_add_finding`), so this was purely a frontend gating bug -- no backend change needed.

**No schema change, no backend change.** **Verification:** `npx tsc --noEmit -p .` from `frontend/`
(clean); Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 89. Suppression Overview now shows the SAST/DAST Request ID it was raised against

**Why:** requested directly -- the Suppression detail view's Overview tab showed "Scan Type: SAST" but
never the actual SAST/DAST Request ID (e.g. "SAST-20260730-93A71B") the suppression was raised against,
even though that's exactly the traceability link the whole feature exists for. The PDF export
(`export_suppression`) already included it via `obj.sast_request.request_id`/`obj.dast_request.request_id`
-- only the in-app Overview tab (and the list table) were missing it.

**Fix:** `models.SuppressionRequest` gained a `linked_request` property returning whichever of its
existing `sast_request`/`dast_request` relationships is actually set (mirrors the `qa_request` pattern
already used on SAST/DAST/Functional/Performance to show *their* linked parent). `schemas.SuppressionOut`
exposes it as `linked_request: Optional[LinkedRequestRef] = None` -- the same minimal cross-reference
schema (`id`/`request_id`/`status`/`priority`/`risk_category`) already used everywhere else in the app for
this exact "show the other side of a link" need, so FastAPI's `from_attributes` picks it up automatically
with no router code changes. Frontend `types.ts`'s `SuppressionOut` mirrors the new field.
`Suppression.tsx`'s Overview tab now shows a `"{scan_type} Request ID:"` row rendering
`sup.linked_request?.request_id`, and the list table gained a matching "Linked Request" column (filterable,
same as every other column there) -- both fall back to "—" for the pre-existing legacy suppressions raised
before a SAST/DAST link was required (see section 183's Scanning+ eligibility fix, which only applies
going forward).

**No schema change** (`sast_request_id`/`dast_request_id` columns already existed -- this only exposes the
relationship they already had). **Verification:** `python3 -m py_compile` on `models.py`/`schemas.py`
(clean); `npx tsc --noEmit -p .` from `frontend/` (clean); Documents and outputs copies re-synced and
confirmed identical via `diff -rq`.

## 90. Suppression Request ID picker also excludes SAST/DAST requests that already reached Security Complete

**Why:** requested directly -- once a SAST/DAST request has been marked Security Complete (declaring its
security review finished with no more open findings), it shouldn't be possible to raise a *new*
suppression against it -- symmetric with section 87's rule blocking a request from reaching Security
Complete while a suppression is still pending. Confirmed with the user that "completed" means Security
Complete onward (`SECURITY_COMPLETE`, `REPORT_READY`, `CLOSED`) -- together with the existing
Scanning-or-later floor from section 85, this narrows the eligible linking window to Scanning through the
stage right before Security Complete. (The DAST side of the Overview Request ID display added in section
89 was also re-checked while making this change -- `Suppression.tsx` has one shared detail component for
both scan types with no SAST-specific branching, and `models.SuppressionRequest.linked_request` resolves
`dast_request` the same way it resolves `sast_request`, so it was already rendering correctly for DAST;
no separate fix was needed there.)

**Fix:** new `SAST_DAST_COMPLETED_STATUSES = ["SECURITY_COMPLETE", "REPORT_READY", "CLOSED"]` added to both
backend `constants.py` and frontend `constants.ts`, mirroring `SAST_DAST_PRE_SCANNING_STATUSES`'s existing
"explicit list, not an index slice" style. Backend `routers/suppression.py`'s `_require_linked_request`
gained a second status check alongside the existing pre-scanning one, rejecting a link to a SAST/DAST
request already in `SAST_DAST_COMPLETED_STATUSES` with a 400 explaining the security review is already
complete. Frontend `Suppression.tsx`'s `NewSuppressionModal` gained a matching `isNotYetCompleted(r)`
filter, chained onto the existing `inScope`/`hasReachedScanning` filters for both the SAST and DAST arrays
before they're combined into `combinedRequests` -- so a completed request never appears in the picker for
either scan type.

**No schema change.** **Verification:** `python3 -m py_compile` on `constants.py`/`suppression.py`
(clean); `npx tsc --noEmit -p .` from `frontend/` (clean); Documents and outputs copies re-synced and
confirmed identical via `diff -rq`.

## 91. SAST/DAST Overview: "Suppression Requested? Yes/No" + Suppression ID(s)

**Why:** requested directly, for clear reporting/visibility -- a SAST/DAST request's own detail window
had no indication of whether a Suppression / False Positive request had ever been raised against it, or
which one. This is the reverse direction of section 89 (which showed the SAST/DAST id *on* the Suppression
view) -- this adds the same relationship visible from the SAST/DAST side.

**Fix:** `models.SASTRequest`/`models.DASTRequest` each gained a `suppressions` relationship
(`back_populates` wired up against the existing `SuppressionRequest.sast_request`/`dast_request`
relationships, which previously had no back-reference). New minimal schema `LinkedSuppressionRef` (`id`,
`suppression_id`, `status`) -- the reverse-direction counterpart to the existing `LinkedRequestRef` --
exposed as `suppressions: List[LinkedSuppressionRef] = []` on both `SASTOut` and `DASTOut`; picked up
automatically via `from_attributes` with no router code changes (SAST's plain `response_model` conversion
and DAST's `_dast_out` both already build off the live ORM row). Frontend `types.ts` mirrors both
interfaces, adding a new shared `LinkedSuppressionRef` type. `SAST.tsx`/`DAST.tsx`'s Overview "Status"
section gained two fields right after Priority/Risk Category: "Suppression Requested?" (Yes if
`req.suppressions.length > 0`, else No), and "Suppression ID" (comma-separated list of every linked
`suppression_id`) -- shown only when the answer is Yes, per the request.

**No schema change** (`sast_request_id`/`dast_request_id` already existed on `SuppressionRequest` -- this
only exposes the relationship the other direction). **Verification:** `python3 -m py_compile` on
`models.py`/`schemas.py`/`sast_dast.py`/`suppression.py` (clean); `npx tsc --noEmit -p .` from `frontend/`
(clean); Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 92. Functional QA: renamed its "Checklist" tab to "Functional Details"

**Why:** requested directly (clarified via follow-up question, since the original wording didn't match
any existing element) -- the Functional QA request's readiness-checklist tab was just labeled "Checklist"
like every other module's own tab. Renamed to "Functional Details" per the request.

**Fix:** `Functional.tsx`'s tab bar renders its label conditionally now -- `t === 'checklist' ?
'Functional Details' : t[0].toUpperCase() + t.slice(1)` -- so only the *displayed* label changed. The tab
key itself stays `'checklist'` internally (unchanged), since that's what drives `tab === 'checklist'`'s
content block, the `/api/functional-requests/{id}/checklist` route, and everything else already wired to
it -- a pure display-string change with zero behavioral risk.

**No schema change, no backend change.** **Verification:** `npx tsc --noEmit -p .` from `frontend/`
(clean); Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 93. Correction to section 92 -- reverted, and the real fix: no separate Readiness Checklist wizard step for Functional QA

**Why:** section 92 was a misread of the original (typo-heavy) request -- it targeted `Functional.tsx`'s
detail-view tab, but the actual ask was about the QA Request wizard: raising a request currently shows
Functional Testing's own "Ready for Testing" readiness checklist as its own separate wizard step
(`buildSteps.ts`'s `{ key: 'checklist', label: 'Readiness Checklist' }`, rendered via `ChecklistStep.tsx`),
while SAST and DAST already fold their own Security Readiness checklist directly into their own step
(`SastStep.tsx`/`DastStep.tsx`) instead of a separate one -- "same behaviour like sast dast and other."
Confirmed directly: no separate step/tab at all: the checklist belongs inside the "Functional QA
Classification" step.

**Fix:** section 92's tab-label change in `Functional.tsx` (the request detail view, unrelated to the
wizard) was reverted back to plain "Checklist" -- untouched otherwise, no other part of section 92 was a
mistake, just the wrong target entirely.

The real fix is in the QA Request wizard (`QARequests/`):
- `steps/FunctionalStep.tsx` now renders the "Readiness Checklist — Self-Declaration" section (item list,
  checkboxes, `toggleChecked`) directly underneath its existing Priority/Risk Rating fields -- the same
  content `ChecklistStep.tsx` used to render on its own separate step, now folded in here instead, mirroring
  exactly how `SastStep.tsx` already combines its own Priority/Risk/Repository Details with its Security
  Readiness Checklist self-declaration in one step.
- `buildSteps.ts` no longer pushes a separate `{ key: 'checklist', ... }` step for Functional-bucket
  request types -- the `'functional'` step is now the only one added for them.
- `NewRequestModal.tsx` dropped its `ChecklistStep` import and the `step.key === 'checklist'` render line.
- `steps/ChecklistStep.tsx` deleted -- no longer referenced anywhere (confirmed via full-repo grep before
  removing).

No change to `form.checked_items`, the payload shape sent to `POST/PUT /api/qa-requests`, or any backend
code -- this is purely a wizard-step-layout change (fewer steps, same fields collected).

**No schema change, no backend change.** **Verification:** `npx tsc --noEmit -p .` from `frontend/`
(clean); grepped the repo to confirm `ChecklistStep`/the `'checklist'` step key have no remaining
references before deleting the file; Documents and outputs copies re-synced and confirmed identical via
`diff -rq`.

## 94. Fixed `AttributeError: module 'datetime' has no attribute 'utcnow'` across the backend

**Why:** reported directly via a traceback at login (`app/auth.py`'s `create_access_token`, the line
computing the JWT's `exp` claim). Every file in `app/` imports the module with plain `import datetime`
(not `from datetime import datetime`), so `datetime` inside those files refers to the *module*, not the
`datetime.datetime` class. `datetime.utcnow()` is a classmethod on `datetime.datetime`, so calling it as
`datetime.utcnow()` against the module raises `AttributeError`. The same lines' `datetime.timedelta(...)`
calls were never affected -- `timedelta` is a class defined directly in the module, so that half of the
same import style already worked. This bug was latent everywhere a timestamp gets generated (row
defaults, ID generation, JWT expiry) but had gone unnoticed until a path calling `create_access_token`
(login) actually ran.

**Fix:** mechanical find/replace of every `datetime.utcnow()` call to `datetime.datetime.utcnow()`,
leaving the `import datetime` statements and every `datetime.timedelta(...)`/`datetime.date`/
`datetime.datetime` type-annotation usage untouched, across: `app/models.py` (`now()`/`gen_id()` helpers),
`app/auth.py` (`create_access_token`'s `exp` claim -- the exact reported line), and the routers
`qa_requests.py`, `performance.py`, `signoff.py`, `functional.py`, `sast_dast.py`, `applications.py`,
`dashboard.py`, `suppression.py`, `export.py` (25 call sites total across 11 files). `app/schemas.py`
already used `datetime.datetime`/`datetime.date` correctly as Pydantic type annotations and needed no
change.

Also found an orphaned top-level `backend/auth.py` (not `app/auth.py`) with the identical bug pattern --
confirmed via repo-wide grep that nothing imports it (`app/deps.py` and `app/seed.py` both import from
`app/auth.py` via `.auth`), so it's dead code and was left as-is rather than edited.

**No schema change, no behavioral change** (the computed timestamps are identical to what was always
intended -- this only fixes the crash preventing them from being computed at all). **Verification:**
`python3 -m py_compile` on all 11 touched files (clean); repo-wide grep confirmed zero remaining
`datetime.utcnow()` call sites outside of `datetime.datetime.utcnow()`; Documents and outputs copies
re-synced via the standard rsync/diff check -- the only reported difference was `app/auth.py` itself,
which is expected and intentional since it's on the sync exclude list (edited directly in Documents per
the reported bug, per the established convention of never overwriting excluded files during sync).

## 95. Fixed `/api/dashboard/3w` 500 error -- missing `ZoneInfo` import + stray extra `()` call

**Why:** reported directly as "internal server error" on `GET /api/dashboard/3w`. Two independent,
pre-existing bugs in `dashboard.py`'s `_age_days(dt)` helper (called for every item on that dashboard):
the function referenced `ZoneInfo(...)` but the file never imported it (`NameError: name 'ZoneInfo' is
not defined`), and even past that, the expression had a stray `()` sitting between the `.astimezone(...)`
chain and the subtraction -- i.e. `...astimezone(ZoneInfo("Asia/Kolkata"))() - dt` -- which calls the
resulting `datetime` object like a function (`TypeError: 'datetime.datetime' object is not callable`).
While fixing this, the same stray-`()` pattern was found copy-pasted into the "generated_at" timestamp
used by every PDF report footer: `suppression.py`, `sast_dast.py`, `functional.py`, `performance.py`, and
`export.py` all had `...astimezone(ZoneInfo("Asia/Kolkata"))\n().strftime(...)` -- same bug, would have
thrown the same `TypeError` the first time any of those PDFs was exported. `export.py` was also missing
the `ZoneInfo` import outright.

**Fix:** added `from zoneinfo import ZoneInfo` to `dashboard.py` and `export.py` (the other four already
had it). Removed the stray `()` in all six spots, joining the expression back into one call chain --
`dashboard.py`'s `_age_days` now computes `now = datetime.datetime.utcnow().replace(...).astimezone(...)`
then returns `(now - dt).days`; the five PDF-export "generated_at" lines now read
`...astimezone(ZoneInfo("Asia/Kolkata")).strftime(...)` directly, no line break, no extra call.

**No schema change, no behavioral change** (same IST timestamp that was always intended -- this only
fixes the crash preventing it from being computed). **Verification:** `python3 -m py_compile` on all 6
touched files (clean); repo-wide grep confirmed no remaining stray leading-`()` lines or files using
`ZoneInfo` without importing it; Documents and outputs re-synced, only the expected (excluded)
`app/auth.py` difference reported.

## 96. Fixed `/api/dashboard/3w` 500 -- "can't subtract offset-naive and offset-aware datetimes"

**Why:** the user re-tested after section 95 and got a new (real, server-reproduced) traceback from the
same `_age_days` helper: `TypeError: can't subtract offset-naive and offset-aware datetimes` at
`return (now - dt).days`. Root cause: `created_at`/`updated_at` are plain `Column(DateTime)` (no
`timezone=True`) on every request model, so Oracle round-trips them as naive `datetime` objects even
though `models.now()` computes them as tz-aware IST at write time -- the tzinfo is silently dropped on
the way into/out of the non-timezone-aware column. Section 95's fix computed `now` as tz-*aware* IST but
still subtracted it directly against the naive `dt` coming out of the DB, which Python's `datetime`
refuses to do.

**Fix:** `_age_days` now checks `dt.tzinfo is None` and, if so, attaches `ZoneInfo("Asia/Kolkata")`
directly via `.replace(tzinfo=...)` (no UTC conversion -- the naive value already represents IST
wall-clock time, exactly what it was before Oracle stripped the zone) before subtracting against the
tz-aware `now`. This mirrors the existing `isinstance(dt, datetime.date)` branch just above it, which
already anticipated dt arriving in a different shape than expected.

**No schema change** (the DateTime columns stay `timezone`-naive by design; this fixes the comparison
logic to match how they're actually stored, rather than changing storage). **Verification:** reproduced
against the live app (the user's own uvicorn/Oracle instance) -- confirmed the exact traceback pointed at
this line; added a standalone script exercising `_age_days` with a naive datetime, a plain `date`, and
`None` (matches the three branches) -- all return the expected day counts with no exception;
`python3 -m py_compile app/routers/dashboard.py` clean; Documents/outputs re-synced, only the expected
(excluded) `app/auth.py` difference reported.

## 97. Redesigned the "Assign QA Lead / Security Lead / Engineer" control -- own labeled row instead of buried in the button row

**Why:** reported directly with a screenshot -- the Department Head decision step's "Assign QA Lead"
searchable picker (`components/UserAssignSelect.tsx`) sat inline inside the same wrapping flex row as
Export PDF / Edit Details / Sign / Approve / Return to Requester / Reject (see
`ApprovalDecisionButtons`'s `extraControl` prop in `components/Common.tsx`). On a typical detail-drawer
width that row wraps awkwardly, and the picker's own search popover opened right on top of/below the
neighbouring buttons -- a required "pick someone before you can approve" step reading as just another
crowded button instead of its own action.

**Fix:** `ApprovalDecisionButtons` now renders `extraControl` (when present) inside a `.approval-assign-row`
div with `width: 100%`, which forces it onto its own full-width line within the parent's flex-wrap row --
Export PDF/Edit Details stay on the row above it, Sign/Approve/Return/Reject flow onto the row below it,
and the picker's popover now has a predictable, uncluttered spot to open into. Added a new
`extraControlLabel?: string` prop so the row carries a proper caption instead of being an unlabeled
dropdown; wired it at all four call sites: Functional ("Assign QA Lead"), SAST/DAST ("Assign Security
Lead"), Performance ("Assign Engineer"). Widened each `UserAssignSelect`'s `minWidth` from 220 to 260 now
that it isn't competing for space with five other buttons on the same line. New `.approval-assign-row`
CSS in `index.css` gives it a shaded `--navy-50` background + border + label styling, consistent with
`.actions-panel`'s existing "give the actionable area its own surface" pattern.

**No schema/backend change** (`UserAssignSelect` and the decision endpoints themselves are untouched --
this only changes where/how the picker is laid out on screen). **Verification:** `npx tsc --noEmit -p .`
from `frontend/` (clean); Documents and outputs re-synced, only the expected (excluded) `app/auth.py`
difference reported.

## 98. Replaced the inline "Assign QA Lead / Security Lead / Engineer" row with a proper confirmation modal

**Why:** section 97's inline `.approval-assign-row` fix (own labeled row above Sign/Approve/Return/Reject)
still overlapped -- reported again with a screenshot showing the picker's search popover (`position:
fixed`, opens below its trigger without pushing anything else down) visually covering the Sign field,
Return to Requester/Reject buttons, and the Comments box underneath, and the visible part of the option
list cut short ("lower options are missing"). Any inline layout has the same structural problem: the
popover floats independently of document flow, so whatever sits below the trigger in the same panel is
always at risk of being covered. Requested directly: rework this as a pop-up instead, or redo the whole
panel.

**Fix:** `ApprovalDecisionButtons` (`components/Common.tsx`) no longer renders `extraControl` inline at
all. Clicking "Approve" on a step that has one (still gated on having signed first, same as before) now
opens a small `Modal` (`variant="dialog"`, `preventBackdropClose`) titled e.g. "Assign QA Lead & Approve",
containing just the picker (full width, `extraControlLabel` as its caption) and a "Confirm Approve"
button that stays disabled until `extraReady`, plus Cancel. Being a dedicated overlay with its own
stacking context, there's nothing behind it for the search popover to collide with -- the picker has the
entire 640px-wide dialog to itself. Return/Reject/Sign stay in the main action row exactly as before
(unaffected -- they never needed the picker). Removed the now-unused `.approval-assign-row` CSS from
`index.css`; widened each `UserAssignSelect` to `width: '100%'` at all four call sites (Functional/SAST/
DAST/Performance) now that it fills the modal rather than competing for space with buttons.

**No schema/backend change** (`onApprove`'s payload and the decision endpoints are untouched -- this only
moves *when* the picker is visible and *where* it renders). **Verification:** `npx tsc --noEmit -p .` from
`frontend/` (clean); Documents and outputs re-synced, only the expected (excluded) `app/auth.py`
difference reported.

## 99. "Require Department Head re-approval on return" -- checkbox replaced with a confirmation pop-up

**Why:** requested directly, with a screenshot of Functional QA's "Readiness Passed / Readiness Failed"
row -- the "Require Department Head re-approval on return" checkbox sat permanently visible next to the
Failed button across five near-identical copy-pasted blocks (Functional/SAST/DAST/Performance's
`readiness-decision`, and Suppression's `security-team-decision` "Return to Requester"). Being just
another always-on control in the row, it was easy to forget to tick before clicking Failed/Returned.

**Fix:** all five now ask at the moment of the decision instead of relying on a pre-set checkbox.
Clicking "Readiness Failed" (or, in Suppression, "Return to Requester") opens `components/ConfirmModal.tsx`
(already used for SAST/DAST's scan-complete flow) with the question "Require Department Head re-approval
when this request is returned to the requester?" -- "Yes, require re-approval" submits the decision with
`require_dept_head_reapproval: true`; "No, skip re-approval" submits it with `false`. Both options submit
the underlying decision (Failed/Returned) -- this pop-up only decides the flag, matching exactly what the
checkbox used to control, just asked explicitly instead of silently defaulting to unchecked. Replaced each
file's `requireDeptHeadReapproval`/`setRequireDeptHeadReapproval` state (now unused everywhere -- confirmed
via repo-wide grep) with a `showReapprovalConfirm` boolean gating the modal. Added the `ConfirmModal`
import to `Functional.tsx`, `Performance.tsx`, and `Suppression.tsx` (SAST/DAST already had it).

**No schema/backend change** (`require_dept_head_reapproval` is sent with the exact same shape/values as
before -- only how the value is chosen changed). **Verification:** `npx tsc --noEmit -p .` from
`frontend/` (clean); repo-wide grep confirms no remaining references to the old checkbox state; Documents
and outputs re-synced, only the expected (excluded) `app/auth.py` difference reported.

## 100. Redesigned "Assign Tester(s)" -- native `<select multiple>` replaced with a searchable chip picker

**Why:** reported directly with a screenshot -- "Assign Tester(s)" (Functional QA's Planning step) used a
bare native `<select multiple>`, which renders as a tall, unstyled listbox with no search and a
ctrl/cmd-click-to-multi-select interaction most people don't discover on their own. Called out as "too
much basic UI" needing a modern revamp, consistent with the searchable single-picker
(`UserAssignSelect.tsx`) already used everywhere else in the app for lead/engineer assignment.

**Fix:** new `components/MultiUserAssignSelect.tsx` -- a multi-value sibling of `UserAssignSelect`, same
searchable dropdown-panel mechanics (fixed-position panel anchored to the trigger, click-away to close,
follows the trigger on scroll/resize), but the trigger itself renders each already-picked tester as a
removable pill/chip (name + an "x" button) instead of a single label, and the dropdown list marks already-
selected names with a checkmark rather than hiding them -- so picking several testers is just repeated
clicks without the panel closing in between, and removing one is a single click on its chip's "x" without
reopening the dropdown at all. Wired into `Functional.tsx`'s `canAssignTester` block in place of the old
`<select multiple>`; `selectedTesters`/`setSelectedTesters` state and the "Assign Tester(s)" button/
`act('assign-tester', ...)` call are unchanged. New `.multi-user-select*`/`.multi-user-chip*`/
`.multi-user-checkbox` CSS in `index.css`, reusing the existing `.searchable-select-panel` family for the
dropdown itself so it looks consistent with every other picker in the app.

**No schema/backend change** (`tester_ids` is still sent as the same array of numeric IDs -- only the
picker UI changed). **Verification:** `npx tsc --noEmit -p .` from `frontend/` (clean); Documents and
outputs re-synced, only the expected (excluded) `app/auth.py` difference reported.

## 101. Fixed searchable dropdowns rendering off-screen near the bottom of the viewport

**Why:** reported directly with a screenshot -- opening the new "Assign Tester(s)" picker (section 100)
showed only the search box, no option list beneath it, "nothing is visible". Root cause: every searchable
dropdown in the app (`UserAssignSelect`, the new `MultiUserAssignSelect`, and the generic
`SearchableSelect` used for the Department picker and Suppression's Request ID search) always opened
downward -- `top: rect.bottom + 4` -- computed once from the trigger's on-screen position with no regard
for how much room was actually left below it. The "Assign Tester(s)" trigger in that screenshot sat near
the bottom of the browser window, so the option list rendered mostly or entirely below the visible
viewport; being `position: fixed`, page scrolling can't bring it into view either, so it just looked
empty/broken even though it had opened correctly.

**Fix:** new shared helper `components/panelPosition.ts` (`computePanelPos(rect, minWidth?)`) -- compares
space below vs. above the trigger against a rough estimate of the panel's own height (search box + option
list, ~280px) and flips the panel to open *upward* (anchored to the trigger's top edge instead of its
bottom) whenever there isn't enough room below but there's more room above. Returns both `top` and
`bottom` (one a pixel offset, the other the literal string `'auto'`) so the caller's inline style always
explicitly cancels whichever edge isn't being used, rather than leaving `.searchable-select-panel-fixed`'s
CSS `top: 0` default fighting with a newly-set `bottom`. All three components (`UserAssignSelect.tsx`,
`MultiUserAssignSelect.tsx`, `SearchableSelect.tsx`) now call this same helper in both `toggleOpen` and
their scroll/resize `reposition` handler, instead of each computing `top: rect.bottom + 4` inline.

**No schema/backend change** (pure client-side positioning logic). **Verification:** `npx tsc --noEmit -p .`
from `frontend/` (clean); repo-wide grep confirms all three components now route through the same
`computePanelPos` helper with no leftover inline `rect.bottom + 4` computations; Documents and outputs
re-synced, only the expected (excluded) `app/auth.py` difference reported.

## 102. Dashboard clarity pass -- every metric now explains what it counts, in plain English, on screen

**Why:** reported directly -- "what is Active Project, What is pending Approval, What is Active requests /
Aging distribution 16 pending how is calculating?" The four Dashboard "At a Glance" cards and the
Ageing Distribution donut each use a genuinely different scope under the hood: Active Projects counts
*distinct project epics* with a Functional Testing request in an in-flight `QAStatus` (see
`ACTIVE_QA_STATUSES` in `dashboard.py`); Pending Approvals counts Functional requests sitting at an
approval-gate status plus SAST/DAST requests at their own gate statuses plus every open Suppression
request; Active Requests (org-wide) counts *individual requests* of any type (QA/Functional/SAST/DAST/
Performance) not yet Closed/Cancelled (computed client-side in `Dashboard.tsx`'s `isActiveRequest`); and
the Ageing Distribution donut's total is `/api/dashboard/3w`'s `total_pending` -- yet another set (every
Functional/SAST/DAST/Suppression request not in a terminal status), grouped by `_age_days()`/
`_ageing_bucket()` into 0-3/4-7/8-15/16-30/30+ day buckets. None of these four numbers are supposed to
match each other, but nothing on screen said so -- a person had to ask (as happened here) rather than
being able to tell from the dashboard itself.

**Fix:** added a `hint` prop to `StatCard` (`Dashboard.tsx`) and `MetricCard` (`components/Common.tsx`) --
one always-visible, plain-English line under the label explaining exactly what's counted (not a hover-only
tooltip, since the ask was for the dashboard to be "self portrayed"). Wired hints onto: all 4 Command
Centre "At a Glance" cards; SAST/DAST's request-count and open-vulnerability cards; Suppression's open/
critical-exception cards; and 3W's "Total Pending Items" card. Added a one-line note directly above the
"At a Glance" grid stating outright that these four numbers use different scopes and aren't meant to
reconcile. Expanded the "Project Visibility & Governance" card's subtitle, the "Pending by Team" subpanel
caption (now states the SLA day-bands: 0-7 within, 8-15 near, 16+ breached), the "Ageing Distribution"
subpanel caption, and the standalone "Ageing" tab caption to all explicitly name the same
Functional+SAST+DAST+Suppression, non-terminal-status scope and the total item count, so the donut's
"pending" is self-explanatory wherever it appears. New `.stat-card .hint`/`.metric-card .hint` CSS
(muted, 11.5px, matches the existing `.footline` treatment).

**No calculation/schema/backend change whatsoever** -- every number is computed exactly as before; this is
purely explanatory copy added around the existing values. **Verification:** `npx tsc --noEmit -p .` from
`frontend/` (clean); Documents and outputs re-synced, only the expected (excluded) `app/auth.py`
difference reported.

## 103. Fixed topbar "Search projects, requests or IDs" -- only worked for QA Request IDs

**Why:** reported directly ("search project, request id not working"). `Layout.tsx`'s `submitSearch`
always navigated to `/qa-requests?search=...` regardless of what was typed -- but that endpoint's
`search` param (see `routers/qa_requests.py`) only matches the QA Request gateway's own `request_id`/
`application_name`/`epic_number`. Every other module generates its own distinctly-prefixed ID
(`models.py`'s `gen_id` calls: `TQA-FUNC-...`, `SAST-...`, `DAST-...`, `PERF-...`, `SUP-...`,
`QA-CERT-...`), so typing any of those into the topbar box landed on an empty/irrelevant QA Requests list
every time -- the search box only ever "worked" for a `TQA-REQ-...` ID or an application name/epic number
that happened to match the gateway.

**Fix:** `submitSearch` now upper-cases the typed term and checks it against a small ordered prefix table
(`ID_PREFIX_ROUTES`: `TQA-FUNC`→`/functional-requests`, `SAST`→`/sast`, `DAST`→`/dast`, `PERF`→
`/performance`, `SUP`→`/suppression`, `QA-CERT`→`/signoff`). A match deep-links straight to that module
with `?open=<the typed id>`, reusing the same "open this exact request's detail drawer" pattern
Functional/SAST/DAST/Performance already supported (originally built for the Linked Requests table's
cross-module navigation, section 179). Anything that doesn't match a known prefix -- a `TQA-REQ-...` ID
itself, or free-text application name/epic number -- still falls through to the QA Request gateway search
exactly as before.

Suppression and Sign-off didn't have `?open=` support at all (only Functional/SAST/DAST/Performance did),
so it was added to both: `Suppression.tsx` matches on `suppression_id`, `SignOff.tsx` on `certificate_id`,
both wired via the same `useSearchParams`-based effect (find the row, select it, strip the query param)
as the other four modules.

**No schema/backend change** (`?open=` matches against data these pages already fetch; no new API calls).
**Verification:** `npx tsc --noEmit -p .` from `frontend/` (clean); Documents and outputs re-synced, only
the expected (excluded) `app/auth.py` difference reported.

## 104. Fixed Change Request ID / Epic Number format validation not actually blocking Next/Submit

**Why:** reported directly -- "there are field validation, but... error also allowing user to submit."
`QARequests/steps/DetailsStep.tsx` showed an inline "Invalid format. Example: CR-1234"/"...EPIC-1234"
message under Change Request ID(s)/Epic Number on blur, using its own local `crError`/`epicError`
component state and regexes (`/^[A-Z]{2,4}-[0-9]{1,4}$/`, `/^[A-Z]{2,4}-[0-9]{1,6}$/`). But
`NewRequestModal.tsx`'s `goNext`/`submit` only ever called `validation.ts`'s `detailsStepError()`, which
checked that the fields were non-empty and nothing else -- it never looked at that format regex or the
local error state at all. So a value that visibly failed validation on screen still advanced the wizard
and still got submitted to the backend.

**Fix:** moved the two regexes into `validation.ts` as exported constants (`CR_NUMBER_REGEX`,
`EPIC_NUMBER_REGEX`) and added the actual format check to `detailsStepError()` itself, right after the
existing required-field check -- the same single gate `goNext`/`submit` already call, so it's now
enforced everywhere that function is (advancing past the Details step, and the final pre-submit safety
net for a step the wizard has since navigated away from). `DetailsStep.tsx`'s `onBlur` handlers now import
and reuse those same two constants instead of keeping their own separate copies, so the on-screen inline
message and the actual gate can never silently drift out of sync again.

Audited every other Edit Details modal (Functional/SAST/DAST/Performance) for the same "shows an error but
still lets you submit" pattern -- none of them run any format validation on Change Request ID/Epic Number
at all (they're plain admin-only-editable text inputs with no error state), so this bug was unique to the
wizard's own Details step; nothing else needed changing.

**No schema/backend change** (the backend never validated this format either way -- purely a frontend
gating fix). **Verification:** `npx tsc --noEmit -p .` from `frontend/` (clean); ran both regexes against
sample valid/invalid values in isolation to confirm the expected pass/fail; repo-wide grep confirmed no
other component has its own duplicate copy of this validation; Documents and outputs re-synced, only the
expected (excluded) `app/auth.py` difference reported.

## 105. Documents could be uploaded but never deleted -- added delete support everywhere

**Why:** reported directly -- "while uploading document system should allow user to delete document if
any mistake happen." Every upload endpoint (both document systems -- see below) only ever supported
list/upload/download; once a file landed on a request there was no way to remove it, even if the wrong
file had been picked by mistake.

**Fix -- backend:** added `documents.py::can_delete_document(doc, user)` -- `True` for an Admin or
whoever's own `uploaded_by_id` matches the acting user, and nothing else. Deliberately narrower than the
existing upload permission (`_can_upload_documents`, section 171-178), which also lets the request's
*current* stage owner (SM, Department Head, assigned Lead/tester/Engineer) upload -- letting a reviewer
delete evidence someone *else* attached would be a different, more dangerous feature than "let me undo my
own mistake," so delete stays scoped to the uploader (or an admin) only. Paired with
`documents.py::delete_document(db, doc)` (removes the file from disk, then the DB row), and a new
`DELETE /{req_id}/documents/{doc_id}` endpoint added to every one of the six routers that share this table
(`functional.py`, `sast_dast.py` -- both SAST and DAST, `performance.py`, `suppression.py`, `signoff.py`),
all following the identical guard-then-delete shape.

The QA Request gateway keeps its own separate, older document system (`models.QARequestDocument`, its own
`UPLOAD_ROOT/<request_id>/<filename>` layout predating `documents.py` -- see section header note in
`documents.py`), so it got its own `DELETE /{req_id}/documents/{doc_id}` in `qa_requests.py` that reuses
`can_delete_document()` for the permission check only (that function is duck-typed, just needs
`.uploaded_by_id`) but does its own file removal/DB delete inline, since its storage path layout doesn't
match `documents.py`'s `full_path()`.

**Fix -- frontend:** added a "Delete" button next to "Download" on every documents table --
`components/Common.tsx`'s shared `RequestDocuments` (used by Functional/SAST/DAST/Performance/
Suppression/Sign-off) and `QARequests/RequestDetail.tsx`'s own Documents tab -- gated on
`isAdmin || doc.uploaded_by_id === user.id`, matching the backend check exactly so the button simply
doesn't render when the click would 403 anyway. Clicking it opens a small confirmation `Modal` ("Delete
document? ... This cannot be undone.") before calling the new `DELETE` endpoint and reloading the list.

Also added the ability to remove a file *before* it's uploaded -- picking files no longer replaces the
staged selection, it appends to it, and each staged file now shows in a list with its own "✕" remove
button. Applied to all three places a file gets staged pre-upload: `components/Common.tsx`'s
`RequestDocuments` upload form, `QARequests/AddDocuments.tsx` (the gateway's own "add more documents"
form), and `QARequests/steps/DocumentsStep.tsx` (the wizard's initial document-picker step).

**Schema/DB change:** none -- deletion just removes existing rows/files, no new columns.
**Verification:** `python3 -m py_compile` on all seven touched backend files (`documents.py`,
`functional.py`, `sast_dast.py`, `performance.py`, `suppression.py`, `signoff.py`, `qa_requests.py`) --
clean; `npx tsc --noEmit -p .` from `frontend/` -- clean; Documents and outputs re-synced with no
unexpected differences.

## 106. "Type name / employee ID to sign" replaced with the logged-in user's own name

**Why:** reported directly -- "Disable 'Type name / employee ID' to sign, whatever name is present on
system that will be log." `components/Common.tsx`'s `SignField` (used by every SM/Department Head decision
step via `ApprovalDecisionButtons`) was a free-text input pre-filled with the acting user's name but fully
editable before clicking Sign -- so in principle an approval could be logged under any typed name/employee
ID, not necessarily the account that was actually logged in and performing the action.

**Fix:** `SignField` no longer renders an editable input at all -- it shows the logged-in user's own name
(`userName`, already passed in by every caller as `user?.full_name` from `AuthContext`) as plain read-only
text, with the "Sign" button now recording that exact name directly (`onSignedChange(userName)`) instead of
whatever had been typed. If `userName` is somehow unavailable, it shows "Unknown user" and Sign stays
disabled. No caller changes were needed -- `Functional.tsx`, `SAST.tsx`, `DAST.tsx`, `Performance.tsx`,
`Suppression.tsx`, `SignOff.tsx` already passed `userName={user?.full_name}` into
`ApprovalDecisionButtons`, so every decision step across all six modules picked up the fix automatically.

**No schema/backend change** (the signed name still travels inside `comments` via the existing
`withSignature()` helper -- only how that name gets populated changed). **Verification:**
`npx tsc --noEmit -p .` from `frontend/` -- clean; Documents and outputs re-synced with no unexpected
differences.

## 107. Dashboard: added a "Raised" date-range filter (within 1 hour / within 1 month / custom From-To)

**Why:** reported directly -- "In dashboard add filter like within 1 hr raised, 1 month, from date to to
date." The Dashboard had no way to narrow any of its data down to a specific time window; everything
shown was always all-time.

**Fix:** added a new `RaisedRangeFilter` control (`Dashboard.tsx`) rendered above the "At a Glance" cards,
with four options as pill-tabs -- All time, Within 1 hour, Within 1 month, Custom range -- the last of
which reveals a From/To native date-input pair. `isWithinRaisedRange(dateStr, range)` does the actual
matching: `1h`/`1m` compare against `Date.now()` minus 1 hour / 1 calendar month, `custom` compares against
the picked From/To (To is treated as end-of-day so the selected day itself is included).

Applied it to the two things on the page that are actually keyed by a raise/created timestamp:
- **"Active requests (org-wide)" stat card** -- `unifiedRequests` (the combined QA/Functional/SAST/DAST/
  Performance list already built for this card) is now filtered by the selected range before computing
  both the card's value and its footline count; the card's hint/footline text changes wording when a
  non-"all" range is active so it's clear the number is scoped.
- **Recent Activity** -- previously fetched all approval actions and immediately sliced to the 6 most
  recent before storing state, which left nothing for a range filter to narrow down; now the full list is
  kept in state and the range filter + the 6-item cap are both applied together in a `filteredActivity`
  memo, so picking e.g. "Within 1 hour" actually narrows what's shown instead of always displaying the same
  fixed 6 regardless of the filter.

The other three At-a-Glance cards (Active projects, Open security findings, Pending approvals) are
backend-aggregated all-time counts with no per-item created_at to filter by client-side, so they're
deliberately left unaffected -- a caption under the filter control says so explicitly, matching this
dashboard's existing convention (section 102) of never leaving a scope difference unexplained on screen.

**No schema/backend change** (purely client-side filtering of data already being fetched).
**Verification:** `npx tsc --noEmit -p .` from `frontend/` -- clean; Documents and outputs re-synced with
no unexpected differences.

## 108. Renamed the "My Requests" dashboard tab to "Requests", hidden for 4 roles

**Why:** reported directly -- rename "My Requests" to "Requests", and hide the tab entirely for QA
Engineer, QA Lead, Security Analyst, and Executive COE (AGM/QA -- `Role.DEPARTMENT_HEAD_COE`). Those 4
roles work across every team's requests as part of the job, so "requests I personally raised" isn't a
relevant view for them the way it is for a Requester/Business Analyst/SM/Department Head.

**Fix:** `Dashboard.tsx`'s tab label changed from `'My Requests'` to `'Requests'` (the tab's own `key` stays
`'my-requests'` -- internal only, not shown anywhere). The tab entry is now conditionally spread into the
`tabs` array based on a new `hideRequestsTab` check: `user.roles` includes any of `QA_ENGINEER`, `QA_LEAD`,
`SECURITY_ANALYST`, `DEPARTMENT_HEAD_COE`. Checked directly against `user.roles` rather than the shared
`hasRole()` helper, since `hasRole` treats holding `ADMIN` as satisfying *any* role check -- using it here
would have also hidden the tab from Admins, which isn't the intent ("Admin always sees everything"
elsewhere in the app). The tab body render (`{tab === 'my-requests' && ...}`) also checks `!hideRequestsTab`
as a second guard, purely defensive since the tab button that sets that state no longer exists for those
roles.

The pill-tab *inside* the Requests tab body ("My Requests (n)" vs. "{department} (n)") was left as-is --
that's a different, still-meaningful distinction (raised by me vs. raised by my department) unrelated to
the outer dashboard tab's own label.

**No schema/backend change** (purely a frontend visibility/label change).
**Verification:** `npx tsc --noEmit -p .` from `frontend/` -- clean; Documents and outputs re-synced with
no unexpected differences.

## 109. New "Tester Overview" dashboard tab -- per-tester completed/pending/sign-off, by department (Executive COE only)

**Why:** reported directly -- a broad-level view showing, per tester, how many requests they've completed,
how many are still pending, and their sign-off count, grouped by department, visible only to Executive COE
(CM/AGM).

**Fix:** new `TesterOverviewTab` component in `Dashboard.tsx`, added as a tab (`'Tester Overview'`) only
when `hasRole(user, 'DEPARTMENT_HEAD_COE')` is true -- unlike the Requests-tab hide list added in section
108, this one deliberately *does* use the shared `hasRole()` helper (ADMIN-bypass and all), since this is a
"show to X" gate rather than a "hide from X" one, and an Admin seeing it too is the wanted behavior.

Built entirely from data already fetched elsewhere on this dashboard -- no new backend endpoint:
- Fetches `/api/functional-requests`, `/api/signoffs`, and `/api/auth/users`.
- For every Functional Testing Request with one or more `assigned_tester_ids` (comma-separated numeric IDs,
  same field/format `Functional.tsx` already parses for its own Overview), each assigned tester accumulates:
  a **Total Assigned** count; a **Completed** count (status has reached `QA_COMPLETED` or later -- i.e. the
  tester's own execution work is done, regardless of how much further the request still has to go through
  sign-off/closure); a **Pending** count (still active, but earlier than `QA_COMPLETED` -- `TESTER_ASSIGNED`
  through `REGRESSION_TESTING`); and a **Signed Off** count (the request's linked `signoff_id`, looked up
  against the fetched sign-off list, has `status === 'ISSUED'`).
- Each tester's own `department` (from the fetched user list) is shown alongside them, and the table is
  sorted by department then tester name so it reads as a grouped, broad-level overview rather than a flat
  list.

A caption above the table spells out exactly what each column counts, matching this dashboard's existing
convention of never leaving a metric's definition unstated on screen.

**No schema/backend change** (reuses 3 endpoints already called elsewhere in the app; purely a new
frontend view over existing data). **Verification:** `npx tsc --noEmit -p .` from `frontend/` -- clean;
Documents and outputs re-synced with no unexpected differences.

## 110. New "Test Management" module -- Project Management / Test Repository / Test Execution, Zephyr-style (6 new tables -- schema change)

**Why:** requested directly -- "implement same behaviour like Zephyr tool management tool has, exact
clone" for three sub-areas (Project Management, Test Repository, Test Execution), plus the ability to
bulk-import test cases from the bank's own "Test Cases - CR-XX - Template" xlsx format straight into the
Test Repository. Given the size of this ask, scope was pinned down with `AskUserQuestion` before writing
any code: build all three sub-areas at once (not phased); one Test Project per existing Application
(reusing `ApplicationMaster` from section 57, rather than a second parallel "project name" concept); and
QA Engineer + QA Lead both author (create/edit/import/delete test cases) and execute them, with Admin
bypassing as usual via `require_roles`.

This is a deliberately standalone module (its own tables, its own nav group) rather than folded into
Functional/Specialised Testing -- it is an authoring/execution workflow (write test cases, run them
against cycles, record results), not a request-raise-and-approve workflow like every other module in this
app, so it doesn't fit the existing `QARequest`-linked-child pattern at all.

**Domain model, mirroring Zephyr's own structure:** a `TestProject` (container, one per Application)
holds a `TestRepository` (a folder tree of `TestCase` rows, each with its own ordered `TestStep` rows) and
a `TestExecution` area (named `TestCycle`s, each holding one `TestExecution` result row per test case
added to it -- Pass/Fail/Blocked/NA/Retest Passed/Not Executed, see new
`constants.TEST_EXECUTION_STATUSES`).

**6 new tables:**
- `qap_test_projects` (`TestProject`): `project_key` (unique, `TPROJ-<date>-<hex>`), `name`,
  `application_master_id` (FK to `qap_application_master`, nullable), `department` (auto-filled from the
  linked Application when one is picked), `description`, `is_active`, `created_by_id`, `created_at`.
- `qap_test_folders` (`TestFolder`): `project_id`, `parent_id` (self-referential FK, nullable -- a folder
  tree), `name`, `created_by_id`, `created_at`.
- `qap_test_cases` (`TestCase`): `test_case_key` (unique -- either typed by the author or auto-generated
  as `TC-<date>-<hex>`), `project_id`, `folder_id` (nullable -- "Unfiled"), `epic_id`, `feature_id`,
  `user_story_id`, `test_type`, `module_name`, `test_scenario`, `pre_condition`, `description`,
  `priority`, `status` (`Active`/`Draft`/`Deprecated`), `created_by_id`, `created_at`, `updated_at`.
- `qap_test_steps` (`TestStep`): `test_case_id`, `step_no`, `step_text`, `expected_result` -- one row per
  step, cascade-deleted with its test case.
- `qap_test_cycles` (`TestCycle`): `cycle_key` (unique, `CYCLE-<date>-<hex>`), `project_id`, `name`,
  `description`, `status` (`Not Started`/`In Progress`/`Completed`), `start_date`, `end_date`,
  `created_by_id`, `created_at`.
- `qap_test_executions` (`TestExecution`): `cycle_id`, `test_case_id` (unique together -- a test case can
  only appear once per cycle), `status`, `actual_result`, `test_run_artifacts`, `defect_id`,
  `executed_by_id`, `executed_at`, `created_at`.

**New routers, all under `require_roles(Role.QA_ENGINEER, Role.QA_LEAD)` for anything that writes (Admin
always bypasses); reads are open to any authenticated user:**
- `routers/test_projects.py` (`/api/test-projects`): list/create/get/patch Test Projects. Creating one
  with an `application_master_id` auto-fills `department` from that Application's own record.
- `routers/test_repository.py` (`/api/test-repository`): folder CRUD (delete blocked while the folder
  still has children or test cases inside it) and test case CRUD (steps are replaced wholesale on
  update, matching the wizard-style "resubmit the whole steps list" pattern used elsewhere in this app).
- `routers/test_execution.py` (`/api/test-execution`): cycle CRUD; adding test cases to a cycle
  (silently skips any already added, since `(cycle_id, test_case_id)` is unique); recording/removing a
  result, which stamps `executed_by_id`/`executed_at` off the acting user, same convention as every other
  "who did this and when" field in the app.

**xlsx import** (`POST /api/test-repository/projects/{id}/import-xlsx`, `openpyxl`, already a
dependency): parses the bank's standard template -- one row per test step, with each test case's own
descriptive fields (Epic ID, Feature ID, User Story ID, Test Type, Module, Scenario, Pre-Condition,
Description, Priority) filled in **only on the first row of that test case's block**, left blank on every
subsequent step row (the template's own merged-cell-style layout); a new block starts whenever the "Test
Case ID" column is non-empty again. Header row is matched case/whitespace-insensitively against a
`_HEADER_MAP`, so extra columns added to the template later are simply ignored rather than rejected. If a
test case's first row *also* carries a Status/Actual Result/Test Run Artifacts/Defect ID (someone had
already run it and recorded the outcome directly in the sheet before uploading), an initial
`TestExecution` is seeded under a get-or-created "Imported from Excel" cycle for that project, so
pre-existing results aren't silently discarded on import. Returns a summary (`created_test_cases`,
`imported_executions`, `skipped_rows`, `errors[]`, e.g. duplicate Test Case IDs). This parsing logic was
validated against the actual uploaded template file (16 test cases, 0 duplicates, 0 zero-step cases,
correct grouping) via a standalone dry-run script before being trusted in the router.

**Frontend:** three new pages under `modules/test-management/` -- `TestProjects.tsx` (list + create,
Application picker reusing the same approved-names list as the QA Request wizard), `TestRepository.tsx`
(project switcher, folder-tree sidebar, test case table, "+ New Test Case" with an inline step editor,
"Import from Excel" upload), `TestExecution.tsx` (project + cycle switcher, "+ Add Test Cases" picker,
per-row "Record Result" modal showing the test case's own steps alongside the result fields). All three
gate their write actions on `hasRole(user, 'QA_ENGINEER', 'QA_LEAD')`, matching the backend. New
`api.uploadForm()` helper added (single named file field + optional extra form fields, unlike the
existing `uploadFiles()` which always uses field name `'files'` with no other data) to support the xlsx
import's `file` + optional `folder_id` fields. New "Test Management" nav group (Project Management / Test
Repository / Test Execution) added to the sidebar for everyone, and the shared `Badge` component's status
color map extended with `Active`/`Deprecated`/`Not Executed`/`Pass`/`Fail`/`Blocked`/`NA`/`Retest
Passed`/`Not Started`.

**Oracle migration needed:** six new tables, all purely additive -- no existing table's columns changed.
`Base.metadata.create_all()` (called on every app startup) will create these automatically on a fresh
database, but on an already-deployed one the same caveat as every prior new-table section applies: if
schema migrations aren't run automatically in that environment, create these by hand before starting the
app on this version.

```sql
CREATE TABLE qap_test_projects (
    id                      NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_key             VARCHAR2(40) NOT NULL,
    name                    VARCHAR2(150) NOT NULL,
    application_master_id   NUMBER,
    department              VARCHAR2(150),
    description             CLOB,
    is_active               NUMBER(1) DEFAULT 1,
    created_by_id           NUMBER,
    created_at              DATE DEFAULT SYSDATE,
    CONSTRAINT uq_qap_test_projects_key UNIQUE (project_key),
    CONSTRAINT fk_qap_test_projects_app FOREIGN KEY (application_master_id) REFERENCES qap_application_master(id),
    CONSTRAINT fk_qap_test_projects_by FOREIGN KEY (created_by_id) REFERENCES qap_users(id)
);

CREATE TABLE qap_test_folders (
    id              NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id      NUMBER NOT NULL,
    parent_id       NUMBER,
    name            VARCHAR2(150) NOT NULL,
    created_by_id   NUMBER,
    created_at      DATE DEFAULT SYSDATE,
    CONSTRAINT fk_qap_test_folders_project FOREIGN KEY (project_id) REFERENCES qap_test_projects(id),
    CONSTRAINT fk_qap_test_folders_parent FOREIGN KEY (parent_id) REFERENCES qap_test_folders(id),
    CONSTRAINT fk_qap_test_folders_by FOREIGN KEY (created_by_id) REFERENCES qap_users(id)
);

CREATE TABLE qap_test_cases (
    id              NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    test_case_key   VARCHAR2(60) NOT NULL,
    project_id      NUMBER NOT NULL,
    folder_id       NUMBER,
    epic_id         VARCHAR2(60),
    feature_id      VARCHAR2(60),
    user_story_id   VARCHAR2(60),
    test_type       VARCHAR2(60),
    module_name     VARCHAR2(150),
    test_scenario   VARCHAR2(255),
    pre_condition   CLOB,
    description     CLOB,
    priority        VARCHAR2(16),
    status          VARCHAR2(20) DEFAULT 'Active',
    created_by_id   NUMBER,
    created_at      DATE DEFAULT SYSDATE,
    updated_at      DATE DEFAULT SYSDATE,
    CONSTRAINT uq_qap_test_cases_key UNIQUE (test_case_key),
    CONSTRAINT fk_qap_test_cases_project FOREIGN KEY (project_id) REFERENCES qap_test_projects(id),
    CONSTRAINT fk_qap_test_cases_folder FOREIGN KEY (folder_id) REFERENCES qap_test_folders(id),
    CONSTRAINT fk_qap_test_cases_by FOREIGN KEY (created_by_id) REFERENCES qap_users(id)
);

CREATE TABLE qap_test_steps (
    id              NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    test_case_id    NUMBER NOT NULL,
    step_no         NUMBER NOT NULL,
    step_text       CLOB,
    expected_result CLOB,
    CONSTRAINT fk_qap_test_steps_case FOREIGN KEY (test_case_id) REFERENCES qap_test_cases(id)
);

CREATE TABLE qap_test_cycles (
    id              NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    cycle_key       VARCHAR2(40) NOT NULL,
    project_id      NUMBER NOT NULL,
    name            VARCHAR2(150) NOT NULL,
    description     CLOB,
    status          VARCHAR2(20) DEFAULT 'Not Started',
    start_date      DATE,
    end_date        DATE,
    created_by_id   NUMBER,
    created_at      DATE DEFAULT SYSDATE,
    CONSTRAINT uq_qap_test_cycles_key UNIQUE (cycle_key),
    CONSTRAINT fk_qap_test_cycles_project FOREIGN KEY (project_id) REFERENCES qap_test_projects(id),
    CONSTRAINT fk_qap_test_cycles_by FOREIGN KEY (created_by_id) REFERENCES qap_users(id)
);

CREATE TABLE qap_test_executions (
    id                  NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    cycle_id            NUMBER NOT NULL,
    test_case_id        NUMBER NOT NULL,
    status              VARCHAR2(20) DEFAULT 'Not Executed',
    actual_result       CLOB,
    test_run_artifacts  VARCHAR2(255),
    defect_id           VARCHAR2(60),
    executed_by_id      NUMBER,
    executed_at         DATE,
    created_at          DATE DEFAULT SYSDATE,
    CONSTRAINT uq_qap_test_exec_cycle_case UNIQUE (cycle_id, test_case_id),
    CONSTRAINT fk_qap_test_exec_cycle FOREIGN KEY (cycle_id) REFERENCES qap_test_cycles(id),
    CONSTRAINT fk_qap_test_exec_case FOREIGN KEY (test_case_id) REFERENCES qap_test_cases(id),
    CONSTRAINT fk_qap_test_exec_by FOREIGN KEY (executed_by_id) REFERENCES qap_users(id)
);

CREATE INDEX ix_qap_test_folders_project ON qap_test_folders(project_id);
CREATE INDEX ix_qap_test_cases_project ON qap_test_cases(project_id);
CREATE INDEX ix_qap_test_cycles_project ON qap_test_cycles(project_id);
CREATE INDEX ix_qap_test_exec_cycle ON qap_test_executions(cycle_id);
```

No existing columns changed or dropped -- purely additive.

Verified via `py_compile` across every touched/new backend file (`models.py`, `schemas.py`,
`constants.py`, `main.py`, `routers/test_projects.py`, `routers/test_repository.py`,
`routers/test_execution.py` -- all clean) and `npx tsc --noEmit -p .` on the frontend (clean, including
the 3 new `.tsx` modules). The xlsx-import row-grouping logic was additionally validated against the real
uploaded template file with a standalone parsing dry-run, independent of the router code, before being
trusted. **Not verified:** an actual FastAPI app boot / SQLAlchemy mapper-configuration check -- this
sandbox has no network access to install the project's runtime dependencies (`pip install` fails with a
proxy `403`), so only syntax-level (`py_compile`) verification plus manual review of every `back_populates`
relationship pair was possible for the new ORM models; a real app boot against a live Oracle instance
should be the first smoke test after this DDL is applied. Documents and outputs copies re-synced and
confirmed identical via `diff -rq` (aside from the always-excluded `.env`/`uploads` runtime files). The
DDL above was not (and cannot be) run from this environment -- no direct network access to the target
Oracle instance -- so it must be applied to the actual database by whoever administers it before this
version is deployed/restarted there.

## 111. Validation: Target Promotion Environment must be strictly later than Deployment Environment (no schema change)

**Why:** requested directly, with the exact rule spelled out -- picking e.g. UAT as the Deployment
Environment must force Target Promotion Environment to Pre-Production or Production, never SIT/UAT again
or anything earlier, along the pipeline `SIT -> UAT -> Pre-Production -> Production`. Previously the two
dropdowns (DetailsStep.tsx's QA Request wizard, and Functional.tsx's Edit Details modal -- the only two
places either field is ever edited; every other module only shows them read-only, see `SAST.tsx`'s/
`DAST.tsx`'s/`Performance.tsx`'s Overview) only had a single static rule each ("Deployment Environment
can't be Dev", "Target Promotion Environment can't be Dev or SIT"), with no relationship enforced between
the *specific* value picked for one and the other -- e.g. Deployment=Production with Target=UAT was
perfectly selectable.

**Fix, one shared rule defined in exactly two places (mirrored intentionally, backend and frontend each
need their own copy since they don't share a runtime):**
- **`backend/app/constants.py`**: new `ENVIRONMENT_PIPELINE_ORDER = ["SIT", "UAT", "Pre-Production",
  "Production"]` (deliberately excludes "Dev" -- neither dropdown ever offers it) and a new
  `validate_environment_promotion(environment, target_promotion_environment)` helper that raises
  `ValueError` if the target's index in that list isn't strictly greater than the environment's index.
  Silently no-ops if either value isn't a recognised pipeline stage, so it never fights with genuinely
  blank/in-progress Draft data -- this is an ordering rule, not a "is this a valid environment name" check.
- **`frontend/src/constants.ts`**: the same `ENVIRONMENT_PIPELINE_ORDER` list, plus
  `validTargetPromotionOptions(environment)` (every stage strictly later than `environment`, used to
  populate the Target dropdown so an invalid combination can't even be selected) and
  `validEnvironmentPromotion(environment, target)` (boolean check, used as a final gate).
- **Backend, 3 write paths enforced** (the only 3 places these two fields are ever written):
  `routers/qa_requests.py::create_request` (validates the incoming `environment`/
  `target_promotion_environment` before constructing the new `QARequest` row), `::edit_request` (resolves
  final values against `obj`'s current ones first, since this is a partial `exclude_unset=True` update --
  re-saving just one of the two fields is still checked against the other's already-saved value, not
  treated as blank), and `routers/functional.py::update_functional` (same partial-update resolution, since
  these are delegated properties read through `obj.qa_request`). All three raise a 400 with a message
  naming both values and the pipeline order.
- **Frontend, both edit points get the same two-part fix:** the Target Promotion Environment dropdown's
  own options are now generated by `validTargetPromotionOptions(form.environment)` instead of a static
  Dev/SIT exclusion, so an invalid option is never even shown; and the Deployment Environment dropdown's
  `onChange` auto-corrects Target Promotion Environment to the nearest still-valid stage if the
  previously-picked one is no longer valid against the newly-picked deployment environment (rather than
  leaving a stale, now-invalid selection sitting there, or falling back to a blank value -- keeps the
  existing "these dropdowns always default to a real, non-blank value" invariant intact, noted in
  `QARequests/validation.ts`'s own comment). `QARequests/validation.ts::detailsStepError` and
  `Functional.tsx`'s `FunctionalFormModal::submit` also call `validEnvironmentPromotion` directly as a
  last-line-of-defense gate before Next/Submit/Save -- belt-and-braces for a Draft saved before this rule
  existed that might still carry a stale, now-invalid combination, same reasoning as the existing CR/Epic
  format checks in that same file (section 218).

**No schema change** -- purely a validation rule layered on top of the existing `environment`/
`target_promotion_environment` columns (`qap_requests`, delegated through to `FunctionalRequest` and every
other linked child type exactly as before). **Verified:** `py_compile` on `constants.py`,
`routers/qa_requests.py`, `routers/functional.py` -- clean; `npx tsc --noEmit -p .` on the frontend --
clean; Documents and outputs copies re-synced and confirmed identical via `diff -rq` (aside from the
always-excluded `.env`/`uploads` runtime files).

## 112. Explicit IT-QA workflow assignments for Functional, Performance, SAST, and DAST

Department Head approval now assigns an active `QA_LEAD` from `IT-QA` for all four testing workflows.
After readiness passes, that QA Lead assigns active execution users from `IT-QA`: `QA_ENGINEER` users
for Functional/Performance and a `SECURITY_ANALYST` for SAST/DAST. Only the assigned users can perform
their respective workflow actions. Functional already had `qa_lead_id` and `assigned_tester_ids`, so it
needs no DDL. Existing Performance `engineer_id` and SAST/DAST `security_lead_id` columns are retained and
now consistently hold the assigned IT-QA QA Lead.

Run these additive statements before deploying the matching application version:

```sql
ALTER TABLE qap_sast_requests ADD (
    security_analyst_id NUMBER,
    CONSTRAINT fk_qap_sast_security_analyst
        FOREIGN KEY (security_analyst_id) REFERENCES qap_users(id)
);

ALTER TABLE qap_dast_requests ADD (
    security_analyst_id NUMBER,
    CONSTRAINT fk_qap_dast_security_analyst
        FOREIGN KEY (security_analyst_id) REFERENCES qap_users(id)
);

ALTER TABLE qap_performance_requests ADD (
    assigned_tester_ids VARCHAR2(255)
);
```

All three columns are nullable so existing history remains readable. Before continuing any in-flight
request beyond its current assignment checkpoint, verify that its legacy `engineer_id` or
`security_lead_id` references an active IT-QA QA Lead and populate the new analyst/tester assignment at
the Planning step. No existing rows are deleted or automatically reassigned.

## 113. Jira-style rich comments with pasted images (no schema change)

The shared Activity component now provides formatted paste, bold/italic/underline/strikethrough, bullet
and numbered lists, quotes, inline code, links, image selection, and direct clipboard image paste.
Formatted text is stored as safe Markdown in the existing `qap_approval_actions.comments` CLOB. Comment
images reuse the existing `qap_module_documents` table with `module = 'COMMENT_IMAGE'` and the comment's
`qap_approval_actions.id` as `request_id`; authenticated list/download endpoints restore the images after
reload. Supported image types are PNG, JPEG, GIF, and WebP, with a maximum of 8 images per comment and
10 MB per image. No Oracle DDL is required.

## 114. QA Tester Overview capacity and occupancy (no schema change)

The QA-team-only dashboard view now combines each active IT-QA QA Tester's Functional/Performance work
and each Security Analyst's SAST/DAST work into one explainable occupancy percentage. Three fully-active
concurrent assignments equal 100% planned capacity. Design/execution/scanning uses up to 1 point,
configuration/retest/regression 0.75, queued/defect/remediation 0.5, waiting/result analysis 0.25, and
near-complete work 0.05–0.15; shared Functional/Performance requests divide their point value between
assigned testers. The view reports available, light, balanced, high, full, and overloaded bands, plus
active/queued/waiting/near-complete counts and Functional/Performance/SAST/DAST work mix. Existing
assignment and status columns provide all required data, so no Oracle DDL is required.

## 115. Remove request context from legacy demo user names (data cleanup only)

Legacy seeded users used values such as `SM 1 Of Req 1` and `Dep Head Of Req 1` as `full_name`. User
selectors and audit views should show only the person's name. New seed runs now use `SM 1`, `SM 2`,
`Department Head 1`, and `Department Head 2`; rerunning `python -m app.seed` safely updates only rows that
still have the exact legacy values. API response schemas also remove the suffix for immediate display
compatibility. Apply the following optional cleanup to persist the corrected values directly:

```sql
UPDATE qap_users SET full_name = 'SM 1'
 WHERE username = 'sm1' AND full_name = 'SM 1 Of Req 1';
UPDATE qap_users SET full_name = 'SM 2'
 WHERE username = 'sm2' AND full_name = 'SM 2 Of Req 1';
UPDATE qap_users SET full_name = 'Department Head 1'
 WHERE username = 'depthead1' AND full_name = 'Dep Head Of Req 1';
UPDATE qap_users SET full_name = 'Department Head 2'
 WHERE username = 'depthead2' AND full_name = 'Dep Head Of Req 1';
COMMIT;
```

No schema change is required.

## 113. Bug fix: freshly-raised requests showed "QA Lead Approval Pending" instead of "SM Approval Pending" everywhere (no schema change)

**Reported directly:** after raising a QA Request, its linked Functional Testing Request (and, it turns
out, every other module's request too) displayed "QA Lead Approval Pending" instead of "SM Approval
Pending". Traced end-to-end before touching anything -- the actual write path
(`routers/qa_requests.py::submit_request` -> `_sync_linked_child_requests` -> `_raise_child_to_sm`)
unconditionally sets a newly-created child request's `status` column to the literal string
`SM_APPROVAL_PENDING`, and every backend status->label map (`constants.py`'s `QA_STATUS_LABELS`,
`SAST_DAST_STATUS_LABELS`, `PERFORMANCE_STATUS_LABELS`) correctly labels that "SM Approval Pending". The
bug was never in the workflow/status logic at all -- it was a frontend display collision.

**Root cause:** `components/Common.tsx`'s shared `Badge` component -- the single place every module's
status renders through -- built its label lookup by spreading five modules' `*_STATUS_LABELS` maps into
one flat object:
```ts
const ALL_STATUS_LABELS = { ...QA_STATUS_LABELS, ...SAST_DAST_STATUS_LABELS, ...SUPPRESSION_STATUS_LABELS,
                             ...PERFORMANCE_STATUS_LABELS, ...SIGNOFF_STATUS_LABELS }
```
`QASignOff` (the QA Sign-off Certificate workflow) reuses `SM_APPROVAL_PENDING`/`RETURNED_BY_SM`/
`SM_REJECTED` as legacy internal status codes for its own, unrelated QA-Lead-approval checkpoint (see
`constants.py`'s own comment on `SIGNOFF_STATUS_LABELS` and `routers/signoff.py` -- Sign-off's chain is
Tester -> QA Lead -> Executive COE, no SM involved at all) -- but gives those reused codes Sign-off-specific
labels: `"SM_APPROVAL_PENDING": "QA Lead Approval Pending"`, `"RETURNED_BY_SM": "Returned by QA Lead"`,
`"SM_REJECTED": "Rejected by QA Lead"`. Since `SIGNOFF_STATUS_LABELS` was spread last, its three colliding
entries silently overwrote the correct "SM Approval Pending"/"Returned by SM"/"Rejected by SM" for
**every other module that also uses those same status codes** -- QA Request/Functional, SAST, DAST,
Performance, and Suppression all do. So this wasn't a one-off cosmetic glitch: any request in this app
sitting at genuine SM Approval Pending rendered as "QA Lead Approval Pending" everywhere its Badge
appeared (list tables, Overview headers, the 3W dashboard reads the raw status independently and was
unaffected, but every `<Badge status={...} />` call site was not).

**Fix:** `Badge` already supported an optional `label` override prop (added earlier for Test Management's
own status vocabulary) but almost nothing used it, so nearly every call site fell through to the corrupted
merged lookup.
- `components/Common.tsx`: `SIGNOFF_STATUS_LABELS` removed from the `ALL_STATUS_LABELS` merge entirely --
  it's the outlier that reuses shared status codes for a different meaning, not the other four maps.
- `modules/governance/SignOff.tsx`'s own two `<Badge status={...} />` call sites (the certificate detail
  header and the list table's Status column) now pass an explicit
  `label={SIGNOFF_STATUS_LABELS[status] || status}` override, so Sign-off's own screens still correctly
  show "QA Lead Approval Pending"/"Returned by QA Lead"/"Rejected by QA Lead" for its own certificates --
  same pattern `Suppression.tsx`/`TestRepository.tsx` already used for their own status vocabularies.
  Every other module's Badge call sites are unchanged and now resolve `SM_APPROVAL_PENDING` correctly
  again.

**No schema or backend change** -- the stored status values and their meaning were always correct; this
was purely a frontend label-lookup collision. **Verified:** `npx tsc --noEmit -p .` -- clean; Documents and
outputs copies re-synced and confirmed identical via `diff -rq` (aside from the always-excluded
`.env`/`uploads` runtime files).

## 114. Test Repository: "Download Template" for test-case xlsx import (no schema change)

**Request:** users need a single, canonical "Test Cases - CR-XX - Template" xlsx to download from inside
Test Repository, so bulk import always uses that exact format rather than an arbitrary spreadsheet.

**New static asset:** `backend/app/assets/templates/Test_Case_Import_Template.xlsx` -- the standard
template (sheet "CR-XX Testcases", 17-column header row matching `test_repository.py`'s existing
`_HEADER_MAP` exactly: Test Case ID, Epic ID, Feature ID, User Story ID, Test Type, Module Name (if any),
Test Scenario, Pre-Condition (if any), Test Case Description, Step No., Steps, Expected Result, Priority,
Actual Result, Status, Test Run Artifacts, Defect ID (if any)). Deliberately placed under
`backend/app/assets/` (new directory), **not** `backend/app/uploads/` -- `uploads/` is runtime-only and
excluded from the Documents↔deploy sync, so a static reference file placed there would silently 404 after
a real deploy. `assets/` is a normal tracked path.

**Backend (`routers/test_repository.py`):** new `GET /api/test-repository/import-template` (any
authenticated user, no role restriction -- it carries no project data, just headers/example rows) serves
the asset via `FileResponse(..., media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")`,
the same xlsx MIME type `export.py` already uses. Returns 404 if the asset file is ever missing from the
deployed image.

**Frontend (`modules/test-management/TestRepository.tsx`):** a "Download Template" button added to the
Test Repository toolbar (visible to everyone, not just authors, so any user can grab the format before
asking someone with author rights to import), plus a second "Download the template" link inside the
Import-from-Excel modal itself, both calling the existing `api.downloadFile()` helper against the new
endpoint.

**No schema or backend-model change.** **Verified:** `python3 -m py_compile routers/test_repository.py` --
clean; `npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced and confirmed identical via
`diff -rq` (aside from the always-excluded `.env`/`uploads` runtime files).

## 115. "Pending With" column on every workflow list table (no schema or backend change)

**Request:** every list table should show who currently owns the next action, not just the raw status, for
better visibility/traceability across the app.

**Frontend-only (`constants.ts`):** added one `*_PENDING_WITH: Record<string, string>` map per module --
`GATEWAY_PENDING_WITH`, `QA_PENDING_WITH`, `SAST_DAST_PENDING_WITH`, `PERFORMANCE_PENDING_WITH`,
`SUPPRESSION_PENDING_WITH`, `SIGNOFF_PENDING_WITH`, `TEST_CASE_PENDING_WITH` -- kept as **separate** maps
per module rather than one merged lookup, deliberately avoiding the exact anti-pattern behind section 113's
Badge label-collision bug (several modules reuse the same status codes for different meanings, e.g.
Sign-off's legacy `SM_APPROVAL_PENDING`). Each map's values were derived from the actual
`require_roles(...)`/`_require_assigned_*` gate on the router transition that moves a request *out* of that
status -- not guessed from the status label text -- so e.g. `QA_PENDING_WITH` mirrors `dashboard.py`'s own
`STAGE_TEAM` (already used server-side by the 3W dashboard) exactly for every status it covers, and
`SAST_DAST_PENDING_WITH`/`PERFORMANCE_PENDING_WITH` were built the same way straight from
`routers/sast_dast.py`/`routers/performance.py`. `DEFECT_RAISED`/`WAITING_FOR_FIX`/`DEFECT_FIX_RETEST`
point at Requester (not QA) in every map that has them, matching `STAGE_TEAM`'s own reasoning: the actual
fix happens on the requester/dev side even though a QA Lead/Engineer/Security Analyst clicks the button
that logs the transition.

**Frontend (8 list tables):** a new "Pending With" column added next to the existing Status column in
`QARequests/index.tsx`, `Functional.tsx`, `SAST.tsx`, `DAST.tsx`, `Performance.tsx`, `Suppression.tsx`,
`SignOff.tsx`, and `TestRepository.tsx`'s test case list -- each rendering `X_PENDING_WITH[row.status] ||
'—'` with a matching `filterValue` so the existing per-column filter popover also works on it.
`TestProjects.tsx` (Active/Inactive toggle) and `TestExecution.tsx`'s cycle/run tables were deliberately
skipped -- neither has an approval-pending concept, so a "Pending With" column there would be "—" on every
row and add nothing.

**No schema or backend change** -- every list already returns `status` today; this is purely a frontend
lookup added next to it. **Verified:** `npx tsc --noEmit -p .` -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (aside from the always-excluded `.env`/`uploads` runtime
files).

## 116. Three fixes: past Target Release Dates, Cancel confirmation, dead wizard Next button (no schema change)

**1. Block a manually-entered past Target Release Date.** The wizard's own date input
(`QARequests/steps/DetailsStep.tsx`) already had `min={today}`, but that's an HTML attribute only --
trivially bypassed by a direct API call -- and `Functional.tsx`'s own Edit Details modal (the only other
place this field can be changed, once the QA Request gateway itself has left Draft) never had a `min` at
all, so a past date could be typed straight in after the request was raised. Added
`validate_target_release_date(target_release_date)` to `constants.py`, the same pattern as the existing
`validate_environment_promotion` -- raises `ValueError` if the date is before today, no-ops on `None`.
Wired into all 3 backend write paths for this field: `routers/qa_requests.py::create_request` and
`edit_request`, and `routers/functional.py::update_functional`. Also added the missing `min={today}` to
Functional.tsx's date input, matching DetailsStep.tsx.

**2. Confirmation pop-up before cancelling a QA Request.** `QARequests/RequestDetail.tsx`'s "Cancel
Request" button called `POST /{id}/cancel` directly on click -- no confirmation, despite Cancelled being a
terminal, unrecoverable status (see `GATEWAY_TERMINAL_STATUSES`). Now opens a `ConfirmModal` first (same
component already used for document/folder/testcase deletion elsewhere); the actual cancel call only fires
on "Cancel Request" inside the pop-up, and any failure is shown inside the still-open pop-up (via
`ErrorText`) rather than silently closing it, matching the existing document-delete pop-up's own
success-only-closes behavior.

**3. Wizard's "Next" button going dead after the validation error pop-up was closed once.** Root cause: a
genuine React footgun, not a logic bug in the validation rules themselves.
`NewRequestModal.tsx::goNext()`/`submit()` call `setError(someString)` when a step's validation fails (e.g.
`typeStepError` returning the fixed literal `'Select at least one Request Type.'`). `ErrorText`
(`components/Common.tsx`) renders that error as its own pop-up modal, with an internal `visible` state that
only responds to *reference/value* changes of the `error` prop (`useEffect(() => setVisible(Boolean(error)),
[error])`) -- and its own "Close" button only clears that local `visible` flag, never the parent's `error`
state. So: click Next with the same thing still missing a second time -> `typeStepError` returns the exact
same string content again -> `setError(sameString)` is a no-op as far as React's state bailout is concerned
(a `setState` call with a value `Object.is`-equal to the current state skips re-rendering entirely, and
plain strings with identical content are always `===`) -> the whole component (including `ErrorText`) never
re-renders -> no pop-up reappears, `goNext()` still `return`s before advancing the step -> Next looks
completely unresponsive, with zero feedback. Fixed by wrapping every validation message in `new Error(...)`
before calling `setError` in both `goNext()` and `submit()`'s safety-net checks -- a fresh `Error` object has
a distinct reference every time even when `.message` is identical, so the state update (and the pop-up)
never gets silently skipped again. Scoped to `NewRequestModal.tsx` only; `ErrorText` itself was left alone
to avoid touching its ~40 other call sites across the app.

**No schema or backend-model change** (item 1 adds a pure validation function, no new column). **Verified:**
`python3 -m py_compile constants.py routers/qa_requests.py routers/functional.py` -- clean; `npx tsc
--noEmit -p .` -- clean; Documents and outputs copies re-synced and confirmed identical via `diff -rq`
(aside from the always-excluded `.env`/`uploads` runtime files).

## 117. Confirmation before discarding the QA Request wizard's own Close/Cancel (no schema change)

**Follow-up to section 97** (which added `preventBackdropClose` + a shake animation so an accidental click
on the dimmed backdrop couldn't silently throw away a multi-step, not-yet-saved wizard). Reported directly:
that guard never covered the wizard's own two explicit dismiss controls -- the header's "Close" button
(rendered by the shared `Modal` component, wired straight to whatever `onClose` it's given) and the footer's
own "Cancel" button both still called `onClose` directly, discarding every step's typed details with zero
confirmation.

**Fix (`QARequests/NewRequestModal.tsx` only):** added a `requestClose()` function that opens a
`ConfirmModal` ("Discard this QA Request?" / "Discard these changes?" when editing) instead of closing
immediately; `<Modal onClose={...}>` (which the header's Close button calls) and the footer's Cancel button
now both call `requestClose` instead of the raw `onClose` prop. The actual `onClose` passed in by the parent
(`QARequests/index.tsx`/`RequestDetail.tsx`) only fires once "Discard" is confirmed; "Keep Editing" just
closes the pop-up and leaves the wizard exactly as it was. Scoped to this one wizard -- the shared `Modal`
component's own header Close button was left alone (used by ~30 other, mostly single-step/non-destructive
modals across the app where an unconditional confirm-to-close would be unwanted friction).

**No schema or backend change.** **Verified:** `npx tsc --noEmit -p .` -- clean; Documents and outputs
copies re-synced and confirmed identical via `diff -rq` (aside from the always-excluded `.env`/`uploads`
runtime files).

## 118. QA Sign-off certificate: "Validity From"/"Validity To" was missing from both forms (no schema change)

**Reported symptom:** every certificate's detail view shows "Validity: — to —" -- there was no way to ever
set it.

**Root cause:** `validity_from`/`validity_to` were already fully wired end-to-end on the backend --
`models.QASignOff` columns, and present on `schemas.SignOffCreate`/`SignOffUpdate`/`SignOffOut` -- and
already rendered (read-only) on `SignOff.tsx`'s certificate detail view. But neither `NewSignOffModal` nor
`EditSignOffModal` ever had an input for them, so the value could never actually be set by anyone -- a pure
missing-frontend-fields gap, not a backend one.

**Fix (`modules/governance/SignOff.tsx` only):** added "Validity From"/"Validity To" `<input type="date">`
fields to both forms (optional, matching the backend's `Optional[date]`), plus a shared `validityError(from,
to)` helper blocking save if To is before From (Validity To's own `min` is also set to whatever Validity
From currently holds, same UX as the Target Release Date/environment-pipeline date pickers elsewhere in the
app). Blank strings are converted to `null` before the `POST`/`PUT` call, matching every other optional-date
field in the app (e.g. QARequests' `target_release_date`) -- sending `""` to a `datetime.date` Pydantic field
would otherwise 422.

**No schema or backend change** -- both endpoints already accepted these fields; this only adds the
frontend inputs. **Verified:** `npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced and
confirmed identical via `diff -rq` (aside from the always-excluded `.env`/`uploads` runtime files).

## 119. "Local admin": Department Heads can now assign working-level roles within their own department (no schema change)

**Request:** reduce sole dependency on a System Admin for role assignment -- let each Department Head
manage role/status for users already mapped to their own department.

**Design decisions (confirmed directly):** a Department Head may assign only the working-level roles --
`REQUESTER, BUSINESS_ANALYST, QA_ENGINEER, QA_LEAD, SECURITY_ANALYST, APPLICATION_OWNER, SM` -- never
`ADMIN`, `DEPARTMENT_HEAD`, or `DEPARTMENT_HEAD_COE` (so a local admin can never mint a peer department
head, an Executive COE approver, or another System Admin). Beyond role assignment, they may also
activate/deactivate accounts in their department. No user creation, no password resets, no department
reassignment, no editing their own account -- those stay System-Admin-only via the existing `/admin` page.

**Backend:**
- `constants.py`: new `LOCAL_ADMIN_ASSIGNABLE_ROLES` list (the 7 roles above).
- `schemas.py`: new `LocalAdminUserUpdate` (`roles: Optional[List[str]]`, `is_active: Optional[bool]` only
  -- no department/login_type/profile fields, unlike the Admin-only `UserUpdate`).
- `routers/auth.py`, two new endpoints, both gated `require_roles(Role.DEPARTMENT_HEAD)`:
  - `GET /api/auth/local-admin/users` -- every user mapped to the caller's own `department` (any
    active/disabled status, so a disabled account can be re-enabled too), excluding the caller's own
    account and excluding anyone who holds `ADMIN`.
  - `PATCH /api/auth/local-admin/users/{id}` -- `_require_own_department_target` re-checks all of the same
    guards server-side (never trust the GET-time filtering alone): 403 if editing self, 403 if the target
    holds `ADMIN`, 403 if the target's department doesn't match the caller's own. Submitting a role outside
    `LOCAL_ADMIN_ASSIGNABLE_ROLES` is rejected outright (403) rather than silently dropped. Crucially, the
    role write is a **merge, not a blind replace**: `preserved = [r for r in user.roles if r not in
    LOCAL_ADMIN_ASSIGNABLE_ROLES]` is combined with the submitted assignable-role list before the
    delete-then-reinsert `UserRole` write (same delete-flush-then-insert pattern `update_user` already
    uses, to avoid tripping the `(user_id, role)` unique constraint) -- so a target user who separately
    holds `DEPARTMENT_HEAD`/`DEPARTMENT_HEAD_COE` never has that silently stripped just because this
    narrower endpoint's payload only ever describes the working-level subset.
  - Deliberately did **not** reuse `deps.require_same_department` for the department check -- that helper
    treats a blank `entity_department` as "skip the check", which is the right call for request-approval
    entities but would be a hole here (any Department Head could then manage any user with no department
    set). Wrote an explicit equality check instead.

**Frontend:**
- `constants.ts`: mirrors `LOCAL_ADMIN_ASSIGNABLE_ROLES` exactly.
- `Admin.tsx`: its existing `RoleChipSelect` is now exported with a new optional `roles` prop (defaults to
  `ALL_ROLES`, so Admin.tsx's own usage is unchanged) so the new page can reuse the same checkbox UI
  restricted to the 7-role subset instead of duplicating it.
- New `modules/governance/DepartmentAdmin.tsx` -- gated on `hasRole(user, 'DEPARTMENT_HEAD')` (same
  in-component "Access Restricted" card pattern as Admin.tsx). Table of the department's users: name, a
  restricted `RoleChipSelect`, and an Active/Disabled toggle button (same pattern as Admin.tsx's own status
  button). Any role a user holds outside the assignable set is shown as a read-only "Also holds: ... (managed
  by a System Admin)" line rather than hidden, so the page is honest about not being the full picture of
  that person's access.
- New route `/department-admin` (`App.tsx`) and a new "Department Admin" nav item (`Layout.tsx`), pushed
  into the existing "Administration" group alongside "Users & Access" -- `hasRole(user, 'DEPARTMENT_HEAD')`
  also returns true for an Admin account (its own ADMIN short-circuit), so an Admin sees both items merged
  into that one group rather than a duplicate second group.

**No schema or backend-model change** -- role assignment already used the existing `qap_user_roles` join
table; this only adds new, narrower endpoints over it. **Verified:** `python3 -m py_compile constants.py
schemas.py routers/auth.py` -- clean; `npx tsc --noEmit -p .` -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (aside from the always-excluded `.env`/`uploads` runtime
files).

## 120. Split `DEPARTMENT_HEAD` role into `DEPARTMENT_HEAD_CM` and `DEPARTMENT_HEAD_AGM` (data migration)

**Request:** the single `DEPARTMENT_HEAD` role (label "Department Head - CM/AGM") is split into two roles
-- **"Department Head (CM)"** and **"Department Head (AGM)"** -- carrying **identical authority**
everywhere. This is not two separate approval steps: every existing Department Head checkpoint (QA
Request, SAST, DAST, Suppression, Performance decision gates; the Local Admin panel) now accepts *either*
role, OR'd together, so any one Department Head account -- CM or AGM -- can still approve on their own.
The only reason for the split is so approval history/activity logs show the approver's exact position (CM
vs AGM) instead of a generic "Department Head" label, since the log already records `actor_role` at the
moment of each decision.

**Not touched by this change (confirmed distinct during the audit):** the unrelated `DEPARTMENT_HEAD_COE`
role (Executive COE / QA Sign-off), and the workflow **status codes** that happen to share the substring --
`DEPARTMENT_HEAD_APPROVAL_PENDING`, `RETURNED_BY_DEPARTMENT_HEAD`, `DEPARTMENT_HEAD_REJECTED` -- which live
on request entities, not on users, and keep their existing spelling everywhere (a decision by either new
role still transitions a request through these same status codes; the log entry recording *who* made that
decision is what now shows CM vs AGM).

**Backend (`constants.py`):**
- `Role.DEPARTMENT_HEAD` removed; replaced with `Role.DEPARTMENT_HEAD_CM = "DEPARTMENT_HEAD_CM"` and
  `Role.DEPARTMENT_HEAD_AGM = "DEPARTMENT_HEAD_AGM"`.
- `ALL_ROLES` and `ROLE_LABELS` updated -- `Role.DEPARTMENT_HEAD_CM: "Department Head (CM)"`,
  `Role.DEPARTMENT_HEAD_AGM: "Department Head (AGM)"`.
- `LOCAL_ADMIN_ASSIGNABLE_ROLES`'s exclusion comment updated to name both new roles (the list's actual
  contents -- the 7 working-level roles -- are unchanged; Department Heads still cannot self-assign either
  of these two roles, same as before the split).

**Backend (every existing Department-Head checkpoint, updated to accept either role via the existing
OR-based `require_roles(*roles)` / `user.has_role(*roles)` helpers -- no new helper needed):**
- `routers/auth.py` -- both Local Admin endpoints' gates (`GET`/`PATCH /api/auth/local-admin/users...`).
- `routers/suppression.py` -- the Department Head decision-endpoint gate, and the `has_role` edit-permission
  check.
- `routers/performance.py` -- the decision-endpoint gate, and both `has_role` edit-permission checks.
- `routers/functional.py` -- the decision-endpoint gate, and both `has_role` edit-permission checks.
- `routers/sast_dast.py` -- both `has_role` edit-permission checks, and both decision-endpoint gates (SAST's
  and DAST's, separately).
- `seed.py` -- demo user `depthead1` now seeded as `DEPARTMENT_HEAD_CM` (an arbitrary but explicit pick
  between the two, since they're equivalent; relabel to `DEPARTMENT_HEAD_AGM` locally if a demo AGM account
  is wanted instead).

**Frontend (mirrors the backend one-for-one, using the same OR-based variadic `hasRole(user, ...roles)`):**
- `constants.ts` -- `ROLE_LABELS` updated the same way as the backend; `LOCAL_ADMIN_ASSIGNABLE_ROLES`
  comment updated.
- Every `hasRole(user, 'DEPARTMENT_HEAD')` call site changed to `hasRole(user, 'DEPARTMENT_HEAD_CM',
  'DEPARTMENT_HEAD_AGM')`: `modules/functional/Functional.tsx` (2 sites), `modules/security/DAST.tsx` (2),
  `modules/security/SAST.tsx` (2), `modules/security/Suppression.tsx` (1),
  `modules/specialised-testing/Performance.tsx` (2), `modules/governance/DepartmentAdmin.tsx` (the page's
  own access gate), `components/Layout.tsx` (the "Department Admin" nav-item gate).

**Data migration (DML -- not run from this sandbox, no live DB connection; apply against the real Oracle
schema when this section is deployed):**
```sql
-- Every existing qap_user_roles row holding the old single role becomes CM by
-- default. CM was picked arbitrarily as the landing spot (the two roles are
-- authority-equivalent, so this changes nothing about what anyone can do) --
-- an Admin, or the affected person's own Department Head peer via the Local
-- Admin panel, should manually flip any row that should actually read AGM
-- immediately after this runs, so the position shown in future approval logs
-- is accurate from day one.
UPDATE qap_user_roles
   SET role = 'DEPARTMENT_HEAD_CM'
 WHERE role = 'DEPARTMENT_HEAD';
COMMIT;
```
No column-width change needed -- `qap_user_roles.role` is already `VARCHAR2(32)` (see section on
`UserRole` in `models.py`), and both `DEPARTMENT_HEAD_CM` (19 chars) and `DEPARTMENT_HEAD_AGM` (20 chars)
fit well within it, same as the existing `DEPARTMENT_HEAD_COE` (19 chars). No change to any workflow status
column or value -- this is a `Role`/user-assignment change only, not a request-entity schema change.

**Verified:** `python3 -m py_compile` across every changed backend file (`constants.py`, `routers/auth.py`,
`routers/suppression.py`, `routers/performance.py`, `routers/functional.py`, `routers/sast_dast.py`,
`seed.py`) -- clean; `npx tsc --noEmit -p .` -- clean; grepped the full codebase afterward for any
remaining bare `Role.DEPARTMENT_HEAD`/`hasRole(user, 'DEPARTMENT_HEAD')` reference outside of explanatory
comments -- none found; Documents and outputs copies re-synced and confirmed identical via `diff -rq`
(aside from the always-excluded `.env`/`uploads` runtime files).

## 121. Split `DEPARTMENT_HEAD_COE` role into `DEPARTMENT_HEAD_COE_CM` and `DEPARTMENT_HEAD_COE_AGM` (data migration)

**Request:** same split treatment as section 120, applied to the separate `DEPARTMENT_HEAD_COE` role (the
Executive COE / QA Sign-off final-approval role, distinct from the business-side Department Head role split
in section 120). Split into two roles with **identical authority** -- **"CM - COE"** and **"AGM - COE"**.
Not two approval steps: the QA Sign-off Executive COE checkpoint, and the QA-team-visibility checks that
key off this role, now accept *either* new role, OR'd together. Purely so approval logs show the exact
position of whichever Executive COE approved.

**Not touched by this change:** `DEPARTMENT_HEAD_CM`/`DEPARTMENT_HEAD_AGM` (section 120's unrelated
business-side split), and the workflow status codes that share the substring --
`DEPT_HEAD_COE_APPROVAL_PENDING`, `RETURNED_BY_DEPT_HEAD_COE`, `DEPT_HEAD_COE_REJECTED` -- which stay
exactly as spelled on the `QASignOff` entity; only the log entry recording *who* made the decision now
shows CM vs AGM.

**Backend (`constants.py`):**
- `Role.DEPARTMENT_HEAD_COE` removed; replaced with `Role.DEPARTMENT_HEAD_COE_CM =
  "DEPARTMENT_HEAD_COE_CM"` and `Role.DEPARTMENT_HEAD_COE_AGM = "DEPARTMENT_HEAD_COE_AGM"`.
- `ALL_ROLES` and `ROLE_LABELS` updated -- `Role.DEPARTMENT_HEAD_COE_CM: "CM - COE"`,
  `Role.DEPARTMENT_HEAD_COE_AGM: "AGM - COE"`.
- `LOCAL_ADMIN_ASSIGNABLE_ROLES`'s exclusion comment updated to name both new roles (the list's contents
  are unchanged -- a Department Head still cannot self-assign either Executive COE role).

**Backend (every existing checkpoint keyed off this role, updated to accept either via the same OR-based
`require_roles(*roles)` / `user.has_role(*roles)` helpers):**
- `routers/signoff.py` -- the Executive COE decision-endpoint gate (`executive_coe_decision`, still
  reachable at both its current path and its legacy `department-head-coe-decision` alias), and the
  `has_role` edit-permission check for the `DEPT_HEAD_COE_APPROVAL_PENDING` stage.
- `routers/dashboard.py` -- the `qa_team_roles` set on `GET /api/dashboard/qa-tester-workload` (Executive
  COE is QA-team-adjacent for this endpoint's purposes) now includes both new roles.
- `seed.py` -- demo user `exec1` now seeded as `DEPARTMENT_HEAD_COE_CM` (arbitrary pick between the two,
  same as section 120's `depthead1`).

**Frontend (mirrors the backend, using the same OR-based variadic `hasRole(user, ...roles)`):**
- `constants.ts` -- `ROLE_LABELS` updated the same way; `LOCAL_ADMIN_ASSIGNABLE_ROLES` comment updated.
- `Dashboard.tsx` -- `REQUESTS_TAB_HIDDEN_ROLES` (hides the "Requests" tab for Executive COE, same as
  before) and the `showTesterOverviewTab` role array both now list both new role codes instead of the old
  single one.
- `modules/governance/SignOff.tsx` -- `canExecutiveCoeDecide` changed to `hasRole(user,
  'DEPARTMENT_HEAD_COE_CM', 'DEPARTMENT_HEAD_COE_AGM')`.
- `modules/governance/DepartmentAdmin.tsx` -- explanatory comments updated to name both new roles (this
  page's own access/exclusion logic was already keyed off `LOCAL_ADMIN_ASSIGNABLE_ROLES`, not the COE role
  directly, so no functional change here beyond the comment text).

**Data migration (DML -- not run from this sandbox, no live DB connection; apply against the real Oracle
schema when this section is deployed):**
```sql
-- Every existing qap_user_roles row holding the old single COE role becomes
-- CM by default, same arbitrary-but-explicit convention as section 120.
-- Manually correct any row that should actually read AGM immediately after
-- this runs (via the regular Admin "Users & Access" page, since Executive
-- COE roles are Admin-only to assign -- Department Heads' Local Admin panel
-- cannot touch this role either before or after the split).
UPDATE qap_user_roles
   SET role = 'DEPARTMENT_HEAD_COE_CM'
 WHERE role = 'DEPARTMENT_HEAD_COE';
COMMIT;
```
No column-width change needed -- `qap_user_roles.role` is `VARCHAR2(32)`, and `DEPARTMENT_HEAD_COE_CM`
(22 chars) / `DEPARTMENT_HEAD_COE_AGM` (23 chars) both fit comfortably. No change to any `QASignOff` status
column or value -- this is a `Role`/user-assignment change only.

**Verified:** `python3 -m py_compile` across every changed backend file (`constants.py`, `routers/signoff.py`,
`routers/dashboard.py`, `seed.py`) -- clean; `npx tsc --noEmit -p .` -- clean; grepped the full codebase
afterward for any remaining bare `Role.DEPARTMENT_HEAD_COE`/`'DEPARTMENT_HEAD_COE'` reference outside of
explanatory comments -- none found; Documents and outputs copies re-synced and confirmed identical via
`diff -rq` (aside from the always-excluded `.env`/`uploads` runtime files).

## 122. A requester who also holds an approving role can no longer approve their own request (no schema change)

**Reported directly, with a concrete example:** a person who is a Requester in IT-Software and *also*
separately holds the SM role could approve their own request -- wearing two hats let them self-approve at
a checkpoint that's supposed to be an independent check. Wanted: block this everywhere it can happen, so a
*different* person holding the same approving role for that department has to decide it instead. Same
principle applies to every two-tier approval chain in the app, not just SM: Department Head, and the
analogous QA Lead / Executive COE chain on QA Sign-off.

**Root cause:** every SM/Department Head/QA Lead/Executive COE decision endpoint already checked the
*role* (`require_roles`) and, for the business-side ones, the *department* (`require_same_department`) --
but nothing checked whether the approver **is the same person who raised the request**. Those are
orthogonal checks: `require_same_department` only compares departments, so a Requester who also holds SM
for their own department sailed straight through it.

**Backend -- new shared helper, `deps.py`:**
```python
def require_not_requester(current_user: models.User, requester_id) -> None:
    if current_user.has_role(Role.ADMIN):
        return
    if not requester_id:
        return
    if current_user.id == requester_id:
        raise HTTPException(status_code=403, detail="You raised this request yourself, so you cannot "
            "also be the one to approve it at this checkpoint -- ask another person who holds this "
            "approval role to decide it.")
```
Mirrors `require_same_department`'s existing conventions exactly: ADMIN always bypasses (consistent with
every other permission check in the app), and a missing/`None` id skips the check rather than blocking
everyone (nothing meaningful to compare against on a standalone request with no linked requester).

**Wired into every SM/Department Head/QA Lead/Executive COE decision endpoint, right alongside the
existing `require_same_department` call (called with each entity's own requester-identifying column):**
- `routers/functional.py` -- `sm_decision`, `department_head_decision` (`obj.requester_id`).
- `routers/sast_dast.py` -- the shared `_sm_decision`/`_department_head_decision` helpers, which back both
  SAST's and DAST's endpoints (`obj.requester_id`) -- 2 edits cover all 4 live endpoints.
- `routers/performance.py` -- `sm_decision`, `department_head_decision` (`obj.requester_id`).
- `routers/suppression.py` -- `sm_decision`, `dept_head_decision` (`obj.created_by_id` -- this module
  tracks who raised the request under a differently-named column than the other five).
- `routers/signoff.py` -- `qa_lead_decision`, `executive_coe_decision` (`obj.requester_id`); this router
  didn't previously import `require_same_department` at all (QA Sign-off's QA Lead/Executive COE
  checkpoints are QA-department-scoped via its own `_require_qa_department`, not the business-side
  helper), so only `require_not_requester` was added here, not `require_same_department`.

**Deliberately NOT touched:** the "Requester Decision" step (Accepted/Changes Required) on a completed
Functional request -- that one is *supposed* to be the requester acting on their own request, it's not an
independent-approval checkpoint. Also not touched: Security Team Verification on Suppression and the
QA-side readiness/execution steps (QA Lead/QA Engineer/Security Analyst work) -- those are QA-team task
execution on someone else's request, not a second independent sign-off on the same person's own request in
the sense reported here.

**Frontend (defensive UX -- hides the Approve/Return/Reject panel instead of letting someone click it and
just get a 403; the backend check above is what actually enforces this):**
- `modules/functional/Functional.tsx`, `modules/security/SAST.tsx`, `modules/security/DAST.tsx`,
  `modules/specialised-testing/Performance.tsx` -- new `isSelfApproval = req.requester_id === user?.id &&
  !isAdmin` (or the local admin-check equivalent), ANDed into both `canSMDecide` and
  `canDeptHeadDecide`/`canDepartmentHeadDecide`.
- `modules/security/Suppression.tsx` -- same pattern, using `sup.created_by_id` to match the backend's
  column choice for this module.
- `modules/governance/SignOff.tsx` -- same pattern (`item.requester_id`), ANDed into `canQALeadDecide` and
  `canExecutiveCoeDecide`.
- Admin still sees and can use every decision panel even when they happen to be the request's own
  requester, matching the backend's ADMIN bypass -- deliberately not blocking Admin, consistent with every
  other permission check in the app.

**No schema change** -- this reads existing `requester_id`/`created_by_id` columns that were already
present; no new column, no migration DML needed. **Verified:** `python3 -m py_compile` across every changed
backend file (`deps.py`, `routers/functional.py`, `routers/sast_dast.py`, `routers/performance.py`,
`routers/suppression.py`, `routers/signoff.py`) -- clean; `npx tsc --noEmit -p .` -- clean; Documents and
outputs copies re-synced and confirmed identical via `diff -rq` (aside from the always-excluded
`.env`/`uploads` runtime files).

## 123. Application Name approval becomes two-tier: Application Owner, then SM (schema change)

**Request:** when a brand-new Application Name is introduced (typed via "Other" on the QA Request wizard),
route its approval to an Application Owner from the same department FIRST; only once they approve should
it move on to SM for the existing (and still final) approval step. Both tiers carry the same authority to
Reject outright. Confirmed directly: an Application Owner is scoped by department exactly like SM already
is (no separate "who owns this specific application" concept exists anywhere in the schema, so this reuses
the same `department` field/`require_same_department` mechanism SM approval already uses), and a Reject at
either tier is final/terminal, identical to how SM's reject already works.

**Backend (`constants.py`):**
- `APPLICATION_MASTER_STATUSES` changed from `["PENDING", "APPROVED", "REJECTED"]` to
  `["PENDING_APP_OWNER", "PENDING_SM", "APPROVED", "REJECTED"]`; `APPLICATION_MASTER_STATUS_LABELS` updated
  to match ("Pending Application Owner Approval" / "Pending SM Approval" / "Approved" / "Rejected").
- New `application_name_block_message(app_status, stage)` helper -- shared, tier-aware wording for the 6
  duplicated SM/Department-Head decision guard clauses (see below) that block a request's own Approve until
  its Application Name reaches APPROVED; now correctly distinguishes "still waiting on Application Owner"
  from "waiting on SM" instead of always assuming SM is the one blocking it.

**Backend (`models.py` -- `ApplicationMaster`):**
- `status` default changed from `"PENDING"` to `"PENDING_APP_OWNER"`.
- New columns: `app_owner_decided_by_id` (FK `qap_users.id`), `app_owner_decided_at`, `app_owner_comments`
  -- the Application Owner tier's own decision record, parallel to the existing `decided_by_id`/
  `decided_at`/`comments` (kept as the SM/final-decision tier). If an Application Owner **rejects**, that
  IS the final decision on the name, so BOTH sets of fields get populated (app_owner_* for this tier's own
  record, and decided_by_id/decided_at/comments so anything reading those as "the decision that made this
  terminal" keeps working regardless of which tier actually rejected it). If an Application Owner
  **approves**, only the app_owner_* fields are set -- decided_by_id/decided_at/comments stay null until
  SM makes their own call.
- Docstring corrected: it previously (inaccurately) said the request's own SM Approval decision "is not
  gated on" the Application Name's status -- that stopped being true back in section covering "Disable
  Sign/Approve until Application Name is approved"; the docstring now describes the real (blocking)
  behavior and the two-tier chain.

**Backend (`schemas.py`):** `ApplicationMasterOut` gains `app_owner_decided_by_id`/`app_owner_decided_at`/
`app_owner_comments`.

**Backend (`routers/qa_requests.py` -- `_resolve_application_name`):** both places that used to set
`status="PENDING"` (a brand-new name, and a REJECTED name reopened by a fresh proposal) now set
`"PENDING_APP_OWNER"` instead -- a reopened REJECTED name re-enters the chain from the START (Application
Owner gets to look at it again too, not just SM), and also now resets the new `app_owner_decided_by_id`/
`app_owner_decided_at`/`app_owner_comments` fields to `None` alongside the existing SM-tier reset.

**Backend (`routers/applications.py`):**
- New `GET /api/application-names/pending-app-owner` -- `require_roles(Role.APPLICATION_OWNER, Role.ADMIN)`,
  lists `PENDING_APP_OWNER` rows, department-filtered for a non-Admin caller. Mirrors the existing
  `GET /pending` (now describes itself as the *second*-tier listing, `PENDING_SM` instead of the old bare
  `PENDING`) exactly one tier earlier.
- New `POST /api/application-names/{app_id}/app-owner-decision` -- `require_roles(Role.APPLICATION_OWNER)`,
  `require_same_department`, requires current status `PENDING_APP_OWNER`. Approve moves it to `PENDING_SM`
  (does NOT approve the name outright -- SM still has the final say). Reject is terminal: sets `REJECTED`,
  populates both tiers' decision fields (see models.py above), and reuses the existing
  `_auto_reject_linked_requests` helper with an Application-Owner-specific reason string, exactly like the
  SM endpoint already does.
- Existing `POST /{app_id}/decision` (SM, unchanged role gate): now requires current status `PENDING_SM`
  instead of the old bare `PENDING`; returns a clearer 400 ("still awaiting Application Owner approval")
  if someone tries to decide it while it's still at the first tier, instead of the old generic "already
  been '...'" message.

**Backend (6 guard-clause call sites, wording only -- the blocking *condition* itself,
`application_master_status not in (None, "APPROVED")`, needed no logic change since it already covers both
new intermediate statuses automatically):** `routers/functional.py` (`sm_decision`,
`department_head_decision`), `routers/sast_dast.py` (shared `_sm_decision`/`_department_head_decision`,
backing both SAST's and DAST's endpoints), `routers/performance.py` (`sm_decision`,
`department_head_decision`) -- all 6 now call `application_name_block_message(...)` instead of a hardcoded
string, so the message accurately says "still awaiting Application Owner" when that's the actual reason,
rather than always implying SM is the one who needs to act.

**Frontend:**
- `types.ts` -- `ApplicationMasterOut` gains the 3 new `app_owner_*` fields.
- `constants.ts` -- new `APPLICATION_MASTER_STATUS_LABELS` map (didn't exist before; the frontend had been
  hardcoding "Pending Approval" inline instead of a shared label constant).
- `components/ApplicationNameBanner.tsx` -- now tier-aware: renders for an Application Owner when status is
  `PENDING_APP_OWNER` (posting to the new `app-owner-decision` endpoint) or for an SM when status is
  `PENDING_SM` (posting to the existing `decision` endpoint), instead of unconditionally requiring the `SM`
  role. Banner copy adjusts per tier ("...before it moves on to SM for final approval" vs "...before it
  becomes a selectable option for everyone else"). The 5 module detail views' own wrapping condition
  (`{(sameDept || isAdmin) && <ApplicationNameBanner .../>}`) needed no change -- department scoping is
  identical for both tiers, so the banner component itself deciding which role/tier applies is sufficient.
- `QARequests/RequestDetail.tsx` -- the gateway Overview's Application Name badge now distinguishes
  "Pending Application Owner Approval" (yellow) from "Pending SM Approval" (yellow) instead of one generic
  "Pending Approval".
- `QARequests/steps/DetailsStep.tsx` -- wizard copy updated ("needs approval from an Application Owner,
  then an SM, both in your department" instead of just "an SM").

**Data migration (DDL + DML -- not run from this sandbox, no live DB connection; apply against the real
Oracle schema when this section is deployed):**
```sql
ALTER TABLE qap_application_master ADD app_owner_decided_by_id NUMBER(19);
ALTER TABLE qap_application_master ADD app_owner_decided_at    TIMESTAMP;
ALTER TABLE qap_application_master ADD app_owner_comments      CLOB;
ALTER TABLE qap_application_master ADD CONSTRAINT fk_appmaster_app_owner_decided_by
  FOREIGN KEY (app_owner_decided_by_id) REFERENCES qap_users(id);

-- Every existing row still holding the old single "PENDING" status becomes
-- PENDING_SM, NOT PENDING_APP_OWNER -- these are names that were already
-- submitted and are already in the queue under the old single-tier flow;
-- retroactively inserting an Application Owner step in front of something
-- already awaiting a decision would be disruptive and wasn't asked for.
-- Only brand-new names raised AFTER this section deploys go through the
-- full two-tier chain from the start (enforced by _resolve_application_name
-- creating new rows at PENDING_APP_OWNER going forward).
UPDATE qap_application_master
   SET status = 'PENDING_SM'
 WHERE status = 'PENDING';
COMMIT;
```
No width change needed on the existing `status` column (`VARCHAR2(20)`) -- `PENDING_APP_OWNER` (18 chars)
and `PENDING_SM` (10 chars) both fit comfortably.

**Verified:** `python3 -m py_compile` across every changed backend file (`constants.py`, `models.py`,
`schemas.py`, `routers/qa_requests.py`, `routers/applications.py`, `routers/functional.py`,
`routers/sast_dast.py`, `routers/performance.py`) -- clean; `npx tsc --noEmit -p .` -- clean; grepped the
full codebase afterward for any remaining bare `"PENDING"` (the old 3-state value) tied to
ApplicationMaster -- none found outside explanatory comments; Documents and outputs copies re-synced and
confirmed identical via `diff -rq` (aside from the always-excluded `.env`/`uploads` runtime files).

## 124. Evidence upload becomes mandatory for every readiness-checklist item that's mandatory OR self-declared checked (no schema change)

**Request:** "for mandatory checklist and whatever checklist is checked for that uploading of evidence is
mandatory" -- across Functional, SAST, DAST, and Performance's own readiness checklists, a checklist item
now needs at least one attached evidence document whenever EITHER `is_mandatory` is `True` OR the requester
has self-declared it checked (`requester_checked` is `True`). Previously the mandatory flag and the
self-declare tick were both purely informational -- an item could sail through Submit and QA-Lead
verification with zero evidence attached. Per-item evidence storage already existed (every checklist item
already has its own upload/list/download/delete endpoints keyed by the existing polymorphic convention
`RequestDocument(module="{X}_ITEM", request_id=<checklist_item.id>)` -- see section covering "Add document
upload to Sign-off raise flow" and the earlier per-module upload-gate work), so this is enforcement added on
top of storage that already existed -- no new column or table.

**Backend (`documents.py`):** new shared `require_checklist_evidence(db, checklist_items, item_module)` --
for every item where `is_mandatory or requester_checked` is true, checks `list_documents(db, item_module,
item.id)` is non-empty; raises 400 naming every item still missing evidence if any are found. Single shared
helper so the same rule and the same wording apply identically across all 4 modules.

**Backend (wired at two points per module -- Submit/Resubmit, and QA Lead verify-time):**
- `routers/functional.py` -- `submit_request` (right after the existing `_require(obj, DRAFT, "Submit")`
  check) and `resubmit_request`'s `RETURNED_BY_SM` branch both call
  `doc_store.require_checklist_evidence(db, obj.checklist_items, "FUNCTIONAL_ITEM")`. `update_checklist_item`
  (the QA Lead verify endpoint) blocks `is_complete=True` with a 400 if
  `not doc_store.list_documents(db, "FUNCTIONAL_ITEM", item.id)`, right next to the existing "requester
  hasn't self-declared it" check.
- `routers/sast_dast.py` -- new small `_require_checklist_evidence(db, obj)` wrapper (mirrors the existing
  `_require_checklist_ready` right above it) picks `"SAST_ITEM"` or `"DAST_ITEM"` based on
  `isinstance(obj, models.SASTRequest)`; called from the shared `_submit` and from `_resubmit`'s
  `RETURNED_BY_SM` branch, covering both SAST and DAST. Both `update_sast_checklist_item` and
  `update_dast_checklist_item` (the two separate QA Lead verify endpoints) each gained the same
  no-evidence-yet 400 check as functional.py, using their own module key.
- `routers/performance.py` -- identical pattern: `submit_performance` and `resubmit_performance`'s
  `RETURNED_BY_SM` branch call `doc_store.require_checklist_evidence(db, obj.checklist_items,
  "PERFORMANCE_ITEM")`; `update_checklist_item` gained the matching verify-time evidence check.
- Deliberately NOT wired into the self-declare/`checked_items` write path (too many disparate call sites --
  pre-raise draft staging, `edit_request`, each module's own Update endpoint, the wizard's draft flow --
  higher risk of an inconsistent gap than the two chosen, already-consistent checkpoints). A mandatory item
  that was never self-declared checked still gets caught by the `is_mandatory` half of the rule regardless,
  so nothing slips through Submit either way.

**Frontend (`components/Common.tsx` -- `ChecklistEvidence`):** two new optional props --
`required?: boolean` (renders a red "Evidence required" badge next to the uploader whenever `required` is
true and zero documents are attached) and `onCountChange?: (count: number) => void` (fires whenever the
loaded document count changes, so a parent view can react to it).

**Frontend (all 8 call sites across `Functional.tsx`, `SAST.tsx`, `DAST.tsx`, `Performance.tsx` -- both the
Edit Details self-declare modal and the read-only Checklist tab, one of each per module):**
- Every call site now passes `required={c.is_mandatory || c.requester_checked}`.
- The 4 Checklist-tab call sites (the QA Lead verify view) additionally track a new
  `evidenceCounts: Record<number, number>` state map (populated via each row's `onCountChange`) and extend
  the existing "Verified"/"QA verified" checkbox's `disabled`/`title` logic: on top of the pre-existing
  "requester hasn't self-declared it" block, the checkbox is now also disabled -- with an explanatory
  tooltip -- when the item needs evidence, isn't complete yet, and its reported evidence count is exactly
  `0`. This mirrors the backend's verify-time gate in the UI instead of only surfacing it as a 400 after the
  fact.

**Verified:** `python3 -m py_compile` on `documents.py`, `routers/functional.py`, `routers/sast_dast.py`,
`routers/performance.py` -- clean; `npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced
and confirmed identical via `diff -rq` (aside from the always-excluded `.env`/`uploads` runtime files).

## 125. Evidence-mandatory rule (previous section) now also blocks the requester at Raise time, not just at each module's own Submit (no schema change)

**Request:** "while requester raising the request, at that time if evidence not submitted, Block the
request raise" -- the previous section's rule (mandatory items, and any item self-declared checked, both
need at least one evidence document) was enforced at each linked module's own Submit/Resubmit and at QA Lead
verify-time, but NOT at the point where the requester first raises the gateway QA Request itself. Since
every linked child (Functional/SAST/DAST/Performance) now lands straight at `SM_APPROVAL_PENDING` the moment
the gateway is raised (see section covering "Change child-request creation to land directly at
SM_APPROVAL_PENDING") with no separate per-module Submit click of its own, the evidence gate has to be
enforced at raise time too -- otherwise a requester could raise the gateway with evidence still missing and
the linked child would be born already sitting at SM Approval despite that, identical in spirit to the
pre-existing mandatory-checklist gate this sits right next to.

**Backend (`routers/qa_requests.py`):**
- New `_pending_draft_checklist_evidence(db, req_id, kind, checked_set)` -- the raise-time counterpart to
  `documents.py::require_checklist_evidence`. At raise time the real per-item checklist rows don't exist yet
  (they're only created a few lines later by `_sync_linked_child_requests`), so this checks evidence against
  the staged draft-evidence keys instead (`_draft_evidence_module(kind, index)`, the same keys
  `ChecklistEvidencePicker`'s own upload/list/delete endpoints already use while the gateway is still a
  Draft). Same rule as everywhere else: an item needs evidence whenever it's mandatory OR the requester has
  self-declared it checked. Returns the item names still missing evidence.
- `raise_request` now calls this once per active request type (`"functional"`/`"sast"`/`"dast"`/
  `"performance"`, using each type's own `checked_items` set) right after the existing mandatory-checklist
  gate, and raises a 400 naming every item still missing evidence if any are found -- before
  `_sync_linked_child_requests` ever runs, so a request with missing evidence never gets its linked child(ren)
  created at all.
- Fixed an adjacent pre-existing bug while in this code: `pending_checklist_items` was being reset to `[]`
  right after the Functional Testing block populated it, silently discarding Functional's own mandatory-item
  results before the SAST/DAST blocks ran -- meaning the "mandatory item must be checked" gate for Functional
  Testing was dead code at raise time (Functional has no mandatory items by default so this was latent, but
  incorrect regardless). Removed the duplicate reset so all three types' pending items now correctly
  accumulate into one list.

**Frontend:**
- `QARequests/steps/ChecklistEvidencePicker.tsx` (used by the wizard's Functional/SAST/DAST/Performance
  steps while the gateway is still being drafted) gains the same `required?: boolean` prop and "Evidence
  required" badge as `components/Common.tsx`'s `ChecklistEvidence` from the previous section -- wired at all
  4 step call sites (`FunctionalStep.tsx`, `SastStep.tsx`, `DastStep.tsx`, `PerformanceStep.tsx`) as
  `required={ci.is_mandatory || checked}` (Performance has no mandatory items by definition, so its call site
  passes `required={checked}` only).
- `QARequests/RequestDetail.tsx` (the gateway's own Overview, where "Submit / Raise" lives) gains a new
  `draftEvidenceCounts: Record<string, number>` state, populated by a `useEffect` that -- only while the
  gateway is still in Draft -- fetches the evidence-document list for every checklist-definition index of
  every active request type via the existing `GET .../checklist-evidence/{kind}/{item_index}/documents`
  endpoint, keyed `"<kind>:<index>"`. A new `pendingEvidence` array (built the same way as the existing
  `pendingMandatory` array right above it, but checking `is_mandatory || requester_checked` against
  `draftEvidenceCounts` instead of just `is_mandatory` against the checked set, and covering all 4 request
  types instead of just SAST/DAST) drives a second warning banner ("Cannot Submit / Raise yet -- the
  following checklist item(s) need at least one evidence document attached first...") and extends the
  "Submit / Raise" button's existing `disabled`/`title` logic to also block on `pendingEvidence.length > 0`.
  This mirrors the backend's raise-time gate in the UI instead of only surfacing it as a 400 after the
  requester already clicked the button.

**Verified:** `python3 -m py_compile routers/qa_requests.py` -- clean; `npx tsc --noEmit -p .` -- clean;
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (aside from the
always-excluded `.env`/`uploads` runtime files).

## 126. Fixed: "Submit / Raise" didn't re-enable/disable after attaching or removing evidence, without a full page reload (no schema change)

**Request:** "without reloading raise button not enabling ever after all documents upload, same vice versa"
-- after attaching evidence via the "Edit Request" wizard, the "Submit / Raise" button on the gateway's own
Overview stayed disabled; removing evidence that had previously satisfied the requirement didn't re-disable
it either -- either way, only a full page reload made the button reflect reality.

**Root cause:** the previous section's `draftEvidenceCounts` state in `QARequests/RequestDetail.tsx` was
fetched by a `useEffect` keyed on `[req.id, req.status, req.request_types]`. `ChecklistEvidencePicker`
(inside the "Edit Request" wizard's checklist steps) uploads/deletes evidence immediately against the
backend the moment the requester clicks Attach/Remove -- it does not wait for the wizard's own Save, and
doesn't touch `req.id`/`status`/`request_types` either way. So neither closing the wizard after Save nor
just clicking away from it ever caused that effect's dependencies to change, meaning `draftEvidenceCounts`
(and therefore the `pendingEvidence` gate and the Submit/Raise button's `disabled` state) stayed frozen at
whatever it read on first mount until the whole component remounted via a page reload.

**Fix (`QARequests/RequestDetail.tsx`):** the inline fetch logic was pulled out into its own
`loadDraftEvidenceCounts` `useCallback` (still run once via `useEffect` on mount/status/type change, same as
before), and is now ALSO explicitly re-run from both of the "Edit Request" wizard's exit paths: its
`onClose` (closing without saving -- evidence may still have changed since attach/remove doesn't wait for
Save) and its `onCreated` (closing after Save). Re-running the same fetch/recompute on every exit covers
both directions the report described: attaching evidence now re-enables the button as soon as the wizard
closes, and removing previously-attached evidence now re-disables it the same way -- no reload needed
either way.

**Verified:** `npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced and confirmed
identical via `diff -rq` (aside from the always-excluded `.env`/`uploads` runtime files). Also checked
whether the equivalent QA-Lead "verify" checkbox gating added in the previous-previous section (Functional/
SAST/DAST/Performance's own Checklist tabs) has the same class of bug: it doesn't -- each of those 4
modules' Checklist tab is only ever mounted via `{tab === "checklist" && (...)}` conditional rendering, so
switching to that tab always remounts it and refetches live evidence counts fresh; there's no separate
top-level state living outside a remountable component the way `draftEvidenceCounts` did on the gateway.

## 127. Department Admin role-assignment split: business Department Heads vs. Executive COE assign different role subsets (no schema change)

**Request:** "Rest of the Team, other than QA team below roles will be there under department admin to assign
role: 1. Requester/Other 2. Business Analyst 3. Application Owner 4. SM. For QA team Executive CM AGM COE
can assign below role: 1. QA Engineer 2. QA Lead 3. Security Analyst." The existing "Local Admin" feature
(Department Admin page) let any business Department Head (CM/AGM) assign a single shared list of 7
working-level roles -- REQUESTER, BUSINESS_ANALYST, QA_ENGINEER, QA_LEAD, SECURITY_ANALYST,
APPLICATION_OWNER, SM -- to users in their own department, and the Executive COE (DEPARTMENT_HEAD_COE_CM/
DEPARTMENT_HEAD_COE_AGM) couldn't access the page at all. This splits that one shared list into two
disjoint sets, one per kind of local admin, and lets the Executive COE in as the QA department's own local
admin.

**Backend (`constants.py`):** `LOCAL_ADMIN_ASSIGNABLE_ROLES` replaced by two lists:
```python
DEPARTMENT_ADMIN_ASSIGNABLE_ROLES = [
    Role.REQUESTER, Role.BUSINESS_ANALYST, Role.APPLICATION_OWNER, Role.SM,
]
QA_ADMIN_ASSIGNABLE_ROLES = [
    Role.QA_ENGINEER, Role.QA_LEAD, Role.SECURITY_ANALYST,
]
```
`DEPARTMENT_ADMIN_ASSIGNABLE_ROLES` is what a business Department Head (DEPARTMENT_HEAD_CM/
DEPARTMENT_HEAD_AGM) may assign; `QA_ADMIN_ASSIGNABLE_ROLES` is what an Executive COE
(DEPARTMENT_HEAD_COE_CM/DEPARTMENT_HEAD_COE_AGM) may assign. No separate "which department is the QA
one" check was needed to scope the Executive COE to QA staff specifically -- the existing
`_require_own_department_target` department-equality check already does that for free, since Executive COE
accounts are mapped to `QA_DEPARTMENT` ("IT - QA") exactly like every other QA staffer (confirmed via
`seed.py`'s demo data).

**Backend (`routers/auth.py`):**
- Both `/local-admin/users` endpoints' `require_roles(...)` gate widened to also accept
  `Role.DEPARTMENT_HEAD_COE_CM`/`Role.DEPARTMENT_HEAD_COE_AGM`, alongside the existing
  `Role.DEPARTMENT_HEAD_CM`/`Role.DEPARTMENT_HEAD_AGM`.
- New `_local_admin_assignable_roles(current_user)` -- returns `QA_ADMIN_ASSIGNABLE_ROLES` if the caller
  holds either COE role, else `DEPARTMENT_ADMIN_ASSIGNABLE_ROLES`. Deliberately checks `current_user.roles`
  directly rather than `has_role()` -- `has_role()` always returns `True` for an Administrator account
  regardless of which role(s) it's asked about (see `models.User.has_role`), which would otherwise wrongly
  hand an Admin who somehow calls this endpoint the QA-only subset.
- `update_local_admin_user` now calls this helper once and uses its result everywhere
  `LOCAL_ADMIN_ASSIGNABLE_ROLES` used to be referenced directly -- both the "am I even allowed to assign
  these roles" validation, and the "preserve everything the target already holds outside my own authority"
  merge logic. The preserve step is what stops a business Department Head from silently stripping someone's
  QA_LEAD role (or an Executive COE from stripping someone's SM role) just because it wasn't in their own
  submitted list -- it was already there defending against ADMIN/DEPARTMENT_HEAD_* roles, and now also
  defends the OTHER kind of local admin's own subset the same way.

**Backend (`seed.py`):** fixed an adjacent pre-existing typo found while testing this feature --
`agm1` was seeded with `Role.DEPARTMENT_HEAD_COE_CM` (same as `cm1`) instead of
`Role.DEPARTMENT_HEAD_COE_AGM`, so there was previously no demo account to exercise the AGM side of the
Executive COE role at all.

**Backend (`schemas.py`):** `LocalAdminUserUpdate`'s docstring updated to describe the split instead of the
single old list name.

**Frontend:**
- `constants.ts` -- `LOCAL_ADMIN_ASSIGNABLE_ROLES` replaced by `DEPARTMENT_ADMIN_ASSIGNABLE_ROLES` and
  `QA_ADMIN_ASSIGNABLE_ROLES`, mirroring the backend exactly.
- `modules/governance/DepartmentAdmin.tsx` -- access gate widened to
  `hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM', 'DEPARTMENT_HEAD_COE_CM',
  'DEPARTMENT_HEAD_COE_AGM')`; a new `assignableRoles` (picked between the two lists based on whether the
  logged-in local admin holds a COE role) replaces every direct reference to the old single list -- the
  `RoleChipSelect`'s own `roles`/`value` props, and the "Also holds: ..." read-only summary of roles outside
  the acting admin's own authority. Page subtitle now reads "Assign QA team roles..." for an Executive COE
  vs. "Assign working-level roles..." for a business Department Head.
- `components/Layout.tsx` -- the "Department Admin" nav item now also renders for
  `DEPARTMENT_HEAD_COE_CM`/`DEPARTMENT_HEAD_COE_AGM`, not just `DEPARTMENT_HEAD_CM`/`DEPARTMENT_HEAD_AGM`.
- `modules/governance/Admin.tsx` -- comment on the shared `RoleChipSelect` component updated to reference
  both new lists instead of the old single one (no functional change -- `RoleChipSelect` already just takes
  whatever `roles` list is passed in).

**Verified:** `python3 -m py_compile constants.py schemas.py routers/auth.py seed.py` -- clean;
`npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced and confirmed identical via
`diff -rq` (aside from the always-excluded `.env`/`uploads` runtime files).

## 128. Renamed 4 role labels to their full titles (display text only, no schema/role-code change)

**Request:** rename "CM - COE" -> "Chief Manager - COE", "AGM - COE" -> "Assistant General Manager - COE",
"Department Head (CM)" -> "Chief Manager - Department", "Department Head (AGM)" -> "Assistant General
Manager - Department".

**Scope:** display-label-only change. The underlying role codes (`DEPARTMENT_HEAD_COE_CM`,
`DEPARTMENT_HEAD_COE_AGM`, `DEPARTMENT_HEAD_CM`, `DEPARTMENT_HEAD_AGM`) are unchanged, so every
`has_role`/`hasRole`/`require_roles` check, DB-stored role value, and API contract is unaffected -- this
only touches the human-readable string shown wherever `ROLE_LABELS[role]` is looked up (role chips, badges,
the Department Admin page, PDF exports, etc.).

**Backend (`constants.py` -- `ROLE_LABELS`):**
```python
Role.DEPARTMENT_HEAD_COE_CM: "Chief Manager - COE",       # was "CM - COE"
Role.DEPARTMENT_HEAD_COE_AGM: "Assistant General Manager - COE",  # was "AGM - COE"
Role.DEPARTMENT_HEAD_CM: "Chief Manager - Department",     # was "Department Head (CM)"
Role.DEPARTMENT_HEAD_AGM: "Assistant General Manager - Department",  # was "Department Head (AGM)"
```

**Frontend (`constants.ts` -- `ROLE_LABELS`):** same 4 values updated to match, byte-for-byte identical to
the backend strings.

Grepped the full codebase afterward for any other hardcoded occurrence of the 4 old label strings outside
this migration doc's own historical log entries (sections 120/121/266-269 above, describing what the labels
used to be at the time) -- none found; every other call site already goes through `ROLE_LABELS`.

**Verified:** `python3 -m py_compile constants.py` -- clean; `npx tsc --noEmit -p .` -- clean; Documents and
outputs copies re-synced and confirmed identical via `diff -rq` (aside from the always-excluded
`.env`/`uploads` runtime files).

## 129. Surfaced Department + Role(s) for the logged-in user in two places (frontend only, no schema change)

**Request:** "add one useful thing either add Department Name, and role assigned under the name or click of
the logged in user name." The sidebar's existing user-chip already showed Role(s) under the name but not
Department; the topbar's signed-in name (top-right) showed neither and wasn't clickable at all. Added both.

**`components/Layout.tsx` -- sidebar user-chip:** a new `.dept` line added under the existing `.role` line,
reading `user.department || 'No department set'` -- same fallback-copy convention already used for the role
line's `'No role assigned'`.

**`components/Layout.tsx` -- topbar user menu (new):** the topbar's signed-in name (`topbar-user-context`)
changed from a plain `<span>` into a clickable `<button>` that toggles a `userMenuOpen` state; when open, a
small popover renders below it (`topbar-user-popover`) showing the full name, Department, and Role(s) (all
roles joined, via the same `ROLE_LABELS` lookup used everywhere else), plus a "Log out" button -- useful
since the topbar stays visible even when the sidebar is collapsed or closed (mobile), unlike the sidebar's
own user-chip. Follows the same click-outside/Escape-to-close pattern already used by the table column
filter popovers in `components/Common.tsx` (`mousedown`/`keydown` document listeners, cleaned up on close),
via a new `userMenuRef` and two `useEffect`s; also closes automatically on route change (`useEffect` keyed
on `location.pathname`), same as the mobile sidebar-open state right above it.

**`index.css`:** new `.user-chip .dept` rule (sidebar), sized/coloured slightly smaller and dimmer than the
existing `.role` rule so Name > Role > Department reads as a clear hierarchy, plus matching size overrides
under the `.redesigned-shell` skin scope (mirroring how `.role` is already overridden there). New
`.topbar-user-menu`/`.topbar-user-caret`/`.topbar-user-popover*` rules for the topbar dropdown -- button
chrome reset on the now-clickable `.navigation-v2 .topbar-user-context` (background/border removed, hover
background added, cursor pointer) since it used to be a non-interactive `<span>`, plus a rotating caret icon
and a right-aligned absolutely-positioned popover card matching the app's existing card/shadow language
(`var(--shadow-lg)`, `var(--border)`).

**Verified:** `npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced and confirmed
identical via `diff -rq` (aside from the always-excluded `.env`/`uploads` runtime files).

## 130. Simplified every app-generated business ID from "{PREFIX}-{YYYYMMDD}-{6 random hex chars}" to "{PREFIX}-{n}" (schema change)

**Request:** "request id, testcase id basically every id is too complex, hard to remember. so make simple
id." Every human-facing ID this app generates itself (as opposed to the internal numeric `id` primary key)
went through one shared helper, `models.gen_id(prefix)`, producing IDs like `TQA-FUNC-20260802-9C3D0E` --
an 8-digit date plus 6 random hex characters bolted onto the prefix. Replaced with a short sequential
number instead: `TQA-FUNC-42`. Covers all 10 places this app assigns its own business ID: QA Request
(`request_id`, prefix `TQA-REQ`), Functional Testing Request (`request_id`, `TQA-FUNC`), SAST Request
(`request_id`, `SAST`), DAST Request (`request_id`, `DAST`), Performance Request (`request_id`, `PERF`),
Suppression (`suppression_id`, `SUP`), QA Sign-off Certificate (`certificate_id`, `QA-CERT`), Test Project
(`project_key`, `TPROJ`), Test Cycle (`cycle_key`, `CYCLE`), and Test Case (`test_case_key`, `TC`, only
when the user leaves the field blank -- they may still type their own arbitrary ID instead).

**Design:** each prefix gets its own dedicated Oracle `SEQUENCE`. A sequence's `NEXTVAL` is atomic and
monotonically increasing even under concurrent inserts from multiple app instances -- the same uniqueness
guarantee the old random-hex suffix provided, just short and rememberable instead. Deliberately NOT reusing
each table's own numeric `id` PK for this (e.g. `f"{prefix}-{row.id}"`) -- that would need a second
UPDATE statement after every insert (the Identity column's value isn't known until the row is actually
inserted), whereas a sequence's NEXTVAL can be fetched in a single extra `SELECT ... FROM dual` immediately
before the INSERT, keeping the existing one-line-per-model `Column(..., default=...)` shape intact. Existing
legacy-format IDs already in the database are left as-is (no backfill/rename) -- old values have TWO
hyphens after the prefix (`TQA-FUNC-20260802-...`), new ones have ONE (`TQA-FUNC-42`), so they're always
distinguishable and can never collide as strings; old and new formats simply coexist going forward.

**Backend (`models.py`):**
- New `ID_SEQUENCES` dict mapping each of the 10 prefixes to its own Oracle sequence name (e.g.
  `"TQA-REQ": "seq_tqa_req_id"`).
- New `_next_seq(prefix, executable)` -- runs `SELECT {seq_name}.NEXTVAL FROM dual` against whatever
  connection-like object is passed (works with both a raw `Connection` and an ORM `Session`, since both
  expose a compatible `.execute(text(...))`).
- `gen_id(prefix)` replaced by two functions: `gen_id(prefix, db)` (call directly with the active `Session`
  -- used by `routers/test_repository.py`'s two call sites, where a Test Case key is generated outside any
  Column default) and `gen_id_default(prefix)` (returns a context-sensitive Column default -- SQLAlchemy
  detects the returned closure's 1-argument signature and automatically supplies the `ExecutionContext` at
  flush/insert time, whose `.connection` is used to fetch `NEXTVAL`; a plain 0-arg default lambda, which is
  what every Column definition used before, has no access to a live connection).
- All 9 `Column(..., default=lambda: gen_id("X"))` definitions changed to
  `Column(..., default=gen_id_default("X"))`.
- `routers/test_repository.py`'s two direct calls changed from `models.gen_id("TC")` to
  `models.gen_id("TC", db)` (both call sites already have `db: Session` in scope).
- Removed the now-unused `import uuid` from `models.py` (nothing else in the file used it).

**Frontend:** no changes needed -- confirmed via research that every frontend dependency on these IDs
(topbar search's prefix router in `Layout.tsx`, exact-string-match lookups on `?open=<id>` deep links,
search placeholders) either does prefix `startsWith()` matching or full-string equality, neither of which
cares about the suffix's exact format.

**Data migration (DDL -- not run from this sandbox, no live DB connection; apply against the real Oracle
schema when this section is deployed):**
```sql
CREATE SEQUENCE seq_tqa_req_id   START WITH 1 INCREMENT BY 1 NOCACHE;
CREATE SEQUENCE seq_tqa_func_id  START WITH 1 INCREMENT BY 1 NOCACHE;
CREATE SEQUENCE seq_sast_id      START WITH 1 INCREMENT BY 1 NOCACHE;
CREATE SEQUENCE seq_dast_id      START WITH 1 INCREMENT BY 1 NOCACHE;
CREATE SEQUENCE seq_perf_id      START WITH 1 INCREMENT BY 1 NOCACHE;
CREATE SEQUENCE seq_sup_id       START WITH 1 INCREMENT BY 1 NOCACHE;
CREATE SEQUENCE seq_qa_cert_id   START WITH 1 INCREMENT BY 1 NOCACHE;
CREATE SEQUENCE seq_tproj_id     START WITH 1 INCREMENT BY 1 NOCACHE;
CREATE SEQUENCE seq_cycle_id     START WITH 1 INCREMENT BY 1 NOCACHE;
CREATE SEQUENCE seq_tc_id        START WITH 1 INCREMENT BY 1 NOCACHE;
```
`NOCACHE` chosen over Oracle's default sequence cache (20) deliberately -- these IDs are user-facing and
low-frequency (one per request/test case raised, not a hot-path bulk-insert column), so the small extra
cost of skipping the cache is worth guaranteeing no gaps ever appear from an instance restart discarding a
partially-used cache block; gaps wouldn't break anything (uniqueness is all that's required) but a smaller,
denser-looking number set is a better fit for "make it simple to remember." No column width change needed
on any of the 9 `String(40)` / 1 `String(60)` (`test_case_key`) target columns -- even a 10-digit sequence
value comfortably fits under the longest prefix (`"TQA-FUNC-" + 10 digits` is 19 characters).

**Verified:** `python3 -m py_compile` across the entire `backend/app` tree (every `.py` file, not just the
ones touched by this section) -- clean; `npx tsc --noEmit -p .` -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (aside from the always-excluded `.env`/`uploads` runtime
files).

## 131. Corrected the previous section's ID format to "{PREFIX}-{YYYYMMDD}-{n}", n resetting daily (schema change, supersedes 130's numbering scheme)

**Request:** Section 130's bare `"{PREFIX}-{n}"` format (e.g. `TQA-FUNC-42`) was rejected outright ("nope"),
with the actually-wanted format spelled out explicitly:
```
Functional QA   TQA-FUNC-20260801-1
SAST            TQA-SAST-20260801-1
DAST            TQA-DAST-20260801-1
Performance     TQA-PERF-20260801-1
```
i.e. keep the 8-digit date (dropped in section 130), and rename the SAST/DAST/Performance prefixes to sit
under the same `TQA-` namespace as `TQA-REQ`/`TQA-FUNC` (`SAST` -> `TQA-SAST`, `DAST` -> `TQA-DAST`, `PERF`
-> `TQA-PERF`). All four examples end in `-1`, read as the first request of that type raised that day --
i.e. `n` is a small counter that resets to 1 each day per prefix, not a number that grows forever (which is
also a better fit for "make it simple to remember" than an ever-growing count). The remaining 6 prefixes
the correction didn't call out by name (`TQA-REQ`, `SUP`, `QA-CERT`, `TPROJ`, `CYCLE`, `TC`) keep their
existing text but now follow the same date+daily-counter shape for consistency, e.g. `SUP-20260801-1`.

**Design:** an Oracle `SEQUENCE` (section 130's mechanism) has no built-in daily reset, so it's replaced by a
small counter table, `qap_id_counters` (`prefix`, `counter_date`, `next_value`; composite PK on
`prefix, counter_date`) -- one row per prefix per calendar day (IST), holding how many of that prefix have
been issued so far that day. Claiming the next number is a single atomic `MERGE` statement per ID: it inserts
the row with `next_value = 1` if today is this prefix's first ID, or increments the existing row's
`next_value` if not, and either way the row ends up holding the number just assigned. Oracle takes a row lock
during the `MERGE`, so a second concurrent request for the *same* prefix on the *same* day blocks until the
first transaction commits, then sees the already-incremented value -- no read-then-write race window, and
no risk of two requests handing out the same number. A trailing `SELECT next_value ... WHERE prefix=:p AND
counter_date=:d` (same transaction, same connection) reads back the value the `MERGE` just committed.

**Backend (`models.py`):**
- Removed the `ID_SEQUENCES` dict and `_next_seq()` (section 130's Oracle-`SEQUENCE`-based mechanism).
- New `IdCounter` model / `qap_id_counters` table (`prefix: String(20)`, `counter_date: Date`,
  `next_value: Integer`, composite primary key on the first two).
- New `_ist_today()` -- returns today's date in Asia/Kolkata (reuses the existing `now()` helper).
- New `_claim_daily_seq(prefix, executable, ist_date)` -- runs the `MERGE` then the follow-up `SELECT`
  described above, against whatever connection-like object is passed (a raw `Connection`, from a Column
  default's `ExecutionContext`, or an ORM `Session`, when called directly from router code).
- `gen_id(prefix, db)` and `gen_id_default(prefix)` (same two-function split as section 130, same reason: a
  Column default needs the 1-arg `ExecutionContext` form to reach a live connection) now build
  `f"{prefix}-{ist_date:%Y%m%d}-{n}"` instead of `f"{prefix}-{n}"`.
- Renamed 3 of the 9 `gen_id_default(...)` call sites: `gen_id_default("SAST")` ->
  `gen_id_default("TQA-SAST")` (SASTRequest), `gen_id_default("DAST")` -> `gen_id_default("TQA-DAST")`
  (DASTRequest), `gen_id_default("PERF")` -> `gen_id_default("TQA-PERF")` (PerformanceRequest). The other 7
  prefix strings (`TQA-REQ`, `TQA-FUNC`, `SUP`, `QA-CERT`, `TPROJ`, `CYCLE`, and `TC` in
  `routers/test_repository.py`'s two `gen_id("TC", db)` calls) are unchanged -- only the SAST/DAST/Performance
  prefixes were called out in the correction.
- Existing legacy-format IDs (both the original random-hex format from before section 130, and section 130's
  own short-lived bare `"{PREFIX}-{n}"` format) are left as-is, no backfill/rename -- all three formats have a
  different hyphen count/shape after the prefix and stay distinguishable as strings, so they coexist
  indefinitely with no collision risk.

**Frontend (`Layout.tsx`):** the topbar search box's `ID_PREFIX_ROUTES` table (routes a pasted/typed ID to
the right module by matching its prefix) hardcoded the old bare `SAST`/`DAST`/`PERF` prefixes -- updated to
`TQA-SAST`/`TQA-DAST`/`TQA-PERF` so search-by-ID keeps working for those 3 request types. Confirmed none of
the 5 `TQA-`-namespaced prefixes (`TQA-REQ`, `TQA-FUNC`, `TQA-SAST`, `TQA-DAST`, `TQA-PERF`) is a prefix of
another, so list order doesn't matter among them (each diverges right after `TQA-`). No other frontend code
depends on the ID suffix's exact shape (confirmed in section 130's research and unaffected by this change).

**Data migration (DDL -- not run from this sandbox, no live DB connection; apply against the real Oracle
schema when this section is deployed):**
```sql
DROP SEQUENCE seq_tqa_req_id;
DROP SEQUENCE seq_tqa_func_id;
DROP SEQUENCE seq_sast_id;
DROP SEQUENCE seq_dast_id;
DROP SEQUENCE seq_perf_id;
DROP SEQUENCE seq_sup_id;
DROP SEQUENCE seq_qa_cert_id;
DROP SEQUENCE seq_tproj_id;
DROP SEQUENCE seq_cycle_id;
DROP SEQUENCE seq_tc_id;

CREATE TABLE qap_id_counters (
    prefix        VARCHAR2(20)  NOT NULL,
    counter_date  DATE          NOT NULL,
    next_value    NUMBER(10)    NOT NULL,
    CONSTRAINT pk_qap_id_counters PRIMARY KEY (prefix, counter_date)
);
```
The 10 section-130 sequences are no longer read anywhere in the codebase (confirmed via a full-tree grep) --
safe to drop; if preferred, they can instead be left in place unused rather than dropped, since an idle
sequence costs nothing. `qap_id_counters` doesn't strictly need to be created by hand -- `Base.metadata.
create_all(bind=engine)` in `main.py` runs on every app startup and will create it automatically the first
time this code runs against a given schema -- the `CREATE TABLE` above is included for the schema record and
for anyone provisioning the table ahead of a deploy. No column width change needed on any target `request_id`/
`suppression_id`/`certificate_id`/`project_key`/`cycle_key`/`test_case_key` column -- the longest realistic
value, `"TQA-FUNC-" + 8-digit date + "-" + n`, stays well under every column's `String(40)`/`String(60)` limit
even with a multi-digit daily count.

**Verified:** `python3 -m py_compile` across the entire `backend/app` tree -- clean; `npx tsc --noEmit -p .`
across the entire frontend -- clean; Documents and outputs copies re-synced and confirmed identical via
`diff -rq`.

## 132. Removed the mandatory evidence-attachment gate; replaced with a non-blocking heads-up pop-up at Raise time (no schema change)

**Request:** "remove the logic of mandatory upload/attach of evidence" -- followed shortly after by a
mid-task refinement: rather than dropping the reminder entirely, "just during submit/raise give Information
message as pop-up requestee may ask to attach evidence for some of readiness checklist item, it's good to
provide upfront during request creation like this." So evidence is no longer required to Submit/Raise or to
QA-Lead-verify a checklist item, but the requester still gets a one-time, dismissible heads-up at Raise time
if some item(s) have nothing attached.

**Backend:**
- `documents.py`: removed `require_checklist_evidence()` entirely (no longer called from anywhere).
- `routers/functional.py`, `routers/performance.py`: removed the `doc_store.require_checklist_evidence(...)`
  call from both `submit`/`resubmit` (blocks Submit/Resubmit) and the checklist-item verify endpoint (blocked
  the QA Lead from marking an item complete with no evidence attached).
- `routers/sast_dast.py`: removed the `_require_checklist_evidence()` helper and its call sites in `_submit`/
  `_resubmit`, plus the equivalent evidence check in both SAST's and DAST's own verify endpoints.
  `_require_checklist_ready()` (the separate "mandatory items must be self-declared checked" gate) is
  untouched -- only the evidence-attachment requirement is removed.
- `routers/qa_requests.py`: removed the Raise-time `pending_evidence_items` block in `submit_request` (the
  gateway-level counterpart that blocked Raise before any linked child request was even created), and its
  now-unused `_pending_draft_checklist_evidence()` helper. The separate mandatory-checked-items gate
  (`pending_checklist_items`, scoped to SAST/DAST) is untouched.

**Frontend (`RequestDetail.tsx`):**
- Removed the red "Cannot Submit / Raise yet -- ... needs at least one evidence document" blocking banner
  and the corresponding `disabled`/`title` conditions on the "Submit / Raise" button.
- `draftEvidenceCounts` (per-checklist-item evidence-document count, loaded from the checklist-evidence
  endpoints) is kept, repurposed for the new non-blocking prompt below; the list of items with nothing
  attached is now named `itemsWithoutEvidence` rather than `pendingEvidence` to reflect that it's advisory,
  not a submit blocker.
- New `handleSubmitClick()`: if `itemsWithoutEvidence` is non-empty, opens a `ConfirmModal` ("Evidence not
  attached yet") listing those items, with "Raise Anyway" (proceeds to actually submit) and "Go Back" (just
  closes the pop-up, so the requester can attach evidence first if they choose) -- otherwise submits
  immediately, same as before this section. Wired to the "Submit / Raise" button's `onClick` in place of the
  previous direct `() => act("submit")`.
- `Functional.tsx`/`Performance.tsx`/`SAST.tsx`/`DAST.tsx`: removed each module's `evidenceCounts` state and
  the matching `((c.is_mandatory || c.requester_checked) && !c.is_complete && evidenceCounts[c.id] === 0)`
  clause that disabled the QA Lead's "Verified" checkbox until evidence existed (and the matching "No
  evidence document attached yet" title text) -- an item can now be verified as soon as the requester has
  self-declared it ready, evidence or not. The `ChecklistEvidence` component's `onCountChange` prop (now
  unused by these 4 call sites) and its `required` prop (still passed through, purely a visual "this item
  could use evidence" hint with no enforcement behind it) are otherwise untouched.

**Verified:** `python3 -m py_compile` across the entire `backend/app` tree -- clean; `npx tsc --noEmit -p .`
across the entire frontend -- clean; Documents and outputs copies re-synced and confirmed identical via
`diff -rq`.

## 133. Restored the missing "Application Name pending approval" status badge on the module detail views; made the SM block message tier-aware (frontend only, no schema change)

**Request:** the requester noticed the Application Name approval status used to be visible somewhere and is
now missing -- "Pending with SM is visible, but there was no such message ... after login with SM," while
logging in as an Application Owner did show a related block message ("Application Name is still pending
your decision above -- decide it before approving this request.").

**Root cause, part 1 (the actually-missing badge):** `constants.ts` already defines
`APPLICATION_MASTER_STATUS_LABELS` (`PENDING_APP_OWNER` -> "Pending Application Owner Approval",
`PENDING_SM` -> "Pending SM Approval"), and `QARequests/RequestDetail.tsx` (the QA Request gateway's own
detail view) already renders 3 badges next to its "Application Name" field for
`PENDING_APP_OWNER`/`PENDING_SM`/`REJECTED` -- but this was never carried over to the 4 module detail views
(`Functional.tsx`, `SAST.tsx`, `DAST.tsx`, `Performance.tsx`) where an SM or Department Head actually makes
their approve/reject decision. Those views showed nothing beyond the (separate) block message on the
Approve button itself -- no persistent status indicator, so someone landing on the Overview tab with the
Approve button not yet in view had no visible explanation. Fixed by adding the same 3 badges:
`Functional.tsx`/`Performance.tsx` already have their own "Application Name" `DetailField` (mirrors
`RequestDetail.tsx` exactly); `SAST.tsx`/`DAST.tsx` show the application name only in the modal title with
no separate field, so their badges were added to the "Status" `DetailField` instead, next to the existing
`needs_dept_head_reapproval` yellow badge, prefixed "Application Name ..." to stay unambiguous next to the
request's own Status badge.

**Root cause, part 2 (the misleading message):** the SM's own `signBlockedMessage` on `ApprovalDecisionButtons`
was a single hardcoded string -- "Application Name is still pending your decision above -- decide it before
approving this request." -- shown any time `application_master_status !== 'APPROVED'`, regardless of which
tier actually owns the pending decision. When the name is still sitting with the Application Owner (tier
`PENDING_APP_OWNER`), there is no "decision above" for the SM to make at all -- `ApplicationNameBanner` only
renders for whoever holds the CURRENT tier's role (`hasRole(user,'APPLICATION_OWNER')` at that tier, not
`SM`), so the message was actively wrong for an SM viewing the request at that point. New
`smApplicationNameBlockedMessage` (one per module, computed next to each file's own `applicationNameBlocking`)
picks the right wording: `PENDING_APP_OWNER` -> explains it's still with the Application Owner and where that
happens; `REJECTED` -> tells the SM the requester needs to pick a different name; anything else (i.e.
`PENDING_SM`, when it genuinely is the SM's own turn) -> the original "your decision above" wording, which is
accurate there. Wired into all 4 modules' `canSMDecide` `ApprovalDecisionButtons` in place of the static
string. The Department Head's own block message ("This request's Application Name is not yet approved by
SM.") was left as-is -- it's already tier-accurate as written, since Department Head is never a decider in
the Application Name chain at all.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean (no backend changes this section);
Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 134. Filled in Overview-tab gaps on SAST/DAST/Performance/Functional (Application Name field, Application Owner field) (frontend only, no schema change)

**Request:** "For SAST, DAST, and Performance overview tab lots of information missing like application
name," raised alongside a reminder that both an Application Owner and an SM get a turn at approving a
request's Application Name (the two-tier chain from section 133) -- i.e. both need enough information on
this same Overview tab to actually make that call.

**Audit:** compared each of the 4 request types' Overview tab against its own already-fetched `req` object
(every field below was already coming back from the API and typed in `types.ts` -- none of this needed a
backend change) and found two real gaps:
- `SAST.tsx`: `application_name` was never rendered as a field at all -- only visible in the modal's own
  title bar (`${req.request_id} — ${req.application_name}`), easy to miss, and with nowhere for section
  133's pending/rejected badges to attach to (they'd been bolted onto the unrelated "Status" field as a
  stand-in instead).
- `DAST.tsx`: had a field for it, but labeled "Application" rather than "Application Name" (inconsistent
  with the other 3 types), and section 133's badges were likewise bolted onto "Status" instead of this field.
- `Performance.tsx` and `Functional.tsx`: both have an `application_owner` field from the API
  (`req.application_owner`, delegated from the linked Application Master record same as `department`) that
  was fetched but never displayed anywhere on the Overview tab -- SAST/DAST already showed it, these two
  didn't.

**Fix:**
- `SAST.tsx`: added a proper "Application Name" `DetailField` to the "Application & Change" section (right
  where `RequestDetail.tsx`/`Functional.tsx`/`Performance.tsx` already put theirs), moved the 3
  pending/rejected badges from section 133 onto it from the "Status" field.
- `DAST.tsx`: relabeled "Application" -> "Application Name" for consistency, same badge move from "Status".
- `Performance.tsx`: added "Application Owner" to "Application & Change", next to Department.
- `Functional.tsx`: added "Application Owner" to "Application & Change", next to Department.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq`.

## 135. Application Name Approve/Reject decisions now show up on every relevant request's Activity tab (schema change: none, uses the existing ApprovalAction table)

**Request:** "Approval Name approval is never logging in activity, but this should be" -- an Application
Owner's or SM's Approve/Reject decision on an Application Name (see `routers/applications.py::
decide_app_owner_name` / `decide_application_name`, sections 133/134's banner and badges) left no visible
trace on any request's own Activity tab.

**Root cause:** neither decision endpoint ever wrote an `ApprovalAction` row for the decision itself.
Rejecting happened to leave an indirect trace -- `_auto_reject_linked_requests` force-rejects whatever
linked child request was still sitting at its own SM Approval checkpoint, logging a "SM Approval / Rejected"
entry for that -- but that reads as the *request* being rejected, not as the *name* being rejected, and only
fires for whichever child requests happened to be at that exact checkpoint at that exact moment. Approving a
name left no entry anywhere, ever, on any screen.

**Fix:** new `_log_application_name_decision(db, obj, tier_label, decision, current_user, comments)` in
`routers/applications.py`, called from both `decide_app_owner_name` (tier_label `"Application Owner"`) and
`decide_application_name` (tier_label `"SM"`), for both Approve and Reject. Since a single ApplicationMaster
row can be shared by more than one separately-raised QA Request (reusing the same "Other" name), and the
App Owner/SM banner plus the pending/rejected badge (sections 133/134) are shown on every request's own
detail screen that resolves to this name, the log entry is written against every one of them: every
`QARequest` gateway whose `application_master_id` matches this name (`entity_type="QA_REQUEST"`), plus each
of that gateway's own linked Functional/SAST/DAST/Performance requests (`entity_type` `"FUNCTIONAL_REQUEST"`/
`"SAST"`/`"DAST"`/`"PERFORMANCE"`) -- the same set of requests `_auto_reject_linked_requests` already walks
for the reject-cascade case, reused here for the new logging (unlike that function, this one runs
unconditionally, for both Approve and Reject). `step_name` is `"Application Name (Application Owner)"` or
`"Application Name (SM)"` so the two tiers read distinctly in the Activity feed; `decision`/`comments`/
`actor_id`/`actor_role` are the same fields every other `ApprovalAction` uses, so no frontend change was
needed -- `JiraActivity.tsx` already renders any `step_name`/`decision` pair generically
(`` `${item.decision} · ${item.step_name}` ``), e.g. "Approved · Application Name (SM)".

**Verified:** `python3 -m py_compile` across the entire `backend/app` tree -- clean; `npx tsc --noEmit -p .`
across the entire frontend -- clean (frontend unaffected, listed for completeness since JiraActivity's
generic rendering was double-checked); Documents and outputs copies re-synced and confirmed identical via
`diff -rq`.

## 136. "SM Approval Pending" no longer shown while the Application Name is still with the Application Owner (frontend only, no schema/status-lifecycle change)

**Request:** "while application name approval pending with Application Owner, status should not be SM
Approval Pending, this is misleading to user."

**Why this happens:** every linked Functional/SAST/DAST/Performance request is born straight at
`SM_APPROVAL_PENDING` the moment its gateway is raised (see section 130-era comments in
`routers/qa_requests.py::submit_request` -- there's no separate per-module Submit click anymore), regardless
of which tier the Application Name's own two-tier chain (section 133) happens to be sitting at. So a
brand-new "Other" name reads `PENDING_APP_OWNER` on the exact same request that already shows
`SM_APPROVAL_PENDING` as its status -- correct under the hood (confirmed backend-enforced, not just a UI
gate: `sm_decision` in `routers/functional.py`/`sast_dast.py`/`performance.py` already refuses an Approve
with `application_master_status not in (None, "APPROVED")`, so an SM genuinely cannot act while it's still
with the Application Owner), but misleading to *display* as "SM Approval Pending" when there's nothing for
the SM to actually do yet.

**Deliberately not a status-lifecycle change:** considered introducing a new status value the request sits
at while the name is still with the Application Owner, transitioning to `SM_APPROVAL_PENDING` once it clears
that tier -- rejected as unnecessarily invasive. `status === 'SM_APPROVAL_PENDING'` is read all over
(`canSMDecide`, `canEditDetails`, editable-status lists, the backend's own gating above, etc.); changing the
actual value would mean re-deriving all of that plus adding a new auto-transition trigger for something that
even the earlier `ApplicationNameBanner.tsx` docstring says by design "never touches the request's own
status." Fixed as a **display-only** override instead.

**Fix:** new `applicationNameAwareStatusLabel(status, applicationMasterStatus)` in `components/Common.tsx`
(next to `Badge`) -- returns `"Pending Application Owner Approval"` when `status === 'SM_APPROVAL_PENDING'`
and `applicationMasterStatus === 'PENDING_APP_OWNER'`, `undefined` otherwise (so `Badge` falls back to its
normal label lookup for every other case). Passed as `Badge`'s existing `label` prop -- doesn't touch
`status` itself, so every permission/gating check keeps reading the real value untouched, only what's
*shown* changes. Wired into every `<Badge status=... />` for a request that carries
`application_master_status`: the Status field and the list-table "Status" column on `Functional.tsx`/
`SAST.tsx`/`DAST.tsx`/`Performance.tsx` (8 call sites), plus the QA Request gateway's own "Linked Requests"
table in `RequestDetail.tsx` (every row there is one of that same gateway's own children, so they all share
its `application_master_status` -- no per-row value needed, `req.application_master_status` covers all of
them). Also fixed each module's "Pending With" list column the same way (`QA_PENDING_WITH`/
`SAST_DAST_PENDING_WITH`/`PERFORMANCE_PENDING_WITH[status]` all said `"SM"` for this exact case) --renders
`"Application Owner"` instead whenever `applicationNameAwareStatusLabel` fires.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean (no backend changes this section);
Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 137. Functional Testing Request's lifecycle stepper now shows an "Application Owner" step while the name is pending with them (frontend only, no schema change)

**Request:** a screenshot of `Functional.tsx`'s Overview tab stepper (Draft -> SM Approval -> Dept. Head
Approval -> QA Activity -> Sign-off -> Closed, with "SM Approval" highlighted as current) with the request:
"dynamic add Application Owner lifecycle here while application owner pending" -- the same underlying issue
as section 136 (the request's own `status` is already `SM_APPROVAL_PENDING` while the Application Name is
still genuinely sitting with the Application Owner), this time on the stepper rather than the Status badge.

**Fix:** `LifecyclePreview` (the stepper component, `Functional.tsx` only -- this is the only one of the 4
module types with this kind of stepper; SAST/DAST/Performance have no equivalent, and the QA Request
gateway's own `GatewayPreview` only covers Draft/Submitted/Raised, no SM Approval stage to conflict with)
now takes an optional `applicationOwnerPending` prop. When true AND the computed stage index is 1 (the "SM
Approval" stage -- covers `SUBMITTED`/`SM_APPROVAL_PENDING`/`RETURNED_BY_SM`), it inserts an extra
"Application Owner" step immediately ahead of "SM Approval" (`[Draft, Application Owner, SM Approval, Dept.
Head Approval, QA Activity, Sign-off, Closed]`, 7 steps instead of the usual 6) and highlights that new step
as the current one instead of "SM Approval". Every other case -- name already resolved, rejected, or no
`ApplicationMaster` row at all (older requests) -- renders the original 6-stage list untouched, so this only
ever appears for the exact sub-step it describes and collapses back on its own the moment the name clears
Application Owner tier. Wired at the call site: `applicationOwnerPending={req.application_master_status ===
"PENDING_APP_OWNER"}`.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean (no backend changes this section);
Documents and outputs copies re-synced and confirmed identical via `diff -rq`.


## 138. Removed the `REGRESSION_TESTING` status from the Functional Testing Request lifecycle (schema-relevant: no column change, but see data note below)

**Request:** "remove REGRESSION_TESTING status."

**State-machine analysis before removing anything:** `REGRESSION_TESTING` was a single, fully optional side
spur off `RETESTING` -- `RETESTING -> REGRESSION_TESTING` via `POST /{req_id}/start-regression` (the ONLY
way in), and `REGRESSION_TESTING -> QA_COMPLETED` via `POST /{req_id}/complete-qa`, which already also
accepted `RETESTING` directly as one of its source statuses (the only way out). Nothing else transitioned
into or out of it. That means `RETESTING -> QA_COMPLETED` already existed and fully covers what
`REGRESSION_TESTING` added -- removing it needed no new transition, no state-machine surgery, just deleting
the one spur and every list/map that referenced it.

**Backend:**
- `constants.py`: removed `QAStatus.REGRESSION_TESTING`, dropped it from `QA_REQUEST_STATUSES` and
  `QA_REQUEST_STATUS_LABELS`, reworded the `QAStatus` class docstring ("defect-fix-retest-regression cycle"
  -> "defect-fix-retest cycle").
- `routers/functional.py`: deleted the `start_regression` endpoint (`POST /{req_id}/start-regression`)
  entirely -- its only purpose was creating this status. `complete_qa`'s accepted-source-status list dropped
  `REGRESSION_TESTING` (already had `RETESTING`, so the direct path survives untouched); `_can_upload_documents`'s
  allowed-status tuple dropped it too.
- `routers/dashboard.py`: dropped from `ACTIVE_QA_STATUSES`, `TESTER_WORKLOAD_STATUSES`, and the two
  per-status label dicts feeding the 3W dashboard ("Regression Testing In Progress" stage label, "QA" stage-team
  mapping).

**Frontend:**
- `constants.ts`: dropped from `QA_STATUSES`, `QA_STATUS_LABELS`, `QA_PENDING_WITH`.
- `components/Common.tsx`: dropped the `REGRESSION_TESTING: "badge-purple"` Badge color-map entry.
- `Dashboard.tsx`: dropped from `STATUS_STAGE_INDEX` (the lifecycle-funnel chart's stage-3 grouping).
- `modules/functional/Functional.tsx`: dropped from `lifecycleStageIndex`'s stage-3 status list and
  `canCompleteQA`'s allowed-status list; removed `canStartRegression` entirely along with its "Start
  Regression Testing" button and its two other references (the "no actions available at this stage" fallback
  condition, and the "show the action-note input" condition) -- a tester at `RETESTING` now goes straight to
  "Mark QA Completed", the same direct path that already existed.

**Data note (not run from this sandbox, no live DB connection):** the `status` column itself is a plain
string (no DB-level CHECK constraint/enum), so this removal is purely an application-level validation
change -- no `ALTER TABLE` needed. However, if any live row currently holds `status = 'REGRESSION_TESTING'`
at deploy time, its next workflow action would be rejected (that value no longer appears in any `_require()`
allow-list). Recommended one-time cleanup immediately before deploying this section, if applicable:
```sql
UPDATE qap_functional_requests SET status = 'RETESTING' WHERE status = 'REGRESSION_TESTING';
```
(table name per `models.FunctionalRequest.__tablename__` -- confirm the actual table name against the live
schema before running). Existing `qap_approval_actions` history rows that mention "Regression Testing
Started" are left as-is -- they're an accurate historical record of what happened at the time and aren't
read by any status-list validation.

**Verified:** `python3 -m py_compile` across the entire `backend/app` tree -- clean; `npx tsc --noEmit -p .`
across the entire frontend -- clean; grepped both trees post-change to confirm zero remaining
`REGRESSION_TESTING`/`start-regression`/`canStartRegression` references; Documents and outputs copies
re-synced and confirmed identical via `diff -rq`.

## 139. Full test-case definition in Test Execution + CR Number traceability

Selecting a test case in a Test Cycle now displays the complete reusable definition: Test Case ID,
Epic ID, CR Number, Feature ID, User Story ID, Test Type, Module, Priority, repository approval status,
scenario, pre-condition, description, last-updated time, all steps and expected results. The detail is
also available read-only when the project is inactive or the viewer cannot record results.

`cr_number` is a new optional Test Case field because the repository previously had no place to retain
that value. Run this once against an existing Oracle schema before deploying the updated backend:

```sql
ALTER TABLE qap_test_cases ADD (cr_number VARCHAR2(64));
```

Fresh schemas receive the column through `Base.metadata.create_all()`. The Excel parser accepts optional
`CR Number`, `CR ID`, or `Change Request` headers; older templates without one remain fully compatible.

## 140. Jira-style rich Actual Result with protected screenshots (no schema change)

Test Execution's Actual Result now uses the same safe Markdown formatting model as Jira-style Activity
comments: bold, italic, underline, strikethrough, bulleted/numbered lists, quotes and code. QA users may
paste screenshots from the clipboard or select up to eight PNG/JPEG/GIF/WebP images per save (10 MB each).
Images are stored as authenticated `qap_module_documents` rows under module `TEST_EXEC_IMAGE`, linked to
the exact `qap_test_executions.id`; list/download/delete endpoints never expose the upload folder publicly.
Existing plain-text Actual Result values remain compatible and render normally. No Oracle DDL is required.


## 139. Extracted shared rich-text editor mechanics out of JiraActivity.tsx/JiraRichTextField.tsx into a new RichTextEditor.tsx (frontend only, no backend/schema change)

**Request:** "JiraActivity.tsx and JiraRichField.tsx mostly have the same common functionality then why
separate files and duplicate code?" -- confirmed on inspection: the two files are genuinely different
features (`JiraActivity.tsx` is a full comment/activity-feed composer that fetches history and posts to
`/api/approvals/{entityType}/{entityId}/rich-comments`; `JiraRichTextField.tsx` is a plain controlled
rich-text form input used only by Test Execution's "Actual Result" field, with no feed/posting concept at
all) -- but roughly half of each file was the low-level contentEditable-editor mechanics, copy-pasted
almost verbatim between them: the markdown<->HTML codec (`textOf`/`listToMarkdown`/`styledMarkdown`/
`nodeToMarkdown`/`editorMarkdown`/`safeLink`, character-for-character identical), the formatting toolbar
JSX, pasted/attached-image validation (type/size/count limits), and the inline link-insertion flow.

**Fix:** new `frontend/src/components/RichTextEditor.tsx` holding all of that shared mechanics, consumed by
both files instead of duplicated:
- Pure codec functions: `editorContentToMarkdown` (was each file's own `editorMarkdown`),
  `markdownToEditorHtml` (was only in `JiraRichTextField.tsx` -- kept alongside its inverse rather than left
  on its own, even though only one current caller needs this direction), `safeRichTextLink` (was `safeLink`).
- `useRichTextImages(opts)` -- a hook owning pending-image state, validation (type/size/count, using the
  caller-supplied `tooLarge`/`tooMany` message text so each field's exact wording is preserved -- Activity's
  says "A comment can contain..."/"...10 MB image limit", Actual Result's says "Actual Result can contain...
  per save"/"...10 MB limit", no wording changed), clipboard-paste handling, and object-URL cleanup on
  unmount (previously duplicated per-file).
- `useRichTextLink(editorRef, onError)` -- the Add-Link toolbar flow (save/restore selection range, apply
  as a `createLink` command, validate the URL via `safeRichTextLink`).
- `RichTextToolbar`, `RichTextImageInput`, `RichTextLinkEditor`, `RichTextPastedImages` -- the shared JSX
  (formatting buttons, hidden file input, URL entry row, pasted-image preview strip), parameterized where
  the two callers' visible text genuinely differs (`ariaLabel`, `codeButtonTitle` -- Activity keeps "Inline
  code", Actual Result keeps "Code" -- `imageButtonTitle` -- Activity keeps "Attach images", Actual Result
  keeps "Upload images").

**One deliberate, additive behavior change:** `nodeToMarkdown` had two slightly different versions --
`JiraActivity.tsx`'s handled `H1`-`H6` (bolds the heading text); `JiraRichTextField.tsx`'s didn't (fell
through to the generic inline-style handler instead). Neither toolbar has a heading button, so this only
ever mattered for pasted external HTML containing headings -- an edge case, but there's no reason the two
editors should disagree on it. Used the more complete (Activity's) version as the single shared
implementation, so `JiraRichTextField`'s "Actual Result" field now also handles pasted headings correctly.
Everything else is behavior-for-behavior identical to before this section.

**`JiraActivity.tsx`** keeps everything genuinely specific to it: `MarkdownComment`/`inlineMarkdown` (posted
markdown -> displayed React, only ever needed for rendering the activity feed, not part of the duplication),
`CommentAttachments`, `actorLabel`/`relativeTime`/`initials`, the filter tabs, and the comment-posting flow.

**`JiraRichTextField.tsx`** keeps everything specific to being a controlled form field: seeding the editor
from an initial markdown `value` (via the now-shared `markdownToEditorHtml`), reporting pending images back
up via `onImagesChange`, and the character-count footer. Its previously-exported `PendingRichImage` type
(unused by anything outside the file) now lives in `RichTextEditor.tsx` instead.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; grepped `components/` to confirm
the markdown<->HTML codec functions (`textOf`/`listToMarkdown`/`styledMarkdown`/`nodeToMarkdown`) now exist
in exactly one place; Documents and outputs copies re-synced and confirmed identical via `diff -rq`.

## 140. Test Case versioning (1.0 -> 1.1 on re-approval)

**Request:** "Test Project we are not following testcase versioning, first time upload version 1.0,
then any modification and after approval version 1.1 like this. and TestCycle automatically will
updated the linked testcased to updated one."

**Root cause:** `TestCase` had a Draft/Active/Deprecated `status` but no version number at all, so a QA
Lead re-approving an edited case had no way to tell reviewers or execution teams that the definition had
changed since the last time it was Active. Separately, the "TestCycle should automatically use the
updated test case" half of the request was already true structurally -- `TestExecution` stores a live
`test_case_id` foreign key with no snapshot/copy of any field, so a cycle always reads the current
definition -- but this was invisible in the UI, since nothing displayed a version to prove it.

**Backend changes:**
- `models.py` `TestCase`: added `version_major` (`Integer`, default `1`) and `version_minor` (`Integer`,
  default `0`) columns, plus a computed `version` property (`f"{version_major}.{version_minor}"`),
  following the same `@property` convention already used there for `folder_name`/`created_by_name`.
- `routers/test_repository.py`: new `_apply_approval_version(db, obj)` helper. Called from both
  `review_test_case`'s APPROVE branch and `bulk_approve_test_cases`, immediately before setting
  `status = "Active"`. It checks whether a prior `ApprovalAction` row already exists for this case with
  `entity_type="TEST_CASE"` and `decision="Approved"`; if so this is a re-approval (the case was edited
  and reverted to Draft by `update_test_case`/`bulk_update_test_cases`'s existing "Resubmitted for
  review" logic), so `version_minor` is incremented by 1. The very first approval leaves the case at its
  starting 1.0. `create_test_case` and `import_test_cases` need no changes -- new cases simply take the
  column defaults (1.0).
- `schemas.py` `TestCaseOut`: added `version: str = "1.0"`, read from the model's `version` property (same
  mechanism as the existing `folder_name`/`created_by_name` fields). This flows through automatically to
  `TestExecutionOut`'s nested `test_case` field with no execution-schema changes needed.

**Frontend changes:**
- `types.ts`: added `version?: string` to `TestCaseOut`.
- `TestRepository.tsx`: added a "Version" `Field` next to "Workflow Status" in the create/edit/view form
  (`v{existing.version}`, gray badge, with a note that it bumps on QA Lead re-approval after an edit), and
  a "Version" column in the test case list table.
- `TestExecution.tsx`: added the version badge next to the test case key in the "Record Result" modal's
  heading, a dedicated "Version" detail field there noting the cycle always uses the live current
  definition (not a copy), and a "Version" column in the cycle's execution list table -- making the
  already-correct live-FK behavior visible, not just structurally true.

**Data notes:** no live DB connection from this sandbox; apply directly to Oracle before/with this
deploy:
```sql
ALTER TABLE qap_test_cases ADD (
  version_major NUMBER(10) DEFAULT 1 NOT NULL,
  version_minor NUMBER(10) DEFAULT 0 NOT NULL
);
```
Existing rows all default to 1.0 on migration -- correct, since none of them have a recorded re-approval
event to bump from.

**Verified:** `python3 -m py_compile` on `models.py`, `schemas.py`, `routers/test_repository.py` -- clean;
`npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies re-synced and
confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 141. Draft QA Request: scope visibility to requester + stop wasting request_id on cancel

**Request:** "While raising QA requests, if it is in Draft that should be under the requster only, also
why generating req id ? if i am cancelling draft then that reqid is actually wasting right ? then there
will be lot of garbage request id"

**Root cause (two separate bugs in the QA Request gateway's Draft handling):**
1. `GET /api/qa-requests` (list) and `GET /api/qa-requests/{id}` (detail), plus the gateway's history/
   export/documents endpoints, had no visibility scoping at all -- every authenticated user could see
   every other user's Draft QA Requests, including ones that were pure personal scratch work never
   intended to be raised.
2. `QARequest.request_id` used the same eager `gen_id_default(...)` Column-default pattern as every other
   business ID in the app, which fires at row-INSERT time. Since a QA Request row is created in Draft
   status the moment the wizard's first step is saved, this meant a real `TQA-REQ-YYYYMMDD-N` number was
   burned immediately -- even for a Draft that's cancelled a minute later without ever being raised,
   permanently leaving a gap in the sequence. (This is unlike the linked Functional/SAST/DAST/Performance
   child requests, whose own IDs are naturally never wasted this way, since those rows -- and therefore
   their own gen_id_default -- don't exist at all until the gateway is actually raised; see
   `_sync_linked_child_requests`.)

**Backend changes:**
- `routers/qa_requests.py`: new `_can_view_gateway(obj, user)` helper -- returns `True` for any non-Draft
  request (unchanged, department-wide visibility, consistent with every other module in this app), and
  for a Draft, only if `obj.requester_id == user.id` or the user is an Admin. Applied to: `list_requests`
  (Drafts belonging to someone else are filtered out of the query entirely, not just masked), `get_request`,
  `request_history`, `export_request`, `list_documents`, `download_document`, and
  `_draft_request_for_evidence` (covers the checklist-evidence list/upload/download/delete endpoints).
  Each returns 403 "This request is still in Draft and is only visible to its requester" for a
  detail-style call, or is silently excluded for the list.
- `models.py` `QARequest.request_id`: removed `default=gen_id_default("TQA-REQ")`, now `nullable=True` with
  no default -- stays NULL through Draft. Oracle's UNIQUE constraint allows any number of NULLs, so this
  doesn't block having several concurrent Drafts.
- `routers/qa_requests.py` `submit_request`: now the one and only place `request_id` is ever assigned --
  `if not obj.request_id: obj.request_id = models.gen_id("TQA-REQ", db)`, set right as the gateway is
  raised (Draft -> Submitted -> Raised), before `_sync_linked_child_requests` runs (a DAST target's
  placeholder URL references it). A cancelled Draft never reaches this line, so it never gets an ID at
  all -- no gap, nothing to explain in an audit later.
- New `_storage_key(req)` helper: `req.request_id or f"DRAFT-{req.id}"` -- the numeric PK is always
  present from row-creation, unlike request_id now. Used as the on-disk folder-name prefix for both
  general supporting-document uploads (`upload_documents`) and checklist-evidence uploads
  (`upload_draft_checklist_evidence`, which can *only* ever run while Draft, so it would otherwise always
  see `request_id = None` now). No migration/rename needed later -- each document's exact path is already
  recorded on its own `stored_path` column at upload time and is never re-derived from this key again, so
  files uploaded during Draft simply keep living under their `DRAFT-<id>` folder even after the request is
  raised.
- `export_request`: title/filename fall back to `f"Draft #{obj.id}"` when `request_id` is still None
  (reachable now that a Draft's own requester can export it).
- `schemas.py` `QARequestOut.request_id`: `str` -> `Optional[str] = None`.

**Frontend changes:**
- `types.ts` `QARequestOut.request_id`: `string` -> `string | null | undefined`.
- `RequestDetail.tsx`: new `displayId = req.request_id || \`Draft #${req.id}\`` used for the modal title,
  the PDF export filename, and the cancel-confirmation dialog (which, since cancel is Draft-only, would
  otherwise always have shown "Cancel null?").
- `NewRequestModal.tsx`: edit-mode modal title changed from `Edit ${editing.request_id}` (always null --
  editing is Draft-only) to `Edit Draft — ${editing.application_name}`.
- `QARequests/index.tsx`: the list table's "Request ID" column now renders `r.request_id || \`Draft
  #${r.id}\`` instead of a blank cell for Drafts.
- `Dashboard.tsx`: `toUnified`'s row-shape and the "My Requests & My Department" unified list apply the
  same `Draft #<id>` fallback so a Draft QA Request gateway row displays sensibly there too.

**Data notes:** no live DB connection from this sandbox; apply directly to Oracle before/with this
deploy:
```sql
ALTER TABLE qap_requests MODIFY (request_id NULL);
```
(The column was already nullable=True at the SQLAlchemy level in practice since Oracle VARCHAR2 columns
default to nullable unless declared otherwise, but this makes the intent explicit if a prior migration
added an explicit NOT NULL.) No backfill needed -- existing Raised/Submitted/Cancelled rows already have
whatever request_id they were given at creation time under the old eager scheme; only brand-new Drafts
created after this deploy will see the new NULL-until-raised behavior.

**Verified:** `python3 -m py_compile` on `models.py`, `schemas.py`, `routers/qa_requests.py`,
`routers/reports.py` -- clean; `npx tsc --noEmit -p .` across the entire frontend -- clean (caught and
fixed two knock-on type errors in `Dashboard.tsx` where `toUnified`'s helper type still required a
non-optional `request_id`); traced every `.request_id` reference against `models.QARequest` specifically
(not the linked Functional/SAST/DAST/Performance children, whose own IDs are unaffected) across both
backend and frontend to find every place that would have broken on a null value; Documents and outputs
copies re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers
differ).

## 142. Block document upload on a Cancelled QA Request

**Request:** "if the status is cencelled then why uploading document is enabled ? it should be disabled"

**Root cause:** `POST /api/qa-requests/{id}/documents` (the gateway's general supporting-document
upload, `upload_documents` in `routers/qa_requests.py`) only ever checked that the caller was the
request's own requester or an Admin -- it never checked `status` at all, so it kept accepting uploads
even after the gateway was Cancelled (a dead-end status with no further workflow of any kind). The
frontend's `AddDocuments` form (`RequestDetail.tsx`'s Documents tab) was rendered unconditionally too, so
the upload control stayed visible and enabled regardless of status.

**Backend changes:**
- `routers/qa_requests.py` `upload_documents`: added `if req.status == GatewayStatus.CANCELLED: raise
  HTTPException(400, "Documents cannot be uploaded to a cancelled request")`, right after the existing
  requester/admin permission check. Draft, Submitted, and Raised are all still allowed -- `AddDocuments`
  is explicitly meant to keep working after the gateway is raised (its own comment: "adding more
  supporting documents after the request has already been raised"), so only Cancelled is blocked.

**Frontend changes:**
- `RequestDetail.tsx`'s Documents tab: `<AddDocuments .../>` now only renders when `status !==
  "CANCELLED"`; a cancelled request shows "Documents cannot be added — this request has been cancelled."
  in its place instead.

**Data notes:** none -- permission/validation-only change, no schema impact.

**Verified:** `python3 -m py_compile` on `routers/qa_requests.py` -- clean; `npx tsc --noEmit -p .` across
the entire frontend -- clean; Documents and outputs copies re-synced and confirmed identical via `diff
-rq` (only the standard `.env`/`uploads/` leftovers differ, including the new `DRAFT-<id>` folder pattern
introduced in section 141).

## 143. Close remaining Draft QA Request visibility leaks (Reports + Approval Workflow Log)

**Request:** "still draft issue not fixed, if i am raising the request, and it is in draft then this
should be visible to me only, not others untill i submit the request" (follow-up to section 141, which
scoped the QA Requests list/detail/history/export/documents endpoints, but missed two other pages that
read the same underlying data through a different path).

**Root cause:** Section 141 scoped every endpoint directly under `/api/qa-requests`, but two other
pages -- both reachable by *any* logged-in user, with no role gate at all in `Layout.tsx`'s nav (`Reports
& Export Centre` and `Approval Workflow Log`) -- read the same `QARequest` rows and `ApprovalAction` log
entries through their own, entirely separate, unfiltered queries:
- `routers/reports.py`'s `qa_request_summary` (`GET /api/reports/qa-request-summary`, the "QA Request
  Summary" operational report) did `db.query(models.QARequest).all()` with no filter at all -- one row
  per request, Request ID/Application Name/Department/Status included, for every Draft belonging to
  every user.
- `routers/reports.py`'s `monthly_kpi` and `quality_scorecard` similarly counted every Draft into
  "Total QA Requests" and the per-application scorecard, regardless of owner.
- `routers/approvals.py`'s `list_approvals` (`GET /api/approvals`, the "Approval Workflow Log" cross-entity
  audit feed) did `db.query(models.ApprovalAction)` with no filter beyond the caller-supplied
  `entity_type`/`entity_id`, so every "Drafted"/"Cancelled" QA_REQUEST audit row -- written by
  `routers/qa_requests.py::_log` on every Draft save/cancel -- was visible to anyone, along with the
  resolved business ID via `_resolve_request_ref`.

**Backend changes:**
- `routers/reports.py`: new `_visible_qa_requests(db, current_user)` helper -- same rule as
  `routers/qa_requests.py::_can_view_gateway`: a Draft row is only included if `requester_id ==
  current_user.id` or the caller is an Admin; every non-Draft row is unaffected. Applied to
  `qa_request_summary`, `monthly_kpi`'s `total_requests` count, and `quality_scorecard`'s app list/
  per-app request count (both now built from one shared `_visible_qa_requests(...).all()` call instead of
  two separate unfiltered queries).
- `routers/approvals.py`: `list_approvals` now pulls a larger internal batch (2000 rows instead of the
  final 500), then -- for non-Admins -- drops any `QA_REQUEST`-type row whose underlying gateway is still
  Draft and not the caller's own, before trimming to the usual 500 most recent. `entity_id`-scoped queries
  (`?entity_type=QA_REQUEST&entity_id=<id>`) are covered by the same check, so a direct lookup of someone
  else's Draft's history can't bypass it either. `my_recent_actions` (`/pending-mine`) needed no change --
  it was already scoped to `actor_id == current_user.id`.

**Data notes:** none -- read-path filtering only, no schema impact.

**Verified:** `python3 -m py_compile` on `routers/reports.py`, `routers/approvals.py` -- clean; `npx tsc
--noEmit -p .` across the entire frontend -- clean (no frontend changes needed, both pages just render
whatever JSON the API returns); re-audited every `db.query(models.QARequest)` call site across the whole
backend (`grep -rn "models\.QARequest)"`) to confirm no other unfiltered read path remains --
`applications.py`'s three call sites are internal audit-logging writes (fan out an approval decision to
every linked QA Request regardless of status), not a user-facing read, so they're correctly left alone;
`dashboard.py` and `export.py` never query `QARequest` directly at all. Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 144. Root cause found: Cancelled gateways were still department-wide visible

**Request:** "still draft issue not fixed !, requester 1's request is visible to requester 2." Follow-up
diagnosis (raw API response shared) showed the actual row: `"status": "CANCELLED"`, `"requester_id": 2`,
visible to a different logged-in requester on the QA Requests list page.

**Root cause:** Sections 141/143 correctly restricted **Draft** gateways to their own requester (or
Admin) everywhere -- `list_requests`, `get_request`, `request_history`, `export_request`,
`list_documents`, `download_document`, `_draft_request_for_evidence`, plus the Reports and Approval
Workflow Log endpoints. But `_can_view_gateway`'s check was `if obj.status != GatewayStatus.DRAFT: return
True` -- meaning Cancelled was treated exactly like Raised: fully department-wide visible. That's wrong.
`GATEWAY_CANCELLABLE_STATUSES = [GatewayStatus.DRAFT]` (`constants.py`) means `cancel_request` can only
ever fire while a gateway is still Draft -- there is no code path from Raised to Cancelled. So a Cancelled
gateway is, by construction, always a Draft that the requester abandoned before ever raising it: it never
got a `request_id`, never spun off a single linked Functional/SAST/DAST/Performance request, and nobody
outside the requester was ever supposed to know it existed. Reaching "Cancelled" doesn't change any of
that -- it's still 100% personal scratch work, not a real, department-relevant request.

**Backend changes:**
- `routers/qa_requests.py`: new module-level `_GATEWAY_PRIVATE_STATUSES = (GatewayStatus.DRAFT,
  GatewayStatus.CANCELLED)`. `_can_view_gateway` now checks `obj.status not in _GATEWAY_PRIVATE_STATUSES`
  instead of just `!= DRAFT`. `list_requests`'s inline OR-filter updated to
  `status.notin_(_GATEWAY_PRIVATE_STATUSES)`. All six 403 messages across the file reworded from "This
  request is still in Draft..." to "This request was never raised (still Draft, or Cancelled before being
  raised) and is only visible to its requester" -- accurate for both statuses now.
- `routers/reports.py`: `_visible_qa_requests` gained the same `_GATEWAY_PRIVATE_STATUSES` tuple and
  `.notin_(...)` filter (was `!= GatewayStatus.DRAFT`).
- `routers/approvals.py`: `list_approvals`'s hidden-QA_REQUEST-ids check now matches
  `status.in_((GatewayStatus.DRAFT, GatewayStatus.CANCELLED))` instead of only `== DRAFT`.

**Data notes:** none -- read-path filtering only, no schema impact. Any already-Cancelled gateway rows
from before this fix need no backfill; the new rule applies automatically based on their existing
`status`/`requester_id` values.

**Verified:** `python3 -m py_compile` on `routers/qa_requests.py`, `routers/reports.py`,
`routers/approvals.py` -- clean; `npx tsc --noEmit -p .` across the entire frontend -- clean (no frontend
changes needed -- the leak was entirely in what the API returned, not how it was rendered); confirmed via
the reported raw JSON (id 62, status CANCELLED, requester_id 2) that this exact row would now be excluded
from a different requester's `GET /api/qa-requests` response; Documents and outputs copies re-synced and
confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 145. Rejected by SM is now reopenable by the requester

**Request:** "Rejected BY SM should give chnace to requester with edit details to reopen." Confirmed
scope via follow-up: applies to Functional, SAST/DAST, Performance, and QA Sign-off (whose SM_REJECTED
status is internally labeled "Rejected by QA Lead" -- see SIGNOFF_STATUS_LABELS). Reopen behavior:
edit details, then send straight back to SM_APPROVAL_PENDING for a fresh decision -- the same path
"Returned by SM" already uses, reusing the existing resubmit endpoint rather than adding a new one.

**Root cause:** SM_REJECTED was treated as a genuine dead end everywhere -- absent from every module's
own *_EDITABLE_STATUSES list (so the requester couldn't even fix whatever caused the rejection), absent
from every resubmit endpoint's accepted-statuses list (so there was no way to send it back to the SM even
if they could edit it), and present in every module's own *_TERMINAL_STATUSES list (so dashboards/nav
counts treated it as finished, matching CLOSED/CANCELLED, rather than "waiting on the requester" the way
RETURNED_BY_SM already is).

**Backend changes (constants.py):**
- `FUNCTIONAL_EDITABLE_STATUSES`, `SAST_DAST_EDITABLE_STATUSES`, `PERFORMANCE_EDITABLE_STATUSES`,
  `SIGNOFF_EDITABLE_STATUSES`: added `SM_REJECTED` to each, alongside the existing `RETURNED_BY_SM`.
- `READINESS_EVIDENCE_EDITABLE_STATUSES` (Functional): added `SM_REJECTED` too, so readiness evidence can
  also be fixed up before reopening.
- `QA_REQUEST_TERMINAL_STATUSES`, `SAST_DAST_TERMINAL_STATUSES`, `PERFORMANCE_TERMINAL_STATUSES`,
  `SIGNOFF_TERMINAL_STATUSES`: removed `SM_REJECTED` from each (kept `DEPARTMENT_HEAD_REJECTED`/
  `DEPT_HEAD_COE_REJECTED` untouched -- only SM/QA-Lead-tier rejection was asked to become reopenable).
  Audited every real usage of each constant first (`QA_REQUEST_TERMINAL_STATUSES` turned out to be an
  unused/dead import in dashboard.py; `SAST_DAST_TERMINAL_STATUSES` actually drives the 3W ageing
  dashboard's "still outstanding" filter in routers/dashboard.py; `PERFORMANCE_TERMINAL_STATUSES` and
  `SIGNOFF_TERMINAL_STATUSES` had no other real usage) to confirm removing SM_REJECTED here couldn't
  silently break some other gate (e.g. a parent QA Request completion check) -- it doesn't; that
  cross-module gate was already decoupled in an earlier round (see functional.py's `complete_qa`
  docstring).
- `routers/dashboard.py`: added `QAStatus.SM_REJECTED` to `STAGE_LABELS` ("Rework by Requester Pending")
  and `STAGE_TEAM` ("Requester") so a rejected-but-reopenable Functional request shows up on the 3W
  ageing dashboard the same way a Returned one already does.

**Backend changes (routers):**
- `functional.py` `resubmit_request`, `sast_dast.py` `_resubmit` (shared by both SAST and DAST),
  `performance.py` `resubmit_performance`, `signoff.py` `resubmit_signoff`: each now accepts `SM_REJECTED`
  alongside `RETURNED_BY_SM` in its status gate, and branches on `reopening = obj.status == "SM_REJECTED"`
  to log a distinct "Reopened"/"...reopened and re-submitted" audit message instead of the Returned
  wording, while landing at the exact same `SM_APPROVAL_PENDING` (or re-auto-rejected, if the Application
  Name is still REJECTED in the meantime) outcome.
- `functional.py` `_can_edit_details`, `sast_dast.py` `_can_edit_details`, `performance.py`
  `_can_edit_details`: added `SM_REJECTED` to the requester-editable status tuple (signoff.py's
  `update_signoff` needed no equivalent change -- it already reads directly off
  `SIGNOFF_EDITABLE_STATUSES`). Each module's own `_can_upload_documents`-equivalent needed no change --
  all four already grant the original requester upload access unconditionally, regardless of status.

**Frontend changes (constants.ts):** mirrored every one of the above: `FUNCTIONAL_EDITABLE_STATUSES`,
`SAST_DAST_EDITABLE_STATUSES`, `PERFORMANCE_EDITABLE_STATUSES`, `SIGNOFF_EDITABLE_STATUSES` gained
`SM_REJECTED`; `QA_TERMINAL_STATUSES`, `SAST_DAST_TERMINAL_STATUSES`, `PERFORMANCE_TERMINAL_STATUSES`,
`SIGNOFF_TERMINAL_STATUSES` dropped it; `QA_PENDING_WITH`, `SAST_DAST_PENDING_WITH`,
`PERFORMANCE_PENDING_WITH` changed `SM_REJECTED` from `'—'` to `'Requester'`. `QA_ACTIVE_STATUSES` and
every nav-count/dashboard computation already derives from these lists, so they automatically start
counting a rejected-but-reopenable request as active/pending instead of closed, with no separate edit
needed.

**Frontend changes (Functional.tsx, SAST.tsx, DAST.tsx, Performance.tsx, SignOff.tsx):** each module's own
`canResubmit`/`canEditDetails` now include `SM_REJECTED`; the resubmit button's label switches to "Reopen
Request" (or "Reopen Certificate" for Sign-off) instead of "Re-submit" specifically when
`status === 'SM_REJECTED'`. SAST.tsx/DAST.tsx's existing "mandatory Security Readiness checklist not yet
self-declared" guard (previously only checked while `RETURNED_BY_SM`) now also covers `SM_REJECTED`, since
the backend's `_require_checklist_ready` gate applies identically to both when resubmitting/reopening.

**Data notes:** none -- status-transition/permission logic only, no schema impact. No backfill needed --
any already-`SM_REJECTED` row simply becomes reopenable going forward under the new rule; nothing about
its stored data needs to change.

**Verified:** `python3 -m py_compile` on `constants.py`, `routers/functional.py`, `routers/sast_dast.py`,
`routers/performance.py`, `routers/signoff.py`, `routers/dashboard.py` -- clean; `npx tsc --noEmit -p .`
across the entire frontend -- clean; grepped every remaining `SM_REJECTED` reference across both
frontend and backend to confirm nothing else (e.g. the shared Badge color map in Common.tsx, which
already used the same "badge-red" for both RETURNED_BY_SM and SM_REJECTED) needed a matching change;
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`uploads/` leftovers differ).

## 146. Test Execution now logs every attempt instead of overwriting the result

**Request:** "Test Lifecycle design is not correct, how multiuple execution will log? execution once
failed, i log with attachment, then next run it passed, so design like this." -- i.e. a test case's
execution result within a cycle is not a single fact that gets corrected in place; it is a sequence of
distinct test runs over time (Run 1: Fail, with a screenshot of the error; Run 2, after a fix: Pass),
and every prior attempt's result and evidence must remain on the record, not get silently overwritten by
the next one.

**Root cause:** `TestExecution` (one junction row per cycle + test case) stored `status`,
`actual_result`, `test_run_artifacts`, `defect_id`, `executed_by_id`, `executed_at` directly on itself as
mutable columns. Recording a new result (`PATCH /executions/{id}` or `POST
/executions/{id}/rich-result`) simply overwrote these columns in place, and the evidence images
(`RequestDocument`, module `TEST_EXEC_IMAGE`) were keyed by the parent `TestExecution.id` -- a single
shared bucket. So logging Run 2's Pass result silently destroyed Run 1's Fail result, its actual-result
text, and detached/re-mixed its screenshots with the next attempt's. There was no way to see "it failed
once, here's the evidence, then it passed."

**Backend changes (models.py):**
- New table `TestExecutionRun` (`qap_test_execution_runs`): one immutable row per concrete attempt --
  `id`, `execution_id` (FK to `qap_test_executions.id`), `attempt_no` (1, 2, 3, ... per execution),
  `status`, `actual_result`, `test_run_artifacts`, `defect_id`, `executed_by_id` (FK to
  `qap_users.id`), `executed_at`. Each attempt's own screenshots are stored the same way as before
  (`RequestDocument`, module `TEST_EXEC_IMAGE`) but keyed by this row's own `id` instead of the parent
  `TestExecution.id`, so attempt 1's evidence and attempt 2's evidence never mix.
- `TestExecution` gained a `runs` relationship (`cascade="all,delete-orphan"`, ordered by `attempt_no`).
  Its own mutable columns are kept, but are now a denormalized mirror of the *latest* attempt only, for
  backward compatibility with anything still reading `execution.status` etc. directly (dashboard
  aggregates, existing exports).

**Backend changes (schemas.py):**
- New `TestExecutionRunOut` (`id`, `execution_id`, `attempt_no`, `status`, `actual_result`,
  `test_run_artifacts`, `defect_id`, `executed_by_id`, `executed_at`).
- `TestExecutionOut` gained `runs: List[TestExecutionRunOut] = []`.

**Backend changes (routers/test_execution.py):**
- New `_migrate_legacy_result_if_needed(db, obj)`: lazily, on first attempt recorded against a
  pre-existing `TestExecution` row that predates this feature, synthesizes attempt #1 from that row's
  own already-stored columns and re-points its existing `RequestDocument`s (module `TEST_EXEC_IMAGE`,
  `request_id = obj.id`) onto the new synthetic run's id. This is a safe, one-line bulk `UPDATE` because
  `RequestDocument.request_id` is a plain `Integer`, not a foreign key, and `stored_path`/`folder_name`
  were never derived from it -- no physical file needs to move. This means no backfill migration script
  is required; the very first save against each old row performs its own migration on the fly.
- New `_record_attempt(db, obj, status, actual_result, test_run_artifacts, defect_id, current_user)`:
  calls the migration guard, computes the next `attempt_no`, inserts the new `TestExecutionRun`, then
  updates `obj`'s own mirrored columns to match. Both `PATCH /executions/{id}` and `POST
  /executions/{id}/rich-result` now go through this instead of mutating `obj` directly -- every save is
  an insert, never an overwrite.
- `POST /executions/{id}/rich-result` now saves uploaded evidence images keyed by the new run's `id`
  (`doc_store.save_documents(db, _RESULT_IMAGE_MODULE, run.id, ...)`), not the execution's `id`.
- New endpoints: `GET /executions/{id}/runs` (full attempt history, oldest first), `GET
  /executions/{id}/runs/{run_id}/images`, `GET .../runs/{run_id}/images/{document_id}/download`, `DELETE
  .../runs/{run_id}/images/{document_id}`.
- Existing `GET /executions/{id}/result-images`, its `download`/`delete` siblings: kept, now resolve to
  the *latest* run's evidence (running the same migration guard first) so any old integration hitting
  these unchanged URLs keeps working exactly as before.
- `DELETE /executions/{id}`: now also cleans up every historical run's evidence images (loops
  `obj.runs`), not just the legacy execution-keyed bucket, before deleting the execution itself
  (`cascade="all,delete-orphan"` removes the `TestExecutionRun` rows automatically).

**Frontend changes (types.ts):** new `TestExecutionRunOut` interface mirroring the backend schema;
`TestExecutionOut` gained `runs?: TestExecutionRunOut[]`.

**Frontend changes (modules/test-management/TestExecution.tsx):**
- New `ImageGallery` component: generic evidence viewer/uploader-cleanup parameterized by `basePath`, so
  the same code renders either the legacy "latest attempt" gallery or (via `/runs/{run_id}/images`) any
  specific historical attempt's own screenshots.
- New `AttemptHistory` component: fetches `GET /executions/{id}/runs` and renders every attempt, newest
  first, as a collapsible row -- attempt number, result Badge, defect ID, executed-at timestamp, and,
  expanded, that attempt's own actual-result text and its own `ImageGallery`.
- `RecordResultModal` reworked: no longer pre-fills its form from the execution's own (single, current)
  fields, since opening it now means logging a brand-new attempt, not editing the last one. It shows a
  "Latest result" summary Badge, the full `AttemptHistory`, and then (for users who can execute) a
  separate "Log New Attempt" form with its own blank Result/Actual Result/Test Run Artifacts/Defect ID
  fields and evidence upload, submitting to the unchanged `POST /rich-result` endpoint. Saving still
  closes the modal (as before), so the next time it's opened `AttemptHistory` naturally re-fetches and
  shows the new attempt already included.

**Data notes:** new table `qap_test_execution_runs` needs to be created in Oracle (no live DB connection
from this sandbox, so this is DDL-only, not executed):
```sql
CREATE TABLE qap_test_execution_runs (
    id            NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    execution_id  NUMBER NOT NULL REFERENCES qap_test_executions(id),
    attempt_no    NUMBER NOT NULL,
    status        VARCHAR2(20) NOT NULL,
    actual_result CLOB,
    test_run_artifacts VARCHAR2(255),
    defect_id     VARCHAR2(60),
    executed_by_id NUMBER REFERENCES qap_users(id),
    executed_at   DATE DEFAULT SYSDATE
);
CREATE INDEX ix_qap_test_execution_runs_execution_id ON qap_test_execution_runs(execution_id);
```
No backfill DML needed -- `_migrate_legacy_result_if_needed` synthesizes attempt #1 for any pre-existing
row lazily, the first time a new attempt is recorded against it.

**Verified:** `python3 -m py_compile app/routers/test_execution.py app/models.py app/schemas.py` --
clean; `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ,
plus the new `TEST_EXEC_IMAGE` folder already present in both).

## 147. Change Request ID / Epic Number inline error popping up multiple times

**Request:** "In New QA Request Form Change Request ID and Epic ID error message not behaving correctly
sometime showing multiple times."

**Root cause:** `steps/DetailsStep.tsx`'s onBlur handlers for both fields stored their "invalid format"
message in local `crError`/`epicError` string state, then rendered that string through the shared
`ErrorText` component -- but `ErrorText` (components/Common.tsx) doesn't render inline text at all, it
renders a full blocking `<Modal>` dialog (title, "The requested action was stopped", a "What to do"
panel, a Close button). That's the right component for a stopped save/submit action, but wrong for
simple per-field format validation: tabbing from Change Request ID straight into Epic Number, with both
still invalid, popped up two of these dialogs (one per field) essentially back to back / stacked, which
read as the same "invalid format" error showing multiple times. Separately, blurring an empty (not yet
typed-in) field also fired the "Invalid format. Example: CR-1234" message, which is misleading for a
field that's simply empty rather than malformed -- that's a mandatory-field question the wizard's own
`detailsStepError` "Please fill in: ..." gate already owns.

**Frontend changes (steps/DetailsStep.tsx):**
- Both fields now render their validation message as plain inline text (`<p className="small"
  style={{ color: 'var(--danger)' }}>`) directly under the input, instead of through `ErrorText`/`Modal`
  -- no more popup, so nothing can visually stack.
- Each field's `onChange` now clears its own error state as soon as the user starts correcting it,
  rather than leaving a stale message sitting under the field, unrelated to what's currently typed,
  until the next blur.
- `onBlur` now only runs the format check when the field actually has a value (`e.target.value &&
  ...`) -- an empty field blurring no longer shows "Invalid format", since that's not what's wrong with
  it.
- `ErrorText` import removed from this file (no longer used here); `validation.ts`'s
  `CR_NUMBER_REGEX`/`EPIC_NUMBER_REGEX` and the real submit/Next-blocking gate in `detailsStepError` are
  unchanged -- this was purely a presentation-layer fix for the inline hint, not the underlying
  validation rule.

**Data notes:** none -- presentation-only change, no schema/API impact.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 147. Test runner assignment and structured defect linking

`TestExecution` is now the managed testcase slot in a cycle: any QA Engineer or QA Lead in IT-QA assigns one active IT-QA runner,
and only that assignee (or an Administrator) can record the next numbered attempt. Reassignment affects
future runs only; every historical `TestExecutionRun.executed_by_id` remains unchanged. The cycle screen
shows assignment coverage, unassigned work, each user's own queue, total retained runs, latest runner and
defect count.

Defects are now structured many-per-run links rather than one free-text value: key, URL, title, status,
notes, linker and timestamp. The legacy `defect_id` columns remain as latest/first-defect summaries for
backward compatibility.

Run once against an existing Oracle schema after section 146:

```sql
ALTER TABLE qap_test_executions ADD (
    assigned_to_id NUMBER REFERENCES qap_users(id),
    assigned_by_id NUMBER REFERENCES qap_users(id),
    assigned_at DATE
);

ALTER TABLE qap_test_execution_runs ADD CONSTRAINT uq_qap_test_run_attempt
    UNIQUE (execution_id, attempt_no);

CREATE TABLE qap_test_run_defects (
    id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    run_id NUMBER NOT NULL REFERENCES qap_test_execution_runs(id),
    defect_key VARCHAR2(100) NOT NULL,
    defect_url VARCHAR2(500),
    title VARCHAR2(255),
    defect_status VARCHAR2(40),
    notes CLOB,
    linked_by_id NUMBER REFERENCES qap_users(id),
    created_at DATE DEFAULT SYSDATE,
    CONSTRAINT uq_qap_run_defect_key UNIQUE (run_id, defect_key)
);

CREATE INDEX ix_qap_test_exec_assigned_to ON qap_test_executions(assigned_to_id);
CREATE INDEX ix_qap_test_run_defects_run ON qap_test_run_defects(run_id);
```

Existing execution slots intentionally remain unassigned, requiring an IT-QA QA Engineer or QA Lead to establish explicit
ownership before another attempt can be recorded. No historical runner or result data is rewritten.

Assignment authority was subsequently widened from QA Lead-only to the full IT-QA execution team
(QA Engineer or QA Lead), while runner eligibility remains restricted to active IT-QA users holding one
of those roles. Administrators retain their standard global bypass.

## 148. Standardized short TQA business IDs (supersedes section 131; no new table)

All newly generated, human-facing IDs now use `TQA-<MODULE>-NN`. Each module owns an independent,
lifetime counter:

| Record | Prefix | Examples |
|---|---|---|
| QA Request | `TQA-REQ` | `TQA-REQ-01`, `TQA-REQ-02` |
| Functional Request | `TQA-FUNC` | `TQA-FUNC-01`, `TQA-FUNC-02` |
| SAST Request | `TQA-SAST` | `TQA-SAST-01`, `TQA-SAST-02` |
| DAST Request | `TQA-DAST` | `TQA-DAST-01`, `TQA-DAST-02` |
| Performance Request | `TQA-PERF` | `TQA-PERF-01`, `TQA-PERF-02` |
| Suppression | `TQA-SUP` | `TQA-SUP-01`, `TQA-SUP-02` |
| QA Sign-off | `TQA-SIGN` | `TQA-SIGN-01`, `TQA-SIGN-02` |
| Test Project | `TQA-PROJ` | `TQA-PROJ-01`, `TQA-PROJ-02` |
| Test Cycle | `TQA-CYCLE` | `TQA-CYCLE-01`, `TQA-CYCLE-02` |
| Test Case | `TQA-TC` | `TQA-TC-01`, `TQA-TC-02` |

The two digits are a minimum display width, not a maximum: sequence values continue naturally as
`...-99`, `...-100`, and so on. Counters no longer reset daily and the date is no longer part of the ID.

The existing `qap_id_counters` table is reused without a schema change. New lifetime counters use the
fixed `counter_date` value `DATE '1900-01-01'`; rows from the previous daily-counter implementation remain
untouched. The generator's atomic Oracle `MERGE` continues to serialize concurrent claims for a prefix.
No counter seed DML is required: the first generated ID for a module inserts its fixed-scope row with
`next_value = 1`.

Existing business IDs are deliberately not renamed. They may be referenced by exported documents,
external links, audit evidence, sign-off records, or user correspondence; rewriting them would damage
that traceability. The new convention is enforced for every record created after deployment. Legacy
Suppression and Sign-off prefixes remain recognized by global search.

Test Case IDs are now fully system-owned. The create API ignores a caller-supplied `test_case_key`, the
create form shows that the value will be generated, and Excel's Test Case ID is used to group its step
rows and retained in the import activity message for source traceability. Every imported repository
definition receives a new `TQA-TC-NN` key.

## 149. Bulk removal of testcases from a Test Cycle (no schema change)

The Test Execution selection column now supports lifecycle management as well as bulk execution. An
IT-QA QA Engineer, QA Lead, or Administrator can select up to 100 testcase slots and choose **Remove from
cycle**. The confirmation dialog shows the selected testcase count and the number of retained attempts and
linked defects that will be removed. Repository testcase definitions are never deleted by this operation.

`POST /api/test-execution/cycles/{cycle_id}/executions/bulk-remove` validates the full selection before
writing: every execution id must exist, belong to the selected cycle, and the project must still be active.
The endpoint removes the selected `TestExecution` rows, their cascaded `TestExecutionRun` and
`TestRunDefect` rows, and associated `TEST_EXEC_IMAGE` document metadata in one database transaction. A
single `Bulk Testcase Removal` approval/audit entry records the actor, testcase keys, attempt count and
evidence count. Physical evidence files are unlinked only after the database commit succeeds.

The frontend uses a governed in-app modal with destructive impact text, dynamic progress, a completion
summary, and an error state that displays the exact backend reason. Bulk Execute remains disabled unless
every selected testcase is assigned to the current runner; this broader selection permission applies only
to lifecycle removal and other IT-QA management actions.

## 150. Admin-configurable readiness checklists (Functional / SAST / DAST / Performance)

**Request:** "I want to make configurable readiness checklist, what ever i will mentioned on that
configuration that will automatically behave like that configuration, for example if I make any
checklist mandatory in that configuration file, that will be mandatory." Clarified via follow-up
questions: configuration should live in a new Admin page backed by the database *and* keep a
file-based shipped-defaults fallback (both); all four existing checklists (Functional, SAST, DAST,
Performance -- QA Sign-off has none) become configurable; a mandatory item should hard-block progress
for Functional/Performance too (today only SAST/DAST actually enforce it); and editing the
configuration later only affects requests raised after the change, never ones already in flight.

**Root cause / starting state:** every one of the four checklists was a hardcoded python list
(`constants.DEFAULT_CHECKLIST_ITEMS` / `DEFAULT_SAST_CHECKLIST_ITEMS` / `DEFAULT_DAST_CHECKLIST_ITEMS`
/ `DEFAULT_PERFORMANCE_CHECKLIST_ITEMS`), mirrored by hand in a second, frontend-only copy
(`constants.ts`), that had to be kept in sync manually and could only ever be changed by editing code
and redeploying. Auditing "mandatory" specifically turned up a second, independent bug: Performance's
seeding code hardcoded `is_mandatory=False` on every item regardless of anything else (constants.py's
own tuple shape for Performance doesn't even carry a mandatory column), and `submit_request`'s
raise-time gate only ever checked Functional/SAST/DAST -- Performance had no way to have a mandatory
item, and no gate to enforce one, even in principle.

**Backend changes (new `models.ChecklistTemplateItem` / `qap_checklist_template_items`):** one row per
configured item -- `module` ("FUNCTIONAL"/"SAST"/"DAST"/"PERFORMANCE"), `item`, `detail` ("Owner" for
Functional/SAST/DAST, "Data Required from Department" for Performance -- one shared free-text column,
labeled differently per module by the frontend), `is_mandatory`, `sort_order`, `active` (soft-disable,
never a hard delete from seeding's perspective -- an inactive item is simply excluded from what gets
seeded onto new requests, but its row and history stay put unless an Admin explicitly deletes it).

**Backend changes (new `app/checklist_config.py`):** `get_template_items(db, module, only_active)` --
the one shared read path both the Admin API and request-seeding now go through. Lazily bootstraps a
module's rows from that module's shipped defaults
(`constants.DEFAULT_*_CHECKLIST_ITEMS`, normalized to a uniform `(item, detail, is_mandatory)` shape by
`_default_items_for`) the first time it's read with zero rows -- same lazy-init-on-first-write pattern
already used elsewhere in this app (e.g. `test_execution.py::_migrate_legacy_result_if_needed`), so a
brand-new Oracle deployment needs no separate manual data-migration step beyond creating the table.
`reseed_defaults(db, module)` backs the Admin "Restore Defaults" action. `constants.py`'s
`DEFAULT_*_CHECKLIST_ITEMS` lists are kept, but only as this table's shipped defaults now -- nothing
else in the app reads them directly any more (comments on each updated to say so).

**Backend changes (new `routers/checklist_config.py`, mounted at `/api/checklist-config`):**
`GET /{module}` (active items only, any authenticated user -- this is what the QA Request wizard reads
while raising a request, same openness as `GET /api/departments`), `GET /{module}/all` (Admin, includes
inactive), `POST /{module}` (Admin, create), `PATCH /{module}/{item_id}` (Admin, edit
item/detail/mandatory/sort_order/active -- this single endpoint is the whole "whatever I configure,
that's what happens" mechanism: flip `is_mandatory` here and the very next request raised for that
module picks it up, no further wiring needed), `DELETE /{module}/{item_id}` (Admin, hard delete --
safe even though older already-raised requests reference the same item text, because their own
`ReadinessChecklistItem`/`SASTChecklistItem`/`DASTChecklistItem`/`PerformanceChecklistItem` rows were
copied at seed time and never reference this table by id), `POST /{module}/restore-defaults` (Admin,
wipe + reseed shipped defaults).

**Backend changes (routers/qa_requests.py):** `_sync_linked_child_requests`'s four seeding loops
(Functional/SAST/DAST/Performance) now call `get_template_items(db, "<MODULE>")` instead of iterating
the old hardcoded constants tuples, copying `is_mandatory` straight through -- including fixing
Performance's previous hardcoded `is_mandatory=False`. `submit_request`'s `pending_checklist_items`
raise-time gate (previously Functional/SAST/DAST only, despite its own stale comment saying
"Scoped to SAST/DAST only") now also has a Performance branch and reads every module's mandatory items
from the same `get_template_items` call -- a mandatory item on any of the four modules must be
self-declared ready before the QA Request can be raised at all, closing the gap that meant Performance
could never actually have a working mandatory item before. `_draft_evidence_module` (evidence
selected on the wizard before the real checklist rows exist) and `_promote_draft_checklist_evidence`
(re-keying that evidence onto the real rows at Submit) both switched from the static
`_DRAFT_EVIDENCE_DEFINITIONS` dict to a live `get_template_items` call per request, so evidence-slot
bounds/ordering always matches whatever is currently configured rather than a python-process-startup
snapshot.

**Backend changes (functional.py / performance.py `readiness_decision`):** no logic change needed --
both already gate "Passed" on every `requester_checked` item being QA-verified (`is_complete`); since a
mandatory item is now forced `requester_checked` before the request can even be raised (the
`submit_request` gate above), every mandatory item is already inside that same check by the time
Readiness Verification/Readiness is reached. Stale comments claiming "none of these items ship
mandatory, so a mandatory-only gate here would be a no-op" were corrected to explain the actual,
now-connected reasoning instead.

**Frontend changes:** new `useChecklistTemplate(module)` hook (QARequests/steps/useChecklistTemplate.ts)
fetches `GET /api/checklist-config/{module}` -- used by `FunctionalStep`/`SastStep`/`DastStep`/
`PerformanceStep.tsx` (replacing their static `DEFAULT_*_CHECKLIST_ITEMS` imports from constants.ts,
which are now dead code and removed) and by `RequestDetail.tsx` (which independently used the same
hardcoded lists three times over -- draft-evidence slot counts, the raise-time "pending mandatory"
warning banner, and the "items without evidence" nudge -- all three switched to the live fetch, and the
raise-time banner gained the same missing Performance branch as the backend gate, plus a stray leftover
debug `console.log` in that file was removed). `PerformanceStep.tsx` also gained the "Mandatory" badge
and required-evidence behavior the other three steps already had, since Performance can now actually
carry a mandatory item. New Admin page `modules/governance/ChecklistConfig.tsx`
(`/checklist-config`, nav item under Administration, Admin-only): per-module tabs, an editable table
(item text and detail/owner both save on blur, Mandatory/Active toggle immediately, up/down reorder
swaps `sort_order` with the neighboring row), an "+ Add Item" form, and a confirmed "Restore Defaults"
action per module.

**Data notes:** new table `qap_checklist_template_items` needs to be created in Oracle (no live DB
connection from this sandbox, so this is DDL-only, not executed):
```sql
CREATE TABLE qap_checklist_template_items (
    id            NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    module        VARCHAR2(20) NOT NULL,
    item          VARCHAR2(255) NOT NULL,
    detail        VARCHAR2(255),
    is_mandatory  NUMBER(1) DEFAULT 0,
    sort_order    NUMBER DEFAULT 0,
    active        NUMBER(1) DEFAULT 1,
    created_at    DATE DEFAULT SYSDATE,
    updated_at    DATE DEFAULT SYSDATE
);
CREATE INDEX ix_qap_checklist_template_items_module ON qap_checklist_template_items(module);
```
No backfill DML needed -- `get_template_items` bootstraps each module's rows from
`constants.DEFAULT_*_CHECKLIST_ITEMS` lazily, the first time it's ever read after the table exists.
Editing the configuration only ever affects requests raised afterward -- an already-raised request's
own checklist rows (`ReadinessChecklistItem`/`SASTChecklistItem`/`DASTChecklistItem`/
`PerformanceChecklistItem`) were copied at seed time and never reference this new table, so nothing
already in flight can be altered by a later configuration change.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` -- clean; `npx tsc --noEmit -p .` across
the entire frontend -- clean; Documents and outputs copies re-synced and confirmed identical via
`diff -rq` (only the standard `.env`/`uploads/` leftovers differ). Note: section numbering collided
with an already-present, independently-authored "## 147. Test runner assignment and structured defect
linking" section found already in this file at edit time (this repo had sections 147-149 added outside
this conversation) -- this entry is numbered 150 to avoid re-using either "147" already in use above.

## 151. Hotfix: corrupted DEFAULT_PERFORMANCE_CHECKLIST_ITEMS row crashed checklist seeding

**Request:** user reported a backend crash --
```
return [(item, data_required, is_mandatory) for item, data_required, is_mandatory in DEFAULT_PERFORMANCE_CHECKLIST_ITEMS]
ValueError: not enough values to unpack (expected 3, got 2)
```

**Root cause:** between section 150 being written and this report, `constants.py`'s
`DEFAULT_PERFORMANCE_CHECKLIST_ITEMS` was edited outside this conversation to add a per-item Mandatory
`True`/`False` third value to every row (a reasonable, expected use of the new configurable-checklist
feature), but one edit went wrong: the "Monitoring Dashboard Access" row's closing paren landed before
the mandatory value instead of after it -- `("Monitoring Dashboard Access", "...")​, False,` -- which
left that row a 2-tuple with a stray `False` sitting next to it as its own (invalid) list element, and
the "Maximum Acceptable System Load Defined (Threshold Values)" item's long description got split
across two separate rows in the same pass, corrupting a single 19-item list into 20 malformed entries.
`checklist_config._default_items_for("PERFORMANCE")` unpacks every row as a 3-tuple, so the first
malformed row it hit crashed with exactly the "expected 3, got 2" error reported.

**Backend changes (constants.py):** `DEFAULT_PERFORMANCE_CHECKLIST_ITEMS` restored to 19 well-formed
`(item, data_required, is_mandatory)` 3-tuples -- the "Monitoring Dashboard Access" row fixed to a
proper 3-tuple (kept its `False`), and "Maximum Acceptable System Load Defined (Threshold Values)"
merged back into a single row with its original two-part description text (kept the `True` one of the
two split fragments had been given). Verified programmatically via `ast.parse` that the list now
contains exactly 19 elements, all 3-tuples, before touching anything else.

**Backend changes (checklist_config.py):** `_default_items_for` simplified -- Performance's list is
the same 3-tuple shape as the other three modules' now (no longer needs special-casing), so it's now a
single dict-lookup + uniform unpack (`_DEFAULTS_BY_MODULE`) rather than an if/elif per module. Updated
its docstring, which still claimed "Performance has no mandatory column", to match reality.

**Data notes:** none -- pure data-integrity fix to an existing constants list, no schema impact. Any
already-bootstrapped `qap_checklist_template_items` rows for PERFORMANCE (seeded before this fix, if
the crash didn't prevent that) are unaffected either way -- `get_template_items` only ever re-seeds
from this list when the table has zero rows for that module.

**Verified:** wrote a small `ast`-based script confirming `DEFAULT_PERFORMANCE_CHECKLIST_ITEMS` parses
to exactly 19 elements, all well-formed 3-tuples; `python3 -m py_compile` on constants.py,
checklist_config.py, routers/checklist_config.py, routers/qa_requests.py, models.py, schemas.py --
clean; Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`uploads/` leftovers differ).

## 152. Performance Edit Details: remove fields never collected at intake

**Request:** "Edit performance testing request getting some fields which is not there during request
creation like Target Load, Tool used, hash value -- remove this fields."

**Root cause:** `PerformanceRequest.tool_used`/`target_load`/`hash_value` are real columns, and
Performance.tsx's Edit Details modal exposed all three as editable inputs -- but none of the three are
ever collected on the QA Request wizard's Performance step (PerformanceStep.tsx only collects
Priority/Risk Category/Request Types + the readiness checklist) or seeded by
`_sync_linked_child_requests` at raise time (`hash_value=None` is set explicitly there, and
`tool_used`/`target_load` are never referenced at all outside this one edit form). Showing three
inputs in "Edit Details" that were never part of "creation" read as unexplained, out-of-nowhere fields
to the requester.

**Frontend changes (modules/specialised-testing/Performance.tsx):** removed the Tool Used, Target
Load, and Hash Value fields entirely from the Edit Details form (`PerformanceFormModal`'s form state
and its "Test Basics"/"Annexure VIII Details" sections), from the Overview tab's read-only detail
display ("Test Parameters & Environment"/"Release & Vendor" sections), and the "Tool" column from the
main Performance Testing Requests list table -- all three would otherwise stay permanently blank going
forward with no way to fill them in, which is just dead UI clutter once the edit inputs are gone.
`change_type`/`vendor_si_partner`/`technology_stack`/`release_version`/`build_number`/
`target_promotion_environment` were left untouched -- those genuinely are collected at creation
(delegated from the QA Request gateway's own "Application & Change Details" step), they just aren't
re-typed on Performance's own wizard step, so removing them wasn't part of this request.

**Backend changes:** none -- `tool_used`/`target_load`/`hash_value` columns and the `PerformanceUpdate`
schema fields are left in place (no destructive schema change); the edit endpoint already uses
`payload.model_dump(exclude_unset=True)`, so simply never sending these keys from the frontend form
leaves any already-stored value untouched rather than nulling it out.

**Data notes:** none -- frontend-only change, no schema impact.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers
differ).

## 153. DAST/Performance Environment restricted to UAT and later

**Request:** "On DAST details during request creation, under DAST target Environment should show from
UAT only as in SIT, DEV DAST does not performed. For Performance Testing also during request creation
ask to select environment which are mandatory and environment should show from UAT only as in DEV, SIT
performance testing does not performed."

**Root cause / starting state:** DastStep.tsx's per-target Environment picker offered the full
`ENVIRONMENTS` list (Dev/SIT/UAT/Pre-Production/Production) plus a blank "defaults to Deployment
Environment" option -- which could resolve to Dev or SIT, neither of which DAST is ever actually run
against. Performance had no Environment ask on its own wizard step at all -- `PerformanceRequest.environment`
was silently delegated from the gateway's own Deployment Environment field (same one Functional/SAST/DAST
share), which also defaults to SIT and is never itself restricted, so a Performance request could be raised
against SIT with no way to say otherwise short of editing it after the fact.

**Backend changes (constants.py):** new `POST_SIT_ENVIRONMENTS = ENVIRONMENT_PIPELINE_ORDER[1:]` --
`['UAT', 'Pre-Production', 'Production']` -- shared by both DAST and Performance's own environment
restriction.

**Backend changes (schemas.py):** `QARequestCreate` gained `performance_environment: Optional[str] =
None` -- its own field, not delegated from the gateway's `environment` like every other Performance
field in that block.

**Backend changes (routers/qa_requests.py):**
- `submit_request` gained two new raise-time gates (same belt-and-braces pattern as the existing
  mandatory-checklist/environment-promotion-ordering checks): every DAST target's `environment` must be
  in `POST_SIT_ENVIRONMENTS`, and (if "Performance Testing" is selected) `performance_environment` must
  be too -- both reject the raise with a 400 explaining DAST/Performance testing isn't performed in
  Dev/SIT if violated.
- `_sync_linked_child_requests`'s DAST branch: target `environment` fallback changed from
  `qa_request.environment` (could be SIT) to `"UAT"` (only used if a row is somehow still blank, which
  the frontend no longer allows).
- `_sync_linked_child_requests`'s Performance branch: `environment` changed from delegating
  `qa_request.environment` to `pd.get("performance_environment") or "UAT"` -- Performance's own
  explicit ask, not the gateway's Deployment Environment.

**Frontend changes (constants.ts):** new `POST_SIT_ENVIRONMENTS` mirroring the backend list.

**Frontend changes (QARequests/types.ts):** `blankDastComponent()`'s `environment` default changed
from `''` to `'UAT'`; `EMPTY_FORM` gained `performance_environment: 'UAT'`. Both follow the same
"dropdown always defaults to a real, non-blank value" convention validation.ts's own comment describes
for every other select-type mandatory field in this wizard -- no separate "is it filled in" check is
needed as a result (same reasoning already applied to Change Type/Deployment Environment/Priority/Risk
Rating).

**Frontend changes (steps/DastStep.tsx):** target Environment `<select>` options changed from
`ENVIRONMENTS` (plus a blank "defaults to Deployment Environment" placeholder) to
`POST_SIT_ENVIRONMENTS` with no blank option.

**Frontend changes (steps/PerformanceStep.tsx):** new mandatory "Environment *" field, `<select>`
restricted to `POST_SIT_ENVIRONMENTS`, bound to `form.performance_environment`; explanatory copy at the
top of the step updated to call out that Environment (unlike every other delegated field there) is its
own ask because Performance testing is never run against Dev or SIT.

**Frontend changes (NewRequestModal.tsx):** `buildInitialForm` gained a `performance_environment`
pre-fill (`editing.draft_performance?.performance_environment || 'UAT'`) for reopening a still-Draft
request. While touching this block, also fixed a pre-existing bug found alongside it:
`performance_priority`/`performance_risk_category` were reading from `editing.draft_classification`,
but the backend only ever sweeps functional_/sast_/dast_-prefixed fields into `draft_classification` --
performance_-prefixed fields (including these two) land in `draft_performance` instead (see
routers/qa_requests.py::create_request's sweep order). Reading the wrong dict meant reopening a
still-Draft request with Performance Testing selected silently lost its previously-picked
Priority/Risk Category back to the 'Medium' fallback every time -- now reads `editing.draft_performance?.
performance_priority`/`performance_risk_category` instead, matching where the backend actually stores them.

**Data notes:** none -- no schema/column changes; `PerformanceRequest.environment` and
`DASTTarget.environment` already existed as columns, this only changes what value populates them at
creation and how tightly the choice is constrained beforehand.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` -- clean; `npx tsc --noEmit -p .` across
the entire frontend -- clean; Documents and outputs copies re-synced and confirmed identical via
`diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 154. Excel test case import now shows a progress bar

**Request:** "while uploading testcases using excel show progress bar, already progress bar is present,
reuse it."

**Root cause / starting state:** `TestRepository.tsx`'s `ImportModal` only ever showed "Importing..."
as the disabled submit button's own label while a plain `busy` boolean was true -- no progress
indicator, despite the app already having an established governed-progress pattern (`tm-operation-state`
/`tm-operation-icon`/`tm-progress-track`/`tm-progress-meta`, a `stage` state machine driving a simulated
percentage via `setInterval`) used four other places already: Bulk Approve and Bulk Update in this same
file, and Bulk Execute/Bulk Removal in `TestExecution.tsx`.

**Backend changes:** none -- frontend-only; the `import-xlsx` endpoint itself is unchanged.

**Frontend changes (modules/test-management/TestRepository.tsx):** `ImportModal` reworked to reuse that
exact pattern instead of the plain `busy` boolean:
- New `stage: 'form' | 'importing'` state (plus the existing `result`, which still separately drives the
  post-import summary view once a response comes back), replacing `busy`.
- `submit()` now starts a simulated progress climb (`setInterval`, capped at 88% until the real response
  lands, message switching from "Uploading file…" to "Validating rows and creating test cases…" partway
  through -- same technique as the other four reuses, since the backend's `import-xlsx` endpoint is one
  atomic request with no real progress events of its own), enforces the same minimum 600ms display floor
  so a very fast import doesn't visually flash, then jumps to 100% once the real response arrives before
  handing off to the existing result view. On failure, clears the timer and drops back to the form with
  the error shown inline (unchanged from before).
- While `stage === 'importing'`, the modal shows the shared `tm-operation-state`/`tm-progress-track`
  progress UI instead of the form, and the modal itself is guarded the same way the other four bulk
  modals already are (`preventBackdropClose`, backdrop/header close disabled) so it can't be dismissed
  mid-upload.

**Data notes:** none -- presentation-only change; no schema/API impact.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 155. "Managed by Admin Only" flag on users (Users & Access)

**Request:** "in user & Access add one functionlity manager by admin only, if it is set as yes, then
those user will not show under department admin, only system admin can assign role."

**Root cause / starting state:** A Department Head/Executive COE's "Department Admin" roster
(`/api/auth/local-admin/users`) already excluded Administrator accounts (`"ADMIN" in target.roles`), but
had no way to exclude any other individual user a System Admin might want to keep off that roster
entirely -- e.g. a sensitive or cross-functional account mapped to a business department that a local
admin still shouldn't be able to reassign a role on or deactivate.

**Backend changes (models.py):** new `User.admin_managed_only` Boolean column, default `False`. Only
ever settable through the System-Admin-only `PATCH /api/auth/users/{id}` endpoint -- never through the
narrower `PATCH /api/auth/local-admin/users/{id}` (its own `LocalAdminUserUpdate` schema only accepts
`roles`/`is_active`, so a local admin cannot set or clear this on anyone, including themselves).

**Backend changes (schemas.py):** `UserOut` gained `admin_managed_only: bool = False`; `UserUpdate`
(the Admin-only PATCH body) gained `admin_managed_only: Optional[bool] = None` -- picked up automatically
by `update_user`'s existing generic `payload.model_dump(exclude_unset=True)` / `setattr` loop, so no
router logic change was needed there.

**Backend changes (routers/auth.py):**
- `list_local_admin_users`: the existing `"ADMIN" not in u.roles` filter became `"ADMIN" not in u.roles
  and not u.admin_managed_only` -- a flagged user simply never appears in a Department Head/Executive
  COE's roster.
- `_require_own_department_target` (shared guard used by `PATCH /local-admin/users/{id}`): gained a
  check mirroring the existing `"ADMIN" in target.roles` one -- targeting a flagged user's ID directly
  now 403s with "This account is managed by a System Admin only", so hiding the row from the list isn't
  the only enforcement (defense in depth, matching how every other guard rail in this function already
  works).

**Backend changes (audit_service.py):** `user_snapshot` gained `admin_managed_only` so toggling it via
the Admin page shows up correctly in that user's `USER_ACCESS_UPDATED` audit trail entry (before/after).

**Frontend changes (types.ts):** `UserOut` gained `admin_managed_only: boolean`.

**Frontend changes (modules/governance/Admin.tsx):** "Users & Access" table gained a "Managed by Admin
Only" column -- a Yes/No toggle button (`PATCH` via the existing `patchUser` helper, same pattern as the
Status column) available only here, since this is the System-Admin-only page. Page subtitle updated to
explain the new toggle.

**Frontend changes (modules/governance/DepartmentAdmin.tsx):** no logic change (the backend already
excludes these users from the response), only the page subtitle updated to mention that a "Managed by
Admin Only" account won't appear in the local roster, so it doesn't look like a missing/broken account to
a Department Head/Executive COE looking for someone they expected to see.

**Data notes:** new nullable-with-default column on `qap_users` (`admin_managed_only`, Boolean, default
`False`/0) -- additive only, no backfill needed since the default already matches "not restricted" for
every existing row.

Run once against an existing Oracle schema:

```sql
ALTER TABLE qap_users ADD admin_managed_only NUMBER(1) DEFAULT 0;
```

(SQLAlchemy maps `Boolean` to `NUMBER(1)` for the Oracle dialect, same representation as
`is_active`/`needs_role_review`/`needs_department_selection` on this same table -- no backfill UPDATE
needed since `DEFAULT 0` already applies to every existing row.)

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` -- clean; `npx tsc --noEmit -p .` across
the entire frontend -- clean; Documents and outputs copies re-synced and confirmed identical via
`diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 156. Growing-list dropdowns converted to searchable pickers

**Request:** "whenever there is dropdown, try to make/convert to searchable dropdown, for example
application name in qa request searchable required, if list increase its hard to find."

**Root cause / starting state:** The app has ~76 native `<select>` elements. Most back short, fixed
enums (Priority, Risk Rating, Change Type, Environment, Status filters, etc. -- 3-6 options each), where
a search box adds a click with no real payoff. A handful, though, are bound to lists that only grow over
time as data is created -- Application Name (the motivating example) being the clearest case, alongside
Test Project, Test Folder, and team/department-derived filters -- and those get harder to scan with every
new row added, exactly like Department already was before it got its own `SearchableSelect` treatment.
Scope was confirmed with the user beforehand: convert growing/dynamic-list pickers only, leave fixed
short enums as plain `<select>`s.

**Backend changes:** none -- frontend-only.

**Frontend changes (components/SearchableSelect.tsx):** generalized to a shared picker instead of a
Department-only one:
- `options` now accepts either `string[]` (unchanged -- value and label are the same, e.g. Department)
  or `{value, label}[]` pairs, so it can drive id-keyed pickers (numeric id as the real value, a name as
  the searched/displayed label) and sentinel rows alongside real ones (e.g. "-- Top level --" at value
  `''`, "No change" at value `'unchanged'`) the same way a plain `<option value="...">` always could.
  The 3 existing Department callers (Admin.tsx x2, DepartmentPrompt.tsx) needed no changes -- `string[]`
  still works exactly as before.
- New optional `style` prop, passed through to the root wrapper, for toolbar placements that aren't
  already inside a width-constraining `Field`/table-cell wrapper (the trigger is `width: 100%` of its own
  wrapper, which otherwise has no intrinsic width of its own in a plain flex toolbar row).

**Frontend changes -- dropdowns converted:**
- `QARequests/steps/DetailsStep.tsx`: Application Name -- the explicit motivating example. Preserves the
  existing "Other (new application)" sentinel flow (typing a brand-new name, pending Application
  Owner/SM approval) exactly as before, just via `SearchableSelect`'s options list instead of a trailing
  `<option>`.
- `modules/test-management/TestProjects.tsx`: `NewProjectModal`'s Application picker (same approved-name
  list Application Name draws from).
- `modules/test-management/TestRepository.tsx`: Parent Folder (`NewFolderModal`), Target Folder (Excel
  `ImportModal`), Folder (test case create/edit modal), Folder (bulk-update modal -- kept its
  `'unchanged'`/`'unfiled'` sentinel values), and the top-toolbar Project picker.
- `modules/test-management/TestExecution.tsx`: the top-toolbar Project picker (same pattern as
  TestRepository.tsx's).
- `Dashboard.tsx`: the "All teams" filter (both the "Live Governance" and "Projects" tabs of the
  Governance dashboard share the same `teamFilter` state) -- team names are department-derived and grow
  the same way Department itself does.

Left as plain `<select>`s (fixed, short enums -- Priority/Risk/Change Type/Environment/Status/etc.
across DetailsStep.tsx, FunctionalStep/SastStep/DastStep/PerformanceStep.tsx, Functional.tsx, SAST.tsx,
DAST.tsx, Performance.tsx, SignOff.tsx, TestExecution.tsx's status/defect-status fields, TestRepository.tsx's
Test Type/Priority filters, Approvals.tsx, AuditLog.tsx, Admin.tsx's Login Type, Login.tsx's demo-account
picker) since none of those lists grow over time.

**Data notes:** none -- presentation-only change; no schema/API impact.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 157. Collapsed sidebar: re-expand button was getting clipped in half

**Request:** "Left side menu on minimize has UI issue. also logo is not cleared, distorted" -- confirmed
via a screenshot to be: "collapse menu getting cut."

**Root cause:** `components/Layout.tsx`'s sidebar renders a small circular chevron button
(`.sidebar-collapse-control`) to re-expand the rail once collapsed. In the collapsed state it's
deliberately positioned half outside the rail's own box (`position: absolute; right: -12px`, relative to
`.sidebar`, its nearest positioned ancestor) so it visually sits on the boundary between the collapsed
rail and the main content, reading as a "pull this out" affordance. The base `.sidebar` rule has
`overflow: hidden`, added earlier (see the `.app-shell` comment near the top of index.css) so a tall
page's content can never drag the whole shell into scrolling together instead of just its own internal
regions -- but that same clipping was cutting this intentionally-overflowing button in half, which read
as "the logo looks distorted/not cleared" since the clipped teal/gold button sits right next to the logo
badge.

**Backend changes:** none -- frontend-only.

**Frontend changes (index.css):** added `.navigation-v2 .sidebar.sidebar-collapsed { overflow: visible; }`
immediately before the existing `.navigation-v2 .sidebar.sidebar-collapsed { width: 76px; }` rule --
scoped to the collapsed state only (the only state anything is ever meant to overflow the rail's box),
rather than removing `.sidebar`'s `overflow: hidden` globally. Safe to relax here: the fixed-shell
scroll-containment behavior that rule protects doesn't actually depend on `.sidebar`'s own overflow at
all -- it's driven entirely by `.sidebar nav`'s own `overflow-y: auto` + `flex: 1; min-height: 0`, both
untouched by this change.

**Data notes:** none -- CSS-only change; no schema/API impact.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean (CSS-only change, not exercised
by the TypeScript compiler, but confirms nothing else in the same pass broke); Documents and outputs
copies re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers
differ).

## 158. Modal close button now shows as a "×" instead of a "Close" text button

**Request:** "whereve is close button in top of the modal, show as cross."

**Root cause / starting state:** `components/Modal` (in `components/Common.tsx`) is the one shared
component every modal in the app renders through -- both its `drawer` variant (right-side slide-over,
most record detail views) and `dialog` variant (centered, e.g. the QA Request wizard, `ConfirmModal`,
`InfoModal`) -- and both rendered their top-right header control as a text `<button className="btn
btn-sm">Close</button>`, not the "×" cross glyph the same small inline remove/unlink/delete controls
elsewhere in the app already use (e.g. `ChecklistEvidencePicker.tsx`, `TestExecution.tsx`'s defect/runner
unlink buttons).

**Backend changes:** none -- frontend-only.

**Frontend changes (components/Common.tsx):** both `Modal` variants' header button changed from the text
"Close" button to `<button type="button" className="modal-close-btn" onClick={onClose}
aria-label="Close">×</button>` -- `aria-label="Close"` keeps it announced correctly for screen readers
now that there's no visible text. Being the one shared component, this single change covers every modal
in the app, including the ones that wrap `Modal` themselves (`ConfirmModal`, `InfoModal`) -- confirmed no
other page renders its own one-off `drawer-header`/`modal-overlay` markup outside this component.

**Frontend changes (index.css):** new `.modal-close-btn` rule -- a small square icon button (30x30,
bordered, rounded) replacing the old text-pill "Close" button's styling.

**Data notes:** none -- presentation-only change; no schema/API impact.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 159. QA Request overview: "Pending Application Approval" badge showed even while still Draft

**Request:** "Application Name status 'Pending Application Approval', even when it is in draft."

**Root cause:** `_resolve_application_name` (routers/qa_requests.py) runs on every create/edit of a QA
Request -- including a plain Draft save, not just Submit/Raise -- so typing a brand-new "Other"
Application Name immediately creates a `models.ApplicationMaster` row in `PENDING_APP_OWNER`, and the
gateway's `application_master_status` (a live delegated property) picks that up right away, by design
(this lets an Application Owner/SM start reviewing a proposed name without waiting on the requester to
actually raise anything). The problem was purely in what `QARequests/RequestDetail.tsx` (the gateway's
own overview, viewable while still Draft) did with that: it showed the same yellow "Pending Application
Owner/SM Approval" badge regardless of the gateway's own status. But the actual decision banner
(`ApplicationNameBanner`) only ever renders on the linked Functional/SAST/DAST/Performance request's own
page -- and that linked request doesn't exist until this gateway is actually raised (`_sync_linked_child_
requests` is only ever called from `submit_request`, never from a Draft save). So while still Draft, the
badge implied the name was already under active review, when nothing -- no App Owner, no SM -- could
actually see or act on it yet.

**Backend changes:** none -- the live `PENDING_APP_OWNER`/`PENDING_SM` status while still Draft is
correct and intentional (see above); only how the gateway's own overview displayed it needed to change.

**Frontend changes (QARequests/RequestDetail.tsx):** the Application Name badge logic in the
"Application & Change" section now branches on `req.status`:
- While `req.status === "DRAFT"` and the name is `PENDING_APP_OWNER`/`PENDING_SM`, shows a neutral
  `badge-gray` note instead -- "New name — enters approval once raised" -- accurate to what's actually
  true at that point, without implying active review is already underway.
- Once raised (`req.status !== "DRAFT"`), the original yellow `badge-yellow` "Pending Application
  Owner/SM Approval" badges show exactly as before.
- `REJECTED` is left unconditional (shown regardless of Draft status) -- unlike "Pending", it's
  immediately actionable (pick a different name) even before raising, and can genuinely apply to a
  still-open Draft if another, already-raised request sharing the same name gets it rejected in the
  meantime (`application_master_status` reads current live state, not a snapshot).

Confirmed no equivalent fix was needed on Functional.tsx/SAST.tsx/DAST.tsx/Performance.tsx's own
"Pending Application ... Approval" badges -- those pages only ever render for a `FunctionalOut`/
`SASTOut`/`DASTOut`/`PerformanceOut` row, none of which can exist before the gateway is raised, so their
own badge is never reachable in a Draft-equivalent state to begin with.

**Data notes:** none -- presentation-only change; no schema/API impact.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 160. "Developed by" credit moved from sidebar footer to a page footer

**Request:** "Developed bySoumyajit PalQuality Assurance Department - IT make it in footer once log in."

**Root cause / starting state:** The credit line lived in the sidebar's own footer
(`.sidebar-bottom > .portal-credit`, `components/Layout.tsx`) -- easy to miss down there, and it
disappeared entirely once the sidebar was collapsed (`.sidebar.sidebar-collapsed .portal-credit {
display: none; }`, since there's no room for it in the 76px collapsed rail).

**Backend changes:** none -- frontend-only.

**Frontend changes (components/Layout.tsx):** removed the `.portal-credit` block from `.sidebar-bottom`;
added a new `.app-footer` as a sibling of `.content`, inside `.main` (same fixed-shell pattern `.topbar`
above it already uses -- `flex-shrink: 0` within `.main`'s fixed-height flex column) so it's pinned at
the bottom of every signed-in page regardless of how long that page's own content is, and regardless of
whether the sidebar is expanded or collapsed.

**Frontend changes (index.css):** new `.app-footer` rule (slim bar, centered text, `border-top`,
`var(--muted)`/`var(--text)` colors matching the rest of the light-themed main content area, unlike the
old teal/gold sidebar-themed `.portal-credit` colors it replaces). Removed the now-dead `.portal-credit`
rules (base styling + the collapsed-sidebar `display: none` override), since the element no longer exists
in the sidebar.

**Data notes:** none -- presentation-only change; no schema/API impact.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 161. QA Request wizard: evidence attach blocked until item is checked, plus batched evidence fetch

**Request:** "if checkbox not checked then 'Attach Evidence' should be blocked. also multiple /documets
api is calling on UI load, instead of one api can render all the data" -- confirmed against
`/api/qa-requests/121/checklist-evidence/functional/5/documents` as the exact endpoint being called
repeatedly.

**Root cause (multiple API calls):** `ChecklistEvidencePicker` (one instance per readiness checklist
item -- up to ~19 items across up to 4 modules if Functional/SAST/DAST/Performance are all selected on
one request) fetched its own already-saved documents independently on mount (`GET .../checklist-evidence/
{kind}/{item_index}/documents`), so opening a Draft with several request types selected could fire dozens
of parallel requests just to render the wizard.

**Backend changes (schemas.py):** new `DraftChecklistEvidenceOut(RequestDocumentOut)` -- adds `kind: str`
and `item_index: int` so a flat, batched list of documents can still be regrouped per item client-side.

**Backend changes (routers/qa_requests.py):** new `GET /{req_id}/checklist-evidence/documents` (no
`{kind}`/`{item_index}` in the path -- distinguishable from the existing per-item route by segment count,
no routing ambiguity). One query: every `RequestDocument` row for this request whose `module` matches any
of the four known draft-evidence prefixes (`DRAFT_FUNCTIONAL_`, `DRAFT_SAST_`, `DRAFT_DAST_`,
`DRAFT_PERF_`), each tagged with `(kind, item_index)` parsed back out of its own module key. The existing
per-item endpoints (`GET`/`POST`/`DELETE .../{kind}/{item_index}/documents`) are untouched -- upload and
delete still target one item at a time, only the initial read was batched.

**Frontend changes (QARequests/NewRequestModal.tsx):** new `savedEvidence` state (keyed by the same
`evidenceKey(kind, itemIndex)` helper already used for not-yet-uploaded pending files) + `loadSavedEvidence()`,
fetched once via the new batched endpoint whenever a Draft is opened for editing (`useEffect` on
`editing?.id`). `savedEvidenceFor(kind, itemIndex)` and `loadSavedEvidence` are passed down to each step
the same way `evidenceFiles`/`setEvidenceFiles` already are.

**Frontend changes (QARequests/steps/ChecklistEvidencePicker.tsx):** no longer fetches its own documents
-- takes `savedFiles`/`onReload` as props instead (`onReload` re-runs the parent's one batched fetch,
called after this picker deletes one of its own already-saved files; harmless to refetch everything for
one delete now that it's a single request either way, not one per item).

**Frontend changes (checkbox-gated evidence, all 4 step files -- FunctionalStep/SastStep/DastStep/
PerformanceStep.tsx):** `ChecklistEvidencePicker` gained a `checked` prop (the same checklist item's own
checkbox state, already computed at each call site). The "Attach evidence" button is now `disabled`
(with an explanatory `title`) whenever `checked` is false -- attaching evidence for an item that isn't
even self-declared "in place" yet didn't make sense. Already-saved evidence stays visible/downloadable/
deletable regardless of the current checkbox state (e.g. attached while checked, then the box got
unticked again) -- only adding NEW evidence is blocked, nothing already attached is hidden or removed.

**Data notes:** none -- no schema/column changes; `RequestDocument`'s existing `module`/`request_id`
columns already carried everything needed to derive `(kind, item_index)`.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` -- clean; `npx tsc --noEmit -p .` across
the entire frontend -- clean; Documents and outputs copies re-synced and confirmed identical via
`diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 162. Second per-item evidence-count loop in RequestDetail.tsx missed by section 161

**Request:** "still multiple API calling on UI" -- reported right after section 161 shipped, meaning the
wizard's own fix wasn't the only offender.

**Root cause:** Section 161 batched the calls `ChecklistEvidencePicker`/`NewRequestModal.tsx` made
inside the wizard itself, but missed a second, separate offender in `QARequests/RequestDetail.tsx` (the
Draft's own detail/overview page, rendered *around* the wizard, not inside it):
`loadDraftEvidenceCounts` -- used to compute the "pending mandatory"/"items without evidence" Raise-time
nudges -- looped over every mandatory/checked checklist item across every selected module and `await`ed
one `GET .../checklist-evidence/{kind}/{item_index}/documents` call at a time, *sequentially* (not even
in parallel like the wizard's old version was), just to get each item's own file count. This ran every
time RequestDetail loaded for a Draft, independent of whether the "Edit Request" wizard was ever opened.

**Frontend changes (QARequests/RequestDetail.tsx):** `loadDraftEvidenceCounts` rewritten to call the same
batched endpoint section 161 added (`GET /{req_id}/checklist-evidence/documents`) once, then group the
flat result into per-item counts (`{kind}:{item_index}` -> count) client-side. Dropped the now-unneeded
`kindsToLoad`/per-module item-count plumbing entirely, since the batched call no longer needs to know in
advance how many items each module has. Removed the `EvidenceKind`/`RequestDocumentOut` imports this
function was the last user of in this file.

**Backend changes:** none -- reuses the endpoint added in section 161 as-is.

**Data notes:** none -- presentation-only change; no schema/API impact.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 163. Readiness checklist items could seed as duplicates under concurrent load

**Request:** "readiness checklist item sometime showing multiple in UI while raising request."

**Root cause:** `checklist_config.get_template_items` -- the one shared read path both the QA Request
wizard (`GET /api/checklist-config/{module}`, hit 4x every time anyone opens the wizard, once per
module) and `_sync_linked_child_requests`'s own Raise-time seeding read -- lazily bootstraps a module's
`ChecklistTemplateItem` rows from `constants.DEFAULT_*_CHECKLIST_ITEMS` the first time it's ever read
with zero rows present. The check was a plain `if count() == 0: seed()`, with nothing at the database
level stopping two concurrent requests from both seeing zero rows (neither had committed yet) and both
inserting a full default set -- doubling every item for that module. Since `_sync_linked_child_requests`
reads from this exact same source when actually seeding a raised request's own checklist rows, a
duplicated template didn't just show doubled items in the wizard's self-declaration list -- it could seed
doubled `ReadinessChecklistItem`/`SASTChecklistItem`/`DASTChecklistItem`/`PerformanceChecklistItem` rows
onto the real, raised request too. Intermittent by nature (only manifests when two requests genuinely
race for the same not-yet-seeded module), matching "sometime."

**Backend changes (models.py):** new unique constraint on `ChecklistTemplateItem`: `UniqueConstraint
("module", "item", name="uq_qap_checklist_template_item")` -- the actual fix; makes a second concurrent
seed attempt fail outright at the database level instead of silently duplicating every item.

**Backend changes (checklist_config.py):** `get_template_items`'s seed attempt now runs inside its own
`db.begin_nested()` SAVEPOINT, with the surrounding `count() == 0` check's `_seed_defaults` call wrapped
in `try/except IntegrityError: pass`. If another concurrent request won the race and already committed
its own seed, this one's INSERTs hit the new unique constraint -- only the SAVEPOINT rolls back (not the
caller's own still-in-progress transaction, e.g. mid-Raise, which may have other uncommitted work of its
own), and execution just falls through to read what the other request already seeded. Same "lost a race,
not an error" idiom already used elsewhere in this codebase (routers/auth.py's JIT LDAP user
provisioning, `uq_qap_user_roles`).

**Frontend changes:** none -- `useChecklistTemplate.ts` already does a full `setItems(r)` replace on every
fetch (confirmed not an accumulation bug); it was faithfully rendering whatever the backend actually
returned.

**Data notes:** run once against an existing Oracle schema, in this order (the cleanup DELETE must run
*before* the ADD CONSTRAINT below, or the constraint creation will itself fail if any module already has
duplicated rows from this bug):

```sql
-- Keep the lowest id per (module, item), drop any duplicates.
DELETE FROM qap_checklist_template_items t1
WHERE t1.id NOT IN (
    SELECT MIN(t2.id)
    FROM qap_checklist_template_items t2
    WHERE t2.module = t1.module AND t2.item = t1.item
);

ALTER TABLE qap_checklist_template_items
    ADD CONSTRAINT uq_qap_checklist_template_item UNIQUE (module, item);
```

Known limitation: this only cleans up the shared *template* table. An already-raised request whose own
checklist rows (`ReadinessChecklistItem` etc.) were seeded from an already-duplicated template keeps
those duplicated rows as-is -- per this table's own docstring, those rows were copied at seed time and
never reference this table afterward, so cleaning up the template here can't retroactively fix a
request already in flight. Deliberately not auto-repaired here (unlike the template table, blindly
deleting a "duplicate" row on an in-flight request risks breaking checklist-evidence index alignment or
an already-recorded requester_checked/evidence state) -- if a specific already-raised request is known to
be affected, it needs a manual, request-specific look before touching its rows.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 164. Folder pickers showed bare names -- same-named folders in different branches were indistinguishable

**Request:** "I SELECTED PARENT FOLDER AS ABC, BUT SUB FOLDER CREATED UNDER ANOTEHR FOLDER."

**Root cause:** Nothing stops creating a folder whose name already exists elsewhere in the same project's
tree (backend `routers/test_repository.py::create_folder` has no uniqueness check on `name`, only that
the given `parent_id`, if any, exists). Every folder picker in Test Repository (Parent Folder on New
Folder, Target Folder on Excel import, Folder on test case create/edit, Folder on bulk-update -- all 4
converted to `SearchableSelect` in section 156) showed only each folder's own bare `name`. If two folders
in different branches of the tree happened to share a name (e.g. two separate "ABC" folders), both
appeared as identical, indistinguishable "ABC" entries in the list -- not a bug in the select itself
(each option's own `value` was always its correct id), but genuinely ambiguous for the requester picking
between them, exactly matching "selected ABC, but created under another folder." Pre-existing since the
folder picker was first built -- not introduced by section 156's conversion to `SearchableSelect` (the
native `<select>` it replaced had the exact same bare-name ambiguity).

**Backend changes:** none -- frontend-only; deliberately not adding a name-uniqueness constraint either,
since reusing the same folder name in a different branch is a legitimate, common pattern (e.g. "Smoke
Tests" nested under several different feature folders) -- the fix is making those distinguishable in the
UI, not disallowing the structure.

**Frontend changes (modules/test-management/TestRepository.tsx):** new `folderPathLabel(folders, folder)`
helper -- walks a folder's `parent_id` chain up to the root (using the already-loaded flat `folders` list
for the project) and joins each ancestor's name into a breadcrumb, e.g. `"XYZ / ABC"` for an "ABC" nested
under "XYZ", vs. a plain `"ABC"` for a top-level one. All 4 folder pickers now use this as each option's
label instead of the bare `f.name` -- same-named folders in different branches now read as visibly
distinct options.

**Data notes:** none -- presentation-only change; no schema/API impact.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 165. Sidebar folder tree was a flat list -- expand/collapse glyphs were static, non-functional text

**Request:** Follow-up on section 164, with two more screenshots: "See the discrepency, i created under
TESTTTTT/NEWWWWW but showing under different folder, also expand and collapse not working."

**Root cause:** Two different bugs both surfaced as "wrong folder" confusion. Section 164 fixed the
folder-picker *dropdowns* (ambiguous bare names). This is a separate, deeper bug in the Test Repository
sidebar's own tree view, which never built a real hierarchy at all: `{folders.map((f) => (...))}` rendered
every folder in whatever flat order the API returned them in (not grouped under its actual `parent_id`),
with only a binary `0px`/`16px` indent regardless of true depth, and a `{f.parent_id ? '└' : '▸'}` glyph
that was static text with no `onClick` -- it never expanded or collapsed anything. A sub-folder created
under `TESTTTTT / NEWWWWW` had the correct `parent_id` all along, but its row could land visually far from
its real parent's row with nothing connecting them, which reads exactly like "created under X but showing
under a different folder" even though the underlying data was fine. "Expand and collapse not working" was
literally true -- those glyphs were never interactive.

**Backend changes:** none -- `parent_id` was always correct; this was a frontend rendering bug only.

**Frontend changes (modules/test-management/TestRepository.tsx):** added `buildFolderTree(folders)`,
converting the flat `TestFolderOut[]` into a real `FolderTreeNode[]` (`{folder, children}`) by grouping
each folder under its actual parent's node (root folders, i.e. no `parent_id`, become top-level nodes).
Added a new recursive `FolderTreeRows` component that renders one node's own row immediately followed by
its own children (one level deeper), so a sub-folder always renders directly beneath its real parent
regardless of API response order. The expand/collapse glyph is now a real `<button>` (`.tm-folder-toggle`)
wired to a new `collapsedFolders` state (`Set<number>`, empty by default so nothing that was previously
always-visible disappears) and a `toggleCollapsed(id)` handler in the sidebar; leaf folders (no children)
render a static, non-interactive `└` (`.tm-folder-toggle-leaf`) instead of a button. The old flat
`{folders.map(...)}` block in the `tm-tree-panel` sidebar was replaced with
`<FolderTreeRows nodes={folderTree} .../>`, where `folderTree = useMemo(() => buildFolderTree(folders),
[folders])`. Added `.tm-folder-toggle` / `.tm-folder-toggle-leaf` CSS to `index.css`, styled to match the
existing muted `.tm-tree-panel .link-btn span` glyph color.

**Data notes:** none -- presentation-only change; no schema/API impact. `folderCounts` (direct test-case
counts per folder) and `canDeleteFolder`/`projectIsActive` gating are unchanged, just threaded through as
props to the new recursive component instead of being read as closures inside a flat `.map()`.

**Verified:** `npx tsc --noEmit -p .` across the entire frontend -- clean; Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 166. Test Repository folders had no Copy or Move action

**Request:** "Add functionality of copy the folder and move the folder."

**Root cause:** Not a bug -- the Test Repository's folder tree only ever supported Create and Delete
(section 165 fixed the tree's own rendering, but never added new actions). Reorganizing an existing tree
(duplicating a folder as a starting point for a similar set of cases, or re-parenting a folder somewhere
else) required deleting and manually re-creating everything by hand, since Delete only works on an already
-empty folder (see `delete_folder`'s `has_children`/`has_cases` guard).

**Backend changes (routers/test_repository.py, schemas.py):** two new endpoints, both gated by the same
`_AUTHOR_ROLES` (QA Engineer or QA Lead) as `create_folder`, both requiring the project to be active.
`POST /api/test-repository/folders/{folder_id}/move` (`schemas.TestFolderMove { parent_id }`) re-parents a
folder in place -- everything already nested beneath it moves along automatically since children only
reference their parent's id, nothing about them changes. Guarded by a new `_descendant_folder_ids()`
cycle-check: a folder can never be moved into itself or into one of its own descendants (would disconnect
it from the tree). `POST /api/test-repository/folders/{folder_id}/copy`
(`schemas.TestFolderCopy { parent_id, name }`) recursively duplicates a folder's entire subtree via a new
`_clone_folder_subtree()` helper -- itself, every test case directly inside it (own steps included), and
every child folder at any depth with its own test cases. Every cloned test case gets a brand-new governed
`TQA-TC` key (via `models.gen_id`) and its status is forced back to `Draft` regardless of the source case's
current status, exactly like `create_test_case`/import already do for anything new -- a copy is a new
definition, not the same already-approved artifact, so it re-enters QA Lead review. Each new case also gets
its own `ApprovalAction` "Submitted for review" audit row noting which original key it was duplicated from.
No cycle guard is needed for Copy (unlike Move): the copy always gets brand-new ids, so "copy a folder into
one of its own sub-folders" is a well-defined destination -- it just nests the new copy under the untouched
original subtree.

**Frontend changes (modules/test-management/TestRepository.tsx, index.css):** `FolderTreeRows` (added in
section 165) gained two new per-row icon buttons alongside the existing Delete ("⧉" Copy, "⇄" Move), both
gated by `canAuthor` (matching the backend's author-role gate) and `projectIsActive`, wrapped together with
Delete in a new `.tm-folder-actions` flex container so all three sit side by side without overlapping the
folder name/count. New `FolderMoveCopyModal` component (one modal, `mode: 'move' | 'copy'` prop) shows a
`SearchableSelect` destination picker built from `folderPathLabel` breadcrumbs (same helper as section 164)
plus a "Top level" option; Move's picker excludes the folder itself and every one of its own descendants
client-side (same exclusion the backend enforces, just pre-filtered so the error can't actually happen from
the UI); Copy shows a required, pre-filled "New Folder Name" field (defaults to `"<name> (Copy)"`) and a
note that every test case inside re-enters QA Lead review. Both actions call `loadProjectData(projectId)`
on success to refresh the full folder + test-case list in one shot, same as `ImportModal`'s `onImported`.

**Data notes:** none -- no schema change; the existing `qap_test_folders`/`qap_test_cases`/`qap_test_steps`
tables and the existing `TQA-TC` id-counter sequence are reused as-is by the new Copy endpoint.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` -- both clean;
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`uploads/` leftovers differ).

## 167. Test cases had no checkout/lock -- two people could edit the same one at once

**Request:** "check in checkout option should be available for testcases, otherwise multiple people can
edit at once, if checkout, the testcase is locked for editing by that user."

**Root cause:** Not a bug -- `update_test_case` had no concurrency control at all. Two QA Engineers opening
the same test case at the same time and both saving would silently overwrite each other's edit (last write
wins), with no warning to either of them. Requested directly as an explicit, SharePoint-style checkout: a
user locks a test case to themselves before editing, and everyone else is blocked from changing it (not
just warned) until they check it back in.

**Backend changes (models.py, schemas.py, routers/test_repository.py):** `TestCase` gains two new nullable
columns, `checked_out_by_id` (FK to `qap_users.id`) and `checked_out_at`, plus a `checked_out_by_name`
property (same pattern as the existing `created_by_name`). Two new endpoints, both requiring `_AUTHOR_ROLES`
(QA Engineer or QA Lead) and an active project: `POST /api/test-repository/test-cases/{id}/checkout` sets
the lock to the caller (rejected with `423 Locked` if someone else already holds it; idempotent -- just
refreshes the timestamp -- if the caller already holds it), and `POST .../checkin` clears it (a no-op if
already unlocked). A new `_enforce_checkout_lock()` helper is now called at the top of `update_test_case`,
`delete_test_case`, `bulk_update_test_cases`, and `bulk_delete_test_cases` -- each raises `423 Locked` if the
case is checked out by anyone other than the caller. Admin always bypasses the lock (`current_user.has_role()`
with no arguments is this codebase's existing "is Administrator" check), so an abandoned lock (e.g. its
holder left the bank, or simply forgot to check back in) can still be broken without touching the database.
QA Lead's separate review/approve step (`review_test_case` / `bulk_approve_test_cases`) is deliberately NOT
gated by this lock -- reviewing an already-submitted definition is not the same action as editing its
content, and gating it would let one engineer's forgotten checkout block the whole team's approval queue.
`copy_folder` (section 166) does not carry a source case's checkout over to its clone -- every cloned case
starts unlocked, same as any other brand-new row.

**Data notes:** requires two new nullable columns on `qap_test_cases`:
```sql
ALTER TABLE qap_test_cases ADD checked_out_by_id NUMBER;
ALTER TABLE qap_test_cases ADD checked_out_at TIMESTAMP;
ALTER TABLE qap_test_cases ADD CONSTRAINT fk_qap_test_cases_checked_out_by
  FOREIGN KEY (checked_out_by_id) REFERENCES qap_users(id);
```
Both are nullable so every existing row is simply "not checked out" with no backfill required.

**Frontend changes (modules/test-management/TestRepository.tsx, types.ts):** the test case table gained a
new "Lock" column -- a case checked out by someone else shows their name as a yellow badge (read-only); a
case the current user holds shows a "Check in" button; an unlocked case (that the viewer is allowed to
author) shows a "Check out" button -- both call the new endpoints directly from the row (`stopPropagation`
so the click doesn't also open the edit modal, same convention as the existing selection checkbox column).
`TestCaseModal` gained a matching "Checkout" field with the same badge/button, plus: opening a case someone
ELSE has checked out now forces the whole form read-only client-side too (not just relying on the backend's
423 on Save) via a new `lockedByOther` check, with an `info-banner` explaining who holds it. A new
`onCheckoutChange` callback prop updates the case in both the parent's list and the still-open modal in
place, so checking out/in from inside the modal doesn't close it.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` -- both clean;
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`uploads/` leftovers differ).

## 168. Test Project activation/deactivation had no QA Lead approval gate

**Request:** "Project Activation, deactivation should need approval from QA lead."

**Root cause:** Not a bug -- `update_test_project` let either QA Engineer or QA Lead flip a project's
`is_active` immediately, with only an audit-log entry after the fact (no approval step at all). Requested
directly: a QA Engineer's activate/deactivate should become a request a QA Lead has to approve before it
takes effect, the same shape as every other requester/approver split already in this app (test case Draft →
QA Lead review, SAST/DAST readiness → Security Lead, etc.).

**Backend changes (models.py, schemas.py, routers/test_projects.py):** `TestProject` gains three new
nullable columns -- `pending_is_active` (the *requested* new value while a request is outstanding, `NULL`
= no pending request), `pending_requested_by_id`, `pending_requested_at` -- plus a `pending_requested_by_name`
property (same pattern as `created_by_name`). `update_test_project` now branches on
`current_user.has_role(Role.QA_LEAD)` (True for QA Lead or Admin, same "is at least this role" bypass used
everywhere else) only for the `is_active` field -- `name`/`department`/`description` still save directly for
either role, unchanged. A QA Lead/Admin's toggle still applies to `is_active` immediately exactly as before.
A QA Engineer's toggle instead only sets `pending_is_active` to what they asked for and logs "Reactivation
requested"/"Deactivation requested" -- `is_active` itself is untouched until resolved. New endpoint
`POST /api/test-projects/{id}/activation-review` (QA Lead/Admin only, `schemas.TestProjectActivationReview
{ decision: APPROVE | REJECT, comments }`) resolves it: Approve applies `pending_is_active` to `is_active`
and logs "Reactivation approved"/"Deactivation approved"; Reject discards the request without touching
`is_active` and logs "...request rejected" -- a reason is required for Reject, same rule `review_test_case`
already uses for Return. Requesting a value the project is already in (e.g. a stale request racing an
already-applied change) is a quiet no-op that just clears the pending fields, not an error.

**Data notes:** requires three new nullable columns on `qap_test_projects`:
```sql
ALTER TABLE qap_test_projects ADD pending_is_active NUMBER(1);
ALTER TABLE qap_test_projects ADD pending_requested_by_id NUMBER;
ALTER TABLE qap_test_projects ADD pending_requested_at TIMESTAMP;
ALTER TABLE qap_test_projects ADD CONSTRAINT fk_qap_test_projects_pend_by
  FOREIGN KEY (pending_requested_by_id) REFERENCES qap_users(id);
```
All nullable, no backfill required -- every existing project is simply "no pending request".

**Frontend changes (modules/test-management/TestProjects.tsx, types.ts):** new `canReview` (QA Lead, Admin
bypasses via `hasRole`) alongside the existing `canManage` (QA Engineer + QA Lead). A project card with a
pending request shows an `info-banner` naming who asked and for what, and its action row swaps to
Approve/Reject buttons for `canReview` users (a new confirm modal, comments required only for Reject) --
everyone else just sees the pending banner, no action buttons, so a second conflicting request can't be
filed on top of an open one. With no pending request: `canReview` still gets the original direct
Deactivate/Reactivate button; a QA Engineer (`canManage` but not `canReview`) instead gets "Request
deactivation"/"Request reactivation", which opens the same confirm modal with copy that makes clear it
needs QA Lead approval before it takes effect (`changeProjectStatus` itself is unchanged -- it always just
PATCHes `is_active`; the backend decides whether that applies immediately or becomes a request).

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` -- both clean;
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`uploads/` leftovers differ).

## 169. Test Projects page had no search box

**Request:** "Search under project is not working" (reported alongside section 168, both about the
Projects page).

**Root cause:** Not a bug in existing logic -- the Test Projects (Project Management) page never had a
free-text search box at all, only the Active/Inactive/All pill-tabs filter. Every other list page in the
app (QA Requests, Test Repository's case list, Audit Log, Suppression, Sign-Off, the global header search)
has one; this page was the one gap, so typing anywhere on it predictably did nothing -- indistinguishable
from a "broken" search to a user expecting the same pattern as everywhere else.

**Frontend changes (modules/test-management/TestProjects.tsx):** new `search` state, a text input added to
the existing `.toolbar` (reuses the same generic `.toolbar input` styling every other page's search box
already gets, e.g. QA Requests' "Search by request ID, application, or project..."). `visibleProjects`
(previously a plain `.filter()` on `projectFilter` only) is now a `useMemo` that also matches the query
against project name, project key, department, and -- via a new `applicationNameById` lookup map built from
the already-loaded `applications` list -- the linked Application's name, case-insensitively, substring
match, same convention as every other search box in this codebase (e.g. Test Repository's case search).

**Data notes:** none -- presentation-only change, no schema/API impact.

**Verified:** `npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced and confirmed
identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 170. Test Project details had no edit option after creation

**Request:** "Once Project is created, give option to edit details."

**Root cause:** Not a bug -- `PATCH /api/test-projects/{id}` already accepted `name`/`department`/
`description`/`is_active`, but nothing in the frontend ever called it for anything except the Activate/
Deactivate toggle (see section 168). Once a Project was created via `NewProjectModal`, its name, linked
Application, department, and description were effectively permanent from the UI's point of view -- the only
way to fix a typo or re-link the wrong Application was a direct database edit.

**Backend changes (schemas.py, routers/test_projects.py):** `TestProjectUpdate` gains
`application_master_id: Optional[int]`. `update_test_project` now handles it the same way
`create_test_project` already does: validates the given id is a real Application, and -- only if the same
request didn't also explicitly set `department` -- syncs `department` from the Application's own, so
re-linking a Project never silently clobbers a department someone deliberately typed in that same edit. An
explicit `null` clears the link entirely.

**Data notes:** none -- reuses the existing `application_master_id` column and `PATCH` endpoint; no schema
change.

**Frontend changes (modules/test-management/TestProjects.tsx):** new `EditProjectModal`, structurally a
twin of `NewProjectModal` (same Application/Name/Department/Description fields, same auto-fill-on-pick
behavor) but pre-filled from the existing project and `PATCH`ing instead of `POST`ing. A new "Edit" button
on every project card (visible to `canManage` -- QA Engineer or QA Lead, same as every other management
action on this page) opens it; saving merges the updated row back into the project list in place.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` -- both clean;
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`uploads/` leftovers differ).

## 171. Test Repository folders had no rename/edit option after creation

**Request:** "Once folder is created, folder details should be editable" (reported alongside section 170).

**Root cause:** Not a bug -- there was no `PATCH` endpoint for `TestFolder` at all (only `GET`/`POST`/
`DELETE`, plus the `/move` and `/copy` actions added in section 166). A folder's name was fixed forever
from the moment it was created; the only way to "fix" a typo'd folder name was delete-and-recreate, which
`delete_folder` already refuses unless the folder is completely empty (no sub-folders, no test cases) --
so in practice a populated folder's name could never be corrected at all.

**Backend changes (schemas.py, routers/test_repository.py):** new `schemas.TestFolderUpdate { name,
parent_id }` and `PATCH /api/test-repository/folders/{id}` (same `_AUTHOR_ROLES` gate as every other folder
action). Accepts both fields since a general-purpose edit endpoint should be complete on its own, though the
UI (see below) only exposes `name` -- `parent_id` reassignment already has its own dedicated, faster Move
action (section 166) and exposing the same picker a second time here would just be a confusing duplicate
path to the same result. The existing cycle/existence guard from `move_folder` was extracted into a shared
`_validate_new_parent()` helper so both endpoints enforce the identical rule (can't be its own parent,
can't move into its own descendant) from one place instead of two copies drifting apart.

**Data notes:** none -- reuses the existing `qap_test_folders` table; no schema change.

**Frontend changes (modules/test-management/TestRepository.tsx, index.css):** new `RenameFolderModal`
(single Name field, pre-filled) and a 4th icon button in `FolderTreeRows`' per-row actions -- "✎" Rename,
alongside the existing Copy/Move/Delete, same `canAuthor` gate as Copy/Move. `.tm-folder-row .link-btn`'s
reserved right-padding grew from 78px to 100px to fit the fourth action icon without crowding the folder
name/count.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` -- both clean;
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`uploads/` leftovers differ).

## 172. Application Name Approve/Reject moved from each child request to the master QA Request

**Request:** "Request Raised with new application name, so it will go to application owner for
Approve/Reject name, it must be at master request level. not on individual request level of childs."

**Root cause:** Not a bug in the decision logic itself (Approve/Reject always operated on the
`ApplicationMaster` row via `application_master_id`, never on any child request) -- it was a placement
problem. The interactive `ApplicationNameBanner` (Approve/Reject buttons for the Application Owner/SM tier
currently holding the checkpoint) was rendered separately on each of the linked Functional/SAST/DAST/
Performance requests' own Overview tab, instead of once on the master QA Request gateway that actually
introduced the name. Since one QA Request can raise several linked child requests at once (e.g. Functional
+ SAST together), and the same "Other" name can also be reused across separately-raised QA Requests
(`_log_application_name_decision`'s own docstring already noted this), the same decision UI could show up
in multiple different places for the same underlying name.

**Backend changes:** none. `routers/applications.py::decide_app_owner_name` / `decide_application_name`
already took `app_id` (the `ApplicationMaster` row's own id) and were never coupled to any specific child
request -- moving where the banner renders needed no backend change at all.

**Frontend changes (QARequests/RequestDetail.tsx, modules/functional/Functional.tsx, modules/security/
SAST.tsx, modules/security/DAST.tsx, modules/specialised-testing/Performance.tsx,
components/ApplicationNameBanner.tsx):** `ApplicationNameBanner` now renders once, at the top of the master
QA Request gateway's own Overview tab (`RequestDetail.tsx`, right after `GatewayPreview`), gated the same
way it always was (`sameDept || isAdmin`) plus a new `req.status !== "DRAFT"` guard -- `application_master_id`
/`status` get set on every create/edit, even while still a private, freely-editable Draft (see
`_resolve_application_name`'s own docstring), so without this the banner could let someone decide a name
before the requester has even raised the request. Removed entirely from all four child request pages,
along with each page's now-dead `reloadAfterApplicationNameDecision` helper (only ever used by the banner's
own `onDecided`) and the `ApplicationNameBanner` import. Each child page keeps everything else
application-name-aware: the read-only "Pending .../Rejected" status badges, the lifecycle stepper's
`applicationOwnerPending` step, and `applicationNameBlocking` (still blocks the SM/Department Head decision
panel on that specific child request while the name isn't `APPROVED`) -- only the interactive Approve/
Reject widget moved. Each page's `smApplicationNameBlockedMessage` (the block reason shown to an SM once
the name has cleared Application Owner and is sitting at their own tier) was reworded from "decide it
above" -- no longer true, since nothing to decide is on that page anymore -- to point at the request's own
QA Request page instead.

**Data notes:** none -- no schema/API impact, presentation-only relocation.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` and `npx tsc --noEmit -p .` -- both clean;
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`uploads/` leftovers differ).

## 173. Defer linked child-request creation until a new Application Name clears Application Owner approval

**Request:** "process workflow / user raised request with new application name / new name will go for
Approval to Application Owner / once approved, then child request will be generated and will assign to SM."

**Root cause:** Not a bug -- a genuine, unrequested-until-now sequencing gap. Before this change,
`submit_request` created every linked Functional/SAST/DAST/Performance child request (and routed each
straight to `SM_APPROVAL_PENDING`) the instant the gateway was raised, regardless of whether the request's
own Application Name was a brand-new "Other" entry still sitting at `PENDING_APP_OWNER` (see section 172 for
the two-tier `PENDING_APP_OWNER -> PENDING_SM -> APPROVED` chain). So an SM could already be looking at a
freshly-created child request -- and could already be blocked from approving it via `applicationNameBlocking`
-- for an application name an Application Owner hadn't even looked at yet. Nothing was technically broken
(the SM genuinely was blocked), but "child request exists and is sitting in someone's queue" was true well
before the name had cleared its first approval tier, which is what was actually being asked to change here.

**Backend changes (`routers/qa_requests.py`, `routers/applications.py`):**

- Added `_finalize_child_requests(db, obj, requester)` in `qa_requests.py`, factored out of `submit_request`'s
  previous inline tail: unstashes `draft_child_details`, calls `_sync_linked_child_requests` (creates
  whichever linked child request(s) the selected `request_types` call for, each landing straight at
  `SM_APPROVAL_PENDING`/`SM_REJECTED` via `_raise_child_to_sm` as before), calls
  `_promote_draft_checklist_evidence`, clears `draft_child_details`, sets the gateway to
  `GatewayStatus.RAISED`, and logs `"Submitted & Raised"`. `requester` is always the gateway's own original
  requester (`obj.requester`), never whoever is actually making the API call that triggers it -- matters for
  the deferred path below, where an Application Owner's Approve action is what ends up calling this, but the
  child's own "Requester -- Submitted" audit entry must still read as coming from the person who actually
  requested the work.
- `submit_request` now branches right after its existing validation gates (mandatory checklist items,
  DAST/Performance environment) instead of always calling child-creation inline: if
  `obj.application_master_status == "PENDING_APP_OWNER"` (a brand-new name, first tier not yet decided), the
  gateway is left at `GatewayStatus.SUBMITTED` -- assigned its real `request_id` same as any raise, logged
  with an explanatory `"Submitted"` entry ("Awaiting Application Owner approval..."), `draft_child_details`
  deliberately left untouched -- and the function returns without creating a single child or calling SM
  assignment. Any other case (name already `APPROVED`, already past `PENDING_APP_OWNER`, or no name at all)
  calls `_finalize_child_requests` immediately, exactly as before section 172 introduced the two-tier chain --
  this is not a behaviour change for the common case, only for the specific "just-typed a new name" case.
  `GatewayStatus.SUBMITTED` already existed in `constants.py` (`GATEWAY_STATUSES`/`GATEWAY_STATUS_LABELS`) but
  was previously set and instantly overwritten to `RAISED` in the same call, so it never actually persisted;
  this is the first time it's ever genuinely reached.
- `routers/applications.py::decide_app_owner_name` (tier 1) now drives the deferred gateway(s) forward as
  part of the same decision, since by construction only it can ever see a gateway sitting at `SUBMITTED`
  waiting on this exact `ApplicationMaster` row:
  - **Approve:** for every `QARequest` with this `application_master_id` still at `GatewayStatus.SUBMITTED`,
    calls `_finalize_child_requests(db, gw, gw.requester)` right here -- children get created and assigned to
    SM in the same transaction as the name clearing this tier, attributed to the original requester.
  - **Reject:** for every such gateway, instead of the existing `_auto_reject_linked_requests` cascade (which
    only ever had existing children to act on, so was a silent no-op for these), the gateway is reverted
    straight back to `GatewayStatus.DRAFT` with a new `"Requester" / "Reverted to Draft"` `ApprovalAction`
    explaining why. Deliberately **keeps** the already-assigned `request_id` rather than nulling it out --
    the model's own column comment on `QARequest.request_id` says it "stays NULL while Draft," and this is a
    narrow, intentional exception: the ID was already surfaced to the requester and already appears in this
    same gateway's own audit log, so nulling it out would just orphan those references without gaining
    anything. The requester can freely edit and resubmit under a different name from here, same as any other
    Draft. Gateways whose children already exist (i.e. `status != SUBMITTED`) are untouched by this new
    branch and keep going through the existing `_auto_reject_linked_requests` cascade exactly as before.
  - `decide_application_name` (tier 2, SM) needed **no changes** -- by the time a name reaches `PENDING_SM`
    under this design, any gateway that introduced it has already had its children created at tier 1.
  - `applications.py` now imports `_finalize_child_requests` from `routers/qa_requests.py` -- the one
    deliberate cross-router import in this app (confirmed via grep that no other router imports from
    another); safe/no circular import, since `qa_requests.py` imports nothing from `applications.py`.

**Frontend changes (`QARequests/RequestDetail.tsx`):** Reviewed `GatewayPreview.tsx`'s `gatewayStageIndex`
(Draft/Submitted/Raised stepper), the `Badge` colour/label maps, and the Application Name badges/
`ApplicationNameBanner` gating (`req.status !== "DRAFT"`) -- all already correctly anticipated a genuinely-
persisted `SUBMITTED` gateway state and needed no changes. Two things did need updating, since they'd
previously never actually seen a `SUBMITTED` gateway with zero linked children in practice:

- The post-Submit `raisedNotice` modal (`act()` sets it from whatever `POST .../submit` returns) now branches
  on `raisedNotice.status`: the existing "Request Raised... go review each section" copy plus the
  `linkedSections()` list only shows when status is genuinely `RAISED`. A new "Request Submitted" variant
  covers `status === "SUBMITTED"`, explaining that the Application Name needs Application Owner approval
  first, that no linked request has been generated yet, and what happens next (auto-advances to Raised +
  children generated on approval, or reverts to Draft on rejection) -- avoids showing the old copy against a
  guaranteed-empty `linkedSections()` list.
- The "no gateway actions available" status line (shown once a gateway is neither editable, submittable, nor
  cancellable) gained one extra sentence specifically for `status === "SUBMITTED"`, pointing back at the
  `ApplicationNameBanner` above and noting no linked request exists yet -- otherwise the line just read "this
  request has been submitted" with no indication of why nothing else is happening.

Deliberately **not** changed: `GATEWAY_CANCELLABLE_STATUSES` still only allows cancelling from `DRAFT`, so a
gateway sitting at `SUBMITTED` awaiting Application Owner approval cannot currently be cancelled by the
requester (only rejected by the Application Owner, which reverts it to Draft, from where it can be
cancelled). Not part of what was asked; flagging in case the requester should also be able to cancel
directly out of that waiting state.

**Data notes:** none -- no new columns. Purely a status-timing/branching change reusing the existing
`GatewayStatus.SUBMITTED` value and existing `ApplicationMaster`/`QARequest` columns.

**Verified:** `python3 -m py_compile app/routers/qa_requests.py app/routers/applications.py app/models.py
app/constants.py` and `npx tsc --noEmit -p .` -- both clean; Documents and outputs copies re-synced and
confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 174. Pending Approvals nav section (single feed across every approval checkpoint)

**Request:** "The system shall provide a Pending Approvals section in the navigation bar to display all
approval requests awaiting action from the logged-in user." Plus a worked example restating the section 173
Application Owner -> SM flow, describing the exact status wording expected at each step: the master request
shows "Application Owner Approval Pending" until the Application Owner decides; once approved, child
requests are generated and each one requiring SM approval shows "SM Approval Pending" and appears in the
assigned SM's own Pending Approvals section. "Only requests requiring action from the logged-in user shall
be displayed in that user's Pending Approvals section."

**Root cause:** Not a bug -- a missing feature. Before this change there was no single place to see "what's
waiting on me" anywhere in the app. Every approval/decision checkpoint (SM, Department Head, QA Lead
readiness, Security Analyst, Application Owner, Executive COE, QA Lead project-activation) only ever surfaced
on that specific request's own detail page -- a reviewer had to already know which module/request to open.
The one existing thing that sounded like it might cover this, `GET /api/approvals/pending-mine`
(`routers/approvals.py::my_recent_actions`), is misleadingly named: it returns the current user's own PAST
actions (`ApprovalAction.actor_id == current_user.id`), not items currently awaiting a decision -- left
untouched here since other things may already depend on its existing behavior/name.

**Backend changes:**

- New `routers/pending_approvals.py` (registered in `main.py`), `GET /api/pending-approvals` -- a single
  aggregator that inventories every approval/decision checkpoint in the app and, for each one, checks it
  against the CURRENT user's own roles/department/specific assignment the exact same way that checkpoint's
  own decision endpoint already gates the real Approve/Reject call, so this feed can never show something the
  viewer isn't actually allowed to act on and can never hide something they are:
  - Application Name -- Application Owner tier (`ApplicationMaster.status == PENDING_APP_OWNER`) and SM tier
    (`PENDING_SM`) -- mirrors `routers/applications.py::decide_app_owner_name`/`decide_application_name`'s own
    department scoping. Links to whichever QA Request gateway most recently used that name (there's no
    dedicated decision page -- the Approve/Reject widget lives inline on the gateway's own Overview tab, see
    section 172's `ApplicationNameBanner`).
  - Functional/SAST/DAST/Performance -- SM Approval, Department Head Approval (mirrors each module's own
    `sm_decision`/`department_head_decision`, `require_same_department` + `require_not_requester`), and
    Readiness Verification / Security Readiness (mirrors `_require_assigned_qa_lead` -- assigned to one
    SPECIFIC `qa_lead_id`/`security_lead_id`/`engineer_id`, not a department pool). The SM/Department Head
    queries use an outer join to `QARequest` (not an inner join) specifically so any pre-existing legacy
    standalone Functional/SAST/DAST/Performance row (from before standalone creation was disabled -- see
    e.g. `routers/sast_dast.py::create_sast`) with no `qa_request_id` still surfaces instead of silently
    vanishing, with the same "nothing to compare against, so don't block on it" fallback `deps.py::
    require_same_department` itself already uses for a `None` department.
  - Suppression -- SM Approval, Department Head Approval, and Security Team Verification (the last one
    deliberately has no department filter at all, any `SECURITY_ANALYST` -- mirrors
    `routers/suppression.py::security_team_decision`'s own "shared pool, cross-department" design).
  - QA Sign-off -- QA Lead Approval and Executive COE Approval (gated by the REVIEWER's own department being
    `IT - QA`, not the certificate's requesting department -- mirrors `routers/signoff.py::
    _require_qa_department`).
  - Test Project activation/deactivation (`TestProject.pending_is_active is not None`, any `QA_LEAD` --
    mirrors `routers/test_projects.py::review_project_activation`'s own org-wide, unscoped gate exactly, not
    invented here).
  - ADMIN sees every category, org-wide, with no department/assignment filtering at all -- `has_role(...)`
    already treats ADMIN as satisfying any role check, and every one of the mirrored decision endpoints lets
    ADMIN bypass `require_same_department`/`require_not_requester`/the specific-assignment checks the same
    way, so an Admin account already CAN act on every one of these; this feed is just honest about that.
  - Deliberately **not** covered (flagged as a possible follow-up, not silently folded in): Functional/
    Performance "Requester Verification" (the requester confirming their own already-approved work, not a
    peer approving someone else's request) and Test Case review (a QA Lead approving test-case CONTENT, not
    a request/workflow entity).
- New `schemas.PendingApprovalItem` -- a flat, non-ORM response shape (`category`, `entity_type`, `entity_id`,
  `display_id`, `title`, `status`, `status_label`, `department`, `submitted_by`, `submitted_at`, `path`) since
  results are built up from many different tables with no single row shape to map `from_attributes` onto.
- **Wording match** (`backend/app/constants.py` + `frontend/src/constants.ts`
  `APPLICATION_MASTER_STATUS_LABELS`, plus every hardcoded copy of the same badge text in
  `components/Common.tsx::applicationNameAwareStatusLabel`, `QARequests/RequestDetail.tsx`, and each of
  `Functional.tsx`/`SAST.tsx`/`DAST.tsx`/`Performance.tsx`): reworded `PENDING_APP_OWNER`'s label from
  "Pending Application Owner Approval" to **"Application Owner Approval Pending"** to match the requirement's
  exact quoted wording. `PENDING_SM`'s Application-Name-tier label ("Pending SM Approval") was left as-is --
  the requirement's "SM Approval Pending" wording refers to a CHILD request's own `SM_APPROVAL_PENDING`
  status (already labelled "SM Approval Pending" verbatim in `QA_REQUEST_STATUS_LABELS`/
  `SAST_DAST_STATUS_LABELS`/`PERFORMANCE_STATUS_LABELS`, unchanged), not the two-tier Application Name
  approval chain's own second tier, which is a different thing.

**Frontend changes:**

- New `types.ts::PendingApprovalItem` (mirrors the backend schema) and new
  `modules/governance/PendingApprovals.tsx` -- a plain list page (same `Card`/`Table`/`PageHeader` pattern as
  `Approvals.tsx`'s existing Approval Workflow Log), grouped by a `Checkpoint` category column with an
  optional category filter dropdown built from whatever categories are actually present for this user (varies
  a lot person to person). Clicking a row navigates to that item's own `path` -- there's no separate decision
  UI on this page itself; the Approve/Reject action always lives on the item's own page (the
  `ApplicationNameBanner`, an SM/Department Head decision panel, etc.), same as before this feed existed.
  Shows an empty state ("Nothing is currently awaiting your action...") rather than a bare empty table when
  there's genuinely nothing pending.
- New route `/pending-approvals` (`App.tsx`) and new nav item "Pending Approvals" in the Governance group
  (`components/Layout.tsx`, between "QA Sign-off" and "Approval Workflow Log"), with a live count badge --
  the one deliberate exception to every other nav item's own count, which is computed but currently switched
  off (commented out) in the sidebar; since the whole point of this page is "how many things need me right
  now," a silent nav entry would defeat it.
- `modules/test-management/TestProjects.tsx` gained `?open=<project_key>` deep-link support (same pattern as
  `Functional.tsx`/`SAST.tsx`/`DAST.tsx`/`Performance.tsx`/`Suppression.tsx`/`SignOff.tsx` already had, which
  this page never did) -- there's no separate single-project detail view to jump into here (the
  pending-activation banner is shown inline per row), so "opening" a project means pre-filling the existing
  search box with that `project_key` instead, surfacing the specific project a QA Lead's Pending Approvals
  item points at.

**Data notes:** none -- no new columns or tables. Purely a new read-only aggregation endpoint over existing
data, plus display-wording changes to two existing string constants.

**Verified:** `python3 -m py_compile app/main.py app/schemas.py app/constants.py app/routers/pending_approvals.py`
and `npx tsc --noEmit -p .` -- both clean; Documents and outputs copies re-synced and confirmed identical via
`diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 175. Application Name banner stayed stale and multi-clickable after an Application Owner reject

**Request:** "currently while application owner rejected the name, as modal opened it's not updating and user
can click approve or reject button multiple time. we can show some message and close the drawer else suggest
how to handle."

**Root cause:** `ApplicationNameBanner`'s `decide()` awaited its own `onDecided()` callback
(`RequestDetail.tsx::reloadAfterApplicationNameDecision`, a plain `GET /api/qa-requests/{id}` refetch) inside
the SAME try/catch as the actual Approve/Reject POST. Rejecting a brand-new name at the Application Owner
tier reverts that gateway straight back to `GatewayStatus.DRAFT` (see section 173's
`decide_app_owner_name`) -- and Draft is requester/admin-only (`_can_view_gateway`), so the Application Owner
who just rejected it immediately loses the ability to even re-fetch the same request. That reload's 403 was
caught by the banner's own catch block and shown as if the DECISION itself had failed, even though the POST
had already succeeded server-side. Worse, since the reload never completed, `onChanged` was never called, so
`applicationMasterStatus` stayed stuck at its stale pre-decision value (`PENDING_APP_OWNER`) -- the banner
kept re-rendering with `canDecideHere` still true and the buttons re-enabled (`busy` resets to `null` in
`finally` regardless), letting the same reviewer click Approve/Reject again against a name that had already
moved on, and the surrounding modal never visibly updated or closed.

**Frontend changes:**

- `components/ApplicationNameBanner.tsx`: added a local `decided` state, set the instant the Approve/Reject
  POST itself succeeds -- independent of whatever the parent's reload does or doesn't manage to do
  afterward. Once `decided` is set, the interactive Approve/Reject buttons are replaced with a small
  confirmation ("Application Name approved/rejected...") and the component's own early-return guard
  (`!canDecideHere`) no longer hides it, so the confirmation stays visible even after
  `applicationMasterStatus` would otherwise make `canDecideHere` false. `onDecided(decision)` is now called
  without being awaited inside the POST's own try/catch, so a reload failure downstream can never again be
  misattributed to the decision itself. `onDecided`'s signature changed from `() => void` to
  `(decision: 'Approved' | 'Rejected') => void` so the parent knows which decision just happened.
- `QARequests/RequestDetail.tsx::reloadAfterApplicationNameDecision`: now takes the `decision` and wraps its
  own `GET` in a try/catch instead of letting it throw back into the banner. On success, `onChanged(fresh)`
  exactly as before. On failure (the reviewer lost visibility), sets a new `appNameDecisionNotice` message
  instead -- worded specifically for the Reject-at-Application-Owner-tier case ("...it has been returned to
  the requester as a Draft and is no longer visible to you here"), with a generic fallback for any other
  reload failure. A new `InfoModal` (same pattern as the existing `draftNotice`/`raisedNotice` pop-ups)
  renders that message; dismissing it both clears the notice and calls `onClose()`, closing this whole
  request-detail modal, since there is nothing left in it for that viewer to look at -- directly implements
  "we can show some message and close the drawer."

**Data notes:** none -- purely frontend state/UX handling around an already-correct backend decision endpoint
(section 173's `decide_app_owner_name` itself was never buggy; only the reviewer's OWN client-side view of
the outcome was).

**Verified:** `npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced and confirmed identical
via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 176. Pending Approvals notice on login

**Request:** "also show one info on login if there are any pending approval pending."

**Root cause:** Not a bug -- a new notification. Section 174 added the Pending Approvals nav item/page/live
badge, but all of it is pull-only -- a person has to think to open the sidebar and notice the badge. Nothing
proactively told anyone, at the one moment they're most likely to act on it (right after signing in), that
something is waiting on them.

**Frontend changes:**

- `context/AuthContext.tsx`: added `justLoggedIn` (boolean) and `acknowledgeLogin()` to the context value.
  `login()` sets `justLoggedIn = true` right after a successful sign-in; `logout()` clears it.
  Deliberately NOT set by `loadMe()` (the session-restore path a page refresh/new tab takes) -- so this only
  ever fires on an actual login, not on every reload of an already-signed-in session, mirroring how
  `DepartmentPrompt` is scoped to a real state flag (`needs_department_selection`) rather than "every time
  Protected happens to mount."
- New `components/PendingApprovalsNotice.tsx`: while `justLoggedIn` is true, fetches
  `GET /api/pending-approvals` (the same feed behind the Pending Approvals page, see section 174) once. If
  the count is 0 or the fetch fails, it silently calls `acknowledgeLogin()` -- no pop-up, no error shown, so
  a person with nothing pending (the common case) sees nothing extra at all. If there's at least one item, it
  shows a single `InfoModal` ("Pending Approvals") with the count and a link straight to `/pending-approvals`;
  dismissing it (either the link or the modal's own "Got it") calls `acknowledgeLogin()`, so it can't reappear
  again this session (until the next actual login).
- `App.tsx`'s `Protected` wrapper renders `<PendingApprovalsNotice />` alongside the existing
  `<DepartmentPrompt />`, gated on `!user.needs_department_selection` so a first-ever LDAP login (which
  already shows a blocking, `preventBackdropClose` department-selection dialog) never stacks a second pop-up
  on top of it -- `justLoggedIn` stays true across that whole exchange, so `PendingApprovalsNotice` still
  fires the moment `DepartmentPrompt` is dismissed, rather than being skipped for that login entirely.

**Data notes:** none -- reuses the existing `GET /api/pending-approvals` endpoint (section 174) as-is.

**Verified:** `npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced and confirmed identical
via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 177. Application Name reject flow: skip the doomed reload instead of firing-then-catching

**Request:** Follow-up to section 175, reported directly with screenshots: an Application Owner rejecting a
brand-new name still saw a raw "Action could not be completed" pop-up (`Reason: This request was never raised
(still Draft, or Cancelled before being raised) and is only visible to its requester`), and the
Approve/Reject buttons were still showing afterward in the request-detail drawer.

**Root cause:** Section 175 fixed this by catching the post-decision reload's failure and converting it into
a friendly notice, but still ATTEMPTED the reload first and only reacted after the fact -- `ErrorText` (see
`components/Common.tsx`) renders as a full blocking `Modal`, not inline text, so ANY code path that still
left a raw error sitting in a local `error` state (including, before section 175, `ApplicationNameBanner`'s
own `error` state, since the reload used to be awaited inside the SAME try/catch as the decision POST) shows
up exactly as this "Action could not be completed" dialog. Since rejecting a brand-new name at the
Application Owner tier reverting the gateway straight to `Draft` (requester/admin-only, `_can_view_gateway`)
is entirely predictable from information already available client-side the moment Reject is clicked
(`req.application_master_status` was `PENDING_APP_OWNER`, and this reviewer is neither the requester nor an
Admin), there was no need to ever fire that reload in the first place for this specific, common case.

**Frontend changes (`QARequests/RequestDetail.tsx::reloadAfterApplicationNameDecision`):** now checks, before
attempting anything, whether `decision === "Rejected"` AND the gateway was at the Application Owner tier
(`req.application_master_status === "PENDING_APP_OWNER"`, captured from the still-current `req` prop, read
before this decision) AND the current viewer is neither the requester nor an Admin (`isRequester`/`isAdmin`,
both already computed earlier in this component). When all three hold, it shows the "returned to the
requester as a Draft" notice immediately and returns -- no network call, so there's nothing left that could
ever surface a raw backend error for this case, and no timing window during which the banner (see section
175's own `decided` local state, already correct) could be left showing stale, re-enabled buttons. Every
other case (Approve at either tier, Reject at the SM tier, or a Reject by the requester/an Admin who can
still view the reverted Draft) is untouched -- still attempts the normal reload, with the section 175 catch
kept in place as a fallback for any other way it could fail (e.g. someone else cancelled the request in the
meantime).

**Data notes:** none -- client-side only, reusing fields already present on `QARequestOut`.

**Verified:** `npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced and confirmed identical
via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 178. Block raising a QA Request while its resolved Application Name is REJECTED (sibling-gateway bug)

**Request:** Reported directly: "though application name rejected, still allow to raise sibling request."

**Root cause:** `_resolve_application_name` (see its own docstring) makes any two QA Requests that type the
identical brand-new "Other" Application Name share one `ApplicationMaster` row -- so a "sibling" gateway
still sitting in Draft, never itself submitted, could resolve to the exact same name as another gateway whose
Application Owner (or SM) later rejected that name. `application_master_status` is a live delegated property
(see `models.QARequest`), so the sibling's status already read `REJECTED` the moment the other gateway's
rejection was recorded -- but nothing about that sibling changes automatically, because
`_resolve_application_name` only re-resolves (and un-rejects a matching row back to `PENDING_APP_OWNER`) when
the Application Name field is actually re-saved via create/edit. Clicking Submit alone never re-saves that
field. `submit_request` only special-cased `application_master_status == "PENDING_APP_OWNER"` (to defer child
creation, section 173) -- every other status, including `REJECTED`, fell through to the immediate-raise path,
so the sibling raised clean and its own linked children were born silently pre-rejected
(`_raise_child_to_sm`'s own `REJECTED` branch sends new children straight to `SM_REJECTED`) instead of the
raise itself ever being stopped.

**Backend changes (`routers/qa_requests.py::submit_request`):** added a guard immediately after the existing
DRAFT-status check, before `request_id` is assigned -- if `obj.application_master_status == "REJECTED"`,
raise `HTTPException(400, ...)` telling the requester to edit the request and either choose a different
Application Name or re-select/re-type the same name to resubmit it for fresh approval before raising. A
gateway can now never raise while resolved to a rejected name, regardless of how it got into that state
(rejected directly, or rejected via a sibling sharing the same name).

**Frontend changes (`QARequests/RequestDetail.tsx`):** added `applicationNameRejected =
req.application_master_status === "REJECTED"`. When `canSubmit && applicationNameRejected`, a new red warning
box replaces the existing yellow "mandatory checklist pending" box (only one of the two shows at a time) with
the same edit-or-resubmit guidance as the backend error. The Submit/Raise button's `disabled` now also
includes `applicationNameRejected`, with a matching `title` tooltip, so the block is visible and pre-empted
client-side rather than only surfacing as a 400 after the click.

**Data notes:** none -- no schema changes; reuses the existing `application_master_status` delegated property.

**Verified:** `python3 -m py_compile app/routers/qa_requests.py` -- clean; `npx tsc --noEmit -p .` -- clean;
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`uploads/` leftovers differ).

## 179. ApplicationNameBanner: resync on a FAILED decision too, not just a successful one

**Request:** Reported directly, again, after sections 175/177: "STILL IN DRAWER SHWOING FOR APPROVE/REJECT. on
button click it should refresh if rejected."

**Root cause:** Sections 175/177 correctly fixed the success path -- `decide()`'s local `decided` state is set
the instant the decision POST itself succeeds, so the banner switches to its read-only confirmation
regardless of anything that happens afterward. What neither section addressed: if that POST *fails*, `decided`
never gets set, and the banner keeps rendering its live Approve/Reject buttons -- exactly this report. The
most likely real-world way this happens with the code already working correctly everywhere else: two
reviewers with the same checkpoint (e.g. two Application Owners, or an Application Owner and someone acting
as SM) both have this same drawer open, and the second one to click gets a 400 from
`decide_app_owner_name`/`decide_application_name`'s own `if obj.status != "PENDING_..."` guard, because the
first reviewer's decision already landed. That 400 shows correctly as the `ErrorText` dialog (`"This
application name is not awaiting Application Owner decision -- its current status is 'REJECTED'"` or
similar), but once dismissed, the buttons underneath were still sitting there completely unchanged --
untouched local state, and nothing had ever told the banner to go check what actually happened.

**Frontend changes:**
- `components/ApplicationNameBanner.tsx`: added a new required prop, `onRefresh: () => void`, distinct from
  the existing `onDecided`. `decide()`'s `catch` branch now calls `onRefresh()` (previously did nothing beyond
  `setError`). Deliberately NOT `onDecided` here -- that callback assumes the decision succeeded and would
  incorrectly fire the "rejected, returned to requester" notice (closing the whole drawer) over a click that
  never actually went through. The success path also now `await`s `onDecided(decision)` (previously
  fire-and-forget) so the parent's own refresh/notice has actually finished before the click's lifecycle ends,
  with its own error swallowed locally (the parent already turns any of its own reload failures into a
  user-facing notice; must not double up on that in this banner too).
- `QARequests/RequestDetail.tsx`: added `silentRefreshRequest()` -- a plain, honest, best-effort `GET
  /api/qa-requests/{req.id}` -> `onChanged(fresh)`, swallowing any failure silently (if this reviewer can no
  longer even view it, the `ErrorText` dialog already shown is the explanation; nothing more to add). Passed
  as the new `onRefresh` prop on `<ApplicationNameBanner>`. Once the fresh data lands, `canDecideHere`
  naturally recomputes false if someone else's decision already moved the name past this reviewer's tier, and
  the banner hides its buttons on its own -- same outcome as a normal successful decision, without ever
  claiming this reviewer's own attempt had succeeded.

**Data notes:** none -- client-side only, reuses the existing `GET /api/qa-requests/{id}` endpoint.

**Verified:** `npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced and confirmed identical
via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 180. Application Name approval: single-tier (Application Owner only), no separate SM decision

**Request:** Reported directly: "only application owner approval required, no SM involvment. if application
owner approved then automatically come to SM for readiness verification and all."

**Root cause / context:** The 2026-08 two-tier chain (sections 173-179) had an Application Owner decide first
(PENDING_APP_OWNER), and only once they approved did the name move to a SECOND, separate SM decision
(PENDING_SM, `decide_application_name`) before finally becoming APPROVED and unblocking the request's own
downstream SM readiness-verification checkpoint (`application_name_block_message` in constants.py blocks SM/
Department Head Approve on the request itself while the name is anything other than APPROVED). This meant an
SM effectively had to clear the name TWICE conceptually: once via the Application-Name-specific decision, then
again via the request's own normal readiness-verification approval -- exactly the redundant "SM involvement"
this report asks to remove. Only the Application Owner's decision on the name itself should exist; once they
approve, the linked child request(s) should land directly on the SM's normal queue with nothing
name-specific left for the SM to separately decide.

**Backend changes:**
- `routers/applications.py::decide_app_owner_name`: Approve is now immediately terminal -- sets
  `obj.status = "APPROVED"` directly (was `"PENDING_SM"`), and now also populates `decided_by_id`/
  `decided_at`/`comments` (the SM-tier-named fields) on Approve, mirroring what Reject already did on this
  tier ("the decision that made this terminal"). Child-request finalization for any gateway still sitting at
  `SUBMITTED` (see section 173's deferred-creation branch) is unchanged -- still happens right here, still
  attributed to the original requester -- so those children now go straight to their assigned SM's own normal
  readiness-verification queue the moment the Application Owner approves, with no separate name decision left
  for that SM to make.
- `routers/applications.py::decide_application_name` (the old second-tier `/decision` endpoint): left in place,
  unremoved, but now documented as LEGACY-ONLY -- no NEW `ApplicationMaster` row can ever reach `PENDING_SM`
  again, so this endpoint can only ever act on a row that predates this change. Kept purely as a safety net for
  any such row the one-time data fix-up below might miss, rather than leaving it permanently stuck.
- `models.py::ApplicationMaster` docstring and the `app_owner_decided_by_id`/`app_owner_comments` field
  comments rewritten for the single-tier model; `constants.py::APPLICATION_MASTER_STATUSES`/
  `APPLICATION_MASTER_STATUS_LABELS` comments updated the same way. `PENDING_SM` is kept as a valid status
  value in both places (not removed) -- purely so any legacy row still round-trips correctly through the API
  and existing display code while it's cleaned up.

**Frontend changes (`components/ApplicationNameBanner.tsx`):** updated the pending-decision banner copy and
the post-decision confirmation copy to stop saying an Application Owner Approve "moves the name on to SM for
final approval" -- it now says the name becomes selectable immediately and the linked request has moved on to
SM for readiness verification. `isSmTier`/`PENDING_SM` branch in the component is unchanged code-wise (still
present for any legacy row) but is now documented as unreachable for any name created after this change.

**Data notes:** one-time fix-up for any `ApplicationMaster` row already sitting at `PENDING_SM` from before
this change (i.e. an Application Owner had already approved it under the old two-tier flow, and it's just
waiting on an SM who, per this request, should no longer need to act) -- promote it straight to `APPROVED`,
reusing its own already-recorded Application Owner decision as the terminal one:
```sql
UPDATE qap_application_master
SET status = 'APPROVED',
    decided_by_id = app_owner_decided_by_id,
    decided_at = app_owner_decided_at,
    comments = app_owner_comments
WHERE status = 'PENDING_SM';
```
No column/table DDL changes -- `PENDING_SM` and every column already existed; this is a data-only fix-up, not
executed against any live database from this sandbox (no DB connection available here, per this doc's own
standing convention -- to be run by whoever has Oracle access when this change is deployed).

**Verified:** `python3 -m py_compile app/routers/applications.py app/models.py app/constants.py` -- clean;
`npx tsc --noEmit -p .` -- clean; Documents and outputs copies re-synced and confirmed identical via
`diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 181. Codebase audit: unused imports/variables and one dead-code cleanup

**Request:** Reported directly: "check any bug, or wiring issue, or unused code. fix it."

**Method:** No linter (pyflakes/flake8) was installable in this sandbox (no network access), so unused Python
imports were found with a small one-off `ast`-based script (flags an imported name that never appears as a
bare identifier reference anywhere else in the same file). Unused TypeScript locals/imports were found by
running `npx tsc --noEmit -p . --noUnusedLocals --noUnusedParameters` (the project's own `tsconfig.json` keeps
both OFF for normal builds -- not changed, just passed as one-off CLI flags for this audit). Also swept for
`TODO`/`FIXME`/`XXX`/`HACK` markers, `console.log`/`debugger` leftovers, bare `except:` clauses, and checked
that every backend router is registered in `main.py` and every frontend sidebar nav path (`components/
Layout.tsx`) resolves to a route actually defined in `App.tsx` -- none of those turned up anything.

**Backend fixes:**
- `auth.py`: removed unused `JWTError` import from the `jose` import line -- `decode_access_token` doesn't
  catch it itself; `deps.py::get_current_user` already imports its own `JWTError` and handles it correctly, so
  this one was a genuine leftover, not a missing error-handling bug.
- `routers/dashboard.py`: removed unused `QA_REQUEST_TERMINAL_STATUSES` from the `constants` import line.

**Frontend fixes:**
- `Dashboard.tsx`: removed unused `useCallback` import; removed the unused destructured `label` in `Donut`'s
  `entries.map(([label, v], i) => ...)` (only `v` was ever used); removed an unused local `const navigate =
  useNavigate()` in `CommandCentre` (a same-named, actually-used `navigate` already exists independently in
  `MyRequestsTab` further down the same file -- these are two different components, not a shared/broken
  reference).
- `modules/functional/Functional.tsx`, `modules/security/SAST.tsx`, `modules/security/DAST.tsx`, `modules/
  specialised-testing/Performance.tsx`: removed unused `FUNCTIONAL_EDITABLE_STATUSES`/
  `SAST_DAST_EDITABLE_STATUSES` (x2)/`PERFORMANCE_EDITABLE_STATUSES` imports from `constants.ts`. Checked each
  page's own `canEditDetails` logic first, since an unused "editable statuses" constant sitting next to
  hand-rolled permission logic is exactly the shape a real permission bug would take -- confirmed each page's
  inline status list is a correct, intentional decomposition of the same constant (some of those statuses are
  requester-editable, others are the current reviewer's own pending-decision stage, gated by role +
  same-department instead of a flat list), not a drifted duplicate. The exported constants themselves are left
  in `constants.ts` -- still documented there as mirroring the equivalent backend constant, still meaningful
  as a parity reference even though nothing currently imports them.
- `modules/test-management/TestExecution.tsx`: removed unused `TEST_CYCLE_STATUSES` import.
- `QARequests/index.tsx`: removed a dead `const canCreate = hasRole(user, "REQUESTER", "BUSINESS_ANALYST")`
  and the commented-out `+ Raise QA Request` button it was written for (`actions={canCreate && <button
  ...>}`, disabled as a JSX comment, not deleted). Confirmed this wasn't an accidentally-hidden feature: the
  topbar's own "New QA request" button (`components/Layout.tsx`, `hasRole(user, 'REQUESTER',
  'BUSINESS_ANALYST')`) already provides the exact same action with the exact same role gate and is the
  real, working entry point (it navigates to `/qa-requests` with `{ state: { openNew: true } }`, which this
  page's own `useEffect` already listens for). Left a plain comment explaining where the button actually lives
  instead of resurrecting a duplicate. Removing `canCreate` also left `hasRole` and the destructured `user`
  (from `useAuth()`) unused in this file -- removed both, and the now-unnecessary `useAuth` import, rather than
  leaving a second layer of newly-dead code behind.

**Data notes:** none -- no schema/behavioural changes, pure dead-code removal plus one JSX-placement fix (the
"Raise QA Request" explanatory comment had to move outside `<PageHeader ... />`'s own attribute list, since
`{/* ... */}` between JSX attributes isn't valid there -- confirmed via `tsc`).

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` -- clean; `npx tsc --noEmit -p .` (normal) --
clean; `npx tsc --noEmit -p . --noUnusedLocals --noUnusedParameters` -- clean except the pre-existing,
harmless `'React' is declared but its value is never read` on every file's default React import (expected
under the `jsx: "react-jsx"` transform, not a real issue, left as-is). Documents and outputs copies re-synced
and confirmed identical via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 182. Help & User Manual readable without logging in

**Request:** Reported directly: "Help & user Manual should come on login page as well, without login atleast
user can read."

**Root cause / context:** `/help` was wrapped in `Protected` (`App.tsx`), same as every other page, so an
unauthenticated visitor hitting it was bounced straight to `/login`. `Help.tsx` itself, though, is entirely
static content -- no `useAuth()`, no `api.get`/`api.post` calls anywhere in it (checked directly) -- so nothing
about it actually needs a signed-in session; the login requirement was just inherited from the same blanket
`Protected` wrapper every other, genuinely data-driven page uses.

**Frontend changes:**
- `App.tsx`: the `/help` route now renders a new `HelpRoute` component instead of `<Protected><Help
  /></Protected>` directly. `HelpRoute` checks auth state itself: while still loading, shows the same
  plain-text loading state `Protected` already uses; once resolved, a signed-in user gets exactly the same
  `<Protected><Help /></Protected>` as before (sidebar, `DepartmentPrompt`, pending-approvals notice --
  nothing changed for the signed-in path); a signed-out visitor gets a new `PublicHelp` component instead --
  a minimal standalone shell (a slim top bar with the bank/QualityHub brand mark and a "← Back to sign in"
  link) wrapped around the exact same `<Help />` content, rather than maintaining a second copy of the manual.
  The manual's own internal "quick link" tiles (Raise a QA Request, My Pending Approvals, etc.) still point at
  genuinely protected pages -- clicking one while signed out lands on `/login` same as navigating there
  directly, which is correct (reading the manual doesn't imply access to act on anything in it).
- `Login.tsx`: added a second `Help & User Manual` link (`<Link to="/help">`) right under the existing "Need
  access? Contact your QualityHub administrator." line, so the manual is discoverable straight from the sign-in
  screen, not just reachable by guessing the URL.
- `index.css`: new `.public-help-shell`/`.public-help-topbar`/`.public-help-brand`/`.public-help-back` rules
  for the standalone shell (reproduces the 24px page padding `Layout`'s own `.content` normally provides,
  since there's no `Layout` in this path; hidden entirely under `@media print`, matching how the signed-in
  Help page already hides its own chrome when printed/saved as PDF); `.login-help a`/`.login-help +
  .login-help` for the new link's colour and spacing on the login page.

**Data notes:** none -- purely a routing/presentation change, no backend involvement (Help.tsx never called
the backend to begin with).

**Verified:** `npx tsc --noEmit -p .` -- clean. Documents and outputs copies re-synced and confirmed identical
via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 183. Dashboard: collapse the 3W governance tracker behind a toggle

**Request:** Reported directly: "Dashboard is too much of details and tracker." Asked to clarify the intended
direction (trim entirely / collapse behind toggles / remove specific sections) -- chose "collapse detail
behind toggles": keep all the existing data, but hide the dense/tracker-style sections by default so the
initial view is clean, with a way to expand back to the full detail.

**Scope:** The default "Dashboard" tab (`CommandCentre` in `Dashboard.tsx`) is what every visitor lands on
first, so it was the target -- the other tabs (Security, Suppression, 3W Pending Items, Requests, QA Tester
Overview) are each an explicit, deliberate navigation choice already, not something shown unsolicited. Within
`CommandCentre`, the "3W project governance" card was clearly the densest, most tracker-like piece: a 3-way
tab switcher (Overview/Projects/Ageing) containing a bar chart, a donut, a full search/team/priority/ageing
filter toolbar, a CSV export button, and a paginated attention table -- all rendered immediately, above the
lighter-weight Lifecycle/Activity section further down the page. That lighter section (a lifecycle stepper +
a short 6-item recent-activity list) was left alone -- it reads as a compact summary, not a tracker, and
matches what a decluttered dashboard should still show.

**Frontend changes (`Dashboard.tsx::CommandCentre`):** added a `govExpanded` state, defaulting to `false`. The
card's own KPI strip (Total pending / SLA breached / Critical-high / Owning teams -- 4 plain numbers) stays
always visible, immediately followed by a one-line summary sentence when collapsed ("N pending items across N
teams -- click Show details for the breakdown, ageing, and full list"). The `Overview`/`Projects`/`Ageing` tab
bodies (chart, donut, filter toolbar, tables) now all additionally require `govExpanded` to render, and the
tab-switcher pills themselves only show once expanded (they have nothing to switch between while collapsed).
A "Show details" / "Hide details" button in the card's own header toggles `govExpanded`. Nothing was deleted
-- every chart, filter, and table is exactly as before, one click away instead of on-screen unconditionally.

**Data notes:** none -- client-side-only presentation change, no new/changed API calls.

**Verified:** `npx tsc --noEmit -p .` -- clean. Documents and outputs copies re-synced and confirmed identical
via `diff -rq` (only the standard `.env`/`uploads/` leftovers differ).

## 184. Eliminate wasted/duplicate API calls (nav badges + Dashboard tab switching)

**Request:** Reported directly: "there are lots of api calling, sometime same api calling multiple time, also
i see api is getting late."

**Finding #1 -- the big one (`components/Layout.tsx`):** `Layout` wraps every single protected page (see
`App.tsx`'s `Protected`), and its `loadCounts()` was refetching, on **every route change**
(`useEffect(() => { loadCounts() }, [loadCounts, location.pathname])`): the full `/api/qa-requests`,
`/api/functional-requests`, `/api/sast-requests`, `/api/dast-requests`, `/api/performance-requests`,
`/api/suppressions`, and `/api/signoffs` lists, plus (for Admin accounts) the entire `/api/auth/users/all`
table -- 8 heavy calls, on top of whatever the page being navigated to fetches for itself, every time anyone
clicked anywhere in the app. Checked the nav item render (`{item.to === '/pending-approvals' && ... <span
className="nav-count">}`) and confirmed only the Pending Approvals badge is ever actually displayed -- every
other one of those 8 calls fed a `count` that was computed and stored but never rendered anywhere (a leftover
from an earlier design where every nav item had a live badge, since disabled in the render but never removed
from the fetch). Fixed by deleting the dead computations entirely: `loadCounts` now only calls
`/api/pending-approvals`, `NavCounts` shrunk to `{ pendingApprovals: number }`, and the `count` prop was
removed from every nav item except Pending Approvals. Also removed the now-dead `isOpenSecurityStatus` helper
and the constants/type imports (`GATEWAY_TERMINAL_STATUSES`, `QA_ACTIVE_STATUSES`,
`SAST_DAST_TERMINAL_STATUSES`, `PERFORMANCE_TERMINAL_STATUSES`, `SUPPRESSION_TERMINAL_STATUSES`,
`QARequestOut`, `FunctionalOut`, `SASTOut`, `DASTOut`, `PerformanceOut`, `SuppressionOut`, `SignOffOut`) that
only existed to support them. This alone cuts every navigation anywhere in the app from 8 extra full-list
fetches (9 for Admins) down to 1 small aggregator call.

**Finding #2 (`Dashboard.tsx`):** `CommandCentre` (the default "Dashboard" tab) and `MyRequestsTab` (the
"Requests" tab) each independently fetched their own copies of the same 5 endpoints
(`/api/qa-requests`/`/api/functional-requests`/`/api/sast-requests`/`/api/dast-requests`/
`/api/performance-requests`) -- since only one tab is ever mounted at a time, switching from "Dashboard" to
"Requests" and back re-fetched all 5 lists on every switch, a direct match for "same api calling multiple
time." Fixed by lifting that fetch up to the parent `Dashboard` component (fetched once via a new `useEffect`
there) and passing the results down as props (`requests`/`functionalRequests`/`sastRequests`/`dastRequests`/
`performanceRequests`/`requestsLoaded`/`requestsError`) to both `CommandCentre` and `MyRequestsTab`, which no
longer fetch these themselves. `CommandCentre` still runs its own smaller fetch for what only it needs
(`/api/dashboard/project-wise`, `/api/dashboard/3w`, `/api/approvals` -- 3 calls, down from 8) and now also
surfaces `requestsError` (previously, a failure in the shared fetch would have left it stuck on a perpetual
"Loading..." rather than showing an error). `SecurityTab`, `SuppressionTab`, `ThreeWTab`, and
`TesterOverviewTab` were left untouched -- each already fetches only its own distinct dashboard-aggregation
endpoint, no duplication there.

**Not changed:** backend endpoint implementations themselves were not audited for N+1 query patterns or
missing indexes in this pass -- this fix targeted the concretely-identified duplicate/wasted frontend calls,
which account for the large majority of request volume described (every navigation, everywhere in the app).
If pages still feel slow after this, that would point at the endpoints themselves rather than call volume, and
is worth a separate, focused look.

**Data notes:** none -- client-side-only, no schema or endpoint changes.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` -- clean (no backend files touched, run anyway
per the standing verification habit); `npx tsc --noEmit -p .` and `npx tsc --noEmit -p .
--noUnusedLocals --noUnusedParameters` -- both clean (the latter confirms no new dead imports/locals were left
behind by the removals above). Documents and outputs copies re-synced and confirmed identical via `diff -rq`
(only the standard `.env`/`uploads/` leftovers differ).

## 185. Pending-approvals badge: cache across Layout remounts (follow-up to section 184)

**Request:** Follow-up, reported directly: "still there are some calls are multiple times." Asked where --
answer: "Just navigating around generally" (not tied to one specific page/action).

**Root cause:** `App.tsx` defines 21 independent top-level `<Route path="..." element={<Protected><Page
/></Protected>}>` entries -- there is no single shared parent/layout route with an `<Outlet/>` that every page
renders inside. That means `Layout` (sidebar, topbar, and -- after section 184 -- its one remaining
`/api/pending-approvals` fetch) doesn't just re-run an effect on navigation, it fully **unmounts and remounts**
on every single route change, since each navigation switches to matching a completely different top-level
`<Route>` element. A fresh mount means a fresh `useState({ pendingApprovals: 0 })` and a fresh `loadCounts()`
call every time -- so "just navigating around" was still re-hitting `/api/pending-approvals` on literally every
click, which is exactly the residual "same api calling multiple time" being described. (Restructuring routing
so every page shares one persistent Layout instance via nested routes + `<Outlet/>` would be the more complete
fix, but that's a much larger, riskier change touching all 21 routes -- out of scope for this pass.)

**Frontend changes (`components/Layout.tsx`):** added a module-level cache (`pendingApprovalsCache: { count,
fetchedAt } | null`, `PENDING_APPROVALS_CACHE_MS = 20000`) declared outside the component, so it survives a
remount the way component state can't. `loadCounts()` now checks this cache first -- if fetched within the
last 20 seconds, it reuses the cached count instead of calling the endpoint again; only once that window
expires does it actually re-fetch (and refresh the cache). The initial `counts` state is also seeded from the
cache (if present) instead of always starting at 0, so a remount doesn't even flash a stale zero badge while
waiting. Added `handleLogout()` (clears `pendingApprovalsCache` before calling the real `logout()`) so a
different account signing in on the same browser tab right after can't briefly inherit the previous account's
cached count.

**Trade-off, stated plainly:** the badge can now lag up to ~20 seconds behind reality if someone else's
decision changes what's pending for you while you're actively clicking around the app -- accepted deliberately
in exchange for not re-fetching on every single navigation; 20 seconds was chosen as short enough that the
badge still feels live, long enough that rapid navigation (the reported symptom) doesn't defeat the point.

**Data notes:** none -- client-side-only, reuses the existing `GET /api/pending-approvals` endpoint.

**Verified:** `npx tsc --noEmit -p .` and the same command with `--noUnusedLocals --noUnusedParameters` --
both clean. Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`uploads/` leftovers differ).

## 186. The real fix: one shared, persistent Layout via nested routes (replaces section 185's cache)

**Request:** Explicit follow-up to section 185's mitigation: "do the real fix."

**Root cause (recap from 185):** `App.tsx` had 21 independent top-level `<Route path="..." element={<Protected>
<Page /></Protected>}>` entries -- no shared parent route, so `Protected`/`Layout` fully unmounted and
remounted on every single navigation between pages, refetching the pending-approvals badge (and, before
section 184, 7 other full-list endpoints) every time. Section 185 added a module-level cache so the repeated
mounts wouldn't repeatedly hit the network, but the underlying churn -- Layout's entire sidebar/topbar tree,
and every bit of its component state (menu-open, expanded nav groups, search box text) -- was still being
torn down and rebuilt on every click.

**The actual fix (`App.tsx`):** restructured routing to use a React Router v6 "layout route" -- a single
pathless parent `<Route element={<ProtectedLayout />}>` wrapping every protected page as a nested child
`<Route>`, rendered via `<Outlet/>`. `ProtectedLayout` does the exact same auth check as the old `Protected`
(loading state, redirect to `/login` if signed out), but now renders `<AuthenticatedChrome user={user}><Outlet
/></AuthenticatedChrome>` instead of `<Layout>{children}</Layout>` -- `AuthenticatedChrome` (new, factored out
of the old `Protected`) is the actual `Layout` + `DepartmentPrompt` + `PendingApprovalsNotice` chrome, now
shared verbatim by both this and `HelpRoute` (see below) instead of duplicated. Every one of the 18 previously
top-level protected routes (`/`, `/qa-requests`, `/functional-requests`, `/sast`, `/dast`, `/suppression`,
`/performance`, `/signoff`, `/pending-approvals`, `/approvals`, `/reports`, `/admin`, `/department-admin`,
`/audit-log`, `/checklist-config`, `/test-projects`, `/test-repository`, `/test-execution`) moved to become a
child of this one parent route, keeping its own `path` and `ModuleBoundary` wrapping exactly as before --
only the auth-gating wrapper moved from being repeated per-route to being shared once at the parent. The
practical effect: `Layout` now mounts once for the whole signed-in session and stays mounted while navigating
between any of these 18 pages -- only the page content inside `<Outlet/>` swaps (React Router unmounts/mounts
the *child* route's own element as before, which is correct and desired -- each page's own state should still
reset when you navigate to a different page; what's fixed is the shared chrome around it no longer doing the
same).

**Deliberate exception -- `/help`:** left as its own separate top-level route (`HelpRoute`, unchanged in
shape from section 182) rather than folded into the new nested group, because it's the one page that must
keep working both signed in AND signed out -- a child of an auth-gated parent route can never render for a
signed-out visitor (the parent would already have redirected to `/login` before any child route is
evaluated). `HelpRoute`'s signed-in branch now calls the same shared `AuthenticatedChrome` component the main
nested group uses (previously it called `<Protected><Help /></Protected>`, now-removed) so the experience is
identical -- the one accepted trade-off is that navigating to/from `/help` specifically still remounts
`Layout`, since it sits outside the shared parent route. Given `/help` is a low-traffic reference page, not
part of the day-to-day click-around-between-pages flow the report was about, this was judged an acceptable,
clearly-documented exception rather than a reason to block the fix or attempt a more convoluted merge of the
signed-in/signed-out cases.

**Section 185's cache:** left in place in `components/Layout.tsx` (harmless, not reverted) -- with Layout no
longer remounting on ordinary navigation, `loadCounts()`'s own `useEffect(() => { loadCounts() }, [loadCounts,
location.pathname])` still re-invokes on every pathname change (Layout itself doesn't unmount, but this
specific effect's dependency still fires), so the cache now serves as a simple "don't hit the network more
than once every 20 seconds" throttle within a single long-lived mount instead of surviving repeated
mounts -- still exactly the behavior wanted, just for a slightly different reason than originally written.

**Data notes:** none -- purely a client-side routing restructure, no backend or endpoint changes.

**Verified:** `npx tsc --noEmit -p .` and `npx tsc --noEmit -p . --noUnusedLocals --noUnusedParameters` --
both clean. A full `vite build` could not be run in this sandbox (pre-existing, unrelated environment issue --
`Cannot find module @rollup/rollup-linux-arm64-gnu`, a known npm optional-dependency bug, not caused by this
change); `tsc` is this project's established verification method throughout every prior change in this
document and remains clean here. Documents and outputs copies re-synced and confirmed identical via `diff -rq`
(only the standard `.env`/`uploads/` leftovers differ). Recommended follow-up for whoever deploys this: run
`npm run build` in a normal (non-sandboxed) environment once to confirm the production bundle builds clean,
and click through a few pages to confirm Layout no longer visibly "flickers" (sidebar/topbar re-mounting) on
navigation.

## 187. Batch the per-checklist-item evidence documents fetch (Functional/SAST/DAST/Performance)

**Request:** Reported directly with server log evidence -- opening a raised Functional request (#161, with 8
readiness checklist items) fired 8 parallel `GET /api/functional-requests/161/checklist/{item_id}/documents`
calls (ids 201-208), one per item, in a single page load: "why multiple documents call? can we just not make
single one."

**Root cause:** `ChecklistEvidence` (`components/Common.tsx`) is rendered once per readiness-checklist item
next to each row (in both the requester's edit modal and the raised request's detail/checklist tab, across
all 4 modules), and every instance independently ran its own `useEffect(() => { load() }, [load])` fetching
just that one item's documents on mount -- N checklist items on a page meant N simultaneous GETs. This is the
exact same anti-pattern already fixed once in this document (section 31/32) for the pre-raise QA Request
wizard's sibling component, `ChecklistEvidencePicker` -- that fix batched the *draft* evidence fetch; this one
had never been applied to `ChecklistEvidence`, the separate component used for already-raised requests.

**Backend changes:** added one new batched `GET .../checklist/documents` endpoint per module, alongside the
existing per-item one (different path-segment count, so no routing ambiguity):
- `routers/functional.py`: `list_functional_checklist_documents_batch`
- `routers/performance.py`: `list_performance_checklist_documents_batch`
- `routers/sast_dast.py`: `list_sast_checklist_documents_batch` (`/api/sast-requests/...`) and
  `list_dast_checklist_documents_batch` (`/api/dast-requests/...`)

Each looks up every checklist item belonging to the request (one query), then fetches every one of those
items' documents in a single `WHERE module = ? AND request_id IN (...)` query via a new shared helper,
`documents.py::list_documents_for_items` (recall: for the `*_ITEM` modules, `RequestDocument.request_id`
actually stores the checklist item's own id, not the parent request's -- same convention as the existing
per-item endpoints). Response is a flat list (`schemas.ChecklistItemDocumentOut`, extends `RequestDocumentOut`
with an `item_id` field) so the frontend can regroup it into per-item buckets -- same shape convention as
section 31's `DraftChecklistEvidenceOut`. The existing per-item GET/POST/download/DELETE endpoints are
untouched; uploads and deletes still go through them one item at a time (only the *read* fetch was the N+1).

**Frontend changes:**
- `components/Common.tsx`: added `useChecklistDocuments(apiBase, reqId)`, a small hook that calls the new
  batched endpoint once and returns `{ documentsByItem, reload }`. `ChecklistEvidence` no longer fetches its
  own documents -- it now takes `documents: RequestDocumentOut[]` and `onReload: () => void` as props (mirrors
  `ChecklistEvidencePicker`'s existing `savedFiles`/`onReload` props from section 32); upload/delete still hit
  this item's own per-item endpoint, then call `onReload()` instead of a local `load()` so every instance on
  the page picks up the change from one shared re-fetch.
- `types.ts`: added `ChecklistItemDocumentOut` (mirrors the new backend schema).
- Wired `useChecklistDocuments` into all 8 render sites (editing-modal + raised-detail view, x4 modules):
  `modules/functional/Functional.tsx` (`FunctionalFormModal`, `FunctionalDetail`), `modules/security/SAST.tsx`
  (`SASTFormModal`, `SASTDetail`), `modules/security/DAST.tsx` (`DASTFormModal`, `DASTDetail`),
  `modules/specialised-testing/Performance.tsx` (`PerformanceFormModal`, `PerformanceDetail`) -- each calls the
  hook once per component instance and passes `documentsByItem[c.id] || []` / the shared `reload` down to
  every `<ChecklistEvidence/>` in that component's own checklist `.map()`.

**Data notes:** none -- no schema changes, existing `RequestDocument` table and `*_ITEM` module keying reused
as-is.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` -- clean. `npx tsc --noEmit -p .` -- clean.
Documents and outputs copies re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/`uploads/` leftovers differ).

## 188. Pending Approvals / Application Name: Draft leakage, stale duplicate entries, and a silent re-flip on plain Save

**Request:** Five bugs reported together, all around the Application Name -- Application Owner Approval
checkpoint: (1) Draft QA Requests shouldn't appear in Pending Approvals; (2) editing the Application Name
should update the existing approval entry, not add a second one; (3) only the latest name should show for
approval; (4) the original name shouldn't remain as a separate pending entry; (5) rejecting a name, having the
gateway revert to Draft, then simply clicking Edit and Save (not Submit/Raise) was sending it back for
approval anyway.

**Root cause 1 (Draft leakage, covers bug 1 and much of bug 5):**
`pending_approvals.py::_application_master_items` queried every `ApplicationMaster` row with status
`PENDING_APP_OWNER`/`PENDING_SM` with no regard for whether the QA Request gateway that actually needs the
decision had ever been Submitted -- a name only ever used by a still-Draft (or Cancelled) gateway showed up
in the aggregator exactly the same as one genuinely awaiting a real decision.

**Root cause 2 (silent re-flip on plain Save, the rest of bug 5):** `routers/qa_requests.py::edit_request`
called `_resolve_application_name` (which flips a `REJECTED` row straight back to `PENDING_APP_OWNER`,
treating it as a fresh proposal) whenever the request body included an `application_name` key at all --
`exclude_unset=True` was meant to make this a no-op unless the requester actually touched that field, but the
wizard (`NewRequestModal.tsx`) always resends the current `application_name` value on every Save regardless of
which step was actually edited, so this fired on every single save of a Draft, not just ones that changed the
name.

**Root cause 3 (bugs 2-4, stale duplicate entries):** `_resolve_application_name`'s own docstring already
called this out as accepted queue clutter: if a requester swaps one brand-new (still-pending) Application Name
for a different one while still in Draft, the FIRST name's `ApplicationMaster` row was simply left behind,
still `PENDING_APP_OWNER`, with nothing pointing at it any more except its own now-stale `qa_request_id` --
Pending Approvals would then show both the abandoned old name and the new one for what looks like one request.

**Backend changes (`routers/qa_requests.py`):**
- `edit_request`'s Application Name handling now compares the incoming (uppercased) name against
  `obj.application_name` and only calls `_resolve_application_name` when it's genuinely different -- a plain
  re-save with the name field unchanged is now a complete no-op for `ApplicationMaster`, so it can never
  re-flip a `REJECTED` row back to pending just because the wizard resent the same value. A consequence,
  called out directly in a new comment on `submit_request`'s existing `REJECTED` block: simply re-selecting
  the exact same rejected name no longer un-rejects it on its own -- a genuinely different Application Name is
  now the only way through, so that endpoint's error message was reworded to drop the now-incorrect
  "or re-select/re-type this same name" suggestion.
- New `_cleanup_orphaned_application_master(db, old_master_id, qa_request_id)`: called right after
  `edit_request` resolves to a genuinely different name. If the name this request used to point at is still
  un-decided (`PENDING_APP_OWNER`/`PENDING_SM`) and no OTHER QA Request still resolves to it, the row is
  deleted outright -- there's no audit trail keyed off the `ApplicationMaster` row itself (`ApprovalAction`
  entries key off the QA Request/child request's own id), and nothing else needs it. A row that was already
  `APPROVED`/`REJECTED` (a real decision was made) is never touched, regardless of who still points at it.

**Backend changes (`routers/pending_approvals.py`):** `_application_master_items` now looks up, per candidate
`ApplicationMaster` row, whether at least one QA Request gateway resolving to it is in a status other than
Draft/Cancelled (`_active_gateway`, replacing the old `_gateway_path`'s inline query with the same lookup
reused for both the exclusion check and the existing "link to the right gateway" display logic) -- a row with
no such gateway is skipped entirely, for both the Application Owner and legacy SM tiers.

**Data notes:** none -- no schema changes. `_cleanup_orphaned_application_master` deletes rows, but only ones
that were never decided and are provably unreferenced by any other QA Request at the moment of deletion.

**Verified:** `python3 -m py_compile app/*.py app/routers/*.py` -- clean. No frontend changes were needed for
any of the 5 reports (all backend query/resolve logic). Documents and outputs copies re-synced and confirmed
identical via `diff -rq` (only the standard `.env` leftover differs).
