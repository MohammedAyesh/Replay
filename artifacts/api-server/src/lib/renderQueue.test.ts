import { describe, it, expect, vi } from "vitest";
import { RenderQueue, makeArchiveBusyProbe } from "./renderQueue";

/** A promise plus the handles to settle it, so tests can order events exactly. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("the cap invariant", () => {
  /**
   * A verbatim copy of the queue that lived in routes/userClips.ts. It is here
   * as the control: the claim in renderQueue.ts is that the old code was correct
   * on concurrency, and this is what backs that claim rather than a comment.
   */
  function makeLegacyQueue(max: number) {
    let activeRenders = 0;
    const renderQueue: (() => void)[] = [];
    let peak = 0;
    async function withRenderSlot<T>(job: () => Promise<T>): Promise<T> {
      if (activeRenders >= max) {
        await new Promise<void>((resolve) => renderQueue.push(resolve));
      }
      activeRenders++;
      peak = Math.max(peak, activeRenders);
      try {
        return await job();
      } finally {
        activeRenders--;
        renderQueue.shift()?.();
      }
    }
    return { withRenderSlot, peak: () => peak };
  }

  /**
   * Arrivals and completions at randomized microtask/macrotask depths — the
   * shape a real evening has, where /export calls land while renders are
   * finishing. Both queues are driven through the identical schedule.
   */
  async function stress(
    submit: (key: string, job: () => Promise<void>) => Promise<unknown>,
    observe: () => number,
  ): Promise<number> {
    let live = 0;
    let peak = 0;
    const jobs: Promise<unknown>[] = [];
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let i = 0; i < 60; i++) {
      const depth = Math.floor(rand() * 4);
      for (let d = 0; d < depth; d++) await Promise.resolve();
      if (rand() < 0.35) await new Promise((r) => setTimeout(r, 0));
      jobs.push(
        submit(`clip-${i}`, async () => {
          live++;
          peak = Math.max(peak, live, observe());
          const hops = Math.floor(rand() * 5);
          for (let d = 0; d < hops; d++) await Promise.resolve();
          if (rand() < 0.5) await new Promise((r) => setTimeout(r, 0));
          live--;
        }),
      );
    }
    await Promise.all(jobs);
    expect(live).toBe(0);
    return peak;
  }

  it("the old inline queue never exceeded the cap either — it was replaced for what it lacked", async () => {
    const legacy = makeLegacyQueue(2);
    const peak = await stress((_k, job) => legacy.withRenderSlot(job), () => legacy.peak());
    expect(peak).toBe(2);
  });

  it("RenderQueue holds the cap across 60 randomized interleavings", async () => {
    const q = new RenderQueue({ concurrency: 2 });
    const peak = await stress((k, job) => q.run(k, job), () => q.snapshot().active);
    expect(peak).toBe(2);
    expect(q.snapshot()).toMatchObject({ active: 0, waiting: 0 });
  });

  it("holds the cap even though acquire awaits the archive probe first", async () => {
    // The probe puts a real await in front of the capacity check, so arrivals
    // can interleave at that point. Only the synchronous check-and-claim makes
    // that safe.
    const q = new RenderQueue({ concurrency: 3, isArchiveBusy: async () => false });
    const peak = await stress((k, job) => q.run(k, job), () => q.snapshot().active);
    expect(peak).toBe(3);
  });
});

