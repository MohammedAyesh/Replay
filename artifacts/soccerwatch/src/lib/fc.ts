import { useQuery } from "@tanstack/react-query";

const FC_PROXY = "/api/fc/compute";

export interface FCVideo {
  key: string;
  filename: string;
  date: string | null;
  time: string | null;
  url: string;
}

export interface FCResponse {
  camera: string;
  cameras: string[];
  videos: FCVideo[];
  fieldImageUrl: string | null;
}

export function dateFromKey(key: string): string | null {
  const parts = key.split("/");
  if (parts.length >= 4) {
    const year = parts[1];
    const month = parts[2];
    const day = parts[3];
    if (
      /^\d{4}$/.test(year) &&
      /^\d{2}$/.test(month) &&
      /^\d{2}$/.test(day)
    ) {
      return `${year}-${month}-${day}`;
    }
  }
  return null;
}

export function timeFromFilename(filename: string): string | null {
  const m = filename.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (m) return `${m[4]}:${m[5]}`;
  return null;
}

export function formatDateLabel(iso: string): string {
  const [year, month, day] = iso.split("-");
  const d = new Date(Number(year), Number(month) - 1, Number(day));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function useFCCompute(camera?: string) {
  const params = new URLSearchParams();
  if (camera) params.set("camera", camera);
  const url = `${FC_PROXY}?${params.toString()}`;

  return useQuery<FCResponse>({
    queryKey: ["fc-compute", camera ?? "default"],
    queryFn: () => fetch(url).then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });
}

export interface OSSVideoEntry {
  url: string;
  filename: string;
  date: string;
  time: string;
}

export interface OSSVideoState {
  videos: OSSVideoEntry[];
  startIndex: number;
  camera: string;
}

export function storeOSSVideos(state: OSSVideoState) {
  sessionStorage.setItem("oss_videos", JSON.stringify(state));
}

export function loadOSSVideos(): OSSVideoState | null {
  try {
    const raw = sessionStorage.getItem("oss_videos");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
