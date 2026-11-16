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
  Flag,
  Triangle,
  Move,
  SquareDashed,
  Rows3,
  Check,
  Send,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import {
  COACH_COLORS,
  COACH_MAX_OFFSIDE,
  COACH_MAX_SHAPES,
  COACH_MAX_SPOTLIGHTS,
  COACH_MAX_UNITS,
  COACH_MAX_UNIT_PLAYERS,
  COACH_WIDTHS,
  EMPTY_COACH_BOARD,
  coachBoxAt,
  coachFeet,
  pitchMapper,
  type CoachAnalysis,
  type CoachBoard,
  type CoachUnit,
  type CoachNote,
  type CoachNoteInput,
  type CoachShape,
  type CoachTracks,
  type CoachView,
} from "@workspace/api-zod";
import { useCoachCopy } from "@/i18n/coach-strings";
import { useMatchesCopy } from "@/i18n/matches-strings";
import type { CoachPlayer as RosterPlayer, CoachTraining, CoachVideo } from "@/lib/academy-coach-api";
import { TrainingSessionTimeline } from "@/components/academy-console/TrainingSessionTimeline";
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
  findList,
  nextOnCamera,
  nextSpan,
  nextSpotColor,
  noteMoment,
  QUICK_LENGTHS,
  QUICK_PRESETS,
  quickWindow,
  type FindEntry,
  type QuickPreset,
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
import { LINE_COLORS, metresLabel } from "@/lib/coach-analysis";
import { seekVideoElement } from "@/lib/video-seek";
import { cn } from "@/lib/utils";
import { useCoachVideo } from "./use-coach-video";

export type CoachTool = "spotlight" | "offside" | "unit" | "move" | "area" | "pen" | "arrow" | "line" | "circle" | "zone" | "text";
const TOOLS: Array<{ id: CoachTool; icon: typeof Crosshair }> = [
  { id: "spotlight", icon: Crosshair },
  { id: "offside", icon: Flag },
  { id: "unit", icon: Triangle },
  { id: "move", icon: Move },
  { id: "area", icon: SquareDashed },
  { id: "pen", icon: PenLine },
  { id: "arrow", icon: ArrowUpRight },
  { id: "line", icon: Slash },
  { id: "circle", icon: Circle },
  { id: "zone", icon: Shapes },
  { id: "text", icon: Type },
];
/** The tools a coach sees first; the rest sit behind "More tools". */
const SIMPLE_TOOLS: ReadonlySet<CoachTool> = new Set(["spotlight", "arrow", "circle", "text"]);
const MORE_TOOLS_KEY = "coach-more-tools";
const readMoreTools = () => { try { return window.localStorage.getItem(MORE_TOOLS_KEY) === "1"; } catch { return false; } };
/** Tools that pick a tracked player with a tap. */
const PICK_TOOLS: ReadonlySet<CoachTool> = new Set(["spotlight", "offside", "unit"]);
/** Tools that need the camera's pitch model. */
const PITCH_TOOLS: ReadonlySet<CoachTool> = new Set(["offside", "area"]);
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const PLAY_FOR = [4, 8, 12, 20];

