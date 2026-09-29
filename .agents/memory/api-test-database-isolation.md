---
name: API test database isolation
description: The API test command inherits the workspace database and can mutate shared data.
---

Do not run the API-server Vitest suite until its process is pointed at an explicitly disposable test database. It is not isolated by the test runner: route tests perform fixture inserts/deletes, and at least one test clears the settings-rules table without a filter.

**Why:** The package test script is a plain `vitest run`, and the DB package opens the ambient `DATABASE_URL`; running the suite against a shared workspace database can remove existing data.

**How to apply:** Before running API tests, verify an isolated test URL is configured and that destructive cleanup is scoped to test-owned records. Never rely on cleanup-by-convention alone.

The suite also inherits workspace Bunny settings. Some tests require Storage credentials for their local fake origin, while the failover-route tests need the primary exporter to appear unconfigured. Do not unset Bunny variables globally to make one test pass; stub the configuration checks in the failover test instead.

**Why:** The API suite initially changed which tests passed depending on whether the workspace Bunny environment was present, and one download test captures its Storage key when the test module loads.

**How to apply:** Keep real environment configuration out of mutation targets by using a disposable database, but make test-specific service availability explicit with mocks rather than changing the process-wide environment.