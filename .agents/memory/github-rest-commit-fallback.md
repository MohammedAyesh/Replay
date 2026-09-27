---
name: GitHub REST commit fallback
description: Preserving an existing local commit when using GitHub REST after shell Git authentication fails.
---

When shell `git push` cannot authenticate but the connected GitHub integration works, use the Git Database API to reproduce the local commit: upload exact file blobs, verify the new tree SHA equals the local tree SHA, create a commit with the same parent and author/committer metadata, and update the branch with `force: false` only while it still points at the expected parent. Preserve the commit message bytes, including its final newline.

When the workspace can switch branches between tool calls, do not assume the checked-out file matches the commit being pushed; source content from the immutable Git blob SHA. Large shell output can silently clip base64, even when the shell result does not report truncation. Keep base64 chunks as separate strings across the impure-call boundary; a single large string may be silently truncated. When using `dd` on the `git cat-file` pipe, include `iflag=fullblock` because a short pipe read can otherwise return fewer bytes without an error.

**Why:** Different blob bytes change the tree, and omitting the final message newline changes the commit SHA. A stale or switched worktree can silently supply content from another branch. The connector bridge can truncate large strings, and `dd` can short-read a pipe unless full-block reads are enabled.

**How to apply:** Prefer `readFile` with an explicit `maxBytes` only after confirming the target revision. Otherwise read blobs by SHA in small full-block chunks (12 KB raw chunks are a safe size), pass base64 chunks as an array, join and hash them inside the impure function, then compare tree and commit hashes. Update a ref only if it still points to the expected parent; leave it untouched if any check fails.