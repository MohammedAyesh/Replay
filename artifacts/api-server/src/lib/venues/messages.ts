/**
 * The WhatsApp messages a booking sends, in Ammani Arabic and English. The owner can switch
 * each one off in Field console → Booking agent → Messages.
 */
import { formatJod } from "./core";

export type Locale = "ar" | "en";

export type BookingFacts = {
  venue: string;
  name: string | null;
  pitch: string;
  /** "Thursday 5 Nov" / "الخميس 5/11" */
  day: string;
  time: string;
  minutes: number;
  amountFils: number;
  dueOnlineFils: number;
  reference: string;
  alias: string | null;
  aliasName: string | null;
  holdUntil: string | null;
  cardUrl: string | null;
  balanceFils: number;
  link: string | null;
  feeFils?: number;
  refundFils?: number;
  /** Why something is due online: the field's standard rule, a first booking, or a past no-show. */
  reason?: "standard" | "new_customer" | "no_show";
  /** The match page (replayjo.com/m/<code>): teams, who's coming, the video after the whistle. Pitches with a camera. */
  matchLink?: string | null;
  /** The booking site's "Manage my booking", with the code filled in. */
  manageLink?: string | null;
  /** Changing and cancelling, from the booking's own policy; the deadlines already in words ("Thursday 5 Nov, 3:00 pm"). */
  terms?: BookingTerms | null;
};

export type BookingTerms = {
  change: { allowed: boolean; until: string | null; feeFils: number };
  /** until null: the free window has passed (or there is none). */
  cancel: { until: string | null; late: "refuse" | "free" | "deposit" | "percent" | "fixed"; value: number };
};

const AR_DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const EN_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "الخميس 5/11" or "Thursday 5 Nov" for a "YYYY-MM-DD". */
export function dayLabel(date: string, locale: Locale): string {
  const d = new Date(`${date}T00:00:00Z`);
  return locale === "ar"
    ? `${AR_DAYS[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`
    : `${EN_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${EN_MONTHS[d.getUTCMonth()]}`;
}

/** "9:30 م" or "9:30 pm" for "HH:MM". */
export function timeLabel(time: string, locale: Locale): string {
  const [h, m] = time.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  const pm = h % 24 >= 12;
  return locale === "ar" ? `${hour}:${String(m).padStart(2, "0")} ${pm ? "م" : "ص"}` : `${hour}:${String(m).padStart(2, "0")} ${pm ? "pm" : "am"}`;
}

export function durationLabel(minutes: number, locale: Locale): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (locale === "ar") {
    const hours = h === 1 ? "ساعة" : h === 2 ? "ساعتين" : h > 0 ? `${h} ساعات` : "";
    if (m === 0) return hours;
    if (m === 30) return h ? `${hours} ونص` : "نص ساعة";
    return `${hours}${h ? " و" : ""}${m} دقيقة`;
  }
  if (m === 0) return h === 1 ? "1 hour" : `${h} hours`;
  return h ? `${h} h ${m} min` : `${m} min`;
}

function greet(f: BookingFacts, locale: Locale): string {
  const first = f.name?.trim().split(/\s+/)[0];
  if (locale === "ar") return first ? `أهلين ${first} 👋` : "أهلين 👋";
  return first ? `Hi ${first} 👋` : "Hi 👋";
}

function when(f: BookingFacts, locale: Locale): string {
  return locale === "ar"
    ? `${f.pitch}، ${f.day} الساعة ${f.time} (${durationLabel(f.minutes, "ar")})`
    : `${f.pitch}, ${f.day} at ${f.time} (${durationLabel(f.minutes, "en")})`;
}

