import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  apiUrl,
  formatMoney,
  useAdminTemplates,
  useAdminWalletAction,
  useAdminWallets,
  useDeleteTemplate,
  useSaveTemplate,
  type AdminAdRequest,
  type AdTemplate,
  type TemplateBody,
} from "@/lib/meta-ads-api";

const jod = (n: number | null | undefined) => formatMoney(n, "JOD", "en");

/** The ad's photos/videos as the admin reviews it (carousel cards in order). */
export function ApprovalMedia({ request }: { request: AdminAdRequest }) {
  if (!request.cards.length) {
    return request.imageData ? <img src={request.imageData} alt="" className="aspect-square w-full rounded-lg object-cover" /> : <div className="aspect-square rounded-lg bg-raised" />;
  }
  return (
    <div className="space-y-1">
      {request.cards.length > 1 && <p className="text-[11px] font-bold text-turf">Carousel · {request.cards.length} cards</p>}
      <div className="flex gap-1 overflow-x-auto">
        {request.cards.map((c) => (
          <a key={c.mediaId} href={apiUrl(`/api/admin/meta-ads/media/${c.mediaId}/file`)} target="_blank" rel="noreferrer" className="w-36 shrink-0" title={c.headline ?? ""}>
            <img src={apiUrl(`/api/admin/meta-ads/media/${c.mediaId}/thumb`)} alt="" className="aspect-square w-full rounded-lg object-cover" />
            {c.headline && <p className="truncate text-[11px] text-muted-text" dir="auto">{c.headline}</p>}
          </a>
        ))}
      </div>
    </div>
  );
}

/** Prepaid ad wallets: confirm CliQ top-ups, see balances and what Replay earned. */
export function AdminWallets() {
  const query = useAdminWallets();
  const act = useAdminWalletAction();
  const [received, setReceived] = useState<Record<number, string>>({});
  const [adjust, setAdjust] = useState<{ academyId: number | null; amount: string; note: string }>({ academyId: null, amount: "", note: "" });
  const data = query.data;
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 text-sm" data-testid="admin-ad-wallets">
      <p className="font-semibold text-text">Ad wallets {data && data.pending.length > 0 && <span className="ms-1 rounded-full bg-amber-300/15 px-2 text-amber-200">{data.pending.length}</span>}</p>
      <p className="mt-0.5 text-xs text-muted-text">
        Academies prepay ads on Replay's account. Spend is charged at Meta's figure × {data ? (data.jodPerUsd).toFixed(3) : "0.709"} JOD/USD × {data ? (1 + data.margin).toFixed(2) : "1.07"}.
        Owners only ever see the charged amount.
      </p>
      {query.isError && <p className="mt-2 text-xs text-red-400">{(query.error as Error).message}</p>}
      {data && (
        <>
          {data.pending.length > 0 && (
            <ul className="mt-3 space-y-2">
              {data.pending.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-floodlight/40 p-2 text-xs">
                  <span className="font-semibold text-text">{p.academyName}</span>
                  <span className="text-text">{jod(p.amount)}</span>
                  <code className="rounded bg-raised px-1.5 py-0.5 text-text">{p.reference}</code>
                  <span className="text-muted-text">{p.createdAt ? new Date(p.createdAt).toLocaleString() : ""}</span>
                  <input value={received[p.id!] ?? ""} onChange={(e) => setReceived({ ...received, [p.id!]: e.target.value })} placeholder={`Received (${p.amount})`}
                    className="ms-auto h-8 w-28 rounded-lg border border-input bg-raised px-2 text-text" inputMode="decimal" />
                  <button type="button" disabled={act.isPending} className="rounded-lg bg-turf px-3 py-1.5 font-bold text-void"
                    onClick={() => act.mutate({ kind: "confirm", id: p.id!, ...(received[p.id!] ? { amount: Number(received[p.id!]) } : {}) })}>Confirm received</button>
                  <button type="button" disabled={act.isPending} className="rounded-lg bg-raised px-3 py-1.5 text-red-400"
                    onClick={() => act.mutate({ kind: "reject", id: p.id!, reason: "Transfer not received" })}>Not received</button>
                </li>
              ))}
            </ul>
          )}
          {data.wallets.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-text"><tr className="text-start">
                  <th className="py-1 text-start font-medium">Academy</th><th className="text-end font-medium">Balance</th><th className="text-end font-medium">Topped up</th>
                  <th className="text-end font-medium">Charged</th><th className="text-end font-medium">Meta cost</th><th className="text-end font-medium">Replay earned</th><th />
                </tr></thead>
                <tbody className="divide-y divide-line">
                  {data.wallets.map((w) => (
                    <tr key={w.academyId}>
                      <td className="py-1.5 text-text">{w.academyName}</td>
                      <td className="text-end font-bold tabular-nums text-text">{jod(w.balance)}</td>
                      <td className="text-end tabular-nums text-muted-text">{jod(w.toppedUp)}</td>
                      <td className="text-end tabular-nums text-muted-text">{jod(w.charged)}</td>
                      <td className="text-end tabular-nums text-muted-text">{jod(w.metaCost)}</td>
                      <td className="text-end tabular-nums text-turf">{jod(w.earned)}</td>
                      <td className="text-end"><button type="button" className="text-muted-text hover:text-text" onClick={() => setAdjust({ academyId: w.academyId, amount: "", note: "" })}>Adjust</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form className="mt-3 flex flex-wrap items-center gap-2 text-xs" onSubmit={(e) => {
            e.preventDefault();
            if (!adjust.academyId || !Number(adjust.amount) || !adjust.note.trim()) return;
            act.mutate({ kind: "adjust", academyId: adjust.academyId, amount: Number(adjust.amount), note: adjust.note.trim() }, { onSuccess: () => setAdjust({ academyId: null, amount: "", note: "" }) });
          }}>
            <span className="text-muted-text">Credit or debit an academy (cash, refund, free credit):</span>
            <input value={adjust.academyId ?? ""} onChange={(e) => setAdjust({ ...adjust, academyId: Number(e.target.value) || null })} placeholder="Academy id" className="h-8 w-24 rounded-lg border border-input bg-raised px-2 text-text" />
            <input value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })} placeholder="JOD (− to debit)" className="h-8 w-32 rounded-lg border border-input bg-raised px-2 text-text" />
            <input value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} placeholder="Note" className="h-8 min-w-40 flex-1 rounded-lg border border-input bg-raised px-2 text-text" />
            <button type="submit" disabled={act.isPending} className="rounded-lg bg-floodlight px-3 py-1.5 font-bold text-void">Save</button>
          </form>
          {act.isError && <p className="mt-2 text-xs text-red-400">{(act.error as Error).message}</p>}
        </>
      )}
    </section>
  );
}

