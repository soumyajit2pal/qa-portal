# Legacy QA Workspace Notes

The former QA-only workspace model is now the portal's global Workspace model.
The current behavior, parent/child hierarchy, membership rules, and deployment
revision are documented in [WORKSPACES.md](WORKSPACES.md).

Database tables and compatibility API routes retain `qa_workspace` in their
technical names to avoid a destructive production migration. Product screens
and authorization treat them as organization-wide workspaces.
