import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { storagePullZoneBase, uploadBufferToBunnyStorage } from "../bunny";

/**
 * A file in a chat. It lives on Bunny Storage under an unguessable path and is read from the
 * pull zone, by the console and by WAHA when it sends it (the same protection the reel cards use).
 */
export type WaMedia = {
  path: string;
  mimetype: string;
  filename?: string | null;
  size?: number | null;
  /** An incoming file WAHA had no copy of, or one too large to keep. */
  unavailable?: boolean;
  /** Being copied from WAHA. */
  pending?: boolean;
};

export type WhatsappContent =
  | { type: "image"; media: WaMedia; caption?: string | null }
  | { type: "video"; media: WaMedia; caption?: string | null; gif?: boolean }
  | { type: "audio"; media: WaMedia; voice?: boolean }
  | { type: "document"; media: WaMedia; caption?: string | null }
  | { type: "sticker"; media: WaMedia }
  | { type: "location"; latitude: number; longitude: number; name?: string | null; address?: string | null }
  | { type: "poll"; name: string; options: string[]; multipleAnswers: boolean };

export const MAX_CHAT_MEDIA_BYTES = 30 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/3gpp": "3gp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/webm": "webm", "audio/wav": "wav",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt", "text/csv": "csv", "application/zip": "zip",
};

export function extensionFor(mimetype: string, filename?: string | null): string {
  const known = EXTENSIONS[mimetype.toLowerCase()];
  if (known) return known;
  const fromName = filename?.split(".").pop()?.toLowerCase();
  return fromName && /^[a-z0-9]{1,5}$/.test(fromName) ? fromName : "bin";
}

export function mediaUrl(media: Pick<WaMedia, "path" | "unavailable"> | null | undefined): string | null {
  if (!media?.path || media.unavailable) return null;
  return `${storagePullZoneBase()}/${media.path}`;
}

/** Keep a chat file on Bunny Storage. */
export async function storeChatMedia(
  academyId: number,
  buffer: Buffer,
  mimetype: string,
  filename?: string | null,
): Promise<WaMedia> {
  const clean = mimetype.split(";")[0].trim().toLowerCase() || "application/octet-stream";
  const remote = `wa-media/${academyId}/${randomBytes(16).toString("hex")}.${extensionFor(clean, filename)}`;
  await uploadBufferToBunnyStorage(buffer, remote, clean);
  return { path: remote, mimetype: clean, filename: filename ? filename.slice(0, 200) : null, size: buffer.length };
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let err = "";
    ff.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 300)}`))));
  });
}

/** WhatsApp GIFs are silent MP4s; a .gif upload is turned into one. */
export async function gifToMp4(gif: Buffer): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-gif-"));
  try {
    const input = path.join(dir, "in.gif");
    const output = path.join(dir, "out.mp4");
    await fs.writeFile(input, gif);
    await run([
      "-i", input, "-movflags", "+faststart", "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(min(iw\\,720)/2)*2:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-an", output,
    ]);
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The one-line text a chat list shows for a message (and what `body` stores). */
export function summaryFor(content: WhatsappContent, locale: "ar" | "en" = "en"): string {
  const ar = locale === "ar";
  switch (content.type) {
    case "image": return content.caption?.trim() || (ar ? "📷 صورة" : "📷 Photo");
    case "video": return content.caption?.trim() || (content.gif ? "GIF" : ar ? "🎥 فيديو" : "🎥 Video");
    case "audio": return content.voice ? (ar ? "🎤 رسالة صوتية" : "🎤 Voice message") : (ar ? "🎵 ملف صوتي" : "🎵 Audio");
    case "document": return content.caption?.trim() || `📄 ${content.media.filename || (ar ? "ملف" : "Document")}`;
    case "sticker": return ar ? "ملصق" : "Sticker";
    case "location": return `📍 ${content.name?.trim() || (ar ? "موقع" : "Location")}`;
    case "poll": return `📊 ${content.name}`;
  }
}

/** Which kind of message WhatsApp sent, from WAHA's payload (GOWS keeps the raw message in _data.Message). */
export function incomingKind(payload: Record<string, unknown>): {
  type: WhatsappContent["type"] | "text";
  gif?: boolean;
  voice?: boolean;
  poll?: { name: string; options: string[]; multipleAnswers: boolean };
} {
  const data = (payload._data ?? {}) as Record<string, unknown>;
  const message = (data.Message ?? data.message ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const pollMessage = message.pollCreationMessageV3 ?? message.pollCreationMessageV2 ?? message.pollCreationMessage;
  if (pollMessage) {
    const options = Array.isArray(pollMessage.options)
      ? (pollMessage.options as Array<{ optionName?: unknown }>).map((o) => String(o.optionName ?? "")).filter(Boolean)
      : [];
    return { type: "poll", poll: { name: String(pollMessage.name ?? ""), options, multipleAnswers: Number(pollMessage.selectableOptionsCount ?? 0) !== 1 } };
  }
  if (payload.location && typeof payload.location === "object") return { type: "location" };
  if (message.locationMessage || message.liveLocationMessage) return { type: "location" };
  if (message.stickerMessage) return { type: "sticker" };
  if (message.imageMessage) return { type: "image" };
  if (message.videoMessage) return { type: "video", gif: message.videoMessage.gifPlayback === true };
  if (message.audioMessage) return { type: "audio", voice: message.audioMessage.PTT === true || message.audioMessage.ptt === true };
  if (message.documentMessage || message.documentWithCaptionMessage) return { type: "document" };
  if (payload.hasMedia !== true) return { type: "text" };
  const mime = String((payload.media as { mimetype?: unknown } | undefined)?.mimetype ?? "").toLowerCase();
  if (mime === "image/webp") return { type: "sticker" };
  if (mime.startsWith("image/")) return { type: "image" };
  if (mime.startsWith("video/")) return { type: "video" };
  if (mime.startsWith("audio/")) return { type: "audio", voice: mime.includes("ogg") };
  return { type: "document" };
}

/** The location WAHA attached to a location message. */
export function incomingLocation(payload: Record<string, unknown>): { latitude: number; longitude: number; name: string | null; address: string | null } | null {
  const data = (payload._data ?? {}) as Record<string, unknown>;
  const message = (data.Message ?? data.message ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const raw = (payload.location ?? message.locationMessage ?? message.liveLocationMessage) as Record<string, unknown> | undefined;
  if (!raw) return null;
  const latitude = Number(raw.latitude ?? raw.degreesLatitude);
  const longitude = Number(raw.longitude ?? raw.degreesLongitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const name = typeof raw.name === "string" && raw.name ? raw.name : typeof raw.description === "string" ? raw.description : null;
  return { latitude, longitude, name, address: typeof raw.address === "string" && raw.address ? raw.address : null };
}
