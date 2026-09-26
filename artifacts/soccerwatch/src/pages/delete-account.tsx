import { ArrowLeft } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useTranslation } from "@/i18n";
import { useLegalCopy } from "@/i18n/legal-strings";
import { supportMailto, useSupportContact } from "@/lib/client-settings";
import { useAuth } from "@/lib/auth";

export default function DeleteAccountPage() {
  const { locale } = useTranslation();
  const copy = useLegalCopy();
  const { supportEmail } = useSupportContact();
  const supportHref = supportMailto(supportEmail);
  const { user, isGuest, isSignedIn, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  return (
    <div dir={locale === "ar" ? "rtl" : "ltr"} className="min-h-0 flex-1 overflow-y-auto bg-void text-text">
      <div className="mx-auto w-full max-w-[680px] px-4 pb-24 pt-4 sm:px-6">
        <button
          type="button"
          onClick={() => setLocation("/")}
          className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-text"
        >
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
          <span>{copy.back}</span>
        </button>

        <header className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
          <h1 className="text-2xl font-bold tracking-tight">{copy.accountDeletion.pageTitle}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-text">{copy.accountDeletion.pageIntro}</p>
          <p className="mt-2 text-sm font-medium leading-6">{copy.accountDeletion.appGuide}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {!isLoading && user && isSignedIn && !isGuest ? (
              <Link
                href="/account"
                className="inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground"
              >
                {copy.accountDeletion.openAccount}
              </Link>
            ) : !isLoading ? (
              <Link
                href="/sign-in?redirect_url=/account"
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-line bg-raised px-4 text-sm font-semibold text-text"
              >
                {copy.accountDeletion.signIn}
              </Link>
            ) : null}
          </div>
        </header>

        <div className="mt-4 space-y-4">
          <section className="rounded-2xl border border-line bg-surface p-5 leading-7 sm:p-6">
            <h2 className="text-lg font-semibold">{copy.accountDeletion.pageDeletedHeading}</h2>
            <ul className="mt-3 list-disc space-y-2 ps-6 text-sm text-muted-text">
              {copy.accountDeletion.deletedItems.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-5 leading-7 sm:p-6">
            <h2 className="text-lg font-semibold">{copy.accountDeletion.pageRetainedHeading}</h2>
            <ul className="mt-3 list-disc space-y-2 ps-6 text-sm text-muted-text">
              {copy.accountDeletion.retainedItems.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-5 leading-7 sm:p-6">
            {supportHref ? (
              <>
                <p className="text-sm text-muted-text">
                  {copy.accountDeletion.contactWithEmail.replace("{email}", supportEmail.trim())}
                </p>
                <a
                  href={supportHref}
                  className="mt-2 inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
                >
                  {copy.contactSupport}
                </a>
              </>
            ) : (
              <p className="text-sm text-muted-text">{copy.accountDeletion.contactWithoutEmail}</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}