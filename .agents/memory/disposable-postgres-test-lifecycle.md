---
name: Disposable PostgreSQL test lifecycle
description: Running API integration tests against a temporary PostgreSQL instance in this workspace.
---

When using a temporary local PostgreSQL instance for API tests, initialize/start it, apply the checked-in schema, run the tests, and stop/remove it within one shell invocation. Starting PostgreSQL in one shell call and running tests in a later call allowed the environment to terminate the daemon, causing mid-suite connection refusals.

**Why:** The test runner needs a disposable database because fixtures mutate tables, but a `pg_ctl`-started daemon did not reliably survive the ShellExec process boundary.

**How to apply:** Keep the full database lifecycle and test command in the same ShellExec call, with a shell trap that stops PostgreSQL and removes its temporary data directory.

In this container, initialize the temporary cluster with `initdb -U postgres` and pass `-k "$PGDATA"` to the server. The OS account is not a PostgreSQL role named `postgres` by default, and `/run/postgresql` may not exist.

**Why:** The default role caused connection failures, and the default Unix-socket directory caused PostgreSQL startup to fail before tests could run.

**How to apply:** Pair explicit test database credentials with a socket directory inside the temporary data directory; keep the client URL pointed only at that temporary server.
