type ProgramTimedFragment = {
  start: number;
  duration: number;
  programDateTime?: number | null;
};

export type LiveClipWindow = {
  startUtcMs: number;
  endUtcMs: number;
  durationSeconds: number;
};

export function liveElapsedSeconds(
  startUtcMs: number | null,
  playheadUtcMs: number | null,
  previousElapsedSeconds = 0,
): number | null {
  if (
    startUtcMs == null
    || playheadUtcMs == null
    || !Number.isFinite(startUtcMs)
    || !Number.isFinite(playheadUtcMs)
  ) {
    return null;
  }
  const previous = Number.isFinite(previousElapsedSeconds)
    ? Math.max(0, previousElapsedSeconds)
    : 0;
  return Math.max(previous, 0, (playheadUtcMs - startUtcMs) / 1000);
}

const ammanClockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Amman",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function liveProgramTimeAtPosition(
  position: number,
  fragments: readonly ProgramTimedFragment[],
): number | null {
  if (!Number.isFinite(position)) return null;
  let active: ProgramTimedFragment | undefined;
  for (const candidate of fragments) {
    if (
      candidate.duration > 0
      && position >= candidate.start
      && position <= candidate.start + candidate.duration
      && (!active || candidate.start > active.start)
    ) {
      active = candidate;
    }
  }
  if (
    active
    && typeof active.programDateTime === "number"
    && Number.isFinite(active.programDateTime)
  ) {
    return active.programDateTime + (position - active.start) * 1000;
  }
  return null;
}

export function createLiveClipWindow(
  startUtcMs: number | null,
  playheadUtcMs: number | null,
  maxDurationSeconds: number,
): LiveClipWindow | null {
  if (
    startUtcMs == null
    || playheadUtcMs == null
    || !Number.isFinite(startUtcMs)
    || !Number.isFinite(playheadUtcMs)
    || !Number.isFinite(maxDurationSeconds)
    || maxDurationSeconds <= 0
  ) {
    return null;
  }
  const durationSeconds = (playheadUtcMs - startUtcMs) / 1000;
  if (durationSeconds < 1 || durationSeconds > maxDurationSeconds) return null;
  return {
    startUtcMs,
    endUtcMs: playheadUtcMs,
    durationSeconds,
  };
}

export function formatAmmanClock(timestampMs: number | null): string {
  if (timestampMs == null || !Number.isFinite(timestampMs)) return "—";
  return ammanClockFormatter.format(new Date(timestampMs));
}