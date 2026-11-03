import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { jod, useAdminVenueMutations, useAdminVenuePayments, useAdminVenues, venueCall } from "@/lib/venue-api";

/**
 * Admin → Field consoles: open one for a field (its owner then runs bookings, WhatsApp,
 * payments and the website), set Replay's fee on bookings paid to Replay, confirm those
 * CliQ payments, and record payouts to fields.
 */
export function FieldConsolesTab() {
  const venues = useAdminVenues();
  const payments = useAdminVenuePayments();
  const m = useAdminVenueMutations();
  const fields = useQuery({ queryKey: ["admin-venues", "fields"], queryFn: () => venueCall<Array<{ id: number; name: string; cameraId?: string | null }>>("/fields") });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [payout, setPayout] = useState<Record<number, string>>({});

  const create = (e: FormEvent) => {
    e.preventDefault();
    m.create.mutate({ name, ownerEmail: email, fieldIds: picked }, { onSuccess: () => { setName(""); setEmail(""); setPicked([]); } });
  };
  const fieldList = Array.isArray(fields.data) ? fields.data : [];

  return (
    <div className="space-y-5 p-4" data-testid="admin-field-consoles">
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-sm font-semibold text-white">CliQ payments to Replay waiting for you</h2>
        {payments.isLoading ? <p className="mt-2 text-xs text-zinc-500">Loading…</p> : (payments.data?.bookings.length ?? 0) === 0 ? <p className="mt-2 text-xs text-zinc-500">Nothing waiting.</p> : (
          <div className="mt-3 space-y-2">
            {payments.data!.bookings.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-sm">
                <span className="font-mono font-bold text-white">{b.reference}</span>
                <span className="text-zinc-300">{b.venueName} · {b.startLocal}</span>
                <span className="text-zinc-400">{b.customerName} · +{b.customerPhone}</span>
                <span className="font-bold text-white">{jod(b.dueOnlineFils, "en")}</span>
                <span className={b.paymentStatus === "receipt" ? "rounded-full bg-violet-500/20 px-2 text-xs text-violet-200" : "rounded-full bg-zinc-800 px-2 text-xs text-zinc-400"}>{b.paymentStatus === "receipt" ? "receipt sent" : "no receipt yet"}</span>
                {b.receiptUrl && <a href={b.receiptUrl} target="_blank" rel="noreferrer" className="text-xs text-sky-300 underline">receipt</a>}
                {b.receiptCheck && <span className="text-xs text-zinc-400">read: {b.receiptCheck.amountFils != null ? jod(b.receiptCheck.amountFils, "en") : "?"} to {b.receiptCheck.receiver ?? "?"}{b.receiptCheck.referenceOk ? " · code ✓" : ""}</span>}
                <span className="ms-auto flex gap-2">
                  <button type="button" onClick={() => m.payment.mutate({ id: b.id, action: "confirm" })} className="rounded-lg bg-lime-300 px-3 py-1.5 text-xs font-bold text-black">Received</button>
                  <button type="button" onClick={() => m.payment.mutate({ id: b.id, action: "reject" })} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300">Not received</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-sm font-semibold text-white">Field consoles</h2>
        {venues.isLoading ? <p className="mt-2 text-xs text-zinc-500">Loading…</p> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead className="text-zinc-500"><tr><th className="p-2 text-left">Field</th><th className="p-2 text-left">Owners</th><th className="p-2 text-left">Money</th><th className="p-2 text-left">Agent</th><th className="p-2 text-left">Domain</th><th className="p-2 text-left">Bookings</th><th className="p-2 text-left">Paid to Replay</th><th className="p-2 text-left">Fee %</th><th className="p-2 text-left">Owed</th><th className="p-2" /></tr></thead>
              <tbody className="divide-y divide-zinc-800 text-zinc-300">
                {(venues.data?.venues ?? []).map((v) => (
                  <tr key={v.id}>
                    <td className="p-2"><a href={`/v/${v.slug}`} target="_blank" rel="noreferrer" className="font-semibold text-white underline">{v.name}</a></td>
                    <td className="p-2">{v.owners.map((o) => o.email).join(", ")}</td>
                    <td className="p-2">{v.moneyTo}</td>
                    <td className="p-2">{v.agentMode}</td>
                    <td className="p-2">{v.customDomain ? `${v.customDomain} (${v.domainStatus})` : "—"}</td>
                    <td className="p-2">{v.bookings}{v.toConfirm ? ` · ${v.toConfirm} to confirm` : ""}</td>
                    <td className="p-2">{jod(v.viaReplayFils, "en")}</td>
                    <td className="p-2">
                      <input type="number" min={0} max={50} step={0.5} defaultValue={v.replayFeeBps / 100} onBlur={(e) => m.fee.mutate({ id: v.id, replayFeeBps: Math.round(Number(e.target.value) * 100) })} className="w-16 rounded border border-zinc-700 bg-zinc-950 px-2 py-1" />
                    </td>
                    <td className="p-2 font-bold text-white">{jod(v.owedFils, "en")}</td>
                    <td className="p-2">
                      <div className="flex gap-1">
                        <input placeholder="JOD" value={payout[v.id] ?? ""} onChange={(e) => setPayout({ ...payout, [v.id]: e.target.value })} className="w-16 rounded border border-zinc-700 bg-zinc-950 px-2 py-1" />
                        <button type="button" disabled={!Number(payout[v.id])} onClick={() => m.payout.mutate({ id: v.id, amountFils: Math.round(Number(payout[v.id]) * 1000) }, { onSuccess: () => setPayout({ ...payout, [v.id]: "" }) })} className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40">Paid out</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-sm font-semibold text-white">Open a field console</h2>
        <p className="mt-1 text-xs text-zinc-500">The owner needs a Replay account. They also become the owner of the fields' footage (Owner console). Field owners can also open one themselves from /field.</p>
        <form onSubmit={create} className="mt-3 space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Business name (e.g. Jordan Galaxy)" required className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Owner's email" type="email" required className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
          <div className="flex flex-wrap gap-1.5">
            {fieldList.map((f) => (
              <button key={f.id} type="button" onClick={() => setPicked(picked.includes(f.id) ? picked.filter((x) => x !== f.id) : [...picked, f.id])}
                className={picked.includes(f.id) ? "rounded-full bg-lime-300 px-3 py-1 text-xs font-bold text-black" : "rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300"}>{f.name}</button>
            ))}
          </div>
          <button type="submit" disabled={!picked.length || m.create.isPending} className="rounded-lg bg-lime-300 px-4 py-2 text-sm font-bold text-black disabled:opacity-40">Open console</button>
          {m.create.error && <p className="text-xs text-red-300">{m.create.error.message}</p>}
        </form>
      </section>
    </div>
  );
}
