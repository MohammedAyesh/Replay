/**
 * Chat behaviour an academy sets in Chats → options: read receipts, the greeting for a new
 * number, the "we're closed" reply, the reply to a missed call, and its WhatsApp Channel.
 * Stored as one jsonb on the settings row; anything missing falls back to these defaults.
 */
export type ChatLocale = "ar" | "en";

export type AutoReply = { enabled: boolean; text: string };
export type AwayReply = AutoReply & {
  /** Days the academy is reachable, 0 = Sunday … 6 = Saturday (Amman time). */
  days: number[];
  /** Open hours "HH:MM"; messages outside them get the away reply. */
  start: string;
  end: string;
};

export type ChatOptions = {
  readReceipts: boolean;
  greeting: AutoReply;
  away: AwayReply;
  missedCall: AutoReply;
  channel: { id: string; name: string; invite: string | null } | null;
};

const TEXTS: Record<ChatLocale, { greeting: string; away: string; missedCall: string }> = {
  ar: {
    greeting: "أهلاً فيك! شكراً لتواصلك معنا. رح نرد عليك بأقرب وقت.",
    away: "شكراً لرسالتك. حالياً خارج أوقات الدوام، ورح نرد عليك أول ما نبدأ.",
    missedCall: "شفنا إنك اتصلت. ما منقدر نرد على المكالمات عالواتساب، اكتبلنا رسالة ورح نرد عليك.",
  },
  en: {
    greeting: "Hi! Thanks for getting in touch. We'll reply as soon as we can.",
    away: "Thanks for your message. We're closed right now and will reply when we're back.",
    missedCall: "We saw your call. We can't take calls on WhatsApp, but send us a message and we'll reply.",
  },
};

export function defaultChatOptions(locale: ChatLocale): ChatOptions {
  const t = TEXTS[locale];
  return {
    readReceipts: true,
    greeting: { enabled: false, text: t.greeting },
    away: { enabled: false, text: t.away, days: [0, 1, 2, 3, 4, 6], start: "09:00", end: "21:00" },
    missedCall: { enabled: false, text: t.missedCall },
    channel: null,
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1000) : fallback;
}

/** Merge what's stored over the defaults, ignoring anything malformed. */
export function parseChatOptions(raw: unknown, locale: ChatLocale): ChatOptions {
  const d = defaultChatOptions(locale);
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const auto = (value: unknown, base: AutoReply): AutoReply => {
    const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return { enabled: v.enabled === true, text: text(v.text, base.text) };
  };
  const away = (r.away && typeof r.away === "object" ? r.away : {}) as Record<string, unknown>;
  const days = Array.isArray(away.days) ? [...new Set((away.days as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))] : d.away.days;
  const channel = r.channel && typeof r.channel === "object" ? (r.channel as Record<string, unknown>) : null;
  return {
    readReceipts: r.readReceipts !== false,
    greeting: auto(r.greeting, d.greeting),
    away: {
      ...auto(r.away, d.away),
      days,
      start: typeof away.start === "string" && HHMM.test(away.start) ? away.start : d.away.start,
      end: typeof away.end === "string" && HHMM.test(away.end) ? away.end : d.away.end,
    },
    missedCall: auto(r.missedCall, d.missedCall),
    channel: channel && typeof channel.id === "string" && channel.id
      ? { id: channel.id, name: String(channel.name ?? ""), invite: typeof channel.invite === "string" ? channel.invite : null }
      : null,
  };
}

/** Day of week (0 = Sunday) and minutes since midnight in Amman. */
export function ammanClock(at: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Amman", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is the academy closed at this moment? A window that crosses midnight (22:00–02:00) is supported. */
export function isClosed(away: AwayReply, at: Date): boolean {
  const { day, minutes } = ammanClock(at);
  if (!away.days.includes(day)) return true;
  const start = toMinutes(away.start);
  const end = toMinutes(away.end);
  if (start === end) return false;
  const open = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  return !open;
}
