/**
 * The WhatsApp booking agent of a field (Field console → Booking agent).
 *
 *   menu — numbered menus: book (day → pitch → length → time → name → [Instagram consent, ask mode] → how to pay), my bookings
 *          and cancelling, prices and hours, location, talk to someone.
 *   ai   — Claude reads free text in Ammani Arabic or English and books through the same
 *          functions (check_availability, create_booking, my_bookings, cancel_booking,
 *          handover). It never quotes a price or a free time it didn't get from a tool.
 *          Without ANTHROPIC_API_KEY, or when the call fails, it falls back to the menu.
 *
 * Both modes: a photo or PDF from someone with a booking waiting for payment is taken as the
 * CliQ receipt. The AI reads it (amount, receiver, booking code); with auto-confirm on and all
 * three matching, the booking is marked paid; otherwise the owner confirms it in Bookings.
 * The agent stays quiet in a chat for a while after someone from the field writes in it.
 */
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  academiesTable,
  academyWhatsappMessagesTable,
  db,
  fieldsTable,
  venueAgentThreadsTable,
  venueBookingsTable,
  venuePitchesTable,
  type VenueBooking,
} from "@workspace/db";
import { logger } from "../logger";
import { getWhatsappSettings, senderSessionFor } from "../whatsapp/queue";
import { chatIdForPhone } from "../whatsapp/phone";
import { mediaUrl, type WhatsappContent } from "../whatsapp/media";
import { setTyping } from "../whatsapp/waha";
import { addDays, ammanLocal, formatJod, normaliseDurations, normaliseHours, normaliseRules, openingWindow, wallMinutes, wallString } from "./core";
import { dayLabel, durationLabel, receiptReceivedMessage, timeLabel, type Locale } from "./messages";
import { consentMode, consentQuestion } from "./igConsent";
import {
  VenueError,
  availability,
  bookingFacts,
  bookingPolicy,
  cancelBooking,
  changeByPlayer,
  createBookings,
  loadVenue,
  markPaid,
  moneyOf,
  paymentTarget,
  quoteFor,
  sendVenueMessage,
  type Venue,
} from "./store";
import { cancelQuote, changeQuote, policyOf, rulesSummary } from "./rules";

type MenuStep = "menu" | "day" | "pitch" | "length" | "time" | "name" | "consent" | "pay" | "cancel" | "manage" | "confirm_cancel";
type Draft = { date?: string; pitchId?: number; minutes?: number; startLocal?: string; name?: string; igConsent?: boolean; options?: string[]; bookingId?: number; moveId?: number };
type ThreadState = { step?: MenuStep | null; draft?: Draft; menuAt?: number; nudgedAt?: number; locale?: Locale };

const HUMAN_KINDS = ["chat", "phone"];

export function agentApiKey(): string {
  return process.env.ANTHROPIC_API_KEY?.trim() || "";
}

function agentModel(): string {
  return process.env.BOOKING_AGENT_MODEL?.trim() || "claude-haiku-5-5";
}

function looksEnglish(text: string): boolean {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  return latin > 2 && arabic === 0;
}

function toAscii(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

function choice(text: string): number | null {
  const t = toAscii(text).trim().replace(/[.)\-️⃣\s]/g, "");
  return /^\d{1,2}$/.test(t) ? Number(t) : null;
}

async function loadThread(venueId: number, phone: string) {
  await db.insert(venueAgentThreadsTable).values({ academyId: venueId, phone }).onConflictDoNothing();
  const [row] = await db.select().from(venueAgentThreadsTable).where(and(eq(venueAgentThreadsTable.academyId, venueId), eq(venueAgentThreadsTable.phone, phone)));
  return row!;
}

async function saveThread(id: number, patch: Partial<typeof venueAgentThreadsTable.$inferInsert>) {
  await db.update(venueAgentThreadsTable).set({ ...patch, updatedAt: new Date() }).where(eq(venueAgentThreadsTable.id, id));
}

async function reply(venue: Venue, phone: string, text: string): Promise<void> {
  await sendVenueMessage(venue.id, phone, "agent", text.slice(0, 3500), null);
}

/** Someone from the field wrote in this chat lately: the agent keeps out. */
async function humanActive(venue: Venue, phone: string): Promise<boolean> {
  const since = new Date(Date.now() - Math.max(5, venue.settings.agentPauseMinutes) * 60_000);
  const [row] = await db.select({ id: academyWhatsappMessagesTable.id }).from(academyWhatsappMessagesTable).where(and(
    eq(academyWhatsappMessagesTable.academyId, venue.id),
    eq(academyWhatsappMessagesTable.phone, phone),
    eq(academyWhatsappMessagesTable.direction, "out"),
    inArray(academyWhatsappMessagesTable.kind, HUMAN_KINDS),
    gt(academyWhatsappMessagesTable.createdAt, since),
  )).limit(1);
  return Boolean(row);
}

async function waitingBooking(venueId: number, phone: string): Promise<VenueBooking | null> {
  const [row] = await db.select().from(venueBookingsTable).where(and(
    eq(venueBookingsTable.academyId, venueId),
    eq(venueBookingsTable.customerPhone, phone),
    inArray(venueBookingsTable.status, ["held", "confirmed"]),
    inArray(venueBookingsTable.paymentStatus, ["unpaid", "receipt"]),
    gt(venueBookingsTable.dueOnlineFils, 0),
    gt(venueBookingsTable.endsAt, new Date()),
  )).orderBy(desc(venueBookingsTable.createdAt)).limit(1);
  return row ?? null;
}

async function upcoming(venueId: number, phone: string): Promise<VenueBooking[]> {
  return db.select().from(venueBookingsTable).where(and(
    eq(venueBookingsTable.academyId, venueId),
    eq(venueBookingsTable.customerPhone, phone),
    inArray(venueBookingsTable.status, ["held", "confirmed"]),
    gt(venueBookingsTable.endsAt, new Date()),
  )).orderBy(asc(venueBookingsTable.startsAt)).limit(10);
}

// ─── Entry point (from the WhatsApp webhook) ─────────────────────────────────

