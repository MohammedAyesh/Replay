import type { Game } from "./model";
import { toPitch } from "./pitch";

/**
 * Touches, passes and teams, as the server resolves them
 * (GET /recordings/:id/claim-match/game/play, api-server lib/matchPlay.ts).
 * The server is the one place a pass is defined, so this page, the match page
 * and the reel all count the same passes.
 */

export type Lab = [number, number, number];

export type PlayPass = {
  give: boolean;
  completed: boolean;
  metres: number;
  f0: number;
  f1: number;
  t0: number;
  t1: number;
  from: [number, number] | null;
  to: [number, number] | null;
  otherTrackId: string;
  trackId: string;
};

export type PlayTeamStats = {
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

export type Play = {
  available: boolean;
  hasPitch: boolean;
  hasKits: boolean;
  fps: number;
  kits: Array<{ lab: Lab; secs: number }>;
  ownKit: Lab | null;
  teams: { a: Lab; b: Lab; source: "query" | "saved" | "seeded" | null } | null;
  team: PlayTeamStats | null;
  totals: { touches: number; rejected: { noTrack: number; tooFar: number } };
  rule: { passMetres: number; contestMetres: number; maxGapSeconds: number };
  mine: {
    touches: Array<{ f: number; t: number; trackId: string; ball: [number, number] | null; foot: [number, number] | null }>;
    passes: PlayPass[];
    passesTried: number;
    passesCompleted: number;
    passesReceived: number;
  };
};

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export async function fetchPlay(recordingId: number, pick?: { a: Lab; b: Lab } | null): Promise<Play | null> {
  const q = pick ? `?a=${pick.a.map((v) => v.toFixed(1)).join(",")}&b=${pick.b.map((v) => v.toFixed(1)).join(",")}` : "";
  const r = await fetch(`${basePath}/api/recordings/${recordingId}/claim-match/game/play${q}`, { credentials: "include" });
  return r.ok ? ((await r.json()) as Play) : null;
}

/* ------------------------------------------------------------------ the ball */

type BallTrack = Array<[number, number, number, number]>; // [tracking s, X m, Y m, trusted 0|1]

const ballCache = new Map<string, Promise<BallTrack | null>>();

/** A ball on the ground can't cover more than this per second; faster means it was in the air. */
const GROUND_MAX_MPS = 12;

/**
 * The segment's 4 Hz ball path on the pitch, flagged where its ground
 * projection can be trusted (the prototype's add_touches.ball_track rule).
 */
export function loadBall(recordingId: number, game: Game, k: number): Promise<BallTrack | null> {
  const key = `${recordingId}:${k}`;
  let hit = ballCache.get(key);
  if (!hit) {
    hit = fetch(`${basePath}/api/recordings/${recordingId}/claim-match/ball/${k}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((sc: { fps?: number; ball?: Array<[number, number, number]> } | null) => {
        if (!sc?.ball?.length || !game.pitch) return null;
        const fps = sc.fps || game.frameRate || 20;
        const out: BallTrack = sc.ball.map(([f, x, y]) => {
          const [X, Y] = toPitch(game, x, y);
          return [f / fps, X, Y, 1];
        });
        for (let i = 1; i < out.length; i++) {
          const dt = out[i][0] - out[i - 1][0];
          if (dt <= 0 || dt > 0.4) { out[i][3] = 0; continue; }
          if (Math.hypot(out[i][1] - out[i - 1][1], out[i][2] - out[i - 1][2]) / dt > GROUND_MAX_MPS) {
            out[i][3] = 0;
            out[i - 1][3] = 0;
          }
        }
        return out;
      })
      .catch(() => null);
    ballCache.set(key, hit);
  }
  return hit;
}

/** The ball at tracking time t, interpolated; null when the path has a gap there. */
export function ballAt(track: BallTrack | null | undefined, t: number): { X: number; Y: number; ok: boolean } | null {
  if (!track?.length) return null;
  let lo = 0;
  let hi = track.length - 1;
  if (t < track[0][0] - 1 || t > track[hi][0] + 1) return null;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (track[m][0] <= t) lo = m; else hi = m;
  }
  const a = track[lo];
  const b = track[hi];
  if (Math.abs(t - a[0]) > 0.6 && Math.abs(t - b[0]) > 0.6) return null;
  const dt = b[0] - a[0];
  const f = dt > 0 ? Math.min(1, Math.max(0, (t - a[0]) / dt)) : 0;
  return { X: a[1] + (b[1] - a[1]) * f, Y: a[2] + (b[2] - a[2]) * f, ok: !!a[3] && !!b[3] };
}

/* ------------------------------------------------------------------ colour */

/** OpenCV 8-bit Lab -> css rgb, for the kit swatches. */
export function labCss(lab: Lab): string {
  const L = (lab[0] * 100) / 255;
  const a = lab[1] - 128;
  const b = lab[2] - 128;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const f = (t: number) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  const X = f(fx) * 0.95047;
  const Y = f(fy);
  const Z = f(fz) * 1.08883;
  const g = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return `rgb(${g(3.2406 * X - 1.5372 * Y - 0.4986 * Z)},${g(-0.9689 * X + 1.8758 * Y + 0.0415 * Z)},${g(0.0557 * X - 0.204 * Y + 1.057 * Z)})`;
}

export function hexToLab(hex: string): Lab {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex) ?? ["", "888888"];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [((116 * f(Y) - 16) * 255) / 100, 500 * (f(X) - f(Y)) + 128, 200 * (f(Y) - f(Z)) + 128];
}

export function labHex(lab: Lab): string {
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(labCss(lab));
  return m ? `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}` : "#888888";
}

export const sameLab = (p: Lab | null | undefined, q: Lab | null | undefined) =>
  !!p && !!q && Math.abs(p[0] - q[0]) < 0.6 && Math.abs(p[1] - q[1]) < 0.6 && Math.abs(p[2] - q[2]) < 0.6;
