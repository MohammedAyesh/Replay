import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

type Lead = {
  id: number;
  name: string;
  place: string;
  phone: string;
  persona: "pitch" | "academy";
  locale: "ar" | "en";
  handled: boolean;
  createdAt: string;
};

/** Jordanian mobile numbers typed as 079… become 96279… for wa.me. */
function waDigits(phone: string): string {
  let digits = phone.replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^07\d{8}$/.test(digits)) digits = `962${digits.slice(1)}`;
  return digits;
}

/**
 * Call-me-back requests left on the public demo (/demo). Newest first; mark
 * one handled once someone has called.
 */
export default function DemoLeadsTab() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [ready, setReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHandled, setShowHandled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${basePath}/api/admin/demo-leads`, { credentials: "include" });
      if (!response.ok) throw new Error(`Could not load leads (${response.status})`);
      const body = await response.json() as { ready: boolean; leads: Lead[] };
      setReady(body.ready);
      setLeads(body.leads);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setHandled = async (lead: Lead, handled: boolean) => {
    setLeads((all) => all.map((item) => (item.id === lead.id ? { ...item, handled } : item)));
    const response = await fetch(`${basePath}/api/admin/demo-leads/${lead.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handled }),
    }).catch(() => null);
    if (!response?.ok) void load();
  };

  const visible = leads.filter((lead) => showHandled || !lead.handled);
  const open = leads.filter((lead) => !lead.handled).length;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text">Demo leads</h2>
          <p className="text-xs text-muted-text">Call-me-back requests from replayjo.com/demo · {open} open</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-text">
            <input type="checkbox" checked={showHandled} onChange={(e) => setShowHandled(e.target.checked)} />
            Show handled
          </label>
          <button type="button" onClick={() => void load()} className="min-h-10 rounded-lg border border-line px-3 text-xs font-semibold text-text">
            Refresh
          </button>
        </div>
      </div>

      {!ready && (
        <p className="rounded-lg border border-line bg-raised p-3 text-xs text-muted-text">
          The demo_leads table is not in this database yet, so the demo hides its callback form. Run the database update, then publish from the Replit website.
        </p>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
      {loading && leads.length === 0 && <p className="text-xs text-muted-text">Loading…</p>}
      {ready && !loading && visible.length === 0 && <p className="text-xs text-muted-text">No requests yet.</p>}

      <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {visible.map((lead) => (
          <div key={lead.id} className={cn("flex flex-wrap items-center gap-3 p-3", lead.handled && "opacity-60")}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text">{lead.name} · {lead.place}</p>
              <p className="text-xs text-muted-text">
                {lead.persona === "academy" ? "Academy" : "Pitch"} · {lead.locale.toUpperCase()} · {new Date(lead.createdAt).toLocaleString()}
              </p>
            </div>
            <a href={`tel:${lead.phone}`} className="font-mono text-sm text-turf" dir="ltr">{lead.phone}</a>
            <a href={`https://wa.me/${waDigits(lead.phone)}`} target="_blank" rel="noopener noreferrer" className="min-h-10 rounded-lg border border-line px-3 py-2 text-xs font-semibold text-text">
              WhatsApp
            </a>
            <button
              type="button"
              onClick={() => void setHandled(lead, !lead.handled)}
              className={cn("min-h-10 rounded-lg px-3 text-xs font-semibold", lead.handled ? "border border-line text-muted-text" : "bg-floodlight text-void")}
            >
              {lead.handled ? "Reopen" : "Mark handled"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
