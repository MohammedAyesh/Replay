import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div className="min-w-0">
        <h1 className="font-display text-3xl font-bold tracking-tight text-text sm:text-4xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{description}</p>}
      </div>
      {action}
    </header>
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return <section className={cn("rounded-2xl border border-line bg-surface p-5 sm:p-6", className)} {...rest}>{children}</section>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "turf" | "floodlight" | "violet" | "live" }) {
  const color = tone === "floodlight" ? "text-floodlight" : tone === "violet" ? "text-[#B9A8FF]" : tone === "live" ? "text-[#FF5A3C]" : "text-text";
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <p className="text-xs font-semibold text-muted-text">{label}</p>
      <p className={cn("mt-3 font-display text-3xl font-bold tabular-nums", color)}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-text">{hint}</p>}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  held: "border-amber-300/40 bg-amber-300/10 text-amber-200",
  confirmed: "border-turf/40 bg-turf/10 text-turf",
  completed: "border-line bg-raised text-muted-text",
  no_show: "border-[#FF5A3C]/40 bg-[#FF5A3C]/10 text-[#FF8A73]",
  cancelled: "border-line bg-raised text-muted-text line-through",
  unpaid: "border-line bg-raised text-muted-text",
  receipt: "border-[#7B5CFF]/50 bg-[#7B5CFF]/15 text-[#C9BCFF]",
  paid: "border-floodlight/40 bg-floodlight/10 text-floodlight",
  waived: "border-line bg-raised text-muted-text",
  refunded: "border-line bg-raised text-muted-text",
};

export function Pill({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold", STATUS_STYLES[kind] ?? "border-line bg-raised text-muted-text")}>{children}</span>;
}

export function Saved({ show, text }: { show: boolean; text: string }) {
  return show ? <span className="text-xs font-semibold text-turf" role="status">{text}</span> : null;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-sm text-red-400" role="alert">{error instanceof Error ? error.message : String(error)}</p>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-3">{Array.from({ length: rows }, (_, i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-raised" />)}</div>;
}

/** A labelled toggle row. */
export function ToggleRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-5 text-muted-text">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function filsFromJod(value: string): number | null {
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
}

export function jodInput(fils: number | null | undefined): string {
  if (fils == null) return "";
  return String(Number((fils / 1000).toFixed(3)));
}
