---
name: GitHub REST commit fallback
description: Preserving an existing local commit when using GitHub REST after shell Git authentication fails.
---

When shell `git push` cannot authenticate but the connected GitHub integration works, use the Git Database API to reproduce the local commit: upload exact file blobs, verify the new tree SHA equals the local tree SHA, create a commit with the same parent and author/committer metadata, and update the branch with `force: false` only while it still points at the expected parent. Preserve the commit message bytes, including its final newline.

**Why:** Different blob bytes change the tree, and omitting the final message newline changes the commit SHA. Large shell output may clip encoded file content without an obvious truncation flag.

**How to apply:** Use `readFile` with an explicit `maxBytes` for large files. Compare blob, tree, and commit hashes before updating the ref; leave the branch untouched if any check fails.