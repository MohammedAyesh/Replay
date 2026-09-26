/**
 * Touches, passes and teams: what happened to the ball, and who it happened to.
 *
 * The analysis pipeline finds the ball, and a TOUCH wherever its path is
 * kicked (an acceleration spike beside a player). It ships those raw, per
 * segment, in the bundle's ball sidecar (pack_ball.py): the player box the
 * ball tracker picked, the ball in pixels, and every track's torso colour.
 * Everything that needs judgement happens here, once, so the claim's stats
 * screen and the match page read the same numbers:
 *
 *   1. WHO touched it -- in metres, not pixels. On a 180 degree panorama the
 *      player nearest the ball in the image is the nearest on the pitch only
 *      ~71% of the time, so candidates are gathered loosely in pixels and the
 *      choice is made on the pitch.
 *   2. WHETHER it was a touch at all -- a touch means the ball is at foot
 *      height, so its ground projection lands at the player's feet. If it
 *      lands metres away the ball was in the air, crossing that player's sight
 *      line: not a touch.
 *   3. WHAT the ball did next (passEvents) -- the single definition of carry,
 *      contested ball and pass that the team stats, the player stats and the
 *      passes reel all read. Two definitions is how two numbers on one page
 *      drift apart; the prototype learnt that the hard way.
 *
 * Ported from the prototype (proto/add_touches.py, make_teams.py, and
 * passEvents/teamStats in the game page). Measured there on the 19 Sep match:
 * below 6 m the ball reaches a team-mate 43% of the time -- a coin flip, so
 * those are contested balls, not passes, and are never graded.
 */
import type { TrackingManifest, TrackingSegmentPayload } from "@workspace/db";

import { hasUsablePitchModel, interpolatePitchPosition } from "./pitchModel";

/* ------------------------------------------------------------------ sidecar */

/** [frame, x0, y0, x1, y1, ballX, ballY, speed] -- frame on the whole-recording timeline, pixels. */
export type RawTouch = [number, number, number, number, number, number | null, number | null, number];

export type BallSidecar = {
  v: 1;
  fps: number;
  touches: RawTouch[];
  /** [frame, x, y] at ~4 Hz, source pixels */
  ball: Array<[number, number, number]>;
  /** trackId (segment-namespaced) -> [L, a, b, seconds on camera], OpenCV 8-bit Lab */
  kits: Record<string, [number, number, number, number]>;
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Validate and namespace a sidecar from an upload. Anything malformed is
 * dropped row by row: ball data is optional, and one bad row must not cost
 * the whole segment its touches.
 */
export function parseBallSidecar(input: unknown, segmentIndex: number): BallSidecar | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const prefix = `s${segmentIndex}:`;
  const touches: RawTouch[] = [];
  for (const row of Array.isArray(raw.touches) ? raw.touches : []) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [f, x0, y0, x1, y1] = row.slice(0, 5).map(num);
    if (f === null || x0 === null || y0 === null || x1 === null || y1 === null || x1 <= x0 || y1 <= y0) continue;
    touches.push([Math.round(f), x0, y0, x1, y1, num(row[5]), num(row[6]), num(row[7]) ?? 0]);
  }
  const ball: Array<[number, number, number]> = [];
  for (const row of Array.isArray(raw.ball) ? raw.ball : []) {
    if (!Array.isArray(row)) continue;
    const [f, x, y] = row.map(num);
    if (f === null || x === null || y === null) continue;
    ball.push([Math.round(f), x, y]);
  }
  const kits: BallSidecar["kits"] = {};
  if (raw.kits && typeof raw.kits === "object") {
    for (const [trackId, value] of Object.entries(raw.kits as Record<string, unknown>)) {
      if (!Array.isArray(value) || value.length < 3) continue;
      const [L, a, b] = value.map(num);
      if (L === null || a === null || b === null) continue;
      kits[trackId.startsWith(prefix) ? trackId : `${prefix}${trackId}`] = [L, a, b, num(value[3]) ?? 0];
    }
  }
  if (!touches.length && !ball.length && !Object.keys(kits).length) return null;
  touches.sort((a, b) => a[0] - b[0]);
  ball.sort((a, b) => a[0] - b[0]);
  return { v: 1, fps: num(raw.fps) ?? 20, touches, ball, kits };
}

/* ------------------------------------------------------------------ colour */

export type Lab = [number, number, number];

/**
 * Lightness is the axis that separates most kits (black vs white), and the
 * only one a black shirt carries any signal on, so it counts half as much per
 * unit as chroma does not: it spans 0-255 where a and b barely move.
 */
export const kitDistance = (p: Lab, q: Lab) => Math.hypot((p[0] - q[0]) / 2, p[1] - q[1], p[2] - q[2]);

export function hexToLab(hex: string): Lab | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [((116 * f(Y) - 16) * 255) / 100, 500 * (f(X) - f(Y)) + 128, 200 * (f(Y) - f(Z)) + 128];
}

const LIGHTNESS_BINS: Array<[number, number]> = [[0, 20], [20, 35], [35, 50], [50, 70], [70, 101]];

