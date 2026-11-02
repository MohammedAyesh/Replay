import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Loader2, MessageCircle, ClipboardList } from "lucide-react";
import { adTemplates, useAdsWizardCopy } from "@/i18n/ads-wizard-strings";
import { fetchAdRequest, formatMoney, useAdRequestAction, useSaveAdRequest, type AdGoal, type AdRequest, type AdRequestBody } from "@/lib/meta-ads-api";
import { resizeImage } from "@/lib/facebook-sdk";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Draft = AdRequestBody & { imageData: string | null };

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
  const save = useSaveAdRequest(academyId);
  const action = useAdRequestAction(academyId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0);
  const [loadingImage, setLoadingImage] = useState(false);
  const blank = useMemo<Draft>(() => {
    const t = adTemplates(copy.locale, defaults.academyName).trial;
    return {
      goal: "whatsapp", name: t.headline, dailyBudget: 5, startAt: null, endAt: null, latitude: defaults.latitude, longitude: defaults.longitude,
      radiusKm: 10, ageMin: 25, ageMax: 55, headline: t.headline, primaryText: t.text, locale: copy.locale, imageData: null, extraQuestion: null,
    };
  }, [copy.locale, defaults]);
  const [draft, setDraft] = useState<Draft>(blank);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    if (!editing) {
      setDraft(blank);
      return;
    }
    void fetchAdRequest(academyId, editing.id).then((full) => setDraft({
      goal: full.goal, name: full.name, dailyBudget: full.dailyBudget, startAt: full.startAt, endAt: full.endAt, latitude: full.latitude, longitude: full.longitude,
      radiusKm: full.radiusKm, ageMin: full.ageMin, ageMax: full.ageMax, headline: full.headline, primaryText: full.primaryText, locale: full.locale,
      imageData: full.imageData ?? null, extraQuestion: full.extraQuestion,
    }));
  }, [open, editing, academyId, blank]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const days = draft.startAt && draft.endAt ? Math.max(1, Math.round((new Date(draft.endAt).getTime() - new Date(draft.startAt).getTime()) / 86_400_000)) : null;
  const canNext = [
    Boolean(draft.name.trim()),
    draft.latitude !== null && draft.ageMin <= draft.ageMax,
    draft.dailyBudget > 0,
    Boolean(draft.imageData && draft.headline.trim() && draft.primaryText.trim()),
    true,
  ][step];

  const persist = async (): Promise<AdRequest> => save.mutateAsync({ id: editing?.id ?? null, body: draft });
  const finish = async (submit: boolean) => {
    const row = await persist();
    if (submit) await action.mutateAsync({ id: row.id, action: "submit" });
    onClose();
  };

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setLoadingImage(true);
    try {
      set({ imageData: await resizeImage(file) });
    } finally {
      setLoadingImage(false);
    }
  };

  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  const busy = save.isPending || action.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto border-line bg-surface" dir={dir}>
        <DialogHeader>
          <DialogTitle>{editing ? copy.wizard.titleEdit : copy.wizard.titleNew}</DialogTitle>
          <DialogDescription className="sr-only">{copy.wizard.steps.join(" · ")}</DialogDescription>
        </DialogHeader>
        <ol className="flex gap-1.5 text-xs">
          {copy.wizard.steps.map((label, i) => (
            <li key={label} className={cn("flex-1 rounded-full px-2 py-1 text-center font-semibold", i === step ? "bg-turf/15 text-turf" : i < step ? "bg-raised text-text" : "bg-raised/50 text-muted-text")}>{label}</li>
          ))}
        </ol>

        <div className="min-h-[300px] py-2">
          {step === 0 && (
            <div className="space-y-4">
              <p className="font-semibold text-text">{copy.wizard.goalTitle}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {([["whatsapp", MessageCircle, copy.wizard.goalWhatsapp, copy.wizard.goalWhatsappBody], ["lead_form", ClipboardList, copy.wizard.goalForm, copy.wizard.goalFormBody]] as const).map(([goal, Icon, title, body]) => (
                  <button key={goal} type="button" onClick={() => set({ goal: goal as AdGoal })} data-testid={`goal-${goal}`}
                    className={cn("rounded-xl border p-4 text-start transition-colors", draft.goal === goal ? "border-turf bg-turf/10" : "border-line hover:border-muted-text")}>
                    <Icon className="h-5 w-5 text-turf" aria-hidden="true" />
                    <p className="mt-2 font-semibold text-text">{title}</p>
                    <p className="mt-1 text-sm text-muted-text">{body}</p>
                  </button>
                ))}
              </div>
              {draft.goal === "lead_form" && (
                <label className="block text-sm text-muted-text">{copy.wizard.extraQuestion}
                  <Input value={draft.extraQuestion ?? ""} onChange={(e) => set({ extraQuestion: e.target.value })} placeholder={copy.wizard.extraQuestionPlaceholder} className="mt-1" dir="auto" maxLength={80} />
                </label>
              )}
              <label className="block text-sm text-muted-text">{copy.wizard.name}
                <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} className="mt-1" dir="auto" maxLength={80} />
              </label>
            </div>
          )}

          {step === 1 && (
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

          {step === 2 && (
            <div className="space-y-4">
              <p className="font-semibold text-text">{copy.wizard.budgetTitle}</p>
              <label className="block text-sm text-muted-text">{copy.wizard.perDay} ({currency})
                <Input type="number" min={1} max={1000} step={0.5} value={draft.dailyBudget} onChange={(e) => set({ dailyBudget: Number(e.target.value) })} className="mt-1 w-40" data-testid="input-daily-budget" />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm text-muted-text">{copy.wizard.start}
                  <Input type="date" value={toLocalInput(draft.startAt)} onChange={(e) => set({ startAt: fromLocalDate(e.target.value) })} className="mt-1" />
                </label>
                <label className="block text-sm text-muted-text">{copy.wizard.end}
                  <Input type="date" value={toLocalInput(draft.endAt)} onChange={(e) => set({ endAt: fromLocalDate(e.target.value, true) })} className="mt-1" />
                </label>
              </div>
              <p className="text-sm text-text">{days ? copy.wizard.estimate(formatMoney(draft.dailyBudget * days, currency, copy.locale), `${days} ${copy.locale === "ar" ? "يوم" : days === 1 ? "day" : "days"}`) : copy.wizard.openEnded}</p>
            </div>
          )}

          {step === 3 && (
            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-text">{copy.wizard.template}:</span>
                  {(Object.keys(copy.wizard.templates) as Array<keyof typeof copy.wizard.templates>).map((key) => (
                    <button key={key} type="button" className="rounded-full bg-raised px-2.5 py-1 text-text hover:bg-turf/15"
                      onClick={() => { const t = adTemplates(draft.locale, defaults.academyName)[key]; set({ headline: t.headline, primaryText: t.text }); }}>
                      {copy.wizard.templates[key]}
                    </button>
                  ))}
                </div>
                <label className="block text-sm text-muted-text">{copy.wizard.language}
                  <select value={draft.locale} onChange={(e) => set({ locale: e.target.value as "ar" | "en" })} className="mt-1 h-10 w-full rounded-lg border border-input bg-raised px-3 text-sm text-text">
                    <option value="ar">العربية</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <label className="block text-sm text-muted-text">{copy.wizard.headline}
                  <Input value={draft.headline} onChange={(e) => set({ headline: e.target.value })} className="mt-1" dir="auto" maxLength={40} />
                </label>
                <label className="block text-sm text-muted-text">{copy.wizard.text}
                  <Textarea value={draft.primaryText} onChange={(e) => set({ primaryText: e.target.value })} className="mt-1 min-h-28" dir="auto" maxLength={600} />
                </label>
                <div>
                  <p className="text-sm text-muted-text">{copy.wizard.image}</p>
                  <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => void pickImage(e.target.files?.[0])} />
                  <Button type="button" variant="ghost" className="mt-1 border border-line" onClick={() => fileRef.current?.click()} disabled={loadingImage}>
                    {loadingImage ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <ImagePlus className="me-2 h-4 w-4" aria-hidden="true" />}{copy.wizard.chooseImage}
                  </Button>
                  <p className="mt-1 text-xs text-muted-text">{copy.wizard.imageHint}</p>
                </div>
              </div>
              <AdPreview draft={draft} pageName={pageName ?? defaults.academyName} copy={copy} />
            </div>
          )}

          {step === 4 && (
            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-2 text-sm">
                <p className="font-semibold text-text">{copy.wizard.reviewTitle}</p>
                <p className="text-text">{copy.wizard.goalTitle} <b>{draft.goal === "whatsapp" ? copy.wizard.goalWhatsapp : copy.wizard.goalForm}</b></p>
                <p className="text-text">{copy.wizard.radius(draft.radiusKm)} · {copy.wizard.ages(draft.ageMin, draft.ageMax)}</p>
                <p className="text-text">{formatMoney(draft.dailyBudget, currency, copy.locale)} / {copy.wizard.perDay}{days ? ` · ${days}` : ""}</p>
                <p className="rounded-xl bg-raised p-3 text-muted-text">{mode === "replay" ? copy.wizard.replayNote : copy.wizard.ownNote}</p>
                {(save.isError || action.isError) && <p className="text-red-400" role="alert">{((save.error ?? action.error) as Error).message}</p>}
              </div>
              <AdPreview draft={draft} pageName={pageName ?? defaults.academyName} copy={copy} />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <Button type="button" variant="ghost" onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>{copy.wizard.back}</Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" disabled={busy || !draft.name.trim()} onClick={() => void finish(false)}>{copy.wizard.saveDraft}</Button>
            {step < 4
              ? <Button type="button" disabled={!canNext} onClick={() => setStep(step + 1)} className="bg-turf font-bold text-void" data-testid="button-wizard-next">{copy.wizard.next}</Button>
              : <Button type="button" disabled={busy || !draft.imageData} onClick={() => void finish(true)} className="bg-floodlight font-bold text-void" data-testid="button-wizard-publish">
                {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}{mode === "replay" ? copy.wizard.sendToReplay : copy.wizard.publish}
              </Button>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Roughly how the ad looks in the Facebook feed. */
function AdPreview({ draft, pageName, copy }: { draft: Draft; pageName: string; copy: ReturnType<typeof useAdsWizardCopy> }) {
  return (
    <div className="overflow-hidden rounded-xl border border-black/10 bg-white text-[#050505] shadow-sm" dir={draft.locale === "ar" ? "rtl" : "ltr"} data-testid="ad-preview">
      <div className="flex items-center gap-2 p-3">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[#1877F2] text-sm font-bold text-white">{pageName.slice(0, 1)}</span>
        <div className="leading-tight">
          <p className="text-sm font-semibold">{pageName}</p>
          <p className="text-xs text-[#65676B]">{copy.wizard.sponsored}</p>
        </div>
      </div>
      <p className="whitespace-pre-line px-3 pb-2 text-sm">{draft.primaryText}</p>
      {draft.imageData ? <img src={draft.imageData} alt="" className="aspect-square w-full object-cover" /> : <div className="grid aspect-square w-full place-items-center bg-[#F0F2F5] text-[#65676B]"><ImagePlus className="h-8 w-8" aria-hidden="true" /></div>}
      <div className="flex items-center justify-between gap-3 bg-[#F0F2F5] p-3">
        <p className="min-w-0 truncate text-sm font-semibold">{draft.headline}</p>
        <span className={cn("shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold", draft.goal === "whatsapp" ? "bg-[#25D366] text-white" : "bg-[#E4E6EB] text-[#050505]")}>{copy.wizard.previewCta[draft.goal]}</span>
      </div>
    </div>
  );
}
