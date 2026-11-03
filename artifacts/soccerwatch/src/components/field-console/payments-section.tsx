import { useEffect, useState } from "react";
import { CreditCard, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useVenueCopy } from "@/i18n/venue-strings";
import { cn } from "@/lib/utils";
import { jod, usePayments, useSaveCard, useSavePayments, type PaymentsData } from "@/lib/venue-api";
import { Card, ErrorText, SectionHeader, Skeleton, Stat, ToggleRow, filsFromJod, jodInput } from "./shared";

export function PaymentsSection({ venueId }: { venueId: number }) {
  const copy = useVenueCopy();
  const q = usePayments(venueId);
  if (q.isLoading) return <Skeleton rows={3} />;
  if (q.isError || !q.data) return <ErrorText error={q.error} />;
  return (
    <section className="space-y-6" data-testid="field-payments">
      <SectionHeader title={copy.payments.title} description={copy.payments.description} />
      <Ledger data={q.data} />
      <SettingsCard venueId={venueId} settings={q.data.settings} />
      {q.data.settings.moneyTo === "venue" && <CardGateway venueId={venueId} settings={q.data.settings} />}
    </section>
  );
}

function Ledger({ data }: { data: PaymentsData }) {
  const copy = useVenueCopy();
  const l = data.ledger;
  const viaReplay = data.settings.moneyTo === "replay" || l.viaReplayFils > 0;
  return (
    <div className="space-y-3">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted-text">{copy.payments.ledger}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label={copy.payments.collected} value={jod(l.collectedThisMonthFils, copy.locale)} tone="floodlight" />
        <Stat label={copy.payments.onlineCollected} value={jod(l.onlineThisMonthFils, copy.locale)} tone="violet" />
        <Stat label={copy.payments.unpaid} value={jod(l.unpaidAfterPlayFils, copy.locale)} tone={l.unpaidAfterPlayFils ? "live" : undefined} />
      </div>
      {viaReplay && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={copy.payments.viaReplay} value={jod(l.viaReplayFils, copy.locale)} />
          <Stat label={copy.payments.fee} value={jod(l.replayFeeFils, copy.locale)} hint={`${data.settings.replayFeeBps / 100}%`} />
          <Stat label={copy.payments.paidOut} value={jod(l.paidOutFils, copy.locale)} />
          <Stat label={copy.payments.owed} value={jod(l.owedByReplayFils, copy.locale)} tone="turf" />
        </div>
      )}
      {viaReplay && (
        <Card>
          <h3 className="font-display text-lg font-bold text-text">{copy.payments.payouts}</h3>
          {l.payouts.length === 0 ? <p className="mt-2 text-sm text-muted-text">{copy.payments.noPayouts}</p> : (
            <ul className="mt-3 divide-y divide-line text-sm">{l.payouts.map((p) => (
              <li key={p.id} className="flex justify-between gap-3 py-2"><span className="text-muted-text">{new Date(p.createdAt).toLocaleDateString(copy.locale === "ar" ? "ar-JO" : "en-GB")} · {p.method}{p.note ? ` · ${p.note}` : ""}</span><span className="font-bold tabular-nums">{jod(p.amountFils, copy.locale)}</span></li>
            ))}</ul>
          )}
        </Card>
      )}
    </div>
  );
}

