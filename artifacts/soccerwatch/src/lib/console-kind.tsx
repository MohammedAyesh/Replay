import { createContext, useContext, type ReactNode } from "react";

/**
 * The Field console runs the academy console's sections (Chats, People, WhatsApp, Ads, Social,
 * Creative, Branding, Profile, Team) for a field business. Inside it, their copy talks about
 * "the field" instead of "the academy": each section's copy hook passes its strings through
 * useConsoleWording, which rewrites them when the console is a field's.
 */
export type ConsoleKind = "academy" | "venue";

const ConsoleKindContext = createContext<ConsoleKind>("academy");

export function ConsoleKindProvider({ kind, children }: { kind: ConsoleKind; children: ReactNode }) {
  return <ConsoleKindContext.Provider value={kind}>{children}</ConsoleKindContext.Provider>;
}

export function useConsoleKind(): ConsoleKind {
  return useContext(ConsoleKindContext);
}

const RULES: Array<[RegExp, string]> = [
  // Arabic (longest forms first)
  [/الأكاديميات/g, "الملاعب"],
  [/أكاديميتك/g, "ملعبك"],
  [/أكاديميتي/g, "ملعبي"],
  [/الأكاديمية/g, "الملعب"],
  [/للأكاديمية/g, "للملعب"],
  [/بالأكاديمية/g, "بالملعب"],
  [/أكاديمية/g, "ملعب"],
  // English
  [/\bacademies\b/g, "fields"],
  [/\bAcademies\b/g, "Fields"],
  [/\bacademy\b/g, "field"],
  [/\bAcademy\b/g, "Field"],
  [/\bACADEMY\b/g, "FIELD"],
];

export function venueWording(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

const cache = new WeakMap<object, unknown>();

function adapt<T>(value: T): T {
  if (typeof value === "string") return venueWording(value) as T;
  if (typeof value === "function") {
    const fn = value as unknown as (...args: unknown[]) => unknown;
    return ((...args: unknown[]) => adapt(fn(...args))) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => adapt(v)) as T;
  if (value && typeof value === "object") {
    const hit = cache.get(value as object);
    if (hit) return hit as T;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[key] = key === "locale" ? v : adapt(v);
    cache.set(value as object, out);
    return out as T;
  }
  return value;
}

/** A section's copy, reworded for a field when the console is a field's. Pure overrides win. */
export function useConsoleWording<T extends object>(copy: T, venueOverrides?: (copy: T) => T): T {
  const kind = useContext(ConsoleKindContext);
  if (kind !== "venue") return copy;
  const adapted = adapt(copy);
  return venueOverrides ? venueOverrides(adapted) : adapted;
}
