import { ammanInputToUtcIso } from "@/lib/academy-session-time";

export type DetectedGame = {
  key: string;
  index: number;
  startSeconds: number;
  endSeconds: number;
  spans: Array<[number, number]>;
  playedSeconds: number;
  players?: number;
};

export type ClaimWindow = [number, number];

type BookingWindow = {
  code: string;
  startSeconds: number;
  endSeconds: number;
  rostered?: boolean;
  games?: Array<{ startSeconds: number; endSeconds: number }>;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Read the bounded session windows carried inside manifest.provenance.phases. */
export function detectedGamesFromProvenance(
  provenance: unknown,
  duration: number,
): DetectedGame[] {
  if (!provenance || typeof provenance !== "object") return [];
  const phases = (provenance as Record<string, unknown>).phases;
  if (!phases || typeof phases !== "object") return [];
  const sessions = (phases as Record<string, unknown>).sessions;
  if (!Array.isArray(sessions)) return [];

  return sessions.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const raw = value as Record<string, unknown>;
    if (!finite(raw.start) || !finite(raw.end)) return [];
    const startSeconds = Math.max(0, raw.start);
    const endSeconds = Math.min(duration, raw.end);
    if (!(endSeconds > startSeconds)) return [];

    const spans = (Array.isArray(raw.spans) ? raw.spans : []).flatMap((span): ClaimWindow[] => {
      if (!Array.isArray(span) || !finite(span[0]) || !finite(span[1])) return [];
      const start = Math.max(startSeconds, span[0]);
      const end = Math.min(endSeconds, span[1]);
      return end > start ? [[start, end]] : [];
    });
    const players = finite(raw.players) && raw.players >= 0 ? Math.round(raw.players) : undefined;
    return [{
      key: `${startSeconds}:${endSeconds}`,
      index: index + 1,
      startSeconds,
      endSeconds,
      spans,
      playedSeconds: spans.reduce((sum, [start, end]) => sum + end - start, 0),
      ...(players === undefined ? {} : { players }),
    }];
  });
}

/** The requested default: second session at >= half; otherwise first; 3+ choose longest. */
export function defaultDetectedGame(games: DetectedGame[]): DetectedGame | null {
  if (games.length < 2) return null;
  if (games.length === 2) {
    const total = games[0].playedSeconds + games[1].playedSeconds;
    return games[1].playedSeconds >= total / 2 ? games[1] : games[0];
  }
  return games.reduce((best, game) => game.playedSeconds > best.playedSeconds ? game : best);
}

function windowsForBooking(match: BookingWindow): ClaimWindow[] {
  const values = match.games?.length
    ? match.games.map((game) => [game.startSeconds, game.endSeconds] as ClaimWindow)
    : [[match.startSeconds, match.endSeconds] as ClaimWindow];
  return values.filter(([start, end]) => finite(start) && finite(end) && end > start);
}

function overlap(a: ClaimWindow, b: ClaimWindow): ClaimWindow | null {
  const start = Math.max(a[0], b[0]);
  const end = Math.min(a[1], b[1]);
  return end > start ? [start, end] : null;
}

/** Booking codes whose actual booking/game windows overlap a detected game. */
export function bookingsForDetectedGame(
  matches: BookingWindow[],
  game: DetectedGame,
): string[] {
  const playedRanges = game.spans.length
    ? game.spans
    : [[game.startSeconds, game.endSeconds] as ClaimWindow];
  const ranked = matches.map((match, index) => ({
    match,
    index,
    overlapSeconds: windowsForBooking(match).reduce((sum, booking) =>
      sum + playedRanges.reduce((played, span) => {
        const clipped = overlap(booking, span);
        return played + (clipped ? clipped[1] - clipped[0] : 0);
      }, 0), 0),
  })).filter(({ overlapSeconds }) => overlapSeconds > 0)
    .sort((a, b) =>
      b.overlapSeconds - a.overlapSeconds
      || Number(Boolean(b.match.rostered)) - Number(Boolean(a.match.rostered))
      || a.index - b.index);
  return ranked[0] ? [ranked[0].match.code] : [];
}

