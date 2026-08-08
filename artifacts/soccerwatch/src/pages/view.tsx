import { useState } from "react";
import { useTranslation } from "@/i18n";
import Academies from "@/pages/academies";
import Fields from "@/pages/fields";

type Section = "academies" | "fields";

export default function View() {
  const [section, setSection] = useState<Section>("academies");
  const { t } = useTranslation();

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-background">
      <div className="sticky top-0 z-10 shrink-0 bg-background px-4 pb-3 pt-4">
        <h1 className="mb-4 font-display text-2xl font-bold text-foreground">Browse</h1>
        <div className="flex rounded-full border border-border bg-card p-1">
          <button
            type="button"
            onClick={() => setSection("academies")}
            className={`flex-1 rounded-full py-2.5 text-sm font-semibold transition-colors ${
              section === "academies"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground"
            }`}
          >
            {t.nav.academies}
          </button>
          <button
            type="button"
            onClick={() => setSection("fields")}
            className={`flex-1 rounded-full py-2.5 text-sm font-semibold transition-colors ${
              section === "fields"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground"
            }`}
          >
            {t.nav.fields}
          </button>
        </div>
      </div>

      {section === "academies" ? <Academies embedded /> : <Fields embedded />}
    </div>
  );
}