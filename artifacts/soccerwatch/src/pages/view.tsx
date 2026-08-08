import { useState } from "react";
import { useTranslation } from "@/i18n";
import Academies from "@/pages/academies";
import Fields from "@/pages/fields";

type Section = "academies" | "fields";

export default function View() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("academies");

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-background">
      {/* Header — not sticky */}
      <div className="shrink-0 px-4 pb-3 pt-4">
        <h1 className="mb-3 text-2xl font-bold text-foreground">Browse</h1>
        {/* Pill toggle */}
        <div className="flex rounded-full border border-border bg-card p-1">
          <button
            onClick={() => setSection("academies")}
            className={`flex flex-1 items-center justify-center rounded-full py-2 text-sm font-semibold transition-colors ${
              section === "academies"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground"
            }`}
          >
            {t.nav.academies}
          </button>
          <button
            onClick={() => setSection("fields")}
            className={`flex flex-1 items-center justify-center rounded-full py-2 text-sm font-semibold transition-colors ${
              section === "fields"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground"
            }`}
          >
            {t.nav.fields}
          </button>
        </div>
      </div>

      {/* Embedded page fills remaining height */}
      {section === "academies" ? <Academies embedded /> : <Fields embedded />}
    </div>
  );
}
