import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ClipboardList, FilePlus2, ImagePlus, Loader2, MessageCircle, Plus, Sparkles, Trash2 } from "lucide-react";
import { adTemplates, useAdsWizardCopy } from "@/i18n/ads-wizard-strings";
import { useAdsExtraCopy } from "@/i18n/ads-extra-strings";
import {
  AdsApiError,
  apiUrl,
  fetchAdRequest,
  formatMoney,
  useAdMedia,
  useAdRequestAction,
  useAdTemplates,
  useSaveAdRequest,
  useWallet,
  type AdCard,
  type AdGoal,
  type AdMedia,
  type AdQuestion,
  type AdRequest,
  type AdRequestBody,
  type AdTemplate,
  type AdVariant,
} from "@/lib/meta-ads-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AdMediaPicker, MediaThumb } from "./ad-media";

type Draft = Omit<AdRequestBody, "variants" | "cards" | "questions"> & {
  variants: AdVariant[];
  cards: AdCard[];
  questions: AdQuestion[];
  imageData: string | null;
};

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromLocalDate(value: string, endOfDay = false): string | null {
  if (!value) return null;
  // Amman time: the ad starts at the start of the chosen day (or runs to its end).
  return new Date(`${value}T${endOfDay ? "23:59:00" : "00:00:00"}+03:00`).toISOString();
}

function ammanDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const fill = (text: string, academy: string) => text.replaceAll("{academy}", academy);

