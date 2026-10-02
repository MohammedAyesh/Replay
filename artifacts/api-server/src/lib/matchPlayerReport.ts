/**
 * The match report's per-player timeline: when a player was on camera, what
 * they did in each five-minute block of the booking, when they touched the
 * ball, and where on the pitch they spent their time.
 *
 * Everything is on the booking clock (seconds from the booked kick-off), so
 * one match spanning two recordings reads as one night. It is built from the
 * same claimed parts, touches and moments as the totals beside it, so a block
 * can never disagree with the total it adds up to.
 */

export const REPORT_BLOCK_SECONDS = 300;
export const REPORT_HEAT_COLUMNS = 12;
export const REPORT_HEAT_ROWS = 8;

export type MatchPlayerReportBlock = {
  /** block number: block n covers [n * 300, (n + 1) * 300) seconds of the booking */
  index: number;
  /** seconds this player was on camera in the block */
  seconds: number;
  /** metres covered in the block; null without a pitch model */
  metres: number | null;
  /** touches in the block; null without ball data */
  touches: number | null;
};

export type MatchPlayerReport = {
  /** on-camera spans, seconds from the booked kick-off, merged and ordered */
  spans: Array<[number, number]>;
  blocks: MatchPlayerReportBlock[];
  /** seconds from kick-off of each touch */
  touchTimes: number[];
  goalTimes: number[];
  dribbleWonTimes: number[];
  /** seconds from kick-off of each shot (goals included, as the shot total counts them) */
  shotTimes: number[];
  /** passes this player played, seconds from kick-off; completed is null without a team pick */
  passes: Array<{ t: number; completed: boolean | null }>;
  /** every dribble this player started, with how it ended (null when it was not settled) */
  dribbles: Array<{ t: number; outcome: "won" | "lost" | null }>;
  /** seconds from kick-off where the fastest one-second run started */
  topSpeedAt: number | null;
  /** share of on-camera time in each cell, row-major, 12 columns x 8 rows; null when nothing was placed */
  heatmap: { coordinateSpace: "pitch" | "camera"; columns: number; rows: number; weights: number[] } | null;
};

type HeatCell = { x: number; y: number; weight: number };

/** Collects one player's pieces across recordings, then settles them into a report. */
export class MatchPlayerReportBuilder {
  private spans: Array<[number, number]> = [];
  private blocks = new Map<number, { seconds: number; metres: number | null; touches: number | null }>();
  private touchTimes: number[] = [];
  private goalTimes: number[] = [];
  private dribbleWonTimes: number[] = [];
  private shotTimes: number[] = [];
  private passes: Array<{ t: number; completed: boolean | null }> = [];
  private dribbles: Array<{ t: number; outcome: "won" | "lost" | null }> = [];
  private topSpeed: { kmh: number; at: number } | null = null;
  private heat = new Array<number>(REPORT_HEAT_COLUMNS * REPORT_HEAT_ROWS).fill(0);
  private heatSeconds = 0;
  private coordinateSpace: "pitch" | "camera" | null = null;
  /** blocks the current recording's spans cover */
  private current = new Set<number>();

  /** Start a recording: the measured-for markers below only apply to its own blocks. */
  beginRecording(): void {
    this.current = new Set();
  }

  private block(index: number) {
    let entry = this.blocks.get(index);
    if (!entry) {
      entry = { seconds: 0, metres: null, touches: null };
      this.blocks.set(index, entry);
    }
    return entry;
  }

  /** A stretch on camera, booking seconds. Its time is shared out over the blocks it crosses. */
  addSpan(from: number, to: number): void {
    const a = Math.max(0, from);
    const b = Math.max(a, to);
    if (b <= a) return;
    this.spans.push([a, b]);
    for (let index = Math.floor(a / REPORT_BLOCK_SECONDS); index * REPORT_BLOCK_SECONDS < b; index++) {
      const lo = Math.max(a, index * REPORT_BLOCK_SECONDS);
      const hi = Math.min(b, (index + 1) * REPORT_BLOCK_SECONDS);
      if (hi > lo) {
        this.block(index).seconds += hi - lo;
        this.current.add(index);
      }
    }
  }

