export type HomeHighlightCandidate = { id: number; kind: "personal" | "field"; weekStart: string };

export function currentReplayWeekStart(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
  const weekday = new Date(`${values.year}-${values.month}-${values.day}T12:00:00Z`).getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((weekday + 1) % 7));
  return date.toISOString().slice(0, 10);
}

export function chooseHomeHighlight<T extends HomeHighlightCandidate>(
  personal: T | null,
  field: T | null,
  currentWeekStart: string,
): T | null {
  const earliest = new Date(`${currentWeekStart}T00:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() - 7);
  const from = earliest.toISOString().slice(0, 10);
  const eligible = (candidate: T | null) =>
    candidate && candidate.weekStart >= from && candidate.weekStart <= currentWeekStart ? candidate : null;
  return eligible(personal) ?? eligible(field);
}
