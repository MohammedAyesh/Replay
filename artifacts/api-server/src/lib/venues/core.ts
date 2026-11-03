/**
 * Field console: the pure parts of pitch booking. Amman wall time, opening hours, prices and
 * free slots. No database here, so all of it is unit-tested directly (core.test.ts).
 *
 * Times a person sees are Amman wall time, "YYYY-MM-DD HH:MM". A business day is the day the
 * field opens: a field open 16:00–02:00 on Thursday takes Thursday-night bookings until 02:00
 * Friday, and those are listed under Thursday.
 */

import { randomBytes } from "node:crypto";

export type DayHours = { open: string; close: string };
/** Weekday (0 = Sunday … 6 = Saturday, as Date.getUTCDay) → hours. A missing day is closed. */
export type OpeningHours = Partial<Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", DayHours | null>>;
export type PriceRule = { days: number[]; from: string; to: string; pricePerHourFils: number };

export const DEFAULT_OPENING_HOURS: OpeningHours = Object.fromEntries(
  ["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, { open: "09:00", close: "01:00" }]),
) as OpeningHours;

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-4]):([0-5]\d)$/;

const ammanFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Amman",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "YYYY-MM-DD HH:MM" in Amman for an instant. */
export function ammanLocal(date: Date): string {
  const p = Object.fromEntries(ammanFormat.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Minutes since 1970 of a wall-clock string, read as if it were UTC (for arithmetic on wall time). */
export function wallMinutes(local: string): number {
  const m = LOCAL_RE.exec(local);
  if (!m) return Number.NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60_000;
}

export function wallString(minutes: number): string {
  const d = new Date(minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** The instant an Amman wall time names. Amman has been UTC+3 all year since 2022; this checks rather than assumes. */
export function fromAmmanLocal(local: string): Date | null {
  const wall = wallMinutes(local);
  if (!Number.isFinite(wall)) return null;
  let guess = new Date((wall - 180) * 60_000);
  for (let i = 0; i < 3; i += 1) {
    const diff = wall - wallMinutes(ammanLocal(guess));
    if (diff === 0) return guess;
    guess = new Date(guess.getTime() + diff * 60_000);
  }
  return wallMinutes(ammanLocal(guess)) === wall ? guess : null;
}

export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const m = DATE_RE.exec(value)!;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function isTime(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value) && (value <= "24:00");
}

function timeMinutes(value: string): number {
  const m = TIME_RE.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}

export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The opening window of a business day, in wall minutes, or null when closed. */
export function openingWindow(hours: OpeningHours, date: string): { start: number; end: number } | null {
  const day = hours[String(weekday(date)) as keyof OpeningHours];
  if (!day || !isTime(day.open) || !isTime(day.close)) return null;
  const base = wallMinutes(`${date} 00:00`);
  const open = timeMinutes(day.open);
  let close = timeMinutes(day.close);
  if (close <= open) close += 24 * 60; // past midnight (and 24:00 → midnight)
  if (close - open < 30) return null;
  return { start: base + open, end: base + close };
}

/** The business day a wall time belongs to (a 01:00 kick-off after a late opening belongs to the day before). */
export function businessDayFor(hours: OpeningHours, local: string): string | null {
  const date = local.slice(0, 10);
  const minute = wallMinutes(local);
  for (const candidate of [date, addDays(date, -1)]) {
    const w = openingWindow(hours, candidate);
    if (w && minute >= w.start && minute < w.end) return candidate;
  }
  return null;
}

/** Price per hour that applies at a wall minute. The first rule whose days and hours cover it wins. */
export function rateAt(base: number, rules: PriceRule[], minute: number): number {
  const local = wallString(minute);
  const day = weekday(local.slice(0, 10));
  const tod = minute - wallMinutes(`${local.slice(0, 10)} 00:00`);
  for (const rule of rules) {
    if (!Array.isArray(rule.days) || !isTime(rule.from) || !isTime(rule.to)) continue;
    const from = timeMinutes(rule.from);
    const to = timeMinutes(rule.to);
    const inWindow = to > from ? tod >= from && tod < to : tod >= from || tod < to;
    // A window past midnight ("18:00"–"02:00") counts its early hours to the day it started.
    const ruleDay = to <= from && tod < to ? (day + 6) % 7 : day;
    if (inWindow && rule.days.includes(ruleDay)) return rule.pricePerHourFils;
  }
  return base;
}

/** What a booking costs, quarter-hour by quarter-hour, rounded to whole fils. */
export function priceFor(pitch: { pricePerHourFils: number; priceRules: unknown }, startLocal: string, minutes: number): number {
  const rules = normaliseRules(pitch.priceRules);
  const start = wallMinutes(startLocal);
  if (!Number.isFinite(start) || minutes <= 0) return 0;
  let total = 0;
  for (let m = 0; m < minutes; m += 15) {
    const step = Math.min(15, minutes - m);
    total += (rateAt(pitch.pricePerHourFils, rules, start + m) * step) / 60;
  }
  return Math.round(total);
}

export function normaliseRules(value: unknown): PriceRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r) => {
    const rule = r as Partial<PriceRule>;
    const days = Array.isArray(rule.days) ? [...new Set(rule.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
    const price = Number(rule.pricePerHourFils);
    if (!days.length || !isTime(rule.from) || !isTime(rule.to) || !Number.isInteger(price) || price < 0 || price > 1_000_000) return [];
    return [{ days, from: rule.from, to: rule.to, pricePerHourFils: price }];
  }).slice(0, 20);
}

export function normaliseHours(value: unknown): OpeningHours {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const out: OpeningHours = {};
  for (const d of ["0", "1", "2", "3", "4", "5", "6"] as const) {
    const day = input[d] as Partial<DayHours> | null | undefined;
    out[d] = day && isTime(day.open) && isTime(day.close) ? { open: day.open, close: day.close } : null;
  }
  return out;
}

export function normaliseDurations(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [];
  const clean = [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n >= 30 && n <= 360 && n % 15 === 0))].sort((a, b) => a - b);
  return clean.length ? clean.slice(0, 6) : [60, 90, 120];
}

