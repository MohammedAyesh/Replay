import { useMemo, useState, type ReactNode } from "react";
import { Eye, Film, Image as ImageIcon, Loader2 } from "lucide-react";
import { CREATIVE_FORMATS, resolveSource, type CreativeData, type SceneLayer } from "@workspace/api-zod";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SceneCanvas } from "@/components/creative-hub/scene-canvas";
import { previewTimeMs } from "@/components/creative-hub/templates/template-card";
import { useAcademyInstagramCopy } from "@/i18n/academy-instagram-strings";
import { apiUrl } from "@/lib/academy-studio-api";
import { useCreativeBrand, useCreativeProject } from "@/lib/creative-hub-api";
import { creativeMediaUrl } from "@/lib/creative-hub-media";
import { cn } from "@/lib/utils";

/**
 * Academy Instagram autopilot: a design's picture before it is rendered. Its rendered image when
 * there is one; otherwise the design itself, drawn live from its saved scene in the academy's
 * colours and crest (it used to be a bare icon). Tapping it opens the preview: the rendered video
 * or image, or the design at full size.
 */

type Media = Extract<SceneLayer, { kind: "image" | "video" }>;
type Lite = { id: number; kind: string; renderStatus: string; outputUrl: string | null; title?: string; about?: string | null };

function useDesign(academyId: number, projectId: number | null) {
  const project = useCreativeProject(academyId, projectId);
  const brand = useCreativeBrand(academyId);
  const data = (project.data?.data ?? {}) as CreativeData;
  const info = brand.data;
  const viewData = useMemo<CreativeData>(() => ({
    ...data,
    academy: { name: info?.brand.nameEn || undefined, nameAr: info?.brand.nameAr ?? null, instagram: info?.instagram ?? null, phone: info?.phone ?? null, ...data.academy },
  }), [data, info]);
  const mediaUrl = (l: Media) => {
    const src = resolveSource(l.src, viewData);
    if (!src) return null;
    const url = creativeMediaUrl(academyId, src, "still");
    if (url) return url;
    const crest = info?.crestUrl;
    if (src.type === "crest" && crest) return crest.startsWith("/api/") ? apiUrl(crest) : crest;
    return null;
  };
  return { scene: project.data?.scene ?? null, brand: info?.brand ?? null, data: viewData, mediaUrl, loading: project.isLoading || brand.isLoading };
}

function LiveDesign({ academyId, projectId, width }: { academyId: number; projectId: number; width: number }) {
  const d = useDesign(academyId, projectId);
  if (!d.scene || !d.brand) return <span className={cn("grid h-full w-full place-items-center bg-raised", d.loading && "animate-pulse")} />;
  return <SceneCanvas scene={d.scene} brand={d.brand} data={d.data} width={width} timeMs={previewTimeMs(d.scene)} mediaUrl={d.mediaUrl} />;
}

/** The small picture on a suggestion or calendar row (44 px wide, its own shape). */
export function ProjectThumb({ academyId, project }: { academyId: number; project: Lite | null }) {
  const [open, setOpen] = useState(false);
  const Icon = project?.kind === "video" ? Film : ImageIcon;
  if (!project) return <span className="grid h-14 w-11 shrink-0 place-items-center rounded-lg bg-turf/10 text-turf"><Icon className="h-4 w-4" aria-hidden="true" /></span>;
  const still = project.outputUrl && project.kind === "image" && project.renderStatus === "done" ? apiUrl(project.outputUrl) : null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="relative h-14 w-11 shrink-0 overflow-hidden rounded-lg bg-raised" data-testid={`academy-ig-thumb-${project.id}`}>
        {still ? <img src={still} alt="" className="h-full w-full object-cover" /> : <span className="pointer-events-none block h-full w-full"><LiveDesign academyId={academyId} projectId={project.id} width={44} /></span>}
        {project.kind === "video" ? <span className="absolute bottom-0.5 end-0.5 rounded bg-black/60 p-0.5 text-white"><Film className="h-2.5 w-2.5" aria-hidden="true" /></span> : null}
      </button>
      {open ? <ProjectPreview academyId={academyId} project={project} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** "Preview" as a button with its word (for rows that have room). */
export function PreviewButton({ academyId, project, label }: { academyId: number; project: Lite; label: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-testid={`academy-ig-preview-${project.id}`}
        className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line px-2.5 text-xs font-semibold text-muted-text hover:text-text">
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />{label}
      </button>
      {open ? <ProjectPreview academyId={academyId} project={project} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ProjectPreview({ academyId, project, onClose }: { academyId: number; project: Lite; onClose: () => void }) {
  const copy = useAcademyInstagramCopy();
  const d = useDesign(academyId, project.id);
  const url = project.outputUrl && project.renderStatus === "done" ? apiUrl(project.outputUrl) : null;
  const fmt = d.scene ? CREATIVE_FORMATS[d.scene.format] : null;
  // A story fits a phone screen at 300 wide; posts, squares and 16:9 at 360.
  const width = fmt && fmt.h > fmt.w * 1.4 ? 300 : 360;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir={copy.locale === "ar" ? "rtl" : "ltr"} className="max-h-[92dvh] overflow-y-auto border-line bg-surface text-text sm:max-w-md" data-testid="academy-ig-preview">
        <DialogHeader className="text-start">
          <DialogTitle dir="auto">{project.title || copy.fromYou}</DialogTitle>
          <DialogDescription className="text-start text-muted-text" dir="auto">{project.about ?? ""}</DialogDescription>
        </DialogHeader>
        <div className="mx-auto">
          {url ? (project.kind === "video"
            ? <video src={url} controls autoPlay playsInline className="mx-auto max-h-[70dvh] rounded-xl bg-black" />
            : <img src={url} alt="" className="mx-auto max-h-[70dvh] rounded-xl object-contain" />)
            : d.scene && d.brand ? (
              <div className="space-y-2">
                <SceneCanvas scene={d.scene} brand={d.brand} data={d.data} width={width} timeMs={previewTimeMs(d.scene)} mediaUrl={d.mediaUrl} className="mx-auto overflow-hidden rounded-xl" />
                <p className="text-center text-xs text-muted-text">{copy.previewDesign}</p>
              </div>
            ) : <p className="flex items-center gap-2 py-8 text-sm text-muted-text"><Loader2 className="h-4 w-4 animate-spin" />…</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
