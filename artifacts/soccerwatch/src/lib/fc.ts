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
  // Scan all positions — works for both "cam9/Cam01/2025/07/04/..." and "Cam01/2025/07/04/..."
  for (let i = 0; i + 2 < parts.length; i++) {
    const year = parts[i];
    const month = parts[i + 1];
    const day = parts[i + 2];
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

// ─── HLS chunk helpers ────────────────────────────────────────────────────────

export interface HLSChunk {
  /** The OSS key prefix up to and including the chunk folder, e.g.
   *  Cam01/2025/07/15/hls/Field_00_20250715184625_combined_chunk01  */
  chunkKey: string;
  /** Parsed date in YYYY-MM-DD format */
  date: string;
  /** HH:MM extracted from the chunk folder name */
  time: string;
}

/** Extract unique HLS chunk folders from a list of FC videos.
 *  Only considers entries inside /hls/ subdirectories. */
export function extractHLSChunks(videos: FCVideo[]): HLSChunk[] {
  const seen = new Set<string>();
  const chunks: HLSChunk[] = [];

  for (const v of videos) {
    const idx = v.key.indexOf("/hls/");
    if (idx === -1) continue;

    // chunk folder = everything up to and including the next path segment after /hls/
    const afterHls = v.key.slice(idx + 5); // strip "/hls/"
    const chunkFolder = afterHls.split("/")[0];
    if (!chunkFolder) continue;

    const chunkKey = v.key.slice(0, idx) + "/hls/" + chunkFolder;
    if (seen.has(chunkKey)) continue;
    seen.add(chunkKey);

    const date = dateFromKey(v.key) ?? "";
    const time = timeFromFilename(chunkFolder) ?? "";
    chunks.push({ chunkKey, date, time });
  }

  return chunks;
}

const OSS_BASE = "https://cam9.oss-me-central-1.aliyuncs.com";

/** Build a public URL for master.m3u8 — the OSS bucket is publicly readable with open CORS. */
export function getHLSMasterUrl(chunkKey: string): string {
  return `${OSS_BASE}/${chunkKey}/master.m3u8`;
}

// ─── OSSVideoEntry (shared by field-detail → oss-player) ─────────────────────

export interface OSSVideoEntry {
  url: string;
  filename: string;
  date: string;
  time: string;
  /** true when url points to a master.m3u8 (HLS stream) */
  isHLS?: boolean;
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
