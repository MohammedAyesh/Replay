import { getSetting } from "./settingsRegistry";

/**
 * Resolving a setting for a request.
 *
 * The model is deliberately small: a rule says "this key has this value, for
 * this scope, at this priority, during this time". Resolution picks the winner.
 * Everything the admin console offers — per field, per academy, per user, per
 * time window, everyone-except-X — is expressible in those four dimensions, and
 * nothing here knows what any particular setting means.
 *
 * PRECEDENCE: highest priority wins; ties break by specificity (user beats
 * academy beats field beats global); remaining ties break by newest rule.
 *
 * Priority-first rather than specificity-first is a choice with a consequence
 * worth stating: it lets a broad rule deliberately beat a narrow one ("this
 * promotion overrides every per-user override"), which is what makes campaigns
 * and incident overrides possible. The cost is that two admins can write rules
 * that fight, and you cannot tell what is in force by looking at one of them.
 * That is exactly why `resolveSetting` returns every rule that matched and which
 * one won, and why the admin console shows it: with this model, a preview is not
 * a nicety, it is how the system stays explainable.
 */

export type ScopeType = "global" | "field" | "academy" | "user";

/** Narrower beats broader when priorities tie. */
export const SCOPE_SPECIFICITY: Record<ScopeType, number> = {
  global: 0,
  field: 1,
  academy: 2,
  user: 3,
};

export interface ScopeRef {
  scopeType: Exclude<ScopeType, "global">;
  scopeId: number;
}

export interface SettingRule {
  id: number;
  key: string;
  value: number | boolean | string;
  priority: number;
  scopeType: ScopeType;
  /** Null for global. */
  scopeId: number | null;
  /** Scopes this rule does NOT apply to — "everyone except these". */
  excludes: ScopeRef[];
  enabled: boolean;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  /** Recurring window: 0 = Sunday. Null means "every day". */
  daysOfWeek: number[] | null;
  /** Minutes since local midnight. Null means "all day". */
  startMinute: number | null;
  endMinute: number | null;
  /** IANA zone the recurring window is expressed in. */
  timezone: string;
}

export interface ResolveContext {
  userId?: number | null;
  academyId?: number | null;
  fieldId?: number | null;
  at: Date;
}

export interface Resolution<T = number | boolean | string> {
  value: T;
  /** The rule that decided, or null when the registry default applied. */
  rule: SettingRule | null;
  /** Every rule that matched, winner first. This is what makes it explainable. */
  matched: SettingRule[];
}

/** The default recurring-window timezone. */
export const DEFAULT_SETTINGS_TIMEZONE = "Asia/Amman";

/**
 * Local weekday and minute-of-day for an instant, in a named zone.
 *
 * This system has three clocks live at once — cameras on Amman, the VPS on
 * Europe/Berlin, buckets on UTC — and an admin setting "match nights, 18:00 to
 * 23:00" means Amman, not whatever the server happens to run on. So the zone is
 * carried on the rule and applied here rather than left to the host.
 *
 * An unusable zone falls back to UTC rather than throwing: one malformed rule
 * must not take down resolution for every other rule and every other request.
 */
export function localWeekdayAndMinute(
  at: Date,
  timezone: string,
): { weekday: number; minute: number; zoneUsed: string } {
  const tryZone = (zone: string) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const lookup = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weekday = names.indexOf(lookup("weekday"));
    // "24" appears for midnight in some ICU versions under hour12: false.
    const hour = Number.parseInt(lookup("hour"), 10) % 24;
    const minute = Number.parseInt(lookup("minute"), 10);
    if (weekday < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      throw new Error("unparseable");
    }
    return { weekday, minute: hour * 60 + minute, zoneUsed: zone };
  };

  try {
    return tryZone(timezone);
  } catch {
    try {
      return tryZone("UTC");
    } catch {
      return { weekday: at.getUTCDay(), minute: at.getUTCHours() * 60 + at.getUTCMinutes(), zoneUsed: "UTC" };
    }
  }
}

/**
 * Is `at` inside the rule's recurring window?
 *
 * Windows that wrap midnight are the normal case here, not an edge case: a rule
 * for evening football is "20:00 to 01:00". When start is after end the window
 * is treated as spanning midnight, and the day-of-week test applies to the day
 * the window STARTED — otherwise a Friday-night rule stops applying at midnight,
 * an hour into the match.
 */
