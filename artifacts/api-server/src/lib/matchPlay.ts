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
