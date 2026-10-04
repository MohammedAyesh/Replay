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
export function passEvents(
  touches: Touch[],
  pick: TeamPick | null,
  classifyTeam?: (touch: Touch) => number | null,
): Array<PlayEvent | null> {
  const events: Array<PlayEvent | null> = [];
  for (let i = 0; i < touches.length - 1; i++) {
    const u = touches[i];
    const v = touches[i + 1];
    const gap = v.t - u.t;
    if (gap <= 0 || gap > PASS.maxGapSeconds) { events.push(null); continue; }
    const fromTeam = classifyTeam ? classifyTeam(u) : teamOf(u, pick)?.team ?? null;
    const toTeam = classifyTeam ? classifyTeam(v) : teamOf(v, pick)?.team ?? null;
    const sameTeam = fromTeam !== null && toTeam !== null && fromTeam === toTeam;
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
  /**
   * goals.py's time for a goal it inferred is when PLAY STOPPED, not when the
   * ball went in: on rec 392 that was 4-15 s late (64:24.9 -> 64:29, 67:31 ->
   * 67:40, 80:09 -> 80:24), and inplay.py marks the kick-off wait itself as a
   * stoppage, so one more "goal" lands seconds before the kick-off (31:10). The
   * 8 s scorer window then found the player fetching the ball from the net or
   * taking the kick-off. So the moment is searched for: the ball's last entry
   * into a goal mouth up to this long before goals.py's time, seconds.
   */
  lookbackSeconds: 20,
  /** "in the mouth": a ball sample this close to a goal line on the pitch side, metres... */
  mouthDepthMetres: 1.5,
  /** ...or up to this far behind it (in the net)... */
  netMetres: 3,
  /** ...and this close to the middle of the goal line, metres (camera error included) */
  mouthHalfWidthMetres: 5,
  /** mouth samples with nothing seen between them are one visit unless this far apart, seconds */
  spellGapSeconds: 5,
  /** a goal is answered by a restart from the halfway line within this long, seconds */
  restartSeconds: 90,
} as const;

/**
 * The restart after a goal: the ball set down on the halfway line. Only the
 * line (x) is tested, not the spot: on cam1's live calibration the centre spot
 * projects 5 m off the pitch's middle (to y = 4.8 of 20), so a fixed spot is
 * missed while a spare ball lying 3.5 m off the line is not.
 */
export const RESTART = {
  /** the ball this close to the halfway line, metres... */
  halfwayMetres: 3,
  /** ...staying within this of where it was set down, metres... */
  stillMetres: 1,
  /** ...for at least this long, seconds */
  seconds: 1.5,
  /** samples further apart than this break the spell, seconds */
  gapSeconds: 3,
} as const;

/** A ball position on the pitch, metres, on the tracking clock. */
export type BallPoint = { t: number; p: [number, number] };

/** What `detectedGoals` needs beyond the touches: the ball's positions and when play ended. */
export type GoalContext = { ball?: BallPoint[]; ends?: number[] };

/** The goal context of a loaded recording: every ball sample, and the end of each stretch of game and of the recording. */
export function goalContext(play: {
  manifest: Pick<TrackingManifest, "width" | "height" | "pitchModel" | "frameRate" | "duration">;
  sidecars?: Array<BallSidecar | null> | null;
  phases?: Array<{ kind: string; start: number; end: number }> | null;
}): GoalContext {
  const ends = (play.phases ?? []).filter((p) => p.kind === "game").map((p) => p.end);
  if (play.manifest.duration > 0) ends.push(play.manifest.duration);
  return { ball: ballOnPitch(play.manifest, play.sidecars), ends };
}

const ballCache = new WeakMap<object, BallPoint[]>();

/** Every ball-tracker sample of the sidecars on the pitch, metres, by time. Empty without a pitch model. */
export function ballOnPitch(
  manifest: Pick<TrackingManifest, "width" | "height" | "pitchModel" | "frameRate">,
  sidecars: Array<BallSidecar | null> | null | undefined,
): BallPoint[] {
  if (!sidecars) return [];
  const hit = ballCache.get(sidecars);
  if (hit) return hit;
  const out: BallPoint[] = [];
  const fps = manifest.frameRate > 0 ? manifest.frameRate : 20;
  if (manifest.pitchModel) {
    for (const sc of sidecars) {
      for (const [f, x, y] of sc?.ball ?? []) {
        const p = interpolatePitchPosition(x, y, manifest as TrackingManifest);
        if (p) out.push({ t: f / fps, p: [p.x, p.y] });
      }
    }
  }
  out.sort((a, b) => a.t - b.t);
  ballCache.set(sidecars, out);
  return out;
}

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
  /**
   * A keeper who stands further out is known by where he spends the spell:
   * a track with at least `spellTouches` touches within `spellSeconds` of the
   * shot, `spellShare` of them in the goal area being attacked, spread over at
   * least `spellSpanSeconds` (so three touches in one scramble do not make a
   * keeper). On recording 392 the rush goalie took the ball 3 m out, beyond
   * `lineMetres`, and was credited with the shot he was receiving; 8 of his
   * 10 touches that minute were in his own goal area. The match's real
   * keepers sit at 95-100%.
   */
  spellSeconds: 60,
  spellTouches: 3,
  spellShare: 0.75,
  spellSpanSeconds: 10,
} as const;

