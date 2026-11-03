import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseIso6709, readJpegExif, readMp4Meta, type CaptureRaw } from "@workspace/api-zod";
import { apiUrl, call } from "@/lib/academy-studio-api";

/**
 * Phone videos and photos sorted by match time: client for
 * routes/academyPhoneMedia.ts, and the reading of the capture time.
 *
 * The time is read here, from the file itself, BEFORE it is uploaded: the
 * iPhone photo picker can convert a video (HEVC → H.264) and the converted
 * file has no date. GPS is read only to tell the server whether it was filmed
 * at the venue; the server compares it and forgets it.
 */

export type PhonePhase = "before" | "during" | "after" | "unlinked";
export type PhoneItem = {
  id: number;
  mediaId: number;
  kind: "image" | "video";
  fileName: string;
  uploaderRole: "owner" | "manager" | "coach" | "parent";
  playerId: number | null;
  capturedAt: string | null;
  capturedEnd: string | null;
  captureDate: string | null;
  captureSource: string;
  captureConfidence: "high" | "medium" | "low";
  captureNotes: string[];
  venue: "at_venue" | "elsewhere" | "unknown";
  sessionId: number | null;
  phase: PhonePhase;
  offsetSec: number | null;
  recordingId: number | null;
  needsReview: boolean;
  reviewReason: "date_only" | "no_time" | "no_session" | null;
  linkedBy: "auto" | "coach";
  playerIds: number[];
  thumbnailUrl: string;
  createdAt: string;
};

/** What the file says about when (and where) it was filmed. Never throws: an unreadable file just says nothing. */
export async function readCapture(file: File): Promise<{ capture: Partial<CaptureRaw>; gps: { lat: number; lon: number } | null }> {
  const capture: Partial<CaptureRaw> = { lastModifiedMs: file.lastModified || null };
  try {
    const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|m4v|3gp)$/i.test(file.name);
    if (isVideo) {
      const read = async (offset: number, length: number) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
      const meta = await readMp4Meta(read, file.size);
      if (meta) {
        const { location, ...rest } = meta;
        return { capture: { ...capture, ...rest }, gps: parseIso6709(location) };
      }
    } else if (file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name)) {
      const exif = readJpegExif(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
      if (exif) {
        const { gps, orientation: _o, ...rest } = exif;
        return { capture: { ...capture, ...rest }, gps };
      }
    }
  } catch {
    // Unreadable: the server reads the file again and the coach is asked if it can't tell.
  }
  return { capture, gps: null };
}

const consoleBase = (academyId: number) => `/academy/console/academies/${academyId}/phone-media`;
const keys = { list: (academyId: number, sessionId: number | null, review: boolean) => ["academy", academyId, "phone-media", sessionId ?? "all", review] as const };

async function send(path: string, file: File): Promise<PhoneItem> {
  const { capture, gps } = await readCapture(file);
  const form = new FormData();
  form.append("file", file);
  form.append("capture", JSON.stringify(capture));
  if (gps) form.append("gps", JSON.stringify(gps));
  return (await call<{ item: PhoneItem }>(path, { method: "POST", body: form })).item;
}

export function usePhoneMedia(academyId: number, opts: { sessionId?: number | null; review?: boolean } = {}) {
  const q = new URLSearchParams();
  if (opts.sessionId) q.set("sessionId", String(opts.sessionId));
  if (opts.review) q.set("review", "1");
  return useQuery({
    queryKey: keys.list(academyId, opts.sessionId ?? null, Boolean(opts.review)),
    staleTime: 15_000,
    queryFn: () => call<{ items: PhoneItem[] }>(`${consoleBase(academyId)}${q.size ? `?${q}` : ""}`).then((r) => r.items),
  });
}

export function useUploadPhoneMedia(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => send(consoleBase(academyId), file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["academy", academyId, "phone-media"] }),
  });
}

export function useUpdatePhoneMedia(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; sessionId?: number | null; phase?: "before" | "during" | "after" | null; playerIds?: number[] }) =>
      call<{ item: PhoneItem }>(`${consoleBase(academyId)}/${v.id}`, { method: "PATCH", body: JSON.stringify({ sessionId: v.sessionId, phase: v.phase, playerIds: v.playerIds }) }).then((r) => r.item),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["academy", academyId, "phone-media"] }),
  });
}

export function useDaySessions(academyId: number, date: string | null) {
  return useQuery({
    queryKey: ["academy", academyId, "phone-media-sessions", date],
    enabled: Boolean(date),
    queryFn: () => call<{ sessions: Array<{ id: number; type: string; startsAt: string; opponent: string | null }> }>(`${consoleBase(academyId)}/sessions?date=${date}`).then((r) => r.sessions),
  });
}

/** A parent sends a video or photo of his child (family page). */
export function sendFamilyPhoneMedia(playerId: number, file: File) {
  return send(`/academy/family/phone-media?playerId=${playerId}`, file);
}

export const phoneThumb = (item: Pick<PhoneItem, "thumbnailUrl">) => apiUrl(item.thumbnailUrl);
