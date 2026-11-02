import type { MediaSource } from "@workspace/api-zod";
import { Shield } from "lucide-react";
import { useCreativeLibraryCopy } from "@/i18n/creative-library-strings";
import { useCreativeBrand } from "@/lib/creative-hub-api";
import { browserUrl } from "@/lib/creative-hub-library-api";
import { creativeMediaUrl } from "@/lib/creative-hub-media";
import { pickFor } from "./library/actions";
import { LibraryBrowser, type LibraryItem } from "./library/browser";
import { LibrarySheet } from "./library/sheet";

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

/**
 * image → uploaded photos, frames of moments and clips, the crest
 * video → moments (their recording window), clips, uploaded videos
 * any   → everything; a moment or clip is picked as footage
 * Mounted = open; the Editor unmounts it (or onClose fires) to close.
 */
export function LibraryPicker({ academyId, accept, onPick, onClose }: LibraryPickerProps) {
  const copy = useCreativeLibraryCopy();
  const brand = useCreativeBrand(academyId);
  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  const pickAs = accept === "any" ? "video" : accept;

  const select = (item: LibraryItem) => {
    // Uploads keep their own kind in an "any" slot: a photo stays a picture.
    const as = accept === "any" && item.kind === "upload" ? item.upload.kind : pickAs;
    const picked = pickFor(item, as, copy);
    if (!picked) return;
    onPick(picked.source, picked.meta);
  };

  const crestSrc: MediaSource = { type: "crest" };
  const crestUrl = browserUrl(creativeMediaUrl(academyId, crestSrc, "still")) ?? browserUrl(brand.data?.crestUrl ?? null);
  const crest = accept !== "video" ? (
    <button type="button" onClick={() => onPick(crestSrc, { label: copy.picker.useCrest })} data-testid="library-pick-crest"
      className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-surface p-2 text-start transition-colors hover:border-turf">
      <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-raised">
        {crestUrl ? <img src={crestUrl} alt="" className="h-full w-full object-contain" /> : <Shield className="h-5 w-5 text-muted-text" aria-hidden />}
      </span>
      <span className="text-sm font-semibold text-text">{copy.picker.useCrest}</span>
    </button>
  ) : null;

  return (
    <LibrarySheet open onClose={onClose} wide dir={dir} closeLabel={copy.close} testId="library-picker"
      title={accept === "image" ? copy.picker.image : accept === "video" ? copy.picker.video : copy.picker.title}>
      <LibraryBrowser academyId={academyId} accept={accept} onSelect={select} extra={crest} dense />
    </LibrarySheet>
  );
}