/** The kit colours actually on the pitch, bucketed on lightness and weighted by time on camera. */
export function kitOptions(sidecars: Array<BallSidecar | null>): Array<{ lab: Lab; secs: number }> {
  const acc = LIGHTNESS_BINS.map(() => ({ s: 0, L: 0, a: 0, b: 0 }));
  for (const sc of sidecars) {
    for (const [L, a, b, secs] of Object.values(sc?.kits ?? {})) {
      const l = (L * 100) / 255;
      const i = LIGHTNESS_BINS.findIndex(([lo, hi]) => l >= lo && l < hi);
      if (i < 0 || !(secs > 0)) continue;
      acc[i].s += secs; acc[i].L += L * secs; acc[i].a += a * secs; acc[i].b += b * secs;
    }
  }
  return acc
    .filter((c) => c.s > 60)
    .map((c) => ({ lab: [c.L / c.s, c.a / c.s, c.b / c.s].map((v) => Math.round(v * 10) / 10) as Lab, secs: Math.round(c.s) }))
    .sort((p, q) => q.secs - p.secs);
}

/* ------------------------------------------------------------------ touches */

export type Touch = {
  /** frame on the recording timeline, and the same in tracking seconds */
  f: number;
  t: number;
  segmentIndex: number;
  /** the track that touched it (segment-namespaced) */
  trackId: string;
  /** torso colour of that track, when the bundle carried sprites */
  kit: Lab | null;
  /** ball and player on the pitch, metres (null without a pitch model) */
  ball: [number, number] | null;
  foot: [number, number] | null;
  /** metres between them */
  d: number | null;
  /** the metres choice disagreed with the ball tracker's pixel choice */
  reassigned: boolean;
};

export const TOUCH = {
  /** box overlap needed to name the track the ball tracker picked */
  minIou: 0.3,
  /** a player's reach plus the camera model's own error, metres */
  baseMetres: 1.5,
  /** assumed ball height during a touch, metres */
  ballHeight: 0.25,
  /** camera height above the pitch, metres (cam1's fitted model: 2.36 m) */
  cameraHeight: 2.36,
  /** candidate net in pixels: a floor and a multiple of the candidate's height */
  pixelFloor: 60,
  pixelPerHeight: 1.6,
  /** frames either side of the touch a box may come from */
  frameSlack: 2,
} as const;

type Box = { id: string; x: number; y: number; w: number; h: number };

function iou(a: [number, number, number, number], b: Box): number {
  const ix0 = Math.max(a[0], b.x), iy0 = Math.max(a[1], b.y);
  const ix1 = Math.min(a[2], b.x + b.w), iy1 = Math.min(a[3], b.y + b.h);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + b.w * b.h - inter);
}

/**
 * How far away a player is from the camera, from how tall they look. On an
 * equirectangular panorama a 1.75 m person at range r is about
 * (width / pi) * 1.75 / r pixels tall. Good to a metre or two, which is all
 * the touch gate needs: it only scales an allowance.
 */
function rangeFromHeight(heightPx: number, imageWidth: number): number {
  return ((imageWidth / Math.PI) * 1.75) / Math.max(heightPx, 1);
}

/** Every box of every track at the frames asked for (+/- slack), in one pass. */
function boxesAtFrames(segment: TrackingSegmentPayload, frames: number[], slack: number): Map<number, Box[]> {
  const want = new Set<number>();
  for (const f of frames) for (let o = -slack; o <= slack; o++) want.add(f + o);
  const out = new Map<number, Box[]>();
  for (const track of segment.tracks) {
    if (!track.boxes.length) continue;
    for (const box of track.boxes) {
      if (!want.has(box.frame)) continue;
      const list = out.get(box.frame) ?? [];
      list.push({ id: track.id, x: box.x, y: box.y, w: box.w, h: box.h });
      out.set(box.frame, list);
    }
  }
  return out;
}

function near(index: Map<number, Box[]>, f: number, slack: number): Box[] {
  const seen = new Set<string>();
  const out: Box[] = [];
  for (const o of [0, -1, 1, -2, 2].filter((v) => Math.abs(v) <= slack)) {
    for (const box of index.get(f + o) ?? []) {
      if (seen.has(box.id)) continue;
      seen.add(box.id);
      out.push(box);
    }
  }
  return out;
}

/**
 * Resolve every raw touch to the track that made it, and drop the ones that
 * cannot have been touches. Without a pitch model there are no metres: the
 * tracker's pixel pick is kept and nothing is gated, and ball positions are
 * null (so no pass can be measured).
 */
