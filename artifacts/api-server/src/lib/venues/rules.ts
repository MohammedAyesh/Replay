/**
 * A field's booking rules (Field console → Payments → Booking rules), as pure functions:
 * what a player must pay online, and what cancelling, missing or moving a booking costs.
 * Every channel uses these: the console, the website, the WhatsApp agent and its menu.
 *
 * A booking keeps a snapshot of the rules it was made under (venue_bookings.policy), so a
 * field changing its rules later doesn't change what an existing booking costs.
 */

export type Policy = {
  depositMode: "full" | "deposit" | "none";
  depositFils: number;
  depositPercent: number;
  payAtField: boolean;
  acceptCliq: boolean;
  newCustomerPolicy: "same" | "deposit" | "full";
  noShowPolicy: "same" | "deposit" | "full" | "block";
  cancelHours: number;
  lateCancelMode: "refuse" | "free" | "deposit" | "percent" | "fixed";
  lateCancelValue: number;
  noShowFeeMode: "none" | "deposit" | "percent" | "fixed";
  noShowFeeValue: number;
  allowChanges: boolean;
  changeHours: number;
  changeFeeFils: number;
  maxChanges: number;
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
const int = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};

/** The rules from a settings row, or from a booking's stored snapshot (filled with defaults). */
export function policyOf(source: Record<string, unknown> | null | undefined): Policy {
  const s = source ?? {};
  return {
    depositMode: pick(s.depositMode, ["full", "deposit", "none"] as const, "full"),
    depositFils: int(s.depositFils, 0, 0, 10_000_000),
    depositPercent: int(s.depositPercent, 0, 0, 100),
    payAtField: s.payAtField !== false,
    acceptCliq: s.acceptCliq !== false,
    newCustomerPolicy: pick(s.newCustomerPolicy, ["same", "deposit", "full"] as const, "same"),
    noShowPolicy: pick(s.noShowPolicy, ["same", "deposit", "full", "block"] as const, "same"),
    cancelHours: int(s.cancelHours, 6, 0, 168),
    lateCancelMode: pick(s.lateCancelMode, ["refuse", "free", "deposit", "percent", "fixed"] as const, "refuse"),
    lateCancelValue: int(s.lateCancelValue, 0, 0, 10_000_000),
    noShowFeeMode: pick(s.noShowFeeMode, ["none", "deposit", "percent", "fixed"] as const, "deposit"),
    noShowFeeValue: int(s.noShowFeeValue, 0, 0, 10_000_000),
    allowChanges: s.allowChanges !== false,
    changeHours: int(s.changeHours, 6, 0, 168),
    changeFeeFils: int(s.changeFeeFils, 0, 0, 1_000_000),
    maxChanges: int(s.maxChanges, 2, 0, 20),
  };
}

/** The deposit on a price: a percent when set, else the fixed amount; never more than the price. */
export function depositFor(policy: Policy, amountFils: number): number {
  const raw = policy.depositPercent > 0 ? Math.round((amountFils * policy.depositPercent) / 100) : policy.depositFils;
  return Math.max(0, Math.min(amountFils, raw));
}

/** What the player has done here before: games played (confirmed or played, in the past) and no-shows. */
export type History = { played: number; noShows: number };

export type Requirement = {
  /** Paying at the field (nothing online) is allowed for this player. */
  fieldAllowed: boolean;
  /** What is due online if they pay online (CliQ or card). */
  onlineDueFils: number;
  /** At least this much must be paid online, whatever they choose. 0 = they may pay at the field. */
  minimumOnlineFils: number;
  reason: "standard" | "new_customer" | "no_show";
  /** A no-show the field won't take online bookings from. */
  blocked: boolean;
};

export function requirement(policy: Policy, history: History, amountFils: number, online: { cliq: boolean; card: boolean }): Requirement {
  const canPayOnline = (online.cliq && policy.acceptCliq) || online.card;
  const standard = policy.depositMode === "full" ? amountFils : policy.depositMode === "deposit" ? depositFor(policy, amountFils) : 0;
  let minimum = 0;
  let reason: Requirement["reason"] = "standard";
  if (history.noShows > 0 && policy.noShowPolicy !== "same") {
    if (policy.noShowPolicy === "block") return { fieldAllowed: false, onlineDueFils: 0, minimumOnlineFils: 0, reason: "no_show", blocked: true };
    minimum = policy.noShowPolicy === "full" ? amountFils : depositFor(policy, amountFils);
    reason = "no_show";
  } else if (history.played === 0 && policy.newCustomerPolicy !== "same") {
    minimum = policy.newCustomerPolicy === "full" ? amountFils : depositFor(policy, amountFils);
    reason = "new_customer";
  }
  // A rule asking for money online can't apply when the field takes no online payment.
  if (!canPayOnline) minimum = 0;
  if (minimum === 0 && reason !== "standard" && canPayOnline) reason = "standard";
  const onlineDue = canPayOnline ? Math.max(standard, minimum) : 0;
  return {
    fieldAllowed: minimum === 0 && (policy.payAtField || !canPayOnline || policy.depositMode === "none"),
    onlineDueFils: onlineDue,
    minimumOnlineFils: minimum,
    reason: minimum > 0 ? reason : "standard",
    blocked: false,
  };
}

