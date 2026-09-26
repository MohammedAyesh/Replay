import { useState } from "react";
import { MoreHorizontal, ShieldBan } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/i18n";
import { useToast } from "@/hooks/use-toast";
import { SafetyApiError, useBlockUser } from "@/lib/safety-api";
import { reportErrorMessage, safetyStrings } from "@/i18n/safety-strings";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ReportSheet } from "./ReportSheet";

export type SafetyTarget =
  | { type: "user_clip"; id: number; ownerId: number; ownerName: string }
  | { type: "user"; id: number; name: string };

export function SafetyMenu({ target, onBlocked }: { target: SafetyTarget; onBlocked?: () => void }) {
  const { user, isGuest } = useAuth();
  const { locale } = useLocale();
  const { toast } = useToast();
  const copy = safetyStrings[locale];
  const block = useBlockUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const name = target.type === "user_clip" ? target.ownerName : target.name;
  const targetUserId = target.type === "user_clip" ? target.ownerId : target.id;

  if (!target || user?.id === targetUserId) return null;

  const stop = (event: Event | React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const requireSignIn = () => toast({ title: copy.guest, variant: "destructive" });
  const openReport = (event: Event) => {
    stop(event);
    setMenuOpen(false);
    if (isGuest || !user) {
      requireSignIn();
      return;
    }
    setReportOpen(true);
  };
  const openBlock = (event: Event) => {
    stop(event);
    setMenuOpen(false);
    if (isGuest || !user) {
      requireSignIn();
      return;
    }
    setBlockOpen(true);
  };
  const confirmBlock = async () => {
    try {
      await block.mutateAsync(targetUserId);
      toast({ title: copy.blocked });
      setBlockOpen(false);
      onBlocked?.();
    } catch (error) {
      const apiError = error instanceof SafetyApiError ? error : null;
      toast({ title: apiError?.reason ? reportErrorMessage(apiError.reason, locale) : copy.blockFailed, variant: "destructive" });
    }
  };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More options" data-testid={`button-safety-menu-${target.type}-${target.id}`} onClick={stop} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-transparent text-muted-text transition-colors hover:border-line hover:bg-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turf">
            <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={locale === "ar" ? "start" : "end"} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
          <DropdownMenuItem onSelect={openReport} className="min-h-11 cursor-pointer gap-3 px-3">
            <ShieldBan className="h-4 w-4" aria-hidden="true" />{copy.report}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openBlock} className="min-h-11 cursor-pointer gap-3 px-3 text-red-300 focus:text-red-200">
            <ShieldBan className="h-4 w-4" aria-hidden="true" />{copy.block(name)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ReportSheet open={reportOpen} onOpenChange={setReportOpen} target={target.type === "user_clip" ? { targetType: "user_clip", targetId: target.id } : { targetType: "user", targetId: target.id }} />
      <AlertDialog open={blockOpen} onOpenChange={setBlockOpen}>
        <AlertDialogContent dir={locale === "ar" ? "rtl" : "ltr"} className="border-line bg-surface text-text">
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle>{copy.blockTitle(name)}</AlertDialogTitle>
            <AlertDialogDescription className="text-start text-muted-text">{copy.blockBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row gap-2">
            <AlertDialogCancel data-testid="button-cancel-block" className="mt-0 min-h-11 flex-1 border-line text-text">{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-block" disabled={block.isPending} onClick={(event) => { event.preventDefault(); void confirmBlock(); }} className="min-h-11 flex-1 bg-red-500/15 text-red-200 hover:bg-red-500/25">
              {block.isPending ? copy.block(name) : copy.block(name)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
