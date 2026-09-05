import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, settingsRulesTable, settingsDefaultsTable, usersTable } from "@workspace/db";
import { getLocalUserId, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { logger } from "../lib/logger";
import {
  SETTINGS,
  getSetting,
  validateSettingValue,
} from "../lib/settingsRegistry";
import {
  DEFAULT_SETTINGS_TIMEZONE,
  SCOPE_SPECIFICITY,
  type ScopeType,
} from "../lib/settingsResolver";
import {
  explainAllSettings,
  explainSetting,
  invalidateSettingsCache,
  isMissingRelationError,
  isSettingsSchemaReady,
  loadDefaults,
  loadRules,
} from "../lib/settings";

const router: IRouter = Router();

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db.select({ isAdmin: usersTable.isAdmin }).from(usersTable).where(eq(usersTable.id, userId));
  return user?.isAdmin ? userId : null;
}

const SCOPE_TYPES: ScopeType[] = ["global", "field", "academy", "user"];

interface RuleInput {
  key?: unknown;
  value?: unknown;
  priority?: unknown;
  scopeType?: unknown;
  scopeId?: unknown;
  excludes?: unknown;
  enabled?: unknown;
  effectiveFrom?: unknown;
  effectiveUntil?: unknown;
  daysOfWeek?: unknown;
  startMinute?: unknown;
  endMinute?: unknown;
  timezone?: unknown;
  note?: unknown;
}

function parseDate(raw: unknown, field: string): { ok: true; value: Date | null } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: `${field} must be an ISO timestamp` };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { ok: false, error: `${field} is not a valid timestamp` };
  return { ok: true, value: d };
}

function parseMinute(raw: unknown, field: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > 1439) {
    return { ok: false, error: `${field} must be a whole number of minutes from 0 to 1439` };
  }
  return { ok: true, value: n };
}

/**
 * Validate a rule before it is stored.
 *
 * Strict on purpose. A rule is data that changes how the product behaves for
 * real people, and the failure mode of a bad one is not a crash — it is a
 * plausible-looking value silently applying to the wrong population. Rejecting
 * at the door is the only cheap place to catch that.
 */
function validateRule(body: RuleInput): { ok: true; value: typeof settingsRulesTable.$inferInsert } | { ok: false; error: string } {
  const key = typeof body.key === "string" ? body.key : "";
  const definition = getSetting(key);
  if (!definition) return { ok: false, error: `Unknown setting "${key}"` };

  const value = validateSettingValue(key, body.value);
  if (!value.ok) return { ok: false, error: value.error };

  const scopeType = (typeof body.scopeType === "string" ? body.scopeType : "global") as ScopeType;
  if (!SCOPE_TYPES.includes(scopeType)) {
    return { ok: false, error: `scopeType must be one of: ${SCOPE_TYPES.join(", ")}` };
  }

  let scopeId: number | null = null;
  if (scopeType !== "global") {
    const n = typeof body.scopeId === "number" ? body.scopeId : Number.NaN;
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: `A ${scopeType} rule needs a ${scopeType} id` };
    }
    scopeId = n;
  } else if (body.scopeId != null) {
    return { ok: false, error: "A global rule cannot have a scope id" };
  }

  const priority = typeof body.priority === "number" ? body.priority : 0;
  if (!Number.isInteger(priority)) return { ok: false, error: "priority must be a whole number" };

  const rawExcludes = body.excludes ?? [];
  if (!Array.isArray(rawExcludes)) return { ok: false, error: "excludes must be a list" };
  const excludes: { scopeType: "field" | "academy" | "user"; scopeId: number }[] = [];
  for (const ex of rawExcludes) {
    const t = (ex as { scopeType?: unknown })?.scopeType;
    const i = (ex as { scopeId?: unknown })?.scopeId;
    if (t !== "field" && t !== "academy" && t !== "user") {
      return { ok: false, error: "Each exclusion needs a scopeType of field, academy or user" };
    }
    if (typeof i !== "number" || !Number.isInteger(i) || i <= 0) {
      return { ok: false, error: "Each exclusion needs a positive id" };
    }
    excludes.push({ scopeType: t, scopeId: i });
  }

  const from = parseDate(body.effectiveFrom, "effectiveFrom");
  if (!from.ok) return from;
  const until = parseDate(body.effectiveUntil, "effectiveUntil");
  if (!until.ok) return until;
  if (from.value && until.value && until.value.getTime() <= from.value.getTime()) {
    return { ok: false, error: "effectiveUntil must be after effectiveFrom" };
  }

  let daysOfWeek: number[] | null = null;
  if (body.daysOfWeek != null) {
    if (!Array.isArray(body.daysOfWeek)) return { ok: false, error: "daysOfWeek must be a list" };
    if (body.daysOfWeek.length > 0) {
      for (const d of body.daysOfWeek) {
        if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6) {
          return { ok: false, error: "daysOfWeek entries must be whole numbers 0 (Sunday) to 6" };
        }
      }
      daysOfWeek = [...new Set(body.daysOfWeek as number[])].sort();
    }
  }

  const start = parseMinute(body.startMinute, "startMinute");
  if (!start.ok) return start;
  const end = parseMinute(body.endMinute, "endMinute");
  if (!end.ok) return end;
  if ((start.value == null) !== (end.value == null)) {
    return { ok: false, error: "A time window needs both a start and an end" };
  }
  if (start.value != null && start.value === end.value) {
    // Not a wrap — a zero-length window that would never match.
    return { ok: false, error: "A time window's start and end cannot be the same minute" };
  }

  const timezone = typeof body.timezone === "string" && body.timezone.trim()
    ? body.timezone.trim()
    : DEFAULT_SETTINGS_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    return { ok: false, error: `"${timezone}" is not a recognised time zone` };
  }

  return {
    ok: true,
    value: {
      key,
      value: value.value!,
      priority,
      scopeType,
      scopeId,
      excludes,
      enabled: body.enabled == null ? true : body.enabled === true,
      effectiveFrom: from.value,
      effectiveUntil: until.value,
      daysOfWeek,
      startMinute: start.value,
      endMinute: end.value,
      timezone,
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
    },
  };
}

