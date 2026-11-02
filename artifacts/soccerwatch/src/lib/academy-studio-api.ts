import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Academy console → Branding and → Studio. Hand-written client for
 * routes/academyBranding.ts and routes/academyStudio.ts (owner only).
 */

export const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export class StudioError extends Error {
  constructor(message: string, readonly status: number, readonly field: string | null = null) {
    super(message);
  }
}

async function readError(response: Response): Promise<StudioError> {
  let body: { error?: unknown; field?: unknown } | null = null;
  try { body = await response.json(); } catch { body = null; }
  return new StudioError(
    typeof body?.error === "string" ? body.error : `Request failed (${response.status})`,
    response.status,
    typeof body?.field === "string" ? body.field : null,
  );
}

export async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers });
  if (!response.ok) throw await readError(response);
  return (await response.json().catch(() => null)) as T;
}

/** A path relative to the API, as an absolute URL for <img>/<video>. */
export const apiUrl = (path: string) => (path.startsWith("/api/") ? `${apiBase}${path.slice(4)}` : `${apiBase}${path}`);

// ── Branding ────────────────────────────────────────────────────────────────

export type BrandLook = {
  nameEn: string;
  nameAr: string | null;
  taglineAr: string | null;
  primaryColor: string;
  accentColor: string | null;
  bookingPhone: string | null;
  instagram: string | null;
  showPlayerNames: boolean;
};

export type BrandingSetting = {
  key: string;
  value: boolean | number | string;
  source: "academy" | "replay";
  overridden: boolean;
  hasOwn: boolean;
  type: "boolean" | "number" | "enum" | "string";
  min: number | null;
  max: number | null;
  options: string[] | null;
  unit: string | null;
};

export type AcademyBranding = {
  academyId: number;
  hasOwnLook: boolean;
  look: BrandLook;
  defaults: BrandLook;
  crest: { source: "own" | "logo" | "none"; src: string | null };
  logoUrl: string | null;
  profile: { updatedAt: string } | null;
  profilesReady: boolean;
  storageReady: boolean;
  outputSizes: { landscape: { w: number; h: number }; portrait: { w: number; h: number } };
  settings: BrandingSetting[];
  settingsReady: boolean;
};

const brandingKey = (academyId: number) => ["academy-branding", academyId];
const brandingPath = (academyId: number) => `/academy/console/academies/${academyId}/branding`;

export function useAcademyBranding(academyId: number) {
  return useQuery({ queryKey: brandingKey(academyId), queryFn: () => call<AcademyBranding>(brandingPath(academyId)), retry: false });
}

function useBrandingWrite<V>(academyId: number, fn: (v: V) => Promise<AcademyBranding>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(brandingKey(academyId), data);
      void qc.invalidateQueries({ queryKey: ["academy-studio", academyId] });
    },
  });
}

export function useSaveBrandLook(academyId: number) {
  return useBrandingWrite(academyId, (look: BrandLook) =>
    call<AcademyBranding>(`${brandingPath(academyId)}/profile`, { method: "PUT", body: JSON.stringify(look) }));
}

export function useBrandCrest(academyId: number) {
  return useBrandingWrite(academyId, async (action: { file: File } | { fromLogo: true } | { remove: true }) => {
    if ("file" in action) {
      const form = new FormData();
      form.append("crest", action.file);
      return call<AcademyBranding>(`${brandingPath(academyId)}/crest`, { method: "PUT", body: form });
    }
    if ("fromLogo" in action) return call<AcademyBranding>(`${brandingPath(academyId)}/crest/from-logo`, { method: "POST" });
    return call<AcademyBranding>(`${brandingPath(academyId)}/crest`, { method: "DELETE" });
  });
}

export function useBrandSetting(academyId: number) {
  return useBrandingWrite(academyId, (v: { key: string; value: boolean | number | string } | { key: string; reset: true }) =>
    "reset" in v
      ? call<AcademyBranding>(`${brandingPath(academyId)}/settings/${encodeURIComponent(v.key)}`, { method: "DELETE" })
      : call<AcademyBranding>(`${brandingPath(academyId)}/settings`, { method: "PUT", body: JSON.stringify(v) }));
}

export function brandingPreviewUrl(academyId: number, params: Record<string, string>): string {
  return `${apiBase}${brandingPath(academyId)}/preview?${new URLSearchParams(params).toString()}`;
}

// ── Studio ──────────────────────────────────────────────────────────────────

export type StudioScorer = { number: number | null; name: string | null; goals: number };
export type StudioRow = { day: string; time: string; squad: string | null; place: string | null };
export type Bilingual<T> = { en: T; ar: T };

