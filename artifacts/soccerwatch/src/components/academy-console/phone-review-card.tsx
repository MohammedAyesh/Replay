import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { usePhoneCopy } from "@/i18n/phone-strings";
import { phoneThumb, useDaySessions, usePhoneMedia, useUpdatePhoneMedia, type PhoneItem } from "@/lib/phone-media-api";
import { PhoneUploadButton } from "./phone-media-card";

/**
 * Matches → files Replay could not place (a WhatsApp forward knows only its
 * day; some files have no date): the coach picks the session and when.
 */
export function PhoneReviewCard({ academyId }: { academyId: number }) {
  const copy = usePhoneCopy();
  const queue = usePhoneMedia(academyId, { review: true });
  const items = queue.data ?? [];
  return (
    <section className="rounded-2xl border border-line bg-surface p-5" data-testid="phone-review">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-bold text-text"><HelpCircle className="h-5 w-5 text-turf" aria-hidden />{items.length ? copy.review.title : copy.title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-text">{items.length ? copy.review.intro : copy.intro}</p>
        </div>
        <PhoneUploadButton academyId={academyId} />
      </div>
      {items.length > 0 && <ul className="mt-3 divide-y divide-line">{items.map((i) => <ReviewRow key={i.id} academyId={academyId} item={i} />)}</ul>}
    </section>
  );
}

function ReviewRow({ academyId, item }: { academyId: number; item: PhoneItem }) {
  const copy = usePhoneCopy();
  const [day, setDay] = useState(item.captureDate ?? "");
  const sessions = useDaySessions(academyId, /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [phase, setPhase] = useState<"before" | "during" | "after">("during");
  const update = useUpdatePhoneMedia(academyId);
  const options = sessions.data ?? [];
  const chosen = sessionId ?? (options.length === 1 ? options[0].id : null);
  const label = (s: { type: string; startsAt: string; opponent: string | null }) =>
    `${new Date(s.startsAt).toLocaleTimeString(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Amman" })}${s.opponent ? ` · ${s.opponent}` : ""}`;
  return (
    <li className="flex flex-wrap items-center gap-3 py-3" data-testid={`phone-review-${item.id}`}>
      <img src={phoneThumb(item)} alt="" className="h-14 w-24 shrink-0 rounded-lg bg-black object-cover" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="truncate font-semibold text-text"><bdi>{item.fileName}</bdi></p>
        <p className="text-xs text-muted-text">{item.reviewReason ? copy.review.reasons[item.reviewReason] : ""}</p>
      </div>
      <label className="flex items-center gap-1 text-xs text-muted-text">{copy.review.day}
        <input type="date" value={day} onChange={(e) => { setDay(e.target.value); setSessionId(null); }} className="h-9 rounded-lg border border-line bg-raised px-2 text-text" />
      </label>
      <select value={chosen ?? ""} onChange={(e) => setSessionId(e.target.value ? Number(e.target.value) : null)} aria-label={copy.review.pickSession}
        className="h-9 rounded-lg border border-line bg-raised px-2 text-sm text-text" data-testid="review-session">
        <option value="">{options.length ? copy.review.pickSession : copy.review.noSessions}</option>
        {options.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}
      </select>
      <select value={phase} onChange={(e) => setPhase(e.target.value as typeof phase)} aria-label={copy.review.pickPhase}
        className="h-9 rounded-lg border border-line bg-raised px-2 text-sm text-text" data-testid="review-phase">
        {(["before", "during", "after"] as const).map((p) => <option key={p} value={p}>{copy.phases[p]}</option>)}
      </select>
      <Button type="button" size="sm" disabled={!chosen || update.isPending}
        onClick={() => update.mutate({ id: item.id, sessionId: chosen, phase }, { onSuccess: () => toast({ description: copy.review.saved }), onError: (e) => toast({ description: (e as Error).message, variant: "destructive" }) })}>
        {copy.review.save}
      </Button>
    </li>
  );
}