/** The catalogue: every adjustable value, with its type, bounds and default. */
router.get("/admin/settings/registry", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req))) { unauthenticatedResponse(res, req); return; }
  res.json({
    settings: SETTINGS,
    scopeTypes: SCOPE_TYPES.map((t) => ({ scopeType: t, specificity: SCOPE_SPECIFICITY[t] })),
    defaultTimezone: DEFAULT_SETTINGS_TIMEZONE,
  });
});

/**
 * The remedy for a settings table that does not exist yet.
 *
 * Deploying the code and running the schema push are separate acts, and between
 * them this endpoint used to answer 500 — which tells an admin nothing except
 * that the page is broken. It is a specific, fixable condition, so it says so
 * and says what to run. The push is deliberately interactive-only (see
 * lib/db/scripts/push-wrapper.sh), which is why this cannot just fix itself.
 */
const SCHEMA_MISSING_MESSAGE =
  "The settings tables have not been created in this database yet. " +
  "Open a Shell tab and run: pnpm --filter @workspace/db run push";

/**
 * GET /admin/settings/defaults
 *
 * The base value of every setting, and whether it is still the one the product
 * shipped with. A rule beats a default; a default beats the shipped value.
 */
router.get("/admin/settings/defaults", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req))) { unauthenticatedResponse(res, req); return; }
  try {
    const rows = await db.select().from(settingsDefaultsTable);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    res.json({
      schemaReady: true,
      defaults: SETTINGS.map((definition) => {
        const stored = byKey.get(definition.key);
        return {
          key: definition.key,
          shippedValue: definition.defaultValue,
          value: stored ? stored.value : definition.defaultValue,
          isShipped: !stored,
          note: stored?.note ?? null,
          updatedAt: stored?.updatedAt?.toISOString() ?? null,
        };
      }),
    });
  } catch (err) {
    if (!isMissingRelationError(err)) throw err;
    res.json({
      schemaReady: false,
      message: SCHEMA_MISSING_MESSAGE,
      defaults: SETTINGS.map((definition) => ({
        key: definition.key,
        shippedValue: definition.defaultValue,
        value: definition.defaultValue,
        isShipped: true,
        note: null,
        updatedAt: null,
      })),
    });
  }
});

/**
 * PUT /admin/settings/defaults/:key
 *
 * Change the base value everyone gets. Validated against the registry exactly
 * as a rule's value is - the same function, deliberately, because a base value
 * reaches more people than any rule and there is no argument for it being the
 * looser of the two.
 */
router.put("/admin/settings/defaults/:key", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }
  const key = String(Array.isArray(req.params.key) ? req.params.key[0] : req.params.key);
  const definition = getSetting(key);
  if (!definition) { res.status(400).json({ error: `Unknown setting: ${key}` }); return; }

  const checked = validateSettingValue(key, (req.body as { value?: unknown })?.value);
  if (!checked.ok) { res.status(400).json({ error: checked.error }); return; }
  const value = checked.value;

  const note = typeof (req.body as { note?: unknown })?.note === "string"
    ? String((req.body as { note: string }).note).slice(0, 500)
    : null;

  try {
    const [saved] = await db
      .insert(settingsDefaultsTable)
      .values({ key, value, note, updatedBy: adminId })
      .onConflictDoUpdate({
        target: settingsDefaultsTable.key,
        set: { value, note, updatedBy: adminId, updatedAt: new Date() },
      })
      .returning();
    invalidateSettingsCache();
    logger.info({ key, value, adminId }, "Admin changed a setting's base value");
    res.json({
      key: saved.key,
      value: saved.value,
      shippedValue: definition.defaultValue,
      isShipped: false,
      note: saved.note,
      updatedAt: saved.updatedAt.toISOString(),
    });
  } catch (err) {
    if (!isMissingRelationError(err)) throw err;
    res.status(503).json({ error: SCHEMA_MISSING_MESSAGE });
  }
});

