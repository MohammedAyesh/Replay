import { useEffect, useState, type FormEvent } from "react";
import { Plus, Trash2, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useVenueCopy } from "@/i18n/venue-strings";
import { cn } from "@/lib/utils";
import { jod, useDeletePitch, usePitches, useSavePitch, useSaveRules, type OpeningHours, type Pitch, type PriceRule, type Rules } from "@/lib/venue-api";
import { Card, ErrorText, SectionHeader, Skeleton, ToggleRow, filsFromJod, jodInput } from "./shared";

export function PitchesSection({ venueId }: { venueId: number }) {
  const copy = useVenueCopy();
  const q = usePitches(venueId);
  const [editing, setEditing] = useState<Pitch | "new" | null>(null);
  if (q.isLoading) return <Skeleton rows={3} />;
  if (q.isError || !q.data) return <ErrorText error={q.error} />;
  const { pitches, fields, rules } = q.data;
  return (
    <section className="space-y-6" data-testid="field-pitches">
      <SectionHeader title={copy.pitches.title} description={copy.pitches.description}
        action={<Button type="button" onClick={() => setEditing("new")} className="min-h-11 rounded-xl bg-floodlight px-4 font-bold text-void" data-testid="button-add-pitch"><Plus className="me-2 h-4 w-4" />{copy.pitches.add}</Button>} />
      <div className="grid gap-3 sm:grid-cols-2">
        {pitches.map((p) => (
          <button key={p.id} type="button" onClick={() => setEditing(p)} className={cn("rounded-2xl border border-line bg-surface p-5 text-start hover:border-turf", !p.active && "opacity-60")} data-testid={`pitch-${p.id}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-xl font-bold text-text">{copy.locale === "ar" ? p.nameAr || p.name : p.name}</h2>
                <p className="mt-1 text-xs text-muted-text">{copy.pitches.sizes(p.size)}{p.surface ? ` · ${p.surface}` : ""}{p.indoor ? ` · ${copy.pitches.indoor}` : ""}</p>
              </div>
              {p.hasCamera && <span className="flex items-center gap-1 rounded-full bg-turf/10 px-2 py-1 text-[11px] font-bold text-turf"><Video className="h-3 w-3" />{p.recordBookings ? "REC" : ""}</span>}
            </div>
            <p className="mt-4 font-display text-2xl font-bold text-floodlight">{jod(p.pricePerHourFils, copy.locale)} <span className="text-sm font-normal text-muted-text">{copy.pitches.perHour}</span></p>
            {p.priceRules.map((r, i) => (
              <p key={i} className="mt-1 text-xs text-muted-text">{r.days.map((d) => copy.pitches.days[d]).join(", ")} {r.from}–{r.to}: {jod(r.pricePerHourFils, copy.locale)}</p>
            ))}
            {!p.active && <p className="mt-2 text-xs font-bold text-muted-text">{copy.pitches.archived}</p>}
          </button>
        ))}
      </div>
      <RulesCard venueId={venueId} rules={rules} />
      {editing && <PitchDialog venueId={venueId} pitch={editing === "new" ? null : editing} fields={fields} onClose={() => setEditing(null)} />}
    </section>
  );
}

function PitchDialog({ venueId, pitch, fields, onClose }: { venueId: number; pitch: Pitch | null; fields: Array<{ id: number; name: string; hasCamera: boolean }>; onClose: () => void }) {
  const copy = useVenueCopy();
  const save = useSavePitch(venueId);
  const remove = useDeletePitch(venueId);
  const [name, setName] = useState(pitch?.name ?? "");
  const [nameAr, setNameAr] = useState(pitch?.nameAr ?? "");
  const [size, setSize] = useState(pitch?.size ?? "5");
  const [surface, setSurface] = useState(pitch?.surface ?? "");
  const [indoor, setIndoor] = useState(pitch?.indoor ?? false);
  const [price, setPrice] = useState(jodInput(pitch?.pricePerHourFils ?? 20000));
  const [rules, setRules] = useState<PriceRule[]>(pitch?.priceRules ?? []);
  const [fieldId, setFieldId] = useState<number | null>(pitch?.fieldId ?? null);
  const [record, setRecord] = useState(pitch?.recordBookings ?? true);
  const [active, setActive] = useState(pitch?.active ?? true);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pricePerHourFils = filsFromJod(price) ?? 0;
    try {
      await save.mutateAsync({ id: pitch?.id, name, nameAr: nameAr || null, size, surface: surface || null, indoor, pricePerHourFils, priceRules: rules, fieldId, recordBookings: record, active });
      onClose();
    } catch {
      // shown below
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir={copy.locale === "ar" ? "rtl" : "ltr"} className="max-h-[92dvh] overflow-y-auto border-line bg-surface text-text sm:max-w-lg">
        <DialogHeader className="text-start"><DialogTitle>{pitch ? copy.pitches.edit : copy.pitches.add}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>{copy.pitches.name}</Label><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></div>
            <div className="space-y-1.5"><Label>{copy.pitches.nameAr}</Label><Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} maxLength={60} dir="rtl" /></div>
            <div className="space-y-1.5"><Label>{copy.pitches.size}</Label>
              <select value={size} onChange={(e) => setSize(e.target.value)} className="min-h-10 w-full rounded-lg border border-input bg-raised px-3 text-sm">
                {["5", "6", "7", "8", "9", "11"].map((s) => <option key={s} value={s}>{copy.pitches.sizes(s)}</option>)}
              </select>
            </div>
            <div className="space-y-1.5"><Label>{copy.pitches.surface}</Label><Input value={surface} onChange={(e) => setSurface(e.target.value)} placeholder={copy.pitches.surfacePlaceholder} /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label>{copy.pitches.price}</Label><Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" required /></div>
          </div>
          <ToggleRow label={copy.pitches.indoor}><Switch checked={indoor} onCheckedChange={setIndoor} /></ToggleRow>

          <div className="space-y-2">
            <Label>{copy.pitches.peak}</Label>
            {rules.map((r, i) => (
              <div key={i} className="space-y-2 rounded-xl border border-line p-3">
                <div className="flex flex-wrap gap-1">
                  {copy.pitches.days.map((d, idx) => (
                    <button key={idx} type="button" onClick={() => setRules(rules.map((x, j) => j === i ? { ...x, days: x.days.includes(idx) ? x.days.filter((y) => y !== idx) : [...x.days, idx].sort() } : x))}
                      className={cn("min-h-8 rounded-full px-2.5 text-xs font-semibold", r.days.includes(idx) ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{d}</button>
                  ))}
                </div>
                <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                  <div><Label className="text-[11px]">{copy.pitches.ruleFrom}</Label><Input type="time" value={r.from} onChange={(e) => setRules(rules.map((x, j) => j === i ? { ...x, from: e.target.value } : x))} /></div>
                  <div><Label className="text-[11px]">{copy.pitches.ruleTo}</Label><Input type="time" value={r.to === "24:00" ? "00:00" : r.to} onChange={(e) => setRules(rules.map((x, j) => j === i ? { ...x, to: e.target.value } : x))} /></div>
                  <div><Label className="text-[11px]">{copy.pitches.rulePrice}</Label><Input inputMode="decimal" value={jodInput(r.pricePerHourFils)} onChange={(e) => setRules(rules.map((x, j) => j === i ? { ...x, pricePerHourFils: filsFromJod(e.target.value) ?? 0 } : x))} /></div>
                  <Button type="button" variant="ghost" size="icon" onClick={() => setRules(rules.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setRules([...rules, { days: [4, 5], from: "18:00", to: "02:00", pricePerHourFils: (filsFromJod(price) ?? 20000) + 5000 }])}><Plus className="me-1 h-3.5 w-3.5" />{copy.pitches.addRule}</Button>
          </div>

          <div className="space-y-1.5">
            <Label>{copy.pitches.camera}</Label>
            <select value={fieldId ?? ""} onChange={(e) => setFieldId(e.target.value ? Number(e.target.value) : null)} className="min-h-10 w-full rounded-lg border border-input bg-raised px-3 text-sm">
              <option value="">{copy.pitches.noCamera}</option>
              {fields.map((f) => <option key={f.id} value={f.id}>{f.name}{f.hasCamera ? " 🎥" : ""}</option>)}
            </select>
          </div>
          {fieldId && fields.find((f) => f.id === fieldId)?.hasCamera && (
            <ToggleRow label={copy.pitches.record} hint={copy.pitches.recordHint}><Switch checked={record} onCheckedChange={setRecord} /></ToggleRow>
          )}
          <ToggleRow label={copy.pitches.active}><Switch checked={active} onCheckedChange={setActive} /></ToggleRow>
          <ErrorText error={save.error ?? remove.error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending} className="min-h-11 flex-1 bg-floodlight font-bold text-void">{copy.pitches.save}</Button>
            {pitch && <Button type="button" variant="ghost" className="text-red-400" onClick={() => remove.mutate(pitch.id, { onSuccess: onClose })}>{copy.pitches.delete}</Button>}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const DAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"] as const;
const LENGTH_OPTIONS = [60, 90, 120, 150, 180];

function RulesCard({ venueId, rules }: { venueId: number; rules: Rules }) {
  const copy = useVenueCopy();
  const save = useSaveRules(venueId);
  const [state, setState] = useState<Rules>(rules);
  const [saved, setSaved] = useState(false);
  useEffect(() => setState(rules), [rules]);
  const setDay = (d: (typeof DAY_KEYS)[number], value: OpeningHours[typeof d]) => setState({ ...state, openingHours: { ...state.openingHours, [d]: value } });
  const submit = () => save.mutate(state, { onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); } });

  return (
    <Card>
      <h2 className="font-display text-2xl font-bold text-text">{copy.pitches.rules}</h2>
      <ToggleRow label={copy.pitches.online} hint={copy.pitches.onlineHint}><Switch checked={state.bookingEnabled} onCheckedChange={(v) => setState({ ...state, bookingEnabled: v })} /></ToggleRow>
      <div className="mt-2 space-y-2">
        <div className="flex items-center justify-between"><Label>{copy.pitches.hours}</Label>
          <Button type="button" size="sm" variant="ghost" onClick={() => { const first = state.openingHours["0"] ?? { open: "16:00", close: "02:00" }; setState({ ...state, openingHours: Object.fromEntries(DAY_KEYS.map((d) => [d, first])) as OpeningHours }); }}>{copy.pitches.copyAll}</Button>
        </div>
        {DAY_KEYS.map((d) => {
          const h = state.openingHours[d];
          return (
            <div key={d} className="grid grid-cols-[4.5rem_auto_1fr_1fr] items-center gap-2">
              <span className="text-sm font-semibold text-text">{copy.pitches.days[Number(d)]}</span>
              <Switch checked={Boolean(h)} onCheckedChange={(on) => setDay(d, on ? { open: "16:00", close: "02:00" } : null)} />
              {h ? <>
                <Input type="time" value={h.open} onChange={(e) => setDay(d, { ...h, open: e.target.value })} />
                <Input type="time" value={h.close === "24:00" ? "00:00" : h.close} onChange={(e) => setDay(d, { ...h, close: e.target.value })} />
              </> : <span className="col-span-2 text-sm text-muted-text">{copy.pitches.closedDay}</span>}
            </div>
          );
        })}
        <p className="text-xs text-muted-text">{copy.pitches.pastMidnight}</p>
      </div>
      <div className="mt-5 space-y-1.5">
        <Label>{copy.pitches.durations}</Label>
        <div className="flex flex-wrap gap-1.5">
          {LENGTH_OPTIONS.map((m) => (
            <button key={m} type="button" onClick={() => setState({ ...state, durations: state.durations.includes(m) ? state.durations.filter((x) => x !== m) : [...state.durations, m].sort((a, b) => a - b) })}
              className={cn("min-h-9 rounded-full px-3.5 text-sm font-semibold", state.durations.includes(m) ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{copy.bookings.minutes(m)}</button>
          ))}
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>{copy.pitches.step}</Label>
          <select value={state.slotStepMinutes} onChange={(e) => setState({ ...state, slotStepMinutes: Number(e.target.value) })} className="min-h-10 w-full rounded-lg border border-input bg-raised px-3 text-sm">
            {[15, 30, 60].map((n) => <option key={n} value={n}>{n} min</option>)}
          </select>
        </div>
        <div className="space-y-1.5"><Label>{copy.pitches.notice}</Label><Input type="number" min={0} value={state.minNoticeMinutes} onChange={(e) => setState({ ...state, minNoticeMinutes: Number(e.target.value) })} /></div>
        <div className="space-y-1.5"><Label>{copy.pitches.horizon}</Label><Input type="number" min={1} max={90} value={state.maxDaysAhead} onChange={(e) => setState({ ...state, maxDaysAhead: Number(e.target.value) })} /></div>
        <div className="space-y-1.5"><Label>{copy.pitches.hold}</Label><Input type="number" min={5} value={state.holdMinutes} onChange={(e) => setState({ ...state, holdMinutes: Number(e.target.value) })} /></div>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Button type="button" onClick={submit} disabled={save.isPending || state.durations.length === 0} className="bg-floodlight font-bold text-void">{copy.pitches.saveRules}</Button>
        {saved && <span className="text-xs font-semibold text-turf">{copy.pitches.saved}</span>}
        <ErrorText error={save.error} />
      </div>
    </Card>
  );
}
