const AMMAN_TIME_ZONE = "Asia/Amman";

type WallClockParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function partsInAmman(epochMs: number): WallClockParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AMMAN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function validWallClock(parts: WallClockParts): boolean {
  if (
    parts.month < 1 || parts.month > 12
    || parts.day < 1 || parts.day > 31
    || parts.hour < 0 || parts.hour > 23
    || parts.minute < 0 || parts.minute > 59
  ) {
    return false;
  }
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  return check.getUTCFullYear() === parts.year
    && check.getUTCMonth() === parts.month - 1
    && check.getUTCDate() === parts.day
    && check.getUTCHours() === parts.hour
    && check.getUTCMinutes() === parts.minute;
}

function wallClockAsUtcMs(parts: WallClockParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function sameWallClock(a: WallClockParts, b: WallClockParts): boolean {
  return a.year === b.year
    && a.month === b.month
    && a.day === b.day
    && a.hour === b.hour
    && a.minute === b.minute;
}

export function ammanInputToUtcIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const target: WallClockParts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  };
  if (!validWallClock(target)) return null;

  const targetAsUtcMs = wallClockAsUtcMs(target);
  let candidateMs = targetAsUtcMs;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const represented = partsInAmman(candidateMs);
    const deltaMs = targetAsUtcMs - wallClockAsUtcMs(represented);
    if (deltaMs === 0) {
      return sameWallClock(target, represented) ? new Date(candidateMs).toISOString() : null;
    }
    candidateMs += deltaMs;
  }

  return sameWallClock(target, partsInAmman(candidateMs))
    ? new Date(candidateMs).toISOString()
    : null;
}

export function utcIsoToAmmanInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const epochMs = Date.parse(iso);
  if (!Number.isFinite(epochMs)) return "";
  const parts = partsInAmman(epochMs);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function formatAmmanDateTime(iso: string, locale: string): {
  date: string;
  dateKey: string;
  time: string;
} {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid session timestamp");
  const language = locale === "ar" ? "ar-JO" : "en-GB";
  const keyParts = partsInAmman(date.getTime());
  const dateKey = `${String(keyParts.year).padStart(4, "0")}-${String(keyParts.month).padStart(2, "0")}-${String(keyParts.day).padStart(2, "0")}`;
  return {
    dateKey,
    date: new Intl.DateTimeFormat(language, {
      timeZone: AMMAN_TIME_ZONE,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date),
    time: new Intl.DateTimeFormat(language, {
      timeZone: AMMAN_TIME_ZONE,
      hour: "numeric",
      minute: "2-digit",
      hour12: locale === "ar",
    }).format(date),
  };
}