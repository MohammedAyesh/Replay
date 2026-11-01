import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, Clock3, Loader2, Play, Sparkles, Undo2, X } from "lucide-react";
import { getListUserClipsQueryKey } from "@workspace/api-client-react";
import { ReelVideo, type ReelVideoState } from "@/components/match/ReelVideo";
import { prefetchFirstClip, useReelClips, type ReelClipState } from "@/lib/goal-reel";
import { dropClips, momentClipUrl, rememberKept, undecided, useMomentReel, type MomentReelCard } from "@/lib/moment-reel";
import { momentTitle } from "@/lib/moment-deck";
import { matchKey, type MatchRoom } from "@/lib/match-api";
import { useMomentReelCopy, type MomentReelStrings } from "@/i18n/moment-reel-strings";
import { cn } from "@/lib/utils";

/**
 * "Your moments" (2026-11-01): the player's own moments in this match, played
 * one after another in a popup over the match page, to keep in My Clips or
 * not. Save (or swipe right) keeps it, Don't save (left) drops it, Later (up)
 * leaves it for next time, Back takes the last answer back.
 *
 * Same machinery as "Was it a goal?" (GoalReel): every card is a few seconds
 * of the match cut once onto Bunny, downloaded ahead from its CDN and played
 * from memory, following him with his clip's own follow path. Drops are sent
 * when the reel closes, so nothing is deleted until he is done with it.
 */

type Verdict = "save" | "drop" | "later";
type Result = { card: MomentReelCard; verdict: Verdict };

const FLOOD = "#D4FF4F";
const SWIPE = 96;
const FLY_MS = 220;

/** The entry row: shows only when he has moments in this match he has not decided. */
export function MomentReelButton({ room, className }: { room: MatchRoom; className?: string }) {
  const copy = useMomentReelCopy();
  const [open, setOpen] = useState(false);
  const enabled = Boolean(room.signedIn && room.me);
  const reel = useMomentReel(room.code, enabled);
  const cards = useMemo(() => undecided(room.code, reel.data?.cards), [room.code, reel.data, open]);
  const route = useCallback((card: MomentReelCard) => momentClipUrl(room.code, card), [room.code]);
  const first = cards[0];
  // the first moment downloads while the button is on screen, so the reel opens playing
  useEffect(() => { prefetchFirstClip(route, first); }, [route, first]);
  if (!enabled || !cards.length) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("flex min-h-12 w-full items-center gap-3 rounded-2xl border border-floodlight/40 bg-floodlight/10 px-3.5 text-start text-sm font-semibold", className)}
        data-testid="button-moment-reel"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-floodlight text-void"><Play className="h-3.5 w-3.5 fill-current" /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{copy.title} · {copy.open(cards.length)}</span>
          <span className="truncate text-[11px] font-normal text-muted-text">{copy.openNote}</span>
        </span>
      </button>
      {open && <MomentReel room={room} startCards={cards} onClose={() => setOpen(false)} />}
    </>
  );
}

