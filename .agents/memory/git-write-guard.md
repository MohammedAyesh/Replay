---
name: Git write guard
description: Replit workspace Git mutations may require an explicit environment override.
---

When a user authorizes fetching or merging and Git blocks a metadata write such as `FETCH_HEAD`, retry the exact intended command with `DANGEROUSLY_ALLOW_GIT=1`. Inspect the worktree before the operation and preserve history with a normal merge when requested; do not treat the override as permission for unrelated destructive Git operations.

**Why:** The workspace guard blocks some Git metadata writes to prevent accidental changes to the user's repository state.

**How to apply:** Use this only for the specific Git operation the user authorized, such as fetch followed by a normal merge.
