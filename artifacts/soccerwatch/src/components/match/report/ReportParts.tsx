import type { ReactNode } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

/**
 * The report's visual vocabulary. Sections are separated by a hairline, not
 * boxed in cards; numbers are Rajdhani and always LTR; colour means one
 * thing each: lime is you (and the one primary action), violet is the other
 * player, turf is time on camera and links, grey is everyone else.
 */

export const REPORT_COLOURS = {
  void: "#0B0F1A",
  surface: "#141B2C",
  line: "#232C42",
  hairline: "#1B2236",
  axis: "#3A4560",
  lime: "#D4FF4F",
  violet: "#7B5CFF",
  violetText: "#A98CFF",
  turf: "#2FD8C4",
  text: "#F2F4F8",
  muted: "#8A93A6",
} as const;

/**
 * A team colour that can be seen on the void background: a black kit is drawn
 * as slate, so a bar or dot never disappears into the page.
 */
export function visibleColour(hex: string | null | undefined, fallback = "#8A93A6"): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return fallback;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance < 0.05 ? "#5A6478" : `#${m[1]}`;
}

export function Section({ eyebrow, aside, children, className, id, last = false }: {
  eyebrow?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  last?: boolean;
}) {
  return (
    <section id={id} className={cn("flex flex-col gap-3.5 py-6", !last && "border-b border-[#1B2236]", className)}>
      {(eyebrow || aside) && (
        <div className="flex items-baseline justify-between gap-3">
          {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : <span />}
          {aside && <span className="text-xs text-muted-text">{aside}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2 className={cn("font-display text-[11px] font-bold uppercase tracking-[0.3em] text-turf rtl:tracking-normal rtl:text-xs", className)}>
      {children}
    </h2>
  );
}

/** A number, LTR in every language. */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span dir="ltr" className={cn("font-mono tabular-nums", className)}>{children}</span>;
}

export function BigStat({ value, label, note, noteTone = "lime" }: {
  value: string;
  label: ReactNode;
  note?: ReactNode;
  noteTone?: "lime" | "muted";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Num className="text-[40px] font-bold leading-[0.95] text-text rtl:text-end">{value}</Num>
      <span className="text-xs leading-4 text-muted-text">{label}</span>
      {note && (
        <span className={cn("font-display text-[13px] font-bold leading-4", noteTone === "lime" ? "text-floodlight" : "text-muted-text")}>{note}</span>
      )}
    </div>
  );
}

/**
 * One metric, everyone on it: grey dots, the viewer as a lime ring, a
 * translucent band for the margin around the viewer, and the leader named.
 * Always drawn left-to-right, low to high, because it is a numeric axis.
 */
export function StripPlot({ dots, you, bandHalfWidth, leader, onOpen, label, range }: {
  dots: Array<{ id: number; value: number; ranked: boolean }>;
  you: number | null;
  bandHalfWidth: number | null;
  leader: { name: string; value: number } | null;
  onOpen?: () => void;
  label: ReactNode;
  range: ReactNode;
}) {
  const values = [...dots.map((dot) => dot.value), ...(you === null ? [] : [you])];
  let min = values.length ? Math.min(...values) : 0;
  let max = values.length ? Math.max(...values) : 1;
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;
  const at = (value: number) => `${Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))}%`;
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="text-text">{label}</span>
        <span className="text-muted-text">{range}</span>
      </div>
      <div dir="ltr" className="relative mt-1 h-[34px]">
        <div className="absolute inset-x-0 top-[19px] h-px bg-[#3A4560]" />
        {you !== null && bandHalfWidth !== null && bandHalfWidth > 0 && (
          <div
            className="absolute top-[12px] h-[15px] rounded-full bg-[rgba(212,255,79,.14)]"
            style={{ left: at(you - bandHalfWidth), width: `calc(${at(you + bandHalfWidth)} - ${at(you - bandHalfWidth)})` }}
          />
        )}
        {dots.map((dot) => (
          <span
            key={dot.id}
            className={cn(
              "absolute top-[15px] h-2 w-2 -translate-x-1/2 rounded-full",
              dot.ranked ? "bg-[#8A93A6]" : "border border-dashed border-[#8A93A6] bg-transparent",
            )}
            style={{ left: at(dot.value), boxShadow: dot.ranked ? "0 0 0 2px #0B0F1A" : undefined }}
          />
        ))}
        {you !== null && (
          <span
            className="absolute top-[12px] h-[15px] w-[15px] -translate-x-1/2 rounded-full border-[3px] border-floodlight bg-void"
            style={{ left: at(you) }}
          />
        )}
        {leader && (
          <span className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-muted-text" style={{ left: at(leader.value) }}>
            {leader.name}
          </span>
        )}
      </div>
    </>
  );
  return onOpen ? (
    <button type="button" onClick={onOpen} className="block w-full rounded-lg text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-turf">
      {body}
    </button>
  ) : <div>{body}</div>;
}

/** The whole booking as one bar: on-camera spans in turf, goals above, a mid-point tick. */
export function GameBar({ durationSeconds, spans, goals, midLabel, startLabel, endLabel, size = "md" }: {
  durationSeconds: number;
  spans: Array<[number, number]> | null;
  goals: Array<{ at: number; colour: string; mine: boolean; href?: string | null; label: string }>;
  midLabel: string;
  startLabel: string;
  endLabel: string;
  size?: "md" | "lg";
}) {
  const pct = (seconds: number) => `${Math.min(100, Math.max(0, (seconds / Math.max(1, durationSeconds)) * 100))}%`;
  const lg = size === "lg";
  return (
    <div dir="ltr" className={cn("relative", lg ? "h-[64px]" : "h-[46px]")}>
      {goals.map((goal, index) => {
        const dot = goal.mine ? (
          <span className={cn("block rounded-full border-floodlight bg-void", lg ? "h-[30px] w-[30px] border-[5px]" : "h-4 w-4 border-[3px]")} />
        ) : (
          <span className={cn("block rounded-full border-2", lg ? "h-[22px] w-[22px] border-[3px]" : "h-3 w-3")} style={{ background: goal.colour, borderColor: "#F2F4F8" }} />
        );
        const style = { left: pct(goal.at), top: goal.mine ? -2 : 0 };
        return goal.href ? (
          <Link key={index} href={goal.href} aria-label={goal.label} title={goal.label} className="absolute -translate-x-1/2" style={style}>{dot}</Link>
        ) : (
          <span key={index} aria-label={goal.label} title={goal.label} className="absolute -translate-x-1/2" style={style}>{dot}</span>
        );
      })}
      <div className={cn("absolute inset-x-0 rounded-full bg-[#232C42]", lg ? "top-[36px] h-4" : "top-[22px] h-2.5")} />
      {spans?.map(([a, b], index) => (
        <div
          key={index}
          className={cn("absolute bg-turf", lg ? "top-[36px] h-4" : "top-[22px] h-2.5", a <= 1 && "rounded-s-full", b >= durationSeconds - 1 && "rounded-e-full")}
          style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }}
        />
      ))}
      <div className={cn("absolute left-1/2 w-px bg-muted-text", lg ? "top-[30px] h-7" : "top-[18px] h-[18px]")} />
      <span className={cn("absolute left-0 font-mono font-semibold text-muted-text", lg ? "top-[56px] text-xl" : "top-[34px] text-[10px]")}>{startLabel}</span>
      <span className={cn("absolute left-1/2 -translate-x-1/2 font-mono font-semibold text-muted-text", lg ? "top-[56px] text-xl" : "top-[34px] text-[10px]")}>{midLabel}</span>
      <span className={cn("absolute right-0 font-mono font-semibold text-muted-text", lg ? "top-[56px] text-xl" : "top-[34px] text-[10px]")}>{endLabel}</span>
    </div>
  );
}

/** A small pitch drawn as a grid, each cell as bright as the share of time spent there. */
export function HeatGrid({ weights, columns, rows, colour, label }: {
  weights: number[] | null;
  columns: number;
  rows: number;
  colour: string;
  label: string;
}) {
  const max = weights ? Math.max(...weights, 1e-9) : 1;
  return (
    <figure className="flex flex-col gap-1.5">
      <div
        dir="ltr"
        className="grid aspect-[3/2] overflow-hidden rounded-lg border border-[#3A4560]"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
        role="img"
        aria-label={label}
      >
        {Array.from({ length: columns * rows }, (_, index) => {
          const weight = weights?.[index] ?? 0;
          return (
            <span
              key={index}
              className="border-[0.5px] border-[#1B2236]"
              style={{ background: colour, opacity: weights ? 0.06 + 0.94 * (weight / max) : 0.04 }}
            />
          );
        })}
      </div>
      <figcaption className="truncate text-xs font-semibold text-text">{label}</figcaption>
    </figure>
  );
}

/** A two-state pill toggle. */
export function PillToggle<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "min-h-8 rounded-full border px-3 font-display text-[13px] font-semibold",
            value === option.value ? "border-floodlight bg-floodlight/10 text-floodlight" : "border-line text-muted-text",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
