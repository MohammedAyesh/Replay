const REQUIRED_MARKER = "isolated-api-test-db-v1";
const REQUIRED_DATABASE = "api_server_test";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertIsolatedApiTestDatabase(env = process.env) {
  const refuse = (reason) => {
    throw new Error(
      `API test database safety guard refused to run: ${reason}. ` +
        "Only the disposable local api_server_test database is allowed.",
    );
  };

  if (env.API_SERVER_TEST_DATABASE !== REQUIRED_MARKER) {
    refuse("the explicit isolated-test marker is missing");
  }

  if (!env.DATABASE_URL) {
    refuse("DATABASE_URL is missing");
  }

  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    refuse("DATABASE_URL is not a valid PostgreSQL URL");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    refuse("DATABASE_URL is not a PostgreSQL URL");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    refuse("DATABASE_URL does not point to a loopback host");
  }

  if (!url.port || !Number.isInteger(Number(url.port))) {
    refuse("DATABASE_URL does not specify a local PostgreSQL port");
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    refuse("DATABASE_URL has an invalid database name");
  }

  if (databaseName !== REQUIRED_DATABASE) {
    refuse(`the database name is not ${REQUIRED_DATABASE}`);
  }

  if (url.search || url.hash) {
    refuse("DATABASE_URL contains unapproved connection parameters");
  }

  if (env.PGHOST && !LOOPBACK_HOSTS.has(env.PGHOST.toLowerCase())) {
    refuse("PGHOST does not point to a loopback host");
  }

  if (env.PGHOSTADDR && !LOOPBACK_HOSTS.has(env.PGHOSTADDR.toLowerCase())) {
    refuse("PGHOSTADDR does not point to a loopback address");
  }

  if (env.PGSERVICE) {
    refuse("PGSERVICE could redirect the connection");
  }

  if (env.PGSERVICEFILE || env.PGOPTIONS) {
    refuse("PostgreSQL service or connection overrides are not allowed");
  }

  if (env.PGDATABASE && env.PGDATABASE !== REQUIRED_DATABASE) {
    refuse(`PGDATABASE is not ${REQUIRED_DATABASE}`);
  }

  if (env.PGPORT && Number(env.PGPORT) !== Number(url.port)) {
    refuse("PGPORT does not match the local DATABASE_URL port");
  }

  return { hostname, port: Number(url.port), databaseName };
}

export default function guardApiTestDatabase() {
  assertIsolatedApiTestDatabase();
}

if (process.env.API_SERVER_RUN_DB_GUARD === "1") {
  try {
    const { hostname, port, databaseName } = assertIsolatedApiTestDatabase();
    console.log(
      `[api-test-db-guard] Verified ${hostname}:${port}/${databaseName}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}