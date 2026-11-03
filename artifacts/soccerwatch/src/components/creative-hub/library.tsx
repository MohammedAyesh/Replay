import { useState } from "react";
import { Clapperboard, ImageIcon, LayoutTemplate, Loader2 } from "lucide-react";
import { useCreativeLibraryCopy } from "@/i18n/creative-library-strings";
import { useCreativeFramerCopy } from "@/i18n/creative-framer-strings";
import { useCreateCreativeProject } from "@/lib/creative-hub-api";
import { clipVideoScene, type FramedClip } from "@/lib/creative-framing";
import { ClipFramer, type FramerStart } from "./framer/clip-framer";
import type { LibraryMatch } from "@/lib/creative-hub-library-api";
import { cn } from "@/lib/utils";
import type { SectionProps, TemplateSeed } from "./types";
import { seedsFor, itemLabel, sessionSeed } from "./library/actions";
import { LibraryBrowser, UploadButton, type LibraryItem } from "./library/browser";
import { PreviewVideo, stillUrls, Thumb, videoUrlFor } from "./library/media";
import { LibrarySheet } from "./library/sheet";

function ActionButtons({ post, video, onSeed, compact }: { post: TemplateSeed | null; video: TemplateSeed | null; onSeed: (s: TemplateSeed) => void; compact?: boolean }) {
  const copy = useCreativeLibraryCopy();
  return (
    <div className={cn("flex gap-2", compact ? "flex-wrap" : "w-full")}>
      {post && (
        <button type="button" onClick={() => onSeed(post)} data-testid="library-make-post"
          className={cn("flex min-h-11 items-center justify-center gap-2 rounded-full bg-floodlight px-4 text-sm font-bold text-void", !compact && "flex-1")}>
          <ImageIcon className="h-4 w-4" aria-hidden />{copy.makePost}
        </button>
      )}
      {video && (
        <button type="button" onClick={() => onSeed(video)} data-testid="library-make-video"
          className={cn("flex min-h-11 items-center justify-center gap-2 rounded-full bg-violet px-4 text-sm font-bold text-white", !compact && "flex-1")}>
          <Clapperboard className="h-4 w-4" aria-hidden />{copy.makeVideo}
        </button>
      )}
    </div>
  );
}

function Preview({ academyId, item }: { academyId: number; item: LibraryItem }) {
  const copy = useCreativeLibraryCopy();
  if (item.kind === "moment") {
    const m = item.moment;
    const poster = stillUrls(academyId, m.still, m.thumbnailUrl)[0] ?? null;
    const url = videoUrlFor(academyId, m.source);
    return url ? <PreviewVideo url={url} window={m.window} poster={poster} className="aspect-video" />
      : <Thumb urls={stillUrls(academyId, m.still, m.thumbnailUrl)} className="aspect-video w-full" />;
  }
  if (item.kind === "clip") {
    const c = item.clip;
    const urls = stillUrls(academyId, c.source, c.thumbnailUrl);
    const url = videoUrlFor(academyId, c.source, c.videoUrl);
    const shape = c.aspectRatio === "9:16" ? "mx-auto aspect-[9/16] max-h-[60dvh] w-auto" : "aspect-video";
    return url ? <PreviewVideo url={url} poster={urls[0] ?? null} className={shape} />
      : (
        <div className="space-y-2">
          <Thumb urls={urls} className={cn("w-full", shape)} />
          <p className="text-center text-xs text-muted-text">{c.status === "processing" ? copy.processing : copy.noPreview}</p>
        </div>
      );
  }
  const u = item.upload;
  const urls = stillUrls(academyId, u.source, u.thumbnailUrl);
  if (u.kind === "video") {
    const url = videoUrlFor(academyId, u.source, u.videoUrl);
    if (url) return <PreviewVideo url={url} poster={urls[0] ?? null} className="max-h-[60dvh]" />;
  }
  return urls[0]
    ? <img src={urls[0]} alt="" className="mx-auto max-h-[60dvh] w-auto rounded-xl object-contain" />
    : <Thumb urls={[]} className="aspect-square w-full" />;
}

/**
 * Where the framer starts for a Library item: a moment's window, or a clip's
 * place in its recording (so the start and end can move past the clip's own
 * edges). A clip with no recording behind it is framed as it is.
 */
