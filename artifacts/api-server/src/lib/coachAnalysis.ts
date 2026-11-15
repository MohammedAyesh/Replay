import { coachBoardRosterIds, type CoachAnalysis, type CoachBoard, type CoachPitch, type CoachPlayerAnalysis } from "@workspace/api-zod";
import type { TrackingManifest, TrackingSegmentPayload } from "@workspace/db";

import {
  assignObservedKits,
  bibObservedKits,
  bibPick,
  kitAcrossBib,
  kitOfParts,
  labToHex,
  observedTeamKits,
  sideOfKit,
  type Lab,
  type TeamPick,
} from "./matchPlay";
import type { RecordingPlay } from "./matchPlayLoad";
import { matchTrainingGroups, type MatchRoster } from "./matchRoster";
import { hasUsablePitchModel } from "./pitchModel";

/**
 * What the coach board's analysis tools need beyond the boxes (routes/academyCoach.ts
 * GET …/coach/analysis): the camera's pitch model, so lines and distances are in
 * pitch metres; each tracked player's side by shirt; which end each side attacks;
 * and, for training, the analysis' per-track group and adult flags when the
 * bundle carries them.
 */

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The camera's pitch model as the coach board reads it, or null when this recording has none that fits. */
export function coachPitch(manifest: TrackingManifest): CoachPitch | null {
  const model = manifest.pitchModel;
  if (!model || !hasUsablePitchModel(manifest)) return null;
  const rows = model.grid.length;
  const cols = model.grid[0].length;
  const x: number[] = [];
  const y: number[] = [];
  for (const row of model.grid) for (const p of row) { x.push(r3(p.x)); y.push(r3(p.y)); }
  return {
    calibrationId: (model as { calibrationId?: string }).calibrationId ?? "camera",
    width: model.pitchWidthMetres,
    height: model.pitchHeightMetres,
    rows,
    cols,
    x,
    y,
  };
}

// ── Training flags ──────────────────────────────────────────────────────────

/**
 * Per-track training flags, wherever the bundle carries them: on the segment's
 * tracks (`group`, `adult`), or in a per-track map on the manifest
 * (`training.tracks[trackId]`, the proposed training.json). Track ids are the
 * stored, namespaced ones ("s3:t7"); a map keyed by the raw id is tried too.
 * Nothing here is required: without flags every answer is null.
 */
export type TrackFlags = { group: string | null; adult: boolean | null };

const flagGroup = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim()) return v.trim().slice(0, 40);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};
const flagAdult = (v: unknown): boolean | null => (typeof v === "boolean" ? v : v === 1 ? true : v === 0 ? false : null);

export function trackFlagIndex(manifest: TrackingManifest, segments: ReadonlyArray<TrackingSegmentPayload> | null): Map<string, TrackFlags> {
  const out = new Map<string, TrackFlags>();
  const put = (id: string, raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const r = raw as Record<string, unknown>;
    const group = flagGroup(r.group);
    const adult = flagAdult(r.adult);
    if (group === null && adult === null) return;
    out.set(id, { group, adult });
  };
  for (const segment of segments ?? []) {
    for (const track of segment.tracks) put(track.id, track);
  }
  const training = (manifest as { training?: unknown }).training;
  const tracks = training && typeof training === "object" ? (training as { tracks?: unknown }).tracks : null;
  if (tracks && typeof tracks === "object") {
    for (const [id, raw] of Object.entries(tracks as Record<string, unknown>)) {
      if (!out.has(id)) put(id, raw);
    }
  }
  return out;
}

