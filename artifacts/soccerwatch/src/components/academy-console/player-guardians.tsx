import { useState } from "react";
import { useForm } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListAcademyConsolePlayerGuardiansQueryKey,
  useAddAcademyConsolePlayerGuardian,
  useListAcademyConsolePlayerGuardians,
  useRemoveAcademyConsolePlayerGuardian,
  type AcademyPlayerGuardian,
} from "@workspace/api-client-react";
import { LoaderCircle, UserMinus, UserPlus } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";

type GuardianForm = { email: string };

type PlayerGuardiansProps = {
  academyId: number;
  playerId: number;
};

export function AcademyPlayerGuardians({ academyId, playerId }: PlayerGuardiansProps) {
  const { t, locale } = useTranslation();
  const labels = t.academyConsole.familyGuardians;
  const isArabic = locale === "ar";
  const queryClient = useQueryClient();
  const queryKey = getListAcademyConsolePlayerGuardiansQueryKey(academyId, playerId);
  const guardiansQuery = useListAcademyConsolePlayerGuardians(academyId, playerId, {
    query: { queryKey, staleTime: 0, refetchOnMount: "always" },
  });
  const addGuardian = useAddAcademyConsolePlayerGuardian();
  const removeGuardian = useRemoveAcademyConsolePlayerGuardian();
  const [guardianToRemove, setGuardianToRemove] = useState<AcademyPlayerGuardian | null>(null);
  const [removeFailed, setRemoveFailed] = useState(false);
  const form = useForm<GuardianForm>({ defaultValues: { email: "" } });

  const submit = form.handleSubmit(async ({ email }) => {
    const normalizedEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
      form.setError("email", { type: "validate", message: labels.invalidEmail });
      return;
    }
    try {
      await addGuardian.mutateAsync({
        academyId,
        playerId,
        data: { email: normalizedEmail },
      });
      form.reset({ email: "" });
      await queryClient.invalidateQueries({ queryKey });
    } catch {
      form.setError("email", { type: "server", message: labels.addError });
    }
  });

  const confirmRemove = async () => {
    if (!guardianToRemove) return;
    setRemoveFailed(false);
    try {
      await removeGuardian.mutateAsync({
        academyId,
        playerId,
        userId: guardianToRemove.userId,
      });
      setGuardianToRemove(null);
      await queryClient.invalidateQueries({ queryKey });
    } catch {
      setRemoveFailed(true);
    }
  };

  return (
    <section className="mt-5 rounded-2xl border border-line bg-raised/40 p-4" dir={isArabic ? "rtl" : "ltr"} data-testid={`player-guardians-${playerId}`}>
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-turf/10 text-turf">
          <UserPlus className="h-4 w-4" aria-hidden="true" />
        </span>
        <div>
          <h3 className="text-sm font-bold text-text">{labels.title}</h3>
          <p className="text-xs leading-5 text-muted-text">{labels.description}</p>
        </div>
      </div>

      <Form {...form}>
        <form noValidate onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem className="min-w-0 flex-1 space-y-1.5">
                <FormLabel className="text-xs text-muted-text">{labels.email}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    placeholder="name@example.com"
                    className="min-h-10 bg-surface"
                    data-testid={`input-guardian-email-${playerId}`}
                  />
                </FormControl>
                <FormMessage className="text-xs" />
              </FormItem>
            )}
          />
          <Button type="submit" disabled={addGuardian.isPending} className="min-h-10 shrink-0 bg-floodlight font-bold text-void hover:bg-floodlight/90" data-testid={`button-add-guardian-${playerId}`}>
            {addGuardian.isPending
              ? <LoaderCircle className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />
              : <UserPlus className="me-2 h-4 w-4" aria-hidden="true" />}
            {addGuardian.isPending ? labels.adding : labels.add}
          </Button>
        </form>
      </Form>

      <div className="mt-4 border-t border-line pt-3">
        {guardiansQuery.isLoading ? (
          <p className="text-sm text-muted-text" role="status" data-testid={`guardians-loading-${playerId}`}>{labels.loading}</p>
        ) : guardiansQuery.isError ? (
          <Alert variant="destructive" data-testid={`guardians-load-error-${playerId}`}>
            <AlertDescription>{labels.loadError}</AlertDescription>
          </Alert>
        ) : guardiansQuery.data?.length ? (
          <ul className="divide-y divide-line" data-testid={`guardian-list-${playerId}`}>
            {guardiansQuery.data.map((guardian) => (
              <li key={guardian.userId} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text">{guardian.name}</p>
                  <p className="truncate text-xs text-muted-text" dir="ltr">{guardian.email}</p>
                  <p className="mt-1 text-[10px] text-muted-text">
                    {guardian.addedBy === "owner" ? labels.sourceOwner : labels.sourceLink}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={removeGuardian.isPending}
                  onClick={() => {
                    setRemoveFailed(false);
                    setGuardianToRemove(guardian);
                  }}
                  className="min-h-9 shrink-0"
                  data-testid={`button-remove-guardian-${guardian.userId}`}
                >
                  <UserMinus className="me-2 h-4 w-4" aria-hidden="true" />
                  {labels.remove}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-text" data-testid={`guardian-list-empty-${playerId}`}>{labels.empty}</p>
        )}
        {removeFailed ? (
          <p className="mt-3 text-sm text-destructive" role="alert" data-testid={`guardian-remove-error-${playerId}`}>{labels.removeError}</p>
        ) : null}
      </div>

      <AlertDialog
        open={Boolean(guardianToRemove)}
        onOpenChange={(open) => {
          if (!open && !removeGuardian.isPending) setGuardianToRemove(null);
        }}
      >
        <AlertDialogContent dir={isArabic ? "rtl" : "ltr"} className="border-line bg-surface text-text">
          <AlertDialogHeader>
            <AlertDialogTitle>{labels.confirmRemoveTitle}</AlertDialogTitle>
            <AlertDialogDescription>{labels.confirmRemoveDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeGuardian.isPending}>{labels.cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={removeGuardian.isPending}
              onClick={(event) => {
                event.preventDefault();
                void confirmRemove();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid={`button-confirm-remove-guardian-${guardianToRemove?.userId ?? "none"}`}
            >
              {removeGuardian.isPending ? labels.removing : labels.confirmRemove}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