export function resolveTouches(
  manifest: TrackingManifest,
  segments: TrackingSegmentPayload[],
  sidecars: Array<BallSidecar | null>,
): { touches: Touch[]; rejected: { noTrack: number; tooFar: number } } {
  const pitch = hasUsablePitchModel(manifest);
  const fps = manifest.frameRate > 0 ? manifest.frameRate : 20;
  const kits = new Map<string, Lab>();
  for (const sc of sidecars) for (const [id, v] of Object.entries(sc?.kits ?? {})) kits.set(id, [v[0], v[1], v[2]]);
  const touches: Touch[] = [];
  let noTrack = 0;
  let tooFar = 0;
  const ground = (x: number, y: number): [number, number] | null => {
    const p = pitch ? interpolatePitchPosition(x, y, manifest) : null;
    return p ? [p.x, p.y] : null;
  };
  for (const segment of segments) {
    const sc = sidecars[segment.segmentIndex];
    if (!sc?.touches.length) continue;
    const index = boxesAtFrames(segment, sc.touches.map((r) => r[0]), TOUCH.frameSlack);
    for (const [f, x0, y0, x1, y1, bx, by] of sc.touches) {
      const boxes = near(index, f, TOUCH.frameSlack);
      // who the ball tracker picked, by overlap with the box it chose
      let bestIou = 0;
      let trackerId: string | null = null;
      for (const box of boxes) {
        const v = iou([x0, y0, x1, y1], box);
        if (v > bestIou) { bestIou = v; trackerId = box.id; }
      }
      if (!trackerId || bestIou < TOUCH.minIou) { noTrack++; continue; }
      const ball = bx !== null && by !== null ? ground(bx, by) : null;
      if (!ball) {
        touches.push({ f, t: f / fps, segmentIndex: segment.segmentIndex, trackId: trackerId, kit: kits.get(trackerId) ?? null, ball: null, foot: null, d: null, reassigned: false });
        continue;
      }
      // choose in metres among everyone loosely near the ball in pixels
      let best: { d: number; id: string; foot: [number, number]; h: number } | null = null;
      for (const box of boxes) {
        const fx = box.x + box.w / 2;
        const fy = box.y + box.h;
        if (Math.hypot(bx! - fx, by! - fy) > Math.max(TOUCH.pixelFloor, TOUCH.pixelPerHeight * box.h)) continue;
        const foot = ground(fx, fy);
        if (!foot) continue;
        const d = Math.hypot(ball[0] - foot[0], ball[1] - foot[1]);
        if (!best || d < best.d) best = { d, id: box.id, foot, h: box.h };
      }
      if (!best) {
        const foot = ground((x0 + x1) / 2, y1);
        if (!foot) { noTrack++; continue; }
        best = { d: Math.hypot(ball[0] - foot[0], ball[1] - foot[1]), id: trackerId, foot, h: y1 - y0 };
      }
      const range = rangeFromHeight(best.h, manifest.width);
      if (best.d > TOUCH.baseMetres + (TOUCH.ballHeight * range) / (TOUCH.cameraHeight - TOUCH.ballHeight)) {
        tooFar++;
        continue;
      }
      touches.push({
        f,
        t: f / fps,
        segmentIndex: segment.segmentIndex,
        trackId: best.id,
        kit: kits.get(best.id) ?? null,
        ball: [round1(ball[0]), round1(ball[1])],
        foot: [round1(best.foot[0]), round1(best.foot[1])],
        d: round1(best.d),
        reassigned: best.id !== trackerId,
      });
    }
  }
  touches.sort((a, b) => a.f - b.f);
  return { touches, rejected: { noTrack, tooFar } };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/* ------------------------------------------------------------------ passes */

export const PASS = {
  /** ball travel at or above which two touches by different players are a pass, metres */
  passMetres: 6,
  /** below this it is a carry, even by two players (a tackle on the ball) */
  contestMetres: 2,
  /** two touches further apart than this are not linked at all, seconds */
  maxGapSeconds: 6,
  /** a touch this close to the line between two kits is counted as ambiguous */
  ambiguousKit: 5,
  /** possession credited per interval is capped, so a dead ball cannot swamp it */
  possessionCapSeconds: 8,
} as const;

export type TeamPick = { a: Lab; b: Lab };

export type PlayEvent = {
  kind: "carry" | "contest" | "pass";
  from: Touch;
  to: Touch;
  /** the next touch was by the same team */
  sameTeam: boolean;
  /** metres the ball travelled (null without a pitch model) */
  metres: number | null;
};

export function teamOf(touch: Touch, pick: TeamPick | null): { team: 0 | 1; margin: number } | null {
  if (!pick || !touch.kit) return null;
  const da = kitDistance(touch.kit, pick.a);
  const db = kitDistance(touch.kit, pick.b);
  return { team: da <= db ? 0 : 1, margin: Math.abs(da - db) };
}

/**
 * ONE definition of what the ball did between two consecutive touches. Two
 * touches within 6 s: the same player again, or under 2 m, is a carry; 2-6 m
 * by different players is a contested ball; 6 m or more is an attempted pass,
 * completed when the same team got it. Without team colours nothing is graded
 * (sameTeam false everywhere) and without a pitch model nothing is a pass.
 */
export function passEvents(touches: Touch[], pick: TeamPick | null): Array<PlayEvent | null> {
  const events: Array<PlayEvent | null> = [];
  for (let i = 0; i < touches.length - 1; i++) {
    const u = touches[i];
    const v = touches[i + 1];
    const gap = v.t - u.t;
    if (gap <= 0 || gap > PASS.maxGapSeconds) { events.push(null); continue; }
    const tu = teamOf(u, pick);
    const tv = teamOf(v, pick);
    const sameTeam = !!tu && !!tv && tu.team === tv.team;
    const metres = u.ball && v.ball ? Math.hypot(v.ball[0] - u.ball[0], v.ball[1] - u.ball[1]) : null;
    const kind: PlayEvent["kind"] = v.trackId === u.trackId || metres === null || metres < PASS.contestMetres
      ? "carry"
      : metres < PASS.passMetres ? "contest" : "pass";
    events.push({ kind, from: u, to: v, sameTeam, metres: metres === null ? null : round1(metres) });
  }
  return events;
}

export type TeamStats = {
  touches: [number, number];
  passesTried: [number, number];
  passesCompleted: [number, number];
  possessionSeconds: [number, number];
  possessionPercent: [number, number];
  completionPercent: number;
  contested: number;
  carries: number;
  longestPassRun: number;
  ambiguous: number;
  total: number;
};

export function teamStats(touches: Touch[], events: Array<PlayEvent | null>, pick: TeamPick): TeamStats {
  const tch: [number, number] = [0, 0];
  const att: [number, number] = [0, 0];
  const comp: [number, number] = [0, 0];
  const pos: [number, number] = [0, 0];
  let contested = 0;
  let carries = 0;
  let best = 1;
  let cur = 1;
  let ambiguous = 0;
  for (let i = 0; i < touches.length; i++) {
    const u = touches[i];
    const tu = teamOf(u, pick);
    if (!tu) continue;
    if (tu.margin < PASS.ambiguousKit) ambiguous++;
    tch[tu.team]++;
    const v = touches[i + 1];
    pos[tu.team] += v ? Math.min(Math.max(v.t - u.t, 0), PASS.possessionCapSeconds) : 1.5;
    const e = events[i];
    if (!v || !e) { best = Math.max(best, cur); cur = 1; continue; }
    if (e.kind === "carry") { carries++; if (!e.sameTeam) { best = Math.max(best, cur); cur = 1; } continue; }
    if (e.kind === "contest") { contested++; if (e.sameTeam) cur++; else { best = Math.max(best, cur); cur = 1; } continue; }
    att[tu.team]++;
    if (e.sameTeam) { comp[tu.team]++; cur++; } else { best = Math.max(best, cur); cur = 1; }
  }
  best = Math.max(best, cur);
  const pt = pos[0] + pos[1] || 1;
  const aT = att[0] + att[1];
  const cT = comp[0] + comp[1];
  return {
    touches: tch,
    passesTried: att,
    passesCompleted: comp,
    possessionSeconds: [Math.round(pos[0]), Math.round(pos[1])],
    possessionPercent: [Math.round((1000 * pos[0]) / pt) / 10, Math.round((1000 * pos[1]) / pt) / 10],
    completionPercent: aT ? Math.round((1000 * cT) / aT) / 10 : 0,
    contested,
    carries,
    longestPassRun: best,
    ambiguous,
    total: tch[0] + tch[1],
  };
}

/* ------------------------------------------------------------------ a player */

export type ClaimedPart = { trackId: string; fromFrame: number; toFrame: number };

/** Frames of slack when deciding a touch falls inside a claimed part. */
const PART_SLACK = 7;

export function mineTest(parts: ClaimedPart[]): (touch: Touch) => boolean {
  const byTrack = new Map<string, Array<[number, number]>>();
  for (const p of parts) byTrack.set(p.trackId, [...(byTrack.get(p.trackId) ?? []), [p.fromFrame, p.toFrame]]);
  return (touch) => (byTrack.get(touch.trackId) ?? []).some(([a, b]) => touch.f >= a - PART_SLACK && touch.f <= b + PART_SLACK);
}

export type PlayerPass = {
  /** you played it (else you received it) */
  give: boolean;
  completed: boolean;
  metres: number;
  f0: number;
  f1: number;
  t0: number;
  t1: number;
  from: [number, number] | null;
  to: [number, number] | null;
  /** the other player's track: the receiver when you gave it, the passer when you got it */
  otherTrackId: string;
  /** your own track at the moment */
  trackId: string;
};

export type PlayerPlay = {
  touches: Touch[];
  passes: PlayerPass[];
  passesTried: number;
  passesCompleted: number;
  passesReceived: number;
};

export function playerPlay(touches: Touch[], events: Array<PlayEvent | null>, parts: ClaimedPart[], graded: boolean): PlayerPlay {
  const mine = mineTest(parts);
  const own = touches.filter(mine);
  const passes: PlayerPass[] = [];
  let tried = 0;
  let completed = 0;
  let received = 0;
  for (const e of events) {
    if (!e || e.kind !== "pass" || e.metres === null) continue;
    const give = mine(e.from);
    const get = mine(e.to);
    if (!give && !get) continue;
    if (give) { tried++; if (graded && e.sameTeam) completed++; }
    if (get && graded && e.sameTeam) received++;
    passes.push({
      give,
      completed: graded && e.sameTeam,
      metres: e.metres,
      f0: e.from.f,
      f1: e.to.f,
      t0: e.from.t,
      t1: e.to.t,
      from: e.from.ball,
      to: e.to.ball,
      otherTrackId: give ? e.to.trackId : e.from.trackId,
      trackId: give ? e.from.trackId : e.to.trackId,
    });
  }
  return { touches: own, passes, passesTried: tried, passesCompleted: completed, passesReceived: received };
}

/** The claimant's own shirt: their claimed tracks' torso colours, weighted by claimed time. */
export function kitOfParts(parts: ClaimedPart[], sidecars: Array<BallSidecar | null>, fps: number): Lab | null {
  const kits = new Map<string, [number, number, number, number]>();
  for (const sc of sidecars) for (const [id, v] of Object.entries(sc?.kits ?? {})) kits.set(id, v);
  let w = 0;
  const acc: Lab = [0, 0, 0];
  for (const p of parts) {
    const k = kits.get(p.trackId);
    if (!k) continue;
    const secs = Math.max(0, (p.toFrame - p.fromFrame) / fps);
    acc[0] += k[0] * secs; acc[1] += k[1] * secs; acc[2] += k[2] * secs;
    w += secs;
  }
  return w > 0 ? [acc[0] / w, acc[1] / w, acc[2] / w].map((v) => Math.round(v * 10) / 10) as Lab : null;
}

/**
 * Seed the two team colours: yours, and the kit most unlike yours weighted by
 * how much it was on camera (so a referee's shirt seen for a minute does not
 * win over the other team seen for an hour).
 */
export function seedTeams(own: Lab | null, options: Array<{ lab: Lab; secs: number }>): TeamPick | null {
  if (options.length < 2) return null;
  let mineIndex = 0;
  if (own) options.forEach((c, i) => { if (kitDistance(c.lab, own) < kitDistance(options[mineIndex].lab, own)) mineIndex = i; });
  const a = own ?? options[mineIndex].lab;
  let other = -1;
  let score = -1;
  options.forEach((c, i) => {
    if (i === mineIndex) return;
    const s = kitDistance(c.lab, a) * Math.sqrt(c.secs);
    if (s > score) { score = s; other = i; }
  });
  return other < 0 ? null : { a, b: options[other].lab };
}

export function parseLab(value: unknown): Lab | null {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map(Number);
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v) || v < -1 || v > 256)) return null;
  return parts as Lab;
}

