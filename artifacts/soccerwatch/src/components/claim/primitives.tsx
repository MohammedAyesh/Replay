import React from "react";
import { cn } from "@/lib/utils";

/**
 * The claim flow's building blocks.
 *
 * Three rules are enforced here rather than left to each screen:
 *
 *   ONE FLOODLIGHT PER SCREEN. PrimaryAction is the only Floodlight surface in
 *   this file. Everything else is Violet (the secondary path), Turf (numbers,
 *   eyebrows, links) or Muted. Two primaries on one screen is two answers to
 *   "what do I do now".
 *
 *   NO PHYSICAL DIRECTIONS. Arabic is the default locale and the claim chain
 *   was written in left/right, which is why it has never been checked in RTL.
 *   Everything here is start/end, and chevrons flip with `rtl:rotate-180`.
 *
 *   NUMERALS STAY LTR AND TABULAR. A duration, a score or a percentage set in
 *   an RTL run reorders its digits; <Num> pins direction and tabular figures so
 *   "1:05" reads the same in both languages.
 */

export function ClaimScreen({
  children,
  footer,
  className,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-void">
      <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-4", className)}>
        {children}
      </div>
      {footer && (
        <div className="shrink-0 border-t border-line bg-surface/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md">
          {footer}
        </div>
      )}
    </div>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-display text-xs font-bold uppercase tracking-[0.12em] text-turf">
      {children}
    </p>
  );
}

export function ScreenTitle({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="mt-1.5 font-display text-2xl font-bold leading-tight text-text">{children}</h1>
  );
}