/** Compute booking/session intersections; session choice replaces a duplicate bookings question. */
export function claimWindowsForSelection(
  matches: BookingWindow[],
  selectedCodes: string[],
  matchWindow: ClaimWindow | null,
  detectedGame: DetectedGame | null,
): ClaimWindow[] {
  const selected = matches.filter((match) => selectedCodes.includes(match.code));
  const bookingWindows = selected.flatMap(windowsForBooking);
  if (detectedGame && selectedCodes.length > 0 && (!selected.length || !bookingWindows.length)) return [];
  const baseWindows = bookingWindows.length
    ? bookingWindows
    : matchWindow
      ? [matchWindow]
      : [];

  if (!detectedGame) return baseWindows;
  const session: ClaimWindow = [detectedGame.startSeconds, detectedGame.endSeconds];
  const scoped = baseWindows.length
    ? baseWindows.flatMap((window) => {
      const clipped = overlap(window, session);
      return clipped ? [clipped] : [];
    })
    : [session];
  return scoped;
}

/** Format tracking offsets as wall-clock times in Amman, including midnight rollover. */
export function detectedGameTimeRange(
  game: DetectedGame,
  date: string | null | undefined,
  timeSlot: string | null | undefined,
  videoStartSeconds: number,
  locale: string,
): string {
  const clock = /^(\d{1,2}):(\d{2})/.exec(timeSlot ?? "");
  const startIso = date && clock
    ? ammanInputToUtcIso(`${date}T${String(Number(clock[1])).padStart(2, "0")}:${clock[2]}`)
    : null;
  if (startIso) {
    const base = Date.parse(startIso) + Math.max(0, videoStartSeconds) * 1000;
    const at = (seconds: number) => new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
      timeZone: "Asia/Amman",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(base + seconds * 1000));
    return `${at(game.startSeconds)}–${at(game.endSeconds)}`;
  }

  const at = (seconds: number) => {
    const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
    return `${String(Math.floor(totalMinutes / 60) % 24).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
  };
  return `${at(game.startSeconds)}–${at(game.endSeconds)}`;
}

/** Coverage of claimed frame ranges inside one selected tracking-time window. */
export function claimCoverageForWindow(
  parts: Array<{ fromFrame: number; toFrame: number }>,
  frameRate: number,
  selectedWindows: ClaimWindow | ClaimWindow[],
  offPitch: Array<{ fromSeconds: number; toSeconds: number }> = [],
): number {
  const fps = frameRate > 0 ? frameRate : 20;
  if (selectedWindows.length === 0) return 0;
  const windows = (Array.isArray(selectedWindows[0]) ? selectedWindows : [selectedWindows]) as ClaimWindow[];
  const mergedWindows: ClaimWindow[] = [];
  for (const [start, end] of windows.slice().sort((a, b) => a[0] - b[0])) {
    const last = mergedWindows.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else mergedWindows.push([start, end]);
  }
  const clipped = parts
    .flatMap(({ fromFrame, toFrame }) => mergedWindows.flatMap((window) => {
      const start = Math.max(window[0], fromFrame / fps);
      const end = Math.min(window[1], (toFrame + 1) / fps);
      return end > start ? [[start, end] as ClaimWindow] : [];
    }))
    .sort((a, b) => a[0] - b[0]);
  const merged: ClaimWindow[] = [];
  for (const range of clipped) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const excluded = offPitch
    .flatMap(({ fromSeconds, toSeconds }) => mergedWindows.flatMap((window) => {
      const clipped = overlap([fromSeconds, toSeconds], window);
      return clipped ? [clipped] : [];
    }))
    .sort((a, b) => a[0] - b[0]);
  const mergedExcluded: ClaimWindow[] = [];
  for (const range of excluded) {
    const last = mergedExcluded.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else mergedExcluded.push([...range]);
  }
  const removedSeconds = (range: ClaimWindow) => mergedExcluded.reduce(
    (sum, excludedRange) => sum + Math.max(0, Math.min(range[1], excludedRange[1]) - Math.max(range[0], excludedRange[0])),
    0,
  );
  const claimed = merged.reduce((sum, range) => sum + Math.max(0, range[1] - range[0] - removedSeconds(range)), 0);
  const windowSeconds = mergedWindows.reduce((sum, [a, b]) => sum + b - a, 0);
  const denominator = Math.max(0, windowSeconds - mergedExcluded.reduce((sum, [a, b]) => sum + b - a, 0));
  return denominator > 0 ? Math.min(100, Math.round(claimed * 10_000 / denominator) / 100) : 0;
}
