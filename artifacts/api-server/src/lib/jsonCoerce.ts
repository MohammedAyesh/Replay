/**
 * Coercion helpers for JSON that arrives from outside this codebase.
 *
 * Tracking bundles and pitch models are produced by other tools and by hand,
 * so field names arrive in whatever casing that tool emits and numbers arrive
 * as strings. These take the first value that is actually usable rather than
 * trusting a single spelling.
 */
export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

export function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  }
  return undefined;
}
