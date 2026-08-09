# Test Management — Ownership & Permissions Model

Reference for who can do what across Test Projects, Test Repository, and Test Execution. Covers the
enforcement built in `ORACLE_MIGRATION_2026-07.md` sections 10, 12 (bulk submit), 13, 14 (Project Lead
rename), 15 (widening review-tier actions to project-role Reviewer/Project Lead/Owner), and 17 (the
two-stage Test Approval Workflow refactor — Reviewer recommends, QA Lead gives final approval). Source of
truth is `backend/app/deps.py`'s "Test Management -- project-scoped role enforcement" section plus
`can_manage_project` — this document explains it in plain language, the code is authoritative if the two
ever disagree.

## The two layers

**1. System roles** (`QA_ENGINEER`, `QA_LEAD`, `CHEIF_MANAGER_QA`, `ADMIN`) — assigned to a user account, apply everywhere in
the portal. `ADMIN` always bypasses every check in this document (`has_role()` treats Admin as satisfying
any role check).

**2. Project roles** (`Owner`, `Project Lead`, `Author`, `Tester`, `Reviewer`, `Viewer`) — assigned per
person, per Test Project, via that project's **Members** list (`TestProjectMember.project_role`). These only
ever **add a restriction on top of** a person's system role — never grant something their system role
wouldn't otherwise allow.

> The project role was originally also called `"QA Lead"`, which collided with the system role `QA_LEAD` and
> caused confusion (two different mechanisms, same name). It was renamed to `"Project Lead"` in section 14
> of the migration log. Holding system `QA_LEAD` gives you elevated rights on *every* project automatically.
> Holding project role `"Project Lead"` on one specific project gives you the same elevated rights on *just
> that project*, even if your system role is only `QA_ENGINEER`.

## The backward-compatible rule (read this first)

Project membership is opt-in per project:

- **Not a member of a project?** You get full access from your system role alone, exactly as if project
  roles didn't exist. Most existing projects have no members configured yet, so nothing changed for them.
- **Added as a member with a role?** That role now restricts you, even if your system role would otherwise
  allow more. Example: someone is `QA_ENGINEER` system-wide (normally allowed to author test cases
  anywhere) but is added to Project X as `"Viewer"` — inside Project X they can no longer create or edit
  test cases, only view them.
- **System `QA_LEAD` (or Admin) always keeps full access to everything below, on every project, member or
  not.** Only `QA_ENGINEER`-tier access is ever narrowed by project membership.

**Two deliberate exceptions to "not a member = unrestricted," flagged where they apply below:**

- **Repository review-tier actions** (recommend/return a Stage-1 decision, checkout override, archive/
  restore, delete a folder, bulk-recommend — section 15 of `ORACLE_MIGRATION_2026-07.md`) — a `QA_ENGINEER`
  gets these rights on a project **only** by being an actual member of that project holding `Reviewer`,
  `Project Lead`, or `Owner`. A non-member `QA_ENGINEER` does **not** get a free pass here, unlike every
  other `QA_ENGINEER`-tier action in this document. This is deliberate: this is this app's maker-checker
  (GOV-002) control, so "not configured yet = wide open" would be the wrong default for who's allowed to
  review.
- The "cycle already has execution attempts, scope changes need Lead-tier approval" rule (CYC-007) — see the
  Execution table.

**A third, narrower tier sits on top of the above (section 17 — the Test Approval Workflow refactor):**
Stage-2 final approval (approve/return/reject once a test case has already been recommended) requires
`can_give_final_approval`, which is **strictly narrower** than `can_review_repository` — project role
`Project Lead`/`Owner` only, or system `QA_LEAD`/Admin. Holding plain project role **Reviewer** satisfies
`can_review_repository` (Stage 1) but does **not** satisfy `can_give_final_approval` (Stage 2). Same
strict-membership pattern (no non-member fallback) as `can_review_repository`.

## Who's who (project roles)

| Project role | What it grants inside that one project |
|---|---|
| **Owner** | Everything below: full Repository (author + review) + full Execution (record results + governance) + can manage this project's own membership. Auto-assigned to whoever is set as the project's Owner (`TestProject.owner_id`); normally exactly one person. |
| **Project Lead** | Same practical capability as Owner for Repository and Execution (author + review + tester + governance) — but **not** membership management or editing the project's own record (name/department/owner). Those two require being the actual `owner_id` or holding system `QA_LEAD`. |
| **Author** | Repository write only: create/edit/submit/delete/checkout/clone test cases and folders, bulk update/delete, import Excel, reassign a test case's own Reviewer/QA Lead override. No review rights, no execution rights. |
| **Reviewer** | Repository **Stage-1** review/governance only: recommend or return a test case that's `In Review`, archive/restore, checkout override, delete a folder, bulk-recommend. Does **not** grant Stage-2 final approval (approve/reject once `Review Completed`) — that requires **Project Lead** or **Owner**. No authoring rights, no execution rights. |
| **Tester** | Execution write: create/edit cycles, perform permitted lifecycle actions, manage cycle testcases and runners, and record results while a cycle is In Progress. No cycle deletion governance or repository rights. |
| **Viewer** | None of the above — read-only. |

