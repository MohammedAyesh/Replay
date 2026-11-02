import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** A card on the Publish tab, in the console's look. */
export function PublishCard({ icon, title, children, testId, className }: { icon: ReactNode; title: string; children: ReactNode; testId: string; className?: string }) {
  return (
    <section className={cn("space-y-3 rounded-2xl border border-line bg-surface p-4", className)} data-testid={testId}>
      <h3 className="flex items-center gap-2 text-base font-bold text-text">{icon}{title}</h3>
      {children}
    </section>
  );
}

export function Chip({ active, onClick, children, disabled, testId }: { active: boolean; onClick: () => void; children: ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={active} data-testid={testId}
      className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition-colors disabled:opacity-40",
        active ? "bg-turf/15 text-turf" : "bg-raised text-muted-text hover:text-text")}>
      {children}
    </button>
  );
}

export function Notice({ tone = "muted", children }: { tone?: "muted" | "ok" | "error" | "warn"; children: ReactNode }) {
  return (
    <p role={tone === "error" ? "alert" : undefined} className={cn("rounded-xl px-3 py-2 text-sm",
      tone === "ok" ? "bg-turf/10 text-turf" : tone === "error" ? "bg-live/10 text-live" : tone === "warn" ? "bg-floodlight/10 text-floodlight" : "bg-raised text-muted-text")}>
      {children}
    </p>
  );
}

export function PrimaryButton({ pending, children, className, ...props }: React.ComponentProps<typeof Button> & { pending?: boolean }) {
  return (
    <Button type="button" {...props} disabled={props.disabled || pending} className={cn("min-h-11 rounded-xl bg-floodlight px-5 font-bold text-void hover:bg-floodlight/90", className)}>
      {pending && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}
      {children}
    </Button>
  );
}

export type ConfirmLine = { icon: ReactNode; text: string };

/**
 * The last step before anything leaves Replay: exactly where it goes, when,
 * and with what text. Nothing is sent until the owner taps the confirm button.
 */
export function ConfirmSheet({
  open, onOpenChange, title, lines, quoteLabel, quote, preview, confirmLabel, cancelLabel, pending, error, warning, onConfirm, dir, testId,
}: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; lines: ConfirmLine[];
  quoteLabel?: string; quote?: string; preview?: ReactNode; confirmLabel: string; cancelLabel: string;
  pending: boolean; error: string | null; warning?: string | null; onConfirm: () => void; dir: "rtl" | "ltr"; testId: string;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <SheetContent side="bottom" dir={dir} className="max-h-[90dvh] overflow-y-auto rounded-t-3xl border-line bg-surface text-text" data-testid={testId}>
        <SheetHeader className="text-start">
          <SheetTitle className="text-text">{title}</SheetTitle>
          <SheetDescription className="sr-only">{lines.map((l) => l.text).join(". ")}</SheetDescription>
        </SheetHeader>
        <div className="mx-auto mt-4 w-full max-w-lg space-y-4">
          <div className="flex gap-3">
            {preview && <div className="w-20 shrink-0 overflow-hidden rounded-xl bg-raised">{preview}</div>}
            <ul className="min-w-0 flex-1 space-y-2">
              {lines.map((l, i) => (
                <li key={i} className="flex items-start gap-2 text-sm font-semibold text-text" data-testid={`${testId}-line`}>
                  <span className="mt-0.5 shrink-0 text-turf">{l.icon}</span><span className="min-w-0 break-words" dir="auto">{l.text}</span>
                </li>
              ))}
            </ul>
          </div>
          {quoteLabel && (
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-text">{quoteLabel}</p>
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl bg-raised p-3 text-sm text-text" dir="auto">{quote}</p>
            </div>
          )}
          {warning && <Notice tone="warn">{warning}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-col-reverse gap-2 pb-[env(safe-area-inset-bottom)] sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" className="min-h-11 rounded-xl border border-line" disabled={pending} onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
            <PrimaryButton pending={pending} onClick={onConfirm} data-testid={`${testId}-confirm`}>{confirmLabel}</PrimaryButton>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Width of an element, kept up to date (for the scaled scene preview). */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
