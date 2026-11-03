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
      <SettingsCard venueId={venueId} settings={q.data.settings} preview={q.data.preview} />
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
      {(l.refundsToSendFils > 0 || l.feesOwedFils > 0) && (
        <div className="grid grid-cols-2 gap-3">
          <Stat label={copy.payments.refundsToSend} value={jod(l.refundsToSendFils, copy.locale)} hint={copy.payments.bookingsCount(l.refundsToSendCount)} tone={l.refundsToSendFils ? "live" : undefined} />
          <Stat label={copy.payments.feesOwed} value={jod(l.feesOwedFils, copy.locale)} hint={copy.payments.bookingsCount(l.feesOwedCount)} />
        </div>
      )}
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

type Form = PaymentsData["settings"];

/** A row of mutually exclusive choices. */
function Choice<T extends string>({ value, options, onChange, testId }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; testId?: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" data-testid={testId}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cn("min-h-10 rounded-xl border px-3 text-sm font-semibold", value === o.value ? "border-turf bg-turf/10 text-turf" : "border-line bg-raised text-muted-text hover:text-text")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 py-4">
      <div>
        <p className="text-sm font-semibold text-text">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-5 text-muted-text">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function NumberBox({ value, onChange, min = 0, max, label, suffix }: { value: string; onChange: (v: string) => void; min?: number; max?: number; label: string; suffix?: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-muted-text">
      <span className="sr-only">{label}</span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" min={min} max={max} aria-label={label} className="w-24 min-h-10" />
      {suffix && <span>{suffix}</span>}
    </label>
  );
}

