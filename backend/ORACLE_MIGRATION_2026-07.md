# QA Portal — Fix/Change Log

The original `ORACLE_MIGRATION_2026-07.md` (which had grown to 215 numbered
sections tracking every fix and refactor made to this app) was deleted in
commit `8e77c98` ("defect fix, along with application upload:") on
2026-08-06, outside of this log's own maintenance process. This file starts
a fresh log from section 1, documenting fixes and changes going forward.

## 1. Sidebar navigation groups now default to closed

**Reported:** the sidebar's navigation groups (Overview, Request Management,
Functional, Test Management, Security, Specialized Testing, Governance,
Administration, Help & Support) were all expanded by default on load —
requested that they default to closed instead.

**Fix:** `frontend/src/components/Layout.tsx` — `expandedGroups` state
(the `Set<string>` backing each group's open/closed toggle button) now
initializes empty instead of pre-populated with every group's label. The
existing effect that auto-expands whichever group contains the current
route (keyed off `activeGroup?.label`) is unchanged, so the active section
is still never hidden on load — only the other groups now start collapsed
instead of everything being expanded up front.

**Verified:** `npx tsc --noEmit -p .` — clean. Documents and outputs copies
re-synced and confirmed identical via `diff -rq` (only the standard
`.env`/uploads leftovers differ).
