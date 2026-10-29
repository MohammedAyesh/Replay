import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Check, ChevronRight, Gift, Loader2, Share2, Sparkles } from "lucide-react";
import { PlayerAvatar } from "@/components/match/bits";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useLocale } from "@/i18n/context";
import { useExplainerCopy } from "@/i18n/explainer-strings";
import { useMatchCopy } from "@/i18n/match-strings";
import { useFirstTime } from "@/lib/first-time";
import { formatJod, shareOrCopy, whatsappLink, type FreeMatchAttempt, type FreeMatchReward, type FreeMatchStatus } from "@/lib/match-api";
import { cn } from "@/lib/utils";

/**
 * The free-match challenge: book, pay by CliQ, find yourself, get N friends to
 * find themselves in the same match, and the next booking is free. The server
 * works out every step (GET /me/matches -> freeMatch); these components only
 * show where the player is and the one thing to do next.
 */

const AFTER_WHISTLE = ["processing", "ready", "expired"];

function useShortDate() {
  const { locale } = useLocale();
  return (iso: string | null | undefined) => {
    if (!iso) return "";
    return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { day: "numeric", month: "short", timeZone: "Asia/Amman" }).format(new Date(iso));
  };
}

/** Share the match link with the free-match line; WhatsApp when the phone has no share sheet. */
function useShareForFreeMatch() {
  const free = useExplainerCopy().free;
  const matchCopy = useMatchCopy();
  const { toast } = useToast();
  return async (code: string) => {
    const url = `${window.location.origin}/m/${code}`;
    const text = free.shareText(url);
    const result = await shareOrCopy({ text: text.replace(url, "").trim(), url });
    if (result === "copied") toast({ title: matchCopy.copied });
    if (result === "failed") window.open(whatsappLink(text), "_blank", "noopener");
  };
}

type StepState = "done" | "next" | "waiting" | "todo";

function stepsFor(attempt: FreeMatchAttempt | null, status: FreeMatchStatus) {
  const free = { book: Boolean(attempt), pay: Boolean(attempt?.paid), find: Boolean(attempt?.bookerFound) };
  const friendsDone = Boolean(attempt) && attempt!.friendsFound >= status.friendsRequired;
  const order: Array<{ key: "account" | "book" | "pay" | "find" | "friends"; done: boolean; waiting?: boolean }> = [
    { key: "account", done: true },
    { key: "book", done: free.book },
    { key: "pay", done: free.pay, waiting: Boolean(attempt?.payPending) },
    { key: "find", done: free.find },
    { key: "friends", done: friendsDone },
  ];
  const nextIndex = order.findIndex((step) => !step.done);
  return order.map((step, index): { key: typeof step.key; state: StepState } => ({
    key: step.key,
    state: step.done ? "done" : index === nextIndex ? (step.waiting ? "waiting" : "next") : "todo",
  }));
}

function Chip({ children, tone = "lime" }: { children: ReactNode; tone?: "lime" | "turf" }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10.5px] font-bold uppercase tracking-wider",
      tone === "lime" ? "bg-floodlight/15 text-floodlight" : "bg-turf/15 text-turf",
    )}>
      {children}
    </span>
  );
}

function CardShell({ children, glow = false, testId, className }: { children: ReactNode; glow?: boolean; testId?: string; className?: string }) {
  return (
    <section
      data-testid={testId}
      className={cn("relative overflow-hidden rounded-2xl border px-5 py-5", glow ? "border-floodlight/40" : "border-line bg-surface", className)}
      style={glow ? { background: "radial-gradient(120% 90% at 100% 0%, rgba(212,255,79,.16), transparent 60%), #141B2C" } : undefined}
    >
      {children}
    </section>
  );
}

const primaryButton = "flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-floodlight px-5 text-center font-display text-[16px] font-extrabold text-void";
const quietButton = "flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-semibold text-muted-text";

// ---------------------------------------------------------------- the rules