export function withinRecurringWindow(rule: SettingRule, at: Date): boolean {
  const hasDays = rule.daysOfWeek != null && rule.daysOfWeek.length > 0;
  const hasTime = rule.startMinute != null && rule.endMinute != null;
  if (!hasDays && !hasTime) return true;

  const { weekday, minute } = localWeekdayAndMinute(at, rule.timezone || DEFAULT_SETTINGS_TIMEZONE);

  if (!hasTime) return rule.daysOfWeek!.includes(weekday);

  const start = rule.startMinute!;
  const end = rule.endMinute!;

  if (start <= end) {
    if (minute < start || minute >= end) return false;
    return !hasDays || rule.daysOfWeek!.includes(weekday);
  }

  // Wraps midnight.
  if (minute >= start) {
    // Still on the starting day.
    return !hasDays || rule.daysOfWeek!.includes(weekday);
  }
  if (minute < end) {
    // The tail, on the following day — check the day it started.
    const startedOn = (weekday + 6) % 7;
    return !hasDays || rule.daysOfWeek!.includes(startedOn);
  }
  return false;
}

function withinAbsoluteWindow(rule: SettingRule, at: Date): boolean {
  if (rule.effectiveFrom && at.getTime() < rule.effectiveFrom.getTime()) return false;
  if (rule.effectiveUntil && at.getTime() >= rule.effectiveUntil.getTime()) return false;
  return true;
}

function scopeIdFor(scopeType: ScopeType, ctx: ResolveContext): number | null | undefined {
  switch (scopeType) {
    case "user": return ctx.userId;
    case "academy": return ctx.academyId;
    case "field": return ctx.fieldId;
    case "global": return null;
  }
}

function scopeMatches(rule: SettingRule, ctx: ResolveContext): boolean {
  if (rule.scopeType === "global") return true;
  const contextId = scopeIdFor(rule.scopeType, ctx);
  return contextId != null && contextId === rule.scopeId;
}

/**
 * Is this rule switched off for the request?
 *
 * An exclusion is how "everyone except academy 3" is expressed without having to
 * invent a value for academy 3. The alternative — a narrower rule at a higher
 * priority — forces the admin to decide what academy 3 gets instead, when what
 * they meant was "leave them on whatever they were on".
 */
export function ruleExcludes(rule: SettingRule, ctx: ResolveContext): boolean {
  return rule.excludes.some((ex) => {
    const contextId = scopeIdFor(ex.scopeType, ctx);
    return contextId != null && contextId === ex.scopeId;
  });
}

export function ruleApplies(rule: SettingRule, ctx: ResolveContext): boolean {
  if (!rule.enabled) return false;
  if (!scopeMatches(rule, ctx)) return false;
  if (ruleExcludes(rule, ctx)) return false;
  if (!withinAbsoluteWindow(rule, ctx.at)) return false;
  if (!withinRecurringWindow(rule, ctx.at)) return false;
  return true;
}

/** Winner first. Priority desc, then specificity desc, then newest. */
export function compareRules(a: SettingRule, b: SettingRule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const sa = SCOPE_SPECIFICITY[a.scopeType];
  const sb = SCOPE_SPECIFICITY[b.scopeType];
  if (sa !== sb) return sb - sa;
  return b.id - a.id;
}

/**
 * Resolve one key. Returns the registry default when no rule applies, so a
 * system with an empty rules table behaves exactly as it did before the table
 * existed — which is what makes it safe to put every value behind this at once.
 */
export function resolveSetting<T extends number | boolean | string>(
  key: string,
  rules: readonly SettingRule[],
  ctx: ResolveContext,
): Resolution<T> {
  const def = getSetting(key);
  const fallback = def?.defaultValue as T;

  const matched = rules
    .filter((r) => r.key === key && ruleApplies(r, ctx))
    .sort(compareRules);

  if (matched.length === 0) {
    return { value: fallback, rule: null, matched: [] };
  }
  return { value: matched[0]!.value as T, rule: matched[0]!, matched };
}

/** Resolve every registered key at once, for one context. */
export function resolveAll(
  keys: readonly string[],
  rules: readonly SettingRule[],
  ctx: ResolveContext,
): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  for (const key of keys) out[key] = resolveSetting(key, rules, ctx).value;
  return out;
}