export type StudioData = {
  brand: { nameEn: string; nameAr: string | null; primaryColor: string; accentColor: string | null; showPlayerNames: boolean; contact: Bilingual<string | null> };
  matches: Array<{
    sessionId: number;
    startsAt: string;
    squad: string | null;
    opponent: string | null;
    ownScore: number | null;
    opponentScore: number | null;
    dateLabel: Bilingual<string>;
    scorers: StudioScorer[];
  }>;
  players: Array<{ id: number; number: number | null; firstName: string | null; squad: string | null; ageGroup: string | null }>;
  squads: Array<{ name: string; ageGroup: string | null }>;
  week: { rangeLabel: Bilingual<string>; rows: Bilingual<StudioRow[]> };
};

export type StudioClip = {
  id: number;
  title: string;
  aspectRatio: "9:16" | "16:9";
  status: "ready" | "processing" | "failed" | "expired" | "live";
  createdAt: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
  creator: { id: number; name: string | null; role: string; isYou: boolean };
};

const studioPath = (academyId: number) => `/academy/console/academies/${academyId}/studio`;

export function useStudioData(academyId: number) {
  return useQuery({ queryKey: ["academy-studio", academyId], queryFn: () => call<StudioData>(studioPath(academyId)), retry: false });
}

export function useStudioClips(academyId: number) {
  return useQuery({
    queryKey: ["academy-studio-clips", academyId],
    queryFn: () => call<{ clips: StudioClip[] }>(`${studioPath(academyId)}/clips`),
    retry: false,
    // Clips being prepared turn ready on their own.
    refetchInterval: (q) => (q.state.data?.clips.some((c) => c.status === "processing" || c.status === "live") ? 10_000 : false),
  });
}

export const clipVideoUrl = (academyId: number, clipId: number) => `${apiBase}${studioPath(academyId)}/clips/${clipId}/video`;

/** Ask for the branded MP4 and wait until it exists (up to ~4 minutes). */
export async function waitForClipExport(academyId: number, clipId: number): Promise<void> {
  const first = await call<{ status: string }>(`${studioPath(academyId)}/clips/${clipId}/export`, { method: "POST" });
  let status = first.status;
  for (let i = 0; status === "pending" && i < 80; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    status = (await call<{ status: string }>(`${studioPath(academyId)}/clips/${clipId}/export-status`)).status;
  }
  if (status !== "done") throw new StudioError(status === "expired" ? "This clip is no longer available." : "The clip couldn't be prepared. Try again later.", 409);
}

export async function downloadBlob(blob: Blob, name: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function downloadClip(academyId: number, clip: StudioClip): Promise<void> {
  await waitForClipExport(academyId, clip.id);
  const response = await fetch(`${apiBase}${studioPath(academyId)}/clips/${clip.id}/download`, { credentials: "include" });
  if (!response.ok) throw await readError(response);
  await downloadBlob(await response.blob(), `${clip.title.replace(/[^\p{L}\p{N}_-]+/gu, "_") || "clip"}.mp4`);
}

/** The ads endpoints are another team's (routes/academyAds.ts); a 404 means they aren't live yet and its text is shown. */
export function addClipToAds(academyId: number, userClipId: number) {
  return call<{ id: number; kind: string; status: string }>(`/academy/console/academies/${academyId}/ads/media/from-clip`, {
    method: "POST",
    body: JSON.stringify({ userClipId }),
  });
}

export function addImageToAds(academyId: number, dataUrl: string, name: string) {
  return call<{ id: number; kind: string; status: string }>(`/academy/console/academies/${academyId}/ads/media/from-image`, {
    method: "POST",
    body: JSON.stringify({ dataUrl, name }),
  });
}

export async function renderPost(academyId: number, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${apiBase}${studioPath(academyId)}/render`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) throw await readError(response);
  return response.blob();
}

/** A photo from the phone, shrunk to at most `max` px and re-encoded as JPEG, as a data URL. */
export function photoToDataUrl(file: File, max = 2048): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * k));
      canvas.height = Math.max(1, Math.round(img.height * k));
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Not an image")); };
    img.src = url;
  });
}

/** The rendered PNG as a JPEG data URL of at most `maxBytes`, lowering quality until it fits. */
export function pngToJpegDataUrl(blob: Blob, maxBytes = 4 * 1024 * 1024): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      for (const q of [0.92, 0.85, 0.75, 0.6, 0.45]) {
        const dataUrl = canvas.toDataURL("image/jpeg", q);
        // Base64 is 4/3 of the bytes.
        if (Math.floor(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4) <= maxBytes) { resolve(dataUrl); return; }
      }
      resolve(null);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Not an image")); };
    img.src = url;
  });
}
