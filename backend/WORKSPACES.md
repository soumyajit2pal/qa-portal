# Workspaces

A Workspace is the global data boundary for the portal. Every active user is
a member of at least one workspace, including requesters, approvers, QA,
security, developers, and administrators.

The seed owns one fixed fallback workspace: key `DEFAULT`, name
`Default Workspace`. System Administrators are required members, and a user
without any membership receives it on first login.

For normal users, DEFAULT is fallback-only. Assigning a non-default workspace
removes DEFAULT; removing the final non-default membership restores DEFAULT.
Users may still belong to several non-default workspaces. System Administrators
remain required members of every workspace.

- The workspace selector in the global header chooses the active workspace.
- Requests and projects are created in that active workspace and stay there.
- Dashboards, lists, search, approvals, reports, test management, defects, and
  future Scrum data are filtered to the active workspace.
- A user with access to several workspaces can switch between them. Data from
  the previous workspace is cleared by a full page reload.
- When an Administrator removes a user's last membership from a workspace,
  the server automatically moves that user to the active default workspace.
- Every System Administrator is a required member of every workspace. New
  workspaces and newly granted Administrator roles receive these memberships
  automatically, and they cannot be removed while the role remains assigned.
- Department remains an organisation and approval attribute. It does not grant
  access to another workspace.
- A top-level workspace can contain direct child workspaces. This is a single
  parent/child level; a child cannot contain another child.
- Selecting a child shows that child's records only. Selecting a parent shows
  the parent's own records plus accessible child workspaces. Direct members
  see explicitly assigned children; Parent Workspace Viewer/Admin grants and
  a parent-level Department Coordinator assignment cover every active direct
  child. Inaccessible siblings are never included.
- Department Coordinator scope follows the workspace hierarchy. Assigning it
  on a parent grants the same department-scoped local administration in each
  active child. Assigning it directly on a child remains child-only. The UI
  shows inherited assignments on the child as locked; they must be changed on
  the parent.
- Use child workspaces for operating units that need separate members, queues,
  projects, testing, defects, or reports. Department units are retained only as
  historical organization metadata and do not participate in authorization or
  request routing.
- The Permission Profile controls what a user can do. Workspace membership
  controls where they can do it. Administrators manage the profile once in
  Users & Access and do not repeat those roles for each workspace.

The API uses `X-Workspace-ID`. The server validates the selected workspace
against the user's direct and inherited workspace access. The former
`X-QA-Workspace-ID` header and `/api/qa-workspaces` routes remain temporary
compatibility aliases.

Existing Oracle table and column names retain their `qa_workspace` wording to
avoid a destructive production migration. Their product meaning is global.
Migration `7e2c4a9b1d60` promotes any remaining legacy workspace roles into
the user's Permission Profile and reduces membership to one row per user and
workspace. Migration `e9a4c2f7b801` adds the one-level parent workspace
relationship.