describe("queue position", () => {
  it("reports 0 while rendering, 1..n while waiting, null when unknown", async () => {
    const q = new RenderQueue({ concurrency: 2 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const run = (i: number) => q.run(`clip-${i}`, () => gates[i]!.promise);

    const a = run(0), b = run(1), c = run(2), d = run(3);
    await tick();

    expect(q.positionOf("clip-0")).toBe(0);
    expect(q.positionOf("clip-1")).toBe(0);
    expect(q.positionOf("clip-2")).toBe(1);
    expect(q.positionOf("clip-3")).toBe(2);
    expect(q.positionOf("clip-99")).toBeNull();
    expect(q.snapshot()).toMatchObject({ active: 2, waiting: 2, concurrency: 2 });

    gates[0]!.resolve();
    await a;
    await tick();

    // Everyone behind the finished job moves up exactly one place.
    expect(q.positionOf("clip-2")).toBe(0);
    expect(q.positionOf("clip-3")).toBe(1);

    gates[1]!.resolve(); gates[2]!.resolve(); gates[3]!.resolve();
    await Promise.all([b, c, d]);
    expect(q.snapshot()).toMatchObject({ active: 0, waiting: 0 });
  });

  it("admits strictly FIFO", async () => {
    const q = new RenderQueue({ concurrency: 1 });
    const started: string[] = [];
    const gate = deferred();
    const first = q.run("a", async () => { started.push("a"); await gate.promise; });
    await tick();
    const rest = ["b", "c", "d"].map((k) =>
      q.run(k, async () => { started.push(k); }),
    );
    await tick();
    gate.resolve();
    await first;
    await Promise.all(rest);
    expect(started).toEqual(["a", "b", "c", "d"]);
  });

  it("releases the slot when a job throws", async () => {
    const q = new RenderQueue({ concurrency: 1 });
    await expect(q.run("boom", async () => { throw new Error("render failed"); }))
      .rejects.toThrow("render failed");
    expect(q.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    await expect(q.run("ok", async () => "done")).resolves.toBe("done");
  });
});

describe("yielding to the archive", () => {
  it("waits while the archive is busy and starts once it goes idle", async () => {
    let busy = true;
    const sleeps: number[] = [];
    // Each sleep parks on a gate the test opens by hand, so the yielding state
    // is observable instead of racing past.
    let gate = deferred();
    const q = new RenderQueue({
      concurrency: 2,
      isArchiveBusy: async () => busy,
      yieldPollMs: 15_000,
      sleep: async (ms) => { sleeps.push(ms); await gate.promise; gate = deferred(); },
    });

    let ran = false;
    const p = q.run("clip-1", async () => { ran = true; });
    await tick();

    expect(ran).toBe(false);
    expect(q.snapshot()).toMatchObject({ active: 0, waiting: 0, yielding: 1 });
    expect(sleeps).toEqual([15_000]);

    const g1 = gate; g1.resolve();        // one poll elapses, archive still busy
    await tick();
    expect(ran).toBe(false);
    expect(sleeps).toEqual([15_000, 15_000]);

    busy = false;
    const g2 = gate; g2.resolve();        // next poll finds it idle
    await p;
    expect(ran).toBe(true);
    expect(q.snapshot().yielding).toBe(0);
  });

  it("runs anyway once the yield ceiling is reached, rather than starving forever", async () => {
    let clock = 0;
    const q = new RenderQueue({
      concurrency: 1,
      isArchiveBusy: async () => true,          // never goes idle
      yieldPollMs: 60_000,
      maxYieldMs: 5 * 60_000,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    await expect(q.run("clip-1", async () => "rendered")).resolves.toBe("rendered");
    expect(clock).toBe(5 * 60_000);
  });

  it("does not yield when the probe throws", async () => {
    const q = new RenderQueue({
      concurrency: 1,
      isArchiveBusy: async () => { throw new Error("no such file"); },
      sleep: async () => { throw new Error("must not sleep"); },
    });
    await expect(q.run("clip-1", async () => "rendered")).resolves.toBe("rendered");
  });

  it("a job already holding a slot is never interrupted by the archive", async () => {
    let busy = false;
    const gate = deferred();
    const q = new RenderQueue({
      concurrency: 1,
      isArchiveBusy: async () => busy,
      sleep: async () => { busy = false; },
    });
    const p = q.run("long", async () => { await gate.promise; return "finished"; });
    await tick();
    busy = true;              // archive starts mid-render
    gate.resolve();
    await expect(p).resolves.toBe("finished");
  });
});

describe("makeArchiveBusyProbe", () => {
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try { await fn(); } finally { process.env = saved; }
  };

  it("is busy while the heartbeat file is fresh and idle once it is stale", async () => {
    await withEnv({ ARCHIVE_BUSY_FILE: "/opt/reocom/state/assembling", ARCHIVE_BUSY_FILE_TTL_S: "300" }, async () => {
      let clock = 1_000_000;
      const probe = makeArchiveBusyProbe({
        mtimeMs: () => 1_000_000 - 60_000,     // touched a minute ago
        loadavg: () => [0, 0, 0],
        cpuCount: () => 8,
        now: () => clock,
      });
      expect(await probe()).toBe(true);
      clock += 10 * 60_000;                     // heartbeat now 11 minutes old
      expect(await probe()).toBe(false);
    });
  });

  it("falls back to load average when there is no heartbeat file", async () => {
    await withEnv({ ARCHIVE_BUSY_FILE: undefined, RENDER_YIELD_LOAD_RATIO: "0.85" }, async () => {
      const at = (load: number) =>
        makeArchiveBusyProbe({ mtimeMs: () => null, loadavg: () => [load, 0, 0], cpuCount: () => 8 })();
      expect(await at(3.2)).toBe(false);   // 0.40 of 8 cores
      expect(await at(6.8)).toBe(true);    // 0.85 exactly — the threshold is inclusive
      expect(await at(7.5)).toBe(true);
    });
  });

  it("is inert where the archive does not exist", async () => {
    await withEnv({ ARCHIVE_BUSY_FILE: "/opt/reocam/state/assembling" }, async () => {
      const probe = makeArchiveBusyProbe({
        mtimeMs: () => null,               // ENOENT
        loadavg: () => [0.1, 0, 0],
        cpuCount: () => 4,
      });
      expect(await probe()).toBe(false);
    });
  });
});

describe("live, admin-configurable limits", () => {
  it("admits against the cap in force at the moment of admission, not at construction", async () => {
    let cap = 1;
    const q = new RenderQueue({
      concurrency: 1,
      liveConfig: async () => ({ concurrency: cap }),
    });
    const gates = [deferred(), deferred(), deferred()];
    let peak = 0;
    const hold = (i: number) =>
      q.run(`c${i}`, async () => {
        peak = Math.max(peak, q.snapshot().active);
        await gates[i]!.promise;
      });

    void hold(0);
    await tick();
    expect(q.snapshot().active).toBe(1);

    // An admin raises the cap mid-evening; the next job takes the new slot
    // without a restart.
    cap = 3;
    void hold(1);
    void hold(2);
    await tick();
    expect(q.snapshot().active).toBe(3);
    expect(peak).toBe(3);

    gates.forEach((g) => g.resolve());
  });

  it("stops yielding to the archive when an admin turns yielding off", async () => {
    const q = new RenderQueue({
      concurrency: 1,
      isArchiveBusy: async () => true,          // archive is busy the whole time
      liveConfig: async () => ({ yieldToArchive: false }),
      sleep: async () => { throw new Error("must not sleep"); },
    });
    await expect(q.run("clip-1", async () => "rendered")).resolves.toBe("rendered");
  });

  it("honours an admin-shortened yield ceiling", async () => {
    let clock = 0;
    const q = new RenderQueue({
      concurrency: 1,
      isArchiveBusy: async () => true,
      yieldPollMs: 30_000,
      maxYieldMs: 10 * 60_000,                    // constructor default
      liveConfig: async () => ({ yieldCeilingMs: 60_000 }),  // admin says one minute
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    await expect(q.run("clip-1", async () => "rendered")).resolves.toBe("rendered");
    expect(clock).toBe(60_000);
  });

  it("falls back to the configured values when settings cannot be read", async () => {
    // An unreadable settings table must not stop renders, for the same reason
    // the archive probe fails open.
    const q = new RenderQueue({
      concurrency: 2,
      liveConfig: async () => { throw new Error("db down"); },
    });
    await expect(q.run("clip-1", async () => "rendered")).resolves.toBe("rendered");
  });
});
