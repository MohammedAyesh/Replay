export const EXPORT_PLAYBACK_MAX_RANGE_BYTES = 8 * 1024 * 1024;

export function boundedExportRange(range: string | undefined): string | undefined {
  if (!range) return range;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(range.trim());
  if (!match) return range;
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return range;
  const requestedEnd = match[2] ? Number(match[2]) : start + EXPORT_PLAYBACK_MAX_RANGE_BYTES - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return range;
  const end = Math.min(requestedEnd, start + EXPORT_PLAYBACK_MAX_RANGE_BYTES - 1);
  return `bytes=${start}-${end}`;
}