/**
 * DELETE /admin/settings/defaults/:key - go back to the value the product ships
 * with. Not the same as setting it to that value by hand: this removes the row,
 * so a later change to the shipped default is picked up instead of being
 * silently pinned to whatever it happened to be today.
 */
router.delete("/admin/settings/defaults/:key", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }
  const key = String(Array.isArray(req.params.key) ? req.params.key[0] : req.params.key);
  const definition = getSetting(key);
  if (!definition) { res.status(400).json({ error: `Unknown setting: ${key}` }); return; }
  try {
    await db.delete(settingsDefaultsTable).where(eq(settingsDefaultsTable.key, key));
    invalidateSettingsCache();
    logger.info({ key, adminId }, "Admin reverted a setting to its shipped value");
    res.json({
      key,
      value: definition.defaultValue,
      shippedValue: definition.defaultValue,
      isShipped: true,
      note: null,
      updatedAt: null,
    });
  } catch (err) {
    if (!isMissingRelationError(err)) throw err;
    res.status(503).json({ error: SCHEMA_MISSING_MESSAGE });
  }
});

/** Every rule, newest first. */
router.get("/admin/settings/rules", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req))) { unauthenticatedResponse(res, req); return; }
  try {
    const rows = await db.select().from(settingsRulesTable);
    rows.sort((a, b) => b.id - a.id);
    res.json({ rules: rows, schemaReady: true });
  } catch (err) {
    if (!isMissingRelationError(err)) throw err;
    logger.warn("settings_rules is missing — the admin settings tab will prompt for a schema push");
    res.json({ rules: [], schemaReady: false, message: SCHEMA_MISSING_MESSAGE });
  }
});

router.post("/admin/settings/rules", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }

  const parsed = validateRule(req.body ?? {});
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }

  let row: typeof settingsRulesTable.$inferSelect;
  try {
    [row] = await db
      .insert(settingsRulesTable)
      .values({ ...parsed.value, createdBy: adminId })
      .returning();
  } catch (err) {
    if (!isMissingRelationError(err)) throw err;
    res.status(503).json({ error: SCHEMA_MISSING_MESSAGE });
    return;
  }
  invalidateSettingsCache();
  logger.info({ adminId, ruleId: row.id, key: row.key, scopeType: row.scopeType, scopeId: row.scopeId, value: row.value },
    "Settings rule created");
  res.status(201).json({ rule: row });
});

router.patch("/admin/settings/rules/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }

  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid rule id" }); return; }

  const [existing] = await db.select().from(settingsRulesTable).where(eq(settingsRulesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Rule not found" }); return; }

  // Validate the merged rule, not the patch: a partial edit can still produce an
  // invalid whole (an end time without a start, a window that ends before it
  // begins), and validating only the changed fields would let that through.
  const merged = { ...existing, ...(req.body ?? {}) } as RuleInput;
  const parsed = validateRule(merged);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }

  const [row] = await db
    .update(settingsRulesTable)
    .set({ ...parsed.value, updatedAt: new Date() })
    .where(eq(settingsRulesTable.id, id))
    .returning();
  invalidateSettingsCache();
  logger.info({ adminId, ruleId: id, key: row.key, value: row.value }, "Settings rule updated");
  res.json({ rule: row });
});

router.delete("/admin/settings/rules/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }

  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid rule id" }); return; }

  const [row] = await db.delete(settingsRulesTable).where(eq(settingsRulesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Rule not found" }); return; }
  invalidateSettingsCache();
  logger.info({ adminId, ruleId: id, key: row.key }, "Settings rule deleted");
  res.json({ ok: true });
});

/**
 * "What does this person actually get, and why?"
 *
 * With priority-based precedence, two admins can write rules that fight, and no
 * single rule tells you what is in force. This endpoint is the answer to that:
 * it resolves every setting for a hypothetical context and returns the winning
 * rule plus every other rule that matched. It is the difference between a
 * configuration system people trust and one they are afraid to touch.
 */
router.get("/admin/settings/preview", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req))) { unauthenticatedResponse(res, req); return; }

  const num = (v: unknown) => {
    const n = typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const at = typeof req.query.at === "string" && req.query.at ? new Date(req.query.at) : new Date();
  if (Number.isNaN(at.getTime())) { res.status(400).json({ error: "Invalid 'at' timestamp" }); return; }

  const ctx = {
    userId: num(req.query.userId),
    academyId: num(req.query.academyId),
    fieldId: num(req.query.fieldId),
    at,
  };

  if (typeof req.query.key === "string" && req.query.key) {
    if (!getSetting(req.query.key)) { res.status(400).json({ error: "Unknown setting" }); return; }
    const resolution = await explainSetting(req.query.key, ctx);
    res.json({ context: ctx, resolution, schemaReady: isSettingsSchemaReady() });
    return;
  }

  const settings = await explainAllSettings(ctx);
  // Reported after resolving, because that is what actually attempts the read.
  const schemaReady = isSettingsSchemaReady();
  res.json({
    context: ctx,
    settings,
    schemaReady,
    ...(schemaReady ? {} : { message: SCHEMA_MISSING_MESSAGE }),
  });
});

export default router;