/** How to pay, for a booking held until it's paid. */
export function paymentInstructions(f: BookingFacts, locale: Locale): string {
  const lines: string[] = [];
  if (locale === "ar") {
    lines.push(`${greet(f, locale)} حجزنالك ${when(f, locale)}.`);
    lines.push(`المبلغ: ${formatJod(f.amountFils, "ar")}${f.dueOnlineFils < f.amountFils ? ` — العربون ${formatJod(f.dueOnlineFils, "ar")} والباقي بالملعب` : ""}.`);
    if (f.reason === "new_customer") lines.push("لأنه أول حجز إلك عنا، لازم تدفع هالمبلغ أونلاين عشان نثبّت الموعد.");
    if (f.reason === "no_show") lines.push("عشان نثبّت الموعد لازم تدفع هالمبلغ أونلاين.");
    if (f.cardUrl) lines.push(`ادفع بالبطاقة أو Apple Pay من هون: ${f.cardUrl}`);
    if (f.alias) {
      lines.push(`${f.cardUrl ? "أو حوّل" : "حوّل"} ${formatJod(f.dueOnlineFils, "ar")} على كليك: *${f.alias}*${f.aliasName ? ` (${f.aliasName})` : ""}`);
      lines.push(`واكتب بالملاحظات رقم الحجز: *${f.reference}*`);
      lines.push("وابعتلنا صورة الإيصال هون 📸");
    }
    if (f.holdUntil) lines.push(`الموعد محجوزلك لحد الساعة ${f.holdUntil}، بعدها بنفتحه لغيرك.`);
    return lines.join("\n");
  }
  lines.push(`${greet(f, locale)} We've held ${when(f, locale)} for you.`);
  lines.push(`Price: ${formatJod(f.amountFils)}${f.dueOnlineFils < f.amountFils ? ` — ${formatJod(f.dueOnlineFils)} deposit now, the rest at the field` : ""}.`);
  if (f.reason === "new_customer") lines.push("As it's your first booking with us, this is paid online to secure the slot.");
  if (f.reason === "no_show") lines.push("This is paid online to secure the slot.");
  if (f.cardUrl) lines.push(`Pay by card or Apple Pay here: ${f.cardUrl}`);
  if (f.alias) {
    lines.push(`${f.cardUrl ? "Or send" : "Send"} ${formatJod(f.dueOnlineFils)} by CliQ to *${f.alias}*${f.aliasName ? ` (${f.aliasName})` : ""}`);
    lines.push(`with the booking code *${f.reference}* in the note,`);
    lines.push("then send us a photo of the receipt here 📸");
  }
  if (f.holdUntil) lines.push(`We'll keep the slot until ${f.holdUntil}.`);
  return lines.join("\n");
}

/** "Free cancellation until …", what happens after, and the change rule. */
export function termsLines(t: BookingTerms, locale: Locale): string[] {
  const ar = locale === "ar";
  const out: string[] = [];
  const c = t.cancel;
  if (c.late === "free") {
    out.push(ar ? "❌ الإلغاء مجاني لحد بداية الماتش" : "❌ Free cancellation up to kick-off");
  } else {
    const after = c.late === "refuse" ? (ar ? "بعدها ما بنقدر نلغيه" : "after that it can't be cancelled")
      : c.late === "deposit" ? (ar ? "بعدها بينخصم العربون" : "after that the deposit is kept")
      : c.late === "percent" ? (ar ? `بعدها رسوم ${c.value}% من السعر` : `after that there's a ${c.value}% fee`)
      : (ar ? `بعدها رسوم ${formatJod(c.value, "ar")}` : `after that there's a ${formatJod(c.value)} fee`);
    out.push(c.until
      ? (ar ? `❌ الإلغاء مجاني لحد ${c.until}، ${after}` : `❌ Free cancellation until ${c.until}; ${after}`)
      : (ar ? `❌ إلغاء الحجز: ${after.replace(/^بعدها /, "")}` : `❌ Cancelling now: ${after.replace(/^after that /, "")}`));
  }
  if (t.change.allowed && t.change.until) {
    const fee = t.change.feeFils > 0 ? (ar ? ` (رسوم ${formatJod(t.change.feeFils, "ar")})` : ` (${formatJod(t.change.feeFils)} fee)`) : "";
    out.push(ar ? `✏️ بتقدر تغيّر الموعد لحد ${t.change.until}${fee}` : `✏️ You can change the time until ${t.change.until}${fee}`);
  }
  return out;
}

/** The match page, how to change or cancel, and by when: under every confirmation. */
function bookingExtras(f: BookingFacts, locale: Locale): string[] {
  const ar = locale === "ar";
  const out: string[] = [];
  if (f.matchLink) out.push(ar ? `🎥 صفحة الماتش (الفرق، مين جاي، والفيديو بعد الصافرة):\n${f.matchLink}` : `🎥 Your match page (teams, who's coming, the video after the whistle):\n${f.matchLink}`);
  if (f.terms) out.push(...termsLines(f.terms, locale));
  const canChange = !!f.terms?.change.allowed && !!f.terms.change.until;
  if (f.manageLink) {
    out.push(ar ? `${canChange ? "للتغيير أو الإلغاء" : "للإلغاء"}: ${f.manageLink}` : `${canChange ? "Change or cancel" : "Cancel"}: ${f.manageLink}`);
  }
  return out;
}

export function confirmedMessage(f: BookingFacts, locale: Locale): string {
  if (locale === "ar") {
    return [
      `تم تأكيد حجزك ✅`,
      when(f, locale),
      `رقم الحجز: ${f.reference}`,
      f.balanceFils > 0 ? `المطلوب بالملعب: ${formatJod(f.balanceFils, "ar")}` : null,
      ...bookingExtras(f, locale),
      `نشوفك بالملعب ⚽`,
    ].filter(Boolean).join("\n");
  }
  return [
    "Your booking is confirmed ✅",
    when(f, locale),
    `Booking code: ${f.reference}`,
    f.balanceFils > 0 ? `To pay at the field: ${formatJod(f.balanceFils)}` : null,
    ...bookingExtras(f, locale),
    "See you on the pitch ⚽",
  ].filter(Boolean).join("\n");
}