export type Money = { amountFils: number; paidFils: number; dueOnlineFils: number; feeFils: number; startsAt: Date; changeCount: number; status: string };

export type CancelQuote = {
  allowed: boolean;
  late: boolean;
  feeFils: number;
  /** Paid money that goes back to the player. */
  refundFils: number;
  /** Fee the player still owes (the fee is more than they paid). */
  owedFils: number;
  hoursBefore: number;
};

function keptDeposit(policy: Policy, b: Money): number {
  return b.dueOnlineFils > 0 && b.dueOnlineFils < b.amountFils ? b.dueOnlineFils : depositFor(policy, b.amountFils) || b.dueOnlineFils;
}

/** What cancelling costs. The field cancelling never costs the player anything. */
export function cancelQuote(policy: Policy, b: Money, by: "player" | "field", now = Date.now()): CancelQuote {
  const hoursBefore = (b.startsAt.getTime() - now) / 3_600_000;
  const paid = b.paidFils;
  if (by === "field") return { allowed: true, late: false, feeFils: 0, refundFils: paid, owedFils: 0, hoursBefore };
  const late = hoursBefore < policy.cancelHours;
  // An unconfirmed hold commits the player to nothing: dropping it is always free.
  if (b.status === "held") return { allowed: true, late, feeFils: 0, refundFils: paid, owedFils: 0, hoursBefore };
  if (!late || policy.lateCancelMode === "free") return { allowed: true, late, feeFils: 0, refundFils: paid, owedFils: 0, hoursBefore };
  if (policy.lateCancelMode === "refuse") return { allowed: false, late, feeFils: 0, refundFils: 0, owedFils: 0, hoursBefore };
  const raw = policy.lateCancelMode === "deposit" ? keptDeposit(policy, b)
    : policy.lateCancelMode === "percent" ? Math.round((b.amountFils * Math.min(100, policy.lateCancelValue)) / 100)
    : policy.lateCancelValue;
  const fee = Math.max(0, Math.min(b.amountFils, raw));
  return { allowed: true, late, feeFils: fee, refundFils: Math.max(0, paid - fee), owedFils: Math.max(0, fee - paid), hoursBefore };
}

/** What a no-show costs. What they paid is kept; the fee may ask for more. */
export function noShowQuote(policy: Policy, b: Money): { feeFils: number; owedFils: number } {
  const raw = policy.noShowFeeMode === "none" ? 0
    : policy.noShowFeeMode === "deposit" ? keptDeposit(policy, b)
    : policy.noShowFeeMode === "percent" ? Math.round((b.amountFils * Math.min(100, policy.noShowFeeValue)) / 100)
    : policy.noShowFeeValue;
  const fee = Math.max(0, Math.min(b.amountFils, raw));
  return { feeFils: fee, owedFils: Math.max(0, fee - b.paidFils) };
}

export type ChangeQuote = { allowed: boolean; reason: "ok" | "off" | "too_late" | "too_many" | "not_active"; feeFils: number; changesLeft: number };

/** Whether a player may move their own booking now, and what it costs. */
export function changeQuote(policy: Policy, b: Money, now = Date.now()): ChangeQuote {
  const changesLeft = Math.max(0, policy.maxChanges - b.changeCount);
  if (b.status !== "held" && b.status !== "confirmed") return { allowed: false, reason: "not_active", feeFils: 0, changesLeft };
  if (!policy.allowChanges) return { allowed: false, reason: "off", feeFils: 0, changesLeft };
  if (changesLeft <= 0) return { allowed: false, reason: "too_many", feeFils: 0, changesLeft };
  if ((b.startsAt.getTime() - now) / 3_600_000 < policy.changeHours) return { allowed: false, reason: "too_late", feeFils: 0, changesLeft };
  return { allowed: true, reason: "ok", feeFils: policy.changeFeeFils, changesLeft };
}

