import { Loader2, Play } from "lucide-react";
import type { CreativeBrand, CreativeData, Scene, SceneLayer, TemplateMeta } from "@workspace/api-zod";
import { SceneCanvas } from "../scene-canvas";
import { useSeen } from "./hooks";
import { cn } from "@/lib/utils";

type MediaLayer = Extract<SceneLayer, { kind: "image" | "video" }>;

/** The frame of a video template the gallery shows: after the overlays have come in. */
export const previewTimeMs = (scene: Scene) => (scene.durationMs ? Math.min(4000, Math.max(0, scene.durationMs - 3000)) : undefined);

export function TemplateCard({
  meta, title, scene, data, brand, width, mediaUrl, onOpen, busy, disabled, failed, labels,
}: {
  meta: TemplateMeta;
  title: string;
  scene: Scene;
  data: CreativeData;
  brand: CreativeBrand;
  width: number;
  mediaUrl: (layer: MediaLayer) => string | null;
  onOpen: () => void;
  busy: boolean;
  disabled: boolean;
  failed: string | null;
  labels: { video: string; seconds: (n: number) => string; creating: string; open: string };
}) {
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const ratio = scene.format === "story" ? 1920 / 1080 : scene.format === "square" ? 1 : 1350 / 1080;
  return (
    <div className="min-w-0" data-testid={`creative-template-${meta.key}`}>
      <button ref={ref} type="button" onClick={onOpen} disabled={disabled} aria-label={labels.open}
        className={cn("group relative block w-full overflow-hidden rounded-xl border border-line bg-raised text-start transition",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turf",
          disabled && !busy ? "opacity-60" : "hover:border-turf")}
        style={{ height: Math.round(width * ratio) }}>
        {seen && width > 0 ? (
          <SceneCanvas scene={scene} brand={brand} data={data} width={width} timeMs={previewTimeMs(scene)} mediaUrl={mediaUrl}
            className="pointer-events-none" />
        ) : null}
        {meta.kind === "video" ? (
          <span className="absolute start-2 top-2 flex items-center gap-1 rounded-full bg-void/80 px-2 py-0.5 text-[11px] font-semibold text-white">
            <Play className="h-3 w-3" aria-hidden />
            {labels.video} · <bdi>{labels.seconds(Math.round((scene.durationMs ?? 0) / 1000))}</bdi>
          </span>
        ) : null}
        {busy ? (
          <span className="absolute inset-0 grid place-items-center bg-void/60 text-sm font-semibold text-white">
            <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{labels.creating}</span>
          </span>
        ) : null}
      </button>
      <p className="mt-1.5 truncate text-xs font-semibold text-text">{title}</p>
      {failed ? <p className="text-xs text-red-400" role="alert">{failed}</p> : null}
    </div>
  );
}
