/**
 * The kick-off field in the analysis tab.
 *
 * An operator types what they read off a clock, and there is no format that is
 * obviously right - "18:30", "1:18:30" and "1080" all mean something sensible.
 * So all three are accepted and anything else is refused outright, because the
 * cost of guessing is not a visible error: a wrong offset draws every tracking
 * box against footage from another part of the match, hours later, and looks
 * like the tracking is broken rather than the number.
 */

/** Seconds, or null when the input is not something we should guess at. */
export function parseStartTime(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return 0;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d+$/.test(part.trim()))) return null;
  const numbers = parts.map((part) => Number(part));
  if (parts.length === 2) {
    if (numbers[1] >= 60) return null;
    return numbers[0] * 60 + numbers[1];
  }
  if (numbers[1] >= 60 || numbers[2] >= 60) return null;
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}

export function formatStartTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}
