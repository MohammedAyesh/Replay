---
name: Port owner inspection
description: Identify live listeners when a managed workflow reports a port conflict.
---

When a managed workflow fails with `EADDRINUSE`, the service may still be running as a child process even though the workflow status is failed. This container does not provide `ss`.

**Why:** A blind restart can collide with or interrupt a listener that is still serving requests.

**How to apply:** Inspect the process tree and map socket inodes from `/proc/net/tcp` and `/proc/net/tcp6` to `/proc/<pid>/fd` before deciding whether a workflow restart is safe. Do not kill an unidentified process.
