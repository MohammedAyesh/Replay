---
name: Workspace type declarations
description: Refreshing project-reference declarations after shared database type changes.
---

After changing a public type in `lib/db`, run `pnpm run typecheck:libs` before package-level TypeScript checks. Project packages can continue to see stale emitted declarations even though the source type has changed.

**Why:** The API server initially could not see a new optional manifest field from the updated database type; rebuilding the workspace libraries refreshed the declaration and the package check passed.

**How to apply:** When a downstream package reports a missing property that is present in a shared library's source, rebuild the workspace libraries first, then rerun the affected package check.