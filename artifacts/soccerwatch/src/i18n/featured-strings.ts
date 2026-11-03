import { useLocale } from "./context";
import { arCount } from "./ar-count";

/**
 * "Every child appears": the creative hub's Squad tab, the Players consent
 * checkbox, the private clips on a match and the family's clip page. English
 * is the type; Arabic is Ammani, as across the console.
 */
const MOMENTS_EN: Record<string, string> = {
  "your-goal": "his goal", "your-shot": "his shot on target", dribble: "his dribble", "long-pass": "his long pass",
  "touch-spell": "his spell on the ball", "fastest-run": "his fastest run", "completed-pass": "his pass", presence: "him in action",
};
const MOMENTS_AR: Record<string, string> = {
  "your-goal": "جوله", "your-shot": "تسديدته على المرمى", dribble: "مراوغته", "long-pass": "تمريرته الطويلة",
  "touch-spell": "لمساته على الطابة", "fastest-run": "أسرع ركضة إله", "completed-pass": "تمريرته", presence: "لقطة إله بالماتش",
};
const STATS_EN: Record<string, (v: number) => string> = {
  goals: (v) => `${v} goal${v === 1 ? "" : "s"}`, dribblesWon: (v) => `${v} dribble${v === 1 ? "" : "s"} won`,
  passesCompleted: (v) => `${v} completed pass${v === 1 ? "" : "es"}`, topSpeedKmh: (v) => `${v} km/h top speed`,
  distanceKm: (v) => `${v} km run`, touches: (v) => `${v} touches`,
};
const STATS_AR: Record<string, (v: number) => string> = {
  goals: (v) => arCount(v, "جول", "جولين", "جوالات", "جول"), dribblesWon: (v) => `${v} مراوغات ناجحة`,
  passesCompleted: (v) => `${v} تمريرات صحيحة`, topSpeedKmh: (v) => `سرعة ${v} كم/س`, distanceKm: (v) => `${v} كم ركض`,
  touches: (v) => arCount(v, "لمسة", "لمستين", "لمسات", "لمسة"),
};

type Note = { kind: "above"; stat: string; value: number; usual: number } | { kind: "best"; stat: string; value: number } | { kind: "first" } | null;

