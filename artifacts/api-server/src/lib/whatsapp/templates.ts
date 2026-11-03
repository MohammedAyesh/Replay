/**
 * Academy WhatsApp automations: what each one is, who it can go to, its timing,
 * and its default wording in Arabic (Ammani) and English.
 *
 * Owners can turn each automation on, choose its audience, change its timing and
 * rewrite its text. Whatever they leave unset falls back to the defaults here, so
 * a wording fix in code reaches every academy that kept the default.
 */

export type WhatsappLocale = "ar" | "en";
export type AudienceRole = "parents" | "players" | "coaches";
export const AUDIENCE_ROLES: AudienceRole[] = ["parents", "players", "coaches"];

export type AutomationKey =
  | "session_created"
  | "session_changed"
  | "session_cancelled"
  | "session_reminder"
  | "absence_notice"
  | "fee_reminder"
  | "fee_overdue"
  | "subscription_expiring"
  | "payment_receipt"
  | "footage_ready"
  | "player_clip"
  | "registration_received"
  | "registration_approved"
  | "announcement";

export type TimingUnit = "hoursBefore" | "daysBefore" | "daysAfter";

export type AutomationDefinition = {
  key: AutomationKey;
  /** Roles the owner may pick from. Empty = fixed recipient (e.g. the registration phone). */
  allowedAudiences: AudienceRole[];
  defaultAudiences: AudienceRole[];
  timing: { unit: TimingUnit; default: number; min: number; max: number } | null;
  placeholders: string[];
  template: Record<WhatsappLocale, string>;
};

const COMMON = ["academy", "name"];