/** A roster player's flags: the group and adult answer that covers most of his tracked frames. */
export function playerFlags(parts: ReadonlyArray<{ trackId: string; fromFrame: number; toFrame: number }>, index: Map<string, TrackFlags>): TrackFlags {
  if (!index.size) return { group: null, adult: null };
  const groups = new Map<string, number>();
  let adultFrames = 0;
  let childFrames = 0;
  for (const part of parts) {
    const raw = part.trackId.includes(":") ? part.trackId.slice(part.trackId.indexOf(":") + 1) : part.trackId;
    const flags = index.get(part.trackId) ?? index.get(raw);
    if (!flags) continue;
    const frames = Math.max(1, part.toFrame - part.fromFrame);
    if (flags.group) groups.set(flags.group, (groups.get(flags.group) ?? 0) + frames);
    if (flags.adult === true) adultFrames += frames;
    else if (flags.adult === false) childFrames += frames;
  }
  const group = [...groups.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  const adult = adultFrames || childFrames ? adultFrames > childFrames : null;
  return { group, adult };
}

// ── Sides ───────────────────────────────────────────────────────────────────

/**
 * The two shirts, ours first when the line-up binds players (as the academy
 * match stats do: our shirt is what our players wore), else the two the
 * analysis saw most.
 */
export function coachTeamPick(play: RecordingPlay, ourParts: Array<{ trackId: string; fromFrame: number; toFrame: number }>): { pick: TeamPick | null; oursKnown: boolean } {
  if (!play.hasKits) return { pick: null, oursKnown: false };
  const own = ourParts.length ? kitOfParts(ourParts, play.sidecars, play.fps) : null;
  if (own) {
    let other: Lab | null = null;
    const bibKits = play.bib ? bibObservedKits(play.sidecars, play.bib) : null;
    if (bibKits && play.bib) other = kitAcrossBib(own, play.bib, bibKits);
    else {
      const observed = observedTeamKits(play.sidecars);
      if (observed) other = assignObservedKits(observed.kits, [{ measured: own, swatch: null }, { measured: null, swatch: null }])[1];
    }
    if (other) return { pick: bibPick(play.bib, own, other) ?? { a: own, b: other }, oursKnown: true };
  }
  const observed = play.bib ? bibObservedKits(play.sidecars, play.bib) : observedTeamKits(play.sidecars)?.kits ?? null;
  if (!observed) return { pick: null, oursKnown: false };
  return { pick: bibPick(play.bib, observed[0], observed[1]) ?? { a: observed[0], b: observed[1] }, oursKnown: false };
}

/** Which of our sides attacks X = length, sampled through the video (video seconds), merged where it does not change. */
export function attackHighSamples(play: RecordingPlay, pick: TeamPick | null, stepSeconds = 30): Array<[number, 0 | 1 | null]> {
  const direction = play.direction;
  const length = play.manifest.pitchModel?.pitchWidthMetres;
  if (!direction || !length) return [];
  const offset = play.manifest.videoStartSeconds ?? 0;
  const out: Array<[number, 0 | 1 | null]> = [];
  for (let t = 0; t <= play.manifest.duration; t += stepSeconds) {
    const d = direction.attacking(length, t);
    let side: 0 | 1 | null = d;
    if (d !== null && pick) {
      const kit = (direction.kitsAt?.(t) ?? direction.kits)[d];
      side = sideOfKit(kit, pick);
    }
    if (!out.length || out[out.length - 1][1] !== side) out.push([Math.round((t + offset) * 10) / 10, side]);
  }
  return out;
}

/** Effective training flags, preferring explicit match-roster values over track metadata. */
export function trainingRosterFlags(play: RecordingPlay, roster: MatchRoster): Map<string, TrackFlags> {
  if (!roster.training) return new Map();
  const index = trackFlagIndex(play.manifest, play.segments);
  const out = new Map<string, TrackFlags>();
  for (const player of roster.players) {
    const trackFlags = playerFlags(player.parts, index);
    out.set(player.id, {
      group: player.group !== undefined ? flagGroup(player.group) : trackFlags.group,
      adult: player.adult !== undefined ? flagAdult(player.adult) : trackFlags.adult,
    });
  }
  return out;
}

export function buildCoachAnalysis(
  play: RecordingPlay,
  roster: MatchRoster,
  boundRosterIds: ReadonlySet<string>,
  opts: { only?: ReadonlySet<string> } = {},
): CoachAnalysis {
  const isTraining = roster.training !== undefined;
  const ourParts = roster.players.filter((p) => boundRosterIds.has(p.id)).flatMap((p) => p.parts);
  const { pick, oursKnown } = coachTeamPick(play, ourParts);
  const rosterFlags = trainingRosterFlags(play, roster);
  const players: Record<string, CoachPlayerAnalysis> = {};
  const groupFrames = new Map<string, number>();
  const metadataGroups = matchTrainingGroups(roster);
  const groupDetailsById = new Map(metadataGroups.map((group) => [group.id, {
    id: group.id,
    name: group.name,
    color: group.torso ? labToHex(group.torso) : null,
  }]));
  let hasAdults = false;
  for (const p of roster.players) {
    const kit = play.hasKits ? kitOfParts(p.parts, play.sidecars, play.fps) : null;
    const f = rosterFlags.get(p.id) ?? { group: null, adult: null };
    if (f.adult === true) hasAdults = true;
    if (f.group) groupFrames.set(f.group, (groupFrames.get(f.group) ?? 0) + p.minutes);
    if (opts.only && !opts.only.has(p.id)) continue;
    players[p.id] = { side: sideOfKit(kit, pick), kit: kit ? labToHex(kit) : null, group: f.group, adult: f.adult };
  }
  const metadataGroupIds = metadataGroups.map((group) => group.id);
  const groupOrder = new Map(metadataGroupIds.map((id, index) => [id, index]));
  const groupWeights = new Map(metadataGroups.map((group) => [group.id, group.trackMinutes ?? 0]));
  for (const [id, minutes] of groupFrames) groupWeights.set(id, minutes);
  const groups = [...new Set([...metadataGroupIds, ...groupFrames.keys()])]
    .sort((a, b) => (
      (groupWeights.get(b) ?? 0) - (groupWeights.get(a) ?? 0)
      || (groupOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (groupOrder.get(b) ?? Number.MAX_SAFE_INTEGER)
      || a.localeCompare(b)
    ));
  for (const id of groups) {
    if (!groupDetailsById.has(id)) groupDetailsById.set(id, { id, name: id, color: null });
  }
  return {
    pitch: coachPitch(play.manifest),
    kits: pick ? [labToHex(pick.a), labToHex(pick.b)] : null,
    oursKnown,
    attackHigh: attackHighSamples(play, pick),
    players,
    groups,
    groupDetails: groups.map((id) => groupDetailsById.get(id)!),
    isTraining,
    hasAdults: isTraining && hasAdults,
  };
}

// ── Boards ──────────────────────────────────────────────────────────────────

/** Spotlights, offside lines, units and moved players must name players the analysis tracked in this match. */
export function boardForRoster(board: CoachBoard, ctx: { roster: MatchRoster | null }): CoachBoard {
  const known = new Set(ctx.roster?.players.map((p) => p.id) ?? []);
  const out: CoachBoard = {
    ...board,
    spotlights: board.spotlights.filter((s) => known.has(s.rosterId)),
    shapes: board.shapes.filter((s) => s.kind !== "move" || known.has(s.rosterId)),
  };
  if (board.offside) out.offside = board.offside.filter((o) => known.has(o.rosterId));
  if (board.units) {
    out.units = board.units
      .map((u) => ({ ...u, rosterIds: u.rosterIds.filter((id) => known.has(id)) }))
      .filter((u) => u.rosterIds.length >= 2);
  }
  return out;
}

/** The players a family's view of a note may see: the ones it points at, and the side whose lines it shows. */
export function familyRosterIds(board: CoachBoard, sides: Record<string, { side: 0 | 1 | null; group: string | null; adult: boolean | null }> | null): Set<string> {
  const ids = coachBoardRosterIds(board);
  const lines = board.teamLines;
  if (lines && sides) {
    for (const [id, p] of Object.entries(sides)) {
      if (p.adult && !board.showAdults) continue;
      if (lines.group !== undefined ? p.group === lines.group : lines.side !== undefined && p.side === lines.side) ids.add(id);
    }
  }
  return ids;
}
