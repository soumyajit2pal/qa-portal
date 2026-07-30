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

## 36. Dashboard: "My Requests & My Department" moved out of Command Centre into its own tab (no schema/backend change)

Frontend-only. `Dashboard.tsx`'s Command Centre tab previously embedded a department/personal-scoped
card ("My Requests & My Department", toggling between the logged-in user's own requests and their
department's, capped at 8 rows) alongside the org-wide stats -- moved into a new dedicated top-level
tab, `MyRequestsTab` (labelled "My Requests" in the tab bar), with no row cap. Command Centre's "At a
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
`Dashboard.tsx` (Command Centre and My Requests tab both dropped their Automation fetch/unify/terminal-status
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
Aging distribution 16 pending how is calculating?" The four Command Centre "At a Glance" cards and the
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

## 107. Command Centre: added a "Raised" date-range filter (within 1 hour / within 1 month / custom From-To)

**Why:** reported directly -- "In dashboard add filter like within 1 hr raised, 1 month, from date to to
date." The Command Centre had no way to narrow any of its data down to a specific time window; everything
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