/* ------------------------------------------------------------------ teleports */

export const TELEPORT = {
  /** a jump this far between two ball samples is a candidate, metres */
  jumpMetres: 3,
  /** it has to come back within this many samples (~4 Hz, so about a second) */
  lookSamples: 4,
  /** while "away" a glitch sits still on what it latched onto; a real ball keeps moving, metres per sample */
  parkedMetres: 1,
  /** samples further apart than this are not compared, frames */
  maxGapFrames: 12,
  /** touches this close to a teleport's window are dropped with it, frames */
  padFrames: 3,
} as const;

/**
 * Ball teleports. The ball detector sometimes jumps to something ball-like --
 * a boot, a knee, a hand, a head -- for a sample or two and then comes back
 * to where the real ball was going. A real ball that jumps that far (a shot)
 * does not come back. The jump samples are dropped, and so is any touch made
 * while the ball was "away", because that touch is the glitch touching a
 * player. Checked by eye on 9 random teleports of the 19 Sep game: all 9 were
 * the tracker on a boot, a hand or a head (420 in two hours, 414 touches).
 */
export function dropTeleports(
  sidecar: BallSidecar | null,
  manifest: Pick<TrackingManifest, "width" | "height" | "pitchModel">,
): { sidecar: BallSidecar | null; teleports: number; touchesDropped: number } {
  if (!sidecar || sidecar.ball.length < 3 || !manifest.pitchModel) return { sidecar, teleports: 0, touchesDropped: 0 };
  const P = sidecar.ball.map(([f, x, y]) => {
    const p = interpolatePitchPosition(x, y, manifest as TrackingManifest);
    return p ? { f, x: p.x, y: p.y } : null;
  });
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const bad = new Set<number>();
  const windows: Array<[number, number]> = [];
  for (let k = 1; k < P.length; k++) {
    const pre = P[k - 1], cur = P[k];
    if (!pre || !cur || cur.f - pre.f > TELEPORT.maxGapFrames) continue;
    const jump = d(pre, cur);
    if (jump < TELEPORT.jumpMetres) continue;
    for (let m = k + 1; m <= Math.min(P.length - 1, k + TELEPORT.lookSamples); m++) {
      const back = P[m];
      if (!back) continue;
      if (d(back, pre) < jump * 0.5 && d(back, cur) >= TELEPORT.jumpMetres) {
        let parked = true;
        for (let q = k + 1; q < m; q++) {
          const a = P[q], z = P[q - 1];
          if (!a || !z || d(a, z) > TELEPORT.parkedMetres) parked = false;
        }
        if (!parked) break;
        for (let q = k; q < m; q++) bad.add(q);
        windows.push([cur.f - TELEPORT.padFrames, P[m - 1]!.f + TELEPORT.padFrames]);
        k = m - 1;
        break;
      }
    }
  }
  if (!windows.length) return { sidecar, teleports: 0, touchesDropped: 0 };
  const touches = sidecar.touches.filter((t) => !windows.some(([lo, hi]) => t[0] >= lo && t[0] <= hi));
  return {
    sidecar: { ...sidecar, touches, ball: sidecar.ball.filter((_, i) => !bad.has(i)) },
    teleports: windows.length,
    touchesDropped: sidecar.touches.length - touches.length,
  };
}

