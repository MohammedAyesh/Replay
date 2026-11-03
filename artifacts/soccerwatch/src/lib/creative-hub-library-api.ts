import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MediaSource } from "@workspace/api-zod";
import { apiUrl, call } from "@/lib/academy-studio-api";
import { creativeKeys, creativePath } from "@/lib/creative-hub-api";

/**
 * Creative hub → Library. Hand-written client for
 * routes/academyCreativeLibrary.ts (owner only). Players arrive already
 * filtered by the academy's "show player names" setting: a first name or
 * nothing, never a full name.
 */

export type RecordingSource = Extract<MediaSource, { type: "recording" }>;
export type FrameSource = Extract<MediaSource, { type: "frame" }>;
export type ClipSource = Extract<MediaSource, { type: "clip" }>;
export type UploadSource = Extract<MediaSource, { type: "upload" }>;
export type RecordingWindow = { recordingId: number; fromMs: number; toMs: number };

export type LibraryPlayer = { number: number | null; firstName: string | null; squad: string | null };

export type LibraryMatch = {
  sessionId: number;
  type: "match" | "training";
  startsAt: string;
  /** Amman day, YYYY-MM-DD, and clock, HH:mm */
  date: string;
  time: string;
  location: string | null;
  opponent: string | null;
  ownScore: number | null;
  opponentScore: number | null;
  squad: { id: number; name: string } | null;
  durationMs: number | null;
  recordingIds: number[];
  recordingId: number | null;
  analysed: boolean;
  still: FrameSource | null;
  thumbnailUrl: string | null;
  /** False for a field's recordings: there is no session to build a whole-match post from. */
  wholeMatch?: boolean;
};

export type LibraryMomentType = "goal" | "chance" | "highlight" | "saved";
export const LIBRARY_MOMENT_TYPES: LibraryMomentType[] = ["goal", "chance", "highlight", "saved"];

export type LibraryMoment = {
  id: string;
  type: LibraryMomentType;
  recordingId: number;
  window: RecordingWindow;
  atMs: number;
  durationMs: number;
  minute: number | null;
  player: LibraryPlayer | null;
  ours: boolean | null;
  ownGoal: boolean;
  title: string | null;
  clipId: number | null;
  source: RecordingSource;
  still: FrameSource;
  thumbnailUrl: string | null;
};

export type LibraryMoments = {
  sessionId: number;
  analysis: "ready" | "none" | "failed";
  recordingIds: number[];
  counts: Record<LibraryMomentType, number>;
  moments: LibraryMoment[];
  total: number;
  nextOffset: number | null;
};

export type LibraryClip = {
  clipId: number;
  title: string | null;
  status: "ready" | "processing" | "failed" | "expired" | "live";
  aspectRatio: "16:9" | "9:16";
  createdAt: string;
  date: string;
  durationMs: number;
  sessionId: number | null;
  source: ClipSource;
  window: RecordingWindow | null;
  still: FrameSource | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  /** A field's clips: cut by a player, or made by Replay from the match analysis. */
  origin?: "player" | "auto";
  /** A field's player-made clips: the maker's first name. */
  madeBy?: string | null;
};

export type ClipOrigin = "player" | "auto";

export type LibraryUpload = {
  mediaId: number;
  kind: "image" | "video";
  name: string;
  status: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  createdAt: string;
  source: UploadSource;
  thumbnailUrl: string | null;
  videoUrl: string | null;
};

/** A photo in a player's gallery (academy console → Players). `url` is an API path. */
export type PlayerPhoto = {
  photoId: number;
  playerId: number;
  width: number;
  height: number;
  /** a cut-out: transparent background */
  transparent: boolean;
  label: string | null;
  isPrimary: boolean;
  createdAt: string;
  url: string;
};

export type LibraryPlayers = {
  showNames: boolean;
  squads: Array<{ id: number; name: string }>;
  /** `photo`: the primary photo, only when the academy shows names. */
  players: Array<LibraryPlayer & { playerId: number; squadId: number | null; position?: string | null; photo?: PlayerPhoto | null }>;
};

/** GET …/creative/library/players/:playerId/media: the Player picker's gallery. */
export type LibraryPlayerMedia = {
  showNames: boolean;
  player: LibraryPlayer & { playerId: number; squadId: number | null; position: string | null };
  /** his linked account has an avatar (used when he has no photo) */
  hasAvatar: boolean;
  /** empty unless the academy shows names */
  photos: Array<PlayerPhoto & { source: Extract<MediaSource, { type: "player-photo" }> }>;
  clips: Array<{ clipId: number; title: string | null; date: string; durationMs: number; source: ClipSource; thumbnailUrl: string | null }>;
  moments: Array<LibraryMoment & { sessionId: number }>;
};

