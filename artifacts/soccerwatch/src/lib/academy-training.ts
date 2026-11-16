export const TRAINING_SEGMENT_LABELS = [
  "game",
  "multi-ball drill",
  "shooting / queue drill",
  "warm-up",
  "team talk",
  "break",
  "drill",
  "adult game",
  "adults",
  "empty",
] as const;

export type TrainingSegmentLabel = (typeof TRAINING_SEGMENT_LABELS)[number];
export type TrainingSegment = { start: number; end: number; label: TrainingSegmentLabel };
export type TrainingGroup = { id: string; name: string; color: string | null };
export type TrainingGamePlayer = {
  number: string;
  team: string;
  minutes: number | null;
  distance: number | null;
  mPerMin: number | null;
  topKmh: number | null;
  sprints: number | null;
  touches: number | null;
  keeper: boolean;
  shared: boolean;
};
export type TrainingTeamTotal = {
  minutes: number | null;
  distance: number | null;
  touches: number | null;
  numberedShare: number | null;
};
export type TrainingGame = {
  start: number;
  end: number;
  teams: string[];
  teamNames: string[];
  resting: string[];
  players: TrainingGamePlayer[];
  teamTotals: Record<string, TrainingTeamTotal>;
};
export type TrainingSessionData = {
  groups: TrainingGroup[];
  segments: TrainingSegment[];
  games: TrainingGame[];
  ground: string | null;
};
export type TrainingPlayerTotal = TrainingGamePlayer;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function id(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized && normalized.length <= 120 ? normalized : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const normalized = id(entry);
        return normalized ? [normalized] : [];
      })
    : [];
}

