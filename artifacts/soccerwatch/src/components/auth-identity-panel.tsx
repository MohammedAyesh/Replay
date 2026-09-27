type AuthIdentityPanelProps = {
  locale: string;
  isLoading: boolean;
  retrying: boolean;
  signOutPending: boolean;
  signOutFailed: boolean;
  onRetry: () => void;
  onSignInAgain: () => void;
};

export function AuthIdentityPanel({
  locale,
  isLoading,
  retrying,
  signOutPending,
  signOutFailed,
  onRetry,
  onSignInAgain,
}: AuthIdentityPanelProps) {
  const isArabic = locale === "ar";
  const copy = isArabic
    ? {
        checkingTitle: "جارٍ تأكيد حسابك",
        checkingDescription: "يرجى الانتظار بينما نتحقق من حسابك في Replay.",
        failedTitle: "تعذّر تأكيد حسابك",
        failedDescription: "لم نتمكن من التحقق من الحساب المسجّل. لم يتم تغيير أي بيانات. أعد تسجيل الدخول للمتابعة.",
        retry: "حاول مرة أخرى",
        signInAgain: "تسجيل الدخول مرة أخرى",
        signingOut: "جارٍ تسجيل الخروج…",
        signOutFailed: "تعذّر تسجيل الخروج. تحقق من اتصالك وحاول مرة أخرى.",
      }
    : {
        checkingTitle: "Confirming your account",
        checkingDescription: "Please wait while we verify your Replay account.",
        failedTitle: "We couldn't confirm your account",
        failedDescription: "We couldn't verify the signed-in account. No account data was changed. Sign in again to continue.",
        retry: "Try again",
        signInAgain: "Sign in again",
        signingOut: "Signing out…",
        signOutFailed: "We couldn't sign you out. Check your connection and try again.",
      };
  const confirming = isLoading || retrying;

  return (
    <section
      dir={isArabic ? "rtl" : "ltr"}
      className="mx-auto flex w-[440px] max-w-full flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-6 text-center text-text"
      aria-live="polite"
    >
      {confirming ? (
        <>
          <span
            className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
          <h1 className="text-lg font-semibold">{copy.checkingTitle}</h1>
          <p className="text-sm leading-6 text-muted-foreground">{copy.checkingDescription}</p>
        </>
      ) : (
        <>
          <h1 className="text-lg font-semibold">{copy.failedTitle}</h1>
          <p className="text-sm leading-6 text-muted-foreground">{copy.failedDescription}</p>
          {signOutFailed && (
            <p role="alert" className="text-sm text-destructive">{copy.signOutFailed}</p>
          )}
          <div className="flex w-full flex-col gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="min-h-11 w-full rounded-xl border border-line bg-raised px-4 py-3 text-sm font-semibold text-text"
            >
              {copy.retry}
            </button>
            <button
              type="button"
              onClick={onSignInAgain}
              disabled={signOutPending}
              className="min-h-11 w-full rounded-xl bg-turf px-4 py-3 text-sm font-semibold text-void disabled:cursor-wait disabled:opacity-60"
            >
              {signOutPending ? copy.signingOut : copy.signInAgain}
            </button>
          </div>
        </>
      )}
    </section>
  );
}