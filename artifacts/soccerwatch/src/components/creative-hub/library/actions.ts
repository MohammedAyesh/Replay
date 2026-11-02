import type { MediaSource } from "@workspace/api-zod";
import type { LibraryMatch } from "@/lib/creative-hub-library-api";
import type { TemplateSeed } from "../types";
import { clipLabel, matchTitle, momentLabel, type LibraryAccept, type LibraryCopy, type LibraryItem } from "./browser";

/**
 * What "Make a post" and "Make a video" start from for each Library item:
 *   moment  post → a frame at the moment; video → its recording window
 *   clip    post → a frame of it (when it is on the academy's recording), else the clip; video → the clip
 *   upload  the upload (a photo only makes a post)
 *   match   the whole session (score, squad, scorers come with it)
 */
export function seedsFor(item: LibraryItem): { post: TemplateSeed | null; video: TemplateSeed | null } {
  switch (item.kind) {
    case "moment": {
      const m = item.moment;
      return {
        post: { type: "frame", recordingId: m.still.recordingId, atMs: m.still.atMs },
        video: { type: "recording", recordingId: m.window.recordingId, fromMs: m.window.fromMs, toMs: m.window.toMs },
      };
    }
    case "clip": {
      const c = item.clip;
      return {
        post: c.still ? { type: "frame", recordingId: c.still.recordingId, atMs: c.still.atMs } : { type: "clip", clipId: c.clipId },
        video: { type: "clip", clipId: c.clipId },
      };
    }
    case "upload": {
      const u = item.upload;
      const seed: TemplateSeed = { type: "upload", mediaId: u.mediaId };
      return { post: seed, video: u.kind === "video" ? seed : null };
    }
  }
}

export const sessionSeed = (m: LibraryMatch): TemplateSeed => ({ type: "session", sessionId: m.sessionId });

export function itemLabel(item: LibraryItem, copy: LibraryCopy): string {
  switch (item.kind) {
    case "moment": return item.match ? `${momentLabel(item.moment, copy)} · ${matchTitle(item.match, copy)}` : momentLabel(item.moment, copy);
    case "clip": return clipLabel(item.clip, copy);
    case "upload": return item.upload.name || (item.upload.kind === "video" ? copy.video : copy.photo);
  }
}

export type PickResult = { source: MediaSource; meta: { durationMs?: number; label?: string } };

/**
 * What a picker slot gets from an item. A picture slot takes a frame of a
 * moment or clip, or an uploaded photo; a video slot takes a moment's window,
 * a clip or an uploaded video. Null when the item can't fill the slot.
 */
export function pickFor(item: LibraryItem, accept: LibraryAccept, copy: LibraryCopy): PickResult | null {
  const label = itemLabel(item, copy);
  switch (item.kind) {
    case "moment":
      if (accept === "image") return { source: item.moment.still, meta: { label } };
      return { source: item.moment.source, meta: { durationMs: item.moment.durationMs, label } };
    case "clip":
      if (accept === "image") return item.clip.still ? { source: item.clip.still, meta: { label } } : null;
      return { source: item.clip.source, meta: { durationMs: item.clip.durationMs, label } };
    case "upload": {
      const u = item.upload;
      if (accept === "image" && u.kind !== "image") return null;
      if (accept === "video" && u.kind !== "video") return null;
      return { source: u.source, meta: { durationMs: u.durationMs ?? undefined, label } };
    }
  }
}