export const STRIKE = {
  /**
   * The goal area: this deep from the goal line and this far either side of
   * its middle, metres. A touch in it is a finish, a save, a block or a
   * scramble, and is only credited as the shot when the ball came to it from
   * outside the area.
   */
  areaDepthMetres: 5,
  areaHalfWidthMetres: 7,
  /**
   * A touch this close to the goal line, met by a ball that was already
   * heading into the mouth from further out, is a save or a block: the shot
   * was the earlier touch's. (Rec 392, 56:56: a shot from 9 m was credited to
   * the player it reached 1.6 m off the line.)
   */
  deflectMetres: 2.5,
  /**
   * ...and the ball reached it at least this fast, m/s (about 43 km/h): a
   * shot. A slower ball is a pass, and the touch on it the finish (the 19 Sep
   * game's real close-range shooters, 1.7 m out).
   */
  shotSpeed: 12,
  /** "heading into the mouth": the line through the two touches crosses the goal line this close to its middle, metres */
  mouthHalfWidthMetres: 4,
  /** ...and the later touch is at least this much nearer the goal line, metres */
  approachMetres: 1,
  /** a touch more than this long before the next one is not the ball that reached it, seconds */
  flightSeconds: 3,
  /**
   * No shot flies faster than this, m/s (about 115 km/h). A "striker" whose
   * ball would have had to go faster to reach the goal mouth when it did did
   * not strike it: the ball tracker jumped (rec 392, 68:24: a spare ball
   * lying in the goal) or the real striker was not seen. Credit goes to
   * nobody rather than to him.
   */
  maxBallSpeed: 32,
} as const;

export const KICKOFF = {
  /**
   * A shot "on target" this soon after a goal, with the ball at the centre
   * spot just before it, is the kick-off -- the ball tracker or goals.py saw
   * a ball in a goal mouth (often the one just scored, or a spare) while the
   * game restarted (rec 392, 68:24). It is dropped.
   */
  afterGoalSeconds: 120,
  /** the centre-spot touch is this close to the spot, metres... */
  radiusMetres: 3,
  /** ...and this long before the shot at most, seconds */
  leadSeconds: 4,
} as const;

/** Touches with t in [from, to], by binary search (touches are sorted by frame). */
function touchesBetween(touches: Touch[], from: number, to: number): Touch[] {
  let lo = 0;
  let hi = touches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (touches[mid].t < from) lo = mid + 1; else hi = mid;
  }
  const out: Touch[] = [];
  for (let k = lo; k < touches.length && touches[k].t <= to; k++) out.push(touches[k]);
  return out;
}

/**
 * Which goal the event happened at: the end nearest the ball among the
 * touches within 1.5 s of it (the ball is in, or arriving at, a goal mouth),
 * else nearest the latest touch before it.
 */
function attackedGoalX(touches: Touch[], t: number, fallback: Touch | undefined, pitch: PitchSize): number | null {
  let best: { d: number; x: number } | null = null;
  for (const c of touchesBetween(touches, t - 1.5, t + 1.5)) {
    const p = c.ball ?? c.foot;
    if (!p) continue;
    for (const x of [0, pitch.length]) {
      const d = Math.abs(p[0] - x);
      if (!best || d < best.d) best = { d, x };
    }
  }
  if (best) return best.x;
  const at = fallback?.foot ?? fallback?.ball ?? null;
  return at ? (at[0] < pitch.length / 2 ? 0 : pitch.length) : null;
}