const en = {
  squad: {
    tab: "Squad",
    title: "Every child appears",
    intro: "One square per shirt number. Green: featured this month. Amber: not yet this month. Red: never featured.",
    summary: (featured: number, total: number) => `${featured} of ${total} featured this month.`,
    notYet: "Not yet:",
    allDone: "Everyone is featured this month.",
    month: "Month",
    squadAll: "All squads",
    targets: "Targets",
    perMonth: "Solo public posts per child per month",
    perMatch: "A private clip for every child after every analysed match",
    targetHint: "Children without public-post consent count only private clips.",
    privateOnly: "Private only",
    never: "Never featured",
    daysAgo: (d: number) => (d === 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`),
    month_: (m: { publicSolo: number; private: number }) => `${m.publicSolo} solo post${m.publicSolo === 1 ? "" : "s"} · ${m.private} private`,
    missing: { public_post: "needs his own post", private_clip: "missing a match clip", any: "nothing yet this month" } as Record<string, string>,
    gapsTitle: "No footage",
    gap: (n: string, m: number) => `No footage of ${n} in the last ${m === 1 ? "match" : `${m} matches`}`,
    fixWho: "Fix in Who's who",
    empty: "No players yet. Add players to see the grid.",
    legend: { green: "Featured", amber: "Not yet this month", red: "Never" },
    saved: "Saved",
  },
  consent: {
    label: "Parent agreed: photos and clips of this player can be posted on the academy's public pages.",
    short: "Public posts OK",
    privateOnly: "Private only",
    saved: "Saved",
    failed: "Couldn't save the consent",
  },
  clips: {
    title: "Each child's clip",
    intro: "His best moment from this match, framed on him, for his own parents only. Compared only with his own earlier matches.",
    prepare: "Prepare the clips",
    preparing: "Preparing…",
    send: (n: number) => `Send ${n} clip${n === 1 ? "" : "s"} to the families`,
    sending: "Sending…",
    sent: (m: number, c: number) => `Sent: ${c} clip${c === 1 ? "" : "s"} in ${m} message${m === 1 ? "" : "s"}.`,
    unreachable: (names: string) => `No WhatsApp number on file for: ${names}`,
    whatsappOff: "Turn WhatsApp on first (WhatsApp section).",
    none: "No clips yet.",
    reasons: {
      not_analysed: "The match hasn't been analysed yet.",
      no_recording: "This match has no video.",
      not_a_match: "Only matches get clips.",
    } as Record<string, string>,
    status: { prepared: "Ready to send", sent: "Sent", no_moment: "No clip (not on camera)", failed: "Failed" } as Record<string, string>,
    rendering: "Being rendered",
    opened: "Opened",
    open: "Open",
    moment: (k: string | null) => MOMENTS_EN[k ?? "presence"] ?? MOMENTS_EN.presence,
    note: (n: Note) => (!n || n.kind === "first" ? "" : n.kind === "best" ? `${(STATS_EN[n.stat] ?? String)(n.value)}, his best yet` : `${(STATS_EN[n.stat] ?? String)(n.value)}, more than his usual ${n.usual}`),
  },
  page: {
    title: (name: string) => `${name}'s moment`,
    from: (academy: string) => `From ${academy}`,
    preparing: "The clip is still being prepared. This page refreshes on its own.",
    notFound: "This link doesn't work any more.",
    privacy: "Only you have this link. It isn't posted anywhere.",
  },
};

type FeaturedStrings = typeof en;

const ar: FeaturedStrings = {
  squad: {
    tab: "التشكيلة",
    title: "كل لاعب بيطلع",
    intro: "مربع لكل رقم قميص. أخضر: طلع هالشهر. برتقالي: لسّا ما طلع هالشهر. أحمر: ما طلع ولا مرة.",
    summary: (featured, total) => `${featured} من ${total} طلعوا هالشهر.`,
    notYet: "لسّا:",
    allDone: "كل اللاعبين طلعوا هالشهر.",
    month: "الشهر",
    squadAll: "كل الفرق",
    targets: "الأهداف",
    perMonth: "بوستات عامة إله لحاله، لكل لاعب بالشهر",
    perMatch: "كليب خاص لكل لاعب بعد كل ماتش متحلّل",
    targetHint: "اللاعب اللي أهله ما وافقوا عالنشر العام بنحسبله الكليبات الخاصة بس.",
    privateOnly: "خاص بس",
    never: "ما طلع ولا مرة",
    daysAgo: (d) => (d === 0 ? "اليوم" : d === 1 ? "من يوم" : d === 2 ? "من يومين" : `من ${d} أيام`),
    month_: (m) => `${m.publicSolo} بوست إله · ${m.private} خاص`,
    missing: { public_post: "بدّه بوست إله", private_clip: "ناقصه كليب ماتش", any: "ولا إشي هالشهر" },
    gapsTitle: "ما في فيديو",
    gap: (n, m) => (m === 1 ? `ما في فيديو لـ ${n} بآخر ماتش` : `ما في فيديو لـ ${n} بآخر ${m} مباريات`),
    fixWho: "صلّحها بـ «مين مين»",
    empty: "ما في لاعبين لسّا. ضيف لاعبين لتشوف المربعات.",
    legend: { green: "طلع", amber: "لسّا هالشهر", red: "ولا مرة" },
    saved: "انحفظ",
  },
  consent: {
    label: "الأهل موافقين ننشر صور وفيديوهات اللاعب على صفحات الأكاديمية العامة.",
    short: "موافقين عالنشر",
    privateOnly: "خاص بس",
    saved: "انحفظ",
    failed: "ما زبط نحفظ الموافقة",
  },
  clips: {
    title: "كليب كل لاعب",
    intro: "أحلى لقطة إله من هالماتش، والكاميرا عليه، لأهله بس. بنقارنه بمبارياته هو بس.",
    prepare: "جهّز الكليبات",
    preparing: "عم نجهّز…",
    send: (n) => (n === 1 ? "ابعث الكليب لأهله" : n === 2 ? "ابعث الكليبين للأهالي" : `ابعث ${n} كليبات للأهالي`),
    sending: "عم نبعث…",
    sent: (m, c) => `انبعث: ${c} كليب بـ ${m} رسالة.`,
    unreachable: (names) => `ما في رقم واتساب لـ: ${names}`,
    whatsappOff: "شغّل الواتساب أول (قسم الواتساب).",
    none: "ما في كليبات لسّا.",
    reasons: {
      not_analysed: "الماتش لسّا ما تحلّل.",
      no_recording: "هالماتش ما إله فيديو.",
      not_a_match: "الكليبات للمباريات بس.",
    },
    status: { prepared: "جاهز ينبعث", sent: "انبعث", no_moment: "ما في كليب (مش بالكاميرا)", failed: "ما زبط" },
    rendering: "عم يتجهّز",
    opened: "انفتح",
    open: "افتح",
    moment: (k) => MOMENTS_AR[k ?? "presence"] ?? MOMENTS_AR.presence,
    note: (n) => (!n || n.kind === "first" ? "" : n.kind === "best" ? `${(STATS_AR[n.stat] ?? String)(n.value)}، أحسن رقم إله لهلأ` : `${(STATS_AR[n.stat] ?? String)(n.value)}، أكثر من معدّله (${n.usual})`),
  },
  page: {
    title: (name) => `لقطة ${name}`,
    from: (academy) => `من ${academy}`,
    preparing: "الكليب لسّا عم يتجهّز. الصفحة بتتحدّث لحالها.",
    notFound: "هالرابط ما عاد يشتغل.",
    privacy: "هالرابط إلكم بس. مش منشور بأي مكان.",
  },
};

export function useFeaturedCopy(): FeaturedStrings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" };
}

export const featuredStrings = { en, ar };