export function FreeMatchRulesSheet({ open, onOpenChange, status, canBook }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: Pick<FreeMatchStatus, "friendsRequired" | "freeHours" | "useWithinDays" | "deadlineDays">;
  canBook: boolean;
}) {
  const free = useExplainerCopy().free;
  const { locale } = useLocale();
  const rules = [
    { title: free.rule1Title, body: free.rule1 },
    { title: free.rule2Title, body: free.rule2 },
    { title: free.rule3Title, body: free.rule3(status.friendsRequired, status.deadlineDays) },
    { title: free.rule4Title, body: free.rule4(status.freeHours, status.useWithinDays) },
  ];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" dir={locale === "ar" ? "rtl" : "ltr"} className="mx-auto max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border-line bg-surface p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]" data-testid="free-match-rules">
        <SheetHeader className="text-start">
          <SheetTitle className="font-display text-2xl font-extrabold">{free.howTitle}</SheetTitle>
        </SheetHeader>
        <ol className="m-0 mt-4 flex list-none flex-col gap-4 p-0">
          {rules.map((rule, index) => (
            <li key={index} className="flex gap-3">
              <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-display text-sm font-extrabold", index === 3 ? "bg-floodlight text-void" : "bg-raised text-turf")}>{index + 1}</span>
              <span className="min-w-0">
                <span className="block text-[15px] font-bold leading-snug">{rule.title}</span>
                <span className="mt-0.5 block text-[13px] leading-5 text-muted-text">{rule.body}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-4 rounded-xl bg-raised px-3 py-2.5 text-[12px] leading-5 text-muted-text">{free.rulesSmall}</p>
        {canBook && (
          <Link href="/book" className={cn(primaryButton, "mt-4")} onClick={() => onOpenChange(false)}>{free.letsBook}</Link>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Home

/** Home's free-match card: the intro, the progress, or the free match ready to book. */
export function FreeMatchHomeCard({ status, canBook, className, hideStartAction = false }: { status: FreeMatchStatus; canBook: boolean; className?: string; hideStartAction?: boolean }) {
  const explainer = useExplainerCopy();
  const free = explainer.free;
  const shortDate = useShortDate();
  const share = useShareForFreeMatch();
  const [rulesOpen, setRulesOpen] = useState(false);
  const attempt = status.attempt;
  const [introOpen, hideIntro] = useFirstTime("free-match.home.dismissed.v1", status.enabled && !attempt && !status.reward);
  const rules = <FreeMatchRulesSheet open={rulesOpen} onOpenChange={setRulesOpen} status={status} canBook={canBook} />;

  // A free match is waiting to be used.
  if (status.reward) {
    return (
      <CardShell glow testId="free-match-home-reward" className={className}>
        <Chip><Gift className="h-3 w-3" />{free.free}</Chip>
        <p className="mt-3 font-display text-[24px] font-extrabold leading-tight">{free.applied}</p>
        <p className="mt-1 text-sm text-muted-text">{free.appliedSub(status.reward.freeHours, shortDate(status.reward.expiresAt))}</p>
        {status.reward.kind === "loyalty" && <p className="mt-1 text-sm text-muted-text">{free.loyaltyEarned(status.loyalty.every)}</p>}
        {canBook && <Link href="/book" className={cn(primaryButton, "mt-4")} data-testid="link-free-match-book">{free.bookFree}</Link>}
      </CardShell>
    );
  }
  // Once per player: after his one free match, the challenge stops showing.
  if (!status.enabled || !status.canEarn || attempt?.capped) return null;
  if (!attempt && !introOpen) return null;

  const steps = stepsFor(attempt, status);
  const done = steps.filter((step) => step.state === "done").length;
  const label = (key: (typeof steps)[number]["key"], state: StepState) => {
    switch (key) {
      case "account": return free.stepAccount;
      case "book": return attempt ? attempt.fieldName : free.stepBook;
      case "pay": return state === "waiting" ? free.stepPayWaiting : free.stepPay;
      case "find": return free.stepFind;
      case "friends": return attempt && attempt.bookerFound
        ? free.stepFriendsCount(attempt.friendsFound, status.friendsRequired)
        : free.stepFriends(status.friendsRequired);
    }
  };
  const next = steps.find((step) => step.state === "next" || step.state === "waiting");
  const afterWhistle = attempt ? AFTER_WHISTLE.includes(attempt.phase) : false;

  let action: ReactNode = null;
  if (!attempt) {
    action = canBook && !hideStartAction ? <Link href="/book" className={primaryButton} data-testid="link-free-match-start">{free.book}</Link> : null;
  } else if (next?.key === "find" && attempt.findRecordingId) {
    action = <Link href={`/find/${attempt.findRecordingId}`} className={primaryButton} data-testid="link-free-match-find">{free.findMe}</Link>;
  } else if (next?.key === "friends") {
    action = (
      <button type="button" onClick={() => void share(attempt.code)} className={primaryButton} data-testid="button-free-match-share">
        <Share2 className="h-4 w-4" />{free.sendLink}
      </button>
    );
  } else {
    action = <Link href={`/m/${attempt.code}`} className={primaryButton} data-testid="link-free-match-open">{free.open}</Link>;
  }

  return (
    <CardShell glow={Boolean(attempt)} testId="free-match-home" className={className}>
      <div className="flex items-center justify-between gap-3">
        <Chip>{free.chip} · {free.of(done, steps.length)}</Chip>
        {!attempt && <button type="button" onClick={hideIntro} className="-me-2 min-h-9 rounded-full px-3 text-xs font-semibold text-muted-text">{explainer.firstClip.hide}</button>}
      </div>
      <p className="mt-3 font-display text-[24px] font-extrabold leading-tight">{free.title}</p>
      {!attempt && <p className="mt-1 text-sm leading-5 text-muted-text">{free.lead(status.friendsRequired)}</p>}
      <ol className="m-0 mt-4 flex list-none flex-col gap-2.5 p-0">
        {steps.map((step, index) => (
          <li key={step.key} className="flex items-center gap-3">
            <span className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-bold",
              step.state === "done" ? "border-floodlight bg-floodlight text-void"
                : step.state === "next" || step.state === "waiting" ? "border-floodlight text-floodlight" : "border-line text-muted-text",
            )}>
              {step.state === "done" ? <Check className="h-4 w-4" strokeWidth={3} /> : step.state === "waiting" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : index + 1}
            </span>
            <span className={cn("min-w-0 flex-1 truncate text-[15px]", step.state === "done" ? "text-muted-text" : step.state === "todo" ? "text-muted-text" : "font-bold")}>
              {label(step.key, step.state)}
            </span>
            {step.key === "book" && !attempt && <span className="shrink-0 text-xs text-muted-text">{free.stepBookSub(formatJod(status.pricePerHourFils))}</span>}
          </li>
        ))}
      </ol>
      {attempt && afterWhistle && attempt.deadline && (
        <p className="mt-3 text-xs text-muted-text">{free.deadline(shortDate(attempt.deadline))}</p>
      )}
      <div className="mt-4 flex flex-col gap-1">
        {action}
        <button type="button" onClick={() => setRulesOpen(true)} className={quietButton} data-testid="button-free-match-how">{free.how}</button>
      </div>
      {rules}
    </CardShell>
  );
}

// ---------------------------------------------------------------- the match page

/** The challenge on the match it is running on, for the booker. */
export function FreeMatchRoomCard({ status, code, onShare }: { status: FreeMatchStatus | null | undefined; code: string; onShare: () => void }) {
  const free = useExplainerCopy().free;
  const shortDate = useShortDate();
  const [rulesOpen, setRulesOpen] = useState(false);
  if (!status) return null;
  const rules = <FreeMatchRulesSheet open={rulesOpen} onOpenChange={setRulesOpen} status={status} canBook />;

  const earned = status.latestEarned?.sourceCode === code ? status.latestEarned : null;
  if (earned) return <FreeMatchUnlocked reward={earned} status={status} />;

  const attempt = status.attempt?.code === code ? status.attempt : null;
  if (!attempt || attempt.capped || !status.enabled) return null;

  // Before the whistle: the booking counts; say what happens next.
  if (!AFTER_WHISTLE.includes(attempt.phase)) {
    return (
      <CardShell testId="free-match-room-pre">
        <Chip>{attempt.payPending ? free.stepPayWaiting : free.cliqCounts}</Chip>
        <p className="mt-2 text-sm leading-5">{free.cliqProgress}</p>
        <button type="button" onClick={() => setRulesOpen(true)} className={cn(quietButton, "-ms-4 mt-1")}>{free.how}</button>
        {rules}
      </CardShell>
    );
  }

  // After the whistle, his turn first.
  if (!attempt.bookerFound) {
    return (
      // The report's own "find yourself" card sits right above with the button, so this stays a one-line note.
      <CardShell testId="free-match-room-find">
        <Chip>{free.chip} · {free.of(attempt.paid ? 3 : 2, 5)}</Chip>
        <p className="mt-2 text-sm leading-5">{free.reportNote}</p>
      </CardShell>
    );
  }

  // Then his friends.
  const left = Math.max(0, status.friendsRequired - attempt.friendsFound);
  return (
    <CardShell glow testId="free-match-room-friends">
      <Chip>{free.chip} · {free.stepFriendsCount(attempt.friendsFound, status.friendsRequired)}</Chip>
      <p className="mt-3 font-display text-[22px] font-extrabold leading-tight">{free.friendsLeft(left)}</p>
      <p className="mt-1 text-sm leading-5 text-muted-text">{free.friendsLead}</p>
      <div className="mt-3 flex gap-1.5" aria-hidden>
        {Array.from({ length: status.friendsRequired }, (_, index) => (
          <span key={index} className={cn("h-1.5 flex-1 rounded-full", index < attempt.friendsFound ? "bg-floodlight" : "bg-raised")} />
        ))}
      </div>
      {attempt.deadline && <p className="mt-2 text-xs text-muted-text">{free.deadline(shortDate(attempt.deadline))}</p>}
      {attempt.friends.length > 0 && (
        <ul className="m-0 mt-4 flex list-none flex-col gap-2 p-0">
          {attempt.friends.slice(0, 12).map((friend) => (
            <li key={friend.userId} className="flex items-center gap-3">
              <PlayerAvatar name={friend.name} avatarUrl={friend.avatarUrl} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold">{friend.name}</span>
                <span className={cn("block text-xs", friend.found ? "text-floodlight" : "text-muted-text")}>{friend.found ? free.foundSelf : free.notFound}</span>
              </span>
              {friend.found
                ? <Check className="h-4 w-4 text-floodlight" strokeWidth={3} />
                : <button type="button" onClick={onShare} aria-label={free.remindName(friend.name)} className="min-h-9 shrink-0 rounded-full border border-line px-3 text-xs font-semibold">{free.remind}</button>}
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onShare} className={cn(primaryButton, "mt-4")} data-testid="button-free-match-room-share">
        <Share2 className="h-4 w-4" />{free.sendLink}
      </button>
    </CardShell>
  );
}

/** The moment it's done: what the free match is and a way to book it. */
function FreeMatchUnlocked({ reward, status }: { reward: FreeMatchReward; status: FreeMatchStatus }) {
  const free = useExplainerCopy().free;
  const { locale } = useLocale();
  const shortDate = useShortDate();
  const rows = [
    { label: free.recording, value: free.recordingValue(reward.freeHours) },
    { label: free.pitch, value: free.anyPitch },
    { label: free.useBy, value: shortDate(reward.expiresAt) },
    { label: free.worth, value: free.worthValue(formatJod(reward.worthFils)) },
  ];
  return (
    <CardShell glow testId="free-match-unlocked">
      <Chip><Sparkles className="h-3 w-3" />{free.unlockedChip(status.friendsRequired)}</Chip>
      <p className="mt-3 font-display text-[26px] font-extrabold leading-tight">{free.rule4Title}</p>
      <p className="mt-1 text-sm leading-5 text-muted-text">{free.unlockedLead(status.friendsRequired)}</p>
      <dl className="m-0 mt-4 grid grid-cols-2 gap-2">
        {rows.map((row) => (
          <div key={row.label} className="rounded-xl bg-raised px-3 py-2.5">
            <dt className="text-[11px] text-muted-text">{row.label}</dt>
            <dd className="m-0 mt-0.5 text-sm font-bold">{row.value}</dd>
          </div>
        ))}
      </dl>
      {reward.thanks.length > 0 && <p className="mt-3 text-xs text-muted-text">{free.thanks(reward.thanks.join(locale === "ar" ? "، " : ", "))}</p>}
      {reward.status === "available"
        ? <Link href="/book" className={cn(primaryButton, "mt-4")} data-testid="link-free-match-unlocked-book">{free.bookFree}<ChevronRight className="h-4 w-4 rtl:rotate-180" /></Link>
        : reward.usedCode && <Link href={`/m/${reward.usedCode}`} className={cn(quietButton, "mt-2 w-full border border-line")}>{free.open}</Link>}
    </CardShell>
  );
}

// ---------------------------------------------------------------- every N games, one free

/** Home's punch card: one ball per paid game played in the current block. */
export function LoyaltyCard({ status, canBook, className, hideStartAction = false }: { status: FreeMatchStatus; canBook: boolean; className?: string; hideStartAction?: boolean }) {
  const free = useExplainerCopy().free;
  const { loyalty } = status;
  if (!loyalty?.enabled) return null;
  const left = loyalty.every - loyalty.count;
  return (
    <section className={cn("rounded-2xl border border-line bg-surface px-5 py-4", className)} data-testid="loyalty-card">
      <div className="flex items-center justify-between gap-3">
        <p className="font-display text-[18px] font-extrabold leading-tight">{free.loyaltyTitle(loyalty.every)}</p>
        <Chip tone="turf">{free.loyaltyCount(loyalty.count, loyalty.every)}</Chip>
      </div>
      <ol className="m-0 mt-3 flex list-none gap-2 p-0" aria-label={free.loyaltyCount(loyalty.count, loyalty.every)}>
        {Array.from({ length: loyalty.every }, (_, index) => (
          <li
            key={index}
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-full border-2 text-[12px] font-bold",
              index < loyalty.count ? "border-turf bg-turf text-void" : "border-line text-muted-text",
            )}
          >
            {index < loyalty.count ? <Check className="h-4 w-4" strokeWidth={3} /> : index + 1}
          </li>
        ))}
        <li className="flex h-9 items-center justify-center rounded-full bg-floodlight/15 px-3 text-[12px] font-bold text-floodlight">
          <Gift className="me-1 h-3.5 w-3.5" />{free.free}
        </li>
      </ol>
      <p className="mt-3 text-sm text-muted-text">{loyalty.total === 0 ? free.loyaltyStart(loyalty.every) : free.loyaltyLeft(left)}</p>
      <p className="mt-1 text-[11.5px] text-muted-text/80">{free.loyaltyRule}</p>
      {canBook && !hideStartAction && loyalty.total === 0 && (
        <Link href="/book" className="mt-3 inline-flex min-h-10 items-center text-sm font-bold text-turf" data-testid="link-loyalty-book">
          {free.book}<ChevronRight className="h-4 w-4 rtl:rotate-180" />
        </Link>
      )}
    </section>
  );
}