function SettingsCard({ venueId, settings, preview }: { venueId: number; settings: Form; preview: PaymentsData["preview"] }) {
  const copy = useVenueCopy();
  const p = copy.payments;
  const save = useSavePayments(venueId);
  const [s, setS] = useState(settings);
  const depositText = (x: Form) => x.depositPercent > 0 ? String(x.depositPercent) : jodInput(x.depositFils);
  const [deposit, setDeposit] = useState(depositText(settings));
  const [depositKind, setDepositKind] = useState<"fixed" | "percent">(settings.depositPercent > 0 ? "percent" : "fixed");
  const [lateValue, setLateValue] = useState(settings.lateCancelMode === "fixed" ? jodInput(settings.lateCancelValue) : String(settings.lateCancelValue || ""));
  const [noShowValue, setNoShowValue] = useState(settings.noShowFeeMode === "fixed" ? jodInput(settings.noShowFeeValue) : String(settings.noShowFeeValue || ""));
  const [changeFee, setChangeFee] = useState(jodInput(settings.changeFeeFils));
  const [saved, setSaved] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    setS(settings);
    setDeposit(depositText(settings));
    setDepositKind(settings.depositPercent > 0 ? "percent" : "fixed");
    setLateValue(settings.lateCancelMode === "fixed" ? jodInput(settings.lateCancelValue) : String(settings.lateCancelValue || ""));
    setNoShowValue(settings.noShowFeeMode === "fixed" ? jodInput(settings.noShowFeeValue) : String(settings.noShowFeeValue || ""));
    setChangeFee(jodInput(settings.changeFeeFils));
  }, [settings]);
  const set = (patch: Partial<Form>) => setS((cur) => ({ ...cur, ...patch }));
  const pct = (v: string) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  const valueFor = (mode: string, v: string) => mode === "fixed" ? filsFromJod(v) ?? 0 : mode === "percent" ? pct(v) : 0;

  const cardReady = s.moneyTo === "venue" && s.cardEnabled && s.cardConfigured;
  const onlineOn = s.acceptCliq || cardReady;
  const submit = () => {
    if (!s.acceptCliq && !cardReady && !s.payAtField) { setLocal(p.needMethod); return; }
    setLocal(null);
    save.mutate({
      moneyTo: s.moneyTo, cliqAlias: s.cliqAlias || null, cliqName: s.cliqName || null, payAtField: s.payAtField, acceptCliq: s.acceptCliq,
      depositMode: onlineOn ? s.depositMode : "none",
      depositFils: depositKind === "fixed" ? filsFromJod(deposit) ?? 0 : s.depositFils,
      depositPercent: depositKind === "percent" ? pct(deposit) : 0,
      cancelHours: s.cancelHours, autoConfirmReceipts: s.autoConfirmReceipts,
      newCustomerPolicy: s.newCustomerPolicy, noShowPolicy: s.noShowPolicy,
      lateCancelMode: s.lateCancelMode, lateCancelValue: valueFor(s.lateCancelMode, lateValue),
      noShowFeeMode: s.noShowFeeMode, noShowFeeValue: valueFor(s.noShowFeeMode, noShowValue),
      allowChanges: s.allowChanges, changeHours: s.changeHours, changeFeeFils: filsFromJod(changeFee) ?? 0, maxChanges: s.maxChanges,
    }, { onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); } });
  };
  const footer = (
    <div className="flex flex-wrap items-center gap-3 pt-2">
      <Button type="button" onClick={submit} disabled={save.isPending} className="bg-floodlight font-bold text-void" data-testid="button-save-payments">{p.save}</Button>
      {saved && <span className="text-xs font-semibold text-turf" role="status">{p.saved}</span>}
      {local && <p className="text-sm text-red-400" role="alert">{local}</p>}
      <ErrorText error={save.error} />
    </div>
  );

  return (
    <>
      <Card className="space-y-5">
        <div>
          <h2 className="font-display text-2xl font-bold text-text">{p.whoTitle}</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(["venue", "replay"] as const).map((m) => (
              <button key={m} type="button" onClick={() => set({ moneyTo: m })} className={cn("rounded-2xl border p-4 text-start", s.moneyTo === m ? "border-turf bg-turf/10" : "border-line bg-raised/40")} data-testid={`money-to-${m}`}>
                <span className="flex items-center gap-2 font-bold text-text"><Landmark className="h-4 w-4 text-turf" />{m === "venue" ? p.toVenue : p.toReplay}</span>
                <span className="mt-1 block text-xs leading-5 text-muted-text">{m === "venue" ? p.toVenueHint : p.toReplayHint}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="font-display text-lg font-bold text-text">{p.methodsTitle}</h3>
          <div className="divide-y divide-line">
            <ToggleRow label={p.methodCliq} hint={p.methodCliqHint}><Switch checked={s.acceptCliq} onCheckedChange={(v) => set({ acceptCliq: v })} aria-label={p.methodCliq} data-testid="switch-accept-cliq" /></ToggleRow>
            {s.acceptCliq && s.moneyTo === "venue" && (
              <div className="grid gap-3 pb-3 sm:grid-cols-2">
                <div className="space-y-1.5"><Label>{p.alias}</Label><Input value={s.cliqAlias ?? ""} onChange={(e) => set({ cliqAlias: e.target.value.toUpperCase() })} dir="ltr" placeholder="GALAXYJO" /></div>
                <div className="space-y-1.5"><Label>{p.aliasName}</Label><Input value={s.cliqName ?? ""} onChange={(e) => set({ cliqName: e.target.value })} dir="auto" /><p className="text-[11px] text-muted-text">{p.aliasNameHint}</p></div>
              </div>
            )}
            <ToggleRow label={p.methodCard} hint={s.moneyTo === "replay" ? p.methodCardReplay : cardReady ? p.methodCardOn : p.methodCardOff}>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", cardReady ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{cardReady ? "✓" : "—"}</span>
            </ToggleRow>
            <ToggleRow label={p.methodCash} hint={p.methodCashHint}><Switch checked={s.payAtField} onCheckedChange={(v) => set({ payAtField: v })} aria-label={p.methodCash} data-testid="switch-pay-at-field" /></ToggleRow>
            {s.acceptCliq && s.moneyTo === "venue" && <ToggleRow label={p.autoConfirm} hint={p.autoConfirmHint}><Switch checked={s.autoConfirmReceipts} onCheckedChange={(v) => set({ autoConfirmReceipts: v })} /></ToggleRow>}
          </div>
        </div>

        {onlineOn && (
          <div className="space-y-3">
            <Label>{p.online}</Label>
            <Choice value={s.depositMode} onChange={(m) => set({ depositMode: m })} testId="choice-deposit-mode"
              options={(["full", "deposit", "none"] as const).filter((m) => m !== "none" || s.payAtField).map((m) => ({ value: m, label: p[m] }))} />
            {(s.depositMode === "deposit" || s.newCustomerPolicy === "deposit" || s.noShowPolicy === "deposit") && (
              <div className="flex flex-wrap items-end gap-3 pt-1">
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-muted-text">{p.depositKind}</p>
                  <Choice value={depositKind} onChange={(k) => { setDepositKind(k); setDeposit(k === "percent" ? String(s.depositPercent || 25) : jodInput(s.depositFils)); }}
                    options={[{ value: "fixed", label: p.depositFixed }, { value: "percent", label: p.depositShare }]} />
                </div>
                <NumberBox value={deposit} onChange={setDeposit} label={depositKind === "percent" ? p.depositPercent : p.depositAmount} suffix={depositKind === "percent" ? "%" : copy.locale === "ar" ? "دينار" : "JOD"} />
              </div>
            )}
          </div>
        )}
        {footer}
      </Card>

      <Card className="space-y-1" data-testid="booking-rules">
        <h2 className="font-display text-2xl font-bold text-text">{p.rulesTitle}</h2>
        <p className="text-sm leading-6 text-muted-text">{p.rulesHint}</p>
        <div className="divide-y divide-line">
          {onlineOn && (
            <Field label={p.newCustomer} hint={p.newCustomerHint}>
              <Choice value={s.newCustomerPolicy} onChange={(v) => set({ newCustomerPolicy: v })} testId="choice-new-customer"
                options={[{ value: "same", label: p.sameRule }, { value: "deposit", label: p.depositOnline }, { value: "full", label: p.fullOnline }]} />
            </Field>
          )}
          <Field label={p.noShowPolicy}>
            <Choice value={s.noShowPolicy} onChange={(v) => set({ noShowPolicy: v })} testId="choice-no-show-policy"
              options={[{ value: "same", label: p.sameRule }, ...(onlineOn ? [{ value: "deposit" as const, label: p.depositOnline }, { value: "full" as const, label: p.fullOnline }] : []), { value: "block", label: p.blockOnline }]} />
          </Field>
          <Field label={p.cancelTitle}>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-text">{p.cancelFreeUntil}</span>
              <Input type="number" min={0} max={168} value={s.cancelHours} onChange={(e) => set({ cancelHours: Number(e.target.value) })} className="w-24 min-h-10" aria-label={p.cancelFreeUntil} />
            </div>
            <p className="pt-2 text-xs font-semibold text-muted-text">{p.lateCancel}</p>
            <Choice value={s.lateCancelMode} onChange={(v) => { set({ lateCancelMode: v }); setLateValue(""); }} testId="choice-late-cancel"
              options={[
                { value: "refuse", label: p.lateRefuse }, { value: "free", label: p.lateFree },
                ...(s.depositMode !== "none" ? [{ value: "deposit" as const, label: p.lateDeposit }] : []),
                { value: "percent", label: p.latePercent }, { value: "fixed", label: p.lateFixed },
              ]} />
            {(s.lateCancelMode === "percent" || s.lateCancelMode === "fixed") && (
              <NumberBox value={lateValue} onChange={setLateValue} label={s.lateCancelMode === "percent" ? p.percentLabel : p.feeLabel} suffix={s.lateCancelMode === "percent" ? "%" : copy.locale === "ar" ? "دينار" : "JOD"} />
            )}
          </Field>
          <Field label={p.noShowTitle}>
            <Choice value={s.noShowFeeMode} onChange={(v) => { set({ noShowFeeMode: v }); setNoShowValue(""); }} testId="choice-no-show-fee"
              options={[
                { value: "none", label: p.noShowNone },
                ...(s.depositMode !== "none" ? [{ value: "deposit" as const, label: p.noShowDeposit }] : []),
                { value: "percent", label: p.latePercent }, { value: "fixed", label: p.lateFixed },
              ]} />
            {(s.noShowFeeMode === "percent" || s.noShowFeeMode === "fixed") && (
              <NumberBox value={noShowValue} onChange={setNoShowValue} label={s.noShowFeeMode === "percent" ? p.percentLabel : p.feeLabel} suffix={s.noShowFeeMode === "percent" ? "%" : copy.locale === "ar" ? "دينار" : "JOD"} />
            )}
          </Field>
          <Field label={p.changesTitle}>
            <ToggleRow label={p.allowChanges} hint={p.allowChangesHint}><Switch checked={s.allowChanges} onCheckedChange={(v) => set({ allowChanges: v })} aria-label={p.allowChanges} /></ToggleRow>
            {s.allowChanges && (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5"><Label className="text-xs">{p.changeHours}</Label><Input type="number" min={0} max={168} value={s.changeHours} onChange={(e) => set({ changeHours: Number(e.target.value) })} className="min-h-10" /></div>
                <div className="space-y-1.5"><Label className="text-xs">{p.changeFee}</Label><Input value={changeFee} onChange={(e) => setChangeFee(e.target.value)} inputMode="decimal" className="min-h-10" /></div>
                <div className="space-y-1.5"><Label className="text-xs">{p.maxChanges}</Label><Input type="number" min={1} max={20} value={s.maxChanges} onChange={(e) => set({ maxChanges: Number(e.target.value) })} className="min-h-10" /></div>
              </div>
            )}
          </Field>
        </div>
        <div className="rounded-2xl border border-line bg-raised/50 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-text">{p.preview}</p>
          <ul className="mt-2 space-y-1 text-sm text-text" dir="auto">
            {preview[copy.locale].map((line) => <li key={line} className="flex gap-2"><span className="text-turf">•</span><span>{line}</span></li>)}
          </ul>
          <p className="mt-2 text-[11px] text-muted-text">{p.previewHint}</p>
        </div>
        {footer}
      </Card>
    </>
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
