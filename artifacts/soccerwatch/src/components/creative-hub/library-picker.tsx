import { useState } from "react";
import type { MediaSource } from "@workspace/api-zod";
import { FolderOpen, Shield, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCreativeLibraryCopy } from "@/i18n/creative-library-strings";
import { useCreativeBrand } from "@/lib/creative-hub-api";
import { browserUrl } from "@/lib/creative-hub-library-api";
import { creativeMediaUrl } from "@/lib/creative-hub-media";
import { pickFor } from "./library/actions";
import { LibraryBrowser, type LibraryItem } from "./library/browser";
import { LibrarySheet } from "./library/sheet";
import { PlayerPicker } from "./library/players";

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
 *
 * A second tab, Players, picks one of the squad and then from his photos
 * (names allowed) or his clips and match moments. A pick from there carries
 * meta.player (number, first name when allowed, position) so the Editor can
 * offer to fill the template's player details; the props are unchanged.
 */
export function LibraryPicker({ academyId, accept, onPick, onClose }: LibraryPickerProps) {
  const copy = useCreativeLibraryCopy();
  const brand = useCreativeBrand(academyId);
  const [tab, setTab] = useState<"library" | "players">("library");
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
      <div className="mb-3 flex gap-1.5" role="tablist">
        {([["library", copy.players.library, FolderOpen], ["players", copy.players.tab, Users]] as const).map(([key, label, Icon]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} data-testid={`library-picker-tab-${key}`}
            className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold", tab === key ? "border-turf bg-turf/15 text-text" : "border-line text-muted-text hover:text-text")}>
            <Icon className="h-4 w-4" aria-hidden />{label}
          </button>
        ))}
      </div>
      {tab === "library"
        ? <LibraryBrowser academyId={academyId} accept={accept} onSelect={select} extra={crest} dense />
        : <PlayerPicker academyId={academyId} accept={accept} onPick={(source, meta) => onPick(source, meta)} />}
    </LibrarySheet>
  );
}
