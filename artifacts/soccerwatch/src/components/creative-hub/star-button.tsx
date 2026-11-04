import { Star } from "lucide-react";
import { useFavoriteCopy } from "@/i18n/favorite-strings";
import { cn } from "@/lib/utils";

/** The favourite star: filled when starred. Sits over a card's corner or inline in a row. */
export function StarButton({ on, onToggle, className, testId, size = "md" }: { on: boolean; onToggle: () => void; className?: string; testId?: string; size?: "sm" | "md" }) {
  const copy = useFavoriteCopy();
  return (
    <button type="button" aria-pressed={on} aria-label={on ? copy.remove : copy.add} title={on ? copy.remove : copy.add}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggle(); }}
      className={cn("grid shrink-0 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turf",
        size === "sm" ? "h-7 w-7" : "h-9 w-9",
        on ? "bg-[#f5c518] text-void" : "bg-void/70 text-white hover:bg-void/90", className)}
      data-testid={testId}>
      <Star className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} fill={on ? "currentColor" : "none"} aria-hidden />
    </button>
  );
}
