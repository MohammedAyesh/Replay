/**
 * Probable people for one segment (pack_people.py in the analysis pipeline):
 * the prototype's grouping -- every clean detection's colour reading, average
 * linkage under hard cannot-links -- run on the bundle's own tracks. The claim
 * page starts from these groups instead of re-grouping tracks in the browser
 * from six crops each.
 *
 * Stored as its own object beside the segment, like sprites and ball data.
 * Ids are namespaced here ("t7" -> "s3:t7") so they match the stored tracks.
 */

export type PeoplePiece = {
  to: [number, number, number];
  sh: [number, number, number];
  hi: number[];
  hr: number;
  nr: number;
  kit: number;
};

export type PeopleJunction = { a: string; b: string; gap: number; dm: number; d: number; ask: boolean };

export type PeopleGroup = {
  cid: string;
  dur: number;
  team: string | null;
  torso: [number, number, number] | null;
  members: string[];
  junctions: PeopleJunction[];
  nb: Array<[number, string]>;
};

export type PeopleSidecar = { v: 1; pieces: Record<string, PeoplePiece>; groups: PeopleGroup[] };

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const triple = (v: unknown): [number, number, number] | null =>
  Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === "number" && Number.isFinite(x))
    ? [v[0], v[1], v[2]] as [number, number, number]
    : null;

export function parsePeopleSidecar(input: unknown, segmentIndex: number): PeopleSidecar | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const prefix = `s${segmentIndex}:`;
  const ns = (id: unknown) => {
    const s = String(id ?? "");
    return s.startsWith(prefix) ? s : `${prefix}${s}`;
  };
  const pieces: Record<string, PeoplePiece> = {};
  if (raw.pieces && typeof raw.pieces === "object") {
    for (const [id, value] of Object.entries(raw.pieces as Record<string, unknown>)) {
      const p = value as Record<string, unknown>;
      const to = triple(p?.to);
      if (!to || !Array.isArray(p.hi) || p.hi.length !== 32) continue;
      pieces[ns(id)] = {
        to,
        sh: triple(p.sh) ?? [0, 0, 0],
        hi: (p.hi as unknown[]).map((x) => num(x)),
        hr: num(p.hr, 1) > 0 ? num(p.hr, 1) : 1,
        nr: Math.max(0, Math.round(num(p.nr))),
        kit: Math.round(num(p.kit, -1)),
      };
    }
  }
  const groups: PeopleGroup[] = [];
  for (const value of Array.isArray(raw.groups) ? raw.groups : []) {
    const g = value as Record<string, unknown>;
    const members = Array.isArray(g?.members) ? (g.members as unknown[]).map(ns) : [];
    if (!members.length) continue;
    groups.push({
      cid: ns(g.cid ?? members[0]),
      dur: num(g.dur),
      team: typeof g.team === "string" ? g.team : null,
      torso: triple(g.torso),
      members,
      junctions: (Array.isArray(g.junctions) ? g.junctions : []).map((j) => {
        const r = j as Record<string, unknown>;
        return { a: ns(r.a), b: ns(r.b), gap: num(r.gap), dm: num(r.dm), d: num(r.d), ask: Boolean(r.ask) };
      }),
      nb: (Array.isArray(g.nb) ? g.nb : [])
        .filter((x): x is [number, unknown] => Array.isArray(x) && x.length >= 2)
        .map((x) => [num(x[0]), ns(x[1])] as [number, string]),
    });
  }
  if (!groups.length) return null;
  return { v: 1, pieces, groups };
}
