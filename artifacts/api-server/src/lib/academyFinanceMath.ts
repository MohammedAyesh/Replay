const AMMAN_TIME_ZONE = "Asia/Amman";
const DAY_MS = 24 * 60 * 60 * 1000;

const ammanPartsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: AMMAN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function dateParts(value: string): [number, number, number] {
  const [year, month, day] = value.split("-").map(Number);
  return [year, month, day];
}

export function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = dateParts(value);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function formatDateOnly(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getAmmanDate(now = new Date()): string {
  const parts = Object.fromEntries(
    ammanPartsFormatter.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getAmmanMonth(now = new Date()): string {
  return getAmmanDate(now).slice(0, 7);
}

export function addMonthsToDate(dateOnly: string, months: number): string {
  const [year, month, day] = dateParts(dateOnly);
  const targetIndex = year * 12 + month - 1 + months;
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonth = targetIndex - targetYear * 12 + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return formatDateOnly(targetYear, targetMonth, Math.min(day, lastDay));
}

export function monthsOwedSince(expiryDate: string, today = getAmmanDate()): number {
  const [expiryYear, expiryMonth] = dateParts(expiryDate);
  const [todayYear, todayMonth] = dateParts(today);
  let months = (todayYear - expiryYear) * 12 + todayMonth - expiryMonth;
  if (months <= 0) return 0;

  while (months > 0 && addMonthsToDate(expiryDate, months) > today) months -= 1;
  while (addMonthsToDate(expiryDate, months + 1) <= today) months += 1;
  return months;
}

export function subscriptionStatus(
  expiryDate: string | null,
  today = getAmmanDate(),
): "no_subscription" | "paid" | "expiring" | "expired" {
  if (!expiryDate) return "no_subscription";
  if (expiryDate < today) return "expired";
  const [year, month, day] = dateParts(expiryDate);
  const [todayYear, todayMonth, todayDay] = dateParts(today);
  const dayDelta = (
    Date.UTC(year, month - 1, day) - Date.UTC(todayYear, todayMonth - 1, todayDay)
  ) / DAY_MS;
  return dayDelta <= 7 ? "expiring" : "paid";
}

function ammanMidnightUtc(dateOnly: string): Date {
  const [year, month, day] = dateParts(dateOnly);
  const targetAsUtc = Date.UTC(year, month - 1, day);
  let guess = targetAsUtc;

  // Convert a wall-clock midnight to UTC using the zone offset at that date.
  // The short iteration also handles offset transitions without depending on
  // the server's local timezone.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      ammanPartsFormatter.formatToParts(new Date(guess)).map(({ type, value }) => [type, value]),
    );
    const localAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    guess += targetAsUtc - localAsUtc;
  }
  return new Date(guess);
}

export function getAmmanMonthRange(now = new Date()): {
  month: string;
  startDate: string;
  endDate: string;
  startAt: Date;
  endAt: Date;
} {
  const month = getAmmanMonth(now);
  const [year, monthNumber] = month.split("-").map(Number);
  const startDate = `${month}-01`;
  const endDate = addMonthsToDate(`${month}-01`, 1);
  return {
    month,
    startDate,
    endDate,
    startAt: ammanMidnightUtc(startDate),
    endAt: ammanMidnightUtc(endDate),
  };
}