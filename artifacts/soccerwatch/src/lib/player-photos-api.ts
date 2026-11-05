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
/** HEIC, AVIF and GIF too: the browser redraws them as PNG before upload (cleanPhotoFile). */
export const PLAYER_PHOTO_ACCEPT = "image/png,image/webp,image/jpeg,image/heic,image/heif,image/avif,image/gif";
export const PLAYER_PHOTO_MAX_MB = 12;

/**
 * The picture as a clean PNG drawn by the browser (alpha kept, at most 1600 px), so the server
 * always gets a file it can read: whatever the phone or PC saved under ".png" (an iPhone HEIC,
 * a 16-bit export, a renamed WebP), if the browser can show it, it uploads. Falls back to the
 * original file when the browser can't decode it either.
 */
export async function cleanPhotoFile(file: File, maxSide = 1600): Promise<File> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return file;
    const name = (file.name || "photo").replace(/\.[a-z0-9]+$/i, "") + ".png";
    return new File([blob], name, { type: "image/png" });
  } catch {
    return file;
  }
}

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
    mutationFn: async ({ playerId, file: picked, label, primary }: { playerId: number; file: File; label?: string; primary?: boolean }) => {
      const file = await cleanPhotoFile(picked);
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
    mutationFn: async (items: ShootAssignment[]) => {
      const form = new FormData();
      const kept = items.filter((i) => i.playerId !== null);
      form.append("assign", JSON.stringify(kept.map((i) => ({ playerId: i.playerId, label: i.label ?? null }))));
      for (const i of kept) {
        const file = await cleanPhotoFile(i.file);
        form.append("files", file, file.name || "photo.png");
      }
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