export function AdWizard({ academyId, open, onClose, editing, defaults, mode, currency, pageName }: {
  academyId: number;
  open: boolean;
  onClose: () => void;
  editing: AdRequest | null;
  defaults: { latitude: number | null; longitude: number | null; academyName: string };
  mode: "replay" | "own";
  currency: string;
  pageName: string | null;
}) {
  const copy = useAdsWizardCopy();
  const extra = useAdsExtraCopy();
  const save = useSaveAdRequest(academyId);
  const action = useAdRequestAction(academyId);
  const templates = useAdTemplates(academyId);
  const media = useAdMedia(academyId);
  const wallet = useWallet(academyId, mode === "replay" && open);
  const [step, setStep] = useState(0);
  const [previewVariant, setPreviewVariant] = useState(0);
  const blank = useMemo<Draft>(() => {
    const t = adTemplates(copy.locale, defaults.academyName).trial;
    return {
      goal: "whatsapp", name: t.headline, dailyBudget: 5, startAt: null, endAt: null, latitude: defaults.latitude, longitude: defaults.longitude,
      radiusKm: 10, ageMin: 25, ageMax: 55, variants: [{ headline: t.headline, primaryText: t.text }], locale: copy.locale, imageData: null,
      cards: [], questions: [], extraQuestion: null, templateId: null,
    };
  }, [copy.locale, defaults]);
  const [draft, setDraft] = useState<Draft>(blank);
  const amountCurrency = mode === "replay" ? "JOD" : currency;

  useEffect(() => {
    if (!open) return;
    setStep(editing ? 1 : 0);
    setPreviewVariant(0);
    if (!editing) {
      setDraft(blank);
      return;
    }
    void fetchAdRequest(academyId, editing.id).then((full) => setDraft({
      goal: full.goal, name: full.name, dailyBudget: full.dailyBudget, startAt: full.startAt, endAt: full.endAt, latitude: full.latitude, longitude: full.longitude,
      radiusKm: full.radiusKm, ageMin: full.ageMin, ageMax: full.ageMax, variants: full.variants?.length ? full.variants : [{ headline: full.headline, primaryText: full.primaryText }],
      locale: full.locale, imageData: full.imageData ?? null, cards: full.cards ?? [], questions: full.questions ?? [], extraQuestion: null, templateId: full.templateId,
    }));
  }, [open, editing, academyId, blank]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const applyTemplate = (t: AdTemplate) => {
    const inLocale = t.variants.filter((v) => v.locale === copy.locale);
    const chosen = (inLocale.length ? inLocale : t.variants).slice(0, 3);
    const locale = (chosen[0]?.locale ?? copy.locale) as "ar" | "en";
    set({
      templateId: t.id,
      goal: t.goal,
      name: (locale === "ar" ? t.titleAr : null) ?? t.title,
      dailyBudget: t.dailyBudget,
      startAt: fromLocalDate(ammanDay(0)),
      endAt: fromLocalDate(ammanDay(t.days - 1), true),
      radiusKm: t.radiusKm,
      ageMin: t.ageMin,
      ageMax: t.ageMax,
      locale,
      variants: chosen.map((v) => ({ headline: fill(v.headline, defaults.academyName).slice(0, 40), primaryText: fill(v.primaryText, defaults.academyName) })),
      questions: t.questions ?? [],
    });
    setStep(1);
  };

  const days = draft.startAt && draft.endAt ? Math.max(1, Math.round((new Date(draft.endAt).getTime() - new Date(draft.startAt).getTime()) / 86_400_000)) : null;
  const hasMedia = draft.cards.length > 0 || Boolean(draft.imageData);
  const textsOk = draft.variants.length > 0 && draft.variants.every((v) => v.headline.trim() && v.primaryText.trim());
  const minBudget = mode === "replay" ? wallet.data?.minDaily ?? 2 : 1;
  const canNext = [
    true,
    Boolean(draft.name.trim()) && (draft.goal !== "lead_form" || draft.questions.every((q) => q.label.trim())),
    draft.latitude !== null && draft.ageMin <= draft.ageMax,
    draft.dailyBudget >= minBudget,
    hasMedia && textsOk,
    true,
  ][step];

  const needToStart = mode === "replay" ? draft.dailyBudget * Math.min(wallet.data?.daysToStart ?? 3, days ?? 3) : 0;
  const walletShort = mode === "replay" && wallet.data && wallet.data.balance < needToStart;

  const body = (): AdRequestBody => ({
    ...draft,
    variants: draft.variants.map((v) => ({ headline: v.headline.trim(), primaryText: v.primaryText.trim() })),
    questions: draft.goal === "lead_form" ? draft.questions.filter((q) => q.label.trim()).map((q) => ({ label: q.label.trim(), ...(q.options?.length ? { options: q.options } : {}) })) : [],
  });
  const persist = async (): Promise<AdRequest> => save.mutateAsync({ id: editing?.id ?? null, body: body() });
  const finish = async (submit: boolean) => {
    const row = await persist();
    if (submit) {
      try {
        await action.mutateAsync({ id: row.id, action: "submit" });
      } catch (error) {
        if (error instanceof AdsApiError && error.data?.code === "wallet_low") { onClose(); return; }
        throw error;
      }
    }
    onClose();
  };

  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  const busy = save.isPending || action.isPending;
  const steps = extra.steps;
  const last = steps.length - 1;
  const actionError = (save.error ?? action.error) as Error | null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto border-line bg-surface" dir={dir}>
        <DialogHeader>
          <DialogTitle>{editing ? copy.wizard.titleEdit : copy.wizard.titleNew}</DialogTitle>
          <DialogDescription className="sr-only">{steps.join(" · ")}</DialogDescription>
        </DialogHeader>
        <ol className="flex gap-1 text-[11px] sm:text-xs">
          {steps.map((label, i) => (
            <li key={label} className={cn("flex-1 truncate rounded-full px-1.5 py-1 text-center font-semibold", i === step ? "bg-turf/15 text-turf" : i < step ? "bg-raised text-text" : "bg-raised/50 text-muted-text")}>{label}</li>
          ))}
        </ol>

        <div className="min-h-[320px] py-2">
          {step === 0 && (
            <div className="space-y-3" data-testid="wizard-templates">
              <div>
                <p className="font-semibold text-text">{extra.templates.title}</p>
                <p className="text-xs text-muted-text">{extra.templates.hint}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {(templates.data ?? []).map((t) => (
                  <button key={t.id} type="button" onClick={() => applyTemplate(t)} data-testid={`template-${t.key ?? t.id}`}
                    className="rounded-xl border border-line p-4 text-start transition-colors hover:border-turf hover:bg-turf/5">
                    <p className="flex items-center gap-2 font-semibold text-text"><Sparkles className="h-4 w-4 text-turf" aria-hidden="true" />{copy.locale === "ar" ? t.titleAr ?? t.title : t.title}</p>
                    <p className="mt-1 text-sm text-muted-text">{copy.locale === "ar" ? t.descriptionAr ?? t.description : t.description}</p>
                    <p className="mt-2 text-xs text-muted-text">
                      {t.goal === "whatsapp" ? copy.wizard.goalWhatsapp : copy.wizard.goalForm} · {extra.templates.perDay(formatMoney(t.dailyBudget, amountCurrency, copy.locale))} · {extra.templates.days(t.days)}
                    </p>
                  </button>
                ))}
                <button type="button" onClick={() => setStep(1)} className="rounded-xl border border-dashed border-line p-4 text-start hover:border-muted-text" data-testid="template-blank">
                  <p className="flex items-center gap-2 font-semibold text-text"><FilePlus2 className="h-4 w-4" aria-hidden="true" />{extra.templates.blank}</p>
                  <p className="mt-1 text-sm text-muted-text">{extra.templates.blankHint}</p>
                </button>
              </div>
              {templates.isLoading && <div className="h-20 animate-pulse rounded-xl bg-raised" />}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <p className="font-semibold text-text">{copy.wizard.goalTitle}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {([["whatsapp", MessageCircle, copy.wizard.goalWhatsapp, copy.wizard.goalWhatsappBody], ["lead_form", ClipboardList, copy.wizard.goalForm, copy.wizard.goalFormBody]] as const).map(([goal, Icon, title, text]) => (
                  <button key={goal} type="button" onClick={() => set({ goal: goal as AdGoal })} data-testid={`goal-${goal}`}
                    className={cn("rounded-xl border p-4 text-start transition-colors", draft.goal === goal ? "border-turf bg-turf/10" : "border-line hover:border-muted-text")}>
                    <Icon className="h-5 w-5 text-turf" aria-hidden="true" />
                    <p className="mt-2 font-semibold text-text">{title}</p>
                    <p className="mt-1 text-sm text-muted-text">{text}</p>
                  </button>
                ))}
              </div>
              {draft.goal === "lead_form" && <QuestionsEditor questions={draft.questions} onChange={(questions) => set({ questions })} />}
              <label className="block text-sm text-muted-text">{copy.wizard.name}
                <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} className="mt-1" dir="auto" maxLength={80} />
              </label>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <p className="font-semibold text-text">{copy.wizard.audienceTitle}</p>
              {draft.latitude === null && <p className="text-sm text-amber-200">{copy.wizard.noLocation}</p>}
              <label className="block text-sm text-text">{copy.wizard.radius(draft.radiusKm)}
                <input type="range" min={1} max={40} value={draft.radiusKm} onChange={(e) => set({ radiusKm: Number(e.target.value) })} className="mt-2 w-full accent-[#2FD8C4]" />
              </label>
              <div>
                <p className="text-sm text-text">{copy.wizard.ages(draft.ageMin, draft.ageMax)}</p>
                <div className="mt-2 flex items-center gap-3">
                  <Input type="number" min={18} max={65} value={draft.ageMin} onChange={(e) => set({ ageMin: Number(e.target.value) })} className="w-24" />
                  <span className="text-muted-text">–</span>
                  <Input type="number" min={18} max={65} value={draft.ageMax} onChange={(e) => set({ ageMax: Number(e.target.value) })} className="w-24" />
                </div>
                <p className="mt-1 text-xs text-muted-text">{copy.wizard.agesHint}</p>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <p className="font-semibold text-text">{copy.wizard.budgetTitle}</p>
              <label className="block text-sm text-muted-text">{copy.wizard.perDay} ({amountCurrency})
                <Input type="number" min={minBudget} max={1000} step={0.5} value={draft.dailyBudget} onChange={(e) => set({ dailyBudget: Number(e.target.value) })} className="mt-1 w-40" data-testid="input-daily-budget" />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm text-muted-text">{copy.wizard.start}
                  <Input type="date" value={toLocalInput(draft.startAt)} onChange={(e) => set({ startAt: fromLocalDate(e.target.value) })} className="mt-1" />
                </label>
                <label className="block text-sm text-muted-text">{copy.wizard.end}
                  <Input type="date" value={toLocalInput(draft.endAt)} onChange={(e) => set({ endAt: fromLocalDate(e.target.value, true) })} className="mt-1" />
                </label>
              </div>
              <p className="text-sm text-text">{days ? copy.wizard.estimate(formatMoney(draft.dailyBudget * days, amountCurrency, copy.locale), `${days} ${copy.locale === "ar" ? "يوم" : days === 1 ? "day" : "days"}`) : copy.wizard.openEnded}</p>
              {mode === "replay" && wallet.data && (
                <p className={cn("rounded-xl p-3 text-sm", walletShort ? "bg-amber-300/10 text-amber-200" : "bg-raised text-muted-text")}>
                  {extra.wallet.balance}: <b className="text-text">{formatMoney(wallet.data.balance, "JOD", copy.locale)}</b>
                  {walletShort && <> · {extra.wallet.needsTopup(formatMoney(needToStart, "JOD", copy.locale), formatMoney(wallet.data.balance, "JOD", copy.locale))}</>}
                </p>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-5">
                <AdMediaPicker academyId={academyId} cards={draft.cards} onChange={(cards) => set({ cards, ...(cards.length ? { imageData: null } : {}) })} />
                <label className="block text-sm text-muted-text">{copy.wizard.language}
                  <select value={draft.locale} onChange={(e) => set({ locale: e.target.value as "ar" | "en" })} className="mt-1 h-10 w-full rounded-lg border border-input bg-raised px-3 text-sm text-text">
                    <option value="ar">العربية</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <VariantsEditor variants={draft.variants} onChange={(variants) => set({ variants })} onFocus={setPreviewVariant} academy={defaults.academyName} locale={draft.locale} />
              </div>
              <div className="space-y-2">
                <VariantTabs count={draft.variants.length} value={previewVariant} onChange={setPreviewVariant} />
                <AdPreview draft={draft} variant={draft.variants[Math.min(previewVariant, draft.variants.length - 1)]} media={media.data ?? []} pageName={pageName ?? defaults.academyName} copy={copy} />
              </div>
            </div>
          )}

          {step === last && (
            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-2 text-sm">
                <p className="font-semibold text-text">{copy.wizard.reviewTitle}</p>
                <p className="text-text">{copy.wizard.goalTitle} <b>{draft.goal === "whatsapp" ? copy.wizard.goalWhatsapp : copy.wizard.goalForm}</b></p>
                <p className="text-text">{copy.wizard.radius(draft.radiusKm)} · {copy.wizard.ages(draft.ageMin, draft.ageMax)}</p>
                <p className="text-text">{formatMoney(draft.dailyBudget, amountCurrency, copy.locale)} / {copy.wizard.perDay}{days ? ` · ${extra.templates.days(days)}` : ""}</p>
                <p className="text-text">{extra.media.selected(Math.max(1, draft.cards.length))} · {extra.variants.title}: {draft.variants.map((_, i) => String.fromCharCode(65 + i)).join(" / ")}</p>
                {draft.goal === "lead_form" && draft.questions.length > 0 && <p className="text-text" dir="auto">{extra.questions.title}: {draft.questions.map((q) => q.label).join(" · ")}</p>}
                <p className="rounded-xl bg-raised p-3 text-muted-text">{mode === "replay" ? copy.wizard.replayNote : copy.wizard.ownNote}</p>
                {walletShort && wallet.data && (
                  <p className="rounded-xl bg-amber-300/10 p-3 text-amber-200" data-testid="wizard-wallet-short">
                    {extra.wallet.needsTopup(formatMoney(needToStart, "JOD", copy.locale), formatMoney(wallet.data.balance, "JOD", copy.locale))}
                  </p>
                )}
                {actionError && <p className="text-red-400" role="alert">{actionError.message}</p>}
              </div>
              <div className="space-y-2">
                <VariantTabs count={draft.variants.length} value={previewVariant} onChange={setPreviewVariant} />
                <AdPreview draft={draft} variant={draft.variants[Math.min(previewVariant, draft.variants.length - 1)]} media={media.data ?? []} pageName={pageName ?? defaults.academyName} copy={copy} />
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <Button type="button" variant="ghost" onClick={() => (step === 0 || (editing && step === 1) ? onClose() : setStep(step - 1))}>{copy.wizard.back}</Button>
          <div className="flex gap-2">
            {step > 0 && <Button type="button" variant="ghost" disabled={busy || !draft.name.trim() || !textsOk} onClick={() => void finish(false)}>{copy.wizard.saveDraft}</Button>}
            {step < last
              ? step > 0 && <Button type="button" disabled={!canNext} onClick={() => setStep(step + 1)} className="bg-turf font-bold text-void" data-testid="button-wizard-next">{copy.wizard.next}</Button>
              : <Button type="button" disabled={busy || !hasMedia || !textsOk || Boolean(walletShort)} onClick={() => void finish(true)} className="bg-floodlight font-bold text-void" data-testid="button-wizard-publish">
                {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}{mode === "replay" ? copy.wizard.sendToReplay : copy.wizard.publish}
              </Button>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VariantTabs({ count, value, onChange }: { count: number; value: number; onChange: (i: number) => void }) {
  if (count < 2) return null;
  return (
    <div className="flex gap-1">
      {Array.from({ length: count }, (_, i) => (
        <button key={i} type="button" onClick={() => onChange(i)} className={cn("rounded-full px-3 py-1 text-xs font-bold", value === i ? "bg-turf text-void" : "bg-raised text-text")}>
          {String.fromCharCode(65 + i)}
        </button>
      ))}
    </div>
  );
}

function VariantsEditor({ variants, onChange, onFocus, academy, locale }: { variants: AdVariant[]; onChange: (v: AdVariant[]) => void; onFocus: (i: number) => void; academy: string; locale: "ar" | "en" }) {
  const copy = useAdsWizardCopy();
  const extra = useAdsExtraCopy();
  const presets = adTemplates(locale, academy);
  const setOne = (i: number, patch: Partial<AdVariant>) => onChange(variants.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-text">{extra.variants.title}</p>
        <p className="text-xs text-muted-text">{extra.variants.hint}</p>
      </div>
      {variants.map((v, i) => (
        <div key={i} className="space-y-2 rounded-xl border border-line p-3" onFocusCapture={() => onFocus(i)}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-turf">{extra.variants.version(i + 1)}</span>
            <div className="flex flex-wrap items-center gap-1">
              {(Object.keys(copy.wizard.templates) as Array<keyof typeof copy.wizard.templates>).map((key) => (
                <button key={key} type="button" className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-text hover:bg-turf/15"
                  onClick={() => setOne(i, { headline: presets[key].headline.slice(0, 40), primaryText: presets[key].text })}>{copy.wizard.templates[key]}</button>
              ))}
              {variants.length > 1 && (
                <button type="button" className="ms-1 text-muted-text hover:text-red-400" aria-label={extra.variants.remove} onClick={() => onChange(variants.filter((_, j) => j !== i))}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          <label className="block text-xs text-muted-text">{copy.wizard.headline}
            <Input value={v.headline} onChange={(e) => setOne(i, { headline: e.target.value })} className="mt-1" dir="auto" maxLength={40} />
          </label>
          <label className="block text-xs text-muted-text">{copy.wizard.text}
            <Textarea value={v.primaryText} onChange={(e) => setOne(i, { primaryText: e.target.value })} className="mt-1 min-h-24" dir="auto" maxLength={600} />
          </label>
        </div>
      ))}
      {variants.length < 3 && (
        <Button type="button" variant="ghost" size="sm" className="border border-dashed border-line" onClick={() => { onChange([...variants, { ...variants[variants.length - 1] }]); onFocus(variants.length); }}>
          <Plus className="me-1 h-4 w-4" aria-hidden="true" />{extra.variants.add}
        </Button>
      )}
    </div>
  );
}

type QuestionRow = { id: number; label: string; optionsText: string };
let questionRowId = 0;
const splitOptions = (raw: string) => raw.split(/[,،]/).map((x) => x.trim()).filter(Boolean).slice(0, 10);

/** Rows keep their own id and raw choices text, so removing one never shifts another's choices. */
function QuestionsEditor({ questions, onChange }: { questions: AdQuestion[]; onChange: (q: AdQuestion[]) => void }) {
  const extra = useAdsExtraCopy();
  const [rows, setRows] = useState<QuestionRow[]>(() => questions.map((q) => ({ id: ++questionRowId, label: q.label, optionsText: (q.options ?? []).join("، ") })));
  const update = (next: QuestionRow[]) => {
    setRows(next);
    onChange(next.map((r) => ({ label: r.label, ...(splitOptions(r.optionsText).length ? { options: splitOptions(r.optionsText) } : {}) })));
  };
  return (
    <div className="space-y-2 rounded-xl border border-line p-3" data-testid="questions-editor">
      <p className="text-sm font-semibold text-text">{extra.questions.title}</p>
      <p className="text-xs text-muted-text">{extra.questions.hint}</p>
      {rows.map((r) => (
        <div key={r.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input value={r.label} maxLength={80} dir="auto" placeholder={extra.questions.label} onChange={(e) => update(rows.map((x) => (x.id === r.id ? { ...x, label: e.target.value } : x)))} />
          <Input value={r.optionsText} dir="auto" placeholder={extra.questions.optionsPlaceholder} aria-label={extra.questions.options}
            onChange={(e) => update(rows.map((x) => (x.id === r.id ? { ...x, optionsText: e.target.value } : x)))} />
          <Button type="button" variant="ghost" size="icon" aria-label={extra.questions.remove} onClick={() => update(rows.filter((x) => x.id !== r.id))}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
        </div>
      ))}
      {rows.length < 5 && (
        <Button type="button" variant="ghost" size="sm" onClick={() => update([...rows, { id: ++questionRowId, label: "", optionsText: "" }])}><Plus className="me-1 h-4 w-4" aria-hidden="true" />{extra.questions.add}</Button>
      )}
      {rows.length > 0 && <p className="text-[11px] text-muted-text">{extra.questions.options}</p>}
    </div>
  );
}

/** Roughly how the ad looks in the Facebook feed: one photo or video, or a carousel. */
function AdPreview({ draft, variant, media, pageName, copy }: { draft: Draft; variant: AdVariant | undefined; media: AdMedia[]; pageName: string; copy: ReturnType<typeof useAdsWizardCopy> }) {
  const [card, setCard] = useState(0);
  const cards = draft.cards.map((c) => ({ card: c, media: media.find((m) => m.id === c.mediaId) }));
  const v = variant ?? { headline: "", primaryText: "" };
  const cta = <span className={cn("shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold", draft.goal === "whatsapp" ? "bg-[#25D366] text-white" : "bg-[#E4E6EB] text-[#050505]")}>{copy.wizard.previewCta[draft.goal]}</span>;
  const single = cards.length <= 1;
  const only = cards[0]?.media;
  return (
    <div className="overflow-hidden rounded-xl border border-black/10 bg-white text-[#050505] shadow-sm" dir={draft.locale === "ar" ? "rtl" : "ltr"} data-testid="ad-preview">
      <div className="flex items-center gap-2 p-3">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[#1877F2] text-sm font-bold text-white">{pageName.slice(0, 1)}</span>
        <div className="leading-tight">
          <p className="text-sm font-semibold">{pageName}</p>
          <p className="text-xs text-[#65676B]">{copy.wizard.sponsored}</p>
        </div>
      </div>
      <p className="whitespace-pre-line px-3 pb-2 text-sm">{v.primaryText}</p>
      {single ? (
        <>
          {only?.kind === "video" && only.fileUrl ? (
            <video src={apiUrl(only.fileUrl)} poster={only.thumbUrl ? apiUrl(only.thumbUrl) : undefined} controls muted playsInline className="aspect-[4/5] w-full bg-black object-contain" />
          ) : only ? (
            <MediaThumb media={only} className="aspect-square w-full" />
          ) : draft.imageData ? (
            <img src={draft.imageData} alt="" className="aspect-square w-full object-cover" />
          ) : (
            <div className="grid aspect-square w-full place-items-center bg-[#F0F2F5] text-[#65676B]"><ImagePlus className="h-8 w-8" aria-hidden="true" /></div>
          )}
          <div className="flex items-center justify-between gap-3 bg-[#F0F2F5] p-3">
            <p className="min-w-0 truncate text-sm font-semibold">{v.headline}</p>
            {cta}
          </div>
        </>
      ) : (
        <div className="relative">
          <div className="flex gap-2 overflow-hidden px-3 pb-3">
            {cards.slice(card, card + 2).map(({ card: c, media: m }) => (
              <div key={c.mediaId} className="w-[70%] shrink-0 overflow-hidden rounded-lg border border-black/10">
                <MediaThumb media={m} className="aspect-square w-full" />
                <div className="flex items-center justify-between gap-2 bg-[#F0F2F5] p-2">
                  <p className="min-w-0 truncate text-xs font-semibold">{c.headline || v.headline}</p>
                  {cta}
                </div>
              </div>
            ))}
          </div>
          {card > 0 && <button type="button" onClick={() => setCard(card - 1)} className="absolute start-1 top-1/3 rounded-full bg-white/90 p-1 shadow" aria-label="previous"><ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" /></button>}
          {card < cards.length - 1 && <button type="button" onClick={() => setCard(card + 1)} className="absolute end-1 top-1/3 rounded-full bg-white/90 p-1 shadow" aria-label="next"><ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" /></button>}
        </div>
      )}
    </div>
  );
}
