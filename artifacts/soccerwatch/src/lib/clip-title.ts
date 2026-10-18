import { formatDay } from "@/components/match/bits";

export type ClipTitleLabels = { today: string; tomorrow: string };

export function formatClipTitle(
  title: string,
  locale: "en" | "ar",
  now: number,
  labels: ClipTitleLabels,
): { dayLabel: string; time: string | null; pitch: string | null } {
  const date = title.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const time = title.match(/\b\d{2}:\d{2}\b/)?.[0];
  if (!date || !time) return { dayLabel: title, time: null, pitch: null };

  const dateMs = Date.parse(`${date}T${time}:00+03:00`);
  if (!Number.isFinite(dateMs)) return { dayLabel: title, time: null, pitch: null };

  const pitch = title
    .replace(date, " ")
    .replace(time, " ")
    .replace(/[_·]/g, " ")
    .trim();

  return {
    dayLabel: formatDay(dateMs, locale, now, labels),
    time,
    pitch: pitch || null,
  };
}