export async function handleVenueInbound(input: {
  academyId: number;
  phone: string;
  body: string;
  content: WhatsappContent | null;
  pushName: string | null;
}): Promise<boolean> {
  const venue = await loadVenue(input.academyId);
  if (!venue || venue.settings.agentMode === "off") return false;
  const wa = await getWhatsappSettings(venue.id);
  if (!senderSessionFor(wa)) return false;
  const thread = await loadThread(venue.id, input.phone);
  await saveThread(thread.id, { lastInAt: new Date(), turns: thread.turns + 1 });
  if (thread.pausedUntil && thread.pausedUntil.getTime() > Date.now()) return true;
  if (await humanActive(venue, input.phone)) return true;

  const state = (thread.state ?? {}) as ThreadState;
  const locale: Locale = input.body && looksEnglish(input.body) ? "en" : state.locale ?? (wa.locale === "en" ? "en" : "ar");

  // A photo or a PDF while a booking waits for payment: the receipt.
  if (input.content && (input.content.type === "image" || input.content.type === "document")) {
    const waiting = await waitingBooking(venue.id, input.phone);
    if (waiting && input.content.media.path) {
      await takeReceipt(venue, waiting, input.content.media.path, input.content.media.mimetype, locale);
      return true;
    }
  }

  const session = senderSessionFor(wa)!;
  if (venue.settings.agentMode === "ai" && agentApiKey()) {
    await setTyping(session, chatIdForPhone(input.phone), true).catch(() => undefined);
    try {
      await runAi(venue, thread.id, input.phone, locale, input.pushName);
      return true;
    } catch (error) {
      logger.warn({ venueId: venue.id, error: (error as Error).message }, "Booking agent (AI) failed; using the menu");
    } finally {
      await setTyping(session, chatIdForPhone(input.phone), false).catch(() => undefined);
    }
  }
  await runMenu(venue, thread.id, state, input.phone, input.body, locale, input.pushName);
  return true;
}

// ─── Receipts ────────────────────────────────────────────────────────────────

export type ReceiptCheck = {
  checkedAt: string;
  isReceipt: boolean | null;
  amountFils: number | null;
  receiver: string | null;
  referenceFound: boolean | null;
  amountOk: boolean;
  receiverOk: boolean;
  referenceOk: boolean;
  note: string | null;
  autoConfirmed: boolean;
};

async function takeReceipt(venue: Venue, booking: VenueBooking, path: string, mimetype: string, locale: Locale): Promise<void> {
  // Give the owner time to look before the hold lapses.
  const holdExpiresAt = booking.holdExpiresAt ? new Date(Math.max(booking.holdExpiresAt.getTime(), Date.now() + 3 * 3_600_000)) : null;
  await db.update(venueBookingsTable).set({ receiptPath: path, paymentStatus: "receipt", holdExpiresAt, updatedAt: new Date() }).where(eq(venueBookingsTable.id, booking.id));
  const check = agentApiKey() && mimetype.startsWith("image/") ? await readReceipt(venue, booking, path, mimetype).catch((error) => {
    logger.warn({ bookingId: booking.id, error: (error as Error).message }, "Reading a receipt failed");
    return null;
  }) : null;
  const all = Boolean(check?.isReceipt && check.amountOk && check.receiverOk && check.referenceOk);
  // Money paid to Replay is confirmed by Replay, never automatically on the field's say-so.
  const auto = all && venue.settings.autoConfirmReceipts && booking.moneyTo === "venue";
  if (check) await db.update(venueBookingsTable).set({ receiptCheck: { ...check, autoConfirmed: auto } }).where(eq(venueBookingsTable.id, booking.id));
  if (auto) {
    const [fresh] = await db.select().from(venueBookingsTable).where(eq(venueBookingsTable.id, booking.id));
    await markPaid(venue, fresh, null);
    return;
  }
  await reply(venue, booking.customerPhone!, receiptReceivedMessage(locale));
}

async function readReceipt(venue: Venue, booking: VenueBooking, path: string, mimetype: string): Promise<ReceiptCheck | null> {
  const url = mediaUrl({ path });
  if (!url) return null;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 5 * 1024 * 1024) return null;
  const target = await paymentTarget(venue.settings);
  const facts = await bookingFacts(venue, booking, "en");
  const media = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimetype) ? mimetype : "image/jpeg";
  const result = await claude({
    max_tokens: 400,
    system: "You read Jordanian bank and wallet transfer receipts (CliQ). Answer only with one JSON object, no prose.",
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: media, data: buffer.toString("base64") } },
        {
          type: "text",
          text: `Read this receipt. Return JSON: {"is_receipt": bool (a completed transfer receipt, not a draft or a pending screen), "amount_jod": number|null, "receiver": string|null (the receiving alias, name or account as shown), "reference_seen": bool (the text "${booking.reference}" appears anywhere, e.g. in the note), "note": short string}. The expected receiver alias is "${facts.alias ?? target.alias ?? ""}"${facts.aliasName ? ` (name "${facts.aliasName}")` : ""} and the expected amount is ${(booking.dueOnlineFils / 1000).toFixed(3)} JOD.`,
        },
      ],
    }],
  });
  const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return null;
  const parsed = JSON.parse(json) as { is_receipt?: unknown; amount_jod?: unknown; receiver?: unknown; reference_seen?: unknown; note?: unknown };
  const amountFils = typeof parsed.amount_jod === "number" ? Math.round(parsed.amount_jod * 1000) : null;
  const receiver = typeof parsed.receiver === "string" ? parsed.receiver.slice(0, 120) : null;
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, "");
  const expectedAlias = norm(facts.alias);
  const expectedName = norm(facts.aliasName);
  const got = norm(receiver);
  return {
    checkedAt: new Date().toISOString(),
    isReceipt: typeof parsed.is_receipt === "boolean" ? parsed.is_receipt : null,
    amountFils,
    receiver,
    referenceFound: typeof parsed.reference_seen === "boolean" ? parsed.reference_seen : null,
    amountOk: amountFils != null && amountFils >= booking.dueOnlineFils,
    receiverOk: Boolean(got) && ((expectedAlias.length > 2 && got.includes(expectedAlias)) || (expectedName.length > 2 && got.includes(expectedName))),
    referenceOk: parsed.reference_seen === true,
    note: typeof parsed.note === "string" ? parsed.note.slice(0, 200) : null,
    autoConfirmed: false,
  };
}

// ─── Menu mode ───────────────────────────────────────────────────────────────