export type LibraryFilter = {
  squadId?: number | null;
  /** shirt number */
  player?: number | null;
  types?: LibraryMomentType[];
  /** Amman days, YYYY-MM-DD */
  from?: string | null;
  to?: string | null;
  kind?: "image" | "video" | null;
  origin?: ClipOrigin | null;
};

function qs(f: LibraryFilter, offset: number, limit: number): string {
  const p = new URLSearchParams();
  if (f.squadId) p.set("squadId", String(f.squadId));
  if (f.player !== null && f.player !== undefined) p.set("player", String(f.player));
  if (f.types?.length) p.set("type", f.types.join(","));
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.kind) p.set("kind", f.kind);
  if (f.origin) p.set("origin", f.origin);
  p.set("offset", String(offset));
  p.set("limit", String(limit));
  return p.toString();
}

const libraryKey = (academyId: number, ...rest: unknown[]) => [...creativeKeys.all(academyId), "library", ...rest] as const;

type Page = { total: number; nextOffset: number | null };

function usePaged<T extends Page>(academyId: number, name: string, path: string, f: LibraryFilter, limit: number, enabled = true) {
  return useInfiniteQuery({
    queryKey: libraryKey(academyId, name, path, f),
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => call<T>(creativePath(academyId, `${path}?${qs(f, pageParam, limit)}`)),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });
}

export function useLibraryMatches(academyId: number, f: LibraryFilter) {
  const q = usePaged<Page & { matches: LibraryMatch[] }>(academyId, "matches", "/library/matches", { squadId: f.squadId, player: f.player, from: f.from, to: f.to }, 24);
  return { ...q, items: q.data?.pages.flatMap((p) => p.matches) ?? [] };
}

export function useLibraryMoments(academyId: number, sessionId: number | null, f: LibraryFilter) {
  const q = usePaged<LibraryMoments>(academyId, "moments", `/library/matches/${sessionId ?? 0}/moments`, { types: f.types, player: f.player }, 60, sessionId !== null);
  return { ...q, items: q.data?.pages.flatMap((p) => p.moments) ?? [], first: q.data?.pages[0] ?? null };
}

export function useLibraryClips(academyId: number, f: LibraryFilter) {
  const q = usePaged<Page & { clips: LibraryClip[]; counts?: { all: number; player: number; auto: number } }>(academyId, "clips", "/library/clips", { squadId: f.squadId, from: f.from, to: f.to, origin: f.origin }, 24);
  return { ...q, items: q.data?.pages.flatMap((p) => p.clips) ?? [], counts: q.data?.pages[0]?.counts ?? null };
}

export function useLibraryUploads(academyId: number, f: LibraryFilter) {
  const q = usePaged<Page & { uploads: LibraryUpload[] }>(academyId, "uploads", "/library/uploads", { kind: f.kind, from: f.from, to: f.to }, 30);
  return { ...q, items: q.data?.pages.flatMap((p) => p.uploads) ?? [] };
}

export function useLibraryPlayers(academyId: number) {
  return useQuery({
    queryKey: libraryKey(academyId, "players"),
    staleTime: 60_000,
    queryFn: () => call<LibraryPlayers>(creativePath(academyId, "/library/players")),
  });
}

export function useLibraryPlayerMedia(academyId: number, playerId: number | null) {
  return useQuery({
    queryKey: libraryKey(academyId, "player-media", playerId ?? 0),
    enabled: playerId !== null,
    staleTime: 30_000,
    queryFn: () => call<LibraryPlayerMedia>(creativePath(academyId, `/library/players/${playerId}/media`)),
  });
}

export function useUploadLibraryMedia(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, name, width, height }: { file: Blob; name: string; width?: number; height?: number }) => {
      const form = new FormData();
      form.append("name", name);
      if (width) form.append("width", String(width));
      if (height) form.append("height", String(height));
      form.append("file", file, name || "upload");
      return call<{ upload: LibraryUpload }>(creativePath(academyId, "/library/uploads"), { method: "POST", body: form }).then((r) => r.upload);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: libraryKey(academyId, "uploads") });
      // Ads → Media lists the same rows.
      void qc.invalidateQueries({ queryKey: ["academy-ad-media", academyId] });
    },
  });
}

/** A server path ("/api/…") or an absolute URL, as something <img>/<video> can load. */
export function browserUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.startsWith("/api/") ? apiUrl(path) : path;
}
