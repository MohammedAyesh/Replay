import { statSync } from "fs";
import { logger } from "./logger";

/**
 * The render queue.
 *
 * Renders are CPU-intensive, and demand arrives in a spike in the two hours
 * after full time. The archive may run on another host, so its activity is only
 * considered when a fresh heartbeat is available.
 *
 * Two rules follow, and this module exists to hold them:
 *
 *   1. Never more than MAX_CONCURRENT_RENDERS renders at once.
 *   2. Renders can yield while a configured archive heartbeat is fresh.
 *
 * WHY THIS REPLACED THE INLINE VERSION IN routes/userClips.ts
 *
 * The version it replaces was:
 *
 *     if (activeRenders >= MAX) await new Promise(r => renderQueue.push(r));
 *     activeRenders++;
 *     try { return await job(); }
 *     finally { activeRenders--; renderQueue.shift()?.(); }
 *
 * That code holds the cap and admits in FIFO order — I went looking for an
 * over-admission window between `activeRenders--` and the woken waiter's
 * `activeRenders++`, wrote a test to exercise it, and the test says there is
 * none: the handover is a microtask and every arrival path here is a macrotask,
 * so nothing can interleave. It is replaced for what it does not do, not for a
 * bug: no queue position to show a waiting user, no way to yield to the archive,
 * and no way to see the queue's state from outside the closure.
 *
 * The property that has to survive the rewrite is that the capacity check and
 * the slot claim are one synchronous step. `acquire` now awaits the archive
 * probe first, which puts a real await in front of the check, so two jobs can
 * arrive at the check interleaved — and that is safe only because
 * `if (active.size < concurrency) { active.add(key); return; }` cannot be
 * suspended part-way. `release` obeys the same rule from the other side: it
 * moves the slot to the head of the FIFO in the same synchronous step that gives
 * it up, so a free slot is never observable by an arriving job while it is
 * already spoken for. `renderQueue.test.ts` pins this with a randomized
 * interleaving stress test rather than trusting the reasoning.
 */

export interface RenderQueueOptions {
  concurrency?: number;
  /**
   * Resolves true while the archive pipeline is working. Checked before a slot
   * is granted, never while one is held — a job that already owns a slot runs to
   * completion rather than stalling half-encoded.
   */
  isArchiveBusy?: () => Promise<boolean>;
  /** Re-check interval while yielding. */
  yieldPollMs?: number;
  /**
   * Ceiling on how long one job will yield before running anyway.
   *
   * Not a nicety: the archive runs every 10 minutes and an hour of 4K takes a
   * large fraction of that, so "busy" is a common steady state rather than a
   * blip. Without a ceiling a busy evening means no user ever gets a download.
   * Yielding is a courtesy with a deadline.
   */
  maxYieldMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Live, admin-configurable values, resolved once per job at admission.
   *
   * Read per job rather than captured at construction because these are exactly
   * the knobs someone reaches for while something is going wrong — an evening
   * where renders are starving the archive, or one where the queue has stalled
   * and needs more slots. A value you have to restart the process to change is
   * not much use at that moment.
   *
   * Omitted entirely, the constructor values stand, which is what keeps this
   * testable without a database.
   */
  liveConfig?: () => Promise<{
    concurrency?: number;
    yieldToArchive?: boolean;
    yieldCeilingMs?: number;
  }>;
}

export interface RenderQueueSnapshot {
  active: number;
  waiting: number;
  concurrency: number;
  /** Jobs holding a slot, or waiting for one, in admission order. */
  order: string[];
  yielding: number;
}

export type ImmediateRenderResult<T> =
  | { started: true; snapshot: RenderQueueSnapshot; completion: Promise<T> }
  | { started: false; snapshot: RenderQueueSnapshot };

interface Waiter {
  key: string;
  admit: () => void;
}