/**
 * Who struck it, walking back from the event through the touches in the
 * window (newest first). The rules, from recording 392 (first real match,
 * 2026-10-04) and the 19 Sep game:
 *
 *   1. Never the goalkeeper. A keeper is a track with a touch in the goal
 *      mouth at the end being attacked (KEEPER.lineMetres), or one who spent
 *      the spell in that goal area (KEEPER.spell*). Every touch of his is
 *      skipped. Shirt colour is not used: a keeper's kit often looks like the
 *      attackers' and it took real shooters' credit away.
 *   2. A touch outside the goal area is the strike.
 *   3. A touch inside the goal area is the strike only if the ball came to it
 *      from outside the area (a pass or cross finished from close in) --
 *      unless it was within STRIKE.deflectMetres of the line and the ball was
 *      already flying into the mouth at shot speed: then it was a save or a
 *      block, that track is skipped and the earlier touch is the strike.
 *   4. If the ball reached it from another touch inside the area, it was a
 *      scramble and nobody can be named.
 *   5. The ball must be able to get from the striker to the goal mouth in
 *      time (STRIKE.maxBallSpeed); otherwise nobody is named.
 *
 * Without a pitch model this falls back to the plain last touch.
 */
function strikerBefore(touches: Touch[], t: number, window: number, pitch: PitchSize | null): Touch | null {
  const candidates = touchesBetween(touches, t - window, t + 0.5).reverse();
  if (!candidates.length) return null;
  if (!pitch) return candidates[0];
  const goalX = attackedGoalX(touches, t, candidates[0], pitch);
  if (goalX === null) return candidates[0];
  const mid = pitch.width / 2;
  const depth = (p: [number, number]) => Math.abs(p[0] - goalX);
  const inArea = (c: Touch) => {
    const p = c.foot ?? c.ball;
    return !!p && depth(p) <= STRIKE.areaDepthMetres && Math.abs(p[1] - mid) <= STRIKE.areaHalfWidthMetres;
  };
  const inMouth = (c: Touch) => !!c.foot
    && depth(c.foot) <= KEEPER.lineMetres
    && Math.abs(c.foot[1] - mid) <= KEEPER.halfWidthMetres;
  const skipped = new Set(candidates.filter(inMouth).map((c) => c.trackId));
  const spellKeeper = (trackId: string): boolean => {
    const spell = touchesBetween(touches, t - KEEPER.spellSeconds, t + KEEPER.spellSeconds).filter((c) => c.trackId === trackId && (c.foot ?? c.ball));
    if (spell.length < KEEPER.spellTouches || spell[spell.length - 1].t - spell[0].t < KEEPER.spellSpanSeconds) return false;
    return spell.filter(inArea).length >= KEEPER.spellShare * spell.length;
  };
  const keeperChecked = new Map<string, boolean>();
  const isKeeper = (trackId: string) => {
    if (skipped.has(trackId)) return true;
    if (!keeperChecked.has(trackId)) keeperChecked.set(trackId, spellKeeper(trackId));
    return keeperChecked.get(trackId)!;
  };
  // the ball reached the goal mouth here: the first save/block touch after the strike, else the event itself
  const reached = (striker: Touch): { t: number; at: [number, number] } | null => {
    const after = touchesBetween(touches, striker.t + 0.01, t + 0.5)
      .find((c) => c.trackId !== striker.trackId && inArea(c) && (c.ball ?? c.foot));
    if (after) return { t: after.t, at: (after.ball ?? after.foot)! };
    const p = striker.ball ?? striker.foot;
    return p ? { t, at: [goalX, Math.min(Math.max(p[1], mid - STRIKE.mouthHalfWidthMetres), mid + STRIKE.mouthHalfWidthMetres)] } : null;
  };
  const plausible = (striker: Touch): Touch | null => {
    const p = striker.ball ?? striker.foot;
    const r = reached(striker);
    // a touch at (or after) the moment the ball was seen there cannot be timed: no verdict
    if (!p || !r || r.t - striker.t < 0.25) return striker;
    const metres = Math.hypot(r.at[0] - p[0], r.at[1] - p[1]);
    return metres <= STRIKE.maxBallSpeed * (r.t - striker.t) ? striker : null;
  };
  /** the ball from p to q was heading into the goal mouth */
  const goalward = (p: [number, number], q: [number, number]) => {
    if (depth(q) > depth(p) - STRIKE.approachMetres) return false;
    const y = q[1] + ((q[1] - p[1]) * depth(q)) / (depth(p) - depth(q));
    return Math.abs(y - mid) <= STRIKE.mouthHalfWidthMetres;
  };
  for (let k = 0; k < candidates.length; k++) {
    const c = candidates[k];
    if (isKeeper(c.trackId)) continue;
    if (!inArea(c)) return plausible(c);
    // the start of this player's run of touches, and the touch the ball came from before it
    let first = k;
    while (first + 1 < candidates.length && candidates[first + 1].trackId === c.trackId) first++;
    const c0 = candidates[first];
    const before = touchesBetween(touches, c0.t - STRIKE.flightSeconds, c0.t - 0.01).reverse().find((x) => x.trackId !== c.trackId) ?? null;
    if (!before) return plausible(c);
    const from = before.ball ?? before.foot;
    const to = c0.ball ?? c0.foot;
    // the ball came from inside the area: off the keeper (a rebound) the touch is the strike, off anyone
    // else it was a scramble and nobody can say who struck it
    if (inArea(before)) return isKeeper(before.trackId) ? plausible(c) : null;
    const near = c0.foot ?? c0.ball;
    const fast = !!from && !!to && Math.hypot(to[0] - from[0], to[1] - from[1]) >= STRIKE.shotSpeed * (c0.t - before.t);
    if (from && to && near && depth(near) <= STRIKE.deflectMetres && fast && goalward(from, to)) {
      skipped.add(c.trackId); // a save or a block: the strike was earlier
      k = first;
      continue;
    }
    return plausible(c);
  }
  return null;
}

