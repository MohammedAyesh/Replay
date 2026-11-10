import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowUpRight,
  Circle,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eraser,
  Link2,
  Maximize,
  Minus,
  Pause,
  PenLine,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Save,
  Shapes,
  Slash,
  Trash2,
  Type,
  Undo2,
  Users,
  X,
  Goal,
  Share2,
  StickyNote,
} from "lucide-react";
import {
  COACH_COLORS,
  COACH_MAX_SHAPES,
  COACH_MAX_SPOTLIGHTS,
  COACH_WIDTHS,
  EMPTY_COACH_BOARD,
  coachBoxAt,
  type CoachBoard,
  type CoachNote,
  type CoachNoteInput,
  type CoachShape,
  type CoachTracks,
  type CoachView,
} from "@workspace/api-zod";
import { useCoachCopy } from "@/i18n/coach-strings";
import type { CoachPlayer as RosterPlayer, CoachVideo } from "@/lib/academy-coach-api";
import {
  WHOLE,
  boxesAt,
  drawBoard,
  easeTowards,
  emptyTrackStore,
  frameRect,
  hitPlayer,
  mergeTracks,
  missingWindow,
  nextSpotColor,
  noteMoment,
  panBy,
  playerLabel,
  thinStroke,
  toShare,
  toScreen,
  viewOf,
  zoomAt,
  type Pt,
  type TrackStore,
} from "@/lib/coach-board";
import { cn } from "@/lib/utils";
import { useCoachVideo } from "./use-coach-video";

export type CoachTool = "spotlight" | "pen" | "arrow" | "line" | "circle" | "zone" | "text";
const TOOLS: Array<{ id: CoachTool; icon: typeof Crosshair }> = [
  { id: "spotlight", icon: Crosshair },
  { id: "pen", icon: PenLine },
  { id: "arrow", icon: ArrowUpRight },
  { id: "line", icon: Slash },
  { id: "circle", icon: Circle },
  { id: "zone", icon: Shapes },
  { id: "text", icon: Type },
];
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const PLAY_FOR = [4, 8, 12, 20];

export type CoachPlayerProps = {
  title: string;
  subtitle?: string | null;
  video: CoachVideo;
  players: RosterPlayer[];
  analysed: boolean;
  loadTracks: (from: number, to: number) => Promise<CoachTracks>;
  onClose: () => void;
  /** a family's view of one shared note: no tools, the note's own board, stops at its end */
  readOnly?: boolean;
  /** open on this note */
  initialNote?: CoachNote | null;
  /** staff: the match's saved moments and who they could be about */
  notes?: CoachNote[];
  lineup?: Array<{ playerId: number; name: string; shirtNumber: number | null }>;
  onSaveNote?: (input: CoachNoteInput, id?: number) => Promise<CoachNote>;
  onDeleteNote?: (id: number) => Promise<void>;
  canEdit?: (note: CoachNote) => boolean;
};

