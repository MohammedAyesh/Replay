/**
 * Every value in the product that an admin can change.
 *
 * The registry is the contract between three things that would otherwise drift:
 * the code that reads a setting, the admin UI that renders a control for it, and
 * the validator that stops a bad value being stored. Adding a knob means adding
 * one entry here — not a column, not a form field, not a migration.
 *
 * `defaultValue` is what ships. A key with no rule matching a request resolves to
 * it, so the system behaves exactly as it did before any rule existed; that is
 * what makes it safe to put every value behind this at once.
 */

export type SettingType = "number" | "boolean" | "string" | "enum";

export interface SettingDefinition {
  key: string;
  /** Grouping for the admin UI. */
  group: string;
  label: string;
  /** Why an admin would change it, and what breaks if they get it wrong. */
  description: string;
  type: SettingType;
  defaultValue: number | boolean | string;
  min?: number;
  max?: number;
  /** Whole numbers only — a limit of 2.5 downloads is not a thing. */
  integer?: boolean;
  options?: readonly string[];
  unit?: string;
  /**
   * True when a change only takes effect on work started afterwards. The admin
   * UI says so, because "I changed it and nothing happened" is otherwise the
   * first support question.
   */
  appliesToNewWorkOnly?: boolean;
}

export const SETTINGS: readonly SettingDefinition[] = [
  // ── Downloads ──────────────────────────────────────────────────────────
  {
    key: "downloads.limit",
    group: "Downloads",
    label: "Downloads per window",
    description:
      "How many distinct clips a metered account may download per rolling window. " +
      "Re-downloading a clip already counted is always free and does not consume one.",
    type: "number",
    defaultValue: 5,
    min: 0,
    max: 10_000,
    integer: true,
    unit: "clips",
  },
  {
    key: "downloads.windowDays",
    group: "Downloads",
    label: "Rolling window length",
    description:
      "The window is rolling, not calendar. Changing this re-evaluates every " +
      "account immediately: shortening it hands slots back, lengthening it takes " +
      "them away from people who had already spent them.",
    type: "number",
    defaultValue: 30,
    min: 1,
    max: 365,
    integer: true,
    unit: "days",
  },
  {
    key: "downloads.enabled",
    group: "Downloads",
    label: "Downloads allowed",
    description: "Off refuses every download, including for unmetered accounts.",
    type: "boolean",
    defaultValue: true,
  },

  // ── Export quality ─────────────────────────────────────────────────────
  {
    key: "export.crf",
    group: "Export quality",
    label: "Encode quality (CRF)",
    description:
      "Lower is better quality and a bigger file. Each step of ~6 roughly doubles " +
      "or halves size. This is the main lever on Bunny storage cost.",
    type: "number",
    defaultValue: 23,
    min: 14,
    max: 34,
    integer: true,
    appliesToNewWorkOnly: true,
  },
  {
    key: "export.preset",
    group: "Export quality",
    label: "Encoder preset",
    description:
      "Slower presets buy compression, not picture quality, and cost CPU the box " +
      "shares with the hourly archive. Raise CRF before slowing the preset.",
    type: "enum",
    defaultValue: "veryfast",
    options: ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"],
    appliesToNewWorkOnly: true,
  },
  {
    key: "export.fps",
    group: "Export quality",
    label: "Output frame rate",
    description:
      "The platform contract every segment is normalised to. Segments that will be " +
      "concatenated must agree, so changing this mid-render produces files that " +
      "play for one segment and stop.",
    type: "number",
    defaultValue: 30,
    min: 15,
    max: 60,
    integer: true,
    unit: "fps",
    appliesToNewWorkOnly: true,
  },
  {
    key: "clip.maxDurationSeconds",
    group: "Export quality",
    label: "Longest exportable clip",
    description: "Caps a single render. A three-minute clip costs about five CPU-minutes.",
    type: "number",
    defaultValue: 600,
    min: 5,
    max: 7200,
    integer: true,
    unit: "seconds",
  },

  // ── Render queue ───────────────────────────────────────────────────────
  {
    key: "render.maxConcurrent",
    group: "Render queue",
    label: "Concurrent renders",
    description:
      "How many exports encode at once. Each saturates several cores on a box " +
      "shared with the hourly archive encoder.",
    type: "number",
    defaultValue: 2,
    min: 1,
    max: 16,
    integer: true,
  },
  {
    key: "render.yieldToArchive",
    group: "Render queue",
    label: "Yield to the archive",
    description:
      "Hold renders while the hourly archive is assembling. A late render is an " +
      "annoyed user; a late archive is a match hour that cannot be re-recorded.",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "render.yieldLoadRatio",
    group: "Render queue",
    label: "Yield above load-per-core",
    description:
      "One-minute load average divided by CPU count, above which the box counts as " +
      "busy. Lower yields more readily.",
    type: "number",
    defaultValue: 0.85,
    min: 0.1,
    max: 8,
  },
  {
    key: "render.yieldCeilingSeconds",
    group: "Render queue",
    label: "Maximum yield",
    description:
      "After this long a render proceeds regardless. Not optional: the archive runs " +
      "every ten minutes and an hour of 4K takes a large fraction of that, so " +
      "'busy' is a steady state and without a ceiling nobody gets a download on a " +
      "busy evening.",
    type: "number",
    defaultValue: 600,
    min: 0,
    max: 7200,
    integer: true,
    unit: "seconds",
  },

  // ── Playback ───────────────────────────────────────────────────────────
  {
    key: "playback.maxWidth",
    group: "Playback",
    label: "Playback quality cap",
    description:
      "Widest rendition ordinary playback will select. The crop editor and the " +
      "exporter are unaffected — they are pinned to the source geometry.",
    type: "number",
    defaultValue: 1920,
    min: 640,
    max: 3840,
    integer: true,
    unit: "px",
  },

  // ── Sharing ────────────────────────────────────────────────────────────
  {
    key: "share.enabled",
    group: "Sharing",
    label: "Public share links",
    description: "Off makes every share page 404, including links already sent.",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "share.posterEnabled",
    group: "Sharing",
    label: "Generate share posters",
    description:
      "Off falls back to a card with no image. Posters cost one seek against the " +
      "source the first time a clip is shared.",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "branding.overlayEnabled",
    group: "Sharing",
    label: "Branding overlay",
    description: "Burn the field or academy overlay into exported clips.",
    type: "boolean",
    defaultValue: true,
    appliesToNewWorkOnly: true,
  },
  {
    key: "branding.endCardEnabled",
    group: "Sharing",
    label: "End card",
    description: "Append the call-to-action card to exported clips.",
    type: "boolean",
    defaultValue: true,
    appliesToNewWorkOnly: true,
  },
  {
    key: "clip.introEnabled",
    group: "Sharing",
    label: "Prepend academy intro",
    description: "Play the academy's intro at the head of a downloaded clip.",
    type: "boolean",
    defaultValue: true,
    appliesToNewWorkOnly: true,
  },
] as const;

