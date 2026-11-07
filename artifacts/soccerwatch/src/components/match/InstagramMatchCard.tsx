import { useState } from "react";
import { Link } from "wouter";
import { ExternalLink, Instagram, Trophy } from "lucide-react";
import { useInstagramCopy } from "@/i18n/instagram-strings";
import { useMatchInstagram, useMatchInstagramActions } from "@/lib/instagram-api";

/**
 * The match page's Instagram card (field autopilot): whether this match is (or will be) on the
 * field's Instagram, "Remove from Instagram" for anyone who played, save and skill nominations
 * (Save of the week, Skill of the week), and the way to this week's awards vote. Shows nothing when the field doesn't post.
 */
export function InstagramMatchCard({ code }: { code: string }) {
  const copy = useInstagramCopy();
  const data = useMatchInstagram(code);
  const actions = useMatchInstagramActions(code);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<"removed" | "flagged" | null>(null);
  const d = data.data;
  if (!d?.enabled) return null;
  const field = (copy.locale === "ar" ? d.field?.nameAr || d.field?.name : d.field?.name) ?? "";
  const posts = d.posts ?? [];
  const live = posts.filter((p) => p.status !== "removed");
  const saves = d.saveCandidates ?? [];
  const skills = d.skillCandidates ?? [];
  if (!live.length && !d.canRemove && !saves.length && !skills.length && !d.awardsUrl && !d.optedOut) return null;

  const remove = () => actions.remove.mutate(undefined, {
    onSuccess: (r) => { setConfirming(false); setResult(r.outcomes.some((o) => o.outcome === "flagged") ? "flagged" : "removed"); },
  });

  return (
    <section className="rounded-2xl border border-line bg-surface p-4" data-testid="match-instagram">
      <h2 className="flex items-center gap-2 text-base font-bold"><Instagram className="h-4 w-4 text-turf" />{copy.match.title}</h2>
      {result === "flagged" ? <p className="mt-2 text-sm text-amber-200" role="status">{copy.match.flagged}</p>
        : result === "removed" || d.removed || d.optedOut ? <p className="mt-2 text-sm text-muted-text" role="status">{result === "removed" ? copy.match.removed : copy.match.optedOut}</p>
        : (
          <>
            <p className="mt-2 text-sm text-muted-text">{live.some((p) => p.status === "published") ? copy.match.posted(field) : copy.match.waiting(field)}</p>
            {live.some((p) => p.permalink) && (
              <div className="mt-2 flex flex-wrap gap-3">
                {live.filter((p) => p.permalink).map((p) => (
                  <a key={p.id} href={p.permalink!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-turf"><ExternalLink className="h-3.5 w-3.5" />Instagram</a>
                ))}
              </div>
            )}
            {d.canRemove && (confirming ? (
              <div className="mt-3 rounded-xl border border-[#FF5A3C]/40 bg-[#FF5A3C]/10 p-3">
                <p className="text-sm">{copy.match.confirm}</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={remove} disabled={actions.remove.isPending} className="rounded-full bg-[#FF5A3C] px-4 py-2 text-xs font-bold text-white disabled:opacity-50" data-testid="button-ig-remove-confirm">{actions.remove.isPending ? copy.match.removing : copy.match.remove}</button>
                  <button type="button" onClick={() => setConfirming(false)} className="rounded-full border border-line px-4 py-2 text-xs font-semibold text-muted-text">{copy.calendar.cancel}</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className="mt-3 block rounded-full border border-[#FF5A3C]/50 px-4 py-2 text-xs font-bold text-[#FF8A73]" data-testid="button-ig-remove">{copy.match.remove}</button>
            ))}
          </>
        )}
      {actions.remove.error && <p className="mt-2 text-xs text-red-400">{actions.remove.error.message}</p>}
      {!d.optedOut && !result && ([["save", saves, copy.match.saves, copy.match.savesHint], ["skill", skills, copy.match.skills, copy.match.skillsHint]] as const).map(([category, list, title, hint]) => list.length > 0 && (
        <details key={category} className="mt-4 rounded-xl border border-line bg-raised/40 p-3" data-testid={`match-nominate-${category}`}>
          <summary className="cursor-pointer text-sm font-semibold">{title}</summary>
          <p className="mt-1 text-xs text-muted-text">{hint}</p>
          <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {list.map((s) => (
              <li key={`${s.recordingId}:${s.atSeconds}`} className="overflow-hidden rounded-lg border border-line bg-void">
                <div className="aspect-video bg-void">{s.thumbnailUrl && <img src={s.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}</div>
                <div className="flex items-center justify-between gap-1 p-1.5 text-xs">
                  <span className="tabular-nums text-muted-text">{copy.match.at(Math.floor(s.atSeconds / 60) + 1)}</span>
                  {s.nominated ? <span className="font-semibold text-turf">{copy.match.nominated}</span>
                    : <button type="button" disabled={actions.nominate.isPending} onClick={() => actions.nominate.mutate({ recordingId: s.recordingId, atSeconds: s.atSeconds, category })} className="rounded-full bg-floodlight px-2 py-0.5 font-bold text-void">{copy.match.nominate}</button>}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ))}
      {d.awardsUrl && <Link href={d.awardsUrl} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-floodlight"><Trophy className="h-3.5 w-3.5" />{copy.match.vote}</Link>}
    </section>
  );
}
