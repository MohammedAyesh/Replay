import { Link } from "wouter";
import { Check, ChevronRight } from "lucide-react";
import type { UserClip } from "@workspace/api-client-react";
import { formatDay } from "@/components/match/bits";
import { useExplainerCopy } from "@/i18n/explainer-strings";
import { useMatchCopy } from "@/i18n/match-strings";
import { useFirstTime } from "@/lib/first-time";
import type { MyMatches } from "@/lib/match-api";
import { cn } from "@/lib/utils";

/**
 * Home's starter checklist: five steps from a new account to a clip sent to
 * the squad. Each step ticks itself from what the player actually did (a
 * match on his account, a video played on this phone, a clip cut, a clip
 * downloaded or shared). The next step is the only one with a button. It goes
 * away when all five are done, or when he taps Hide.
 */
export function FirstClipChecklist({ matches, clips, now }: { matches: MyMatches; clips: UserClip[]; now: number }) {
  const copy = useExplainerCopy().firstClip;
  const matchCopy = useMatchCopy();
  const [open, hide] = useFirstTime("home.first-clip.dismissed.v1");
  const [notWatched] = useFirstTime("home.first-clip.watched.v1");
  const [notShared] = useFirstTime("home.first-clip.shared.v1");

  const latest = matches.recent[0] ?? matches.live[0] ?? null;
  // A pitch counts once he has a match of his own (an unanswered invite isn't one yet).
  const anyMatch = latest ?? matches.upcoming[0] ?? null;
  const matchHref = latest ? (latest.inviteToken ? `/m/${latest.code}?i=${latest.inviteToken}` : `/m/${latest.code}`) : "/fields";
  const cut = clips.length > 0;
  // Sent = downloaded or shared from this phone, shared publicly, or rendered for download.
  // "match" visibility doesn't count: clips cut from a match page are saved that way automatically.
  const shared = !notShared || clips.some((clip) => clip.visibility === "public" || clip.visibility === "followers" || Boolean(clip.exportedUrl));

  const steps = [
    { key: "account", label: copy.account, done: true, href: "/account" },
    { key: "pitch", label: anyMatch ? copy.pitchDone(anyMatch.field.name) : copy.pitch, done: Boolean(anyMatch), href: "/fields" },
    {
      key: "watch",
      label: latest ? copy.watchDated(formatDay(latest.startMs, matchCopy.locale, now, matchCopy)) : copy.watch,
      done: !notWatched || cut,
      href: matchHref,
    },
    { key: "cut", label: copy.cut, done: cut, href: matchHref },
    { key: "share", label: copy.share, done: cut && shared, href: "/my-clips?tab=created" },
  ];
  const done = steps.filter((step) => step.done).length;
  // A starter checklist: players who have already cut a few clips are past it, whatever this phone remembers.
  if (!open || done === steps.length || clips.length >= 3) return null;
  const next = steps.findIndex((step) => !step.done);

  return (
    <section className="rounded-2xl border border-line bg-surface px-5 py-5" data-testid="home-first-clip">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[22px] font-extrabold leading-tight">{copy.title}</h2>
        <span className="shrink-0 font-mono text-[11px] font-bold tracking-wider text-floodlight">{copy.progress(done, steps.length)}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden>
        <div className="h-full rounded-full bg-floodlight transition-[width] duration-500" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="m-0 mt-4 flex list-none flex-col gap-1 p-0">
        {steps.map((step, index) => {
          const isNext = index === next;
          const row = (
            <>
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-bold",
                  step.done ? "border-floodlight bg-floodlight text-void" : isNext ? "border-floodlight text-floodlight" : "border-line text-muted-text",
                )}
              >
                {step.done ? <Check className="h-4 w-4" strokeWidth={3} /> : index + 1}
              </span>
              <span className={cn("min-w-0 flex-1 text-[15px] leading-snug", step.done ? "text-muted-text" : isNext ? "font-bold" : "text-muted-text")}>
                {step.label}
              </span>
              {isNext && <ChevronRight className="h-4 w-4 shrink-0 text-floodlight rtl:rotate-180" aria-hidden />}
            </>
          );
          return (
            <li key={step.key}>
              {isNext ? (
                <Link href={step.href} className="-mx-2 flex min-h-12 items-center gap-3 rounded-xl bg-floodlight/10 px-2 py-2" data-testid={`first-clip-next-${step.key}`}>
                  {row}
                </Link>
              ) : (
                <div className="flex min-h-11 items-center gap-3">{row}</div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={hide} className="-me-2 min-h-10 rounded-full px-3 text-xs font-semibold text-muted-text" data-testid="button-first-clip-hide">
          {copy.hide}
        </button>
      </div>
    </section>
  );
}
