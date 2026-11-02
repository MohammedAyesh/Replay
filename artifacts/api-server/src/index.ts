import app from "./app";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";
import { attachPostgresIdleErrorListener } from "./lib/postgresPoolErrors";
import { startOwnerStatusSync } from "./routes/owner";
import { backfillMatchRooms } from "./lib/matchRooms";
import { refreshStaleMatchStatsCaches } from "./lib/matchStatsCacheJobs";
import { warmDemoBrandingPreviews } from "./routes/demoBranding";
import { ensureAdditiveColumns } from "./lib/ensureAdditiveColumns";

attachPostgresIdleErrorListener(pool, logger);

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

try {
  const added = await ensureAdditiveColumns(pool);
  if (added) logger.warn({ added }, "Added missing additive columns at startup (schema push had not reached this database)");
} catch (error) {
  logger.error({ error }, "Startup column check failed");
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startOwnerStatusSync();
  void warmDemoBrandingPreviews()
    .then(() => logger.info("Public branding video previews warmed"))
    .catch((err) => logger.warn({ err }, "Public branding video preview warm-up failed"));
  backfillMatchRooms()
    .then((created) => { if (created) logger.info({ created }, "Created match rooms for existing bookings"); })
    .catch((error) => logger.warn({ error }, "Match room backfill failed"));
  // cached stats computed under older rules (MATCH_STATS_CACHE_VERSION) are recomputed
  setTimeout(() => {
    refreshStaleMatchStatsCaches()
      .then((checked) => logger.info({ checked }, "Match stats cache refresh finished"))
      .catch((error) => logger.warn({ error }, "Match stats cache refresh failed"));
  }, 30_000).unref();
});
