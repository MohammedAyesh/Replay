---
name: Disposable PostgreSQL test lifecycle
description: Running API integration tests against a temporary PostgreSQL instance in this workspace.
---

When using a temporary local PostgreSQL instance for API tests, initialize/start it, push the schema, run the tests, and stop/remove it within one shell invocation. Starting PostgreSQL in one shell call and running tests in a later call allowed the environment to terminate the daemon, causing mid-suite connection refusals.

**Why:** The test runner needs a disposable database because fixtures mutate tables, but a `pg_ctl`-started daemon did not reliably survive the ShellExec process boundary.

**How to apply:** Keep the full database lifecycle and test command in the same ShellExec call, with a shell trap that stops PostgreSQL and removes its temporary data directory.

In this container, initialize the temporary cluster with `initdb -U postgres` and pass `-k "$PGDATA"` to the server. The OS account is not a PostgreSQL role named `postgres` by default, and `/run/postgresql` may not exist.

**Why:** The default role caused connection failures, and the default Unix-socket directory caused PostgreSQL startup to fail before tests could run.

**How to apply:** Pair explicit test database credentials with a socket directory inside the temporary data directory; keep the client URL pointed only at that temporary server.

When restoring a `pg_dump --schema-only` export into a fresh database from `initdb`, replace the target database's default `public` schema before applying the export.

**Why:** Schema-only dumps may reference `public` without creating it; dropping the initialized schema without recreating it makes the first `CREATE TABLE public...` fail.

**How to apply:** In the disposable target only, run `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` before restoring. Never drop or recreate the source schema.