const T = {
  ar: {
    menu: (venue: string, name: string | null) => `أهلين${name ? ` ${name}` : ""} بـ${venue} ⚽\nاختار رقم:\n1️⃣ احجز ملعب\n2️⃣ حجوزاتي\n3️⃣ الأسعار والمواعيد\n4️⃣ موقعنا\n5️⃣ بدي أحكي مع حدا`,
    pickDay: "أي يوم؟ اكتب الرقم:",
    pickPitch: "أي ملعب؟",
    pickLength: "قديش بدك مدة الحجز؟",
    pickTime: (day: string) => `المواعيد الفاضية ${day}:`,
    noTimes: "للأسف ما في مواعيد فاضية بهاليوم. اختار يوم ثاني 👇",
    askName: "شو الاسم اللي نحجز عليه؟",
    pickPay: "كيف بدك تدفع؟",
    payCliq: "كليك (CliQ)",
    payCard: "بطاقة / Apple Pay",
    payField: "بالملعب",
    back: "0 رجوع للقائمة",
    none: "ما عندك حجوزات جاية.",
    yours: "حجوزاتك:",
    cancelHint: "لتغيير أو إلغاء حجز اكتب رقمه، أو 0 للقائمة.",
    cancelled: "تمام، ألغينا الحجز ✅",
    tooLate: (h: number) => `ما بنقدر نلغي أونلاين قبل الموعد بأقل من ${h} ساعات. احكي معنا هون ومنشوف.`,
    manage: "شو بدك تعمل بهالحجز؟",
    doChange: (fee: string | null) => `غيّر الموعد${fee ? ` (رسوم ${fee})` : ""}`,
    doCancel: (fee: string | null) => `ألغِ الحجز${fee ? ` (رسوم ${fee})` : ""}`,
    cantChange: (why: string) => `تغيير الموعد: ${why}`,
    changeWhy: { off: "احكي مع الملعب", too_late: "انتهى وقت التغيير", too_many: "وصلت الحد الأقصى للتغييرات", not_active: "ما بينفع" } as Record<string, string>,
    confirmCancel: (fee: string | null, refund: string | null) => [`متأكد بدك تلغي؟`, fee ? `رسوم الإلغاء المتأخر: ${fee}` : null, refund ? `رح نرجعلك ${refund}` : null, `${NUM[1]} أيوه، ألغِ`, "0 لا، ارجع"].filter(Boolean).join("\n"),
    pickNewDay: "لأي يوم بدك تنقل الحجز؟",
    blocked: "لازم تحكي مع الملعب عشان تحجز. حدا من الفريق رح يرد عليك هون 🙏",
    firstDeposit: (amount: string) => `لأنه أول حجز إلك عنا، لازم تدفع ${amount} أونلاين.`,
    human: "تمام، حدا من الفريق رح يرد عليك هون بأقرب وقت 🙏",
    nudge: "اختار رقم من القائمة، أو اكتب 0 لترجع للقائمة.",
    hours: "مواعيد الدوام:",
    closed: "مسكّر",
    from: "من",
    perHour: "بالساعة",
    noLocation: "اسألنا هون وبنبعتلك اللوكيشن.",
    error: "صار خطأ، جرّب كمان مرة أو اكتب 5 لتحكي مع حدا.",
    yes: "أيوه",
    no: "لأ",
  },
  en: {
    menu: (venue: string, name: string | null) => `Hi${name ? ` ${name}` : ""}, welcome to ${venue} ⚽\nReply with a number:\n1️⃣ Book a pitch\n2️⃣ My bookings\n3️⃣ Prices & hours\n4️⃣ Location\n5️⃣ Talk to someone`,
    pickDay: "Which day? Reply with the number:",
    pickPitch: "Which pitch?",
    pickLength: "How long?",
    pickTime: (day: string) => `Free times on ${day}:`,
    noTimes: "Sorry, nothing free that day. Pick another 👇",
    askName: "What name should the booking be under?",
    pickPay: "How would you like to pay?",
    payCliq: "CliQ",
    payCard: "Card / Apple Pay",
    payField: "At the field",
    back: "0 back to the menu",
    none: "You have no upcoming bookings.",
    yours: "Your bookings:",
    cancelHint: "To change or cancel one, reply with its number, or 0 for the menu.",
    cancelled: "Done, the booking is cancelled ✅",
    tooLate: (h: number) => `Bookings can't be cancelled online less than ${h} hours before kick-off. Message us here and we'll sort it out.`,
    manage: "What would you like to do with this booking?",
    doChange: (fee: string | null) => `Change the time${fee ? ` (${fee} fee)` : ""}`,
    doCancel: (fee: string | null) => `Cancel it${fee ? ` (${fee} fee)` : ""}`,
    cantChange: (why: string) => `Changing the time: ${why}`,
    changeWhy: { off: "message the field", too_late: "too close to kick-off", too_many: "no changes left", not_active: "not possible" } as Record<string, string>,
    confirmCancel: (fee: string | null, refund: string | null) => ["Cancel this booking?", fee ? `Late cancellation fee: ${fee}` : null, refund ? `We'll refund ${refund}` : null, `${NUM[1]} Yes, cancel`, "0 No, go back"].filter(Boolean).join("\n"),
    pickNewDay: "Which day would you like to move it to?",
    blocked: "Please talk to the field to book. Someone from the team will reply here 🙏",
    firstDeposit: (amount: string) => `As it's your first booking with us, ${amount} is paid online.`,
    human: "Sure, someone from the team will reply here shortly 🙏",
    nudge: "Reply with a number from the menu, or 0 to start again.",
    hours: "Opening hours:",
    closed: "closed",
    from: "from",
    perHour: "an hour",
    noLocation: "Ask us here and we'll send the location.",
    error: "Something went wrong. Try again, or reply 5 to talk to someone.",
    yes: "Yes",
    no: "No",
  },
};

const NUM = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const num = (i: number) => NUM[i] ?? `${i}.`;