export const AUTOMATIONS: AutomationDefinition[] = [
  {
    key: "session_created",
    allowedAudiences: ["parents", "players", "coaches"],
    defaultAudiences: ["parents", "players"],
    timing: null,
    placeholders: [...COMMON, "player", "squad", "type", "day", "date", "time", "location", "opponent"],
    template: {
      ar: "{academy} ⚽\nانضاف {type} جديد لفريق {squad}{opponent}\n📅 {day} {date}\n⏰ {time}\n📍 {location}",
      en: "{academy} ⚽\nNew {type} for {squad}{opponent}\n📅 {day} {date}\n⏰ {time}\n📍 {location}",
    },
  },
  {
    key: "session_changed",
    allowedAudiences: ["parents", "players", "coaches"],
    defaultAudiences: ["parents", "players"],
    timing: null,
    placeholders: [...COMMON, "player", "squad", "type", "day", "date", "time", "location", "opponent"],
    template: {
      ar: "{academy} ⚠️\nتغيّر موعد {type} فريق {squad}{opponent}\n📅 {day} {date}\n⏰ {time}\n📍 {location}",
      en: "{academy} ⚠️\nThe {type} for {squad}{opponent} has changed\n📅 {day} {date}\n⏰ {time}\n📍 {location}",
    },
  },
  {
    key: "session_cancelled",
    allowedAudiences: ["parents", "players", "coaches"],
    defaultAudiences: ["parents", "players", "coaches"],
    timing: null,
    placeholders: [...COMMON, "player", "squad", "type", "day", "date", "time", "location", "opponent"],
    template: {
      ar: "{academy} ❌\nانلغى {type} فريق {squad}{opponent} يوم {day} {date} الساعة {time}.",
      en: "{academy} ❌\nThe {type} for {squad}{opponent} on {day} {date} at {time} is cancelled.",
    },
  },
  {
    key: "session_reminder",
    allowedAudiences: ["parents", "players", "coaches"],
    defaultAudiences: ["parents", "players"],
    timing: { unit: "hoursBefore", default: 3, min: 1, max: 48 },
    placeholders: [...COMMON, "player", "squad", "type", "day", "date", "time", "location", "opponent"],
    template: {
      ar: "تذكير من {academy} ⏰\n{type} فريق {squad}{opponent}\n📅 {day} {date} الساعة {time}\n📍 {location}",
      en: "Reminder from {academy} ⏰\n{type} for {squad}{opponent}\n📅 {day} {date} at {time}\n📍 {location}",
    },
  },
  {
    key: "absence_notice",
    allowedAudiences: ["parents", "players"],
    defaultAudiences: ["parents"],
    timing: null,
    placeholders: [...COMMON, "player", "squad", "type", "day", "date", "time"],
    template: {
      ar: "{academy}\n{player} كان غايب عن {type} يوم {day} {date}. إذا في عذر، احكولنا 🙏",
      en: "{academy}\n{player} was marked absent from the {type} on {day} {date}. If there's a reason, please let us know 🙏",
    },
  },
  {
    key: "fee_reminder",
    allowedAudiences: ["parents", "players"],
    defaultAudiences: ["parents"],
    timing: { unit: "daysBefore", default: 3, min: 0, max: 30 },
    placeholders: [...COMMON, "player", "label", "amount", "due_date"],
    template: {
      ar: "{academy} 💳\nتذكير: رسوم {label} لـ {player} بقيمة {amount} مستحقة بتاريخ {due_date}.",
      en: "{academy} 💳\nReminder: {label} for {player} ({amount}) is due on {due_date}.",
    },
  },
  {
    key: "fee_overdue",
    allowedAudiences: ["parents", "players"],
    defaultAudiences: ["parents"],
    timing: { unit: "daysAfter", default: 3, min: 1, max: 60 },
    placeholders: [...COMMON, "player", "label", "amount", "due_date"],
    template: {
      ar: "{academy} 💳\nرسوم {label} لـ {player} بقيمة {amount} كانت مستحقة بتاريخ {due_date} ولسّا ما انتدفعت.",
      en: "{academy} 💳\n{label} for {player} ({amount}) was due on {due_date} and is still unpaid.",
    },
  },
  {
    key: "subscription_expiring",
    allowedAudiences: ["parents", "players"],
    defaultAudiences: ["parents"],
    timing: { unit: "daysBefore", default: 5, min: 0, max: 30 },
    placeholders: [...COMMON, "player", "squad", "expires"],
    template: {
      ar: "{academy}\nاشتراك {player} بخلص بتاريخ {expires}. جدّدوا الاشتراك عشان يضل يتمرّن معنا 🙏",
      en: "{academy}\n{player}'s subscription ends on {expires}. Renew to keep training with us 🙏",
    },
  },
  {
    key: "payment_receipt",
    allowedAudiences: ["parents", "players"],
    defaultAudiences: ["parents"],
    timing: null,
    placeholders: [...COMMON, "player", "amount", "details"],
    template: {
      ar: "{academy} ✅\nوصلنا مبلغ {amount} عن {player}. شكراً!\n{details}",
      en: "{academy} ✅\nWe received {amount} for {player}. Thank you!\n{details}",
    },
  },
  {
    key: "footage_ready",
    allowedAudiences: ["parents", "players", "coaches"],
    defaultAudiences: ["parents", "players"],
    timing: null,
    placeholders: [...COMMON, "player", "squad", "type", "day", "date", "link"],
    template: {
      ar: "{academy} 🎥\nفيديو {type} فريق {squad} يوم {day} {date} صار جاهز. شوفوه من هون:\n{link}",
      en: "{academy} 🎥\nThe video of {squad}'s {type} on {day} {date} is ready. Watch it here:\n{link}",
    },
  },
  {
    // A child's best moment from an analysed match, to his own family only (lib/featured/privateClips.ts).
    // Prepared automatically; the owner sends each batch from Matches. A parent with two children gets one message.
    key: "player_clip",
    allowedAudiences: ["parents", "players"],
    defaultAudiences: ["parents"],
    timing: null,
    placeholders: [...COMMON, "day", "date", "clips"],
    template: {
      ar: "{academy} 🎥\nأحلى لقطة من ماتش {day} {date}:\n{clips}",
      en: "{academy} 🎥\nThe best moment from {day} {date}'s match:\n{clips}",
    },
  },
  {
    key: "registration_received",
    allowedAudiences: [],
    defaultAudiences: [],
    timing: null,
    placeholders: [...COMMON, "player"],
    template: {
      ar: "أهلاً {name} 👋\nوصلنا طلب تسجيل {player} في {academy}. رح نتواصل معكم قريباً.",
      en: "Hi {name} 👋\nWe received {player}'s registration for {academy}. We'll be in touch soon.",
    },
  },
  {
    key: "registration_approved",
    allowedAudiences: [],
    defaultAudiences: [],
    timing: null,
    placeholders: [...COMMON, "player", "squad", "link"],
    template: {
      ar: "أهلاً وسهلاً 🎉\nتم قبول {player} في {academy}.\nسجّلوا من هون عشان تتابعوا المواعيد والحضور والفيديوهات:\n{link}",
      en: "Welcome 🎉\n{player} has been accepted into {academy}.\nSign up here to follow sessions, attendance and videos:\n{link}",
    },
  },
  {
    key: "announcement",
    allowedAudiences: ["parents", "players", "coaches"],
    defaultAudiences: ["parents", "players"],
    timing: null,
    placeholders: [...COMMON, "player", "squad", "title", "message"],
    template: {
      ar: "📢 {academy}\n*{title}*\n{message}",
      en: "📢 {academy}\n*{title}*\n{message}",
    },
  },
];