export function MomentReel({ room, startCards, onClose }: { room: MatchRoom; startCards: MomentReelCard[]; onClose: () => void }) {
  const copy = useMomentReelCopy();
  const queryClient = useQueryClient();
  const reel = useMomentReel(room.code, true);
  // fixed when the reel opens: a refetch never reshuffles cards under a thumb
  const [cards] = useState<MomentReelCard[]>(startCards);
  const recordings = useMemo(() => new Map((reel.data?.recordings ?? []).map((r) => [r.recordingId, r])), [reel.data]);
  const [i, setI] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [done, setDone] = useState(false);
  const [dropFailed, setDropFailed] = useState(false);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const [videoState, setVideoState] = useState<Record<string, ReelVideoState>>({});
  const flying = useRef(false);
  const applied = useRef(false);
  const resultsRef = useRef(results);
  resultsRef.current = results;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevFocus = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    const wasInert = root?.hasAttribute("inert") ?? false;
    document.body.style.overflow = "hidden";
    root?.setAttribute("inert", "");
    dialogRef.current?.querySelector<HTMLElement>("[data-testid=button-moment-reel-close]")?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      if (root && !wasInert) root.removeAttribute("inert");
      prevFocus?.focus?.();
    };
  }, []);

  /** Keep the saves on this device, delete the drops' clips. Once. */
  const apply = useCallback(async () => {
    if (applied.current) return { failed: [] as number[] };
    applied.current = true;
    const final = resultsRef.current;
    rememberKept(room.code, final.filter((r) => r.verdict === "save").map((r) => r.card.id));
    const drops = final.filter((r) => r.verdict === "drop").flatMap((r) => r.card.userClipIds);
    const out = drops.length ? await dropClips(drops) : { failed: [] };
    void queryClient.invalidateQueries({ queryKey: matchKey(room.code) });
    void queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
    return out;
  }, [queryClient, room.code]);

  // a tab closed or reloaded mid-reel still sends what was decided
  useEffect(() => {
    const onHide = () => { void apply(); };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [apply]);

  const answered = results.some((r) => r.verdict !== "later");
  // Done: the drops go now; if one fails the reel stays open to say so, and Done again closes it
  const leave = useCallback(async () => {
    if (applied.current) { onClose(); return; }
    const { failed } = await apply();
    if (failed.length) { setDropFailed(true); setDone(true); return; }
    onClose();
  }, [apply, onClose]);
  const close = useCallback(() => { if (answered && !done) setDone(true); else void leave(); }, [answered, done, leave]);

  const current = !done ? cards[i] ?? null : null;
  const route = useCallback((card: MomentReelCard) => momentClipUrl(room.code, card), [room.code]);
  const { clips, retry } = useReelClips(route, cards, i);
  const onVideoState = useCallback((id: string, state: ReelVideoState) => {
    setVideoState((s) => (s[id] === state ? s : { ...s, [id]: state }));
  }, []);

  const decide = useCallback((verdict: Verdict) => {
    if (!current || flying.current) return;
    flying.current = true;
    const el = document.getElementById(`moment-card-${current.id}`);
    if (el) {
      el.style.transition = `transform ${FLY_MS}ms cubic-bezier(.2,.8,.2,1), opacity ${FLY_MS}ms`;
      el.style.transform = verdict === "save" ? "translate(140%, -6%) rotate(16deg)"
        : verdict === "drop" ? "translate(-140%, -6%) rotate(-16deg)" : "translate(0, -120%)";
      el.style.opacity = "0";
    }
    try { navigator.vibrate?.(verdict === "later" ? 6 : 14); } catch { /* not supported */ }
    if (verdict !== "later") setToast({ text: verdict === "save" ? copy.toastSaved : copy.toastDropped, key: Date.now() });
    setResults((r) => [...r, { card: current, verdict }]);
    window.setTimeout(() => {
      flying.current = false;
      if (i + 1 >= cards.length) setDone(true);
      else setI(i + 1);
    }, FLY_MS);
  }, [cards.length, current, copy, i]);

  const back = useCallback(() => {
    if (flying.current || !results.length || applied.current) return;
    setResults((r) => r.slice(0, -1));
    setDone(false);
    setI(Math.max(0, results.length - 1));
  }, [results]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1100);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (done) return;
      if (e.key === "ArrowRight") { e.preventDefault(); decide("save"); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); decide("drop"); }
      else if (e.key === "ArrowUp") { e.preventDefault(); decide("later"); }
      else if (e.key === "Backspace") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, back, close, done]);

  let body: React.ReactNode;
  if (!cards.length) {
    body = (
      <Centered>
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-turf/15 text-turf"><Check className="h-7 w-7" /></span>
        <h2 className="mt-3 font-display text-[26px] font-bold">{copy.noneTitle}</h2>
        <p className="mt-1 text-sm text-muted-text">{copy.noneDesc}</p>
        <button type="button" onClick={() => void leave()} className="mt-6 min-h-12 rounded-full bg-floodlight px-6 text-base font-bold text-void">{copy.done}</button>
      </Centered>
    );
  } else if (done) {
    body = <Done copy={copy} results={results} total={cards.length} failed={dropFailed} onDone={() => void leave()} onUndo={results.length && !dropFailed ? back : null} />;
  } else {
    const stack = cards.slice(i, i + 3).map((card, k) => ({ card, k }));
    body = (
      <>
        <div className="relative min-h-0 flex-1">
          {stack.slice().reverse().map(({ card, k }) => {
            const rec = recordings.get(card.recordingId);
            return (
              <CardView
                key={card.id}
                card={card}
                depth={k}
                copy={copy}
                srcAspect={rec && rec.srcW > 0 && rec.srcH > 0 ? rec.srcW / rec.srcH : 3840 / 1080}
                active={k === 0}
                clip={k <= 1 ? clips[card.id] ?? { status: "loading" } : null}
                videoState={videoState[card.id] ?? "loading"}
                onVideoState={onVideoState}
                onRetry={() => retry(card.id)}
                onDecide={decide}
              />
            );
          })}
          {toast && (
            <div key={toast.key} role="status" className="pointer-events-none absolute left-1/2 top-[34%] z-30 flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-full border border-turf/40 bg-raised py-2 pe-4 ps-2 shadow-[0_12px_32px_rgba(0,0,0,.45)] [animation:reel-toast_1.1s_ease-out_forwards]">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-turf/15 text-turf"><Check className="h-4 w-4" /></span>
              <span className="font-display text-base font-bold">{toast.text}</span>
            </div>
          )}
        </div>
        <Controls copy={copy} onDecide={decide} onBack={results.length ? back : null} />
      </>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/65 backdrop-blur-[2px] [animation:reel-fade_.18s_ease-out] sm:items-center sm:p-6"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      data-testid="moment-reel-backdrop"
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={copy.title} dir={copy.locale === "ar" ? "rtl" : "ltr"}
        className="relative flex h-[min(88dvh,720px)] w-full max-w-[440px] flex-col gap-3 overflow-hidden rounded-t-[28px] border border-line bg-void px-4 pb-[max(14px,env(safe-area-inset-bottom))] pt-2.5 text-text shadow-[0_-12px_48px_rgba(0,0,0,.55)] [animation:reel-up_.24s_cubic-bezier(.2,.8,.2,1)] sm:rounded-[28px]"
        data-testid="moment-reel">
        <span aria-hidden="true" className="mx-auto h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" />
        <Header copy={copy} onClose={close} progress={cards.length && !done ? { at: i, of: cards.length } : null} />
        {body}
      </div>
      <style>{`@keyframes reel-toast{0%{transform:translate(-50%,12px);opacity:0}15%{transform:translate(-50%,0);opacity:1}80%{opacity:1}100%{transform:translate(-50%,-8px);opacity:0}}
@keyframes reel-up{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}
@keyframes reel-fade{from{opacity:0}to{opacity:1}}`}</style>
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------------- pieces */

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center text-center">{children}</div>;
}

function Header({ copy, onClose, progress }: { copy: MomentReelStrings; onClose: () => void; progress: { at: number; of: number } | null }) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      <button type="button" aria-label={copy.close} onClick={onClose} data-testid="button-moment-reel-close"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-text">
        <X className="h-5 w-5" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="truncate font-display text-[11px] font-bold uppercase tracking-[0.3em] text-floodlight rtl:text-xs rtl:tracking-normal">{copy.title}</span>
        {progress && (
          <div className="flex items-center gap-2" role="progressbar" aria-valuemin={0} aria-valuemax={progress.of} aria-valuenow={progress.at}>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-floodlight transition-[width] duration-200" style={{ width: `${(progress.at / progress.of) * 100}%` }} />
            </div>
            <span dir="ltr" className="shrink-0 font-mono text-[11px] tabular-nums text-muted-text">{Math.min(progress.at + 1, progress.of)}/{progress.of}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CardView({ card, depth, copy, clip, srcAspect, active, videoState, onVideoState, onRetry, onDecide }: {
  card: MomentReelCard; depth: number; copy: MomentReelStrings & { locale: "en" | "ar" };
  clip: ReelClipState | null; srcAspect: number; active: boolean; videoState: ReelVideoState;
  onVideoState: (id: string, state: ReelVideoState) => void;
  onRetry: () => void;
  onDecide: (verdict: Verdict) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const yesRef = useRef<HTMLDivElement | null>(null);
  const noRef = useRef<HTMLDivElement | null>(null);
  const upRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const title = momentTitle({ kind: card.kind, title: card.title }, copy.locale);

  const paint = (dx: number, dy: number) => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = `translate(${dx}px, ${Math.min(0, dy)}px) rotate(${dx / 20}deg)`;
    // right keeps in both languages, as on every swipe app; the buttons stay in that order too
    if (yesRef.current) yesRef.current.style.opacity = String(Math.max(0, Math.min(1, dx / SWIPE)));
    if (noRef.current) noRef.current.style.opacity = String(Math.max(0, Math.min(1, -dx / SWIPE)));
    if (upRef.current) upRef.current.style.opacity = String(Math.abs(dx) < 40 ? Math.max(0, Math.min(1, -dy / SWIPE)) : 0);
  };
  const reset = () => {
    if (!ref.current) return;
    ref.current.style.transition = "transform .2s ease-out";
    paint(0, 0);
  };
  const onDown = (e: React.PointerEvent) => {
    if (!active) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* still drags */ }
    if (ref.current) ref.current.style.transition = "none";
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    paint(e.clientX - drag.current.x, e.clientY - drag.current.y);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
    drag.current = null;
    if (dx > SWIPE) onDecide("save");
    else if (dx < -SWIPE) onDecide("drop");
    else if (dy < -SWIPE && Math.abs(dx) < 60) onDecide("later");
    else reset();
  };
  // a drag the system took away is not an answer (some browsers report it at 0,0)
  const onCancel = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    reset();
  };

  const behind = depth > 0;
  return (
    <div
      id={`moment-card-${card.id}`}
      ref={ref}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      className={cn("absolute inset-0 flex select-none flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-[0_20px_48px_rgba(0,0,0,.45)]",
        active ? "z-20 cursor-grab touch-none" : "z-10")}
      style={behind ? { transform: `translateY(${12 * depth}px) scale(${1 - 0.05 * depth})`, opacity: depth === 1 ? 1 : 0, transition: "transform .24s, opacity .24s" } : undefined}
      data-testid={active ? "moment-card-active" : undefined}
    >
      <div className="relative min-h-0 flex-1">
        {clip && (
          <ReelVideo card={card} src={clip.status === "ready" ? clip.url : null} offset={clip.status === "ready" ? clip.offset : 0}
            srcAspect={srcAspect} active={active} onState={onVideoState} ringColor={FLOOD} tag={copy.tag} fieldViewLabel={copy.fieldView} />
        )}
        <div className="pointer-events-none absolute left-3 right-40 top-3 flex flex-wrap gap-1.5" dir="ltr">
          <span className="rounded-md bg-black/60 px-2 py-0.5 font-display text-xs font-bold text-white">{card.minute}′</span>
        </div>
        {(clip?.status === "failed" || videoState === "failed") && (
          <div className="absolute inset-x-6 top-1/2 flex -translate-y-1/2 flex-col items-center gap-2 rounded-xl bg-black/70 p-3 text-center text-xs text-white">
            {copy.videoFailed}
            {active && (
              <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onRetry}
                className="min-h-9 rounded-full border border-white/40 px-4 font-semibold">{copy.retry}</button>
            )}
          </div>
        )}
        {active && clip?.status !== "failed" && videoState === "loading" && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-center gap-2 text-xs font-semibold text-muted-text">
            <Loader2 className="h-4 w-4 animate-spin" />{copy.videoSlow}
          </div>
        )}
        <div ref={yesRef} className="pointer-events-none absolute start-5 top-16 -rotate-12 rounded-xl border-[3px] border-floodlight bg-void/55 px-3 py-1 font-display text-2xl font-bold uppercase tracking-wider text-floodlight" style={{ opacity: 0 }}>{copy.save}</div>
        <div ref={noRef} className="pointer-events-none absolute end-5 top-16 rotate-12 rounded-xl border-[3px] border-text bg-void/55 px-3 py-1 font-display text-2xl font-bold uppercase tracking-wider text-text" style={{ opacity: 0 }}>{copy.drop}</div>
        <div ref={upRef} className="pointer-events-none absolute bottom-14 left-1/2 -translate-x-1/2 rounded-xl border-[3px] border-muted-text bg-void/55 px-3 py-1 font-display text-xl font-bold uppercase tracking-wider" style={{ opacity: 0 }}>{copy.later}</div>
      </div>
      <div className="flex flex-col gap-2 px-[18px] pb-4 pt-3.5">
        <span className="flex min-w-0 items-start gap-2">
          <Sparkles className="mt-1.5 h-4 w-4 shrink-0 text-floodlight" aria-hidden="true" />
          <span className="line-clamp-2 font-display text-[24px] font-bold leading-[1.15]">{title}</span>
        </span>
      </div>
    </div>
  );
}

