import { db, settingsRulesTable, type SettingsRuleRow } from "@workspace/db";
import { logger } from "./logger";
import { SETTINGS, settingKeys, type SettingDefinition } from "./settingsRegistry";
import {
  DEFAULT_SETTINGS_TIMEZONE,
  resolveSetting,
  resolveAll,
  type ResolveContext,
  type Resolution,
  type ScopeType,
  type SettingRule,
} from "./settingsResolver";

/**
 * The database-backed side of settings.
 *
 * Resolution itself is pure and lives in settingsResolver.ts; this adds the two
 * things that need the outside world: reading the rules, and not reading them
 * on every request.
 *
 * THE CACHE IS THE POINT. A setting is consulted on paths that run per download
 * and per render, and a table read on each would put a query in front of work
 * that used to be a constant. The window is short and every write busts it, so
 * an admin sees their change take effect immediately; the TTL only matters for a
 * change made directly in the database, or by another process.
 */

const CACHE_TTL_MS = Math.max(
  0,
  parseInt(process.env.SETTINGS_CACHE_TTL_MS ?? "15000", 10) || 15_000,
);

let cache: { rules: SettingRule[]; loadedAt: number } | null = null;
let inflight: Promise<SettingRule[]> | null = null;

/**
 * Has the settings table been created yet?
 *
 * Deploying the code and running the schema push are two separate acts, and
 * between them every settings read hits a table that does not exist. That window
 * is not an error state to hide — it is a specific, fixable condition with a
 * specific remedy, and the admin looking at a blank page deserves to be told
 * which one it is rather than shown a 500.
 */
let schemaMissing = false;

export function isSettingsSchemaReady(): boolean {
  return !schemaMissing;
}

/** Postgres 42P01: relation does not exist. */
export function isMissingRelationError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
    ?? ((err as { cause?: { code?: string } })?.cause)?.code;
  if (code === "42P01") return true;
  const message = String((err as Error)?.message ?? "");
  return /relation .* does not exist/i.test(message);
}

/** Drop the cache. Called by every write path so an admin change is immediate. */
export function invalidateSettingsCache(): void {
  cache = null;
}

function toRule(row: SettingsRuleRow): SettingRule {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    priority: row.priority,
    scopeType: row.scopeType as ScopeType,
    scopeId: row.scopeId,
    excludes: (row.excludes ?? []) as SettingRule["excludes"],
    enabled: row.enabled,
    effectiveFrom: row.effectiveFrom,
    effectiveUntil: row.effectiveUntil,
    daysOfWeek: (row.daysOfWeek ?? null) as number[] | null,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    timezone: row.timezone || DEFAULT_SETTINGS_TIMEZONE,
  };
}

export async function loadRules(): Promise<SettingRule[]> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.rules;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const rows = await db.select().from(settingsRulesTable);
      const rules = rows.map(toRule);
      schemaMissing = false;
      cache = { rules, loadedAt: Date.now() };
      return rules;
    } catch (err) {
      if (isMissingRelationError(err)) {
        // Not an outage — the schema push has not been run in this environment.
        // Every key still resolves to its shipped default, so the product works;
        // it just cannot be configured yet.
        schemaMissing = true;
        logger.warn(
          "settings_rules does not exist yet — every setting is resolving to its shipped default. " +
          "Run the database schema push to enable configuration.",
        );
        return [];
      }
      // A settings table that cannot be read must not take the product down: every
      // key has a shipped default, so an empty rule set is a safe answer. It is
      // also the honest one — we do not know of any override.
      logger.error({ err }, "Could not read settings rules — falling back to shipped defaults");
      return cache?.rules ?? [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export type SettingsContext = Omit<ResolveContext, "at"> & { at?: Date };

function withNow(ctx: SettingsContext): ResolveContext {
  return { ...ctx, at: ctx.at ?? new Date() };
}

/** Resolve one setting for a context. */
export async function getSettingValue<T extends number | boolean | string>(
  key: string,
  ctx: SettingsContext = {},
): Promise<T> {
  const rules = await loadRules();
  return resolveSetting<T>(key, rules, withNow(ctx)).value;
}

/** Resolve one setting and explain which rule decided — used by the admin preview. */
export async function explainSetting(
  key: string,
  ctx: SettingsContext = {},
): Promise<Resolution> {
  const rules = await loadRules();
  return resolveSetting(key, rules, withNow(ctx));
}

/** Resolve every registered key for one context, in a single rules read. */
export async function getAllSettings(
  ctx: SettingsContext = {},
): Promise<Record<string, number | boolean | string>> {
  const rules = await loadRules();
  return resolveAll(settingKeys(), rules, withNow(ctx));
}

/** Every setting, with the winning rule for each — the admin preview payload. */
export async function explainAllSettings(ctx: SettingsContext = {}): Promise<
  Array<{ definition: SettingDefinition; resolution: Resolution; isDefault: boolean }>
> {
  const rules = await loadRules();
  const at = withNow(ctx);
  return SETTINGS.map((definition) => {
    const resolution = resolveSetting(definition.key, rules, at);
    return { definition, resolution, isDefault: resolution.rule === null };
  });
}

/**
 * Look up the academy and field a clip belongs to, so a setting can be scoped to
 * either without every call site having to know how that join works.
 *
 * Returns nulls rather than throwing when the clip has no academy or its
 * recording cannot be matched: a missing scope means the narrower rules simply
 * do not apply, which is the right behaviour, not an error.
 */
export type ScopeLookup = { userId?: number | null; academyId?: number | null; fieldId?: number | null };

export function contextFrom(scope: ScopeLookup, at?: Date): SettingsContext {
  return {
    userId: scope.userId ?? null,
    academyId: scope.academyId ?? null,
    fieldId: scope.fieldId ?? null,
    at,
  };
}
