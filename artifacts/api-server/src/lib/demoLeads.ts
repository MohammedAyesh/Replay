import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

import { logger } from "./logger";
import { isMissingRelationError } from "./settings";

/**
 * Call-me-back requests from the public demo.
 *
 * The table arrives with a migration that has to go through the publish
 * review. Until it exists, the demo simply does not show the form
 * (`demoLeadsReady()` answers false) and these routes answer 503, so shipping
 * the code before the table can never break the page.
 */
let readyCache: { at: number; ready: boolean } | null = null;
const READY_TTL_MS = 60_000;

export async function demoLeadsReady(): Promise<boolean> {
  if (readyCache && Date.now() - readyCache.at < READY_TTL_MS) return readyCache.ready;
  let ready = false;
  try {
    await db.execute(sql`select 1 from demo_leads limit 0`);
    ready = true;
  } catch (error) {
    if (!isMissingRelationError(error)) logger.warn({ err: error }, "demo leads readiness check failed");
  }
  readyCache = { at: Date.now(), ready };
  return ready;
}

export function resetDemoLeadsReady(): void {
  readyCache = null;
}
