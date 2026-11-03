import { useLocale } from "./context";

/**
 * Marketing practices in the academy console: trial clips and their
 * follow-up (People), referrals (a person in People), and the weekly
 * content calendar (Creative hub → For you). Arabic is Ammani; digits stay Latin.
 */
const en = {
  trials: {
    title: "Trial sessions",
    hint: "Send each trial child's moment to the family within 24 hours. A follow-up with the registration link goes a few days later, unless they've joined.",
    empty: "No one is at the trial stage. Set a lead's stage to Trial, then pick the session here.",
    session: "Trial session",
    pickSession: "Pick the session…",
    noVideo: "The video isn't in yet",
    childName: "Child's first name",
    moment: "Moment (min:sec in the video)",
    make: "Make the clip",
    remake: "Pick another moment",
    send: "Send to the family",
    preparing: "Clip being prepared",
    ready: "Clip ready",
    sent: (when: string) => `Sent ${when}`,
    opened: "Opened",
    notOpened: "Not opened yet",
    due: (h: number) => (h <= 0 ? "Late: over 24 hours since the session" : `Send within ${h} h`),
    followUp: { pending: (when: string) => `Follow-up ${when}`, sent: "Follow-up sent", skipped: "No follow-up needed" },
    errors: {
      no_video: "The session has no video yet.",
      bad_moment: "That time isn't in the video.",
      whatsapp_off: "WhatsApp isn't connected (Settings → WhatsApp).",
      automation_off: "The trial clip message is off (WhatsApp → Automations).",
      opted_out: "This number opted out or is blocked.",
      generic: "That didn't work. Try again.",
    },
    badTime: "Write the time as min:sec, e.g. 12:30",
  },
  referral: {
    by: "Referred by",
    none: "No one",
    note: "What the referrer gets",
    notePlaceholder: "e.g. 10% off December",
    chip: (name: string) => `Referred by ${name}`,
    count: (n: number) => (n === 1 ? "Referred 1 family" : `Referred ${n} families`),
  },
  calendar: {
    title: "This week",
    hint: "Your posting week. Each day takes the best draft Replay prepared for it.",
    edit: "Edit the week",
    done: "Done",
    reset: "Back to the default week",
    nothing: "No draft yet",
    open: "Open",
    kinds: { matchday: "Matchday", fulltime: "Full time", player: "Player of the week", training: "Training clip", weekly: "Weekly round-up" },
    none: "Nothing",
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    saved: "Week saved",
  },
  review: {
    label: "Google review link",
    hint: "Used by the review request message (WhatsApp → Automations; off until you turn it on).",
  },
  kidTrial: (academy: string) => `From the trial session at ${academy}`,
  kidTrialNoName: "Your child's moment",
};

type MarketingStrings = typeof en;

const ar: MarketingStrings = {
  trials: {
    title: "الحصص التجريبية",
    hint: "ابعتوا لقطة كل ولد جاي يجرّب لأهله خلال 24 ساعة. بعد كم يوم بتروح رسالة متابعة فيها رابط التسجيل، إلا إذا سجّلوا.",
    empty: "ما في حدا بمرحلة التجربة. حطّوا مرحلة المهتم \"تجربة\"، وبعدين اختاروا الحصة من هون.",
    session: "الحصة التجريبية",
    pickSession: "اختاروا الحصة…",
    noVideo: "الفيديو لسا ما وصل",
    childName: "اسم الولد الأول",
    moment: "اللقطة (دقيقة:ثانية بالفيديو)",
    make: "اعمل المقطع",
    remake: "اختار لقطة تانية",
    send: "ابعتو للأهل",
    preparing: "المقطع عم يتجهّز",
    ready: "المقطع جاهز",
    sent: (when: string) => `انبعت ${when}`,
    opened: "انفتح",
    notOpened: "لسا ما انفتح",
    due: (h: number) => (h <= 0 ? "متأخر: صار أكتر من 24 ساعة على الحصة" : `ابعتوه خلال ${h} ساعة`),
    followUp: { pending: (when: string) => `المتابعة ${when}`, sent: "انبعتت المتابعة", skipped: "ما في داعي لمتابعة" },
    errors: {
      no_video: "الحصة لسا ما إلها فيديو.",
      bad_moment: "هالوقت مش موجود بالفيديو.",
      whatsapp_off: "واتساب مش موصول (الإعدادات ← واتساب).",
      automation_off: "رسالة مقطع التجربة مطفية (واتساب ← الرسائل التلقائية).",
      opted_out: "هالرقم طلب ما يوصله رسائل أو محظور.",
      generic: "ما زبطت. جرّبوا كمان مرة.",
    },
    badTime: "اكتبوا الوقت دقيقة:ثانية، مثلاً 12:30",
  },
  referral: {
    by: "مين دلّهم علينا",
    none: "ولا حدا",
    note: "شو بياخد اللي دلّهم",
    notePlaceholder: "مثلاً خصم 10% على شهر 12",
    chip: (name: string) => `دلّهم ${name}`,
    count: (n: number) => (n === 1 ? "دلّ عيلة وحدة" : n === 2 ? "دلّ عيلتين" : `دلّ ${n} عيلات`),
  },
  calendar: {
    title: "هالأسبوع",
    hint: "أسبوع النشر تبعكم. كل يوم بياخد أحسن مسودة جهّزها Replay إله.",
    edit: "عدّل الأسبوع",
    done: "تمام",
    reset: "رجّع الأسبوع الأساسي",
    nothing: "لسا ما في مسودة",
    open: "افتح",
    kinds: { matchday: "يوم الماتش", fulltime: "نهاية الماتش", player: "لاعب الأسبوع", training: "مقطع من التمرين", weekly: "ملخص الأسبوع" },
    none: "ولا شي",
    days: ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
    saved: "انحفظ الأسبوع",
  },
  review: {
    label: "رابط مراجعات جوجل",
    hint: "بتستخدمه رسالة طلب المراجعة (واتساب ← الرسائل التلقائية؛ مطفية لحد ما تشغّلوها).",
  },
  kidTrial: (academy: string) => `من الحصة التجريبية بـ ${academy}`,
  kidTrialNoName: "لقطة ابنكم",
};

export const marketingStrings = { en, ar };

export function useMarketingCopy(): MarketingStrings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" };
}
