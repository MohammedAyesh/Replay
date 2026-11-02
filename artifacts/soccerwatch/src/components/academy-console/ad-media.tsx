import { useRef, useState } from "react";
import { Film, ImagePlus, Loader2, Sparkles, Trash2, Upload } from "lucide-react";
import { useAdsExtraCopy } from "@/i18n/ads-extra-strings";
import { apiUrl, useAdMedia, useDeleteAdMedia, useUploadAdMedia, type AdCard, type AdMedia } from "@/lib/meta-ads-api";
import { resizeImage } from "@/lib/facebook-sdk";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const MAX_BYTES = 300 * 1024 * 1024;

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

export function MediaThumb({ media, className }: { media: Pick<AdMedia, "kind" | "thumbUrl" | "durationSec"> | undefined; className?: string }) {
  return (
    <span className={cn("relative block overflow-hidden bg-raised", className)}>
      {media?.thumbUrl ? <img src={apiUrl(media.thumbUrl)} alt="" className="h-full w-full object-cover" loading="lazy" /> : <span className="grid h-full w-full place-items-center text-muted-text"><ImagePlus className="h-5 w-5" aria-hidden="true" /></span>}
      {media?.kind === "video" && (
        <span className="absolute bottom-1 start-1 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">
          <Film className="h-3 w-3" aria-hidden="true" />{media.durationSec ? `${Math.round(media.durationSec)}s` : ""}
        </span>
      )}
    </span>
  );
}

/** The academy's photos and videos: upload from the phone, pick 1 (single ad) or 2–10 (carousel). */
export function AdMediaPicker({ academyId, cards, onChange }: { academyId: number; cards: AdCard[]; onChange: (cards: AdCard[]) => void }) {
  const copy = useAdsExtraCopy();
  const media = useAdMedia(academyId);
  const upload = useUploadAdMedia(academyId);
  const remove = useDeleteAdMedia(academyId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const items = media.data ?? [];

  const toggle = (m: AdMedia) => {
    const at = cards.findIndex((c) => c.mediaId === m.id);
    if (at >= 0) onChange(cards.filter((_, i) => i !== at));
    else if (cards.length < 10) onChange([...cards, { mediaId: m.id, headline: null }]);
  };

  const pick = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (file.size > MAX_BYTES) { setError(copy.media.tooBig); return; }
    try {
      let created: AdMedia;
      if (file.type.startsWith("image/")) {
        const dataUrl = await resizeImage(file, 1440, 0.88);
        const size = await imageSize(dataUrl);
        created = await upload.mutateAsync({ file: await dataUrlToBlob(dataUrl), name: file.name.replace(/\.[^.]+$/, ".jpg"), ...size });
      } else {
        created = await upload.mutateAsync({ file, name: file.name });
      }
      if (cards.length < 10) onChange([...cards, { mediaId: created.id, headline: null }]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-3" data-testid="ad-media-picker">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text">{copy.media.title}</p>
          <p className="text-xs text-muted-text">{copy.media.hint}</p>
        </div>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/*" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        <Button type="button" variant="ghost" className="border border-line" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
          {upload.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="me-2 h-4 w-4" aria-hidden="true" />}
          {upload.isPending ? copy.media.uploading : copy.media.upload}
        </Button>
      </div>
      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      {media.isLoading ? <div className="h-24 animate-pulse rounded-xl bg-raised" /> : !items.length ? (
        <p className="rounded-xl bg-raised p-4 text-sm text-muted-text">{copy.media.empty}</p>
      ) : (
        <>
          <p className="text-xs text-muted-text">{copy.media.pickHint}</p>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {items.map((m) => {
              const order = cards.findIndex((c) => c.mediaId === m.id);
              return (
                <li key={m.id} className="group relative">
                  <button type="button" onClick={() => toggle(m)} disabled={m.status === "failed"}
                    className={cn("block w-full overflow-hidden rounded-lg border-2", order >= 0 ? "border-turf" : "border-transparent", m.status === "failed" && "opacity-40")}
                    aria-pressed={order >= 0} title={m.name} data-testid={`ad-media-${m.id}`}>
                    <MediaThumb media={m} className="aspect-square w-full" />
                    {order >= 0 && <span className="absolute end-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-turf text-xs font-bold text-void">{order + 1}</span>}
                    {m.source !== "upload" && <span className="absolute start-1 top-1 rounded bg-black/70 p-0.5 text-white" title={copy.media.fromStudio}><Sparkles className="h-3 w-3" aria-hidden="true" /></span>}
                  </button>
                  {order < 0 && (
                    <button type="button" className="absolute end-1 top-1 hidden rounded bg-black/70 p-1 text-white group-hover:block" aria-label={copy.media.delete}
                      onClick={() => remove.mutate(m.id)}><Trash2 className="h-3 w-3" aria-hidden="true" /></button>
                  )}
                </li>
              );
            })}
          </ul>
          {remove.isError && <p className="text-sm text-red-400" role="alert">{(remove.error as Error).message}</p>}
        </>
      )}
      {cards.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-turf">{copy.media.selected(cards.length)}</p>
          {cards.length > 1 && cards.map((card, i) => (
            <div key={card.mediaId} className="flex items-center gap-2">
              <MediaThumb media={items.find((m) => m.id === card.mediaId)} className="h-10 w-10 shrink-0 rounded" />
              <Input value={card.headline ?? ""} maxLength={40} dir="auto" placeholder={copy.media.cardHeadline}
                onChange={(e) => onChange(cards.map((c, j) => (j === i ? { ...c, headline: e.target.value } : c)))} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
