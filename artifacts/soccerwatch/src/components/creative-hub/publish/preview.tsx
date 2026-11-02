import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw, Wand2 } from "lucide-react";
import { resolveSource, type CreativeBrand, type CreativeData } from "@workspace/api-zod";
import { useCreativePublishCopy } from "@/i18n/creative-publish-strings";
import { apiUrl } from "@/lib/academy-studio-api";
import { creativeKeys, useRenderCreativeProject, type CreativeProject } from "@/lib/creative-hub-api";
import { creativeMediaUrl } from "@/lib/creative-hub-media";
import { SceneCanvas } from "../scene-canvas";
import { Notice, PrimaryButton, useWidth } from "./ui";

const FALLBACK_BRAND: CreativeBrand = { primary: "#7B5CFF", accent: "#D4FF4F", ink: "#0B0F1A", paper: "#FFFFFF", muted: "#8A93A6", nameEn: "", nameAr: null };

export const isRendered = (p: CreativeProject) => p.renderStatus === "done" && Boolean(p.outputUrl);
export const isRendering = (p: CreativeProject) => p.renderStatus === "queued" || p.renderStatus === "rendering";
export const isVideoProject = (p: Pick<CreativeProject, "kind" | "outputMime">) => (p.outputMime ? p.outputMime.startsWith("video/") : p.kind === "video");

/** The rendered file when there is one, else the live scene. */
export function PublishPreview({ academyId, project, brand }: { academyId: number; project: CreativeProject; brand: CreativeBrand | undefined }) {
  const copy = useCreativePublishCopy();
  const [ref, width] = useWidth<HTMLDivElement>();
  const ratio = project.format === "story" ? 1920 / 1080 : project.format === "square" ? 1 : 1350 / 1080;
  // Keep a 9:16 story from filling a whole phone screen.
  const maxWidth = project.format === "story" ? 300 : 420;
  const shown = Math.min(width || maxWidth, maxWidth);
  const data = (project.data ?? undefined) as CreativeData | undefined;
  const src = project.outputUrl ? `${apiUrl(project.outputUrl)}${project.renderedAt ? `?v=${encodeURIComponent(project.renderedAt)}` : ""}` : null;
  return (
    <div ref={ref} className="flex w-full justify-center" data-testid="publish-preview">
      <div className="relative overflow-hidden rounded-2xl bg-raised shadow-lg" style={{ width: shown, height: shown * ratio }}>
        {isRendered(project) && src ? (
          isVideoProject(project)
            ? <video src={src} controls playsInline preload="metadata" className="h-full w-full bg-black object-contain" aria-label={copy.render.preview} />
            : <img src={src} alt={project.title || copy.render.preview} className="h-full w-full object-contain" />
        ) : shown > 0 && (
          <SceneCanvas
            scene={project.scene}
            brand={brand ?? FALLBACK_BRAND}
            data={data}
            width={shown}
            timeMs={0}
            mediaUrl={(layer) => {
              const resolved = resolveSource(layer.src, data ?? {});
              return resolved ? creativeMediaUrl(academyId, resolved, layer.kind === "video" ? "video" : "still") : null;
            }}
          />
        )}
        {isRendering(project) && (
          <div className="absolute inset-0 grid place-items-center bg-void/60 text-sm font-semibold text-text">
            <span className="flex items-center gap-2"><Loader2 className="h-5 w-5 animate-spin text-floodlight" aria-hidden="true" />
              {project.renderStatus === "queued" ? copy.render.queued : copy.render.rendering}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Render / Render again, with progress for videos. While the engine works the
 * project is re-read every 3 s (useCreativeProject's key) until done or failed.
 */
export function RenderPanel({ academyId, project }: { academyId: number; project: CreativeProject }) {
  const copy = useCreativePublishCopy();
  const qc = useQueryClient();
  const render = useRenderCreativeProject(academyId);
  const busy = isRendering(project);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      void qc.invalidateQueries({ queryKey: creativeKeys.project(academyId, project.id) });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [busy, qc, academyId, project.id]);

  const rendered = isRendered(project);
  const stale = !rendered && !busy && project.renderStatus === "none" && Boolean(project.renderedAt);
  return (
    <div className="space-y-2" data-testid="publish-render">
      {busy ? (
        <div className="space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-raised" role="progressbar" aria-label={copy.render.rendering}>
            <div className="h-full w-1/3 animate-[publish-indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-floodlight" />
          </div>
          <p className="text-xs text-muted-text">{project.renderStatus === "queued" ? copy.render.queued : copy.render.rendering}
            {project.kind === "video" ? ` ${copy.render.videoHint}` : ""}</p>
          <style>{"@keyframes publish-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}[dir=rtl] [role=progressbar]>div{animation-direction:reverse}"}</style>
        </div>
      ) : (
        <>
          {project.renderStatus === "failed" && <Notice tone="error"><AlertTriangle className="me-1 inline h-4 w-4" aria-hidden="true" />{copy.render.failed}{project.renderError ? `: ${project.renderError}` : ""}</Notice>}
          {stale && <Notice tone="warn">{copy.render.stale}</Notice>}
          {!rendered && !stale && project.renderStatus !== "failed" && <Notice>{copy.render.needed}</Notice>}
          {render.isError && <Notice tone="error">{(render.error as Error).message}</Notice>}
          <PrimaryButton pending={render.isPending} onClick={() => render.mutate(project.id)} data-testid="button-render"
            className={rendered ? "bg-raised text-text hover:bg-raised/80" : undefined}>
            {rendered ? <RefreshCw className="me-2 h-4 w-4" aria-hidden="true" /> : <Wand2 className="me-2 h-4 w-4" aria-hidden="true" />}
            {rendered ? copy.render.rerender : copy.render.render}
          </PrimaryButton>
        </>
      )}
    </div>
  );
}
