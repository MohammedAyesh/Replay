---
name: Development schema push
description: Environment constraint around applying development PostgreSQL schema changes from the agent workspace.
---

The project’s database push wrapper deliberately refuses noninteractive execution, so an agent cannot rely on invoking the package push script in a noninteractive shell.

**Why:** Automated verification can reach the development database even when the wrapper cannot open its interactive confirmation flow.

**How to apply:** Treat the supported publish/post-merge schema flow as the normal path. If a development-only schema check is required during an agent task, verify the existing tables first and use the project’s approved database tooling rather than bypassing the wrapper with ad-hoc startup DDL.