const clock = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = v % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
let idSeq = 0;
const newId = () => `s${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function CoachPlayer(props: CoachPlayerProps) {
  const copy = useCoachCopy();
  const { video: v, readOnly = false } = props;
  const aspect = v.width > 0 && v.height > 0 ? v.width / v.height : 32 / 9;
  const startAt = props.initialNote ? props.initialNote.atMs / 1000 : v.matchWindow?.from ?? 0;

  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { error: videoError } = useCoachVideo(videoRef, v.videoUrl, startAt);

  // Everything the draw loop reads lives in refs; state mirrors drive the controls.
  const [board, setBoardState] = useState<CoachBoard>(() => props.initialNote?.board ?? EMPTY_COACH_BOARD);
  const boardRef = useRef(board);
  const history = useRef<CoachBoard[]>([]);
  const setBoard = useCallback((next: CoachBoard, remember = true) => {
    if (remember) history.current = [...history.current.slice(-49), boardRef.current];
    boardRef.current = next;
    setBoardState(next);
  }, []);
  const [view, setViewState] = useState<CoachView>(() => props.initialNote?.board.view ?? WHOLE);
  const viewRef = useRef(view);
  const setView = useCallback((next: CoachView) => { viewRef.current = next; setViewState(next); }, []);
  const [follow, setFollow] = useState(Boolean(props.initialNote?.board.view?.follow));
  const followRef = useRef(follow);
  followRef.current = follow;
  const [tool, setTool] = useState<CoachTool>("spotlight");
  const [color, setColor] = useState<string>(COACH_COLORS[0]);
  const [width, setWidth] = useState<number>(COACH_WIDTHS[1]);
  const [dashed, setDashed] = useState(false);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(startAt);
  const [duration, setDuration] = useState(v.duration ?? 0);
  const [speed, setSpeed] = useState(1);
  // The side panel starts open where there is room for it beside the video.
  const [panel, setPanel] = useState<"players" | "notes" | null>(() => (readOnly || (typeof window !== "undefined" && window.innerWidth < 1024) ? null : "players"));
  const [saveOpen, setSaveOpen] = useState<{ id?: number } | null>(null);
  const [textAt, setTextAt] = useState<{ p: Pt; x: number; y: number } | null>(null);
  const [activeNote, setActiveNote] = useState<CoachNote | null>(props.initialNote ?? null);
  const activeNoteRef = useRef(activeNote);
  activeNoteRef.current = activeNote;
  const draft = useRef<CoachShape | null>(null);
  const store = useRef<TrackStore>(emptyTrackStore());
  const [, setTracksVersion] = useState(0);
  const loading = useRef(false);

  const byRoster = useMemo(() => new Map(props.players.map((p) => [p.rosterId, p])), [props.players]);
  const unknownIndex = useMemo(() => {
    const m = new Map<string, number>();
    props.players.filter((p) => !p.name && !p.number && p.shirtNumber === null).forEach((p, i) => m.set(p.rosterId, i + 1));
    return m;
  }, [props.players]);
  const label = useCallback((rosterId: string) => {
    const p = byRoster.get(rosterId);
    if (!p) return "";
    return playerLabel(p) || copy.unknownPlayer(unknownIndex.get(rosterId) ?? 0);
  }, [byRoster, copy, unknownIndex]);
  const labelRef = useRef(label);
  labelRef.current = label;

  // ── Tracks: keep the next half-minute loaded around the playhead ──────────
  useEffect(() => {
    if (!props.analysed) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || loading.current) return;
      const t = videoRef.current?.currentTime ?? startAt;
      const want = missingWindow(store.current, t);
      if (!want) return;
      loading.current = true;
      try {
        const add = await props.loadTracks(want[0], want[1]);
        if (!stopped) {
          store.current = mergeTracks(store.current, add);
          setTracksVersion((n) => n + 1);
        }
      } catch {
        // Mark the stretch as asked for, so a failing window is not retried every half second.
        store.current = mergeTracks(store.current, { from: want[0], to: want[1], players: {}, ball: [] });
      } finally {
        loading.current = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 500);
    return () => { stopped = true; window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.analysed, props.loadTracks]);

  // ── The draw loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    let centre: Pt | null = null;
    let lastUi = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const stage = stageRef.current;
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!stage || !canvas || !video) return;
      const W = stage.clientWidth;
      const H = stage.clientHeight;
      const t = video.currentTime;
      // A family's note stops at its end.
      const note = activeNoteRef.current;
      if (readOnly && note?.endMs && !video.paused && t * 1000 >= note.endMs) video.pause();
      // Follow: ease the camera towards the first spotlighted player.
      let vw = viewRef.current;
      const first = boardRef.current.spotlights[0];
      if (followRef.current && first && vw.zoom > 1.01) {
        const boxes = store.current.players.get(first.rosterId);
        const b = boxes ? coachBoxAt(boxes, t) : null;
        if (b) {
          const target: Pt = [b[0] + b[2] / 2, b[1] + b[3] / 2];
          centre = centre ? easeTowards(centre, target, video.paused ? 0.35 : 0.12) : target;
          vw = viewOf(frameRect(W, H, aspect, { ...vw, cx: centre[0], cy: centre[1] }), W, H, vw.zoom);
          viewRef.current = { ...vw, follow: true };
        }
      } else {
        centre = null;
      }
      const rect = frameRect(W, H, aspect, vw);
      video.style.left = `${rect.left}px`;
      video.style.top = `${rect.top}px`;
      video.style.width = `${rect.width}px`;
      video.style.height = `${rect.height}px`;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = Math.round(W * dpr);
      const ch = Math.round(H * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, cw, ch);
      drawBoard(ctx, { rect, dpr, t, paused: video.paused, board: boardRef.current, draft: draft.current, store: store.current, label: labelRef.current });
      if (now - lastUi > 200) {
        lastUi = now;
        setTime(t);
        if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [aspect, readOnly]);

  // ── Playback ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => { video.removeEventListener("play", onPlay); video.removeEventListener("pause", onPause); };
  }, []);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = speed; }, [speed]);

  const seek = useCallback((t: number) => {
    const video = videoRef.current;
    if (!video) return;
    const end = Number.isFinite(video.duration) && video.duration > 0 ? video.duration - 0.1 : Infinity;
    video.currentTime = Math.max(0, Math.min(end, t));
    setTime(video.currentTime);
  }, []);
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      const note = activeNoteRef.current;
      if (readOnly && note?.endMs && video.currentTime * 1000 >= note.endMs - 50) video.currentTime = note.atMs / 1000;
      void video.play().catch(() => undefined);
    } else video.pause();
  }, [readOnly]);
  const step = useCallback((frames: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    seek(video.currentTime + frames / (v.fps || 20));
  }, [seek, v.fps]);

  // ── Board edits ───────────────────────────────────────────────────────────
  const toggleSpot = useCallback((rosterId: string) => {
    const b = boardRef.current;
    if (b.spotlights.some((s) => s.rosterId === rosterId)) {
      setBoard({ ...b, spotlights: b.spotlights.filter((s) => s.rosterId !== rosterId) });
      return;
    }
    if (b.spotlights.length >= COACH_MAX_SPOTLIGHTS) return;
    setBoard({ ...b, spotlights: [...b.spotlights, { rosterId, color: nextSpotColor(b.spotlights.map((s) => s.color), COACH_COLORS) }] });
  }, [setBoard]);
  const addShape = useCallback((shape: CoachShape) => {
    const b = boardRef.current;
    setBoard({ ...b, shapes: [...b.shapes, shape].slice(-COACH_MAX_SHAPES) });
  }, [setBoard]);
  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) { boardRef.current = prev; setBoardState(prev); }
  }, []);
  const clearShapes = useCallback(() => setBoard({ ...boardRef.current, shapes: [] }), [setBoard]);
  const clearAll = useCallback(() => {
    setBoard({ ...EMPTY_COACH_BOARD });
    setActiveNote(null);
  }, [setBoard]);

  // ── Pointer: spotlight taps, pan and pinch, drawing ───────────────────────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: "tap" | "pan" | "pinch" | "draw"; x0: number; y0: number; moved: boolean; dist?: number; points?: Pt[] } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const currentRect = () => {
    const s = stageRef.current!;
    return frameRect(s.clientWidth, s.clientHeight, aspect, viewRef.current);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!stageRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", x0: (a.x + b.x) / 2, y0: (a.y + b.y) / 2, moved: true, dist: Math.hypot(a.x - b.x, a.y - b.y) };
      draft.current = null;
      return;
    }
    if (readOnly || tool === "spotlight") { gesture.current = { kind: "tap", x0: p.x, y0: p.y, moved: false }; return; }
    if (tool === "text") { gesture.current = { kind: "tap", x0: p.x, y0: p.y, moved: false }; return; }
    videoRef.current?.pause();
    const share = toShare(currentRect(), p.x, p.y);
    const atMs = Math.round((videoRef.current?.currentTime ?? 0) * 1000);
    gesture.current = { kind: "draw", x0: p.x, y0: p.y, moved: false, points: [[p.x, p.y]] };
    const base = { id: newId(), color, atMs };
    draft.current = tool === "pen" ? { ...base, kind: "pen", width, points: [share, share] }
      : tool === "zone" ? { ...base, kind: "zone", points: [share, share, share] }
      : tool === "circle" ? { ...base, kind: "circle", width, from: share, to: share }
      : { ...base, kind: tool, width, from: share, to: share, dashed };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    const p = local(e);
    const prev = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, p);
    const s = stageRef.current!;
    if (g.kind === "pinch" && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.dist && dist > 0) setView(zoomAt(viewRef.current, s.clientWidth, s.clientHeight, aspect, (a.x + b.x) / 2, (a.y + b.y) / 2, dist / g.dist));
      g.dist = dist;
      return;
    }
    if (Math.hypot(p.x - g.x0, p.y - g.y0) > 6) g.moved = true;
    if (g.kind === "tap" && g.moved && viewRef.current.zoom > 1.01) g.kind = "pan";
    if (g.kind === "pan") {
      setFollow(false);
      setView(panBy(viewRef.current, s.clientWidth, s.clientHeight, aspect, p.x - prev.x, p.y - prev.y));
      return;
    }
    if (g.kind === "draw" && draft.current) {
      const share = toShare(currentRect(), p.x, p.y);
      const d = draft.current;
      if (d.kind === "pen" || d.kind === "zone") {
        g.points!.push([p.x, p.y]);
        const rect = currentRect();
        draft.current = { ...d, points: thinStroke(g.points!, 3).map(([x, y]) => toShare(rect, x, y)) } as CoachShape;
      } else if (d.kind === "arrow" || d.kind === "line" || d.kind === "circle") {
        draft.current = { ...d, to: share };
      }
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (!g) return;
    const p = local(e);
    if (g.kind === "tap" && !g.moved) {
      const rect = currentRect();
      const share = toShare(rect, p.x, p.y);
      if (tool === "text" && !readOnly) {
        videoRef.current?.pause();
        setTextAt({ p: share, x: p.x, y: p.y });
        return;
      }
      if (readOnly) { togglePlay(); return; }
      const t = videoRef.current?.currentTime ?? 0;
      const hit = hitPlayer(boxesAt(store.current, t), share);
      if (hit) toggleSpot(hit);
      return;
    }
    if (g.kind === "draw" && draft.current) {
      const d = draft.current;
      draft.current = null;
      const rect = currentRect();
      const big = (a: Pt, b: Pt) => { const [ax, ay] = toScreen(rect, a); const [bx, by] = toScreen(rect, b); return Math.hypot(ax - bx, ay - by) > 8; };
      if ((d.kind === "pen" && d.points.length >= 2) || (d.kind === "zone" && d.points.length >= 3)
        || ((d.kind === "arrow" || d.kind === "line" || d.kind === "circle") && big(d.from, d.to))) addShape(d);
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const s = stageRef.current;
    if (!s) return;
    const p = local(e);
    setView(zoomAt(viewRef.current, s.clientWidth, s.clientHeight, aspect, p.x, p.y, e.deltaY < 0 ? 1.15 : 1 / 1.15));
  };
  const zoomBy = (factor: number) => {
    const s = stageRef.current;
    if (!s) return;
    setView(zoomAt(viewRef.current, s.clientWidth, s.clientHeight, aspect, s.clientWidth / 2, s.clientHeight / 2, factor));
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "Escape") { if (saveOpen) setSaveOpen(null); else if (textAt) setTextAt(null); else props.onClose(); return; }
      if (e.key === " ") { e.preventDefault(); togglePlay(); return; }
      if (e.key === "ArrowLeft") { seek((videoRef.current?.currentTime ?? 0) - 5); return; }
      if (e.key === "ArrowRight") { seek((videoRef.current?.currentTime ?? 0) + 5); return; }
      if (e.key === ",") { step(-1); return; }
      if (e.key === ".") { step(1); return; }
      if (readOnly) return;
      if ((e.key === "z" || e.key === "Z") && !e.shiftKey) { undo(); return; }
      if (e.key === "f" || e.key === "F") { setFollow((f) => !f); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= TOOLS.length) setTool(TOOLS[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props, readOnly, saveOpen, seek, step, textAt, togglePlay, undo]);

  // ── Notes ─────────────────────────────────────────────────────────────────
  const openNote = (note: CoachNote) => {
    videoRef.current?.pause();
    setActiveNote(note);
    history.current = [];
    boardRef.current = note.board;
    setBoardState(note.board);
    if (note.board.view) { setView(note.board.view); setFollow(Boolean(note.board.view.follow)); }
    seek(note.atMs / 1000);
  };

  const matchFrom = v.matchWindow?.from ?? 0;
  const clockOf = (t: number) => (v.matchWindow ? `${clock(t - matchFrom)}` : clock(t));
  const total = duration || v.duration || 0;
  const spotRosterIds = new Set(board.spotlights.map((s) => s.rosterId));
  const tracked = props.analysed ? boxesAt(store.current, time) : new Map();
  const ours = props.players.filter((p) => p.playerId !== null);
  const others = props.players.filter((p) => p.playerId === null);

  const playerRow = (p: RosterPlayer) => {
    const spot = board.spotlights.find((s) => s.rosterId === p.rosterId);
    const visible = tracked.has(p.rosterId);
    return (
      <button key={p.rosterId} type="button" onClick={() => toggleSpot(p.rosterId)} disabled={!props.analysed}
        className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm transition-colors", spot ? "bg-raised text-text" : "text-muted-text hover:bg-raised/60 hover:text-text")}
        data-testid={`coach-player-${p.rosterId}`}>
        <span className="h-3 w-3 shrink-0 rounded-full border border-line" style={spot ? { background: spot.color, borderColor: spot.color } : undefined} />
        <span className="min-w-0 flex-1 truncate font-semibold" dir="auto">{label(p.rosterId)}</span>
        <span className={cn("shrink-0 text-[11px]", visible ? "text-turf" : "text-muted-text/60")}>{visible ? copy.minutes(p.minutes) : copy.notOnCamera}</span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-void text-text" dir={copy.locale === "ar" ? "rtl" : "ltr"} data-testid="coach-player">
      <header className="flex min-h-14 items-center gap-3 border-b border-line px-3 sm:px-4">
        <button type="button" onClick={props.onClose} className="grid h-10 w-10 place-items-center rounded-xl text-muted-text hover:bg-raised hover:text-text" aria-label={copy.close} data-testid="coach-close">
          <X className="h-5 w-5" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-base font-bold" dir="auto">{props.title}</p>
          {props.subtitle && <p className="truncate text-xs text-muted-text" dir="auto">{props.subtitle}</p>}
        </div>
        {!readOnly && (
          <>
            <button type="button" onClick={() => setPanel(panel === "players" ? null : "players")} className={cn("hidden h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold sm:inline-flex", panel === "players" ? "bg-raised text-text" : "text-muted-text hover:text-text")} data-testid="coach-tab-players">
              <Users className="h-4 w-4" aria-hidden />{copy.players}
            </button>
            <button type="button" onClick={() => setPanel(panel === "notes" ? null : "notes")} className={cn("hidden h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold sm:inline-flex", panel === "notes" ? "bg-raised text-text" : "text-muted-text hover:text-text")} data-testid="coach-tab-notes">
              <StickyNote className="h-4 w-4" aria-hidden />{copy.notes}{props.notes?.length ? <span className="rounded-full bg-raised px-1.5 text-[11px]">{props.notes.length}</span> : null}
            </button>
            <button type="button" onClick={() => { videoRef.current?.pause(); setSaveOpen(activeNote && props.canEdit?.(activeNote) ? { id: activeNote.id } : {}); }}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-floodlight px-3 text-sm font-bold text-void" data-testid="coach-save">
              <Save className="h-4 w-4" aria-hidden /><span className="hidden sm:inline">{activeNote && props.canEdit?.(activeNote) ? copy.update : copy.save}</span>
            </button>
          </>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {!readOnly && (
          <aside className="hidden w-14 shrink-0 flex-col items-center gap-1 border-e border-line py-2 md:flex" aria-label="tools">
            <ToolButtons tool={tool} setTool={setTool} copy={copy} vertical />
          </aside>
        )}

        <div className="relative min-w-0 flex-1 overflow-hidden bg-black" ref={stageRef} data-testid="coach-stage">
          <video ref={videoRef} playsInline muted={false} className="pointer-events-none absolute max-w-none bg-black object-fill" data-testid="coach-video" />
          <canvas ref={canvasRef} className={cn("absolute inset-0 h-full w-full touch-none", readOnly ? "cursor-pointer" : tool === "spotlight" ? "cursor-crosshair" : "cursor-cell")}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel}
            data-testid="coach-canvas" />
          {textAt && (
            <form className="absolute z-10 flex gap-1 rounded-xl border border-line bg-surface p-1.5 shadow-xl" style={{ left: Math.max(8, textAt.x - 120), top: Math.max(8, textAt.y - 24) }}
              onSubmit={(e) => {
                e.preventDefault();
                const value = String(new FormData(e.currentTarget).get("text") ?? "").trim().slice(0, 120);
                if (value) addShape({ id: newId(), kind: "text", color, atMs: Math.round((videoRef.current?.currentTime ?? 0) * 1000), at: textAt.p, text: value, size: 20 });
                setTextAt(null);
              }}>
              <input name="text" autoFocus aria-label={copy.textPrompt} placeholder={copy.textPrompt} className="w-48 rounded-lg bg-raised px-2 text-sm text-text outline-none" dir="auto" />
              <button type="submit" className="rounded-lg bg-floodlight px-2.5 text-sm font-bold text-void">{copy.addText}</button>
            </form>
          )}
          {videoError && <p className="absolute inset-x-0 top-1/2 mx-auto w-fit -translate-y-1/2 rounded-xl bg-surface px-4 py-3 text-sm text-text" role="alert">{copy.videoError}</p>}
          {!readOnly && !props.analysed && <p className="absolute inset-x-3 top-3 mx-auto w-fit rounded-xl bg-surface/90 px-3 py-2 text-xs text-muted-text">{copy.notAnalysed}</p>}
          {activeNote && (activeNote.title || activeNote.body) && (
            <div className="absolute start-3 top-3 max-w-sm rounded-2xl border border-line bg-void/85 p-3 backdrop-blur" data-testid="coach-note-card">
              {activeNote.title && <p className="font-display text-base font-bold" dir="auto">{activeNote.title}</p>}
              {activeNote.body && <p className="mt-1 whitespace-pre-line text-sm text-muted-text" dir="auto">{activeNote.body}</p>}
              {readOnly && paused && activeNote.endMs !== null && time * 1000 >= activeNote.endMs - 100 && (
                <button type="button" onClick={() => openNote(activeNote)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-floodlight px-3 py-1.5 text-sm font-bold text-void">
                  <RotateCcw className="h-4 w-4" aria-hidden />{copy.family.replay}
                </button>
              )}
            </div>
          )}
          {/* Zoom and overlays */}
          <div className="absolute bottom-3 end-3 flex flex-col gap-1.5">
            <IconButton label={copy.zoomIn} onClick={() => zoomBy(1.4)}><Plus className="h-4 w-4" /></IconButton>
            <IconButton label={copy.zoomOut} onClick={() => zoomBy(1 / 1.4)}><Minus className="h-4 w-4" /></IconButton>
            <IconButton label={copy.resetView} onClick={() => { setFollow(false); setView(WHOLE); }}><Maximize className="h-4 w-4" /></IconButton>
          </div>
        </div>

        {!readOnly && panel && (
          <aside className="absolute inset-y-14 end-0 z-20 w-[min(88vw,20rem)] overflow-y-auto border-s border-line bg-surface p-3 sm:static sm:inset-auto sm:w-80" data-testid={`coach-panel-${panel}`}>
            {panel === "players" ? (
              <div className="space-y-3">
                {!props.analysed && <p className="text-xs text-muted-text">{copy.notAnalysed}</p>}
                {ours.length > 0 && <section><h3 className="mb-1 px-2 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.ours}</h3>{ours.map(playerRow)}</section>}
                {others.length > 0 && <section><h3 className="mb-1 px-2 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.others}</h3>{others.map(playerRow)}</section>}
              </div>
            ) : (
              <NotesList notes={props.notes ?? []} copy={copy} clockOf={(ms) => clockOf(ms / 1000)} activeId={activeNote?.id ?? null}
                onOpen={openNote} canEdit={props.canEdit} onDelete={props.onDeleteNote} />
            )}
          </aside>
        )}
      </div>

      <footer className="border-t border-line bg-void px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
        {!readOnly && (
          <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-1">
            <div className="flex gap-1 md:hidden"><ToolButtons tool={tool} setTool={setTool} copy={copy} /></div>
            <span className="mx-1 h-6 w-px shrink-0 bg-line md:hidden" />
            {COACH_COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={c} aria-pressed={color === c}
                className={cn("h-7 w-7 shrink-0 rounded-full border-2", color === c ? "border-text" : "border-transparent")} style={{ background: c }} />
            ))}
            <span className="mx-1 h-6 w-px shrink-0 bg-line" />
            {COACH_WIDTHS.map((w) => (
              <button key={w} type="button" onClick={() => setWidth(w)} aria-pressed={width === w} aria-label={`${w}px`}
                className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", width === w ? "bg-raised" : "")}>
                <span className="block rounded-full bg-text" style={{ width: 18, height: w }} />
              </button>
            ))}
            <Chip on={dashed} onClick={() => setDashed((d) => !d)}>{copy.dashed}</Chip>
            <span className="mx-1 h-6 w-px shrink-0 bg-line" />
            <Chip on={Boolean(board.connect)} onClick={() => setBoard({ ...board, connect: !board.connect }, false)} title={copy.connectHint}><Link2 className="h-3.5 w-3.5" />{copy.connect}</Chip>
            <Chip on={Boolean(board.ball)} onClick={() => setBoard({ ...board, ball: !board.ball }, false)}><Goal className="h-3.5 w-3.5" />{copy.ball}</Chip>
            <Chip on={follow} onClick={() => { const next = !follow; setFollow(next); if (next && viewRef.current.zoom < 1.5) zoomBy(2.2); }} title={copy.followHint}><Crosshair className="h-3.5 w-3.5" />{copy.follow}</Chip>
            <span className="mx-1 h-6 w-px shrink-0 bg-line" />
            <Chip onClick={undo}><Undo2 className="h-3.5 w-3.5" />{copy.undo}</Chip>
            <Chip onClick={clearShapes}><Eraser className="h-3.5 w-3.5" />{copy.clear}</Chip>
            <Chip onClick={clearAll}><Trash2 className="h-3.5 w-3.5" />{copy.clearAll}</Chip>
            <button type="button" onClick={() => setPanel(panel === "players" ? null : "players")} className="ms-auto inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-muted-text sm:hidden"><Users className="h-4 w-4" />{copy.players}</button>
            <button type="button" onClick={() => setPanel(panel === "notes" ? null : "notes")} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-muted-text sm:hidden"><StickyNote className="h-4 w-4" />{copy.notes}</button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap" dir="ltr">
          <span className="hidden sm:contents"><IconButton label={copy.back5} onClick={() => seek(time - 5)}><RotateCcw className="h-4 w-4" /></IconButton></span>
          <IconButton label={copy.frameBack} onClick={() => step(-1)}><ChevronLeft className="h-4 w-4" /></IconButton>
          <button type="button" onClick={togglePlay} aria-label={paused ? copy.play : copy.pause} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-floodlight text-void" data-testid="coach-play">
            {paused ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
          </button>
          <IconButton label={copy.frameFwd} onClick={() => step(1)}><ChevronRight className="h-4 w-4" /></IconButton>
          <span className="hidden sm:contents"><IconButton label={copy.fwd5} onClick={() => seek(time + 5)}><RotateCw className="h-4 w-4" /></IconButton></span>
          <span className="w-14 shrink-0 text-center font-mono text-xs tabular-nums text-muted-text">{clockOf(time)}</span>
          <span className="flex-1 sm:hidden" />
          <div className="relative order-first min-w-0 basis-full sm:order-none sm:basis-auto sm:flex-1">
            <input type="range" min={0} max={Math.max(1, total)} step={0.05} value={Math.min(time, total || time)} onChange={(e) => seek(Number(e.target.value))}
              className="w-full accent-floodlight" aria-label="time" data-testid="coach-scrubber" />
            {total > 0 && (props.notes ?? []).map((n) => (
              <button key={n.id} type="button" onClick={() => openNote(n)} title={n.title || clockOf(n.atMs / 1000)}
                className="absolute -top-1.5 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-turf ring-2 ring-void" style={{ left: `${(n.atMs / 1000 / total) * 100}%` }} />
            ))}
          </div>
          <span className="hidden w-14 shrink-0 text-center font-mono text-xs tabular-nums text-muted-text sm:block">{clockOf(total)}</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label={copy.speed} className="h-9 shrink-0 rounded-lg border border-line bg-surface px-1.5 text-xs text-text">
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </div>
        {!readOnly && <p className="mt-1 hidden text-[11px] text-muted-text lg:block">{copy.toolHints[tool]} · {copy.keys}</p>}
      </footer>

      {saveOpen && props.onSaveNote && (
        <SaveDialog
          copy={copy}
          existing={saveOpen.id ? (props.notes ?? []).find((n) => n.id === saveOpen.id) ?? null : null}
          lineup={props.lineup ?? []}
          spotlitPlayerIds={board.spotlights.map((s) => byRoster.get(s.rosterId)?.playerId).filter((id): id is number => typeof id === "number")}
          atMs={noteMoment(board, Math.round(time * 1000))}
          onCancel={() => setSaveOpen(null)}
          onSave={async (fields) => {
            const input: CoachNoteInput = {
              ...fields,
              board: { ...boardRef.current, view: { ...viewRef.current, follow } },
            };
            const note = await props.onSaveNote!(input, saveOpen.id);
            setActiveNote(note);
            setSaveOpen(null);
            setPanel("notes");
          }}
        />
      )}
    </div>
  );
}

function ToolButtons({ tool, setTool, copy, vertical }: { tool: CoachTool; setTool: (t: CoachTool) => void; copy: ReturnType<typeof useCoachCopy>; vertical?: boolean }) {
  return (
    <>
      {TOOLS.map(({ id, icon: Icon }, i) => (
        <button key={id} type="button" onClick={() => setTool(id)} aria-pressed={tool === id} title={`${copy.tools[id]} (${i + 1})`}
          className={cn("grid shrink-0 place-items-center rounded-xl transition-colors", vertical ? "h-11 w-11" : "h-9 w-9", tool === id ? "bg-floodlight text-void" : "text-muted-text hover:bg-raised hover:text-text")}
          data-testid={`coach-tool-${id}`}>
          <Icon className="h-5 w-5" aria-hidden /><span className="sr-only">{copy.tools[id]}</span>
        </button>
      ))}
    </>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line bg-surface/90 text-text hover:bg-raised">
      {children}
    </button>
  );
}

function Chip({ on, onClick, children, title }: { on?: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} title={title}
      className={cn("inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold", on ? "bg-turf text-void" : "text-muted-text hover:bg-raised hover:text-text")}>
      {children}
    </button>
  );
}

function NotesList({ notes, copy, clockOf, activeId, onOpen, canEdit, onDelete }: {
  notes: CoachNote[];
  copy: ReturnType<typeof useCoachCopy>;
  clockOf: (ms: number) => string;
  activeId: number | null;
  onOpen: (n: CoachNote) => void;
  canEdit?: (n: CoachNote) => boolean;
  onDelete?: (id: number) => Promise<void>;
}) {
  if (!notes.length) return <p className="p-2 text-sm text-muted-text">{copy.noNotes}</p>;
  return (
    <ul className="space-y-2">
      {notes.map((n) => (
        <li key={n.id} className={cn("rounded-xl border p-2.5", activeId === n.id ? "border-turf bg-turf/5" : "border-line")}>
          <button type="button" onClick={() => onOpen(n)} className="block w-full text-start" data-testid={`coach-note-${n.id}`}>
            <span className="font-mono text-xs text-turf">{clockOf(n.atMs)}</span>
            <span className="ms-2 font-semibold text-text" dir="auto">{n.title || "—"}</span>
            {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-text" dir="auto">{n.body}</span>}
          </button>
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-text">
            {n.shared ? <span className="inline-flex items-center gap-1 text-turf"><Share2 className="h-3 w-3" />{copy.shared}</span> : <span>{copy.private}</span>}
            {n.author && <span className="truncate">{copy.by(n.author)}</span>}
            {onDelete && canEdit?.(n) && (
              <button type="button" className="ms-auto text-live hover:underline" onClick={() => { if (window.confirm(copy.deleteConfirm)) void onDelete(n.id); }}>{copy.delete}</button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SaveDialog({ copy, existing, lineup, spotlitPlayerIds, atMs, onCancel, onSave }: {
  copy: ReturnType<typeof useCoachCopy>;
  existing: CoachNote | null;
  lineup: Array<{ playerId: number; name: string; shirtNumber: number | null }>;
  spotlitPlayerIds: number[];
  atMs: number;
  onCancel: () => void;
  onSave: (fields: Omit<CoachNoteInput, "board">) => Promise<void>;
}) {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [playFor, setPlayFor] = useState(existing?.endMs ? Math.max(1, Math.round((existing.endMs - existing.atMs) / 1000)) : 8);
  const [players, setPlayers] = useState<number[]>(existing?.playerIds ?? [...new Set(spotlitPlayerIds)]);
  const [shared, setShared] = useState(existing?.shared ?? false);
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const at = existing?.atMs ?? atMs;
  const toggle = (id: number) => setPlayers((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" data-testid="coach-save-dialog">
      <form className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-line bg-surface p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setState("saving");
          try {
            await onSave({ title: title.trim(), body: body.trim() || null, atMs: at, endMs: at + playFor * 1000, playerIds: players, shared: shared && players.length > 0 });
          } catch {
            setState("failed");
          }
        }}>
        <h2 className="font-display text-xl font-bold text-text">{copy.saveTitle}</h2>
        <label className="mt-4 block text-sm font-semibold text-text">{copy.title}
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={copy.titlePlaceholder} dir="auto"
            className="mt-1 w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm font-normal text-text" data-testid="coach-note-title" />
        </label>
        <label className="mt-3 block text-sm font-semibold text-text">{copy.comment}
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={3} placeholder={copy.commentPlaceholder} dir="auto"
            className="mt-1 w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm font-normal text-text" />
        </label>
        <div className="mt-3">
          <p className="text-sm font-semibold text-text">{copy.playFor}</p>
          <div className="mt-1 flex gap-1.5">
            {PLAY_FOR.map((s) => (
              <button key={s} type="button" onClick={() => setPlayFor(s)} aria-pressed={playFor === s}
                className={cn("h-9 rounded-lg px-3 text-sm font-semibold", playFor === s ? "bg-turf text-void" : "bg-raised text-muted-text")}>{copy.seconds(s)}</button>
            ))}
          </div>
        </div>
        {lineup.length > 0 && (
          <div className="mt-3">
            <p className="text-sm font-semibold text-text">{copy.tagPlayers}</p>
            <div className="mt-1 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {lineup.map((p) => (
                <button key={p.playerId} type="button" onClick={() => toggle(p.playerId)} aria-pressed={players.includes(p.playerId)}
                  className={cn("h-8 rounded-full px-3 text-xs font-semibold", players.includes(p.playerId) ? "bg-floodlight text-void" : "bg-raised text-muted-text")} dir="auto">
                  {p.shirtNumber !== null ? `#${p.shirtNumber} ` : ""}{p.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className={cn("mt-4 flex items-start gap-2 text-sm", players.length ? "text-text" : "text-muted-text")}>
          <input type="checkbox" checked={shared && players.length > 0} disabled={!players.length} onChange={(e) => setShared(e.target.checked)} className="mt-0.5 h-4 w-4 accent-floodlight" data-testid="coach-note-share" />
          <span><span className="font-semibold">{copy.share}</span><span className="block text-xs text-muted-text">{players.length ? copy.shareHint : copy.shareNeedsPlayers}</span></span>
        </label>
        {state === "failed" && <p className="mt-3 text-sm text-live" role="alert">{copy.saveFailed}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="h-10 rounded-xl px-4 text-sm font-semibold text-muted-text hover:text-text">{copy.cancel}</button>
          <button type="submit" disabled={state === "saving"} className="h-10 rounded-xl bg-floodlight px-4 text-sm font-bold text-void disabled:opacity-60" data-testid="coach-note-submit">
            {state === "saving" ? copy.saving : existing ? copy.update : copy.save}
          </button>
        </div>
      </form>
    </div>
  );
}