export const DEFAULT_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_RENDERS ?? "2", 10) || 2,
);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RenderQueue {
  readonly concurrency: number;
  private active = new Set<string>();
  private waiters: Waiter[] = [];
  private yielding = new Set<string>();
  private readonly isArchiveBusy: () => Promise<boolean>;
  private readonly yieldPollMs: number;
  private readonly maxYieldMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private liveConfig?: RenderQueueOptions["liveConfig"];

  constructor(options: RenderQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.isArchiveBusy = options.isArchiveBusy ?? (async () => false);
    this.yieldPollMs = options.yieldPollMs ?? 15_000;
    this.maxYieldMs = options.maxYieldMs ?? 10 * 60_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.liveConfig = options.liveConfig;
  }

  /**
   * The configuration in force for the job about to be admitted.
   *
   * A failing lookup falls back to the constructor values rather than blocking:
   * an unreadable settings table must not stop renders, for the same reason the
   * archive probe fails open.
   */
  private async currentConfig(): Promise<{ concurrency: number; yieldToArchive: boolean; yieldCeilingMs: number }> {
    const fallback = {
      concurrency: this.concurrency,
      yieldToArchive: true,
      yieldCeilingMs: this.maxYieldMs,
    };
    if (!this.liveConfig) return fallback;
    try {
      const live = await this.liveConfig();
      return {
        concurrency: Math.max(1, Math.floor(live.concurrency ?? fallback.concurrency)),
        yieldToArchive: live.yieldToArchive ?? true,
        yieldCeilingMs: Math.max(0, live.yieldCeilingMs ?? fallback.yieldCeilingMs),
      };
    } catch (err) {
      logger.warn({ err }, "Could not read live render settings — using the configured values");
      return fallback;
    }
  }

  /**
   * Position of a job, for display: 0 while it is rendering, 1..n while it is
   * waiting, null if this process has never heard of it. A restarted process
   * legitimately returns null for a job it is no longer running — the caller
   * should treat that as "unknown", not as "finished".
   */
  positionOf(key: string): number | null {
    if (this.active.has(key)) return 0;
    const idx = this.waiters.findIndex((w) => w.key === key);
    return idx === -1 ? null : idx + 1;
  }

  snapshot(): RenderQueueSnapshot {
    return {
      active: this.active.size,
      waiting: this.waiters.length,
      concurrency: this.concurrency,
      order: [...this.active, ...this.waiters.map((w) => w.key)],
      yielding: this.yielding.size,
    };
  }

  /**
   * Run `job` under a slot. Resolves or rejects with the job's own result; a
   * throwing job still releases its slot.
   */
  async run<T>(key: string, job: () => Promise<T>): Promise<T> {
    await this.acquire(key);
    try {
      return await job();
    } finally {
      this.release(key);
    }
  }

  /**
   * Reserve a local slot only when this job would not have to wait.
   *
   * Yielding jobs count as waiting even though they have not reached the FIFO
   * yet. Callers can hand overflow to another renderer instead of adding it
   * behind local work.
   */
  async tryRunImmediately<T>(
    key: string,
    job: () => Promise<T>,
  ): Promise<ImmediateRenderResult<T>> {
    const config = await this.currentConfig();
    const snapshot = { ...this.snapshot(), concurrency: config.concurrency };
    if (
      snapshot.active >= config.concurrency ||
      snapshot.waiting > 0 ||
      snapshot.yielding > 0
    ) {
      return { started: false, snapshot };
    }
    // Claim the slot before probing the archive. The probe is async; leaving
    // the slot unclaimed until it resolves lets concurrent admissions all see
    // the same free capacity and exceed the concurrency limit.
    this.active.add(key);
    if (config.yieldToArchive) {
      try {
        if (await this.isArchiveBusy()) {
          this.release(key);
          return { started: false, snapshot };
        }
      } catch (err) {
        logger.warn({ err, key }, "Archive-busy probe failed during immediate admission; not yielding");
      }
    }

    const completion = (async () => {
      try {
        return await job();
      } finally {
        this.release(key);
      }
    })();
    return { started: true, snapshot: this.snapshot(), completion };
  }

  private async acquire(key: string): Promise<void> {
    const config = await this.currentConfig();

    // Yield to the archive BEFORE queuing, so a job that is waiting on the
    // archive is not also occupying a place in front of jobs that could run.
    if (config.yieldToArchive) await this.yieldToArchive(key, config.yieldCeilingMs);

    if (this.active.size < config.concurrency && this.waiters.length === 0) {
      this.active.add(key);
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ key, admit: resolve });
    });
    // The releaser added us to `active` before resolving. Nothing to do here,
    // and deliberately nothing to increment — see the header comment.
  }

  private release(key: string): void {
    this.active.delete(key);
    // Hand on using the cap the departing job ran under. Re-resolving here would
    // need an await, which would reopen the window the synchronous handover
    // exists to close; a lowered cap therefore takes effect on the next
    // admission rather than retroactively, which is the honest behaviour anyway.
    const next = this.waiters.shift();
    if (!next) return;
    // Hand the slot over inside the same synchronous step that gave it up, so
    // no arriving job can observe a free slot that is already spoken for.
    this.active.add(next.key);
    next.admit();
  }

  private async yieldToArchive(key: string, ceilingMs = this.maxYieldMs): Promise<void> {
    let busy: boolean;
    try {
      busy = await this.isArchiveBusy();
    } catch (err) {
      // A probe that cannot answer must not block renders.
      logger.warn({ err, key }, "Archive-busy probe failed; not yielding");
      return;
    }
    if (!busy) return;

    const startedAt = this.now();
    this.yielding.add(key);
    logger.info({ key }, "Archive pipeline is busy — render yielding");
    try {
      while (this.now() - startedAt < ceilingMs) {
        await this.sleep(this.yieldPollMs);
        let stillBusy: boolean;
        try {
          stillBusy = await this.isArchiveBusy();
        } catch {
          return;
        }
        if (!stillBusy) {
          logger.info({ key, yieldedMs: this.now() - startedAt }, "Archive idle — render resuming");
          return;
        }
      }
      logger.warn(
        { key, maxYieldMs: ceilingMs },
        "Archive still busy at the yield ceiling — running the render anyway",
      );
    } finally {
      this.yielding.delete(key);
    }
  }
}

