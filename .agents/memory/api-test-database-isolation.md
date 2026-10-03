---
name: API test database isolation
description: The API test command inherits the workspace database and can mutate shared data.
---

Do not run the API-server Vitest suite until its process is pointed at an explicitly disposable test database. It is not isolated by the test runner: route tests perform fixture inserts/deletes, and at least one test clears the settings-rules table without a filter. Never use the shared database as a schema source either; build the disposable database from the checked-in Drizzle schema only.

**Why:** The package test script is a plain `vitest run`, and the DB package opens `DATABASE_URL`; running the suite against a shared workspace database can remove existing data. Even a read-only schema dump makes test setup depend on the shared database and its credentials.

**How to apply:** Unset inherited database and PostgreSQL connection settings, create a temporary loopback PostgreSQL cluster, set the test marker and local URL, and pass the unchanged guard before applying Drizzle schema or running tests. Keep setup, tests, and teardown in one shell invocation; never rely on cleanup-by-convention alone.

The suite also inherits workspace Bunny settings. Some tests require Storage credentials for their local fake origin, while the failover-route tests need the primary exporter to appear unconfigured. Do not unset Bunny variables globally to make one test pass; stub the configuration checks in the failover test instead.

**Why:** The API suite initially changed which tests passed depending on whether the workspace Bunny environment was present, and one download test captures its Storage key when the test module loads.

**How to apply:** Keep real environment configuration out of mutation targets by using a disposable database, but make test-specific service availability explicit with mocks rather than changing the process-wide environment.

Vitest 4.1.9 rejects `--minWorkers`; `--maxWorkers=1` is the working serial-run option.

**Why:** The API suite needs predictable serial execution when it is run against a temporary PostgreSQL instance, and the old flag fails before tests start.

**How to apply:** Use `--maxWorkers=1` for serial API-suite runs, and keep temporary database setup, schema push, tests, and teardown in one shell invocation.