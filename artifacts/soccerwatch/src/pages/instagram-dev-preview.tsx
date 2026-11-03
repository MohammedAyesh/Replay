import { InstagramSection } from "@/components/field-console/instagram-section";
import { AdminConsentPanel } from "@/components/admin/instagram-consent-panel";
import { InstagramMatchCard } from "@/components/match/InstagramMatchCard";
import { useInstagramCopy } from "@/i18n/instagram-strings";

/** Dev only: the Instagram autopilot screens against whatever /api answers (fixtures in a test browser). */
export default function InstagramDevPreview() {
  const copy = useInstagramCopy();
  return (
    <main dir={copy.locale === "ar" ? "rtl" : "ltr"} className="min-h-screen bg-void px-4 py-8 text-text">
      <div className="mx-auto max-w-6xl space-y-8">
        <InstagramSection venueId={1} />
        <div className="max-w-md"><InstagramMatchCard code="PREVIEW" /></div>
        <div className="max-w-3xl rounded-2xl bg-zinc-900 p-4"><AdminConsentPanel venueId={1} /></div>
      </div>
    </main>
  );
}
