import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MusicMood } from "@workspace/api-zod";
import { apiUrl, call } from "@/lib/academy-studio-api";
import { creativePath } from "@/lib/creative-hub-api";

/**
 * Creative hub → Music. Client for routes/academyCreativeMusic.ts:
 *   GET    …/creative/music?scope=&mood=   Replay's library and the academy's own
 *   POST   …/creative/music                upload (multipart: file, title, artist, mood, bpm, rights)
 *   PATCH  …/creative/music/:id            the academy's own
 *   DELETE …/creative/music/:id            the academy's own
 *   GET    …/creative/music/:id/file       the .m4a (Range), via musicFileUrl
 */

export type MusicTrack = {
  trackId: number;
  /** Bundled Replay tracks: the asset key older designs name them by (scene.music.trackKey). */
  key: string | null;
  scope: "replay" | "academy";
  title: string;
  artist: string | null;
  mood: MusicMood;
  bpm: number | null;
  durationMs: number;
  loudnessLufs: number | null;
  /** ≈200 peaks 0..1. */
  waveform: number[];
  license: string;
  status: "active" | "hidden";
  mine: boolean;
  createdAt: string;
  /** API path; pass through apiUrl() (musicFileUrl does). */
  url: string;
};

export const musicKeys = {
  all: (academyId: number) => ["creative", academyId, "music"] as const,
};

/** Every track the academy may use (Replay's first, then its own). The panel filters locally. */
export function useCreativeMusic(academyId: number, enabled = true) {
  return useQuery({
    queryKey: musicKeys.all(academyId),
    enabled,
    staleTime: 60_000,
    queryFn: () => call<{ tracks: MusicTrack[] }>(creativePath(academyId, "/music")).then((r) => r.tracks),
  });
}

export const musicFileUrl = (track: Pick<MusicTrack, "url">) => apiUrl(track.url);

export type MusicUpload = { file: File; title: string; artist: string; mood: MusicMood; bpm: string; rights: boolean };

export function useUploadCreativeMusic(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (u: MusicUpload) => {
      const form = new FormData();
      form.append("title", u.title);
      form.append("artist", u.artist);
      form.append("mood", u.mood);
      if (u.bpm.trim()) form.append("bpm", u.bpm.trim());
      form.append("rights", u.rights ? "true" : "false");
      form.append("file", u.file);
      return call<{ track: MusicTrack }>(creativePath(academyId, "/music"), { method: "POST", body: form }).then((r) => r.track);
    },
    onSuccess: (track) => {
      qc.setQueryData<MusicTrack[]>(musicKeys.all(academyId), (cur) => (cur ? [...cur.filter((t) => t.scope === "replay"), track, ...cur.filter((t) => t.scope !== "replay")] : cur));
      void qc.invalidateQueries({ queryKey: musicKeys.all(academyId) });
    },
  });
}

export function useDeleteCreativeMusic(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trackId: number) => call<null>(creativePath(academyId, `/music/${trackId}`), { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: musicKeys.all(academyId) }),
  });
}