/**
 * Goals the detector saw, each at the moment the ball went in and with the
 * player who scored it (never the goalkeeper).
 *
 * With a pitch model and ball positions (the sidecar samples, `ballOnPitch`,
 * plus the touches' own ball positions), a goals.py goal counts only when:
 *   1. a restart from the halfway line (RESTART) follows it within
 *      GOAL.restartSeconds -- what answers a goal and nothing else does
 *      (rec 392: 53:06 and 53:19 were a scramble and a keeper walking out);
 *   2. the ball was seen entering a goal mouth: the latest visit up to
 *      GOAL.lookbackSeconds before goals.py's time, and not followed by the ball
 *      going to the other goal's area before it. Its start is the goal's time,
 *      and the scorer is the strike before it (`strikerBefore`).
 * goals.py events answered by the same restart are one goal; the first of them
 * (in time) that finds the ball's entry sets it -- a later one sees the ball
 * being fetched out of the net. Search never goes back past the previous
 * restart. Goals that no restart answers, or whose ball was never seen in a
 * mouth, are dropped.
 *
 * The end of a stretch of game or of the recording (`context.ends`) answers a
 * goal too: the last goal before full time has no kick-off after it.
 *
 * Without a pitch model or any ball position: the old rule (events within
 * GOAL.mergeSeconds merged to the last, the last touch before it credited).
 */
export function detectedGoals(events: BundleEvent[], touches: Touch[], pitch: PitchSize | null = null, context: GoalContext = {}): DetectedGoal[] {
  const samples = pitch ? ballSamples(context.ball ?? [], touches) : [];
  if (!pitch || !samples.length) {
    return mergedGoalTimes(events).map((t) => credit(t, touches, pitch));
  }
  const raw = events.filter((e) => e.type.toLowerCase() === "goal").map((e) => e.t).sort((a, b) => a - b);
  const restarts = halfwayRests(samples, pitch);
  // the end of a stretch of game (or of the recording) answers the last goal before it
  const answers: Array<[number, number]> = [...restarts, ...(context.ends ?? []).map((e): [number, number] => [e, e])]
    .sort((a, b) => a[0] - b[0]);
  const groups = new Map<number, number[]>();
  for (const t of raw) {
    const k = answers.findIndex(([start]) => start >= t - 2 && start <= t + GOAL.restartSeconds);
    if (k < 0) continue;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const out: DetectedGoal[] = [];
  for (const [k, times] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const [kickoff] = answers[k];
    // never look back past the restart that answered the previous goal
    const floor = restarts.reduce((m, [, end]) => (end < times[0] - 2 && end > m ? end : m), -Infinity);
    let at: number | null = null;
    for (const t of times) {
      at = entryIntoMouth(samples, Math.max(t - GOAL.lookbackSeconds, floor), Math.min(t + 1, kickoff), pitch);
      if (at !== null) break;
    }
    if (at !== null) out.push(credit(at, touches, pitch));
  }
  return out;
}

function credit(t: number, touches: Touch[], pitch: PitchSize | null): DetectedGoal {
  const touch = strikerBefore(touches, t, GOAL.scorerSeconds, pitch);
  return { t, trackId: touch?.trackId ?? null, kit: touch?.kit ?? null, lead: touch ? round1(t - touch.t) : null, touchF: touch?.f ?? null };
}

/** The ball tracker's samples and the touches' ball positions together, by time. */
function ballSamples(ball: BallPoint[], touches: Touch[]): BallPoint[] {
  const out = ball.slice();
  for (const c of touches) if (c.ball) out.push({ t: c.t, p: c.ball });
  return out.sort((a, b) => a.t - b.t);
}

/** [start, end] of every spell of the ball set down on the halfway line (RESTART), seconds. */
function halfwayRests(samples: BallPoint[], pitch: PitchSize): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < samples.length;) {
    const { t, p } = samples[i];
    if (Math.abs(p[0] - pitch.length / 2) > RESTART.halfwayMetres || p[1] < 0 || p[1] > pitch.width) { i++; continue; }
    let j = i;
    while (j + 1 < samples.length
      && samples[j + 1].t - samples[j].t <= RESTART.gapSeconds
      && Math.hypot(samples[j + 1].p[0] - p[0], samples[j + 1].p[1] - p[1]) <= RESTART.stillMetres) j++;
    if (samples[j].t - t >= RESTART.seconds) { out.push([t, samples[j].t]); i = j + 1; } else i++;
  }
  return out;
}

