/**
 * The player's end screen choice (what plays after his clip or reel) and
 * highlight reels: the API's shapes and the small rules the sheet follows.
 * See artifacts/api-server/src/lib/clipBranding/plan.ts (endScreenOptions)
 * and src/routes/userReels.ts.
 */

export type EndScreenCardKind = "player" | "match" | "academy" | "signOff";
export type EndScreenStatKey = "goals" | "shotsOnTarget" | "topSpeed" | "distance" | "passes" | "dribbles";

export type EndScreenChoice = {
  card?: "auto" | EndScreenCardKind;
  stats?: EndScreenStatKey[];
};

export type EndScreenOptions = {
  enabled: boolean;
  seconds: number;
  choice: EndScreenChoice;
  /** The card the export uses now, with the stored choice. */
  current: EndScreenCardKind | null;
  /** Switched-on cards in automatic order; `available` = has something to show. */
  cards: Array<{ kind: EndScreenCardKind; available: boolean }>;
  /** Empty when the player has no stats for this match. */
  stats: Array<{ key: EndScreenStatKey; labelEn: string; labelAr: string; value: number | null; unit: string; decimals: number }>;
  rerender?: "rerendering" | "queued" | "unchanged" | "expired";
};

export type ReelStatus = "pending" | "done" | "error" | "expired";

export type UserReel = {
  id: number;
  title: string;
  clipIds: number[];
  aspectRatio: string;
  endScreen: EndScreenChoice;
  status: ReelStatus;
  error: string | null;
  durationSec: number | null;
  createdAt: string;
  updatedAt: string;
};

export const REEL_MIN_CLIPS = 2;
export const REEL_MAX_CLIPS = 10;

/** Numbers that fit on each card: four on the player card, three on the academy card. */
export function maxStatsFor(card: EndScreenCardKind | null): number {
  return card === "academy" ? 3 : 4;
}

/**
 * The card the export will actually use for a given pick: the chosen one if
 * it has something to show, otherwise the first available in automatic order
 * (the server's rule).
 */
export function effectiveCard(
  cards: EndScreenOptions["cards"],
  card: EndScreenChoice["card"],
): EndScreenCardKind | null {
  const chosen = card && card !== "auto" ? cards.find((c) => c.kind === card && c.available) : undefined;
  if (chosen) return chosen.kind;
  return cards.find((c) => c.available)?.kind ?? null;
}

/** Tap a number: add it at the end, or take it off. Never more than `max`. */
export function toggleStat(picked: EndScreenStatKey[], key: EndScreenStatKey, max: number): EndScreenStatKey[] {
  if (picked.includes(key)) return picked.filter((k) => k !== key);
  if (picked.length >= max) return picked;
  return [...picked, key];
}

/** What to send: {} means fully automatic. */
export function choiceBody(card: EndScreenChoice["card"], stats: EndScreenStatKey[]): EndScreenChoice {
  const body: EndScreenChoice = {};
  if (card && card !== "auto") body.card = card;
  if (stats.length) body.stats = stats;
  return body;
}

/** Query string for a preview of a pick. */
export function previewQuery(card: EndScreenChoice["card"], stats: EndScreenStatKey[]): string {
  const p = new URLSearchParams();
  if (card && card !== "auto") p.set("card", card);
  if (stats.length) p.set("stats", stats.join(","));
  return p.toString();
}

/** "9:16" vs everything else, the way the server groups reel clips. */
export function clipShape(aspectRatio: string | null | undefined): "9:16" | "16:9" {
  return aspectRatio === "9:16" ? "9:16" : "16:9";
}

export function formatStatValue(value: number | null, decimals: number, unit: string): string {
  if (value === null) return "—";
  const n = decimals ? value.toFixed(decimals) : String(Math.round(value));
  return unit ? `${n} ${unit}` : n;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `Request failed (${res.status})`;
    throw Object.assign(new Error(message), { status: res.status });
  }
  return body as T;
}

const opts: RequestInit = { credentials: "include" };
const jsonOpts = (method: string, body: unknown): RequestInit => ({
  method,
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const endScreenApi = {
  clipOptions: (clipId: number) => fetch(`/api/user-clips/${clipId}/end-screen`, opts).then(json<EndScreenOptions>),
  saveClip: (clipId: number, choice: EndScreenChoice) =>
    fetch(`/api/user-clips/${clipId}/end-screen`, jsonOpts("PUT", choice)).then(json<EndScreenOptions>),
  clipPreviewUrl: (clipId: number, q: string) => `/api/user-clips/${clipId}/end-screen/preview.png${q ? `?${q}` : ""}`,

  reelOptions: (reelId: number) => fetch(`/api/user-reels/${reelId}/end-screen`, opts).then(json<EndScreenOptions>),
  draftOptions: (clipIds: number[]) =>
    fetch(`/api/user-reels-draft/end-screen?clipIds=${clipIds.join(",")}`, opts).then(json<EndScreenOptions>),
  draftPreviewUrl: (clipIds: number[], q: string) =>
    `/api/user-reels-draft/end-screen/preview.png?clipIds=${clipIds.join(",")}${q ? `&${q}` : ""}`,
};

export const reelApi = {
  list: () => fetch("/api/user-reels", opts).then(json<UserReel[]>),
  get: (id: number) => fetch(`/api/user-reels/${id}`, opts).then(json<UserReel>),
  create: (body: { title: string; clipIds: number[]; endScreen: EndScreenChoice | null }) =>
    fetch("/api/user-reels", jsonOpts("POST", body)).then(json<UserReel>),
  update: (id: number, body: { title?: string; endScreen?: EndScreenChoice | null }) =>
    fetch(`/api/user-reels/${id}`, jsonOpts("PATCH", body)).then(json<UserReel>),
  retry: (id: number) => fetch(`/api/user-reels/${id}/retry`, { method: "POST", credentials: "include" }).then(json<UserReel>),
  remove: async (id: number) => {
    const res = await fetch(`/api/user-reels/${id}`, { method: "DELETE", credentials: "include" });
    if (!res.ok && res.status !== 404) throw new Error(`Delete failed (${res.status})`);
  },
  playbackUrl: (id: number) => `/api/user-reels/${id}/playback`,
  downloadUrl: (id: number) => `/api/user-reels/${id}/download`,
};