export type SettingKey = (typeof SETTINGS)[number]["key"];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function getSetting(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

export function settingKeys(): string[] {
  return SETTINGS.map((s) => s.key);
}

export interface ValidationResult {
  ok: boolean;
  /** Coerced value, present when ok. */
  value?: number | boolean | string;
  error?: string;
}

/**
 * Validate and coerce a value for a key.
 *
 * Strict about type, because a rule is stored as JSON and an admin form will
 * happily hand over the string "5" for a number. Storing that would make the
 * resolver return a string where the caller expects a number, and the failure
 * would surface somewhere unrelated hours later.
 */
export function validateSettingValue(key: string, raw: unknown): ValidationResult {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, error: `Unknown setting "${key}"` };

  if (def.type === "boolean") {
    if (typeof raw !== "boolean") return { ok: false, error: `${def.label} must be true or false` };
    return { ok: true, value: raw };
  }

  if (def.type === "enum") {
    if (typeof raw !== "string" || !def.options?.includes(raw)) {
      return { ok: false, error: `${def.label} must be one of: ${def.options?.join(", ")}` };
    }
    return { ok: true, value: raw };
  }

  if (def.type === "string") {
    if (typeof raw !== "string") return { ok: false, error: `${def.label} must be text` };
    return { ok: true, value: raw };
  }

  // number
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return { ok: false, error: `${def.label} must be a number` };
  if (def.integer && !Number.isInteger(n)) {
    return { ok: false, error: `${def.label} must be a whole number` };
  }
  if (def.min != null && n < def.min) {
    return { ok: false, error: `${def.label} must be at least ${def.min}` };
  }
  if (def.max != null && n > def.max) {
    return { ok: false, error: `${def.label} must be at most ${def.max}` };
  }
  return { ok: true, value: n };
}
