import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  ArrowLeft, ArrowRight, Check, CloudOff, Copy, Database, Eye, Image, LayoutTemplate, Layers, Loader2, Music, Palette, Redo2,
  Shapes, Smartphone, Trash2, Type, Undo2, X,
} from "lucide-react";
import {
  CREATIVE_TEMPLATES, resolveSource,
  type CreativeBrand, type CreativeData, type MediaSource, type SceneLayer,
} from "@workspace/api-zod";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import {
  canRedo, canUndo, createEditorState, editorReducer, findLayer, sceneBindings, setPath, uniqueLayerId, type LayerChange,
} from "@/lib/creative-editor-state";
import {
  useCreativeBrand, useCreativeProject, useUpdateCreativeProject, type CreativeBrandInfo, type CreativeProject,
} from "@/lib/creative-hub-api";
import { creativeMediaUrl } from "@/lib/creative-hub-media";
import { musicFileUrl, useCreativeMusic } from "@/lib/creative-hub-music-api";
import { sceneTrack } from "@/lib/creative-music";
import { apiUrl } from "@/lib/academy-studio-api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SceneCanvas } from "./scene-canvas";
import { LibraryPicker } from "./library-picker";
import type { SectionProps } from "./types";
import { GENERAL_FIELDS, type EditorApi } from "./editor/editor-api";
import { IconButton } from "./editor/controls";
import { DataPanel } from "./editor/data-panel";
import { FormatPanel } from "./editor/format-panel";
import { useFitWidth, usePlayback } from "./editor/hooks";
import { LayersPanel, layerTitle } from "./editor/layers-panel";
import { MediaPanel } from "./editor/media-panel";
import { MusicPanel } from "./editor/music-panel";
import { useMusicPreview, type MusicPreviewSource } from "./editor/use-music-preview";
import { PreviewDialog } from "./editor/preview-dialog";
import { ShapesPanel } from "./editor/shapes-panel";
import { StylePanel } from "./editor/style-panel";
import { TextPanel } from "./editor/text-panel";
import { Timeline } from "./editor/timeline";
import { useAutosave, type SaveStatus } from "./editor/use-autosave";

type Tool = "text" | "media" | "music" | "shapes" | "layers" | "style" | "format" | "data";
const TOOLS: Array<{ id: Tool; icon: typeof Type }> = [
  { id: "text", icon: Type }, { id: "media", icon: Image }, { id: "shapes", icon: Shapes }, { id: "layers", icon: Layers },
  { id: "style", icon: Palette }, { id: "format", icon: Smartphone }, { id: "data", icon: Database },
];
/** Videos get Music after Media. */
const VIDEO_TOOLS: Array<{ id: Tool; icon: typeof Type }> = [TOOLS[0]!, TOOLS[1]!, { id: "music", icon: Music }, ...TOOLS.slice(2)];
const TOOL_FOR_KIND: Record<SceneLayer["kind"], Tool> = { text: "text", image: "media", video: "media", shape: "shapes" };

/** Replay's own palette, used only if the academy's brand fails to load. */
const FALLBACK_BRAND: CreativeBrand = { primary: "#D4FF4F", accent: "#7B5CFF", ink: "#FFFFFF", paper: "#0B0F1A", muted: "#8A93A6", nameEn: "", nameAr: null };

/** Creative hub → Editor: a phone-first CapCut/Canva for academy managers. */
export function CreativeEditor({ academyId, nav, projectId }: SectionProps & { projectId: number | null }) {
  const copy = useCreativeEditorCopy();
  const project = useCreativeProject(academyId, projectId);
  const brand = useCreativeBrand(academyId);

  if (projectId === null) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface px-6 py-12 text-center" data-testid="creative-editor">
        <LayoutTemplate className="h-8 w-8 text-turf" aria-hidden />
        <h2 className="font-display text-lg font-bold text-text">{copy.emptyTitle}</h2>
        <p className="max-w-sm text-sm text-muted-text">{copy.emptyBody}</p>
        <Button type="button" className="mt-2 min-h-11 rounded-xl" onClick={() => nav.openTemplates()} data-testid="editor-open-templates">
          {copy.emptyCta}
        </Button>
      </div>
    );
  }
  if (project.isLoading || brand.isLoading) {
    return (
      <div className="space-y-3" data-testid="creative-editor" aria-busy>
        <div className="h-10 animate-pulse rounded-xl bg-raised" />
        <div className="mx-auto aspect-[4/5] w-full max-w-sm animate-pulse rounded-2xl bg-raised" />
        <p className="text-center text-sm text-muted-text">{copy.loading}</p>
      </div>
    );
  }
  if (project.isError || !project.data) {
    return (
      <div className="space-y-3 rounded-2xl border border-line bg-surface p-6 text-center" data-testid="creative-editor">
        <p className="text-sm text-red-400" role="alert">{copy.loadError}</p>
        <Button type="button" variant="outline" className="rounded-xl" onClick={() => void project.refetch()}>{copy.retry}</Button>
      </div>
    );
  }
  return <EditorWorkspace key={project.data.id} academyId={academyId} nav={nav} project={project.data} brandInfo={brand.data ?? null} />;
}