function Controls({ copy, onDecide, onBack }: { copy: MomentReelStrings; onDecide: (v: Verdict) => void; onBack: (() => void) | null }) {
  return (
    <div className="flex flex-col gap-1.5" dir="ltr">
      <div className="flex items-center justify-center gap-4">
        <button type="button" aria-label={copy.back} onClick={() => onBack?.()} disabled={!onBack} data-testid="button-moment-back"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface/60 text-muted-text active:scale-95 disabled:opacity-30">
          <Undo2 className="h-4 w-4" />
        </button>
        <button type="button" aria-label={copy.drop} onClick={() => onDecide("drop")} data-testid="button-moment-drop"
          className="flex h-16 w-16 items-center justify-center rounded-full border border-line bg-surface/60 text-text active:scale-95">
          <X className="h-7 w-7" />
        </button>
        <button type="button" aria-label={copy.later} onClick={() => onDecide("later")} data-testid="button-moment-later"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface/60 text-muted-text active:scale-95">
          <ArrowUp className="h-4 w-4" />
        </button>
        <button type="button" aria-label={copy.save} onClick={() => onDecide("save")} data-testid="button-moment-save"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-floodlight text-void active:scale-95">
          <Check className="h-7 w-7" strokeWidth={2.8} />
        </button>
      </div>
      <div className="flex justify-center gap-4 text-[11px] font-semibold text-muted-text">
        <span className="w-11 text-center">{copy.back}</span>
        <span className="w-16 text-center">{copy.drop}</span>
        <span className="w-11 text-center">{copy.later}</span>
        <span className="w-16 text-center">{copy.save}</span>
      </div>
    </div>
  );
}

