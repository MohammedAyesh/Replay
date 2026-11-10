import * as z from "zod";

/**
 * Coach board (academy console → Matches → Coach view): what a coach draws over
 * a match and which players he spotlights. The same document is drawn live in
 * the player and saved with a note (academy_coach_notes.board), so a saved
 * moment comes back exactly as it was drawn.
 *
 * Points are shares of the camera frame (the panorama): x and y in 0..1, so a
 * drawing stays on the pitch whatever the zoom, the screen or the rendition.
 * Times are milliseconds into the recording's video (the player's clock).
 */

/** Pen colours: Floodlight, Turf, live red, Stoppage violet, white, amber. */
export const COACH_COLORS = ["#D4FF4F", "#2FD8C4", "#FF5A3C", "#7B5CFF", "#FFFFFF", "#FFC23C"] as const;
export const COACH_WIDTHS = [2, 4, 7] as const;
export const COACH_MAX_SHAPES = 60;
export const COACH_MAX_SPOTLIGHTS = 6;
/** How long a drawing stays on screen around the moment it was drawn when the video plays, ms. */
export const COACH_SHAPE_HOLD_MS = 900;

const share = z.number().min(-0.5).max(1.5);
const point = z.tuple([share, share]);
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const width = z.number().min(1).max(12);
const common = { id: z.string().min(1).max(40), color, atMs: z.number().int().min(0).max(24 * 3600_000) };

export const coachShapeSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("pen"), width, points: z.array(point).min(2).max(400) }),
  z.object({ ...common, kind: z.literal("arrow"), width, from: point, to: point, dashed: z.boolean().optional() }),
  z.object({ ...common, kind: z.literal("line"), width, from: point, to: point, dashed: z.boolean().optional() }),
  /** An ellipse inside the box from `from` to `to` (a player's area, a gap). */
  z.object({ ...common, kind: z.literal("circle"), width, from: point, to: point }),
  /** A filled translucent area (a lasso): the space to attack, the zone to hold. */
  z.object({ ...common, kind: z.literal("zone"), points: z.array(point).min(3).max(400) }),
  z.object({ ...common, kind: z.literal("text"), at: point, text: z.string().min(1).max(120), size: z.number().min(10).max(48).optional() }),
]);
export type CoachShape = z.infer<typeof coachShapeSchema>;
export type CoachShapeKind = CoachShape["kind"];

/** A spotlighted player: a match analysis roster id, followed through the video by tracking. */
export const coachSpotlightSchema = z.object({
  rosterId: z.string().min(1).max(64),
  color,
  /** what the label says (a first name, a shirt number); the player shows the roster's own label when absent */
  label: z.string().max(40).optional(),
});
export type CoachSpotlight = z.infer<typeof coachSpotlightSchema>;

/** Where the camera was: zoom (1 = the whole frame) and the centre, as shares. */
export const coachViewSchema = z.object({
  zoom: z.number().min(1).max(8),
  cx: z.number().min(0).max(1),
  cy: z.number().min(0).max(1),
  follow: z.boolean().optional(),
});
export type CoachView = z.infer<typeof coachViewSchema>;

export const coachBoardSchema = z.object({
  v: z.literal(1),
  shapes: z.array(coachShapeSchema).max(COACH_MAX_SHAPES),
  spotlights: z.array(coachSpotlightSchema).max(COACH_MAX_SPOTLIGHTS),
  /** draw lines between the spotlighted players (a unit, a passing lane) */
  connect: z.boolean().optional(),
  /** show the ball and its last second */
  ball: z.boolean().optional(),
  view: coachViewSchema.optional(),
});
export type CoachBoard = z.infer<typeof coachBoardSchema>;

export const EMPTY_COACH_BOARD: CoachBoard = { v: 1, shapes: [], spotlights: [] };

/** A note as it is created or changed (academy console). */
export const coachNoteInputSchema = z.object({
  title: z.string().trim().max(120).default(""),
  body: z.string().trim().max(2000).nullish(),
  atMs: z.number().int().min(0).max(24 * 3600_000),
  endMs: z.number().int().min(0).max(24 * 3600_000).nullish(),
  board: coachBoardSchema,
  playerIds: z.array(z.number().int().positive()).max(40).default([]),
  shared: z.boolean().default(false),
});
export type CoachNoteInput = z.infer<typeof coachNoteInputSchema>;

/** A note as the API returns it. */
export type CoachNote = {
  id: number;
  title: string;
  body: string | null;
  atMs: number;
  endMs: number | null;
  board: CoachBoard;
  playerIds: number[];
  shared: boolean;
  author: string | null;
  mine: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * A tracked box: [video seconds, x, y, w, h], the box's top-left corner and size
 * as shares of the frame.
 */
export type CoachBox = [number, number, number, number, number];
/** The ball: [video seconds, x, y], shares of the frame. */
export type CoachBall = [number, number, number];

/** GET …/coach/tracks: every roster player's boxes and the ball through a window. */
export type CoachTracks = {
  from: number;
  to: number;
  players: Record<string, CoachBox[]>;
  ball: CoachBall[];
};

/** A spotlight never spans a gap in tracking longer than this, seconds. */
export const COACH_MAX_GAP_SECONDS = 1.2;

/**
 * Where a tracked player is at `t` (video seconds): his box between the two
 * samples either side, moved in a straight line. Null when he is not tracked
 * there (before, after, or across a gap longer than COACH_MAX_GAP_SECONDS).
 * `boxes` is sorted by time.
 */
export function coachBoxAt(boxes: ReadonlyArray<CoachBox>, t: number): [number, number, number, number] | null {
  if (!boxes.length || !Number.isFinite(t)) return null;
  let lo = 0;
  let hi = boxes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxes[mid][0] < t) lo = mid + 1; else hi = mid;
  }
  const after = boxes[lo];
  const before = boxes[lo - 1];
  if (after && Math.abs(after[0] - t) < 1e-6) return [after[1], after[2], after[3], after[4]];
  if (!before || !after) {
    const edge = before ?? after;
    // A box just outside the samples still counts (the last sample before a stop).
    return edge && Math.abs(edge[0] - t) <= 0.15 ? [edge[1], edge[2], edge[3], edge[4]] : null;
  }
  const gap = after[0] - before[0];
  if (gap > COACH_MAX_GAP_SECONDS) {
    if (t - before[0] <= 0.15) return [before[1], before[2], before[3], before[4]];
    if (after[0] - t <= 0.15) return [after[1], after[2], after[3], after[4]];
    return null;
  }
  const f = gap > 0 ? (t - before[0]) / gap : 0;
  const mix = (i: 1 | 2 | 3 | 4) => before[i] + (after[i] - before[i]) * f;
  return [mix(1), mix(2), mix(3), mix(4)];
}

/** Where a player stands: the middle of the bottom of his box (his feet), as shares. */
export function coachFeet(box: readonly [number, number, number, number]): [number, number] {
  return [box[0] + box[2] / 2, box[1] + box[3]];
}

/** Whether a drawing shows at `tMs`: the moment it was drawn, give or take COACH_SHAPE_HOLD_MS. */
export function coachShapeVisible(shape: Pick<CoachShape, "atMs">, tMs: number, holdMs = COACH_SHAPE_HOLD_MS): boolean {
  return Math.abs(tMs - shape.atMs) <= holdMs;
}