export type CoachPlayerProps = {
  title: string;
  subtitle?: string | null;
  video: CoachVideo;
  training?: CoachTraining | null;
  players: RosterPlayer[];
  analysed: boolean;
  loadTracks: (from: number, to: number) => Promise<CoachTracks>;
  /** the pitch model, sides and training flags for the analysis tools */
  loadAnalysis?: () => Promise<CoachAnalysis>;
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
const round1 = (n: number) => Math.round(n * 10) / 10;
/** What a Quick note carries over when the coach asks for the full form. */
type QuickDraft = { title: string; body: string | null; playerIds: number[]; shared: boolean; atMs: number; endMs: number };
type QuickFields = { preset: QuickPreset | null; comment: string; playerId: number | null; lengthS: number };
let idSeq = 0;
const newId = () => `s${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function CoachPlayer(props: CoachPlayerProps) {
  const copy = useCoachCopy();
  const matchesCopy = useMatchesCopy();
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
  const [moreTools, setMoreToolsState] = useState<boolean>(() => (typeof window !== "undefined" ? readMoreTools() : false));
  const setMoreTools = (on: boolean) => {
    setMoreToolsState(on);
    try { window.localStorage.setItem(MORE_TOOLS_KEY, on ? "1" : "0"); } catch { /* private mode */ }
    if (!on && !SIMPLE_TOOLS.has(tool)) { if (pendingRef.current) finishUnit(); setTool("spotlight"); }
  };
  const toolList = useMemo(() => TOOLS.filter((t) => moreTools || SIMPLE_TOOLS.has(t.id)), [moreTools]);
  /** Quick note: the child a tap picked, waiting for Well done / Watch this / Work on it. */
  /** `left`: on a wide screen the sheet sits on the side of the video away from him */
  const [quick, setQuick] = useState<{ rosterId: string; left: boolean } | null>(null);
  /** the Quick note clip the coach picked, shown as a band on the timeline */
  const [quickLen, setQuickLen] = useState(10);
  const [findText, setFindText] = useState("");
  const [color, setColorState] = useState<string>(COACH_COLORS[0]);
  const setColor = (c: string) => { colorRef.current = c; setColorState(c); };
  const [width, setWidth] = useState<number>(COACH_WIDTHS[1]);
  const [dashed, setDashed] = useState(false);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(startAt);
  const [duration, setDuration] = useState(v.duration ?? 0);
  const [selectedGameIndex, setSelectedGameIndex] = useState<number | null>(null);
  const selectedGame = selectedGameIndex === null ? null : props.training?.games[selectedGameIndex] ?? null;
  const rangeStart = selectedGame?.start ?? 0;
  const fullDuration = duration || v.duration || 0;
  const rangeEnd = selectedGame
    ? Math.max(rangeStart, fullDuration > 0 ? Math.min(selectedGame.end, fullDuration) : selectedGame.end)
    : fullDuration;
  const [speed, setSpeed] = useState(1);
  // The side panel starts open where there is room for it beside the video.
  const [panel, setPanel] = useState<"players" | "notes" | null>(() => (readOnly || (typeof window !== "undefined" && window.innerWidth < 1024) ? null : "players"));
  const [saveOpen, setSaveOpen] = useState<{ id?: number; initial?: QuickDraft } | null>(null);
  const [textAt, setTextAt] = useState<{ p: Pt; x: number; y: number } | null>(null);
  const [activeNote, setActiveNote] = useState<CoachNote | null>(props.initialNote ?? null);
  const activeNoteRef = useRef(activeNote);
  activeNoteRef.current = activeNote;
  const draft = useRef<CoachShape | null>(null);
  const store = useRef<TrackStore>(emptyTrackStore());
  const [, setTracksVersion] = useState(0);
  const loading = useRef(false);

  // ── Analysis: the camera's pitch model, sides and training flags ──────────
  const [analysis, setAnalysis] = useState<CoachAnalysis | null>(null);
  useEffect(() => {
    if (!props.analysed || !props.loadAnalysis) return;
    let stopped = false;
    props.loadAnalysis().then((a) => { if (!stopped) setAnalysis(a); }).catch(() => undefined);
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.analysed, props.loadAnalysis]);
  const map = useMemo(() => (analysis?.pitch ? pitchMapper(analysis.pitch) : null), [analysis]);
  const analysisRef = useRef(analysis);
  analysisRef.current = analysis;
  const mapRef = useRef(map);
  mapRef.current = map;
  /** Adults are hidden unless shown; a training group filter hides the other groups. */
  const visible = useCallback((rosterId: string) => {
    const p = analysis?.players[rosterId];
    if (!p) return true;
    if (analysis?.isTraining && p.adult && !board.showAdults) return false;
    if (analysis?.isTraining && board.group && p.group !== board.group) return false;
    return true;
  }, [analysis, board.showAdults, board.group]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [pending, setPendingState] = useState<{ ids: string[]; kind: CoachUnit["kind"] } | null>(null);
  const pendingRef = useRef(pending);
  const setPending = useCallback((next: { ids: string[]; kind: CoachUnit["kind"] } | null) => { pendingRef.current = next; setPendingState(next); }, []);
  const colorRef = useRef(COACH_COLORS[0] as string);
  const [hud, setHud] = useState<{ formation: string; width: number; depth: number; lines: number } | null>(null);
  const [linesOpen, setLinesOpen] = useState(false);

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
  const drawCopy = useMemo(() => ({ offside: copy.analysis.offside, width: copy.analysis.width, depth: copy.analysis.depth, keeper: copy.analysis.keeper, lines: copy.analysis.lines, unit: copy.analysis.unit }), [copy]);
  const drawCopyRef = useRef(drawCopy);
  drawCopyRef.current = drawCopy;

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
      const pend = pendingRef.current;
      const drawn = drawBoard(ctx, {
        rect, dpr, t, paused: video.paused, board: boardRef.current, draft: draft.current, store: store.current, label: labelRef.current,
        map: mapRef.current, analysis: analysisRef.current, visible: visibleRef.current, copy: drawCopyRef.current,
        pending: pend ? { ids: pend.ids, kind: pend.kind, color: colorRef.current } : null,
      });
      if (now - lastUi > 200) {
        lastUi = now;
        const sh = drawn.shape;
        setHud((prev) => {
          if (!sh) return prev ? null : prev;
          const next = { formation: sh.formation, width: Math.round(sh.width * 10) / 10, depth: Math.round(sh.depth * 10) / 10, lines: sh.lines.length };
          return prev && prev.formation === next.formation && prev.width === next.width && prev.depth === next.depth ? prev : next;
        });
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
    const videoEnd = Number.isFinite(video.duration) && video.duration > 0 ? video.duration - 0.1 : Infinity;
    const end = Math.min(videoEnd, selectedGame?.end ?? videoEnd);
    const target = Math.max(rangeStart, Math.min(end, t));
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      seekVideoElement(video, target);
      setTime(target);
      return;
    }
    video.currentTime = target;
    setTime(video.currentTime);
  }, [rangeStart, selectedGame?.end]);
  useEffect(() => {
    if (!selectedGame) return;
    const video = videoRef.current;
    if (!video) return;
    const stopAtGameEnd = () => {
      if (video.currentTime < selectedGame.end) return;
      video.pause();
      video.currentTime = Math.max(selectedGame.start, selectedGame.end - 0.05);
      setTime(video.currentTime);
    };
    video.addEventListener("timeupdate", stopAtGameEnd);
    return () => video.removeEventListener("timeupdate", stopAtGameEnd);
  }, [selectedGame?.start, selectedGame?.end]);
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
  /** Spotlight him if he isn't yet, letting the oldest spotlight go when the board is full. */
  const ensureSpot = useCallback((rosterId: string) => {
    const b = boardRef.current;
    if (b.spotlights.some((s) => s.rosterId === rosterId)) return;
    const kept = b.spotlights.slice(-(COACH_MAX_SPOTLIGHTS - 1));
    setBoard({ ...b, spotlights: [...kept, { rosterId, color: nextSpotColor(kept.map((s) => s.color), COACH_COLORS) }] });
  }, [setBoard]);
  /** Simple mode with notes on: a tap on a child opens the Quick note for him. */
  const quickOn = !moreTools && Boolean(props.onSaveNote);
  const pickPlayer = useCallback((rosterId: string) => {
    if (!quickOn) { toggleSpot(rosterId); return; }
    const lit = boardRef.current.spotlights.some((s) => s.rosterId === rosterId);
    if (lit && quick?.rosterId === rosterId) { toggleSpot(rosterId); setQuick(null); return; }
    ensureSpot(rosterId);
    videoRef.current?.pause();
    const stage = stageRef.current;
    const boxes = store.current.players.get(rosterId);
    const box = boxes ? coachBoxAt(boxes, videoRef.current?.currentTime ?? 0) : null;
    let left = false;
    if (stage && box) {
      const [x] = toScreen(frameRect(stage.clientWidth, stage.clientHeight, aspect, viewRef.current), [box[0] + box[2] / 2, box[1]]);
      left = x > stage.clientWidth / 2;
    }
    setQuick({ rosterId, left });
  }, [quickOn, quick, toggleSpot, ensureSpot, aspect]);
  const toggleOffside = useCallback((rosterId: string) => {
    const b = boardRef.current;
    const list = b.offside ?? [];
    if (list.some((o) => o.rosterId === rosterId)) { setBoard({ ...b, offside: list.filter((o) => o.rosterId !== rosterId) }); return; }
    const kept = list.length >= COACH_MAX_OFFSIDE ? list.slice(1) : list;
    setBoard({ ...b, offside: [...kept, { rosterId, color: colorRef.current }] });
  }, [setBoard]);
  const pickForUnit = useCallback((rosterId: string) => {
    const cur = pendingRef.current ?? { ids: [], kind: "shape" as const };
    if (cur.ids.includes(rosterId)) { setPending({ ...cur, ids: cur.ids.filter((id) => id !== rosterId) }); return; }
    if (cur.ids.length >= COACH_MAX_UNIT_PLAYERS) return;
    setPending({ ...cur, ids: [...cur.ids, rosterId] });
  }, [setPending]);
  const finishUnit = useCallback(() => {
    const cur = pendingRef.current;
    setPending(null);
    if (!cur || cur.ids.length < 2) return;
    const b = boardRef.current;
    setBoard({ ...b, units: [...(b.units ?? []), { id: newId(), kind: cur.kind, rosterIds: cur.ids, color: colorRef.current }].slice(-COACH_MAX_UNITS) });
  }, [setBoard, setPending]);
  const chooseTool = useCallback((next: CoachTool) => {
    if (PITCH_TOOLS.has(next) && !mapRef.current) return;
    if (next !== "unit" && pendingRef.current) finishUnit();
    setTool(next);
  }, [finishUnit]);
  const toolDisabled = useCallback((id: CoachTool) => PITCH_TOOLS.has(id) && !map, [map]);
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
    const b = boardRef.current;
    // The training filters are a view, not a drawing: they stay.
    setBoard({ ...EMPTY_COACH_BOARD, ...(b.group ? { group: b.group } : {}), ...(b.showAdults ? { showAdults: true } : {}) });
    setPending(null);
    setActiveNote(null);
  }, [setBoard, setPending]);

  // ── Pointer: spotlight taps, pan and pinch, drawing ───────────────────────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: "tap" | "pan" | "pinch" | "draw"; x0: number; y0: number; moved: boolean; dist?: number; points?: Pt[] } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const visibleBoxes = (t: number) => new Map([...boxesAt(store.current, t)].filter(([id]) => visible(id)));
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
    if (readOnly || PICK_TOOLS.has(tool) || tool === "text") { gesture.current = { kind: "tap", x0: p.x, y0: p.y, moved: false }; return; }
    const share = toShare(currentRect(), p.x, p.y);
    const atMs = Math.round((videoRef.current?.currentTime ?? 0) * 1000);
    if (tool === "move") {
      // Freeze-frame: grab a tracked player and drag him to where he should have been.
      const t = videoRef.current?.currentTime ?? 0;
      const hit = hitPlayer(visibleBoxes(t), share);
      const b = hit ? store.current.players.get(hit) : null;
      const box = b ? coachBoxAt(b, t) : null;
      if (!hit || !box) { gesture.current = { kind: "tap", x0: p.x, y0: p.y, moved: false }; return; }
      videoRef.current?.pause();
      const feet = coachFeet(box);
      gesture.current = { kind: "draw", x0: p.x, y0: p.y, moved: false, points: [[p.x, p.y]] };
      draft.current = { id: newId(), kind: "move", color, atMs, rosterId: hit, from: feet, to: feet, size: [box[2], box[3]] };
      return;
    }
    if (tool === "area") {
      if (!map) { gesture.current = { kind: "tap", x0: p.x, y0: p.y, moved: false }; return; }
      videoRef.current?.pause();
      const at = map.toPitch(share[0], share[1]);
      gesture.current = { kind: "draw", x0: p.x, y0: p.y, moved: false, points: [[p.x, p.y]] };
      draft.current = { id: newId(), kind: "area", color, atMs, a: at, b: at, pinned: true };
      return;
    }
    videoRef.current?.pause();
    gesture.current = { kind: "draw", x0: p.x, y0: p.y, moved: false, points: [[p.x, p.y]] };
    const base = { id: newId(), color, atMs };
    draft.current = tool === "pen" ? { ...base, kind: "pen", width, points: [share, share] }
      : tool === "zone" ? { ...base, kind: "zone", points: [share, share, share] }
      : tool === "circle" ? { ...base, kind: "circle", width, from: share, to: share }
      : { ...base, kind: tool === "line" ? "line" : "arrow", width, from: share, to: share, dashed };
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
      } else if (d.kind === "arrow" || d.kind === "line" || d.kind === "circle" || d.kind === "move") {
        draft.current = { ...d, to: share };
      } else if (d.kind === "area" && map) {
        draft.current = { ...d, b: map.toPitch(share[0], share[1]) };
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
      const hit = hitPlayer(visibleBoxes(t), share);
      if (!hit) return;
      if (tool === "offside") { if (map) toggleOffside(hit); return; }
      if (tool === "unit") { pickForUnit(hit); return; }
      if (tool === "spotlight") pickPlayer(hit);
      return;
    }
    if (g.kind === "draw" && draft.current) {
      const d = draft.current;
      draft.current = null;
      const rect = currentRect();
      const big = (a: Pt, b: Pt) => { const [ax, ay] = toScreen(rect, a); const [bx, by] = toScreen(rect, b); return Math.hypot(ax - bx, ay - by) > 8; };
      const bigArea = d.kind === "area" && Math.abs(d.a[0] - d.b[0]) >= 1 && Math.abs(d.a[1] - d.b[1]) >= 1;
      if ((d.kind === "pen" && d.points.length >= 2) || (d.kind === "zone" && d.points.length >= 3)
        || ((d.kind === "arrow" || d.kind === "line" || d.kind === "circle" || d.kind === "move") && big(d.from, d.to)) || bigArea) {
        addShape(d.kind === "area" ? { ...d, a: [round1(d.a[0]), round1(d.a[1])], b: [round1(d.b[0]), round1(d.b[1])] } : d);
      }
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
      if (e.key === "Escape") { if (saveOpen) setSaveOpen(null); else if (quick) setQuick(null); else if (textAt) setTextAt(null); else props.onClose(); return; }
      if (e.key === " ") { e.preventDefault(); togglePlay(); return; }
      if (e.key === "ArrowLeft") { seek((videoRef.current?.currentTime ?? 0) - 5); return; }
      if (e.key === "ArrowRight") { seek((videoRef.current?.currentTime ?? 0) + 5); return; }
      if (e.key === ",") { step(-1); return; }
      if (e.key === ".") { step(1); return; }
      if (readOnly) return;
      if ((e.key === "z" || e.key === "Z") && !e.shiftKey) { undo(); return; }
      if (e.key === "f" || e.key === "F") { setFollow((f) => !f); return; }
      if (e.key === "Enter" && pendingRef.current) { finishUnit(); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= Math.min(9, toolList.length)) chooseTool(toolList[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props, readOnly, saveOpen, quick, seek, step, textAt, togglePlay, undo, finishUnit, map, toolList]);

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
  const total = rangeEnd;
  const spotRosterIds = new Set(board.spotlights.map((s) => s.rosterId));
  const tracked = props.analysed ? boxesAt(store.current, time) : new Map();
  // Find a player: only children tied to the lineup and kept shirt numbers tracked for a while,
  // one entry per child; anyone else is tapped on the video. On camera now first.
  const entries = useMemo(() => findList(props.players, (id) => analysis?.players[id]), [props.players, analysis]);
  const entryLabel = (e: FindEntry) => (e.name ? `${e.number ? `#${e.number} ` : ""}${e.name}` : `#${e.number}`);
  const needle = findText.trim().toLowerCase().replace(/^#/, "");
  const matchesFind = (e: FindEntry) => !needle || (e.name ?? "").toLowerCase().includes(needle) || (e.number ?? "").toLowerCase() === needle;
  const shown = entries.filter((e) => e.rosterIds.some((id) => visible(id)) && matchesFind(e))
    .map((e, i) => ({ e, i, on: e.rosterIds.some((id) => tracked.has(id)) }))
    .sort((a, b) => Number(b.on) - Number(a.on) || a.i - b.i)
    .map((x) => x.e);
  const ours = shown.filter((e) => e.playerId !== null);
  const others = shown.filter((e) => e.playerId === null);
  const trainingSections = analysis?.isTraining
    ? [
        ...analysis.groupDetails.map((group) => ({
          id: group.id,
          title: group.name,
          color: group.color,
          players: shown.filter((e) => e.team === group.id),
        })),
        {
          id: "__unassigned",
          title: copy.analysis.ungrouped,
          color: null,
          players: shown.filter((e) => !e.team || !analysis.groupDetails.some((g) => g.id === e.team)),
        },
      ].filter((section) => section.players.length > 0)
    : [];
  const hiddenAdults = analysis?.isTraining && analysis.hasAdults && !board.showAdults
    ? props.players.filter((p) => analysis.players[p.rosterId]?.adult).length
    : 0;
  const groupLabel = (id: string) => analysis?.groupDetails.find((group) => group.id === id)?.name ?? copy.analysis.group(id);

  const quickName = (rosterId: string, playerId: number | null) => {
    const bound = byRoster.get(rosterId);
    if (bound?.playerId !== null && bound?.playerId !== undefined && bound.playerId === playerId && bound.name) return bound.name;
    return props.lineup?.find((l) => l.playerId === playerId)?.name ?? label(rosterId);
  };
  /** The clip: the seconds up to the moment (now, or the drawing's moment) plus a short run-on, inside the game picked. */
  const quickClip = (lengthS: number) => quickWindow(noteMoment(boardRef.current, Math.round((videoRef.current?.currentTime ?? time) * 1000)), lengthS, rangeStart * 1000);
  const quickDraft = (rosterId: string, f: QuickFields): QuickDraft => {
    const name = quickName(rosterId, f.playerId);
    return {
      ...quickClip(f.lengthS),
      title: (f.preset ? `${copy.quick.presets[f.preset]} ${copy.quick.emoji[f.preset]} · ${name}` : name).slice(0, 120),
      body: f.comment.trim() || null,
      playerIds: f.playerId !== null ? [f.playerId] : [],
      shared: f.playerId !== null,
    };
  };
  /** Save a Quick note: this child's spotlight only, over the clip the coach picked. */
  const sendQuick = async (rosterId: string, f: QuickFields & { share: boolean }) => {
    const d = quickDraft(rosterId, f);
    const b = boardRef.current;
    await props.onSaveNote!({
      ...d,
      shared: d.shared && f.share,
      board: { ...b, spotlights: b.spotlights.filter((s) => s.rosterId === rosterId), view: { ...viewRef.current, follow } },
    });
  };
  /** A row in the list: on camera, pick him; off camera, jump to where he next appears and pick that track. */
  const findEntry = (e: FindEntry) => {
    const onId = e.rosterIds.find((id) => tracked.has(id));
    const phone = window.innerWidth < 640;
    if (onId) { if (phone && quickOn) setPanel(null); pickPlayer(onId); return; }
    const next = nextSpan(e.spans, time);
    if (!next) return;
    videoRef.current?.pause();
    seek(Math.min(next[1], next[0] + 0.2));
    if (phone) setPanel(null);
    if (quickOn) pickPlayer(next[2]); else ensureSpot(next[2]);
  };
  const playerRow = (e: FindEntry) => {
    const spot = board.spotlights.find((s) => e.rosterIds.includes(s.rosterId));
    const on = e.rosterIds.some((id) => tracked.has(id));
    const next = on ? null : nextOnCamera(e.spans, time);
    const kit = analysis?.players[e.rosterIds[0]]?.kit;
    return (
      <button key={e.key} type="button" onClick={() => findEntry(e)} disabled={!props.analysed}
        className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm transition-colors", spot ? "bg-raised text-text" : "text-muted-text hover:bg-raised/60 hover:text-text")}
        data-testid={`coach-player-${e.rosterIds[0]}`}>
        <span className="h-3 w-3 shrink-0 rounded-full border border-line" style={spot ? { background: spot.color, borderColor: spot.color } : undefined} />
        {kit && <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: kit }} />}
        <span className="min-w-0 flex-1 truncate font-semibold" dir="auto">{entryLabel(e)}</span>
        <span className={cn("shrink-0 text-[11px]", on ? "text-turf" : next !== null ? "text-floodlight" : "text-muted-text/60")}>
          {on ? copy.minutes(e.minutes) : next !== null ? copy.quick.jump(clockOf(next)) : copy.notOnCamera}
        </span>
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
          <aside className={cn("hidden shrink-0 flex-col items-center gap-1 overflow-y-auto border-e border-line py-2 md:flex", moreTools ? "w-14" : "w-20")} aria-label="tools" data-testid="coach-rail">
            <ToolButtons tools={toolList} tool={tool} setTool={chooseTool} disabled={toolDisabled} copy={copy} vertical labelled={!moreTools} />
            <span className="my-1 h-px w-8 shrink-0 bg-line" />
            <button type="button" onClick={() => setMoreTools(!moreTools)} aria-pressed={moreTools} title={moreTools ? copy.quick.simpleTools : copy.quick.moreToolsHint}
              className={cn("flex shrink-0 flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-[10px] font-semibold leading-tight text-muted-text hover:bg-raised hover:text-text", moreTools ? "w-11" : "w-[4.25rem]")}
              data-testid="coach-more-tools">
              <SlidersHorizontal className="h-5 w-5" aria-hidden />
              <span className="text-center">{moreTools ? copy.quick.simpleTools : copy.quick.moreTools}</span>
            </button>
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
          {pending && !readOnly && (
            <div className="absolute inset-x-0 bottom-3 z-10 mx-auto flex w-fit max-w-[92%] flex-wrap items-center gap-1.5 rounded-2xl border border-line bg-void/90 p-1.5 text-xs backdrop-blur" data-testid="coach-unit-bar">
              <span className="px-2 font-semibold text-text">{copy.analysis.picked(pending.ids.length)}</span>
              <Chip on={pending.kind === "shape"} onClick={() => setPending({ ...pending, kind: "shape" })}><Triangle className="h-3.5 w-3.5" />{copy.analysis.shape}</Chip>
              <Chip on={pending.kind === "lanes"} onClick={() => setPending({ ...pending, kind: "lanes" })}><Share2 className="h-3.5 w-3.5" />{copy.analysis.lanes}</Chip>
              <button type="button" onClick={finishUnit} disabled={pending.ids.length < 2} className="inline-flex h-8 items-center gap-1 rounded-lg bg-floodlight px-3 font-bold text-void disabled:opacity-40" data-testid="coach-unit-done"><Check className="h-3.5 w-3.5" />{copy.analysis.done}</button>
              <button type="button" onClick={() => setPending(null)} className="h-8 rounded-lg px-2 font-semibold text-muted-text hover:text-text">{copy.cancel}</button>
            </div>
          )}
          {hud && board.teamLines && (
            <div className="pointer-events-none absolute end-3 top-3 z-10 rounded-2xl border border-line bg-void/85 px-3 py-2 text-xs backdrop-blur" data-testid="coach-team-hud">
              <p className="font-display text-lg font-bold leading-none text-text" dir="ltr">{hud.formation}</p>
              <p className="mt-1 text-muted-text">{copy.analysis.width} <span className="font-semibold text-text">{metresLabel(hud.width, copy.analysis.unit)}</span> · {copy.analysis.depth} <span className="font-semibold text-text">{metresLabel(hud.depth, copy.analysis.unit)}</span></p>
            </div>
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
      {quick && props.onSaveNote && !saveOpen && (
        <QuickNoteSheet
          key={quick.rosterId}
          left={quick.left}
          copy={copy}
          name={label(quick.rosterId)}
          boundPlayerId={byRoster.get(quick.rosterId)?.playerId ?? null}
          lineup={props.lineup ?? []}
          sentName={(playerId) => quickName(quick.rosterId, playerId)}
          lengthS={quickLen}
          onLength={setQuickLen}
          clipLabel={(() => { const w = quickClip(quickLen); return `${clockOf(w.atMs / 1000)}–${clockOf(w.endMs / 1000)}`; })()}
          onClose={() => setQuick(null)}
          onSend={(f) => sendQuick(quick.rosterId, f)}
          onMore={(f) => { setSaveOpen({ initial: quickDraft(quick.rosterId, f) }); setQuick(null); }}
        />
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
                {entries.length > 8 && (
                  <label className="flex items-center gap-2 rounded-xl border border-line bg-raised px-2.5">
                    <Search className="h-4 w-4 shrink-0 text-muted-text" aria-hidden />
                    <input value={findText} onChange={(e) => setFindText(e.target.value)} placeholder={copy.quick.find} aria-label={copy.quick.find} dir="auto"
                      className="h-9 min-w-0 flex-1 bg-transparent text-sm text-text outline-none" data-testid="coach-find" />
                    {findText && <button type="button" onClick={() => setFindText("")} aria-label={copy.cancel} className="text-muted-text hover:text-text"><X className="h-4 w-4" /></button>}
                  </label>
                )}
                {analysis?.isTraining && (analysis.groups.length > 0 || analysis.hasAdults) && (
                  <section className="space-y-1.5 border-b border-line pb-3" data-testid="coach-training-filters">
                    {analysis.groups.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        <Chip on={!board.group} onClick={() => setBoard({ ...board, group: undefined }, false)}>{copy.analysis.allGroups}</Chip>
                        {analysis.groups.map((g) => {
                          const detail = analysis.groupDetails.find((group) => group.id === g);
                          return (
                            <Chip key={g} on={board.group === g} onClick={() => setBoard({ ...board, group: board.group === g ? undefined : g }, false)}>
                              {detail?.color && <span className="h-2.5 w-2.5 rounded-sm border border-line" style={{ background: detail.color }} />}
                              {groupLabel(g)}
                            </Chip>
                          );
                        })}
                      </div>
                    )}
                    {analysis.hasAdults && (
                      <Chip on={Boolean(board.showAdults)} onClick={() => setBoard({ ...board, showAdults: board.showAdults ? undefined : true }, false)}>
                        {board.showAdults ? copy.analysis.adultsShown : copy.analysis.adultsHidden(hiddenAdults)}
                      </Chip>
                    )}
                  </section>
                )}
                {analysis && !map && <p className="px-2 text-xs text-muted-text">{copy.analysis.needsPitch}</p>}
                {props.analysed && <p className="px-2 text-[11px] text-muted-text" data-testid="coach-find-hint">{shown.length ? copy.quick.findHint : copy.quick.findEmpty}</p>}
                {analysis?.isTraining ? (
                  trainingSections.map((section) => (
                    <section key={section.id} data-testid={`coach-group-${section.id}`}>
                      <h3 className="mb-1 flex items-center gap-1.5 px-2 text-xs font-bold uppercase tracking-wide text-muted-text">
                        {section.color && <span className="h-2.5 w-2.5 rounded-sm border border-line" style={{ background: section.color }} />}
                        {section.title}
                      </h3>
                      {section.players.map(playerRow)}
                    </section>
                  ))
                ) : (
                  <>
                    {ours.length > 0 && <section><h3 className="mb-1 px-2 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.ours}</h3>{ours.map(playerRow)}</section>}
                    {others.length > 0 && <section><h3 className="mb-1 px-2 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.others}</h3>{others.map(playerRow)}</section>}
                  </>
                )}
              </div>
            ) : (
              <NotesList notes={props.notes ?? []} copy={copy} clockOf={(ms) => clockOf(ms / 1000)} activeId={activeNote?.id ?? null}
                onOpen={openNote} canEdit={props.canEdit} onDelete={props.onDeleteNote} />
            )}
          </aside>
        )}
      </div>

      {linesOpen && analysis && !board.teamLines && (
        <div className="fixed inset-x-0 bottom-28 z-[90] mx-auto w-[min(92vw,22rem)] rounded-2xl border border-line bg-surface p-3 shadow-2xl" data-testid="coach-lines-picker">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.analysis.whichSide}</p>
          <div className="flex flex-wrap gap-1.5">
            {analysis.kits && ([0, 1] as const).map((side) => (
              <button key={side} type="button" onClick={() => { setBoard({ ...board, teamLines: { side } }); setLinesOpen(false); }}
                className="inline-flex h-9 items-center gap-2 rounded-xl bg-raised px-3 text-sm font-semibold text-text hover:bg-raised/70" data-testid={`coach-lines-side-${side}`}>
                <span className="h-4 w-4 rounded-full border border-line" style={{ background: analysis.kits![side] }} />
                {analysis.oursKnown ? (side === 0 ? copy.analysis.ours : copy.analysis.theirs) : copy.analysis.kit(side + 1)}
              </button>
            ))}
            {analysis.isTraining && analysis.groups.map((g) => (
              <button key={g} type="button" onClick={() => { setBoard({ ...board, teamLines: { group: g } }); setLinesOpen(false); }}
                className="inline-flex h-9 items-center gap-2 rounded-xl bg-raised px-3 text-sm font-semibold text-text hover:bg-raised/70" dir="auto">
                {analysis.groupDetails.find((group) => group.id === g)?.color && (
                  <span className="h-3 w-3 rounded-sm border border-line" style={{ background: analysis.groupDetails.find((group) => group.id === g)!.color! }} />
                )}
                {groupLabel(g)}
              </button>
            ))}
            {!analysis.kits && !analysis.groups.length && <p className="text-sm text-muted-text">{copy.analysis.noSides}</p>}
          </div>
          <div className="mt-2 flex gap-3 text-[11px] text-muted-text">
            {(["back", "mid", "front"] as const).map((k) => <span key={k} className="inline-flex items-center gap-1"><span className="h-2 w-4 rounded-full" style={{ background: LINE_COLORS[k] }} />{copy.analysis.lines[k]}</span>)}
          </div>
        </div>
      )}

      <footer className="border-t border-line bg-void px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
        {props.training && (props.training.segments.length > 0 || props.training.games.length > 0) && (
          <div className="mb-3 space-y-2" data-testid="coach-training-timeline">
            {props.training.games.length > 0 && (
              <label className="block max-w-xl text-xs font-semibold text-muted-text">
                <span className="mb-1 block">{copy.trainingGames.select}</span>
                <select
                  value={selectedGameIndex ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) {
                      setSelectedGameIndex(null);
                      const start = v.matchWindow?.from ?? 0;
                      seekVideoElement(videoRef.current, start);
                      setTime(start);
                      return;
                    }
                    const index = Number(value);
                    const game = props.training?.games[index];
                    if (!Number.isInteger(index) || !game) return;
                    setSelectedGameIndex(index);
                    seekVideoElement(videoRef.current, game.start);
                    setTime(game.start);
                  }}
                  className="min-h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm font-semibold text-text"
                  data-testid="coach-game-picker"
                >
                  <option value="">{copy.trainingGames.session}</option>
                  {props.training.games.map((game, index) => {
                    const teams = game.teams.map((team, teamIndex) => game.teamNames[teamIndex] || props.training?.groups.find((group) => group.id === team)?.name || team).join(" vs ");
                    return <option key={`${game.start}-${index}`} value={index}>{copy.trainingGames.game(index + 1, teams)}</option>;
                  })}
                </select>
              </label>
            )}
            {props.training.segments.length > 0 && (
              <TrainingSessionTimeline
                segments={props.training.segments}
                games={props.training.games}
                groups={props.training.groups}
                recordingDate={props.training.recordingDate}
                recordingTimeSlot={props.training.recordingTimeSlot}
                duration={fullDuration}
                range={selectedGame ? { from: selectedGame.start, to: selectedGame.end } : null}
                copy={matchesCopy}
                onSeek={seek}
              />
            )}
          </div>
        )}
        {!readOnly && (
          <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-1">
            <div className="flex gap-1 md:hidden">
              <ToolButtons tools={toolList} tool={tool} setTool={chooseTool} disabled={toolDisabled} copy={copy} labelled={!moreTools} />
              <Chip on={moreTools} onClick={() => setMoreTools(!moreTools)} title={copy.quick.moreToolsHint}><SlidersHorizontal className="h-3.5 w-3.5" />{moreTools ? copy.quick.simpleTools : copy.quick.moreTools}</Chip>
            </div>
            <span className="mx-1 h-6 w-px shrink-0 bg-line md:hidden" />
            {COACH_COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={c} aria-pressed={color === c}
                className={cn("h-7 w-7 shrink-0 rounded-full border-2", color === c ? "border-text" : "border-transparent")} style={{ background: c }} />
            ))}
            {moreTools && <>
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
            </>}
            {!moreTools && <span className="mx-1 h-6 w-px shrink-0 bg-line" />}
            <Chip on={Boolean(board.ball)} onClick={() => setBoard({ ...board, ball: !board.ball }, false)}><Goal className="h-3.5 w-3.5" />{copy.ball}</Chip>
            <Chip on={follow} onClick={() => { const next = !follow; setFollow(next); if (next && viewRef.current.zoom < 1.5) zoomBy(2.2); }} title={copy.followHint}><Crosshair className="h-3.5 w-3.5" />{copy.follow}</Chip>
            {analysis && moreTools && (
              <span className="relative shrink-0">
                <Chip on={Boolean(board.teamLines)} onClick={() => (board.teamLines ? setBoard({ ...board, teamLines: undefined }, false) : setLinesOpen((o) => !o))} title={map ? copy.analysis.linesHint : copy.analysis.needsPitch} disabled={!map}>
                  <Rows3 className="h-3.5 w-3.5" />{copy.analysis.teamLines}
                </Chip>
              </span>
            )}
            {board.teamLines && moreTools && (
              <Chip on={board.teamLines.keeper !== false} onClick={() => setBoard({ ...board, teamLines: { ...board.teamLines!, keeper: board.teamLines!.keeper === false ? undefined : false } }, false)} title={copy.analysis.keeperHint}>{copy.analysis.leaveKeeperOut}</Chip>
            )}
            <span className="mx-1 h-6 w-px shrink-0 bg-line" />
            <Chip onClick={undo}><Undo2 className="h-3.5 w-3.5" />{copy.undo}</Chip>
            {moreTools && <Chip onClick={clearShapes}><Eraser className="h-3.5 w-3.5" />{copy.clear}</Chip>}
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
            {quick && total > rangeStart && (() => {
              const w = quickClip(quickLen);
              const pct = (ms: number) => Math.max(0, Math.min(100, ((ms / 1000 - rangeStart) / (total - rangeStart)) * 100));
              return <span className="pointer-events-none absolute inset-y-0 my-auto h-3 rounded-full bg-floodlight/35 ring-1 ring-floodlight" style={{ left: `${pct(w.atMs)}%`, width: `${Math.max(0.6, pct(w.endMs) - pct(w.atMs))}%` }} data-testid="coach-quick-band" />;
            })()}
            <input type="range" min={rangeStart} max={Math.max(rangeStart + 0.1, total)} step={0.05} value={Math.min(Math.max(time, rangeStart), total || time)} onChange={(e) => seek(Number(e.target.value))}
              className="w-full accent-floodlight" aria-label="time" data-testid="coach-scrubber" />
            {total > rangeStart && (props.notes ?? []).filter((n) => n.atMs / 1000 >= rangeStart && n.atMs / 1000 <= total).map((n) => (
              <button key={n.id} type="button" onClick={() => openNote(n)} title={n.title || clockOf(n.atMs / 1000)}
                className="absolute -top-1.5 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-turf ring-2 ring-void" style={{ left: `${((n.atMs / 1000 - rangeStart) / (total - rangeStart)) * 100}%` }} />
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
          initial={saveOpen.initial}
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

function ToolButtons({ tools, tool, setTool, copy, vertical, labelled, disabled }: {
  tools: typeof TOOLS;
  tool: CoachTool;
  setTool: (t: CoachTool) => void;
  copy: ReturnType<typeof useCoachCopy>;
  vertical?: boolean;
  /** Simple mode: the tool's name next to (or under) its icon */
  labelled?: boolean;
  disabled?: (t: CoachTool) => boolean;
}) {
  return (
    <>
      {tools.map(({ id, icon: Icon }, i) => (
        <button key={id} type="button" onClick={() => setTool(id)} aria-pressed={tool === id} disabled={disabled?.(id)}
          title={disabled?.(id) ? `${copy.tools[id]} · ${copy.analysis.needsPitch}` : `${copy.tools[id]}${i < 9 ? ` (${i + 1})` : ""}`}
          className={cn("shrink-0 rounded-xl transition-colors disabled:opacity-35",
            labelled
              ? vertical ? "flex w-[4.25rem] flex-col items-center gap-0.5 px-1 py-1.5 text-[11px] font-semibold leading-tight" : "inline-flex h-9 items-center gap-1.5 px-2.5 text-xs font-semibold"
              : cn("grid place-items-center", vertical ? "h-10 w-11" : "h-9 w-9"),
            tool === id ? "bg-floodlight text-void" : "text-muted-text hover:bg-raised hover:text-text")}
          data-testid={`coach-tool-${id}`}>
          <Icon className="h-5 w-5 shrink-0" aria-hidden />
          {labelled ? <span className="text-center">{copy.tools[id]}</span> : <span className="sr-only">{copy.tools[id]}</span>}
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

function Chip({ on, onClick, children, title, disabled }: { on?: boolean; onClick: () => void; children: React.ReactNode; title?: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} title={title} disabled={disabled}
      className={cn("inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold disabled:opacity-40", on ? "bg-turf text-void" : "text-muted-text hover:bg-raised hover:text-text")}>
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

function SaveDialog({ copy, existing, initial, lineup, spotlitPlayerIds, atMs, onCancel, onSave }: {
  copy: ReturnType<typeof useCoachCopy>;
  existing: CoachNote | null;
  initial?: QuickDraft;
  lineup: Array<{ playerId: number; name: string; shirtNumber: number | null }>;
  spotlitPlayerIds: number[];
  atMs: number;
  onCancel: () => void;
  onSave: (fields: Omit<CoachNoteInput, "board">) => Promise<void>;
}) {
  const [title, setTitle] = useState(existing?.title ?? initial?.title ?? "");
  const [body, setBody] = useState(existing?.body ?? initial?.body ?? "");
  const [playFor, setPlayFor] = useState(existing?.endMs ? Math.max(1, Math.round((existing.endMs - existing.atMs) / 1000))
    : initial ? Math.max(1, Math.round((initial.endMs - initial.atMs) / 1000)) : 8);
  const [players, setPlayers] = useState<number[]>(existing?.playerIds ?? initial?.playerIds ?? [...new Set(spotlitPlayerIds)]);
  const [shared, setShared] = useState(existing?.shared ?? initial?.shared ?? false);
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const at = existing?.atMs ?? initial?.atMs ?? atMs;
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
            {[...new Set([...PLAY_FOR, playFor])].sort((a, b) => a - b).map((s) => (
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

/**
 * The Quick note: tap a child, pick Well done / Watch this / Work on it, send. It goes to his
 * parents straight away; a track not tied to a child asks who he is first, or stays with staff.
 */
function QuickNoteSheet({ copy, name, boundPlayerId, lineup, sentName, lengthS, onLength, clipLabel, left, onClose, onSend, onMore }: {
  copy: ReturnType<typeof useCoachCopy>;
  name: string;
  boundPlayerId: number | null;
  lineup: Array<{ playerId: number; name: string; shirtNumber: number | null }>;
  sentName: (playerId: number | null) => string;
  /** clip length in seconds, kept by the parent so the timeline can show it */
  lengthS: number;
  onLength: (s: number) => void;
  /** the clip's times, as the timeline shows them */
  clipLabel: string;
  /** wide screens: dock on the left of the video (he is on the right) */
  left: boolean;
  onClose: () => void;
  onSend: (f: QuickFields & { share: boolean }) => Promise<void>;
  onMore: (f: QuickFields) => void;
}) {
  const [preset, setPreset] = useState<QuickPreset | null>(null);
  const [comment, setComment] = useState("");
  const [playerId, setPlayerId] = useState<number | null>(boundPlayerId);
  const [state, setState] = useState<"idle" | "sending" | "failed" | { done: string }>("idle");
  const needsChild = boundPlayerId === null && lineup.length > 0;
  // The parent re-renders as the video plays, so hold onClose in a ref or the timer never fires.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (typeof state !== "object") return;
    const id = window.setTimeout(() => closeRef.current(), 1600);
    return () => window.clearTimeout(id);
  }, [state]);
  const send = async (share: boolean) => {
    setState("sending");
    try {
      await onSend({ preset, comment, playerId, lengthS, share });
      setState({ done: share && playerId !== null ? copy.quick.sent(sentName(playerId)) : copy.quick.savedStaff });
    } catch {
      setState("failed");
    }
  };
  const shownName = playerId !== null ? sentName(playerId) : name;
  return (
    <div className={cn("fixed inset-x-0 bottom-0 z-[85] mx-auto w-full max-w-lg rounded-t-3xl border border-b-0 border-line bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl md:absolute md:inset-x-auto md:bottom-3 md:mx-0 md:w-[26rem] md:rounded-3xl md:border-b md:pb-4", left ? "md:left-3" : "md:right-3")}
      role="dialog" aria-label={shownName} data-testid="coach-quick">
      {typeof state === "object" ? (
        <p className="flex items-center justify-center gap-2 py-6 text-base font-bold text-turf" role="status" data-testid="coach-quick-done"><Check className="h-5 w-5" aria-hidden />{state.done}</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate font-display text-lg font-bold text-text" dir="auto">{shownName}</p>
            <button type="button" onClick={onClose} aria-label={copy.close} className="grid h-9 w-9 place-items-center rounded-full text-muted-text hover:bg-raised hover:text-text"><X className="h-5 w-5" /></button>
          </div>
          {needsChild && (
            <div className="mt-2">
              <p className="text-sm font-semibold text-text">{copy.quick.whoIsThis}</p>
              <p className="text-xs text-muted-text">{copy.quick.whoHint}</p>
              <div className="mt-1.5 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto" data-testid="coach-quick-who">
                {lineup.map((p) => (
                  <button key={p.playerId} type="button" onClick={() => setPlayerId(playerId === p.playerId ? null : p.playerId)} aria-pressed={playerId === p.playerId}
                    className={cn("h-8 rounded-full px-3 text-xs font-semibold", playerId === p.playerId ? "bg-floodlight text-void" : "bg-raised text-muted-text")} dir="auto">
                    {p.shirtNumber !== null ? `#${p.shirtNumber} ` : ""}{p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-3 grid grid-cols-3 gap-2">
            {QUICK_PRESETS.map((k) => (
              <button key={k} type="button" onClick={() => setPreset(preset === k ? null : k)} aria-pressed={preset === k}
                className={cn("flex flex-col items-center gap-1 rounded-2xl border px-2 py-3 text-sm font-bold transition-colors",
                  preset === k ? "border-floodlight bg-floodlight text-void" : "border-line bg-raised text-text hover:border-muted-text")}
                data-testid={`coach-quick-${k}`}>
                <span className="text-2xl leading-none" aria-hidden>{copy.quick.emoji[k]}</span>
                {copy.quick.presets[k]}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="coach-quick-length">
            <span className="me-1 text-xs font-semibold text-muted-text">{copy.quick.clip}</span>
            {QUICK_LENGTHS.map((s) => (
              <button key={s} type="button" onClick={() => onLength(s)} aria-pressed={lengthS === s}
                className={cn("h-8 rounded-full px-3 text-xs font-semibold", lengthS === s ? "bg-turf text-void" : "bg-raised text-muted-text hover:text-text")}
                data-testid={`coach-quick-len-${s}`}>{copy.quick.lastSeconds(s)}</button>
            ))}
            <span className="ms-auto font-mono text-[11px] tabular-nums text-muted-text" dir="ltr" data-testid="coach-quick-clip">{clipLabel}</span>
          </div>
          <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={300} placeholder={copy.quick.comment} aria-label={copy.quick.comment} dir="auto"
            className="mt-3 h-10 w-full rounded-xl border border-line bg-raised px-3 text-sm text-text outline-none" data-testid="coach-quick-comment" />
          {state === "failed" && <p className="mt-2 text-sm text-live" role="alert">{copy.quick.failed}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button type="button" onClick={() => onMore({ preset, comment, playerId, lengthS })} className="h-11 shrink-0 rounded-xl px-3 text-sm font-semibold text-muted-text hover:text-text" data-testid="coach-quick-more">{copy.quick.more}</button>
            <button type="button" onClick={() => void send(false)} disabled={state === "sending"} className="h-11 shrink-0 rounded-xl border border-line px-3 text-sm font-semibold text-text disabled:opacity-50" data-testid="coach-quick-staff">{copy.quick.saveStaff}</button>
            <button type="button" onClick={() => void send(true)} disabled={state === "sending" || playerId === null || (!preset && !comment.trim())}
              className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl bg-floodlight px-3 text-sm font-bold text-void disabled:opacity-40" data-testid="coach-quick-send">
              <Send className="h-4 w-4 shrink-0" aria-hidden /><span className="truncate">{state === "sending" ? copy.quick.sending : copy.quick.send}</span>
            </button>
          </div>
          {playerId === null && !needsChild && <p className="mt-2 text-xs text-muted-text">{copy.quick.noChild} · {copy.shareNeedsPlayers}</p>}
        </>
      )}
    </div>
  );
}