/**
 * Is the hourly archive working right now?
 *
 * A heartbeat file touched by the archive host. A file touched within
 * ARCHIVE_BUSY_FILE_TTL_S means an hour is being built. Local load average is
 * not a valid substitute when this API and the archive run on different hosts.
 * Without a fresh heartbeat the probe says "not busy".
 */
export function makeArchiveBusyProbe(deps?: {
  mtimeMs?: (path: string) => number | null;
  now?: () => number;
}): () => Promise<boolean> {
  const mtimeMs =
    deps?.mtimeMs ??
    ((p: string) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return null;
      }
    });
  const now = deps?.now ?? Date.now;

  const busyFile = process.env.ARCHIVE_BUSY_FILE ?? "";
  const busyTtlMs = (parseInt(process.env.ARCHIVE_BUSY_FILE_TTL_S ?? "300", 10) || 300) * 1000;

  return async () => {
    if (!busyFile) return false;
    const m = mtimeMs(busyFile);
    return m !== null && now() - m < busyTtlMs;
  };
}

/**
 * The process-wide queue. Constructed once; `run` is the only entry point.
 *
 * `liveConfig` is injected rather than imported at the top of this file so the
 * queue keeps no database dependency and stays unit-testable — routes/userClips
 * supplies it at startup via `useLiveRenderSettings`.
 */
export const renderQueue = new RenderQueue({
  concurrency: DEFAULT_CONCURRENCY,
  isArchiveBusy: makeArchiveBusyProbe(),
});

/**
 * Point the process-wide queue at the admin settings.
 *
 * Separate from construction so this module never imports the database layer.
 * Called once at wiring time; calling it again replaces the source.
 */
export function useLiveRenderSettings(
  liveConfig: NonNullable<RenderQueueOptions["liveConfig"]>,
): void {
  (renderQueue as unknown as { liveConfig?: RenderQueueOptions["liveConfig"] }).liveConfig = liveConfig;
}