async function runMenu(venue: Venue, threadId: number, state: ThreadState, phone: string, body: string, locale: Locale, pushName: string | null): Promise<void> {
  const t = T[locale];
  const pick = choice(body);
  const draft: Draft = state.draft ?? {};
  const save = (next: ThreadState) => saveThread(threadId, { state: { ...next, locale } });
  const venueName = locale === "ar" ? venue.nameAr || venue.name : venue.name;
  const showMenu = async () => {
    await reply(venue, phone, t.menu(venueName, pushName?.split(/\s+/)[0] ?? null));
    await save({ step: "menu", draft: {}, menuAt: Date.now() });
  };

  if (pick === 0) return showMenu();
  const step = state.step ?? null;
  const fresh = !state.menuAt || Date.now() - state.menuAt > 6 * 3_600_000;

  if (!step || step === "menu") {
    if (step === "menu" && pick !== null && !fresh) {
      if (pick === 1) return askDay(venue, threadId, phone, locale, {});
      if (pick === 2) return listMine(venue, threadId, phone, locale);
      if (pick === 3) { await reply(venue, phone, await pricesText(venue, locale)); return save({ step: "menu", draft: {}, menuAt: Date.now() }); }
      if (pick === 4) { await reply(venue, phone, await locationText(venue, locale)); return save({ step: "menu", draft: {}, menuAt: Date.now() }); }
      if (pick === 5) return handover(venue, threadId, phone, locale);
    }
    if (fresh) return showMenu();
    // Free text after the menu: one nudge, then leave the chat to the team.
    if (!state.nudgedAt || Date.now() - state.nudgedAt > 3_600_000) {
      await reply(venue, phone, t.nudge);
      return save({ ...state, nudgedAt: Date.now() });
    }
    return;
  }

  const options = draft.options ?? [];
  if (pick === null || pick < 1 || pick > options.length) {
    if (step === "name" && body.trim().length >= 2) {
      return afterName(venue, threadId, phone, locale, { ...draft, name: body.trim().slice(0, 60) });
    }
    await reply(venue, phone, t.nudge);
    return;
  }
  const value = options[pick - 1];
  try {
    if (step === "day" && draft.moveId) return askTime(venue, threadId, phone, locale, { ...draft, date: value });
    if (step === "day") return askPitch(venue, threadId, phone, locale, { ...draft, date: value });
    if (step === "pitch") return askLength(venue, threadId, phone, locale, { ...draft, pitchId: Number(value) });
    if (step === "length") return askTime(venue, threadId, phone, locale, { ...draft, minutes: Number(value) });
    if (step === "time" && draft.moveId) {
      const b = await mineById(venue, phone, draft.moveId);
      if (!b) return showMenu();
      try {
        await changeByPlayer(venue, b, { startLocal: value });
      } catch (error) {
        if (error instanceof VenueError && error.code === "taken") return askTime(venue, threadId, phone, locale, draft);
        throw error;
      }
      return save({ step: "menu", draft: {}, menuAt: Date.now() });
    }
    if (step === "time") {
      const next = { ...draft, startLocal: value };
      if (pushName && pushName.trim().length >= 2) return afterName(venue, threadId, phone, locale, { ...next, name: pushName.trim().slice(0, 60) });
      await reply(venue, phone, t.askName);
      return save({ step: "name", draft: { ...next, options: [] } });
    }
    if (step === "consent") return askPay(venue, threadId, phone, locale, { ...draft, igConsent: value === "yes" });
    if (step === "pay") return book(venue, threadId, phone, locale, draft, value as "cliq" | "card" | "field");
    if (step === "cancel") {
      const b = await mineById(venue, phone, Number(value));
      if (!b) return showMenu();
      return askManage(venue, threadId, phone, locale, b);
    }
    if (step === "manage") {
      const b = await mineById(venue, phone, draft.bookingId ?? 0);
      if (!b) return showMenu();
      if (value === "change") {
        const minutes = wallMinutes(b.endLocal) - wallMinutes(b.startLocal);
        return askDay(venue, threadId, phone, locale, { moveId: b.id, pitchId: b.pitchId, minutes }, t.pickNewDay);
      }
      const policy = bookingPolicy(venue, b);
      const q = cancelQuote(policy, moneyOf(b), "player");
      if (!q.allowed) {
        await reply(venue, phone, t.tooLate(policy.cancelHours));
        return save({ step: "menu", draft: {}, menuAt: Date.now() });
      }
      await reply(venue, phone, t.confirmCancel(q.feeFils ? formatJod(q.feeFils, locale) : null, q.refundFils ? formatJod(q.refundFils, locale) : null));
      return save({ step: "confirm_cancel", draft: { bookingId: b.id, options: ["yes"] } });
    }
    if (step === "confirm_cancel") {
      const b = await mineById(venue, phone, draft.bookingId ?? 0);
      if (!b) return showMenu();
      await cancelBooking(venue, b, "Cancelled by the player on WhatsApp", { by: "player" });
      return save({ step: "menu", draft: {}, menuAt: Date.now() });
    }
  } catch (error) {
    if (error instanceof VenueError && error.code === "too_late") {
      await reply(venue, phone, t.tooLate(venue.settings.cancelHours));
      return save({ step: "menu", draft: {}, menuAt: Date.now() });
    }
    if (error instanceof VenueError && error.code?.startsWith("change_")) {
      await reply(venue, phone, t.cantChange(t.changeWhy[error.code.slice(7)] ?? t.changeWhy.not_active));
      return save({ step: "menu", draft: {}, menuAt: Date.now() });
    }
    if (error instanceof VenueError && error.code === "blocked") return handover(venue, threadId, phone, locale, t.blocked);
    const message = error instanceof VenueError ? error.message : t.error;
    await reply(venue, phone, error instanceof VenueError && locale === "ar" ? t.error : message);
    return showMenu();
  }
}

async function askDay(venue: Venue, threadId: number, phone: string, locale: Locale, draft: Draft, note?: string) {
  const t = T[locale];
  const hours = normaliseHours(venue.settings.openingHours);
  const today = ammanLocal(new Date()).slice(0, 10);
  const days: string[] = [];
  for (let i = 0; i < Math.min(14, venue.settings.maxDaysAhead + 1) && days.length < 7; i += 1) {
    const d = addDays(today, i);
    if (openingWindow(hours, d)) days.push(d);
  }
  const lines = days.map((d, i) => `${num(i + 1)} ${dayLabel(d, locale)}`);
  await reply(venue, phone, [note, t.pickDay, ...lines, t.back].filter(Boolean).join("\n"));
  await saveThread(threadId, { state: { step: "day", draft: { ...draft, options: days }, menuAt: Date.now(), locale } });
}