  /** Metres per block, keyed by block number (from the metrics' distanceByBucket). */
  addDistance(byBlock: Record<string | number, number>): void {
    for (const [key, metres] of Object.entries(byBlock)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || !Number.isFinite(metres)) continue;
      const entry = this.block(index);
      entry.metres = (entry.metres ?? 0) + metres;
    }
  }

  /** Marks the current recording's blocks as measured for distance, even where the player stood still. */
  markDistanceMeasured(): void {
    for (const index of this.current) {
      const entry = this.block(index);
      if (entry.metres === null) entry.metres = 0;
    }
  }

  /** Touches from a recording with ball data: its blocks count from zero. */
  addTouches(times: number[]): void {
    for (const index of this.current) {
      const entry = this.block(index);
      if (entry.touches === null) entry.touches = 0;
    }
    for (const at of times) {
      if (!Number.isFinite(at) || at < 0) continue;
      this.touchTimes.push(at);
      const entry = this.block(Math.floor(at / REPORT_BLOCK_SECONDS));
      entry.touches = (entry.touches ?? 0) + 1;
    }
  }

  addGoals(times: number[]): void {
    for (const at of times) if (Number.isFinite(at) && at >= 0) this.goalTimes.push(at);
  }

  addDribblesWon(times: number[]): void {
    for (const at of times) if (Number.isFinite(at) && at >= 0) this.dribbleWonTimes.push(at);
  }

  addShots(times: number[]): void {
    for (const at of times) if (Number.isFinite(at) && at >= 0) this.shotTimes.push(at);
  }

  /** Passes the player played. */
  addPasses(passes: Array<{ t: number; completed: boolean | null }>): void {
    for (const pass of passes) if (Number.isFinite(pass.t) && pass.t >= 0) this.passes.push({ t: pass.t, completed: pass.completed });
  }

  /** Every dribble the player started, won, lost or unsettled. */
  addDribbles(dribbles: Array<{ t: number; outcome: "won" | "lost" | null }>): void {
    for (const dribble of dribbles) if (Number.isFinite(dribble.t) && dribble.t >= 0) this.dribbles.push({ t: dribble.t, outcome: dribble.outcome });
  }

  addTopSpeed(kmh: number | null, at: number | null): void {
    if (kmh === null || at === null || !Number.isFinite(kmh) || !Number.isFinite(at)) return;
    if (!this.topSpeed || kmh > this.topSpeed.kmh) this.topSpeed = { kmh, at: Math.max(0, at) };
  }

  /** A recording's heatmap (cell centres in 0..1, weights summing to 1), weighted by its seconds. */
  addHeatmap(space: "pitch" | "camera", cells: HeatCell[], seconds: number): void {
    if (!cells.length || !(seconds > 0)) return;
    // Mixing camera pixels with pitch metres would put cells in the wrong place.
    if (this.coordinateSpace && this.coordinateSpace !== space) {
      if (space === "camera") return;
      this.heat.fill(0);
      this.heatSeconds = 0;
    }
    this.coordinateSpace = space;
    for (const cell of cells) {
      const column = Math.min(REPORT_HEAT_COLUMNS - 1, Math.max(0, Math.floor(cell.x * REPORT_HEAT_COLUMNS)));
      const row = Math.min(REPORT_HEAT_ROWS - 1, Math.max(0, Math.floor(cell.y * REPORT_HEAT_ROWS)));
      this.heat[row * REPORT_HEAT_COLUMNS + column] += cell.weight * seconds;
    }
    this.heatSeconds += seconds;
  }

  build(): MatchPlayerReport {
    const ordered = [...this.spans].sort((p, q) => p[0] - q[0]);
    const spans: Array<[number, number]> = [];
    for (const [a, b] of ordered) {
      const last = spans.at(-1);
      // Two parts a moment apart are one stretch on camera.
      if (last && a - last[1] <= 2) last[1] = Math.max(last[1], b);
      else spans.push([a, b]);
    }
    const round1 = (value: number) => Math.round(value * 10) / 10;
    const total = this.heat.reduce((sum, value) => sum + value, 0);
    return {
      spans: spans.map(([a, b]) => [round1(a), round1(b)]),
      blocks: [...this.blocks.entries()]
        .sort((p, q) => p[0] - q[0])
        .map(([index, entry]) => ({
          index,
          seconds: Math.round(entry.seconds),
          metres: entry.metres === null ? null : Math.round(entry.metres),
          touches: entry.touches,
        })),
      touchTimes: this.touchTimes.sort((a, b) => a - b).map(round1),
      goalTimes: this.goalTimes.sort((a, b) => a - b).map(round1),
      dribbleWonTimes: this.dribbleWonTimes.sort((a, b) => a - b).map(round1),
      shotTimes: this.shotTimes.sort((a, b) => a - b).map(round1),
      passes: this.passes.sort((p, q) => p.t - q.t).map((pass) => ({ t: round1(pass.t), completed: pass.completed })),
      dribbles: this.dribbles.sort((p, q) => p.t - q.t).map((dribble) => ({ t: round1(dribble.t), outcome: dribble.outcome })),
      topSpeedAt: this.topSpeed ? round1(this.topSpeed.at) : null,
      heatmap: total > 0 && this.coordinateSpace
        ? {
          coordinateSpace: this.coordinateSpace,
          columns: REPORT_HEAT_COLUMNS,
          rows: REPORT_HEAT_ROWS,
          weights: this.heat.map((value) => Math.round((value / total) * 1000) / 1000),
        }
        : null,
    };
  }
}