/* ------------------------------------------------------------------ dribbles */

export const DRIBBLE = {
  /** consecutive touches by the carrier this close together are one run, seconds */
  maxTouchGapSeconds: 3,
  /** one stray "touch" by someone else, with the carrier back on it within this long, does not end the run, seconds */
  regainSeconds: 1.5,
  /** the carrier has to travel this far with the ball, metres... */
  minMetres: 5,
  /** ...over at least this long, seconds */
  minSeconds: 1.2,
  /** how often the run is sampled, frames */
  sampleFrames: 4,
  /** an opponent counts as "in front" up to this far ahead of the carrier... */
  aheadMetres: 7,
  /** ...and this far either side of his line, metres */
  lateralMetres: 3.5,
  /** and is "passed" once he is this far behind the carrier (and still within passedRadius) */
  behindMetres: 0.5,
  passedRadiusMetres: 6,
  /** the next touch decides it only when it comes within this long, seconds */
  outcomeSeconds: 4,
  /** without team colours: another shirt this far from his is an opponent... */
  opponentKit: 22,
  /** ...and this close is a team-mate (in between is too close to call) */
  sameKit: 12,
} as const;

export type Dribble = {
  trackId: string;
  f0: number;
  f1: number;
  t0: number;
  t1: number;
  /** ball at the first and last touch of the run, metres */
  from: [number, number] | null;
  to: [number, number] | null;
  /** how far the carrier travelled with it, metres */
  metres: number | null;
  touches: number;
  /** opponents he went past, and the first of them */
  beaten: number;
  beatenTrackIds: string[];
  opponentTrackId: string;
  /** won = successful (he or his side still had it after), lost = failed (the other side got it), null = nobody touched it within 4 s */
  outcome: "won" | "lost" | null;
};