async function askPitch(venue: Venue, threadId: number, phone: string, locale: Locale, draft: Draft) {
  const t = T[locale];
  const free = (await availability(venue, draft.date!)).filter((p) => p.slots.some((s) => s.available));
  if (!free.length) return askDay(venue, threadId, phone, locale, {}, t.noTimes);
  if (free.length === 1) return askLength(venue, threadId, phone, locale, { ...draft, pitchId: free[0].pitchId });
  const lines = free.map((p, i) => `${num(i + 1)} ${locale === "ar" ? p.nameAr || p.name : p.name} (${p.size}×${p.size})`);
  await reply(venue, phone, [t.pickPitch, ...lines, t.back].join("\n"));
  await saveThread(threadId, { state: { step: "pitch", draft: { ...draft, options: free.map((p) => String(p.pitchId)) }, menuAt: Date.now(), locale } });
}

async function askLength(venue: Venue, threadId: number, phone: string, locale: Locale, draft: Draft) {
  const t = T[locale];
  const durations = normaliseDurations(venue.settings.durations);
  const [pitchSlots] = await availability(venue, draft.date!, draft.pitchId);
  const offered = durations.filter((m) => pitchSlots?.slots.some((s) => s.options.some((o) => o.minutes === m && o.available)));
  if (!offered.length) return askDay(venue, threadId, phone, locale, {}, t.noTimes);
  if (offered.length === 1) return askTime(venue, threadId, phone, locale, { ...draft, minutes: offered[0] });
  const lines = offered.map((m, i) => {
    const prices = pitchSlots.slots.flatMap((s) => s.options.filter((o) => o.minutes === m && o.available).map((o) => o.priceFils));
    return `${num(i + 1)} ${durationLabel(m, locale)} — ${t.from} ${formatJod(Math.min(...prices), locale)}`;
  });
  await reply(venue, phone, [t.pickLength, ...lines, t.back].join("\n"));
  await saveThread(threadId, { state: { step: "length", draft: { ...draft, options: offered.map(String) }, menuAt: Date.now(), locale } });
}

async function askTime(venue: Venue, threadId: number, phone: string, locale: Locale, draft: Draft) {
  const t = T[locale];
  const [pitchSlots] = await availability(venue, draft.date!, draft.pitchId);
  const free = (pitchSlots?.slots ?? []).flatMap((s) => s.options.filter((o) => o.minutes === draft.minutes && o.available).map((o) => ({ start: s.startLocal, price: o.priceFils }))).slice(0, 10);
  if (!free.length) return askDay(venue, threadId, phone, locale, {}, t.noTimes);
  const lines = free.map((f, i) => `${num(i + 1)} ${timeLabel(f.start.slice(11), locale)} — ${formatJod(f.price, locale)}`);
  await reply(venue, phone, [t.pickTime(dayLabel(draft.date!, locale)), ...lines, t.back].join("\n"));
  await saveThread(threadId, { state: { step: "time", draft: { ...draft, options: free.map((f) => f.start) }, menuAt: Date.now(), locale } });
}

/** The ways to pay the field takes in general (for the AI's prompt). A player's own quote may narrow them. */
async function payOptions(venue: Venue): Promise<Array<"cliq" | "card" | "field">> {
  const target = await paymentTarget(venue.settings);
  const out: Array<"cliq" | "card" | "field"> = [];
  if (venue.settings.depositMode !== "none") {
    if (target.alias) out.push("cliq");
    if (target.card) out.push("card");
  }
  if (venue.settings.payAtField || !out.length) out.push("field");
  return out;
}

async function mineById(venue: Venue, phone: string, id: number): Promise<VenueBooking | null> {
  if (!id) return null;
  const [b] = await db.select().from(venueBookingsTable).where(and(eq(venueBookingsTable.id, id), eq(venueBookingsTable.academyId, venue.id), eq(venueBookingsTable.customerPhone, phone)));
  return b && ["held", "confirmed"].includes(b.status) ? b : null;
}

async function askManage(venue: Venue, threadId: number, phone: string, locale: Locale, b: VenueBooking) {
  const t = T[locale];
  const policy = bookingPolicy(venue, b);
  const money = moneyOf(b);
  const cq = cancelQuote(policy, money, "player");
  const ch = changeQuote(policy, money);
  const options: string[] = [];
  const lines: string[] = [`${dayLabel(b.startLocal.slice(0, 10), locale)} ${timeLabel(b.startLocal.slice(11), locale)} (${b.reference})`, t.manage];
  if (ch.allowed) { options.push("change"); lines.push(`${num(options.length)} ${t.doChange(ch.feeFils ? formatJod(ch.feeFils, locale) : null)}`); }
  if (cq.allowed) { options.push("cancel"); lines.push(`${num(options.length)} ${t.doCancel(cq.feeFils ? formatJod(cq.feeFils, locale) : null)}`); }
  if (!ch.allowed) lines.push(t.cantChange(t.changeWhy[ch.reason] ?? t.changeWhy.not_active));
  if (!cq.allowed) lines.push(t.tooLate(policy.cancelHours));
  lines.push(t.back);
  await reply(venue, phone, lines.join("\n"));
  await saveThread(threadId, { state: { step: options.length ? "manage" : "menu", draft: { bookingId: b.id, options }, menuAt: Date.now(), locale } });
}

/** The field asks the captain about Instagram (consent mode "ask"); otherwise straight on to paying. */
async function afterName(venue: Venue, threadId: number, phone: string, locale: Locale, draft: Draft) {
  if (consentMode(venue.settings.igConsentMode) !== "ask" || draft.igConsent !== undefined) return askPay(venue, threadId, phone, locale, draft);
  const t = T[locale];
  const name = locale === "ar" ? venue.nameAr || venue.name : venue.name;
  await reply(venue, phone, [consentQuestion(name, locale), `${num(1)} ${t.yes}`, `${num(2)} ${t.no}`].join("\n"));
  await saveThread(threadId, { state: { step: "consent", draft: { ...draft, options: ["yes", "no"] }, menuAt: Date.now(), locale } });
}

