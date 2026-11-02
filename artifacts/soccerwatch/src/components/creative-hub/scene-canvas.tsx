import type { CreativeBrand, CreativeData, Scene, SceneLayer } from "@workspace/api-zod";

/**
 * Live preview of a scene, drawn with the DOM at any width (scaled from the
 * 1080-wide canvas). The API's renderer draws the same scene for export.
 * Props are frozen: Editor, Templates, For you and Publish all rely on them.
 */
export type SceneCanvasProps = {
  scene: Scene;
  brand: CreativeBrand;
  data?: CreativeData;
  /** Display width in CSS pixels. */
  width: number;
  /** Current time for video scenes (ms). Ignored for stills. */
  timeMs?: number;
  playing?: boolean;
  /** Resolves a media source to a URL the browser can load (thumb for stills, video for clips). */
  mediaUrl?: (layer: Extract<SceneLayer, { kind: "image" | "video" }>) => string | null;
  editable?: boolean;
  selectedLayerId?: string | null;
  onSelectLayer?: (id: string | null) => void;
  /** Drag / resize result, in canvas pixels. */
  onLayerChange?: (id: string, change: Partial<Pick<SceneLayer, "x" | "y" | "w" | "h" | "rotation">>) => void;
  /** Inline text edit result. */
  onTextChange?: (id: string, text: string) => void;
  className?: string;
};

export function SceneCanvas({ scene, width, className }: SceneCanvasProps) {
  const ratio = scene.format === "story" ? 1920 / 1080 : scene.format === "square" ? 1 : 1350 / 1080;
  return <div className={className} style={{ width, height: width * ratio, background: "#111" }} data-testid="scene-canvas" />;
}