function Done({ copy, results, total, failed, onDone, onUndo }: {
  copy: MomentReelStrings; results: Result[]; total: number; failed: boolean; onDone: () => void; onUndo: (() => void) | null;
}) {
  const saved = results.filter((r) => r.verdict === "save").length;
  const dropped = results.filter((r) => r.verdict === "drop").length;
  const later = results.filter((r) => r.verdict === "later").length;
  const left = Math.max(0, total - results.length);
  const tiles = [
    { value: saved, label: copy.saved, cls: "text-floodlight", icon: <Check className="h-4 w-4" /> },
    { value: dropped, label: copy.dropped, cls: "text-text", icon: <X className="h-4 w-4" /> },
    { value: later, label: copy.later_, cls: "text-muted-text", icon: <Clock3 className="h-4 w-4" /> },
  ];
  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="moment-reel-done">
      <div className="flex flex-col items-center gap-2 rounded-3xl border border-floodlight/40 bg-surface px-5 py-5 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-floodlight/15 text-floodlight"><Sparkles className="h-7 w-7" /></span>
        <h2 className="font-display text-[28px] font-bold leading-[1.05]">{left > 0 ? copy.pausedTitle(left) : copy.doneTitle}</h2>
        <p className="text-sm leading-6 text-muted-text">{left > 0 ? copy.pausedDesc : copy.doneDesc}</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {tiles.map((tile) => (
          <div key={tile.label} className="flex flex-col gap-0.5 rounded-2xl border border-line bg-surface px-3 py-3.5">
            <span dir="ltr" className={cn("flex items-center gap-1 font-display text-[30px] font-bold leading-tight tabular-nums", tile.cls)}>{tile.value}</span>
            <span className="flex items-center gap-1 text-xs text-muted-text">{tile.icon}{tile.label}</span>
          </div>
        ))}
      </div>
      {failed && <p role="alert" className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-muted-text">{copy.dropFailed}</p>}
      <div className="flex-1" />
      <button type="button" onClick={onDone} className="min-h-12 rounded-full bg-floodlight text-base font-bold text-void" data-testid="button-moment-done">{copy.done}</button>
      {onUndo && (
        <button type="button" onClick={onUndo} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-line text-sm font-semibold">
          <Undo2 className="h-4 w-4" />{copy.back}
        </button>
      )}
    </div>
  );
}