export function paidMessage(f: BookingFacts, locale: Locale): string {
  return locale === "ar"
    ? `وصلنا المبلغ، يعطيك العافية 🙏\n${confirmedMessage(f, locale)}`
    : `Payment received, thank you 🙏\n${confirmedMessage(f, locale)}`;
}

export function reminderMessage(f: BookingFacts, locale: Locale): string {
  return locale === "ar"
    ? `تذكير ⏰ عندك حجز ${when(f, locale)}.${f.balanceFils > 0 ? `\nالمطلوب بالملعب: ${formatJod(f.balanceFils, "ar")}` : ""}\nإذا صار أي تغيير احكيلنا.`
    : `Reminder ⏰ you're booked on ${when(f, locale)}.${f.balanceFils > 0 ? `\nTo pay at the field: ${formatJod(f.balanceFils)}` : ""}\nLet us know if anything changes.`;
}

export function cancelledMessage(f: BookingFacts, locale: Locale): string {
  const money: string[] = [];
  if (f.feeFils) money.push(locale === "ar" ? `رسوم الإلغاء المتأخر: ${formatJod(f.feeFils, "ar")}` : `Late cancellation fee: ${formatJod(f.feeFils)}`);
  if (f.refundFils) money.push(locale === "ar" ? `رح نرجعلك ${formatJod(f.refundFils, "ar")}` : `We'll refund ${formatJod(f.refundFils)}`);
  if (f.feeFils && f.balanceFils) money.push(locale === "ar" ? `المطلوب منك: ${formatJod(f.balanceFils, "ar")}` : `Still to pay: ${formatJod(f.balanceFils)}`);
  const head = locale === "ar"
    ? `تم إلغاء حجزك (${f.reference}) — ${when(f, locale)}.`
    : `Your booking ${f.reference} — ${when(f, locale)} — is cancelled.`;
  const tail = locale === "ar" ? "إذا بدك موعد ثاني احكيلنا." : "Message us if you'd like another time.";
  return [head, ...money, tail].join("\n");
}

export function changedMessage(f: BookingFacts, locale: Locale): string {
  return locale === "ar"
    ? [`تم تغيير موعد حجزك ✅`, when(f, locale), `رقم الحجز: ${f.reference}`, f.balanceFils > 0 ? `المطلوب بالملعب: ${formatJod(f.balanceFils, "ar")}` : null, ...bookingExtras(f, locale)].filter(Boolean).join("\n")
    : ["Your booking has moved ✅", when(f, locale), `Booking code: ${f.reference}`, f.balanceFils > 0 ? `To pay at the field: ${formatJod(f.balanceFils)}` : null, ...bookingExtras(f, locale)].filter(Boolean).join("\n");
}

export function expiredMessage(f: BookingFacts, locale: Locale): string {
  return locale === "ar"
    ? `ما وصلنا الدفع لحجز ${when(f, locale)}، فرجعنا فتحنا الموعد.\nإذا لسا بدك ياه احكيلنا ومنشوف إذا لسا فاضي.`
    : `We didn't receive payment for ${when(f, locale)}, so the slot is open again.\nMessage us if you still want it and we'll check it's free.`;
}

/**
 * The match video is ready. `rebook`: the same kick-off next week on the same pitch, still free,
 * and the booking site (Mohammed, 2026-11-07: "same time next week?" after every filmed game).
 */
export function videoReadyMessage(f: BookingFacts, locale: Locale, rebook: { day: string; time: string; link: string } | null = null): string {
  const base = locale === "ar"
    ? `فيديو مباراتكم بـ${f.venue} جاهز 🎥\n${f.link}\nشاركوه مع الشباب وقصّوا أحلى لقطاتكم!`
    : `Your match video from ${f.venue} is ready 🎥\n${f.link}\nShare it with the team and clip your best moments!`;
  if (!rebook) return base;
  return locale === "ar"
    ? `${base}\n\nنفس الوقت الأسبوع الجاي؟ ${rebook.day} الساعة ${rebook.time} لسا فاضي. احجزوه من هون:\n${rebook.link}`
    : `${base}\n\nSame time next week? ${rebook.day} at ${rebook.time} is still free. Book it here:\n${rebook.link}`;
}

export function receiptReceivedMessage(locale: Locale): string {
  return locale === "ar"
    ? "وصلنا الإيصال 👍 رح نتأكد منه ونأكدلك الحجز بأقرب وقت."
    : "Got your receipt 👍 We'll check it and confirm your booking shortly.";
}
