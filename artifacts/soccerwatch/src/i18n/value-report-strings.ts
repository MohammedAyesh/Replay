import { useLocale } from "./context";
import { arCount } from "./ar-count";

/**
 * The monthly value report (academy console and the shared /vr/<token> page).
 * English is the type; Arabic is Ammani, as across the console. Digits stay Latin.
 */
const fmtNum = (n: number) => new Intl.NumberFormat("en-US").format(n);
const jod = (v: number, ar: boolean) => (ar ? `${v.toFixed(v % 1 ? 2 : 0)} دينار` : `${v.toFixed(v % 1 ? 2 : 0)} JOD`);

const en = {
  nav: "Monthly report",
  title: "Your month with Replay",
  subtitle: "What Replay did for the academy this month, in numbers you can share.",
  month: (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`)),
  soFar: "So far this month",
  pick: "Month",
  share: "Share link",
  copy: "Copy link",
  copied: "Copied",
  turnOff: "Turn link off",
  shareNote: "Anyone with the link sees this month's numbers. No child is named on it.",
  download: "Download PDF",
  loading: "Building the report…",
  error: "Couldn't build the report. Try again in a minute.",
  footage: {
    title: "Footage",
    videos: "Match videos",
    clips: "Clips made",
    privateSent: (n: number) => `${fmtNum(n)} sent privately to families`,
  },
  posts: { title: "Public posts", reach: (n: number) => `Reached ${fmtNum(n)} people` },
  messages: { title: "WhatsApp messages sent", read: (n: number) => `${fmtNum(n)} read` },
  families: {
    title: "Families who watched",
    of: (o: number, t: number) => `${fmtNum(o)} of ${fmtNum(t)} families opened their child's clip or a match video`,
    none: "No families linked yet",
  },
  featured: {
    title: "Children featured",
    of: (f: number, t: number) => `${fmtNum(f)} of ${fmtNum(t)}`,
    target: (n: number) => (n === 0 ? "Target: a private clip after every match" : `Target: ${n} solo public post${n === 1 ? "" : "s"} each, or private-only`),
    notYet: (nums: string) => `Not yet: ${nums}`,
    all: "Every child appeared",
  },
  people: { title: "New families", enquiries: "Enquiries", trials: "Trial sessions", joined: "Players joined", since: (d: string) => `Counted from ${d}` },
  ads: {
    title: "Ads",
    spend: (v: number) => `${jod(v, false)} spent`,
    cost: (v: number) => `${jod(v, false)} per player joined`,
    noJoin: "No player joined from the ads yet",
    none: "No ads run through Replay this month",
  },
  footer: (d: string) => `Made by Replay · ${d}`,
  sharedTitle: (academy: string, month: string) => `${academy} · ${month}`,
  notFound: "This report link was turned off or doesn't exist.",
};

type ValueReportStrings = typeof en;

const ar: ValueReportStrings = {
  nav: "التقرير الشهري",
  title: "شهركم مع Replay",
  subtitle: "شو عمل Replay للأكاديمية هالشهر، بأرقام بتقدروا تشاركوها.",
  month: (m: string) => new Intl.DateTimeFormat("ar-JO-u-nu-latn", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`)),
  soFar: "لحد هلأ هالشهر",
  pick: "الشهر",
  share: "رابط للمشاركة",
  copy: "انسخ الرابط",
  copied: "انتسخ",
  turnOff: "وقّف الرابط",
  shareNote: "أي حدا معه الرابط بشوف أرقام هالشهر. ما في اسم أي ولد عليه.",
  download: "نزّل PDF",
  loading: "عم نجهّز التقرير…",
  error: "ما قدرنا نجهّز التقرير. جرّب كمان دقيقة.",
  footage: {
    title: "الفيديوهات",
    videos: "فيديوهات المباريات",
    clips: "مقاطع انعملت",
    privateSent: (n: number) => `${arCount(n, "مقطع واحد", "مقطعين", "مقاطع", "مقطع")} انبعتت للأهالي بشكل خاص`,
  },
  posts: { title: "منشورات عامة", reach: (n: number) => `وصلت لـ ${fmtNum(n)} شخص` },
  messages: { title: "رسائل واتساب انبعتت", read: (n: number) => `${fmtNum(n)} انقرت` },
  families: {
    title: "أهالي حضروا",
    of: (o: number, t: number) => `${fmtNum(o)} من ${fmtNum(t)} عيلة فتحوا مقطع ابنهم أو فيديو ماتش`,
    none: "لسا ما في أهالي مربوطين",
  },
  featured: {
    title: "أولاد ظهروا",
    of: (f: number, t: number) => `${fmtNum(f)} من ${fmtNum(t)}`,
    target: (n: number) => (n === 0 ? "الهدف: مقطع خاص بعد كل ماتش" : `الهدف: ${n === 1 ? "منشور عام لحاله" : `${n} منشورات عامة لحاله`} لكل ولد، أو خاص بس`),
    notYet: (nums: string) => `لسا: ${nums}`,
    all: "كل الأولاد ظهروا",
  },
  people: { title: "عيلات جديدة", enquiries: "استفسارات", trials: "حصص تجريبية", joined: "لاعبين سجّلوا", since: (d: string) => `محسوبة من ${d}` },
  ads: {
    title: "الإعلانات",
    spend: (v: number) => `${jod(v, true)} انصرفت`,
    cost: (v: number) => `${jod(v, true)} لكل لاعب سجّل`,
    noJoin: "لسا ما سجّل حدا من الإعلانات",
    none: "ما في إعلانات من خلال Replay هالشهر",
  },
  footer: (d: string) => `من Replay · ${d}`,
  sharedTitle: (academy: string, month: string) => `${academy} · ${month}`,
  notFound: "رابط التقرير هاد انوقف أو مش موجود.",
};

export const valueReportStrings = { en, ar };

export function useValueReportCopy(): ValueReportStrings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" };
}

export function formatReportDate(iso: string, locale: "ar" | "en"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Amman" }).format(new Date(iso));
}