async function askPay(venue: Venue, threadId: number, phone: string, locale: Locale, draft: Draft) {
  const t = T[locale];
  const quote = await quoteFor(venue, { phone, pitchId: draft.pitchId!, startLocal: draft.startLocal!, minutes: draft.minutes! });
  if (quote.blocked) return handover(venue, threadId, phone, locale, t.blocked);
  const options = (["cliq", "card", "field"] as const).filter((m) => quote.methods[m]);
  if (!options.length) options.push("field");
  const note = quote.reason === "new_customer" ? t.firstDeposit(formatJod(quote.minimumOnlineFils, locale)) : null;
  if (options.length === 1) return book(venue, threadId, phone, locale, draft, options[0]);
  const label = { cliq: t.payCliq, card: t.payCard, field: t.payField };
  await reply(venue, phone, [note, t.pickPay, ...options.map((o, i) => `${num(i + 1)} ${label[o]}`), t.back].filter(Boolean).join("\n"));
  await saveThread(threadId, { state: { step: "pay", draft: { ...draft, options }, menuAt: Date.now(), locale } });
}

async function book(venue: Venue, threadId: number, phone: string, locale: Locale, draft: Draft, payWith: "cliq" | "card" | "field") {
  try {
    await createBookings(venue, {
      pitchId: draft.pitchId!,
      startLocal: draft.startLocal!,
      minutes: draft.minutes!,
      customerName: draft.name ?? null,
      customerPhone: phone,
      source: "whatsapp",
      payWith,
      igConsent: draft.igConsent,
      notify: true,
    });
  } catch (error) {
    if (error instanceof VenueError && error.code === "taken") return askTime(venue, threadId, phone, locale, draft);
    throw error;
  }
  await saveThread(threadId, { state: { step: "menu", draft: {}, menuAt: Date.now(), locale } });
}

async function listMine(venue: Venue, threadId: number, phone: string, locale: Locale) {
  const t = T[locale];
  const mine = await upcoming(venue.id, phone);
  if (!mine.length) {
    await reply(venue, phone, `${t.none}\n${num(1)} ${locale === "ar" ? "احجز ملعب" : "Book a pitch"}`);
    return saveThread(threadId, { state: { step: "menu", draft: {}, menuAt: Date.now(), locale } });
  }
  const pitches = new Map((await db.select().from(venuePitchesTable).where(eq(venuePitchesTable.academyId, venue.id))).map((p) => [p.id, p]));
  const lines = mine.map((b, i) => {
    const p = pitches.get(b.pitchId);
    return `${num(i + 1)} ${dayLabel(b.startLocal.slice(0, 10), locale)} ${timeLabel(b.startLocal.slice(11), locale)} — ${(locale === "ar" ? p?.nameAr || p?.name : p?.name) ?? ""} (${b.reference})${b.status === "held" ? (locale === "ar" ? " ⏳ بانتظار الدفع" : " ⏳ awaiting payment") : ""}`;
  });
  await reply(venue, phone, [t.yours, ...lines, t.cancelHint].join("\n"));
  await saveThread(threadId, { state: { step: "cancel", draft: { options: mine.map((b) => String(b.id)) }, menuAt: Date.now(), locale } });
}

async function handover(venue: Venue, threadId: number, phone: string, locale: Locale, text?: string) {
  await reply(venue, phone, text ?? T[locale].human);
  await saveThread(threadId, {
    handoverAt: new Date(),
    pausedUntil: new Date(Date.now() + Math.max(30, venue.settings.agentPauseMinutes) * 60_000),
    state: { step: null, draft: {}, locale },
  });
}

async function pricesText(venue: Venue, locale: Locale): Promise<string> {
  const t = T[locale];
  const hours = normaliseHours(venue.settings.openingHours);
  const pitches = await db.select().from(venuePitchesTable).where(and(eq(venuePitchesTable.academyId, venue.id), eq(venuePitchesTable.active, true))).orderBy(asc(venuePitchesTable.sortOrder));
  const dayNames = locale === "ar" ? ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const lines: string[] = [];
  for (const p of pitches) {
    lines.push(`⚽ ${locale === "ar" ? p.nameAr || p.name : p.name} (${p.size}×${p.size}): ${formatJod(p.pricePerHourFils, locale)} ${t.perHour}`);
    for (const r of normaliseRules(p.priceRules)) {
      lines.push(`   • ${r.days.map((d) => dayNames[d]).join("، ")} ${r.from}–${r.to}: ${formatJod(r.pricePerHourFils, locale)}`);
    }
  }
  lines.push("", t.hours);
  for (let d = 0; d < 7; d += 1) {
    const h = hours[String(d) as "0"];
    lines.push(`${dayNames[d]}: ${h ? `${h.open}–${h.close}` : t.closed}`);
  }
  return lines.join("\n");
}

async function locationText(venue: Venue, locale: Locale): Promise<string> {
  const [a] = await db.select({ address: academiesTable.address, lat: academiesTable.latitude, lng: academiesTable.longitude }).from(academiesTable).where(eq(academiesTable.id, venue.id));
  const [f] = await db.select({ lat: fieldsTable.latitude, lng: fieldsTable.longitude, location: fieldsTable.location }).from(fieldsTable).where(eq(fieldsTable.id, venue.fieldId));
  const lat = a?.lat ?? f?.lat;
  const lng = a?.lng ?? f?.lng;
  const address = a?.address || f?.location || "";
  if (!lat || !lng) return address || T[locale].noLocation;
  return `📍 ${address}\nhttps://maps.google.com/?q=${lat},${lng}`.trim();
}

// ─── AI mode ─────────────────────────────────────────────────────────────────

type ClaudeContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
type ClaudeMessage = { role: "user" | "assistant"; content: string | ClaudeContent[] };
type ClaudeResponse = { content: ClaudeContent[]; stop_reason: string };

async function claude(body: { system: string; messages: ClaudeMessage[]; max_tokens: number; tools?: unknown[] }): Promise<ClaudeResponse> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": agentApiKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: agentModel(), ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({}))) as ClaudeResponse & { error?: { message?: string } };
  if (!response.ok) throw new Error(`Anthropic ${response.status}: ${data.error?.message ?? "error"}`);
  return data;
}