/** The side of a shirt: 0/1 against a team pick, or "same"/"other" against another shirt, or null when it cannot be told. */
function sameSide(p: Lab | null, q: Lab | null, pick: TeamPick | null): boolean | null {
  if (!p || !q) return null;
  if (pick) {
    const tp = kitDistance(p, pick.a) <= kitDistance(p, pick.b) ? 0 : 1;
    const tq = kitDistance(q, pick.a) <= kitDistance(q, pick.b) ? 0 : 1;
    return tp === tq;
  }
  const d = kitDistance(p, q);
  if (d >= DRIBBLE.opponentKit) return false;
  if (d <= DRIBBLE.sameKit) return true;
  return null;
}

/**
 * Dribbles, successful and failed. A dribble is a RUN with the ball that gets
 * past people -- not a standing 1-v-1, not a pass (Mohammed's definition,
 * checked against his calls on the 19 Sep game):
 *
 *   1. A RUN: one player's touches, each within 3 s of the last, over at least
 *      1.2 s, while he himself travels at least 5 m. A single stray "touch" by
 *      someone else with the carrier back on it within 1.5 s is the touch
 *      detector misreading a tackle attempt, and the run carries on through it.
 *   2. PAST SOMEONE: an opponent who was in front of him (up to 7 m ahead,
 *      within 3.5 m of his line) ends up behind him. Nobody passed: a carry,
 *      not a dribble.
 *   3. The OUTCOME is who touched it next: his side is successful; the other
 *      side is failed -- unless his side has it back within 1.5 s, which again
 *      is a misread. Nobody within 4 s is not graded.
 *
 * Needs the pitch model (metres) and the tracks' boxes. Sides come from the
 * team pick when there is one, else from shirt colour alone. Feed it touches
 * resolved from teleport-free sidecars (dropTeleports).
 */
