import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getGetAcademyConsoleMembershipsQueryKey, getGetAcademyQueryKey } from "@workspace/api-client-react";

/** Academy console → Profile. Hand-written client for routes/academyProfile.ts. */

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export class ProfileError extends Error {
  constructor(message: string, readonly fields: Record<string, string> = {}) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers });
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const body = data as { error?: unknown; fields?: Record<string, string> } | null;
    throw new ProfileError(typeof body?.error === "string" ? body.error : `Request failed (${response.status})`, body?.fields ?? {});
  }
  return data as T;
}

export type AcademyProfile = {
  id: number;
  name: string;
  nameAr: string | null;
  description: string | null;
  logoUrl: string | null;
  contactPhone: string | null;
  whatsappPhone: string | null;
  email: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  instagramUrl: string | null;
  facebookUrl: string | null;
  websiteUrl: string | null;
  /** The Google review link, for the review request message. */
  googleReviewUrl: string | null;
  field: { name: string; location: string | null; latitude: number | null; longitude: number | null } | null;
  canEdit: boolean;
};

export type ProfileInput = Omit<AcademyProfile, "id" | "logoUrl" | "field" | "canEdit">;

const key = (academyId: number) => ["academy-profile", academyId];

function useRefreshAcademy(academyId: number) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: key(academyId) });
    void qc.invalidateQueries({ queryKey: getGetAcademyQueryKey(academyId) });
    void qc.invalidateQueries({ queryKey: getGetAcademyConsoleMembershipsQueryKey() });
    void qc.invalidateQueries({ queryKey: ["academy-ad-requests", academyId] });
  };
}

export function useAcademyProfile(academyId: number) {
  return useQuery({ queryKey: key(academyId), queryFn: () => call<AcademyProfile>(`/academy/console/academies/${academyId}/profile`), retry: false });
}

export function useSaveAcademyProfile(academyId: number) {
  const refresh = useRefreshAcademy(academyId);
  return useMutation({
    mutationFn: (input: ProfileInput) => call<AcademyProfile>(`/academy/console/academies/${academyId}/profile`, { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: refresh,
  });
}

export function useAcademyLogo(academyId: number) {
  const refresh = useRefreshAcademy(academyId);
  return useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) return call<{ logoUrl: null }>(`/academy/console/academies/${academyId}/profile/logo`, { method: "DELETE" });
      const form = new FormData();
      form.append("logo", await squareLogo(file), "logo.png");
      return call<{ logoUrl: string }>(`/academy/console/academies/${academyId}/profile/logo`, { method: "POST", body: form });
    },
    onSuccess: refresh,
  });
}

export function useLocateFromLink(academyId: number) {
  return useMutation({
    mutationFn: (link: string) => call<{ latitude: number; longitude: number }>(`/academy/console/academies/${academyId}/profile/locate`, { method: "POST", body: JSON.stringify({ link }) }),
  });
}

/** Fits the image inside 512 px, keeping transparency, as PNG. */
export function squareLogo(file: File, max = 512): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Not an image"))), "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Not an image"));
    };
    img.src = url;
  });
}

/** "962791234567" → "+962 79 123 4567". */
export function formatPhone(phone: string | null): string {
  if (!phone) return "";
  const m = /^962(7\d)(\d{3})(\d{4})$/.exec(phone);
  return m ? `+962 ${m[1]} ${m[2]} ${m[3]}` : `+${phone}`;
}