const EMPTY: TemplateBody = {
  title: "", titleAr: "", description: "", descriptionAr: "", goal: "whatsapp",
  variants: [{ locale: "ar", headline: "", primaryText: "" }], questions: [], dailyBudget: 5, days: 14, ageMin: 25, ageMax: 50, radiusKm: 10, imageData: null, isActive: true, sortOrder: 0,
};

/** Ready-made campaigns owners can start from. "{academy}" becomes the academy's name. */
export function AdminAdTemplates() {
  const query = useAdminTemplates();
  const save = useSaveTemplate();
  const remove = useDeleteTemplate();
  const [editing, setEditing] = useState<{ id: number | null; body: TemplateBody } | null>(null);
  const field = "h-8 w-full rounded-lg border border-input bg-raised px-2 text-xs text-text";
  const start = (t: AdTemplate | null) => setEditing(t ? { id: t.id, body: { ...EMPTY, ...t } } : { id: null, body: { ...EMPTY } });
  const b = editing?.body;
  const set = (patch: Partial<TemplateBody>) => setEditing((e) => (e ? { ...e, body: { ...e.body, ...patch } } : e));
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 text-sm" data-testid="admin-ad-templates">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-text">Ready-made campaigns</p>
        <button type="button" onClick={() => start(null)} className="inline-flex items-center gap-1 rounded-lg bg-raised px-3 py-1.5 text-xs text-text"><Plus className="h-3.5 w-3.5" aria-hidden="true" />New</button>
      </div>
      <p className="mt-0.5 text-xs text-muted-text">Owners pick one in the ad builder and everything starts filled in. Write {"{academy}"} where the academy's name goes.</p>
      <ul className="mt-2 divide-y divide-line text-xs">
        {(query.data ?? []).map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="font-semibold text-text">{t.title}</span>
            {t.titleAr && <span className="text-muted-text" dir="rtl">{t.titleAr}</span>}
            <span className="text-muted-text">{t.goal === "whatsapp" ? "WhatsApp" : "Form"} · {jod(t.dailyBudget)}/day · {t.days} days · {t.variants.length} text(s)</span>
            {!t.isActive && <span className="text-amber-200">hidden</span>}
            <button type="button" className="ms-auto text-muted-text hover:text-text" onClick={() => start(t)}>Edit</button>
            <button type="button" className="text-red-400" aria-label="Delete" onClick={() => remove.mutate(t.id)}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
          </li>
        ))}
      </ul>
      {editing && b && (
        <form className="mt-3 space-y-2 rounded-xl border border-line p-3 text-xs" onSubmit={(e) => { e.preventDefault(); save.mutate({ id: editing.id, body: b }, { onSuccess: () => setEditing(null) }); }}>
          <div className="grid gap-2 md:grid-cols-2">
            <input className={field} placeholder="Title (English)" value={b.title} onChange={(e) => set({ title: e.target.value })} />
            <input className={field} dir="rtl" placeholder="العنوان بالعربي" value={b.titleAr ?? ""} onChange={(e) => set({ titleAr: e.target.value })} />
            <input className={field} placeholder="Description (English)" value={b.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
            <input className={field} dir="rtl" placeholder="الوصف بالعربي" value={b.descriptionAr ?? ""} onChange={(e) => set({ descriptionAr: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
            <select className={field} value={b.goal} onChange={(e) => set({ goal: e.target.value as TemplateBody["goal"] })}><option value="whatsapp">WhatsApp</option><option value="lead_form">Sign-up form</option></select>
            <label className="text-muted-text">JOD/day<input className={field} type="number" step={0.5} value={b.dailyBudget} onChange={(e) => set({ dailyBudget: Number(e.target.value) })} /></label>
            <label className="text-muted-text">Days<input className={field} type="number" value={b.days} onChange={(e) => set({ days: Number(e.target.value) })} /></label>
            <label className="text-muted-text">km<input className={field} type="number" value={b.radiusKm} onChange={(e) => set({ radiusKm: Number(e.target.value) })} /></label>
            <label className="text-muted-text">Age from<input className={field} type="number" value={b.ageMin} onChange={(e) => set({ ageMin: Number(e.target.value) })} /></label>
            <label className="text-muted-text">to<input className={field} type="number" value={b.ageMax} onChange={(e) => set({ ageMax: Number(e.target.value) })} /></label>
          </div>
          {b.variants.map((v, i) => (
            <div key={i} className="grid gap-2 rounded-lg bg-raised/50 p-2 md:grid-cols-[80px_1fr_2fr_auto]">
              <select className={field} value={v.locale} onChange={(e) => set({ variants: b.variants.map((x, j) => (j === i ? { ...x, locale: e.target.value as "ar" | "en" } : x)) })}><option value="ar">AR</option><option value="en">EN</option></select>
              <input className={field} dir="auto" maxLength={40} placeholder="Headline" value={v.headline} onChange={(e) => set({ variants: b.variants.map((x, j) => (j === i ? { ...x, headline: e.target.value } : x)) })} />
              <textarea className="min-h-16 w-full rounded-lg border border-input bg-raised px-2 py-1 text-xs text-text" dir="auto" maxLength={600} placeholder="Text" value={v.primaryText}
                onChange={(e) => set({ variants: b.variants.map((x, j) => (j === i ? { ...x, primaryText: e.target.value } : x)) })} />
              <button type="button" className="text-red-400" disabled={b.variants.length < 2} onClick={() => set({ variants: b.variants.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
            </div>
          ))}
          {b.variants.length < 6 && <button type="button" className="text-muted-text" onClick={() => set({ variants: [...b.variants, { locale: "ar", headline: "", primaryText: "" }] })}>+ text version</button>}
          {b.goal === "lead_form" && <TemplateQuestions key={editing.id ?? "new"} questions={b.questions ?? []} onChange={(questions) => set({ questions })} field={field} />}
          <label className="flex items-center gap-2 text-muted-text"><input type="checkbox" checked={b.isActive !== false} onChange={(e) => set({ isActive: e.target.checked })} />Shown to owners</label>
          <div className="flex gap-2">
            <button type="submit" disabled={save.isPending} className="rounded-lg bg-turf px-3 py-1.5 font-bold text-void">Save</button>
            <button type="button" onClick={() => setEditing(null)} className="rounded-lg bg-raised px-3 py-1.5 text-text">Cancel</button>
          </div>
          {save.isError && <p className="text-red-400">{(save.error as Error).message}</p>}
        </form>
      )}
    </section>
  );
}

let templateQuestionId = 0;

/** Rows with their own ids and raw choices text, so removing one never moves another's choices. */
function TemplateQuestions({ questions, onChange, field }: { questions: Array<{ label: string; options?: string[] }>; onChange: (q: Array<{ label: string; options?: string[] }>) => void; field: string }) {
  const [rows, setRows] = useState(() => questions.map((q) => ({ id: ++templateQuestionId, label: q.label, optionsText: (q.options ?? []).join(", ") })));
  const split = (raw: string) => raw.split(/[,،]/).map((x) => x.trim()).filter(Boolean).slice(0, 10);
  const update = (next: typeof rows) => {
    setRows(next);
    onChange(next.map((r) => ({ label: r.label, ...(split(r.optionsText).length ? { options: split(r.optionsText) } : {}) })));
  };
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.id} className="flex gap-2">
          <input className={field} dir="auto" placeholder="Question" value={r.label} onChange={(e) => update(rows.map((x) => (x.id === r.id ? { ...x, label: e.target.value } : x)))} />
          <input className={field} dir="auto" placeholder="Choices, comma-separated" value={r.optionsText} onChange={(e) => update(rows.map((x) => (x.id === r.id ? { ...x, optionsText: e.target.value } : x)))} />
          <button type="button" className="text-red-400" onClick={() => update(rows.filter((x) => x.id !== r.id))}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
        </div>
      ))}
      {rows.length < 5 && <button type="button" className="text-muted-text" onClick={() => update([...rows, { id: ++templateQuestionId, label: "", optionsText: "" }])}>+ question</button>}
    </div>
  );
}
