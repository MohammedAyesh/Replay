import type React from "react";
import { cn } from "@/lib/utils";
import type { Chunk, Game, OffRange } from "@/lib/game-claim/model";
import { L2G, mmss, OUT } from "@/lib/game-claim/model";
import { hkey, offLocal, timeline, type Ctx, type Hole } from "@/lib/game-claim/claim";
import type { GameStrings } from "@/i18n/game-strings";

/**
 * Small building blocks the game-claim screens share.
 *
 * They follow the match report (components/match/report): Turf eyebrows,
 * Surface cards with rounded-2xl corners, rounded-full buttons, one Floodlight
 * action per screen, LTR tabular numbers.
 */

export function Btn({
  children,
  onClick,
  kind = "ghost",
  size = "md",
  disabled,
  className,
  title,
  testId,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "violet" | "turf";
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
  title?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold leading-snug transition-colors disabled:opacity-40",
        size === "sm" ? "min-h-9 px-3.5 py-1.5 text-xs" : "min-h-12 px-5 py-2 text-sm",
        kind === "primary" && cn("bg-floodlight font-bold text-void hover:opacity-90", size === "md" && "text-base"),
        // #7B5CFF fails AA as text on Void; violet TEXT is #A98CFF, the border keeps the brand violet.
        kind === "violet" && "border border-violet text-[#A98CFF] hover:bg-violet/10",
        kind === "ghost" && "border border-line bg-surface/60 text-text hover:border-muted-text",
        kind === "turf" && "border border-turf/60 text-turf hover:bg-turf/10",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-turf rtl:text-xs rtl:tracking-normal">{children}</p>;
}

export function Title({ children, big }: { children: React.ReactNode; big?: boolean }) {
  return <h1 className={cn("font-display font-bold leading-tight text-text", big ? "text-[28px]" : "text-2xl")}>{children}</h1>;
}

/** A small rounded pill: who else picked a person, counts, states. */
export function Chip({ children, tone = "muted", className }: {
  children: React.ReactNode;
  tone?: "muted" | "turf" | "violet";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-h-7 w-fit items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        tone === "turf" && "border-turf/40 bg-turf/10 text-turf",
        tone === "violet" && "border-violet/40 bg-violet/10 text-[#A98CFF]",
        tone === "muted" && "border-line bg-raised text-muted-text",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Where the player is in the game: one segment per ten-minute block. */
export function ProgressRail({ step, of, label }: { step: number; of: number; label: string }) {
  return (
    <div className="flex items-center gap-2" role="progressbar" aria-valuemin={0} aria-valuemax={of} aria-valuenow={step} aria-label={label}>
      <div className="flex flex-1 gap-1">
        {Array.from({ length: of }, (_, index) => (
          <span key={index} className={cn("h-1 flex-1 rounded-full", index < step ? "bg-turf" : "bg-line")} />
        ))}
      </div>
      <span dir="ltr" className="shrink-0 font-mono text-[11px] tabular-nums text-muted-text">{step}/{of}</span>
    </div>
  );
}

export function Lede({ children }: { children: React.ReactNode }) {
  return <p className="max-w-[62ch] text-sm leading-6 text-muted-text">{children}</p>;
}

export function Section({ title, children }: { title?: React.ReactNode; children: React.ReactNode }) {
  return (
    // A divider-led block, like a match report section (cards sit inside it).
    <div className="flex flex-col gap-3 border-t border-[#1B2236] pt-5">
      {title && <h3 className="font-display text-lg font-bold leading-tight text-text">{title}</h3>}
      {children}
    </div>
  );
}

export function Crop({ chunk, keyName, h = 104, className }: { chunk: Chunk; keyName: string | null | undefined; h?: number; className?: string }) {
  const b64 = keyName ? chunk.crops[keyName] : null;
  if (!b64) return null;
  return (
    <img
      src={`data:image/jpeg;base64,${b64}`}
      alt=""
      loading="lazy"
      draggable={false}
      style={{ height: h }}
      className={cn("w-auto shrink-0 rounded-md object-cover", className)}
    />
  );
}

export function Stat({ value, label }: { value: React.ReactNode; label: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <b dir="ltr" className="block font-mono text-[28px] font-bold leading-none tabular-nums text-text rtl:text-end">{value}</b>
      <span className="mt-1 block text-xs text-muted-text">{label}</span>
    </div>
  );
}

const pct = (x: number, total: number) => `${((100 * Math.max(0, x)) / Math.max(total, 1e-6)).toFixed(3)}%`;

/** One chunk's timeline: found, bridged, out of play, off camera, missing (current hole outlined). */
export function ChunkTimeline({
  ctx,
  k,
  cur,
  copy,
  bare,
}: {
  ctx: Ctx;
  k: number;
  cur?: Hole | null;
  copy: GameStrings["timeline"];
  bare?: boolean;
}) {
  const t = timeline(ctx, k);
  const meta = ctx.game.chunks.find((c) => c.k === k)!;
  const dur = meta.dur;
  const seg = (cls: string, [a, b]: [number, number], key: string) => (
    <i key={key} className={cn("absolute inset-y-0 block", cls)} style={{ left: pct(a, dur), width: pct(Math.min(b, dur) - Math.max(a, 0), dur) }} />
  );
  const offs = offLocal(ctx, k);
  const bar = (
    <div dir="ltr" className="relative h-5 overflow-hidden rounded-md bg-raised">
      {t.found.map((x, i) => seg("bg-turf", x, `f${i}`))}
      {t.br.map((x, i) => seg("bg-turf/45", x, `b${i}`))}
      {offs.map((o, i) => seg(OUT(o[2]) ? "bg-[#3a4257]" : "bg-[#5b6479]", [Math.max(0, o[0]), Math.min(dur, o[1])], `o${i}`))}
      {t.holes.map((h, i) =>
        seg(
          cn("bg-[repeating-linear-gradient(45deg,rgba(255,90,60,.35)_0_4px,transparent_4px_8px)]", cur && hkey(cur) === hkey(h) && "shadow-[inset_0_0_0_2px_#D4FF4F]"),
          [h.t0, h.t1],
          `h${i}`,
        ),
      )}
    </div>
  );
  if (bare) return bar;
  const s0 = meta.start + ctx.game.matchOffset;
  const missing = t.holes.reduce((s, h) => s + h.t1 - h.t0, 0);
  return (
    <div className="flex flex-col gap-1.5">
      {bar}
      <div dir="ltr" className="flex justify-between text-[11px] tabular-nums text-muted-text">
        <span>{mmss(s0)}</span><span>{mmss(s0 + dur / 2)}</span><span>{mmss(s0 + dur)}</span>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-muted-text">
        <span><b className="me-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-turf align-[-1px]" />{copy.found(mmss(t.fs + t.bs))}</span>
        <span><b className="me-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-[#3a4257] align-[-1px]" />{copy.outOfPlay}</span>
        {t.os > 0 && <span><b className="me-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-[#5b6479] align-[-1px]" />{copy.offCamera(mmss(t.os))}</span>}
        <span><b className="me-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-[#FF5A3C]/70 align-[-1px]" />{copy.missing(mmss(missing))}</span>
      </div>
    </div>
  );
}

/** The whole game: out of play and everything found so far, with an optional playhead. */
export function GameTimeline({ ctx, ph, off }: { ctx: Ctx; ph?: number; off?: OffRange[] }) {
  const T = ctx.game.total;
  const g = ctx.game;
  return (
    <div className="flex flex-col gap-1.5">
      <div dir="ltr" className="relative h-5 overflow-hidden rounded-md bg-raised">
        {(off ?? ctx.S.off).filter((r) => r[2] === "play").map(([a, b], i) => (
          <i key={`o${i}`} className="absolute inset-y-0 block bg-[#3a4257]" style={{ left: pct(a, T), width: pct(b - a, T) }} />
        ))}
        {Object.keys(ctx.S.you).map((key) => {
          const k = Number(key);
          if (!ctx.CH[k]) return null;
          const t = timeline(ctx, k);
          return t.found.concat(t.br).map(([a, b], i) => (
            <i key={`f${k}-${i}`} className="absolute inset-y-0 block bg-turf" style={{ left: pct(L2G(g, k, a), T), width: pct(b - a, T) }} />
          ));
        })}
        {ph !== undefined && <span className="absolute inset-y-0 w-0.5 bg-floodlight" style={{ left: pct(ph, T) }} />}
      </div>
      <GameTicks game={g} />
    </div>
  );
}

export function GameTicks({ game }: { game: Game }) {
  return (
    <div dir="ltr" className="flex justify-between text-[11px] tabular-nums text-muted-text">
      {[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{mmss(game.total * f + game.matchOffset)}</span>)}
    </div>
  );
}