export function dribbleEvents(
  manifest: TrackingManifest,
  segments: TrackingSegmentPayload[],
  touches: Touch[],
  kits: Map<string, Lab>,
  pick: TeamPick | null,
): Dribble[] {
  if (!hasUsablePitchModel(manifest) || touches.length < 2) return [];
  const T = touches;
  const sideOf = (id: string, fallback: Lab | null) => kits.get(id) ?? fallback ?? null;
  type Run = { i: number; j: number };
  const runs: Run[] = [];
  let i = 0;
  while (i < T.length) {
    const c = T[i].trackId;
    let j = i;
    for (;;) {
      const n1 = T[j + 1], n2 = T[j + 2];
      if (n1 && n1.trackId === c && n1.t - T[j].t <= DRIBBLE.maxTouchGapSeconds) { j += 1; continue; }
      if (n1 && n2 && n1.trackId !== c && n2.trackId === c
        && n2.t - T[j].t <= DRIBBLE.maxTouchGapSeconds + 0.5 && n2.t - n1.t <= DRIBBLE.regainSeconds) { j += 2; continue; }
      break;
    }
    if (j > i && T[j].t - T[i].t >= DRIBBLE.minSeconds) runs.push({ i, j });
    i = j + 1;
  }
  if (!runs.length) return [];

  const framesOf = (r: Run) => {
    const out: number[] = [];
    for (let f = T[r.i].f; f <= T[r.j].f; f += DRIBBLE.sampleFrames) out.push(f);
    if (out[out.length - 1] !== T[r.j].f) out.push(T[r.j].f);
    return out;
  };
  const bySegment = new Map<number, number[]>();
  for (const r of runs) {
    const seg = T[r.i].segmentIndex;
    const list = bySegment.get(seg) ?? [];
    list.push(...framesOf(r));
    bySegment.set(seg, list);
  }
  const index = new Map<number, Box[]>();
  for (const segment of segments) {
    const frames = bySegment.get(segment.segmentIndex);
    if (!frames?.length) continue;
    for (const [f, boxes] of boxesAtFrames(segment, frames, 1)) {
      const list = index.get(f) ?? [];
      list.push(...boxes);
      index.set(f, list);
    }
  }
  const footOf = (box: Box) => interpolatePitchPosition(box.x + box.w / 2, box.y + box.h, manifest);

  const out: Dribble[] = [];
  for (const r of runs) {
    const first = T[r.i], last = T[r.j];
    const own = sideOf(first.trackId, first.kit);
    const me: Array<{ x: number; y: number }> = [];
    const opp = new Map<string, Array<{ p: { x: number; y: number }; mp: { x: number; y: number } }>>();
    for (const f of framesOf(r)) {
      const boxes = near(index, f, 2);
      const mb = boxes.find((b) => b.id === first.trackId);
      const mp = mb ? footOf(mb) : null;
      if (!mp) continue;
      me.push(mp);
      for (const b of boxes) {
        if (b.id === first.trackId || sameSide(own, sideOf(b.id, null), pick) !== false) continue;
        const p = footOf(b);
        if (!p) continue;
        const list = opp.get(b.id) ?? [];
        list.push({ p, mp });
        opp.set(b.id, list);
      }
    }
    if (me.length < 2) continue;
    const c0 = me[0], c1 = me[me.length - 1];
    const L = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    if (L < DRIBBLE.minMetres) continue;
    const ux = (c1.x - c0.x) / L, uy = (c1.y - c0.y) / L;
    const beaten: string[] = [];
    for (const [id, seq] of opp) {
      let ahead = false;
      for (const { p, mp } of seq) {
        const rx = p.x - mp.x, ry = p.y - mp.y;
        const along = rx * ux + ry * uy, lateral = Math.abs(rx * uy - ry * ux);
        if (along > 0.3 && along <= DRIBBLE.aheadMetres && lateral <= DRIBBLE.lateralMetres) ahead = true;
        else if (ahead && along < -DRIBBLE.behindMetres && Math.hypot(rx, ry) < DRIBBLE.passedRadiusMetres) { beaten.push(id); break; }
      }
    }
    if (!beaten.length) continue;
    const next = T[r.j + 1];
    let outcome: Dribble["outcome"] = null;
    if (next && next.t - last.t <= DRIBBLE.outcomeSeconds) {
      const same = next.trackId === first.trackId ? true : sameSide(own, sideOf(next.trackId, next.kit), pick);
      if (same === true) outcome = "won";
      else if (same === false) {
        const back = T.slice(r.j + 2, r.j + 6).find((x) => x.t - next.t <= DRIBBLE.regainSeconds
          && (x.trackId === first.trackId || sameSide(own, sideOf(x.trackId, x.kit), pick) === true));
        outcome = back ? "won" : "lost";
      }
    }
    out.push({
      trackId: first.trackId,
      f0: first.f,
      f1: last.f,
      t0: first.t,
      t1: last.t,
      from: first.ball,
      to: last.ball,
      metres: round1(L),
      touches: r.j - r.i + 1,
      beaten: beaten.length,
      beatenTrackIds: beaten,
      opponentTrackId: beaten[0],
      outcome,
    });
  }
  return out;
}

/** Dribbles per team: all of them, successful (won) and failed (lost), [side 0, side 1]. */
export function teamDribbles(dribbles: Dribble[], kits: Map<string, Lab>, pick: TeamPick): { total: [number, number]; won: [number, number]; lost: [number, number] } {
  const total: [number, number] = [0, 0];
  const won: [number, number] = [0, 0];
  const lost: [number, number] = [0, 0];
  for (const d of dribbles) {
    const kit = kits.get(d.trackId);
    if (!kit) continue;
    const side = kitDistance(kit, pick.a) <= kitDistance(kit, pick.b) ? 0 : 1;
    total[side]++;
    if (d.outcome === "won") won[side]++;
    else if (d.outcome === "lost") lost[side]++;
  }
  return { total, won, lost };
}

/* ------------------------------------------------------------------ goals */

/** A bundle event (goals.py via make_appbundle), on the tracking clock. */
export type BundleEvent = { type: string; t: number };

export const GOAL = {
  /**
   * goals.py infers a goal from a stoppage followed by a kick-off. Several
   * stoppages before one kick-off each become a "goal" (seen on the 19 Sep
   * game: three inferred goals sharing one restart), so goals this close
   * together are one goal, the last of them -- the one the kick-off answers.
   */
  mergeSeconds: 75,
  /** the scorer is the last touch this long before the ball went in, seconds */
  scorerSeconds: 8,
  /** a shot on target is credited to a touch this long before it, seconds */
  shooterSeconds: 3,
} as const;

export type DetectedGoal = {
  t: number;
  /** the last player to touch it, when a touch was seen */
  trackId: string | null;
  kit: Lab | null;
  /** seconds between that touch and the goal */
  lead: number | null;
  /** frame of that touch */
  touchF: number | null;
};

export type DetectedShot = { t: number; trackId: string | null; kit: Lab | null; touchF: number | null };