function SettingsCard({ venueId, settings }: { venueId: number; settings: PaymentsData["settings"] }) {
  const copy = useVenueCopy();
  const save = useSavePayments(venueId);
  const [s, setS] = useState(settings);
  const [deposit, setDeposit] = useState(jodInput(settings.depositFils));
  const [saved, setSaved] = useState(false);
  useEffect(() => { setS(settings); setDeposit(jodInput(settings.depositFils)); }, [settings]);
  const submit = () => save.mutate({
    moneyTo: s.moneyTo, cliqAlias: s.cliqAlias || null, cliqName: s.cliqName || null, payAtField: s.payAtField, depositMode: s.depositMode,
    depositFils: filsFromJod(deposit) ?? 0, cancelHours: s.cancelHours, autoConfirmReceipts: s.autoConfirmReceipts,
  }, { onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); } });

  return (
    <Card className="space-y-5">
      <div>
        <h2 className="font-display text-2xl font-bold text-text">{copy.payments.whoTitle}</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {(["venue", "replay"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setS({ ...s, moneyTo: m })} className={cn("rounded-2xl border p-4 text-start", s.moneyTo === m ? "border-turf bg-turf/10" : "border-line bg-raised/40")} data-testid={`money-to-${m}`}>
              <span className="flex items-center gap-2 font-bold text-text"><Landmark className="h-4 w-4 text-turf" />{m === "venue" ? copy.payments.toVenue : copy.payments.toReplay}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-text">{m === "venue" ? copy.payments.toVenueHint : copy.payments.toReplayHint}</span>
            </button>
          ))}
        </div>
      </div>
      {s.moneyTo === "venue" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>{copy.payments.alias}</Label><Input value={s.cliqAlias ?? ""} onChange={(e) => setS({ ...s, cliqAlias: e.target.value.toUpperCase() })} dir="ltr" placeholder="GALAXYJO" /></div>
          <div className="space-y-1.5"><Label>{copy.payments.aliasName}</Label><Input value={s.cliqName ?? ""} onChange={(e) => setS({ ...s, cliqName: e.target.value })} dir="auto" /><p className="text-[11px] text-muted-text">{copy.payments.aliasNameHint}</p></div>
        </div>
      )}
      <div className="space-y-1.5">
        <Label>{copy.payments.online}</Label>
        <div className="grid gap-1.5 sm:grid-cols-3">
          {(["full", "deposit", "none"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setS({ ...s, depositMode: m })} className={cn("min-h-10 rounded-xl border px-3 text-sm font-semibold", s.depositMode === m ? "border-turf bg-turf/10 text-turf" : "border-line bg-raised text-muted-text")}>{copy.payments[m]}</button>
          ))}
        </div>
        {s.depositMode === "deposit" && <div className="max-w-xs pt-2"><Label>{copy.payments.depositAmount}</Label><Input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" /></div>}
      </div>
      <div className="divide-y divide-line">
        <ToggleRow label={copy.payments.atField}><Switch checked={s.payAtField} onCheckedChange={(v) => setS({ ...s, payAtField: v })} /></ToggleRow>
        {s.moneyTo === "venue" && <ToggleRow label={copy.payments.autoConfirm} hint={copy.payments.autoConfirmHint}><Switch checked={s.autoConfirmReceipts} onCheckedChange={(v) => setS({ ...s, autoConfirmReceipts: v })} /></ToggleRow>}
        <div className="flex items-center justify-between gap-4 py-3"><Label>{copy.payments.cancelHours}</Label><Input type="number" min={0} max={168} value={s.cancelHours} onChange={(e) => setS({ ...s, cancelHours: Number(e.target.value) })} className="w-24" /></div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={submit} disabled={save.isPending} className="bg-floodlight font-bold text-void" data-testid="button-save-payments">{copy.payments.save}</Button>
        {saved && <span className="text-xs font-semibold text-turf">{copy.payments.saved}</span>}
        <ErrorText error={save.error} />
      </div>
    </Card>
  );
}

function CardGateway({ venueId, settings }: { venueId: number; settings: PaymentsData["settings"] }) {
  const copy = useVenueCopy();
  const save = useSaveCard(venueId);
  const [profileId, setProfileId] = useState("");
  const [serverKey, setServerKey] = useState("");
  const [region, setRegion] = useState("jordan");
  const [enabled, setEnabled] = useState(settings.cardEnabled);
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 font-display text-xl font-bold text-text"><CreditCard className="h-5 w-5 text-turf" />{copy.payments.card}</h2>
        <p className="mt-1 text-sm text-muted-text">{copy.payments.cardHint}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5"><Label>{copy.payments.profileId}</Label><Input value={profileId} onChange={(e) => setProfileId(e.target.value)} inputMode="numeric" dir="ltr" /></div>
        <div className="space-y-1.5"><Label>{copy.payments.serverKey}</Label><Input type="password" value={serverKey} onChange={(e) => setServerKey(e.target.value)} placeholder={settings.cardConfigured ? copy.payments.serverKeySet : ""} dir="ltr" autoComplete="off" /></div>
        <div className="space-y-1.5"><Label>{copy.payments.region}</Label>
          <select value={region} onChange={(e) => setRegion(e.target.value)} className="min-h-10 w-full rounded-lg border border-input bg-raised px-3 text-sm">
            <option value="jordan">Jordan</option><option value="uae">UAE</option><option value="ksa">KSA</option><option value="global">Global</option>
          </select>
        </div>
      </div>
      <ToggleRow label={copy.payments.cardOn}><Switch checked={enabled} onCheckedChange={setEnabled} disabled={!settings.cardConfigured && !serverKey} /></ToggleRow>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => save.mutate({ provider: "paytabs", profileId: profileId || undefined, serverKey: serverKey || undefined, region, enabled }, { onSuccess: () => setServerKey("") })} disabled={save.isPending} className="bg-floodlight font-bold text-void">{copy.payments.save}</Button>
        {settings.cardConfigured && <Button type="button" variant="ghost" className="text-red-400" onClick={() => save.mutate(null)}>{copy.payments.removeCard}</Button>}
        <ErrorText error={save.error} />
      </div>
    </Card>
  );
}
