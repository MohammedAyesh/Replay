import { useEffect, useState } from "react";
import { useInstagramCopy } from "@/i18n/instagram-strings";
import { useAdminConsent, useSaveAdminConsent, type ConsentMode } from "@/lib/instagram-api";

/**
 * Admin → Field consoles → Instagram consent for one field. Only an admin changes it; every
 * change is logged (who, when, old and new) and shown here and in the field's console.
 */
export function AdminConsentPanel({ venueId }: { venueId: number }) {
  const copy = useInstagramCopy();
  const data = useAdminConsent(venueId);
  const save = useSaveAdminConsent(venueId);
  const [mode, setMode] = useState<ConsentMode>("off");
  const [wording, setWording] = useState("");
  useEffect(() => {
    if (data.data) { setMode(data.data.mode); setWording(data.data.wording ?? ""); }
  }, [data.data]);
  const fmt = (iso: string) => new Date(iso).toLocaleString(copy.locale === "ar" ? "ar-JO" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Amman" });
  if (data.isLoading) return <p className="text-xs text-zinc-500">…</p>;
  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300" dir={copy.locale === "ar" ? "rtl" : "ltr"} data-testid={`admin-ig-consent-${venueId}`}>
      <div>
        <p className="text-sm font-semibold text-white">{copy.admin.title}</p>
        <p className="mt-0.5 text-zinc-500">{copy.admin.help}</p>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-3">
        {(["ask", "owner", "off"] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={mode === m ? "rounded-lg border border-lime-300 bg-lime-300/10 p-2 text-start text-lime-200" : "rounded-lg border border-zinc-700 p-2 text-start text-zinc-300"}>
            <span className="block font-bold">{copy.admin.modes[m]}</span>
            <span className="mt-1 block text-[11px] leading-4 text-zinc-400">{copy.admin.modeHelp[m]}</span>
          </button>
        ))}
      </div>
      {mode === "owner" && (
        <label className="block">
          <span className="mb-1 block text-zinc-400">{copy.admin.wording}</span>
          <textarea value={wording} onChange={(e) => setWording(e.target.value)} rows={3} maxLength={4000} dir="auto" className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
        </label>
      )}
      <button type="button" disabled={save.isPending || (mode === "owner" && !wording.trim())} onClick={() => save.mutate({ mode, wording: mode === "owner" ? wording : null })} className="rounded-lg bg-lime-300 px-3 py-1.5 text-xs font-bold text-black disabled:opacity-40">{copy.admin.save}</button>
      {save.error && <p className="text-red-300">{save.error.message}</p>}
      {data.data?.since && <p className="text-zinc-500">{copy.consent.since(fmt(data.data.since))}</p>}
      {(data.data?.history.length ?? 0) > 0 && (
        <div>
          <p className="font-semibold text-zinc-400">{copy.admin.history}</p>
          <ul className="mt-1 space-y-0.5 text-zinc-500">
            {data.data!.history.map((h) => <li key={h.id}>{fmt(h.at)} · {copy.consent.change(h.oldMode ? copy.admin.modes[h.oldMode] : "—", copy.admin.modes[h.newMode])}{h.by ? ` · ${h.by}` : ""}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