/**
 * When the ball last went into a goal mouth in [from, to]: the start of the
 * latest spell of samples in a mouth. Null when there was none, or when the
 * ball was in the other goal's area after it (that visit was not the goal).
 */
function entryIntoMouth(samples: BallPoint[], from: number, to: number, pitch: PitchSize): number | null {
  const mid = pitch.width / 2;
  const mouthOf = (p: [number, number]): number | null => {
    for (const x of [0, pitch.length]) {
      const depth = x === 0 ? p[0] : pitch.length - p[0];
      if (depth >= -GOAL.netMetres && depth <= GOAL.mouthDepthMetres && Math.abs(p[1] - mid) <= GOAL.mouthHalfWidthMetres) return x;
    }
    return null;
  };
  let last: { start: number; end: number; goalX: number } | null = null;
  let open = false;
  for (const s of samples) {
    if (s.t < from) continue;
    if (s.t > to) break;
    const g = mouthOf(s.p);
    if (g === null) { open = false; continue; }
    if (open && last && last.goalX === g && s.t - last.end <= GOAL.spellGapSeconds) last.end = s.t;
    else last = { start: s.t, end: s.t, goalX: g };
    open = true;
  }
  if (!last) return null;
  const other = pitch.length - last.goalX;
  const away = samples.some((s) => s.t > last!.end && s.t <= to
    && Math.abs(s.p[0] - other) <= STRIKE.areaDepthMetres && Math.abs(s.p[1] - mid) <= STRIKE.areaHalfWidthMetres);
  return away ? null : last.start;
}

function mergedGoalTimes(events: BundleEvent[]): number[] {
  const goals = events.filter((e) => e.type.toLowerCase() === "goal").map((e) => e.t).sort((a, b) => a - b);
  const merged: number[] = [];
  for (const t of goals) {
    if (merged.length && t - merged[merged.length - 1] <= GOAL.mergeSeconds) merged[merged.length - 1] = t;
    else merged.push(t);
  }
  return merged;
}

/** The restart after a goal: the ball at the centre spot shortly after one (KICKOFF). */
function isKickoff(t: number, goals: number[], touches: Touch[], pitch: PitchSize | null): boolean {
  if (!pitch || !goals.some((g) => g < t && t - g <= KICKOFF.afterGoalSeconds)) return false;
  return touchesBetween(touches, t - KICKOFF.leadSeconds, t).some((c) => {
    const p = c.ball ?? c.foot;
    return !!p && Math.hypot(p[0] - pitch.length / 2, p[1] - pitch.width / 2) <= KICKOFF.radiusMetres;
  });
}

/**
 * Shots on target (the ball seen inside a goal mouth), each with the player
 * who struck it -- never the goalkeeper, and nobody when no touch can have
 * been the strike. Kick-offs read as shots are dropped.
 */
export function detectedShots(events: BundleEvent[], touches: Touch[], pitch: PitchSize | null = null): DetectedShot[] {
  const goals = events.filter((e) => e.type.toLowerCase() === "goal").map((e) => e.t);
  return events
    .filter((e) => e.type.toLowerCase() === "shot")
    .sort((a, b) => a.t - b.t)
    .filter((e) => !isKickoff(e.t, goals, touches, pitch))
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
