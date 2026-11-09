import app from "./app";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";
import { attachPostgresIdleErrorListener } from "./lib/postgresPoolErrors";
import { startOwnerStatusSync } from "./routes/owner";
import { backfillMatchRooms } from "./lib/matchRooms";
import { refreshStaleMatchStatsCaches } from "./lib/matchStatsCacheJobs";
import { warmDemoBrandingPreviews } from "./routes/demoBranding";
import { ensureAdditiveColumns } from "./lib/ensureAdditiveColumns";
import { ensureReplayMusic } from "./lib/creative/music";

attachPostgresIdleErrorListener(pool, logger);

// Safety net (2026-11-04): a background promise that rejects without a catch
// used to end the process (Node's default), and Autoscale restarted it ~30
// times a day. Log it with its stack and keep serving instead.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection (process kept running)");
});

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

// Replay's bundled music library (assets/creative/music/library.json): rows it doesn't have yet.
void ensureReplayMusic()
  .then((added) => { if (added) logger.info({ added }, "Creative music: seeded Replay's library"); })
  .catch((error) => logger.warn({ error }, "Creative music: seeding Replay's library failed"));

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