export function framerStartFor(item: LibraryItem): FramerStart | null {
  if (item.kind === "moment") {
    const w = item.moment.window;
    return { type: "recording", recordingId: w.recordingId, fromMs: w.fromMs, toMs: w.toMs };
  }
  if (item.kind === "clip") {
    const c = item.clip;
    if (c.window) return { type: "recording", recordingId: c.window.recordingId, fromMs: c.window.fromMs, toMs: c.window.toMs };
    if (c.status === "ready" && c.aspectRatio === "16:9" && c.durationMs > 0) return { type: "clip", clipId: c.clipId, durationMs: c.durationMs };
  }
  return null;
}

/** The framer's buttons: a 16:9 video straight into the editor, a post, or a template with this footage. */
function FramerActions({ academyId, value, title, post, onSeed, onEditor }: {
  academyId: number; value: FramedClip; title: string; post: TemplateSeed | null;
  onSeed: (s: TemplateSeed) => void; onEditor: (projectId: number) => void;
}) {
  const copy = useCreativeFramerCopy();
  const create = useCreateCreativeProject(academyId);
  const [failed, setFailed] = useState(false);
  const makeVideo = async () => {
    setFailed(false);
    try {
      const project = await create.mutateAsync({ title, templateKey: null, scene: clipVideoScene(value, copy.locale === "ar" ? "ar" : "en") });
      onEditor(project.id);
    } catch {
      setFailed(true);
    }
  };
  const seed: TemplateSeed = value.src.type === "recording"
    ? { ...value.src, framing: value.framing, branding: value.branding }
    : { type: "clip", clipId: value.src.clipId, framing: value.framing, branding: value.branding };
  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => void makeVideo()} disabled={create.isPending} data-testid="framer-make-video"
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-violet px-4 text-sm font-bold text-white disabled:opacity-60">
        {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Clapperboard className="h-4 w-4" aria-hidden />}
        {create.isPending ? copy.creating : copy.makeVideo(value.shape === "wide" ? copy.shapeWide : value.shape === "tall" ? copy.shapeTall : copy.shapeBars)}
      </button>
      <div className="flex gap-2">
        {post && (
          <button type="button" onClick={() => onSeed(post)} data-testid="framer-make-post"
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-floodlight px-3 text-sm font-bold text-void">
            <ImageIcon className="h-4 w-4" aria-hidden />{copy.makePost}
          </button>
        )}
        <button type="button" onClick={() => onSeed(seed)} data-testid="framer-use-template"
          className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-line px-3 text-sm font-bold text-text">
          <LayoutTemplate className="h-4 w-4" aria-hidden />{copy.useTemplate}
        </button>
      </div>
      {failed && <p className="text-center text-xs text-[#FF5A3C]" role="alert">{copy.createFailed}</p>}
    </div>
  );
}

/** Creative hub → Library: the academy's own footage, moments, clips and uploads to make something from. */
export function CreativeLibrary({ academyId, nav }: SectionProps & { seed?: TemplateSeed | null }) {
  const copy = useCreativeLibraryCopy();
  const [open, setOpen] = useState<LibraryItem | null>(null);
  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  const start = (seed: TemplateSeed) => { setOpen(null); nav.openTemplates(seed); };
  const seeds = open ? seedsFor(open) : null;
  const framerStart = open ? framerStartFor(open) : null;

  const matchActions = (m: LibraryMatch) => m.wholeMatch === false ? null : (
    <div className="flex w-full flex-col gap-1 sm:w-auto">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-text">{copy.wholeMatch}</p>
      <ActionButtons post={sessionSeed(m)} video={sessionSeed(m)} onSeed={start} compact />
    </div>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="creative-library">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-text">{copy.intro}</p>
        <UploadButton academyId={academyId} accept="any" onUploaded={(u) => setOpen({ kind: "upload", upload: u })} />
      </div>
      <LibraryBrowser academyId={academyId} onSelect={setOpen} matchActions={matchActions} />
      <LibrarySheet open={open !== null} onClose={() => setOpen(null)} title={open ? itemLabel(open, copy) : copy.preview}
        closeLabel={copy.close} dir={dir} testId="library-preview">
        {open && seeds && framerStart && (
          <ClipFramer key={JSON.stringify(framerStart)} academyId={academyId} start={framerStart}
            actions={(value) => (
              <FramerActions academyId={academyId} value={value} title={itemLabel(open, copy)} post={seeds.post}
                onSeed={start} onEditor={(id) => { setOpen(null); nav.openInEditor(id); }} />
            )} />
        )}
        {open && seeds && !framerStart && (
          <div className="flex flex-col gap-4">
            <Preview academyId={academyId} item={open} />
            <ActionButtons post={seeds.post} video={seeds.video} onSeed={start} />
          </div>
        )}
      </LibrarySheet>
    </div>
  );
}