export const AUTOMATION_KEYS = AUTOMATIONS.map((a) => a.key);

export function automationDefinition(key: string): AutomationDefinition | undefined {
  return AUTOMATIONS.find((a) => a.key === key);
}

export type StoredAutomation = {
  enabled?: boolean;
  audiences?: AudienceRole[];
  template?: string | null;
  timing?: number | null;
};

export type EffectiveAutomation = {
  key: AutomationKey;
  enabled: boolean;
  audiences: AudienceRole[];
  template: string;
  customTemplate: boolean;
  timing: number | null;
};

/**
 * Announcements default to on (the owner still ticks "also send on WhatsApp" per
 * announcement); every other automation is off until the owner turns it on.
 */
const DEFAULT_ENABLED: Partial<Record<AutomationKey, boolean>> = { announcement: true, player_clip: true };

export function effectiveAutomation(
  def: AutomationDefinition,
  stored: StoredAutomation | undefined,
  locale: WhatsappLocale,
): EffectiveAutomation {
  const audiences = Array.isArray(stored?.audiences)
    ? stored!.audiences.filter((r) => def.allowedAudiences.includes(r))
    : def.defaultAudiences;
  let timing: number | null = null;
  if (def.timing) {
    const raw = typeof stored?.timing === "number" && Number.isFinite(stored.timing) ? stored.timing : def.timing.default;
    timing = Math.min(def.timing.max, Math.max(def.timing.min, Math.round(raw)));
  }
  const custom = typeof stored?.template === "string" && stored.template.trim().length > 0;
  return {
    key: def.key,
    enabled: typeof stored?.enabled === "boolean" ? stored.enabled : DEFAULT_ENABLED[def.key] ?? false,
    audiences,
    template: custom ? stored!.template!.trim() : def.template[locale],
    customTemplate: custom,
    timing,
  };
}

export function effectiveAutomations(
  stored: unknown,
  locale: WhatsappLocale,
): Record<AutomationKey, EffectiveAutomation> {
  const map = (stored && typeof stored === "object" ? stored : {}) as Record<string, StoredAutomation>;
  return Object.fromEntries(
    AUTOMATIONS.map((def) => [def.key, effectiveAutomation(def, map[def.key], locale)]),
  ) as Record<AutomationKey, EffectiveAutomation>;
}

/** Replace {placeholders}. Unknown or empty ones vanish; leftover blank lines collapse. */
export function renderTemplate(template: string, values: Record<string, string | null | undefined>): string {
  const out = template.replace(/\{([a-z_]+)\}/g, (_m, key: string) => {
    const value = values[key];
    return value == null ? "" : String(value);
  });
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Value formatting ─────────────────────────────────────────────────────────

const TZ = "Asia/Amman";

export function formatDay(date: Date, locale: WhatsappLocale): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { weekday: "long", timeZone: TZ }).format(date);
}

export function formatDate(date: Date, locale: WhatsappLocale): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", {
    day: "numeric",
    month: "numeric",
    timeZone: TZ,
  }).format(date);
}

export function formatTime(date: Date, locale: WhatsappLocale): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TZ,
  }).format(date);
}

/** A YYYY-MM-DD calendar date, shown as d/m. */
export function formatCalendarDate(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return `${d}/${m}/${y}`;
}

export function formatFils(amountFils: number, locale: WhatsappLocale): string {
  const text = String(Number((amountFils / 1000).toFixed(3)));
  return locale === "ar" ? `${text} دينار` : `${text} JOD`;
}

export function sessionTypeLabel(type: string, locale: WhatsappLocale): string {
  if (type === "match") return locale === "ar" ? "مباراة" : "match";
  return locale === "ar" ? "تمرين" : "training";
}

export function opponentFragment(opponent: string | null | undefined, locale: WhatsappLocale): string {
  if (!opponent?.trim()) return "";
  return locale === "ar" ? ` ضد ${opponent.trim()}` : ` vs ${opponent.trim()}`;
}

export function allSquadsLabel(locale: WhatsappLocale): string {
  return locale === "ar" ? "الأكاديمية" : "the academy";
}
