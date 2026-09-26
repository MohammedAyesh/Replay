import { ArrowLeft } from "lucide-react";
import { useLocation } from "wouter";
import { useLocale } from "@/i18n";
import { useLegalCopy } from "@/i18n/legal-strings";
import { fillLegalPlaceholders } from "@/legal/fill";
import { privacy } from "@/legal/privacy";
import { terms } from "@/legal/terms";
import type { LegalDoc } from "@/legal/types";
import { useSupportContact } from "@/lib/client-settings";

export function LegalPage({ doc }: { doc: "privacy" | "terms" }) {
  const { locale } = useLocale();
  const copy = useLegalCopy();
  const { company, supportEmail } = useSupportContact();
  const [, setLocation] = useLocation();
  const content: LegalDoc = (doc === "privacy" ? privacy : terms)[locale];
  const placeholders = { company, supportEmail };
  const fill = (text: string) => fillLegalPlaceholders(text, placeholders, locale);
  const updatedDate = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${content.lastUpdated}T00:00:00.000Z`));

  const goBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      setLocation("/home");
    }
  };

  return (
    <div dir={locale === "ar" ? "rtl" : "ltr"} className="min-h-0 flex-1 overflow-y-auto bg-void text-text">
      <div className="mx-auto w-full max-w-[680px] px-4 pb-24 pt-4 sm:px-6">
        <button
          type="button"
          onClick={goBack}
          data-testid="button-legal-back"
          className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-text"
        >
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
          <span>{copy.back}</span>
        </button>

        <header className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
          <h1 data-testid="text-legal-title" className="text-2xl font-bold tracking-tight">
            {fill(content.title)}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-text">
            {copy.lastUpdated}{" "}
            <time dateTime={content.lastUpdated}>{updatedDate}</time>
          </p>
          <p
            role="status"
            data-testid="status-legal-draft"
            className="mt-4 rounded-xl border border-line bg-raised px-3 py-2 text-xs leading-5 text-muted-text"
          >
            {fill(content.draftNotice)}
          </p>
        </header>

        <div className="mt-4 space-y-4">
          {content.sections.map((section, index) => (
            <section
              key={`${section.heading}-${index}`}
              className="rounded-2xl border border-line bg-surface p-5 leading-7 sm:p-6"
            >
              <h2 className="text-lg font-semibold leading-7">{fill(section.heading)}</h2>
              <div className="mt-3 space-y-3 text-sm text-muted-text">
                {section.paragraphs.map((paragraph, paragraphIndex) => (
                  <p key={paragraphIndex}>{fill(paragraph)}</p>
                ))}
              </div>
              {section.bullets && section.bullets.length > 0 && (
                <ul className="mt-3 list-disc space-y-2 ps-6 text-sm leading-7 text-muted-text">
                  {section.bullets.map((bullet, bulletIndex) => (
                    <li key={bulletIndex}>{fill(bullet)}</li>
                  ))}
                </ul>
              )}
              {section.paragraphsAfterBullets?.map((paragraph, paragraphIndex) => (
                <p
                  key={paragraphIndex}
                  className="mt-3 text-sm leading-7 text-muted-text"
                >
                  {fill(paragraph)}
                </p>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}