import { useEffect, useState, type ReactNode } from "react";
import { COLOR_TOKENS, resolveColor, type CreativeBrand } from "@workspace/api-zod";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** Small building blocks shared by the editor's panels (house style: the Studio section). */

export function Chip({ active, onClick, children, testId, title, className }: {
  active?: boolean; onClick: () => void; children: ReactNode; testId?: string; title?: string; className?: string;
}) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} title={title} aria-pressed={active}
      className={cn("inline-flex min-h-9 items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
        active ? "border-turf bg-turf text-void" : "border-line text-muted-text hover:text-text", className)}>
      {children}
    </button>
  );
}

export function IconButton({ label, onClick, children, disabled, active, testId, className }: {
  label: string; onClick: () => void; children: ReactNode; disabled?: boolean; active?: boolean; testId?: string; className?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} data-testid={testId} aria-pressed={active}
      className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line text-muted-text transition-colors hover:text-text disabled:opacity-40",
        active && "border-turf bg-turf/15 text-turf", className)}>
      {children}
    </button>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-text">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Row({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3">
      <Label htmlFor={htmlFor} className="text-sm text-text">{label}</Label>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function Toggle({ id, label, checked, onChange, testId }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <Row label={label} htmlFor={id}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </Row>
  );
}

/** A slider with its value beside it. Changes stream while dragging. */
export function NumberSlider({ label, value, min, max, step = 1, onChange, unit = "", testId }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; unit?: string; testId?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-text">{label}</span>
        <bdi className="font-mono text-xs text-muted-text">{Number.isInteger(step) ? Math.round(value) : value.toFixed(step < 0.1 ? 2 : 1)}{unit}</bdi>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v ?? value)} data-testid={testId}
        aria-label={label} className="py-2" />
    </div>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Brand tokens first (they follow the academy's colours), then any hex. */
export function ColorPicker({ value, brand, onChange, label, testId }: {
  value: string | undefined; brand: CreativeBrand; onChange: (v: string) => void; label: string; testId?: string;
}) {
  const copy = useCreativeEditorCopy();
  const resolved = resolveColor(value, brand, "#FFFFFF").slice(0, 7);
  const [hex, setHex] = useState(resolved);
  useEffect(() => setHex(resolved), [resolved]);
  const isToken = !!value && value.startsWith("@");
  return (
    <div className="space-y-2" data-testid={testId}>
      <span className="text-sm text-text">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {COLOR_TOKENS.map((t) => (
          <button key={t} type="button" onClick={() => onChange(t)} title={copy.tokens[t]} aria-label={copy.tokens[t]} aria-pressed={value === t}
            className={cn("flex min-h-9 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold",
              value === t ? "border-turf text-text" : "border-line text-muted-text")}>
            <span className="h-5 w-5 rounded-full border border-white/20" style={{ background: resolveColor(t, brand) }} />
            {copy.tokens[t]}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input type="color" value={HEX.test(resolved) ? resolved : "#ffffff"} onChange={(e) => onChange(e.target.value.toUpperCase())}
          aria-label={copy.hex} className="h-10 w-12 cursor-pointer rounded-lg border border-line bg-transparent p-1" />
        <input value={hex} onChange={(e) => { setHex(e.target.value); if (HEX.test(e.target.value)) onChange(e.target.value.toUpperCase()); }}
          aria-label={copy.hex} dir="ltr" spellCheck={false}
          className={cn("h-10 w-28 rounded-lg border bg-surface px-2 font-mono text-sm text-text", isToken ? "border-line opacity-70" : "border-turf/60")} />
      </div>
    </div>
  );
}

export const panelEmpty = "rounded-2xl border border-dashed border-line bg-surface p-4 text-center text-sm text-muted-text";
