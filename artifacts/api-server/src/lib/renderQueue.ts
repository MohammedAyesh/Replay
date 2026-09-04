import os from "os";
import { statSync } from "fs";
import { logger } from "./logger";

/**
 * The render queue.
 *
 * Renders are the heaviest thing this process does: a CRF-16 pass over a
 * three-minute clip costs roughly five CPU-minutes, about 0.6x realtime. Demand
 * is not spread out — it arrives in a spike in the two hours after full time,
 * which is exactly the window in which `process-all.sh` is assembling the hour
 * that just finished. Both workloads want every core on a 6-vCPU box.
 *
 * Two rules follow, and this module exists to hold them:
 *
 *   1. Never more than MAX_CONCURRENT_RENDERS renders at once.
 *   2. Renders yield to the archive. A late render is an annoyed user; a late
 *      archive is a match hour that cannot be re-recorded.
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
}

export interface RenderQueueSnapshot {
  active: number;
  waiting: number;
  concurrency: number;
  /** Jobs holding a slot, or waiting for one, in admission order. */
  order: string[];
  yielding: number;
}

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

  constructor(options: RenderQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.isArchiveBusy = options.isArchiveBusy ?? (async () => false);
    this.yieldPollMs = options.yieldPollMs ?? 15_000;
    this.maxYieldMs = options.maxYieldMs ?? 10 * 60_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
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

  private async acquire(key: string): Promise<void> {
    // Yield to the archive BEFORE queuing, so a job that is waiting on the
    // archive is not also occupying a place in front of jobs that could run.
    await this.yieldToArchive(key);

    if (this.active.size < this.concurrency && this.waiters.length === 0) {
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
    const next = this.waiters.shift();
    if (!next) return;
    // Hand the slot over inside the same synchronous step that gave it up, so
    // no arriving job can observe a free slot that is already spoken for.
    this.active.add(next.key);
    next.admit();
  }

  private async yieldToArchive(key: string): Promise<void> {
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
      while (this.now() - startedAt < this.maxYieldMs) {
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
        { key, maxYieldMs: this.maxYieldMs },
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
 * Two signals, checked in order, because neither is sufficient alone:
 *
 *  1. A heartbeat file. `process.sh` can `touch $ARCHIVE_BUSY_FILE` at the top of
 *     each assembly pass; a file touched within ARCHIVE_BUSY_FILE_TTL_S means an
 *     hour is being built right now. This is exact, and it is the signal to
 *     prefer — but it only exists if the API server shares a filesystem with the
 *     archive, and it will not exist at all when the two run on different hosts.
 *  2. Load average. Host-agnostic, needs no cooperation from the archive, and
 *     catches every other reason the box is saturated. It is a proxy, not a
 *     diagnosis, which is why it is second.
 *
 * With neither configured nor tripped the probe says "not busy", so this is
 * inert on a host that has no archive — which is the correct behaviour for the
 * Replit preview environment.
 */
export function makeArchiveBusyProbe(deps?: {
  mtimeMs?: (path: string) => number | null;
  loadavg?: () => number[];
  cpuCount?: () => number;
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
  const loadavg = deps?.loadavg ?? (() => os.loadavg());
  const cpuCount = deps?.cpuCount ?? (() => os.cpus().length || 1);
  const now = deps?.now ?? Date.now;

  const busyFile = process.env.ARCHIVE_BUSY_FILE ?? "";
  const busyTtlMs = (parseInt(process.env.ARCHIVE_BUSY_FILE_TTL_S ?? "300", 10) || 300) * 1000;
  const loadRatio = Number.parseFloat(process.env.RENDER_YIELD_LOAD_RATIO ?? "0.85") || 0.85;

  return async () => {
    if (busyFile) {
      const m = mtimeMs(busyFile);
      if (m !== null && now() - m < busyTtlMs) return true;
    }
    const cores = Math.max(1, cpuCount());
    const oneMinute = loadavg()[0] ?? 0;
    return oneMinute / cores >= loadRatio;
  };
}

/** The process-wide queue. Constructed once; `run` is the only entry point. */
export const renderQueue = new RenderQueue({
  concurrency: DEFAULT_CONCURRENCY,
  isArchiveBusy: makeArchiveBusyProbe(),
});
