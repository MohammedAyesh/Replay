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
  playingDateMs?: number | null,
): number | null {
  if (Number.isFinite(position)) {
    const fragment = fragments.find((candidate) =>
      typeof candidate.programDateTime === "number"
      && Number.isFinite(candidate.programDateTime)
      && candidate.duration > 0
      && position >= candidate.start
      && position <= candidate.start + candidate.duration,
    );
    if (fragment && typeof fragment.programDateTime === "number") {
      return fragment.programDateTime + (position - fragment.start) * 1000;
    }
  }
  return typeof playingDateMs === "number" && Number.isFinite(playingDateMs)
    ? playingDateMs
    : null;
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
  const endUtcMs = Math.min(playheadUtcMs, startUtcMs + maxDurationSeconds * 1000);
  if (endUtcMs <= startUtcMs) return null;
  return {
    startUtcMs,
    endUtcMs,
    durationSeconds: (endUtcMs - startUtcMs) / 1000,
  };
}

export function formatAmmanClock(timestampMs: number | null): string {
  if (timestampMs == null || !Number.isFinite(timestampMs)) return "—";
  return ammanClockFormatter.format(new Date(timestampMs));
}