function shirtNumber(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim().replace(/^#/, "");
  return /^\d{1,3}$/.test(normalized) ? normalized : null;
}

function labToHex(lab: unknown): string | null {
  if (!Array.isArray(lab) || lab.length < 3 || !lab.slice(0, 3).every((part) => typeof part === "number" && Number.isFinite(part))) return null;
  const L = (lab[0] * 100) / 255;
  const a = lab[1] - 128;
  const b = lab[2] - 128;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (value: number) => (value ** 3 > 0.008856 ? value ** 3 : (value - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047;
  const Y = inv(fy);
  const Z = inv(fz) * 1.08883;
  const gamma = (value: number) => {
    const linear = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, linear)) * 255);
  };
  const channels = [
    gamma(3.2406 * X - 1.5372 * Y - 0.4986 * Z),
    gamma(-0.9689 * X + 1.8758 * Y + 0.0415 * Z),
    gamma(0.0557 * X - 0.204 * Y + 1.057 * Z),
  ];
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function metric(row: Record<string, unknown>, key: string): number | null {
  return finite(row[key]);
}

function parsePlayer(value: unknown): TrainingGamePlayer | null {
  const row = record(value);
  const number = shirtNumber(row.number);
  const team = id(row.team);
  if (!number || !team) return null;
  return {
    number,
    team,
    minutes: metric(row, "minutes"),
    distance: metric(row, "distance"),
    mPerMin: metric(row, "mPerMin"),
    topKmh: metric(row, "topKmh"),
    sprints: metric(row, "sprints"),
    touches: metric(row, "touches"),
    keeper: row.keeper === true,
    shared: row.shared === true,
  };
}

function parseGame(value: unknown): TrainingGame | null {
  const row = record(value);
  const start = finite(row.start);
  const end = finite(row.end);
  if (start === null || end === null || end <= start) return null;
  const players = Array.isArray(row.players) ? row.players.flatMap((player) => {
    const parsed = parsePlayer(player);
    return parsed ? [parsed] : [];
  }) : [];
  const totals: Record<string, TrainingTeamTotal> = {};
  for (const [groupId, raw] of Object.entries(record(row.teamTotals))) {
    const total = record(raw);
    totals[groupId] = {
      minutes: metric(total, "minutes"),
      distance: metric(total, "distance"),
      touches: metric(total, "touches"),
      numberedShare: finite(total.numberedShare),
    };
  }
  return {
    start,
    end,
    teams: strings(row.teams),
    teamNames: strings(row.teamNames),
    resting: strings(row.resting),
    players,
    teamTotals: totals,
  };
}

export function parseTrainingSession(value: unknown): TrainingSessionData {
  const training = record(value);
  const groups: TrainingGroup[] = Array.isArray(training.groups)
    ? training.groups.flatMap((item) => {
        const group = record(item);
        const groupId = id(group.id);
        if (!groupId) return [];
        const color = typeof group.color === "string" && /^#[0-9a-f]{6}$/i.test(group.color)
          ? group.color
          : labToHex(group.torso);
        return [{ id: groupId, name: id(group.name) ?? groupId, color }];
      })
    : [];
  const segments: TrainingSegment[] = Array.isArray(training.segments)
    ? training.segments.flatMap((item) => {
        const segment = record(item);
        const start = finite(segment.start);
        const end = finite(segment.end);
        const label = typeof segment.label === "string"
          ? segment.label.trim().toLowerCase() as TrainingSegmentLabel
          : null;
        if (start === null || end === null || end <= start || !label || !TRAINING_SEGMENT_LABELS.includes(label)) return [];
        return [{ start, end, label }];
      }).sort((a, b) => a.start - b.start || a.end - b.end)
    : [];
  const games: TrainingGame[] = Array.isArray(training.games)
    ? training.games.flatMap((item) => {
        const game = parseGame(item);
        return game ? [game] : [];
      }).sort((a, b) => a.start - b.start || a.end - b.end)
    : [];
  return {
    groups,
    segments,
    games,
    ground: typeof training.ground === "string" ? training.ground.trim() || null : null,
  };
}

/** Sum shirt-number stats across every game, retaining only the team/number identity. */
export function aggregateTrainingGamePlayers(games: TrainingGame[]): TrainingPlayerTotal[] {
  const totals = new Map<string, TrainingPlayerTotal>();
  for (const game of games) {
    for (const player of game.players) {
      const key = `${player.team}\u0000${player.number}`;
      const current = totals.get(key);
      if (!current) {
        totals.set(key, { ...player });
        continue;
      }
      const minutes = (current.minutes ?? 0) + (player.minutes ?? 0);
      const distance = (current.distance ?? 0) + (player.distance ?? 0);
      totals.set(key, {
        number: player.number,
        team: player.team,
        minutes: current.minutes === null && player.minutes === null ? null : minutes,
        distance: current.distance === null && player.distance === null ? null : distance,
        mPerMin: minutes > 0 ? Math.round((distance / minutes) * 10) / 10 : current.mPerMin ?? player.mPerMin,
        topKmh: current.topKmh === null ? player.topKmh : player.topKmh === null ? current.topKmh : Math.max(current.topKmh, player.topKmh),
        sprints: current.sprints === null && player.sprints === null ? null : (current.sprints ?? 0) + (player.sprints ?? 0),
        touches: current.touches === null && player.touches === null ? null : (current.touches ?? 0) + (player.touches ?? 0),
        keeper: current.keeper || player.keeper,
        shared: current.shared || player.shared,
      });
    }
  }
  return [...totals.values()].sort((a, b) => a.team.localeCompare(b.team) || Number(a.number) - Number(b.number) || a.number.localeCompare(b.number));
}

export function numberedSharePercent(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(Math.max(0, Math.min(100, value <= 1 ? value * 100 : value)));
}

/** Segment labels a coach can pick as a part of the session (games come from `games`). */
export const COACH_PART_LABELS: ReadonlySet<TrainingSegmentLabel> = new Set(["multi-ball drill", "shooting / queue drill", "drill", "warm-up"]);
export type CoachPart = { key: string; kind: "game" | "drill"; start: number; end: number; label: TrainingSegmentLabel | "game"; gameIndex: number | null };
/**
 * The parts of a training a coach can narrow the Coach view to: each game, and each drill or warm-up
 * of at least `minSeconds`, joining runs of the same kind split by a gap of up to `joinGap` seconds.
 * In time order.
 */
export function coachParts(training: Pick<TrainingSessionData, "segments" | "games"> | null | undefined, minSeconds = 120, joinGap = 60): CoachPart[] {
  if (!training) return [];
  const drills: CoachPart[] = [];
  for (const s of [...training.segments].sort((a, b) => a.start - b.start)) {
    if (!COACH_PART_LABELS.has(s.label) || !(s.end > s.start)) continue;
    const last = drills[drills.length - 1];
    if (last && last.label === s.label && s.start - last.end <= joinGap) { last.end = Math.max(last.end, s.end); continue; }
    drills.push({ key: "", kind: "drill", start: s.start, end: s.end, label: s.label, gameIndex: null });
  }
  const games: CoachPart[] = training.games.map((g, i) => ({ key: `g${i}`, kind: "game", start: g.start, end: g.end, label: "game", gameIndex: i }));
  return [...games, ...drills.filter((d) => d.end - d.start >= minSeconds)]
    .sort((a, b) => a.start - b.start)
    .map((p) => (p.kind === "drill" ? { ...p, key: `d${Math.round(p.start)}` } : p));
}
