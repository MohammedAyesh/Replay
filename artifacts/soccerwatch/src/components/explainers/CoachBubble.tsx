import type { CSSProperties, ReactNode } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * A one-time pointer: a Floodlight bubble with an arrow towards the control it
 * explains. The caller positions it (absolute, inside the screen it explains)
 * and decides when it goes away: on "Got it", or when the player does the
 * thing the bubble points at.
 */
export function CoachBubble({
  children,
  step,
  actionLabel,
  onAction,
  arrow = "down",
  arrowOffset = "50%",
  className,
  style,
  testId,
}: {
  children: ReactNode;
  /** "1 of 2" style counter, already translated. */
  step?: string;
  actionLabel: string;
  onAction: () => void;
  arrow?: "up" | "down" | "none";
  /** Where along the bubble's edge the arrow sits (CSS length, logical start). */
  arrowOffset?: string;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <motion.div
      role="note"
      aria-live="polite"
      data-testid={testId}
      initial={{ opacity: 0, y: arrow === "up" ? -6 : 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "pointer-events-auto absolute z-[70] rounded-2xl bg-primary px-4 py-3 text-primary-foreground shadow-[0_12px_32px_rgba(0,0,0,0.55)]",
        className,
      )}
      style={style}
    >
      {arrow !== "none" && (
        <span
          aria-hidden="true"
          className={cn("absolute h-3 w-3 rotate-45 bg-primary", arrow === "down" ? "-bottom-1.5" : "-top-1.5")}
          style={{ insetInlineStart: `calc(${arrowOffset} - 6px)` }}
        />
      )}
      <p className="text-[13px] font-medium leading-snug">{children}</p>
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] opacity-70">{step}</span>
        <button
          type="button"
          onClick={onAction}
          className="-me-2 min-h-9 rounded-full px-3 text-[13px] font-bold underline-offset-2 hover:underline"
        >
          {actionLabel}
        </button>
      </div>
    </motion.div>
  );
}