## Who's who (system roles, unaffected by any project membership)

| System role | Baseline access everywhere |
|---|---|
| **ADMIN** | Everything, on every project, always. |
| **QA_LEAD** | Full Repository + Execution author/tester/governance/review tier on every project by default (same as being every project's Owner), plus: approve/reject activation requests, archive/unarchive a project, and resolve project-scope-change locks. Can be *further* narrowed only if explicitly demoted via project membership on a specific project — but see the CYC-007 exception below, where system `QA_LEAD` still always passes regardless. |
| **CHEIF_MANAGER_QA (CM-QA)** | Project-scoped Test Management access only. Selecting this user as **Default CM-QA (Stage 2)** automatically adds them as **Project Lead**; that membership grants Stage 2 final approval and Project Lead repository/execution rights on that project, without granting blanket access to every project. |
| **QA_ENGINEER** | Baseline authoring/execution tier (create test cases, create cycles, record results) — this is the tier that project membership can narrow per project. Can always create a new project and request activation/deactivation on any project, regardless of membership. |

## Full action matrix — Test Projects

| Action | Who can do it |
|---|---|
| Create a new project | System `QA_ENGINEER` or `QA_LEAD` (unrestricted — no project exists yet to be a member of) |
| Edit project details (name, department, linked application, description, reassign owner) | Project's own **Owner** (`owner_id` match), or system `QA_LEAD`/Admin. A non-owner `QA_ENGINEER` cannot, even if they're an Author/Tester/Reviewer/Project Lead member. |
| Request activation / deactivation | Any `QA_ENGINEER` or `QA_LEAD`, regardless of ownership/membership |
| Approve / reject an activation request | System `QA_LEAD`/Admin only |
| Archive / Unarchive a project | System `QA_LEAD`/Admin only — **not** extended to the project Owner; an Owner who is only `QA_ENGINEER` system-wide cannot archive their own project |
| Add / remove / change a member's role | Project's own **Owner** (`owner_id` match), or system `QA_LEAD`/Admin |
| Set approval defaults | The Default Reviewer is automatically added/promoted to project role **Reviewer**. The Default CM-QA (Stage 2) must hold `CHEIF_MANAGER_QA` and is automatically added/promoted to **Project Lead**. Owner/Project Lead memberships are never downgraded. |
| View the member list | Anyone signed in |

## Full action matrix — Test Repository

| Action | Who can do it |
|---|---|
| Create / edit / move / copy a folder | System `QA_ENGINEER`/`QA_LEAD`, and (if a member) project role **Author**, **Project Lead**, or **Owner** |
| Delete a folder | System `QA_LEAD`/Admin (always), **or** a `QA_ENGINEER` who is a member of this project holding **Reviewer**, **Project Lead**, or **Owner** — a non-member `QA_ENGINEER` is rejected (see note below) |
| Create / edit / delete a test case | System `QA_ENGINEER`/`QA_LEAD`, and (if a member) **Author**, **Project Lead**, or **Owner** |
| Checkout / check back in | Same as create/edit above — **except** checking your own held checkout back in is always allowed to whoever holds it (or Admin), with no project-role restriction, so a demoted role can't get stuck holding a lock it can no longer release |
| Checkout override (force-release someone else's lock) | System `QA_LEAD`/Admin (always), **or** a `QA_ENGINEER` who is a member of this project holding **Reviewer**, **Project Lead**, or **Owner** — same non-member rejection as above |
| Submit for review (single or bulk) | Same as create/edit — **Author**-tier. Moves `Draft`/`Returned` → `In Review`, defaults `assigned_reviewer_id`/`assigned_qa_lead_id` from the project's own defaults if not already set. |
| Reassign a test case's Reviewer/QA Lead (`PATCH .../approvers`) | Same as create/edit — **Author**-tier. Routing/visibility only — does **not** change who is authorized to act; see section 17 of `ORACLE_MIGRATION_2026-07.md`. |
| **Stage 1** — Recommend / return a decision while `In Review` (single or bulk-recommend) | System `QA_LEAD`/Admin (always), **or** a `QA_ENGINEER` who is a member of this project holding **Reviewer**, **Project Lead**, or **Owner** — same non-member rejection as above (`can_review_repository`). GOV-002: the author of the draft being reviewed can never act on their own work, regardless of role. `RECOMMEND` moves the case to `Review Completed`; `RETURN` moves it to `Returned`. |
| **Stage 2** — Approve / return / reject a decision while `Review Completed` (single or bulk-approve) | System `QA_LEAD`/Admin (always), or a project member holding **Project Lead**/**Owner**. The project default for this stage is labelled **CM-QA** and selecting it automatically grants **Project Lead** membership. Plain **Reviewer** is **not** enough (`can_give_final_approval`, strictly narrower than Stage 1). Same GOV-002 self-approval block. `APPROVE` moves the case to `Approved`; `RETURN` moves it to `Returned`; `REJECT` moves it to terminal `Rejected`. |
| Archive / restore an approved test case | Same as Stage 1 — same **Reviewer**-tier rule, same non-member rejection |
| Clone a test case | Author-tier, checked against the **destination** project (not the source, if cloning across projects) |
| Bulk update / bulk delete | Author-tier |
| Import from Excel | Author-tier |
| View / browse | Anyone signed in, no project-role restriction |

## Full action matrix — Test Execution

| Action | Who can do it |
|---|---|
| Create / edit a cycle | System `QA_ENGINEER`/`QA_LEAD`, and (if a member) **Tester**, **Project Lead**, or **Owner** |
| Delete an empty cycle | System `QA_LEAD`/Admin, or an eligible Test Management user (including CM-QA) who is a member holding **Project Lead** or **Owner** — **Tester** is not enough |
| Add / remove test cases from an *unstarted* cycle | **Tester**-tier |
| Add / remove test cases once the cycle has recorded attempts (CYC-007) | System `QA_LEAD`/Admin, **or** project role **Project Lead**/**Owner** on that project — a non-member `QA_ENGINEER` does **not** get a free pass here even though they'd normally be unrestricted when not a member. This is the one deliberate exception to the backward-compatible rule. |
| Transition a cycle into `Ready` | Same as edit above, **plus** server-side readiness validation: the cycle must have at least one test case, every test case must be `Approved`, every execution must have an assigned tester, and dates must be set and consistent. Validated against the fully-updated cycle object, not stale pre-update state. |
| Other lifecycle transitions | Only `Ready → In Progress`, `In Progress → Blocked/Completed`, and `Blocked → In Progress`. Blocking requires a reason; Completed is terminal. Every change is written to activity history. |
| Assign / reassign a runner | **Tester**-tier, plus must be on the Test Management team (department check, unrelated to project role — see below) |
| Upgrade a stale pinned version | **Tester**-tier |
| Record a result (single, bulk, or rich/with screenshots) | **Tester**-tier, the cycle must be `In Progress`, plus (unless Admin) the user must be the assigned runner |
| Link / unlink a defect | **Tester**-tier |
| Delete an evidence screenshot | **Tester**-tier, plus must be the uploader or Admin |
| Remove a test case from a cycle (single or bulk) | **Tester**-tier, same CYC-007 exception as above once attempts exist |
| View cycles / executions / reports | Anyone signed in, no project-role restriction |

## Who's eligible to appear in a Test Management user picker

Every user picker in Projects/Repository/Execution (Project owner, Project members, default Reviewer/
default QA Lead, per-item Reviewer/QA Lead reassignment, Cycle owner) — plus the runner-eligibility and
assignment-manager department checks in `test_execution.py` — is scoped to `constants.
TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS` (currently just `["COE - Quality Assurance"]`), served via `GET /api/test-projects/
eligible-users`. This is a **list**, not a single hardcoded department, specifically so a second team (e.g.
a `"TCS-QA"` vendor team) can be onboarded later by appending one string in `constants.py` rather than
touching every picker and check individually — see section 18 of `ORACLE_MIGRATION_2026-07.md`. Every other
module in the app (SAST/DAST/Functional/Performance/Suppression/Sign-off/QA Requests/Approvals) still uses
the unfiltered app-wide `GET /api/auth/users` list, unaffected by this.

## Known gaps / inconsistencies (not yet restricted by project role)

Flagging these so they're a deliberate choice, not an oversight:

- **Test Reports (all 8 views)** — any authenticated user can view any project's reports if they know the
  project ID; there's no project-membership check on the report endpoints at all, only the cross-project
  Portfolio report applies department scoping.
- **Archive/Unarchive project** stays strictly system-`QA_LEAD`-only, not extendable to a project's own Owner.

Happy to close any of these the same way if you want them tightened.
