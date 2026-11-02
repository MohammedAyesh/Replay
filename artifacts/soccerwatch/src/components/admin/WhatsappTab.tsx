import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageCircle, RefreshCw } from "lucide-react";
import { useAdminWhatsapp, useDisconnectWhatsapp } from "@/lib/academy-whatsapp-api";
import { WhatsappLinkDialog } from "@/components/academy-console/whatsapp-link-dialog";

/** Admin: the WAHA service on vps1, Replay's shared number, and each academy's WhatsApp. */
export default function WhatsappTab() {
  const qc = useQueryClient();
  const query = useAdminWhatsapp();
  const disconnect = useDisconnectWhatsapp("replay");
  const [linkOpen, setLinkOpen] = useState(false);
  const data = query.data;
  const replayLinked = data?.replay.status === "WORKING";

  return (
    <div className="space-y-5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-bold text-text">WhatsApp</h2>
        <button type="button" onClick={() => void query.refetch()} className="inline-flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-xs text-muted-text hover:text-text">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Refresh
        </button>
      </div>

      {query.isLoading ? <div className="h-32 animate-pulse rounded-2xl bg-raised" /> : !data ? (
        <p className="text-sm text-red-400">Could not load WhatsApp status{query.error ? `: ${(query.error as Error).message}` : "."}</p>
      ) : (
        <>
          <section className="rounded-2xl border border-line bg-surface p-4 text-sm">
            <p className="font-semibold text-text">Service (WAHA on vps1)</p>
            <p className={data.reachable ? "mt-1 text-turf" : "mt-1 text-red-400"}>
              {data.reachable
                ? `Reachable · ${String((data.version as { version?: unknown } | null)?.version ?? "")} ${String((data.version as { engine?: unknown } | null)?.engine ?? "")}`
                : `Not reachable${data.error ? ` — ${data.error}` : ""}`}
            </p>
            <p className="mt-1 text-xs text-muted-text">{data.sessions.length} WhatsApp session(s) on the server.</p>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-3">
              <MessageCircle className="h-5 w-5 text-turf" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-text">Replay's shared number</p>
                <p className="text-xs text-muted-text" dir="ltr">
                  {replayLinked ? [data.replay.name, data.replay.phone].filter(Boolean).join(" · ") : `Status: ${data.replay.status}`}
                </p>
                <p className="mt-1 text-xs text-muted-text">Academies that pick "Replay's number" send from this. Messages start with the academy's name.</p>
              </div>
              <button type="button" disabled={!data.reachable} onClick={() => setLinkOpen(true)} className="rounded-lg bg-floodlight px-3 py-2 text-xs font-bold text-void disabled:opacity-50">
                {replayLinked ? "Link again" : "Link number"}
              </button>
              {replayLinked && (
                <button type="button" disabled={disconnect.isPending} onClick={() => { if (window.confirm("Unlink Replay's number? Academies using it stop sending.")) disconnect.mutate(); }} className="rounded-lg bg-raised px-3 py-2 text-xs font-semibold text-red-400">
                  Unlink
                </button>
              )}
            </div>
          </section>

          <section className="overflow-x-auto rounded-2xl border border-line bg-surface">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-text">
                <tr className="border-b border-line text-start">
                  <th className="p-3 text-start">Academy</th><th className="p-3 text-start">Sends from</th><th className="p-3 text-start">Own number</th>
                  <th className="p-3 text-end">Sent 7d</th><th className="p-3 text-end">Failed 7d</th><th className="p-3 text-end">Waiting</th>
                </tr>
              </thead>
              <tbody>
                {data.academies.length === 0 ? (
                  <tr><td colSpan={6} className="p-4 text-center text-muted-text">No academy has opened WhatsApp yet.</td></tr>
                ) : data.academies.map((a) => (
                  <tr key={a.academyId} className="border-b border-line last:border-0">
                    <td className="p-3" dir="auto">{a.name}</td>
                    <td className="p-3">{a.sender === "own" ? "Own number" : a.sender === "replay" ? "Replay's number" : "Off"}</td>
                    <td className="p-3 text-xs text-muted-text" dir="ltr">{a.sessionStatus === "WORKING" ? a.connectedPhone : (a.sessionStatus ?? "—")}</td>
                    <td className="p-3 text-end tabular-nums">{a.sent7d}</td>
                    <td className={`p-3 text-end tabular-nums ${a.failed7d > 0 ? "text-red-400" : ""}`}>{a.failed7d}</td>
                    <td className="p-3 text-end tabular-nums">{a.queued}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      <WhatsappLinkDialog
        target="replay"
        open={linkOpen}
        onOpenChange={(open) => { setLinkOpen(open); if (!open) void qc.invalidateQueries({ queryKey: ["admin-whatsapp"] }); }}
        title="Link Replay's WhatsApp number"
      />
    </div>
  );
}
