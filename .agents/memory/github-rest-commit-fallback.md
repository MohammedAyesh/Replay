---
name: GitHub REST commit fallback
description: Preserving an existing local commit when using GitHub REST after shell Git authentication fails.
---

When shell `git push` cannot authenticate but the connected GitHub integration works, use the Git Database API to reproduce the local commit: upload exact file blobs, verify the new tree SHA equals the local tree SHA, create a commit with the same parent and author/committer metadata, and update the branch with `force: false` only while it still points at the expected parent. Preserve the commit message bytes, including its final newline.

When the workspace can switch branches between tool calls, do not assume the checked-out file matches the commit being pushed; source content from the immutable Git blob SHA. Large shell output can silently clip base64, even when the shell result does not report truncation. Retrieve large base64 blobs in small, newline-trimmed chunks and verify the Git blob hash before making API writes.

**Why:** Different blob bytes change the tree, and omitting the final message newline changes the commit SHA. A stale or switched worktree can silently supply content from another branch.

**How to apply:** Prefer `readFile` with an explicit `maxBytes` only after confirming the target revision. Otherwise read blobs by SHA, verify blob hashes, then compare tree and commit hashes. Update a ref only if it still points to the expected parent; leave it untouched if any check fails.