const TOOLS = [
  {
    name: "check_availability",
    description: "Free kick-off times on one day (the field's business day, YYYY-MM-DD), per pitch, with the price for each length. Always call this before offering or booking a time.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        pitch_id: { type: "integer" },
        minutes: { type: "integer", description: "Only lengths of this many minutes" },
      },
      required: ["date"],
    },
  },
  {
    name: "create_booking",
    description: "Book a pitch for this WhatsApp number once the player has agreed on pitch, day, time and length. The system then sends them the confirmation or the payment details itself; do not repeat amounts or payment details in your reply.",
    input_schema: {
      type: "object",
      properties: {
        pitch_id: { type: "integer" },
        start_local: { type: "string", description: "YYYY-MM-DD HH:MM in Amman time, exactly as check_availability returned it" },
        minutes: { type: "integer" },
        customer_name: { type: "string" },
        team_name: { type: "string" },
        pay_with: { type: "string", enum: ["cliq", "card", "field"] },
        instagram_consent: { type: "boolean", description: "The player's answer to the Instagram question, only when the system prompt says to ask it. Never guess it." },
      },
      required: ["pitch_id", "start_local", "minutes", "customer_name", "pay_with"],
    },
  },
  {
    name: "my_bookings",
    description: "This number's upcoming bookings.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancel_booking",
    description: "Cancel one of this number's upcoming bookings by its code. Only when the player clearly asks to cancel. Check my_bookings first: if cancelling has a fee, tell the player the fee and cancel only after they agree. The system sends the player the cancellation (with any fee or refund) itself.",
    input_schema: { type: "object", properties: { reference: { type: "string" } }, required: ["reference"] },
  },
  {
    name: "change_booking",
    description: "Move one of this number's upcoming bookings to another kick-off time (same pitch and length unless given). Check my_bookings first for whether changes are allowed and the change fee; tell the player any fee and get their OK. Call check_availability for the new time first. The system sends the player the new details itself.",
    input_schema: {
      type: "object",
      properties: {
        reference: { type: "string" },
        start_local: { type: "string", description: "YYYY-MM-DD HH:MM in Amman time, exactly as check_availability returned it" },
        pitch_id: { type: "integer" },
        minutes: { type: "integer" },
      },
      required: ["reference", "start_local"],
    },
  },
  {
    name: "handover",
    description: "Hand the chat to a person from the field: complaints, refunds, special requests, anything you can't do with the other tools, or when the player asks for a person.",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  },
];

async function systemPrompt(venue: Venue, locale: Locale): Promise<string> {
  const s = venue.settings;
  const hours = normaliseHours(s.openingHours);
  const pitches = await db.select().from(venuePitchesTable).where(and(eq(venuePitchesTable.academyId, venue.id), eq(venuePitchesTable.active, true))).orderBy(asc(venuePitchesTable.sortOrder));
  const options = await payOptions(venue);
  const now = ammanLocal(new Date());
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return [
    `You are ${s.agentName || "the booking assistant"} for ${venue.name}${venue.nameAr ? ` (${venue.nameAr})` : ""}, a football pitch rental in Jordan, answering on WhatsApp.`,
    `Now in Amman: ${now} (${days[new Date(`${now.slice(0, 10)}T00:00:00Z`).getUTCDay()]}).`,
    `Write like a friendly Jordanian front-desk person: Ammani Arabic dialect by default, or English if the player writes English. Short WhatsApp messages, no markdown headings, at most one emoji.`,
    `Never state a free time or a price you didn't get from check_availability in this conversation. Times are Amman time; a field open past midnight lists those late times under the day it opened.`,
    `To book you need: pitch, day, kick-off time, length, a name, and how they pay. Ask only for what's missing. Confirm the details in one line before calling create_booking.`,
    consentMode(s.igConsentMode) === "ask"
      ? `Before create_booking also ask, word for word in their language: "${consentQuestion(venue.name, "en")}" / "${consentQuestion(venue.nameAr || venue.name, "ar")}" and pass their yes/no as instagram_consent. If they don't answer it, pass nothing: the field then won't post their match. Either answer is fine; never push.`
      : "",
    `Ways to pay here: ${options.join(", ")}. ${options.includes("cliq") ? "For CliQ the system sends the alias and a booking code; they send the receipt photo in this chat." : ""}`,
    `The field's rules (the system enforces them; if create_booking says a payment method isn't allowed for this player, offer the methods it allows):`,
    ...rulesSummary(policyOf(s as unknown as Record<string, unknown>), "en").map((l) => `- ${l}`),
    `Lengths offered: ${normaliseDurations(s.durations).join(", ")} minutes.`,
    "Pitches:",
    ...pitches.map((p) => `- id ${p.id}: ${p.name}${p.nameAr ? ` / ${p.nameAr}` : ""}, ${p.size}-a-side${p.surface ? `, ${p.surface}` : ""}${p.indoor ? ", indoor" : ""}`),
    "Opening hours:",
    ...[0, 1, 2, 3, 4, 5, 6].map((d) => { const h = hours[String(d) as "0"]; return `- ${days[d]}: ${h ? `${h.open}–${h.close}` : "closed"}`; }),
    s.agentNotes?.trim() ? `What the owner wants you to know:\n${s.agentNotes.trim().slice(0, 3000)}` : "",
    `If something is outside booking (complaints, refunds, lost items, prices you can't confirm, events), use handover. Don't make promises for the field.`,
    locale === "en" ? "The player writes English." : "",
  ].filter(Boolean).join("\n");
}

async function history(venueId: number, phone: string): Promise<ClaudeMessage[]> {
  const rows = await db.select({ direction: academyWhatsappMessagesTable.direction, body: academyWhatsappMessagesTable.body, createdAt: academyWhatsappMessagesTable.createdAt })
    .from(academyWhatsappMessagesTable)
    .where(and(eq(academyWhatsappMessagesTable.academyId, venueId), eq(academyWhatsappMessagesTable.phone, phone), gt(academyWhatsappMessagesTable.createdAt, new Date(Date.now() - 24 * 3_600_000))))
    .orderBy(desc(academyWhatsappMessagesTable.id)).limit(20);
  const messages: ClaudeMessage[] = [];
  for (const r of rows.reverse()) {
    const role = r.direction === "in" ? "user" : "assistant";
    const text = r.body.trim();
    if (!text) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = `${last.content as string}\n${text}`;
    else messages.push({ role, content: text });
  }
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") messages.push({ role: "user", content: "(sent a message)" });
  return messages;
}

