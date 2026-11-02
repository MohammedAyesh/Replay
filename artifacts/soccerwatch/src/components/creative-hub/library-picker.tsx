import type { MediaSource } from "@workspace/api-zod";

/**
 * A compact picker over the academy's Library (clips, match moments, frames,
 * uploads, crest) used by the Editor to fill or replace a picture / video slot.
 * Owned by the Library work. CONTRACT (frozen props).
 */
export type LibraryPickerProps = {
  academyId: number;
  /** What the slot accepts. */
  accept: "image" | "video" | "any";
  onPick: (source: MediaSource, meta: { durationMs?: number; label?: string }) => void;
  onClose: () => void;
};

export function LibraryPicker(_props: LibraryPickerProps) {
  return null;
}
