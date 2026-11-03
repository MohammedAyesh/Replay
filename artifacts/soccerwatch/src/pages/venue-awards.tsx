import { Link, useRoute } from "wouter";
import { Check, Trophy } from "lucide-react";
import { useInstagramCopy } from "@/i18n/instagram-strings";
import { useAwardVote, useAwardsPage } from "@/lib/instagram-api";
import { cn } from "@/lib/utils";

/**
 * A field's weekly awards, voted in the Replay app (/awards/<slug>): nominees from last week's
 * games, one vote per person per award, counts hidden until voting closes.
 */
export default function VenueAwardsPage() {
  const [, params] = useRoute("/awards/:slug");
  const slug = params?.slug ?? "";
  const copy = useInstagramCopy();
  const page = useAwardsPage(slug);
  const vote = useAwardVote(slug);
  const data = page.data;
  const field = data ? (copy.locale === "ar" ? data.field.nameAr || data.field.name : data.field.name) : "";
  const fmt = (iso: string) => new Date(iso).toLocaleString(copy.locale === "ar" ? "ar-JO" : "en-GB", { weekday: "long", hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" });
  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-20 pt-6" dir={copy.locale === "ar" ? "rtl" : "ltr"} data-testid="venue-awards">
      <div className="flex items-center gap-3">
        {data?.field.logoUrl ? <img src={data.field.logoUrl} alt="" className="h-12 w-12 rounded-xl object-cover" /> : <span className="grid h-12 w-12 place-items-center rounded-xl bg-floodlight text-void"><Trophy className="h-6 w-6" /></span>}
        <h1 className="font-display text-3xl font-bold tracking-tight">{copy.vote.title(field)}</h1>
      </div>
      {page.isLoading && <div className="mt-6 h-40 animate-pulse rounded-2xl bg-raised" />}
      {page.error && <p className="mt-6 text-sm text-muted-text">{copy.vote.none}</p>}
      {data && !data.awards.length && <p className="mt-6 text-sm text-muted-text">{copy.vote.none}</p>}
      {data && !data.signedIn && data.awards.some((a) => a.status === "voting") && (
        <Link href={`/sign-in?redirect_url=${encodeURIComponent(`/awards/${slug}`)}`} className="mt-5 block rounded-2xl bg-floodlight px-4 py-3 text-center text-sm font-bold text-void">{copy.vote.signIn}</Link>
      )}
      <div className="mt-6 space-y-6">
        {data?.awards.map((a) => {
          const open = a.status === "voting";
          return (
            <section key={a.id} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-display text-xl font-bold">{copy.awards.categories[a.category] ?? a.category}</h2>
                <span className={cn("text-xs font-semibold", open ? "text-turf" : "text-muted-text")}>{open ? (a.votingEndsAt ? copy.vote.closes(fmt(a.votingEndsAt)) : copy.vote.open) : copy.vote.closed}</span>
              </div>
              <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                {a.nominees.map((n) => {
                  const mine = a.myVote === n.key;
                  const won = a.winnerKey === n.key && !open;
                  return (
                    <li key={n.key} className={cn("overflow-hidden rounded-xl border bg-raised", mine ? "border-turf" : won ? "border-floodlight" : "border-line")}>
                      <div className="aspect-video bg-void">{n.thumbnailUrl && <img src={n.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}</div>
                      <div className="flex items-center justify-between gap-2 p-2.5">
                        <span className="min-w-0 text-xs text-text">{copy.locale === "ar" ? n.labelAr : n.label}{n.value != null ? ` · ${n.value} ${copy.locale === "ar" ? "كم/س" : "km/h"}` : ""}</span>
                        {open && data.signedIn ? (
                          <button type="button" disabled={vote.isPending} onClick={() => vote.mutate({ awardId: a.id, key: n.key })} className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold", mine ? "bg-turf text-void" : "bg-floodlight text-void")} data-testid={`vote-${a.id}-${n.key}`}>
                            {mine ? <><Check className="h-3.5 w-3.5" />{copy.vote.yourVote}</> : copy.vote.voteFor}
                          </button>
                        ) : won ? <span className="shrink-0 text-xs font-bold text-floodlight">{copy.vote.winner}</span>
                          : n.votes != null ? <span className="shrink-0 text-xs tabular-nums text-muted-text">{copy.vote.votes(n.votes)}</span> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      {vote.error && <p className="mt-3 text-sm text-red-400">{vote.error.message}</p>}
    </div>
  );
}