/** The pitch in metres, for telling a goalkeeper's touch from the shot. */
export type PitchSize = { length: number; width: number };

export function pitchSizeOf(manifest: Pick<TrackingManifest, "pitchModel">): PitchSize | null {
  const m = manifest.pitchModel;
  return m && m.pitchWidthMetres > 0 && m.pitchHeightMetres > 0 ? { length: m.pitchWidthMetres, width: m.pitchHeightMetres } : null;
}

export const KEEPER = {
  /**
   * a touch with the player's feet this close to the goal line... On the
   * 19 Sep game every keeper touch was within 1.2 m of the line and every
   * real shooter at least 1.7 m out (3 m nulled real shots, 2026-09-26).
   */
  lineMetres: 1.4,
  /** ...and this close to the middle of it is the goalkeeper's, metres */
  halfWidthMetres: 4,
} as const;

/**
 * Who struck it: the last touch before the ball went in (or was seen in the
 * goal mouth) that was not the goalkeeper's. On a goal the keeper picks the
 * ball out of the net; on a save he is the one who stopped it -- either way
 * "the last touch" was his, and he was being credited with other people's
 * goals and shots (Mohammed, 2026-09-26; 7 of 12 real shots on the 19 Sep
 * game). So touches from inside the goal mouth at the end being attacked are
 * skipped, and so is every touch by that same track in the window. Shirt
 * colour is not used: a keeper's kit often looks like the attackers' and it
 * took real shooters' credit away. Without a pitch model this falls back to
 * the plain last touch.
 */
function strikerBefore(touches: Touch[], t: number, window: number, pitch: PitchSize | null): Touch | null {
  let lo = 0;
  let hi = touches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (touches[mid].t <= t + 0.5) lo = mid + 1; else hi = mid;
  }
  const candidates: Touch[] = [];
  for (let k = lo - 1; k >= 0 && t - touches[k].t <= window; k--) candidates.push(touches[k]);
  if (!candidates.length) return null;
  const at = candidates.find((c) => c.foot)?.foot ?? candidates.find((c) => c.ball)?.ball ?? null;
  if (!pitch || !at) return candidates[0];
  const goalX = at[0] < pitch.length / 2 ? 0 : pitch.length;
  const inMouth = (c: Touch) => !!c.foot
    && Math.abs(c.foot[0] - goalX) <= KEEPER.lineMetres
    && Math.abs(c.foot[1] - pitch.width / 2) <= KEEPER.halfWidthMetres;
  const keeperIds = new Set(candidates.filter(inMouth).map((c) => c.trackId));
  return candidates.find((c) => !keeperIds.has(c.trackId)) ?? null;
}

/** Goals the detector saw, merged, each with the player who scored it (never the goalkeeper). */
export function detectedGoals(events: BundleEvent[], touches: Touch[], pitch: PitchSize | null = null): DetectedGoal[] {
  const goals = events.filter((e) => e.type.toLowerCase() === "goal").map((e) => e.t).sort((a, b) => a - b);
  const merged: number[] = [];
  for (const t of goals) {
    if (merged.length && t - merged[merged.length - 1] <= GOAL.mergeSeconds) merged[merged.length - 1] = t;
    else merged.push(t);
  }
  return merged.map((t) => {
    const touch = strikerBefore(touches, t, GOAL.scorerSeconds, pitch);
    return { t, trackId: touch?.trackId ?? null, kit: touch?.kit ?? null, lead: touch ? round1(t - touch.t) : null, touchF: touch?.f ?? null };
  });
}

/** Shots on target (the ball seen inside a goal mouth), each with the player who struck it (never the goalkeeper). */
export function detectedShots(events: BundleEvent[], touches: Touch[], pitch: PitchSize | null = null): DetectedShot[] {
  return events
    .filter((e) => e.type.toLowerCase() === "shot")
    .sort((a, b) => a.t - b.t)
    .map((e) => {
      const touch = strikerBefore(touches, e.t, GOAL.shooterSeconds, pitch);
      return { t: e.t, trackId: touch?.trackId ?? null, kit: touch?.kit ?? null, touchF: touch?.f ?? null };
    });
}

/** Which side a shirt is on under a pick, or null. */
export function sideOfKit(kit: Lab | null, pick: TeamPick | null): 0 | 1 | null {
  if (!kit || !pick) return null;
  return kitDistance(kit, pick.a) <= kitDistance(kit, pick.b) ? 0 : 1;
}

/** One player's share of the dribbles, goals and shots, by their claimed parts. */
export function playerMoments(parts: ClaimedPart[], dribbles: Dribble[], goals: DetectedGoal[], shots: DetectedShot[]) {
  const mine = mineTest(parts);
  const is = (trackId: string | null, f: number | null) => trackId !== null && f !== null && mine({ trackId, f } as Touch);
  const own = dribbles.filter((d) => is(d.trackId, d.f0));
  return {
    dribbles: own,
    dribblesWon: own.filter((d) => d.outcome === "won").length,
    dribblesLost: own.filter((d) => d.outcome === "lost").length,
    goals: goals.filter((g) => is(g.trackId, g.touchF)),
    shots: shots.filter((x) => is(x.trackId, x.touchF)),
  };
}
