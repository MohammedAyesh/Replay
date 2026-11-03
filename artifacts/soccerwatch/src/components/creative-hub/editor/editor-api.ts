import type { CreativeBrand, CreativeData, CreativeFormat, CreativeStyle, MediaSource, Scene, SceneLayer, TemplateMeta } from "@workspace/api-zod";
import type { LayerChange, PlateChange } from "@/lib/creative-editor-state";

/** What the editor's panels and timeline get to read and change. Built once per render in editor.tsx. */
export type EditorApi = {
  academyId: number;
  scene: Scene;
  selected: SceneLayer | null;
  select: (id: string | null) => void;
  /** Change one layer. Changes with the same `key` close together become one undo step. */
  update: (id: string, change: LayerChange, key?: string) => void;
  updateScene: (change: Partial<Pick<Scene, "durationMs" | "background" | "music">>, key?: string) => void;
  /** Add a layer on top and select it. */
  add: (layer: SceneLayer) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  move: (id: string, to: "up" | "down" | "top" | "bottom" | number) => void;
  setFormat: (format: CreativeFormat) => void;
  setStyle: (style: CreativeStyle) => void;
  /** Change the background plate (adds the style's plate back if the design has none). Same `key` coalesces like update. */
  setPlate: (change: PlateChange, key?: string) => void;
  brand: CreativeBrand;
  data: CreativeData;
  setData: (path: string, value: unknown) => void;
  template: TemplateMeta | null;
  /** The template's {{binding}} fields, or a general set for designs without a template. */
  fields: string[];
  /** Open the Library picker. */
  pick: (accept: "image" | "video" | "any", onPick: (source: MediaSource, meta: { durationMs?: number; label?: string }) => void) => void;
  /** For SceneCanvas previews inside panels. */
  mediaUrl: (layer: Extract<SceneLayer, { kind: "image" | "video" }>) => string | null;
  isVideo: boolean;
  timeMs: number;
  setTimeMs: (t: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
};

/** Bindings offered when a design has no template (or the template lists none). */
export const GENERAL_FIELDS = [
  "custom.headline", "match.ownName", "match.opponent", "match.ownScore", "match.opponentScore", "match.date", "match.time",
  "match.place", "match.squad", "player.number",
];
