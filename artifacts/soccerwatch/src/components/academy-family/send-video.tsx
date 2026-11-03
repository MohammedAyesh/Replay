import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { usePhoneCopy } from "@/i18n/phone-strings";
import { sendFamilyPhoneMedia } from "@/lib/phone-media-api";

/** Family page: a parent sends the academy a video or photo of his child (sorted by when it was filmed). */
export function FamilySendVideo({ playerId }: { playerId: number }) {
  const copy = usePhoneCopy();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const onFiles = async (files: FileList | null) => {
    const list = [...(files ?? [])];
    if (!list.length) return;
    setBusy(true);
    try {
      for (const f of list) await sendFamilyPhoneMedia(playerId, f);
      toast({ description: copy.family.sent });
    } catch {
      toast({ description: copy.family.failed, variant: "destructive" });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <section className="fp-card" data-testid="family-send-video">
      <div className="fp-card-head"><div><h2 className="fp-card-title">{copy.family.button}</h2><p className="fp-card-sub">{copy.family.hint}</p></div></div>
      <input ref={input} type="file" accept="video/*,image/jpeg,image/png" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} />
      <button type="button" className="fp-retry" disabled={busy} onClick={() => input.current?.click()}
        style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{copy.family.button}
      </button>
    </section>
  );
}
