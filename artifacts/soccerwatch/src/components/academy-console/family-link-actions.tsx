import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAcademyConsolePlayerFamilyLinkQueryKey,
  useGetAcademyConsolePlayerFamilyLink,
  useRegenerateAcademyConsolePlayerFamilyLink,
} from "@workspace/api-client-react";
import { Check, Copy, Link2, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type FamilyLinkActionsProps = {
  academyId: number;
  playerId: number;
  isActive: boolean;
  isOwner: boolean;
};

const text = {
  en: {
    title: "Family view link", description: "Share a private, read-only view of this player's academy schedule and progress with their family.",
    copy: "Copy link", copied: "Copied", create: "Create family link", rotate: "Rotate link",
    privacy: "Anyone with this link can view this player's family page. Keep it within the family.",
    confirmTitle: "Replace this family link?", confirmDescription: "The current link will stop working immediately. Anyone using it will need the new link.",
    cancel: "Keep current link", confirm: "Replace link", loading: "Loading family link…",
    error: "The family link could not be loaded.", rotationError: "The link could not be replaced. Please try again.",
    copyError: "Could not copy automatically. Select and copy the link instead.",
  },
  ar: {
    title: "رابط مساحة العائلة", description: "شارك عرضاً خاصاً للقراءة فقط لمواعيد اللاعب وتقدمه مع عائلته.",
    copy: "نسخ الرابط", copied: "تم النسخ", create: "إنشاء رابط العائلة", rotate: "تغيير الرابط",
    privacy: "يمكن لمن يملك الرابط مشاهدة صفحة هذا اللاعب. يرجى مشاركته مع العائلة فقط.",
    confirmTitle: "استبدال رابط العائلة؟", confirmDescription: "سيتوقف الرابط الحالي عن العمل فوراً، وسيحتاج مستخدموه إلى الرابط الجديد.",
    cancel: "الإبقاء على الرابط", confirm: "استبدال الرابط", loading: "جارٍ تحميل رابط العائلة…",
    error: "تعذر تحميل رابط العائلة.", rotationError: "تعذر استبدال الرابط. يرجى المحاولة مجدداً.",
    copyError: "تعذر النسخ تلقائياً. يرجى تحديد الرابط ونسخه.",
  },
};

export function FamilyLinkActions({ academyId, playerId, isActive, isOwner }: FamilyLinkActionsProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const { locale } = useTranslation();
  const isArabic = locale === "ar";
  const queryClient = useQueryClient();
  const queryKey = getGetAcademyConsolePlayerFamilyLinkQueryKey(academyId, playerId);
  const linkQuery = useGetAcademyConsolePlayerFamilyLink(academyId, playerId, {
    query: { enabled: isOwner && isActive, queryKey },
  });
  const regenerate = useRegenerateAcademyConsolePlayerFamilyLink();
  const labels = isArabic ? text.ar : text.en;

  if (!isOwner || !isActive) return null;
  const familyUrl = linkQuery.data?.familyUrl ?? null;
  const absoluteUrl = familyUrl
    ? (familyUrl.startsWith("http") ? familyUrl : `${window.location.origin}${familyUrl.startsWith("/") ? "" : "/"}${familyUrl}`)
    : null;

  const copyLink = async () => {
    if (!absoluteUrl) return;
    setCopied(false);
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopyFailed(true);
    }
  };

  const rotateLink = async () => {
    try {
      const result = await regenerate.mutateAsync({ academyId, playerId });
      queryClient.setQueryData(queryKey, result);
      setConfirmOpen(false);
    } catch {
      setConfirmOpen(false);
    }
  };

  return (
    <section className="join-link-panel" dir={isArabic ? "rtl" : "ltr"} data-testid={`family-link-actions-${playerId}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-turf/10 text-turf"><Link2 className="h-4 w-4" aria-hidden="true" /></span>
          <div className="min-w-0">
            <h2>{labels.title}</h2>
            <p>{labels.description}</p>
          </div>
        </div>
        {linkQuery.isLoading ? <div className="mt-3 h-9 animate-pulse rounded-lg bg-raised" aria-label={labels.loading} data-testid="family-link-loading" /> : null}
        {linkQuery.isError && <p className="mt-3 text-sm text-destructive" role="alert" data-testid="family-link-error">{labels.error}</p>}
        {absoluteUrl && (
          <div className="join-url-row">
            <code dir="ltr" title={absoluteUrl} data-testid="family-link-url">{absoluteUrl}</code>
            <Button type="button" variant="outline" size="sm" onClick={() => void copyLink()} className="min-h-10 shrink-0" data-testid={`button-copy-family-link-${playerId}`}>
              {copied ? <Check className="me-2 h-4 w-4" aria-hidden="true" /> : <Copy className="me-2 h-4 w-4" aria-hidden="true" />}
              {copied ? labels.copied : labels.copy}
            </Button>
          </div>
        )}
        {copyFailed && <p className="mt-2 text-xs text-destructive" role="alert" data-testid="family-link-copy-error">{labels.copyError}</p>}
        {!linkQuery.isLoading && !linkQuery.isError && !absoluteUrl && (
          <Button type="button" onClick={() => void rotateLink()} disabled={regenerate.isPending} className="mt-3 min-h-10 bg-floodlight font-bold text-void hover:bg-floodlight/90" data-testid={`button-create-family-link-${playerId}`}>
            {regenerate.isPending && <LoaderCircle className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {labels.create}
          </Button>
        )}
        {regenerate.isError && <p className="mt-2 text-xs text-destructive" role="alert" data-testid="family-link-rotation-error">{labels.rotationError}</p>}
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-muted-text"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-turf" aria-hidden="true" />{labels.privacy}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {absoluteUrl && <Button type="button" variant="outline" size="sm" onClick={() => setConfirmOpen(true)} disabled={regenerate.isPending} className="min-h-10" data-testid={`button-rotate-family-link-${playerId}`}>
          <RefreshCw className="me-2 h-4 w-4" aria-hidden="true" />{labels.rotate}
        </Button>}
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent dir={isArabic ? "rtl" : "ltr"} className="border-line bg-surface text-text">
          <AlertDialogHeader>
            <AlertDialogTitle>{labels.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-text">{labels.confirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={regenerate.isPending} data-testid={`button-cancel-family-link-rotation-${playerId}`}>{labels.cancel}</AlertDialogCancel>
            <AlertDialogAction disabled={regenerate.isPending} onClick={(event) => { event.preventDefault(); void rotateLink(); }} className="bg-floodlight font-bold text-void hover:bg-floodlight/90" data-testid={`button-confirm-family-link-rotation-${playerId}`}>
              {regenerate.isPending && <LoaderCircle className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}{labels.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
