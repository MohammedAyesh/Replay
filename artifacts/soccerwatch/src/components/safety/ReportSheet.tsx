import { useEffect, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { useLocale } from "@/i18n";
import { useToast } from "@/hooks/use-toast";
import { useReportContent, SafetyApiError, type ReportInput } from "@/lib/safety-api";
import { reportErrorMessage, reportReasonsFor, safetyStrings, type ReportReason } from "@/i18n/safety-strings";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

export { reportReasonsFor, reportErrorMessage };

export type ReportSheetTarget = { targetType: "user_clip" | "user"; targetId: number };

export function ReportSheet({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ReportSheetTarget | null;
}) {
  const { locale } = useLocale();
  const { toast } = useToast();
  const report = useReportContent();
  const copy = safetyStrings[locale];
  const [reason, setReason] = useState<ReportReason | "">("");
  const [note, setNote] = useState("");
  const reasons = target ? reportReasonsFor(target.targetType) : [];

  useEffect(() => {
    if (!open) {
      setReason("");
      setNote("");
    }
  }, [open]);

  const close = () => {
    setReason("");
    setNote("");
    onOpenChange(false);
  };

  const submit = async () => {
    if (!target || !reason) return;
    const input: ReportInput = { ...target, reason, ...(note.trim() ? { note: note.trim() } : {}) };
    try {
      await report.mutateAsync(input);
      toast({ title: copy.success });
      close();
    } catch (error) {
      const apiError = error instanceof SafetyApiError ? error : null;
      toast({ title: reportErrorMessage(apiError?.reason, locale), variant: "destructive" });
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" dir={locale === "ar" ? "rtl" : "ltr"} className="mx-auto max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border-line bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <SheetHeader className="text-start">
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-turf/10 text-turf">
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          </div>
          <SheetTitle className="font-display text-2xl text-text">{copy.reportTitle}</SheetTitle>
          <SheetDescription className="text-start text-muted-text">{copy.reportDescription}</SheetDescription>
        </SheetHeader>
        <div className="mt-5 space-y-5">
          <RadioGroup value={reason} onValueChange={(value) => setReason(value as ReportReason)} className="gap-1">
            {reasons.map((value) => (
              <Label key={value} htmlFor={`report-reason-${value}`} data-testid={`label-report-reason-${value}`} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-2 text-sm text-text transition-colors hover:bg-raised has-[[data-state=checked]]:border-turf has-[[data-state=checked]]:bg-turf/5">
                <RadioGroupItem id={`report-reason-${value}`} value={value} data-testid={`radio-report-reason-${value}`} />
                <span>{copy.reasons[value]}</span>
              </Label>
            ))}
          </RadioGroup>
          <div className="space-y-2">
            <Label htmlFor="report-note" className="text-sm font-semibold text-text">{copy.noteLabel}</Label>
            <Textarea id="report-note" data-testid="textarea-report-note" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder={copy.notePlaceholder} className="min-h-24 resize-y border-line bg-raised text-text placeholder:text-muted-text" />
            <p className="text-end text-xs text-muted-text">{copy.charactersRemaining(500 - note.length)}</p>
          </div>
        </div>
        <SheetFooter className="mt-5 flex-row gap-2">
          <Button type="button" variant="outline" data-testid="button-cancel-report" onClick={close} className="min-h-11 flex-1 border-line text-text">{copy.cancel}</Button>
          <Button type="button" disabled={!reason || report.isPending} data-testid="button-send-report" onClick={() => void submit()} className="min-h-11 flex-1 bg-floodlight font-bold text-void hover:bg-floodlight/90">
            {report.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {copy.send}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