export function Lead({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-sm leading-6 text-muted-text">{children}</p>;
}

/** Numerals: left-to-right and tabular in both languages. */
export function Num({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span dir="ltr" className={cn("font-display tabular-nums", className)}>
      {children}
    </span>
  );
}

export function Panel({
  children,
  className,
  onClick,
  selected,
  disabled,
  as,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  selected?: boolean;
  disabled?: boolean;
  as?: "div" | "button";
} & Omit<React.HTMLAttributes<HTMLElement>, "onClick">) {
  const Tag = (as ?? (onClick ? "button" : "div")) as "div";
  return (
    <Tag
      {...(rest as Record<string, unknown>)}
      {...(onClick && !disabled ? { onClick, type: "button" } : {})}
      {...(disabled ? { disabled: true } : {})}
      className={cn(
        "w-full rounded-2xl border bg-surface text-start transition-colors",
        selected ? "border-turf" : "border-line",
        onClick && !disabled && "hover:border-muted-text",
        disabled && "opacity-55",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** The one Floodlight action on a screen. 48px, full width. */
export function PrimaryAction({
  children,
  onClick,
  disabled,
  type = "button",
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        // min-h, not h: "I can't see myself -- find me in the video" is two
        // lines at 390px in both languages, and a fixed height cropped it.
        "flex min-h-12 w-full items-center justify-center rounded-full bg-floodlight px-5 py-2 text-center font-display text-base font-bold leading-snug text-void transition-opacity",
        disabled ? "opacity-40" : "hover:opacity-90",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The secondary path. Violet, outlined, never Floodlight. */
export function SecondaryAction({
  children,
  onClick,
  disabled,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        // #7B5CFF is 4.3:1 on Void and fails AA as text, so violet TEXT is
        // #A98CFF; the border keeps the brand violet.
        "flex min-h-12 w-full items-center justify-center rounded-full border border-violet px-5 py-2 text-center text-sm font-semibold leading-snug text-[#A98CFF] transition-colors",
        disabled ? "opacity-40" : "hover:bg-violet/10",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A way out that must exist but must not compete: muted, text only. */
export function QuietAction({
  children,
  onClick,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-11 w-full items-center justify-center px-2 text-sm font-medium text-muted-text underline-offset-4 hover:text-text hover:underline",
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * The action on a row in a list of equals.
 *
 * Deliberately NOT Floodlight. A gallery of twelve people would otherwise
 * carry twelve primary actions, which is twelve answers to "what do I do
 * now"; the screen's action is choosing a row, and the rows are the choice.
 * Violet outline, compact, at the end of the row -- as drawn in the
 * wireframe (CL04).
 */
export function RowAction({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-violet px-5 py-2 text-center font-display text-base font-bold leading-snug text-[#A98CFF] transition-colors hover:bg-violet/10"
    >
      {children}
    </button>
  );
}

/** A link-weight action in Turf: the flow's "other way" lines. */
export function TextLink({
  children,
  onClick,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-11 w-full items-center justify-center px-2 text-center text-sm font-medium text-turf underline-offset-4 hover:underline",
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * The top of every step (CL03-CL06): back, "Step n of 4", the saved-as-you-go
 * chip, and the rail under them. Back is a chevron that flips in RTL.
 */
export function StepHeader({
  label,
  step,
  of,
  savedLabel,
  backLabel,
  onBack,
}: {
  label: string;
  step: number;
  of: number;
  savedLabel: string;
  backLabel: string;
  onBack?: () => void;
}) {
  return (
    <div className="-mx-4 -mt-4 mb-6 border-b border-line px-4 pb-3 pt-3">
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label={backLabel}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line text-text hover:border-muted-text"
          >
            <span aria-hidden="true" className="text-lg leading-none rtl:rotate-180">&#8249;</span>
          </button>
        )}
        <p className="min-w-0 flex-1 font-display text-xs font-bold uppercase tracking-[0.3em] text-turf">{label}</p>
        <span className="shrink-0 rounded-full bg-turf/10 px-2.5 py-1 font-display text-[11px] font-bold uppercase tracking-[0.06em] text-turf">
          {savedLabel}
        </span>
      </div>
      <div className="mt-3 flex gap-1.5" role="presentation">
        {Array.from({ length: of }, (_, index) => (
          <span key={index} className={cn("h-1 flex-1 rounded-full", index < step ? "bg-turf" : "bg-line")} />
        ))}
      </div>
    </div>
  );
}

/** 36px pill for counts and filters. */
export function Chip({
  children,
  tone = "muted",
  className,
}: {
  children: React.ReactNode;
  tone?: "muted" | "turf" | "violet";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold",
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

/** One crop from a sprite strip. */
export function CropTile({
  jpeg,
  alt,
  struck,
  className,
  onClick,
}: {
  jpeg: string;
  alt: string;
  struck?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  const image = (
    <img
      src={`data:image/jpeg;base64,${jpeg}`}
      alt={alt}
      loading="lazy"
      draggable={false}
      className={cn("h-full w-full object-cover transition-opacity", struck && "opacity-30")}
    />
  );
  const shell = cn(
    "relative aspect-[2/3] overflow-hidden rounded-xl border bg-raised",
    struck ? "border-line" : "border-line",
    className,
  );
  if (!onClick) return <div className={shell}>{image}</div>;
  return (
    <button type="button" onClick={onClick} className={shell} aria-pressed={struck}>
      {image}
      {struck && (
        <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
          <span className="h-px w-[130%] rotate-[-30deg] bg-muted-text" />
        </span>
      )}
    </button>
  );
}

/** A crop slot with nothing in it: never a blank hole, never a spinner. */
export function CropPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex aspect-[2/3] items-center justify-center rounded-xl border border-dashed border-line bg-raised px-1 text-center text-[10px] leading-3 text-muted-text">
      {label}
    </div>
  );
}

/**
 * Every empty, loading and failed branch on a claim screen renders through
 * this, so none of them can end up as a bare spinner.
 */
export function StateBlock({
  title,
  body,
  action,
  tone = "quiet",
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
  tone?: "quiet" | "busy" | "failed";
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-line bg-surface px-5 py-8 text-center">
      <span
        aria-hidden="true"
        className={cn(
          "mb-3 block h-1.5 w-10 rounded-full",
          tone === "busy" && "animate-pulse bg-turf",
          // Live red means a camera is broadcasting and nothing else -- a
          // failure is neutral (Foundations board).
          tone === "failed" && "bg-muted-text/60",
          tone === "quiet" && "bg-line",
        )}
      />
      <p className="font-display text-base font-bold text-text">{title}</p>
      {body && <p className="mt-1.5 max-w-[30ch] text-sm leading-6 text-muted-text">{body}</p>}
      {action && <div className="mt-4 w-full max-w-[260px]">{action}</div>}
    </div>
  );
}

/** The saved-as-you-go line. Never a progress bar pretending to be one. */
export function SavedNote({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-center text-xs text-muted-text">{children}</p>;
}

export function ProgressRail({ step, of }: { step: number; of: number }) {
  return (
    <div className="mt-4 flex gap-1.5" role="presentation">
      {Array.from({ length: of }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-1 flex-1 rounded-full",
            index < step ? "bg-turf" : "bg-line",
          )}
        />
      ))}
    </div>
  );
}
