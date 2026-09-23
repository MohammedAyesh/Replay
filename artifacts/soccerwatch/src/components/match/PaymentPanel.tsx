import { Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useMatchCopy } from "@/i18n/match-strings";
import { formatJod } from "@/lib/match-api";

/** CliQ payment instructions: amount, alias, reference, three steps. */
export function PaymentPanel({ amountFils, cliqAlias, reference }: { amountFils: number; cliqAlias: string; reference: string }) {
  const copy = useMatchCopy();
  const b = copy.book;
  const { toast } = useToast();
  const copyText = (text: string) =>
    void navigator.clipboard.writeText(text).then(() => toast({ title: b.copied })).catch(() => undefined);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between rounded-2xl border border-line bg-raised px-4 py-3">
        <span className="text-sm text-muted-text">{b.payAmount}</span>
        <span className="font-mono text-3xl font-bold" dir="ltr">{formatJod(amountFils)} JOD</span>
      </div>
      <CopyRow label={b.payTo} value={cliqAlias} onCopy={copyText} />
      <CopyRow label={b.payRef} value={reference} onCopy={copyText} highlight />
      <ol className="flex flex-col gap-2 ps-1">
        {b.paySteps.map((step, i) => (
          <li key={i} className="flex items-start gap-3 text-sm">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet/20 font-mono text-xs font-bold text-violet">{i + 1}</span>
            <span className="pt-0.5">{step}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs leading-5 text-muted-text">{b.payAfter}</p>
    </div>
  );
}

function CopyRow({ label, value, onCopy, highlight }: { label: string; value: string; onCopy: (v: string) => void; highlight?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onCopy(value)}
      className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-start ${highlight ? "border-floodlight/50 bg-floodlight/5" : "border-line bg-raised"}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] text-muted-text">{label}</span>
        <span className="block truncate font-mono text-lg font-bold" dir="ltr">{value}</span>
      </span>
      <Copy className="h-4 w-4 shrink-0 text-muted-text" />
    </button>
  );
}
