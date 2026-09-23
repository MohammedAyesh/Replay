import app from "./app";
import { logger } from "./lib/logger";
import { startOwnerStatusSync } from "./routes/owner";
import { backfillMatchRooms } from "./lib/matchRooms";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startOwnerStatusSync();
  backfillMatchRooms()
    .then((created) => { if (created) logger.info({ created }, "Created match rooms for existing bookings"); })
    .catch((error) => logger.warn({ error }, "Match room backfill failed"));
});
