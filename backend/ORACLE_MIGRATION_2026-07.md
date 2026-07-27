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
> is split into a `shell/` (Login, Command Centre, the QA Request gateway -- cross-cutting, not owned
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
