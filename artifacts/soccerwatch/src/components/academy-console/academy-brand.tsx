import { useState } from "react";
import { useTranslation } from "@/i18n";

export function AcademyLogo({ academyName, logoUrl }: { academyName: string; logoUrl: string | null }) {
  const [imageFailed, setImageFailed] = useState(false);
  const initial = Array.from(academyName.trim())[0]?.toLocaleUpperCase() || "A";

  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-raised text-sm font-bold text-turf">
      {logoUrl && !imageFailed ? (
        <img
          src={logoUrl}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-contain p-0.5"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="grid h-7 w-7 place-items-center rounded-full bg-turf/10 text-sm font-bold text-turf" aria-hidden="true">
          {initial}
        </span>
      )}
    </span>
  );
}

export function AcademySidebarBrand({
  academyName,
  academyLogoUrl,
  caption,
  direction,
}: {
  academyName: string;
  academyLogoUrl: string | null;
  caption?: string;
  direction?: "ltr" | "rtl";
}) {
  const { t, locale } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3" data-testid="academy-console-brand">
      <div className="flex shrink-0 items-center gap-2" aria-hidden="true">
        <AcademyLogo
          key={`${academyName}:${academyLogoUrl ?? ""}`}
          academyName={academyName}
          logoUrl={academyLogoUrl}
        />
        <span className="h-6 w-px bg-line" />
        <img src="/replay-mark.svg" alt="" className="h-7 w-7 object-contain" />
      </div>
      <span className="min-w-0 flex-1" dir={direction ?? (locale === "ar" ? "rtl" : "ltr")}>
        <span
          className="block truncate font-display text-sm font-bold leading-5 text-text"
          title={academyName}
        >
          {academyName}
        </span>
        <span className="block whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-text">
          {caption ?? t.academyConsole.title}
        </span>
      </span>
    </div>
  );
}
