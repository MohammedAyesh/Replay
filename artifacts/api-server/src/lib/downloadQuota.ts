/**
 * The free tier's download allowance.
 *
 * Five downloads per ROLLING thirty days, not per calendar month. The
 * distinction is the whole point of this module and it is a business decision,
 * not an implementation detail:
 *
 *   - A calendar month resets everyone at the same instant. That manufactures a
 *     stampede at 00:00 on the 1st — the two hours of the month when the render
 *     queue is least able to absorb it — and it teaches users to hoard clips
 *     until the reset rather than downloading them the evening of the match.
 *   - A rolling window resets each user on their own schedule, spreads the load
 *     flat, and gives a truthful answer to "when do I get another one?" — which
 *     is a specific date and time, not "the 1st".
 *
 * Everything here is pure. It takes the timestamps and returns the state; it
 * does not read the clock unless asked, does not touch the database, and has no
 * opinion about who is exempt.
 */

export const FREE_DOWNLOADS_PER_WINDOW = Math.max(
  1,
  parseInt(process.env.FREE_DOWNLOADS_PER_WINDOW ?? "5", 10) || 5,
);

export const QUOTA_WINDOW_DAYS = Math.max(
  1,
  parseInt(process.env.QUOTA_WINDOW_DAYS ?? "30", 10) || 30,
);

const DAY_MS = 86_400_000;

export interface DownloadEvent {
  /** When the download was counted. */
  at: Date;
  /**
   * Which clip it was. Re-downloading a clip already counted inside the window
   * is free — see `consumeQuota`.
   */
  clipId: number;
}

export interface QuotaState {
  used: number;
  limit: number;
  remaining: number;
  windowDays: number;
  /**
   * When the allowance next increases by one: the oldest counted download plus
   * the window. Null when nothing has been used, because then there is nothing
   * to reset.
   *
   * This is deliberately the NEXT slot to free, not the last — a user at 5/5
   * wants to know when they can download again, and that is governed by their
   * oldest download, not their newest.
   */
  resetAt: Date | null;
  /** True when a further download would be allowed. */
  allowed: boolean;
  /** Set when the account is not subject to the limit at all. */
  unlimited: boolean;
}

export interface QuotaOptions {
  limit?: number;
  windowDays?: number;
  unlimited?: boolean;
}

/** Events inside the rolling window, oldest first. */
export function eventsInWindow(
  events: readonly DownloadEvent[],
  now: Date,
  windowDays: number = QUOTA_WINDOW_DAYS,
): DownloadEvent[] {
  const cutoff = now.getTime() - windowDays * DAY_MS;
  return events
    .filter((e) => e.at.getTime() > cutoff)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function evaluateQuota(
  events: readonly DownloadEvent[],
  now: Date,
  options: QuotaOptions = {},
): QuotaState {
  const limit = options.limit ?? FREE_DOWNLOADS_PER_WINDOW;
  const windowDays = options.windowDays ?? QUOTA_WINDOW_DAYS;
  const unlimited = options.unlimited ?? false;

  const inWindow = eventsInWindow(events, now, windowDays);
  const used = inWindow.length;
  const oldest = inWindow[0];

  return {
    used,
    limit,
    remaining: unlimited ? Number.POSITIVE_INFINITY : Math.max(0, limit - used),
    windowDays,
    resetAt: oldest ? new Date(oldest.at.getTime() + windowDays * DAY_MS) : null,
    allowed: unlimited || used < limit,
    unlimited,
  };
}

export interface ConsumeResult {
  /** State AFTER the download, whether or not it was counted. */
  state: QuotaState;
  /** Should the caller write a new row? False for a repeat or an exempt account. */
  shouldRecord: boolean;
  /** The download may proceed. */
  allowed: boolean;
  /** This clip was already counted inside the window, so it costs nothing. */
  repeat: boolean;
  /**
   * This download is what took the account to its limit. Emit the analytics
   * event exactly here and nowhere else — see LIMIT_REACHED_EVENT.
   */
  limitReachedNow: boolean;
}

/**
 * Decide what a download attempt costs.
 *
 * A clip already counted inside the window is free to fetch again. Without that,
 * a dropped connection, an iOS Share-sheet retry or a second tap costs a slot,
 * and a five-download allowance becomes a three-download allowance for anybody
 * on a bad connection at a floodlit pitch. The allowance is meant to meter
 * distinct clips, not HTTP requests.
 */
export function consumeQuota(
  events: readonly DownloadEvent[],
  clipId: number,
  now: Date,
  options: QuotaOptions = {},
): ConsumeResult {
  const before = evaluateQuota(events, now, options);
  const windowDays = before.windowDays;

  if (before.unlimited) {
    return { state: before, shouldRecord: false, allowed: true, repeat: false, limitReachedNow: false };
  }

  const repeat = eventsInWindow(events, now, windowDays).some((e) => e.clipId === clipId);
  if (repeat) {
    return { state: before, shouldRecord: false, allowed: true, repeat: true, limitReachedNow: false };
  }

  if (!before.allowed) {
    return { state: before, shouldRecord: false, allowed: false, repeat: false, limitReachedNow: false };
  }

  const after = evaluateQuota([...events, { at: now, clipId }], now, options);
  return {
    state: after,
    shouldRecord: true,
    allowed: true,
    repeat: false,
    limitReachedNow: after.remaining === 0 && before.remaining > 0,
  };
}

/**
 * The analytics event for an account that has just used its last download.
 *
 * The reason this is instrumented at all: that population is the highest-intent
 * prospect set in the product — people who wanted a sixth clip badly enough to
 * ask for it — and the hit-limit-to-conversion rate is the only clean read on
 * whether five is the right number. If almost everyone who hits five converts,
 * five is too generous; if almost nobody does, the limit is annoying users
 * without selling anything.
 */
export const LIMIT_REACHED_EVENT = "download_quota_limit_reached";

export interface LimitReachedEvent {
  event: typeof LIMIT_REACHED_EVENT;
  userId: number;
  clipId: number;
  limit: number;
  windowDays: number;
  at: string;
  /** When they can download again — the length of the wall they just hit. */
  resetAt: string | null;
}

export function buildLimitReachedEvent(
  userId: number,
  clipId: number,
  state: QuotaState,
  now: Date,
): LimitReachedEvent {
  return {
    event: LIMIT_REACHED_EVENT,
    userId,
    clipId,
    limit: state.limit,
    windowDays: state.windowDays,
    at: now.toISOString(),
    resetAt: state.resetAt ? state.resetAt.toISOString() : null,
  };
}

/** The shape the API hands the client, ready to render. */
export interface QuotaResponse {
  used: number;
  limit: number;
  remaining: number;
  windowDays: number;
  resetAt: string | null;
  unlimited: boolean;
}

export function toQuotaResponse(state: QuotaState): QuotaResponse {
  return {
    used: state.used,
    limit: state.limit,
    remaining: state.unlimited ? -1 : state.remaining,
    windowDays: state.windowDays,
    resetAt: state.resetAt ? state.resetAt.toISOString() : null,
    unlimited: state.unlimited,
  };
}