/** What's left to pay on a live booking (price + fees − paid). */
export function balanceOf(b: { amountFils: number; feeFils: number; paidFils: number }): number {
  return Math.max(0, b.amountFils + b.feeFils - b.paidFils);
}

const jod = (fils: number, ar: boolean) => {
  const n = fils / 1000;
  const text = Number.isInteger(n) ? String(n) : n.toFixed(n * 10 === Math.round(n * 10) ? 1 : 2);
  return ar ? `${text} دينار` : `${text} JOD`;
};

/**
 * The field's rules in a few plain lines, for the booking site, the WhatsApp agent's prompt
 * and its "my bookings" menu. Only rules that apply are mentioned.
 */
export function rulesSummary(policy: Policy, locale: "ar" | "en"): string[] {
  const ar = locale === "ar";
  const lines: string[] = [];
  const deposit = policy.depositPercent > 0 ? (ar ? `${policy.depositPercent}٪ من السعر` : `${policy.depositPercent}% of the price`) : jod(policy.depositFils, ar);
  if (policy.depositMode === "full") lines.push(ar ? "الدفع كامل أونلاين عند الحجز." : "Paid in full online when you book.");
  else if (policy.depositMode === "deposit") lines.push(ar ? `عربون ${deposit} أونلاين، والباقي بالملعب.` : `A deposit of ${deposit} online; the rest at the field.`);
  else lines.push(ar ? "الدفع بالملعب." : "Pay at the field.");
  if (policy.newCustomerPolicy !== "same") {
    lines.push(policy.newCustomerPolicy === "full"
      ? (ar ? "أول حجز: الدفع كامل أونلاين." : "First booking: paid in full online.")
      : (ar ? `أول حجز: عربون ${deposit} أونلاين.` : `First booking: a deposit of ${deposit} online.`));
  }
  if (policy.lateCancelMode === "free") lines.push(ar ? "الإلغاء مجاني بأي وقت." : "Cancel free at any time.");
  else {
    const h = policy.cancelHours;
    const fee = policy.lateCancelMode === "refuse" ? null
      : policy.lateCancelMode === "deposit" ? (ar ? "بتخسر العربون" : "the deposit is kept")
      : policy.lateCancelMode === "percent" ? (ar ? `رسوم ${policy.lateCancelValue}٪ من السعر` : `a fee of ${policy.lateCancelValue}% of the price`)
      : (ar ? `رسوم ${jod(policy.lateCancelValue, true)}` : `a ${jod(policy.lateCancelValue, false)} fee`);
    lines.push(ar
      ? `الإلغاء مجاني لحد ${h} ساعات قبل الموعد${fee ? `؛ بعدها ${fee}.` : "؛ بعدها احكي مع الملعب."}`
      : `Cancel free up to ${h} hours before kick-off${fee ? `; after that, ${fee}.` : "; after that, message the field."}`);
  }
  if (policy.allowChanges && policy.maxChanges > 0) {
    lines.push(ar
      ? `تغيير الموعد لحد ${policy.changeHours} ساعات قبل${policy.changeFeeFils ? ` برسوم ${jod(policy.changeFeeFils, true)}` : " مجاناً"} (${policy.maxChanges} ${policy.maxChanges === 1 ? "مرة" : "مرات"} كحد أقصى).`
      : `Change the time up to ${policy.changeHours} hours before${policy.changeFeeFils ? ` for ${jod(policy.changeFeeFils, false)}` : ", free"} (up to ${policy.maxChanges} ${policy.maxChanges === 1 ? "time" : "times"}).`);
  } else lines.push(ar ? "لتغيير الموعد احكي مع الملعب." : "To change the time, message the field.");
  if (policy.noShowFeeMode !== "none") {
    const fee = policy.noShowFeeMode === "deposit" ? (ar ? "بتخسر العربون" : "the deposit is kept")
      : policy.noShowFeeMode === "percent" ? (ar ? `رسوم ${policy.noShowFeeValue}٪` : `a ${policy.noShowFeeValue}% fee`)
      : (ar ? `رسوم ${jod(policy.noShowFeeValue, true)}` : `a ${jod(policy.noShowFeeValue, false)} fee`);
    if (policy.noShowFeeMode !== "deposit" || policy.depositMode !== "none") lines.push(ar ? `عدم الحضور: ${fee}.` : `No-show: ${fee}.`);
  }
  return lines;
}