async function runTool(venue: Venue, threadId: number, phone: string, locale: Locale, name: string, input: Record<string, unknown>): Promise<{ result: string; isError?: boolean; stop?: boolean }> {
  try {
    if (name === "check_availability") {
      const date = String(input.date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { result: "date must be YYYY-MM-DD", isError: true };
      const minutes = Number(input.minutes) || null;
      const result = (await availability(venue, date, Number(input.pitch_id) || undefined)).map((p) => ({
        pitch_id: p.pitchId,
        pitch: p.name,
        free: p.slots.flatMap((s) => s.options.filter((o) => o.available && (!minutes || o.minutes === minutes)).map((o) => ({ start_local: s.startLocal, minutes: o.minutes, price_jod: o.priceFils / 1000 }))),
      }));
      return { result: JSON.stringify(result).slice(0, 6000) };
    }
    if (name === "create_booking") {
      const payWith = ["cliq", "card", "field"].includes(String(input.pay_with)) ? String(input.pay_with) as "cliq" | "card" | "field" : "cliq";
      const [b] = await createBookings(venue, {
        pitchId: Number(input.pitch_id),
        startLocal: String(input.start_local ?? ""),
        minutes: Number(input.minutes),
        customerName: typeof input.customer_name === "string" ? input.customer_name : null,
        teamName: typeof input.team_name === "string" ? input.team_name : null,
        customerPhone: phone,
        source: "whatsapp",
        payWith,
        igConsent: typeof input.instagram_consent === "boolean" ? input.instagram_consent : undefined,
        notify: true,
      });
      return { result: JSON.stringify({ ok: true, reference: b.reference, status: b.status, note: "The payment details or the confirmation were just sent to the player by the system." }), stop: true };
    }
    if (name === "my_bookings") {
      const mine = await upcoming(venue.id, phone);
      return {
        result: JSON.stringify(mine.map((b) => {
          const policy = bookingPolicy(venue, b);
          const cq = cancelQuote(policy, moneyOf(b), "player");
          const ch = changeQuote(policy, moneyOf(b));
          return {
            reference: b.reference, start_local: b.startLocal, end_local: b.endLocal, pitch_id: b.pitchId, status: b.status, payment: b.paymentStatus,
            price_jod: b.amountFils / 1000, paid_jod: b.paidFils / 1000,
            cancel: cq.allowed ? { allowed: true, fee_jod: cq.feeFils / 1000, refund_jod: cq.refundFils / 1000 } : { allowed: false, why: "too close to kick-off: hand over" },
            change: ch.allowed ? { allowed: true, fee_jod: ch.feeFils / 1000, changes_left: ch.changesLeft } : { allowed: false, why: ch.reason },
          };
        })),
      };
    }
    if (name === "cancel_booking") {
      const reference = String(input.reference ?? "").toUpperCase().trim();
      const [b] = await db.select().from(venueBookingsTable).where(and(eq(venueBookingsTable.academyId, venue.id), eq(venueBookingsTable.customerPhone, phone), sql`upper(${venueBookingsTable.reference}) = ${reference}`));
      if (!b || !["held", "confirmed"].includes(b.status)) return { result: "No upcoming booking with that code on this number", isError: true };
      const row = await cancelBooking(venue, b, "Cancelled by the player on WhatsApp", { by: "player" });
      return { result: JSON.stringify({ ok: true, cancelled: b.reference, fee_jod: (row.feeFils - b.feeFils) / 1000, refund_jod: row.refundDueFils / 1000, note: "The system sent the player the cancellation details." }) };
    }
    if (name === "change_booking") {
      const reference = String(input.reference ?? "").toUpperCase().trim();
      const [b] = await db.select().from(venueBookingsTable).where(and(eq(venueBookingsTable.academyId, venue.id), eq(venueBookingsTable.customerPhone, phone), sql`upper(${venueBookingsTable.reference}) = ${reference}`));
      if (!b || !["held", "confirmed"].includes(b.status)) return { result: "No upcoming booking with that code on this number", isError: true };
      const row = await changeByPlayer(venue, b, {
        startLocal: String(input.start_local ?? ""),
        pitchId: Number(input.pitch_id) || undefined,
        minutes: Number(input.minutes) || undefined,
      });
      return { result: JSON.stringify({ ok: true, reference: row.reference, start_local: row.startLocal, note: "The system sent the player the new details." }), stop: true };
    }
    if (name === "handover") {
      await saveThread(threadId, {
        handoverAt: new Date(),
        pausedUntil: new Date(Date.now() + Math.max(30, venue.settings.agentPauseMinutes) * 60_000),
      });
      return { result: "Handed over. Tell the player someone from the team will reply here soon.", stop: false };
    }
    return { result: `Unknown tool ${name}`, isError: true };
  } catch (error) {
    return { result: error instanceof VenueError ? error.message : "That didn't work", isError: true };
  }
}

async function runAi(venue: Venue, threadId: number, phone: string, locale: Locale, pushName: string | null): Promise<void> {
  const system = await systemPrompt(venue, locale) + (pushName ? `\nThe player's WhatsApp name is "${pushName}".` : "");
  const messages = await history(venue.id, phone);
  let finalText = "";
  let booked = false;
  for (let turn = 0; turn < 6; turn += 1) {
    const response = await claude({ system, messages, max_tokens: 700, tools: TOOLS });
    const texts = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n").trim();
    const uses = response.content.filter((c): c is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => c.type === "tool_use");
    if (!uses.length) {
      finalText = texts;
      break;
    }
    messages.push({ role: "assistant", content: response.content });
    const results: ClaudeContent[] = [];
    for (const use of uses) {
      const out = await runTool(venue, threadId, phone, locale, use.name, use.input ?? {});
      if (use.name === "create_booking" && !out.isError) booked = true;
      results.push({ type: "tool_result", tool_use_id: use.id, content: out.result, ...(out.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
    finalText = texts;
  }
  await saveThread(threadId, { state: { step: null, draft: {}, locale } });
  // After a booking the system's own message carries the details; a short line from the agent is enough.
  if (finalText) await reply(venue, phone, finalText);
  else if (!booked) await reply(venue, phone, T[locale].human);
}

// Exposed for tests.
export const __test = { choice, looksEnglish, readReceipt, pricesText, wallString, wallMinutes };