function EditorWorkspace({ academyId, nav, project, brandInfo }: SectionProps & { project: CreativeProject; brandInfo: CreativeBrandInfo | null }) {
  const copy = useCreativeEditorCopy();
  const brand = brandInfo?.brand ?? FALLBACK_BRAND;
  const updateProject = useUpdateCreativeProject(academyId);

  const [state, dispatch] = useReducer(editorReducer, project.scene, createEditorState);
  const scene = state.scene;
  const [title, setTitle] = useState(project.title);
  const [titleRev, setTitleRev] = useState(0);
  const [data, setDataState] = useState<CreativeData>(() => (project.data ?? {}) as CreativeData);
  const [dataRev, setDataRev] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("text");
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [picker, setPicker] = useState<{ accept: "image" | "video" | "any"; onPick: (s: MediaSource, m: { durationMs?: number; label?: string }) => void } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const isVideo = scene.durationMs !== undefined;
  const selected = findLayer(scene, selectedId);
  useEffect(() => { if (selectedId && !selected) setSelectedId(null); }, [selectedId, selected]);
  useEffect(() => { if (scene.durationMs !== undefined && timeMs > scene.durationMs) setTimeMs(0); }, [scene.durationMs, timeMs]);
  usePlayback(scene.durationMs, playing, setTimeMs);
  useEffect(() => { if (!isVideo && tool === "music") setTool("media"); }, [isVideo, tool]);

  // ── Soundtrack: plays with the editor's clock (and in Preview) ──────────
  const musicTracks = useCreativeMusic(academyId, isVideo);
  const musicTrack = isVideo ? sceneTrack(scene.music, musicTracks.data) : null;
  const musicSource = useMemo<MusicPreviewSource | null>(
    () => (musicTrack ? { url: musicFileUrl(musicTrack), trackMs: musicTrack.durationMs, loudnessLufs: musicTrack.loudnessLufs } : null),
    [musicTrack?.trackId, musicTrack?.durationMs, musicTrack?.loudnessLufs], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useMusicPreview(musicSource, scene.music, scene.durationMs, timeMs, playing && !previewOpen);

  // ── Autosave ────────────────────────────────────────────────────────────
  const { status, flush } = useAutosave(
    `${state.revision}:${titleRev}:${dataRev}`,
    () => ({ scene, title: title.trim() || copy.titlePlaceholder, data }),
    (p) => updateProject.mutateAsync({ id: project.id, ...p, data: p.data as Record<string, unknown> }),
  );

  // ── What panels read and change ─────────────────────────────────────────
  const template = useMemo(() => CREATIVE_TEMPLATES.find((t) => t.key === (scene.template?.key ?? project.templateKey)) ?? null, [scene.template?.key, project.templateKey]);
  const fields = useMemo(() => {
    const base = template?.fields.length ? template.fields : GENERAL_FIELDS;
    return [...new Set([...base, ...sceneBindings(scene).filter((p) => !p.startsWith("academy."))])];
  }, [template, scene]);

  /** Preview data: the academy's own name and contacts fill {{academy.*}} unless the manager typed others. */
  const viewData = useMemo<CreativeData>(() => ({
    ...data,
    academy: {
      name: (copy.locale === "ar" ? brand.nameAr : null) || brand.nameEn || undefined,
      nameAr: brand.nameAr, instagram: brandInfo?.instagram ?? null, phone: brandInfo?.phone ?? null,
      ...data.academy,
    },
  }), [data, brand, brandInfo, copy.locale]);

  const mediaUrl = useCallback((layer: Extract<SceneLayer, { kind: "image" | "video" }>) => {
    const src = resolveSource(layer.src, viewData);
    if (!src) return null;
    const url = creativeMediaUrl(academyId, src, layer.kind === "video" ? "video" : "still");
    if (url) return url;
    const crest = brandInfo?.crestUrl;
    if (src.type === "crest" && crest) return crest.startsWith("/api/") ? apiUrl(crest) : crest;
    return null;
  }, [academyId, viewData, brandInfo?.crestUrl]);

  const update = useCallback((id: string, change: LayerChange, key?: string) =>
    dispatch({ type: "updateLayer", id, change, key: key ? `${key}:${id}` : undefined, at: Date.now() }), []);

  const ed: EditorApi = {
    academyId, scene, selected, brand, data: viewData, template, fields, mediaUrl, isVideo, timeMs, playing,
    select: setSelectedId,
    update,
    updateScene: (change, key) => dispatch({ type: "updateScene", change, key, at: Date.now() }),
    add: (layer) => { dispatch({ type: "addLayer", layer }); setSelectedId(uniqueLayerId(scene, layer.id)); },
    remove: (id) => { dispatch({ type: "removeLayer", id }); if (selectedId === id) setSelectedId(null); },
    duplicate: (id) => { const newId = uniqueLayerId(scene, `${id}-copy`); dispatch({ type: "duplicateLayer", id, newId }); setSelectedId(newId); },
    move: (id, to) => dispatch({ type: "moveLayer", id, to }),
    setFormat: (format) => dispatch({ type: "setFormat", format }),
    setStyle: (style) => dispatch({ type: "setStyle", style }),
    setPlate: (change, key) => dispatch({ type: "setPlate", change, key: key ? `plate:${key}` : undefined, at: Date.now() }),
    setData: (path, value) => { setDataState((d) => setPath(d, path, value)); setDataRev((r) => r + 1); },
    pick: (accept, onPick) => setPicker({ accept, onPick }),
    setTimeMs: (t) => setTimeMs(t),
    setPlaying,
  };

  // ── Canvas ──────────────────────────────────────────────────────────────
  const { ref: fitRef, width } = useFitWidth(scene.format);
  const selectFromCanvas = (id: string | null) => {
    setSelectedId(id);
    const layer = findLayer(scene, id);
    if (layer && tool !== "layers") setTool(TOOL_FOR_KIND[layer.kind]);
  };
  const onLayerChange = (id: string, change: Partial<Pick<SceneLayer, "x" | "y" | "w" | "h" | "rotation">>) => {
    if (findLayer(scene, id)?.locked) return;
    update(id, change, "canvas");
  };

  // ── Keyboard (desktop) ──────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") { e.preventDefault(); dispatch({ type: e.shiftKey ? "redo" : "undo" }); return; }
      if (mod && k === "y") { e.preventDefault(); dispatch({ type: "redo" }); return; }
      if (k === " " && isVideo && !t?.closest("button")) { e.preventDefault(); setPlaying((p) => !p); return; }
      if (!selected) return;
      if (k === "escape") { setSelectedId(null); return; }
      if (mod && k === "d") { e.preventDefault(); ed.duplicate(selected.id); return; }
      if (selected.locked) return;
      if (k === "delete" || k === "backspace") { e.preventDefault(); ed.remove(selected.id); return; }
      const step = e.shiftKey ? 40 : 4;
      const nudge = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k];
      if (nudge) { e.preventDefault(); update(selected.id, { x: selected.x + nudge[0]!, y: selected.y + nudge[1]! }, "nudge"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const tools = isVideo ? VIDEO_TOOLS : TOOLS;
  const goPublish = async () => { setPlaying(false); await flush(); nav.openInPublish(project.id); };

  const panel = tool === "text" ? <TextPanel ed={ed} />
    : tool === "media" ? <MediaPanel ed={ed} />
    : tool === "music" ? <MusicPanel ed={ed} />
    : tool === "shapes" ? <ShapesPanel ed={ed} />
    : tool === "layers" ? <LayersPanel ed={ed} />
    : tool === "style" ? <StylePanel ed={ed} />
    : tool === "format" ? <FormatPanel ed={ed} />
    : <DataPanel ed={ed} />;

  return (
    <div className="flex flex-col gap-3" data-testid="creative-editor">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-2">
          <input value={title} onChange={(e) => { setTitle(e.target.value.slice(0, 120)); setTitleRev((r) => r + 1); }}
            aria-label={copy.titleLabel} placeholder={copy.titlePlaceholder} dir="auto" data-testid="editor-title"
            className="min-h-10 min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-2 font-display text-lg font-bold text-text hover:border-line focus:border-turf focus:outline-none" />
          <SaveBadge status={status} />
        </div>
        <div className="flex items-center gap-1.5">
          <IconButton label={copy.undo} onClick={() => dispatch({ type: "undo" })} disabled={!canUndo(state)} testId="editor-undo"><Undo2 className="h-4 w-4 rtl:-scale-x-100" /></IconButton>
          <IconButton label={copy.redo} onClick={() => dispatch({ type: "redo" })} disabled={!canRedo(state)} testId="editor-redo"><Redo2 className="h-4 w-4 rtl:-scale-x-100" /></IconButton>
          <Button type="button" variant="outline" className="min-h-10 rounded-xl" onClick={() => { setPlaying(false); setPreviewOpen(true); }} data-testid="editor-preview-open">
            <Eye className="h-4 w-4" /><span className="hidden sm:inline">{copy.preview}</span>
          </Button>
          <Button type="button" className="min-h-10 rounded-xl" onClick={() => void goPublish()} data-testid="editor-next">
            {copy.next}{copy.locale === "ar" ? <ArrowLeft className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        {/* Canvas, selection bar, timeline */}
        <div className="flex min-w-0 flex-col gap-3">
          <div ref={fitRef} aria-label={copy.canvasLabel}
            className="flex justify-center rounded-2xl bg-raised/40 p-2 sm:p-4"
            onPointerDown={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}>
            <SceneCanvas scene={scene} brand={brand} data={viewData} width={Math.max(160, width - 16)} mediaUrl={mediaUrl}
              timeMs={isVideo ? timeMs : undefined} playing={isVideo && playing}
              editable selectedLayerId={selectedId} onSelectLayer={selectFromCanvas} onLayerChange={onLayerChange}
              onTextChange={(id, text) => update(id, { text }, "text")} className="shadow-lg" />
          </div>
          {selected ? (
            <div className="flex items-center gap-1.5 rounded-2xl border border-line bg-surface p-1.5 ps-3" data-testid="editor-selection-bar">
              <bdi dir="auto" className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{layerTitle(selected, copy, viewData)}</bdi>
              <IconButton label={copy.duplicate} onClick={() => ed.duplicate(selected.id)}><Copy className="h-4 w-4" /></IconButton>
              <IconButton label={copy.remove} onClick={() => ed.remove(selected.id)} className="hover:text-live"><Trash2 className="h-4 w-4" /></IconButton>
              <IconButton label={copy.deselect} onClick={() => setSelectedId(null)}><X className="h-4 w-4" /></IconButton>
            </div>
          ) : null}
          {isVideo ? (
            <Timeline ed={ed} music={{
              title: musicTrack?.title ?? null, peaks: musicTrack?.waveform ?? [], trackMs: musicTrack?.durationMs ?? 0,
              startMs: scene.music?.startMs ?? 0, active: tool === "music", onOpen: () => setTool("music"),
            }} />
          ) : null}
        </div>

        {/* Tools: side panel on desktop, panel above a sticky bottom toolbar on phones */}
        <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-4">
          <nav className="hidden gap-1 rounded-2xl border border-line bg-surface p-1 lg:grid" aria-label={copy.toolbar}
            style={{ gridTemplateColumns: `repeat(${tools.length}, minmax(0, 1fr))` }}>
            {tools.map(({ id, icon: Icon }) => <ToolButton key={id} id={id} icon={Icon} active={tool === id} onClick={() => setTool(id)} label={copy.tools[id]} />)}
          </nav>
          <div className="rounded-2xl border border-line bg-surface p-4 lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto" data-testid={`editor-panel-${tool}`}>
            <h2 className="mb-3 font-display text-base font-bold text-text">{copy.tools[tool]}</h2>
            {panel}
          </div>
        </aside>
      </div>

      <nav className="sticky bottom-0 z-20 -mx-1 flex gap-1 overflow-x-auto border-t border-line bg-void/95 px-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1 backdrop-blur lg:hidden"
        aria-label={copy.toolbar} data-testid="editor-toolbar">
        {tools.map(({ id, icon: Icon }) => <ToolButton key={id} id={id} icon={Icon} active={tool === id} onClick={() => setTool(id)} label={copy.tools[id]} />)}
      </nav>

      {picker ? (
        <LibraryPicker academyId={academyId} accept={picker.accept}
          onPick={(src, meta) => { picker.onPick(src, meta); setPicker(null); }} onClose={() => setPicker(null)} />
      ) : null}
      <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} scene={scene} brand={brand} data={viewData} mediaUrl={mediaUrl} music={musicSource} />
    </div>
  );
}

function ToolButton({ id, icon: Icon, active, onClick, label }: { id: Tool; icon: typeof Type; active: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} data-testid={`editor-tool-${id}`}
      className={cn("flex min-h-14 min-w-[3.75rem] flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-semibold transition-colors",
        active ? "bg-turf text-void" : "text-muted-text hover:text-text")}>
      <Icon className="h-5 w-5" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

function SaveBadge({ status }: { status: SaveStatus }) {
  const copy = useCreativeEditorCopy();
  const Icon = status === "saving" ? Loader2 : status === "error" ? CloudOff : status === "saved" ? Check : null;
  return (
    <span role="status" data-testid="editor-save-status" data-status={status}
      className={cn("flex shrink-0 items-center gap-1 text-xs", status === "error" ? "text-live" : status === "saved" ? "text-turf" : "text-muted-text")}>
      {Icon ? <Icon className={cn("h-3.5 w-3.5", status === "saving" && "animate-spin")} aria-hidden /> : <span className="h-1.5 w-1.5 rounded-full bg-floodlight" aria-hidden />}
      {copy.save[status]}
    </span>
  );
}
