import { useTranslation } from "@/i18n";
import Fields from "@/pages/fields";

export default function View() {
  const { locale } = useTranslation();

  return (
    <div className="view-page flex flex-1 min-h-0 flex-col overflow-hidden bg-background">
      <div className="view-page-header shrink-0 px-4 pb-2 pt-4">
        <h1 className="text-2xl font-bold text-foreground">
          {locale === "ar" ? "استعراض" : "Browse"}
        </h1>
      </div>

      <Fields embedded />
    </div>
  );
}