export type Busy = { start: number; end: number };

export type SlotOption = { minutes: number; priceFils: number; available: boolean };
export type Slot = { startLocal: string; endsByLocal: string; options: SlotOption[]; available: boolean };

/**
 * Kick-off times on a business day for one pitch, each with the lengths that fit before
 * closing and whether they're free. `nowMinute` is Amman wall time now.
 */
export function slotsFor(input: {
  date: string;
  hours: OpeningHours;
  stepMinutes: number;
  durations: number[];
  busy: Busy[];
  pitch: { pricePerHourFils: number; priceRules: unknown };
  nowMinute: number;
  minNoticeMinutes: number;
}): Slot[] {
  const window = openingWindow(input.hours, input.date);
  if (!window) return [];
  const step = Math.max(15, Math.min(120, input.stepMinutes || 30));
  const shortest = Math.min(...input.durations);
  const earliest = input.nowMinute + Math.max(0, input.minNoticeMinutes);
  const slots: Slot[] = [];
  for (let start = window.start; start + shortest <= window.end; start += step) {
    if (start < earliest) continue;
    const options = input.durations
      .filter((minutes) => start + minutes <= window.end)
      .map((minutes) => ({
        minutes,
        priceFils: priceFor(input.pitch, wallString(start), minutes),
        available: !input.busy.some((b) => start < b.end && b.start < start + minutes),
      }));
    if (!options.length) continue;
    slots.push({
      startLocal: wallString(start),
      endsByLocal: wallString(window.end),
      options,
      available: options.some((o) => o.available),
    });
  }
  return slots;
}

/** Whether a requested booking fits the field's rules (not whether the pitch is free). */
export function checkRequest(input: {
  startLocal: string;
  minutes: number;
  hours: OpeningHours;
  stepMinutes: number;
  durations: number[];
  nowMinute: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  /** Staff may book any length on the step, and on short notice. */
  staff?: boolean;
}): { ok: true; businessDay: string } | { ok: false; error: string } {
  const start = wallMinutes(input.startLocal);
  if (!Number.isFinite(start)) return { ok: false, error: "Pick a start time" };
  const step = Math.max(15, input.stepMinutes || 30);
  if (!Number.isInteger(input.minutes) || input.minutes < 30 || input.minutes > 360) return { ok: false, error: "A booking is between 30 minutes and 6 hours" };
  if (!input.staff && !input.durations.includes(input.minutes)) return { ok: false, error: "That length can't be booked online" };
  if (input.minutes % 15 !== 0) return { ok: false, error: "A booking is in quarter hours" };
  const day = businessDayFor(input.hours, input.startLocal);
  if (!day) return { ok: false, error: "The field is closed then" };
  const window = openingWindow(input.hours, day)!;
  if (!input.staff && (start - window.start) % step !== 0) return { ok: false, error: `Kick-off times are every ${step} minutes` };
  if (start + input.minutes > window.end) return { ok: false, error: "The field closes before that ends" };
  const notice = input.staff ? -24 * 60 : input.minNoticeMinutes;
  if (start < input.nowMinute + notice) return { ok: false, error: "That time has passed or is too soon to book" };
  if (start > input.nowMinute + input.maxDaysAhead * 24 * 60) return { ok: false, error: `Bookings open ${input.maxDaysAhead} days ahead` };
  return { ok: true, businessDay: day };
}

const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** "JG-4F7K2Q": the field's initials and six characters that can't be misread. */
export function bookingReference(venueName: string): string {
  const initials = venueName
    .replace(/[^A-Za-z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("")
    .slice(0, 3) || "RP";
  const bytes = randomBytes(6);
  let code = "";
  for (const b of bytes) code += REF_ALPHABET[b % REF_ALPHABET.length];
  return `${initials}-${code}`;
}

export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "field";
}

/** "20.000 JOD" / "20 د.أ" — amounts are stored in fils (1 JOD = 1000 fils). */
export function formatJod(fils: number, locale: "ar" | "en" = "en"): string {
  const jod = fils / 1000;
  const text = Number.isInteger(jod) ? String(jod) : jod.toFixed(jod * 10 === Math.round(jod * 10) ? 1 : 3).replace(/0+$/, "");
  return locale === "ar" ? `${text} دينار` : `${text} JOD`;
}

/** What is due online for a booking, given the field's deposit rule. */
export function dueOnline(amountFils: number, mode: string, depositFils: number): number {
  if (mode === "none") return 0;
  if (mode === "deposit") return Math.min(amountFils, Math.max(0, depositFils));
  return amountFils;
}

/** A hostname a field may point at us: lower case, no scheme, no path, at least one dot, not ours. */
export function normaliseDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let host = value.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null;
  if (/(^|\.)replayjo\.com$|(^|\.)b-cdn\.net$|(^|\.)replit\.(app|dev)$|(^|\.)repl\.co$/.test(host)) return null;
  return host;
}
