---
name: Disposable PostgreSQL test lifecycle
description: Running API integration tests against a temporary PostgreSQL instance in this workspace.
---

When using a temporary local PostgreSQL instance for API tests, initialize/start it, push the schema, run the tests, and stop/remove it within one shell invocation. Starting PostgreSQL in one shell call and running tests in a later call allowed the environment to terminate the daemon, causing mid-suite connection refusals.

**Why:** The test runner needs a disposable database because fixtures mutate tables, but a `pg_ctl`-started daemon did not reliably survive the ShellExec process boundary.

**How to apply:** Keep the full database lifecycle and test command in the same ShellExec call, with a shell trap that stops PostgreSQL and removes its temporary data directory.