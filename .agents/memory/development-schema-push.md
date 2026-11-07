---
name: Development schema push
description: Environment constraint around applying development PostgreSQL schema changes from the agent workspace.
---

The project’s database push wrapper deliberately refuses noninteractive execution, so an agent cannot rely on invoking the package push script in a noninteractive shell.

**Why:** Automated verification can reach the development database even when the wrapper cannot open its interactive confirmation flow.

**How to apply:** Treat the supported publish/post-merge schema flow as the normal path. If a development-only schema check is required during an agent task, verify the existing tables first and use the project’s approved database tooling rather than bypassing the wrapper with ad-hoc startup DDL.

Direct comparison can also surface legacy columns that are still present in the live development database but no longer represented in the current schema. Do not approve their removal merely to apply an unrelated additive change; retain the legacy column until it has an intentional data-migration plan.

**Why:** The push tool treats an undeclared legacy column as a destructive drop, even when that column still contains rows.

**How to apply:** When a push pauses on a legacy-column deletion, preserve it as nullable compatibility schema, then rerun the approved push so the intended additive tables/indexes can be applied safely.

Publishing compares the live development database with the live production database; it does not diff either database against the Drizzle source. If both databases lack the same code-required columns, the publish diff can be empty.

**Why:** An empty development-to-production diff only means those databases match each other, not that either matches the application schema.

**How to apply:** Check the source schema and both databases when runtime errors report missing columns. Apply the approved additive change to development first, then re-check the diff and publish.