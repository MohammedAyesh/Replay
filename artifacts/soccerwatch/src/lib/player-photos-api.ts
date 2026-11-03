import type { CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiUrl, call } from "@/lib/academy-studio-api";
import type { PlayerPhoto } from "@/lib/creative-hub-library-api";

/**
 * Academy console → Players → photos. Hand-written client for
 * routes/academyPlayerPhotos.ts (members of the academy). Pictures keep their
 * transparency (cut-outs from a photoshoot); the server scales them to at most
 * 1600 px and stores PNG (with alpha) or WebP.
 */

export type { PlayerPhoto };

const base = (academyId: number) => `/academy/console/academies/${academyId}/players`;
export const playerPhotoKeys = {
  all: (academyId: number) => ["academy", academyId, "player-photos"] as const,
  player: (academyId: number, playerId: number) => ["academy", academyId, "player-photos", playerId] as const,
};

/** Accepted picture types (JPG is accepted and kept opaque; PNG / WebP keep transparency). */
export const PLAYER_PHOTO_ACCEPT = "image/png,image/webp,image/jpeg";
export const PLAYER_PHOTO_MAX_MB = 12;

/** A checkerboard behind a picture, so a cut-out's transparency shows. */
export const CHECKER: CSSProperties = {
  backgroundColor: "#E9ECF2",
  backgroundImage: "conic-gradient(#C9CFDA 25%, transparent 0 50%, #C9CFDA 0 75%, transparent 0)",
  backgroundSize: "16px 16px",
};

export const photoSrc = (p: Pick<PlayerPhoto, "url">) => apiUrl(p.url);

/** Every photo of the academy's players (the list's thumbnails). */
export function useAcademyPlayerPhotos(academyId: number) {
  return useQuery({
    queryKey: playerPhotoKeys.all(academyId),
    staleTime: 30_000,
    queryFn: () => call<{ photos: PlayerPhoto[] }>(`${base(academyId)}/photos`).then((r) => r.photos),
  });
}

export function usePlayerGallery(academyId: number, playerId: number | null) {
  return useQuery({
    queryKey: playerPhotoKeys.player(academyId, playerId ?? 0),
    enabled: playerId !== null,
    queryFn: () => call<{ photos: PlayerPhoto[] }>(`${base(academyId)}/${playerId}/photos`).then((r) => r.photos),
  });
}

function useInvalidate(academyId: number) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: playerPhotoKeys.all(academyId) });
    // The Creative hub's Player picker shows the same photos.
    void qc.invalidateQueries({ queryKey: ["creative", academyId] });
  };
}

export function useUploadPlayerPhoto(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: ({ playerId, file, label, primary }: { playerId: number; file: File; label?: string; primary?: boolean }) => {
      const form = new FormData();
      if (label) form.append("label", label);
      if (primary) form.append("primary", "true");
      form.append("file", file, file.name || "photo.png");
      return call<{ photo: PlayerPhoto }>(`${base(academyId)}/${playerId}/photos`, { method: "POST", body: form }).then((r) => r.photo);
    },
    onSuccess: done,
  });
}

export type ShootAssignment = { file: File; playerId: number | null; label?: string };

export function useUploadShoot(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: (items: ShootAssignment[]) => {
      const form = new FormData();
      const kept = items.filter((i) => i.playerId !== null);
      form.append("assign", JSON.stringify(kept.map((i) => ({ playerId: i.playerId, label: i.label ?? null }))));
      for (const i of kept) form.append("files", i.file, i.file.name || "photo.png");
      return call<{ added: PlayerPhoto[]; skipped: Array<{ index: number; name: string; error: string }> }>(`${base(academyId)}/photos/bulk`, { method: "POST", body: form });
    },
    onSuccess: done,
  });
}

export function useUpdatePlayerPhoto(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: ({ photo, label, isPrimary }: { photo: PlayerPhoto; label?: string | null; isPrimary?: true }) =>
      call<{ photo: PlayerPhoto | null }>(`${base(academyId)}/${photo.playerId}/photos/${photo.photoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(label !== undefined ? { label } : {}), ...(isPrimary ? { isPrimary: true } : {}) }),
      }),
    onSuccess: done,
  });
}

export function useDeletePlayerPhoto(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: (photo: PlayerPhoto) => call<null>(`${base(academyId)}/${photo.playerId}/photos/${photo.photoId}`, { method: "DELETE" }),
    onSuccess: done,
  });
}
