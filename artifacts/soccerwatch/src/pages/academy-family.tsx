import { useMemo } from "react";
import { useLocation, useParams, useSearch } from "wouter";
import {
  useGetAcademyFamilyMe,
  useGetPublicAcademyFamily,
  getGetAcademyFamilyMeQueryKey,
  getGetPublicAcademyFamilyQueryKey,
} from "@workspace/api-client-react";
import { ArrowUpLeft, CalendarDays, Check, Clock3, MapPin, ShieldCheck, Trophy, WalletCards } from "lucide-react";
import { useTranslation } from "@/i18n";
import { guardianContactLinks } from "@/components/academy-console/guardian-contact";

function dateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(value: string, locale: string, options?: Intl.DateTimeFormatOptions) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, options ?? { weekday: "long", day: "numeric", month: "long" }).format(date);
}

function formatMoney(fils: number, locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "JOD", minimumFractionDigits: 2 }).format(fils / 1000);
}

const copy = {
  en: {
    eyebrow: "FAMILY VIEW", welcome: "A little closer to", academy: "the game.",
    intro: "A private window into your player's academy journey.",
    player: "PLAYER", squad: "Squad", number: "Shirt", position: "Position",
    schedule: "Coming up", scheduleHint: "Academy sessions and fixtures",
    training: "Training", match: "Match", noSessions: "Nothing scheduled in this window.",
    attendance: "Attendance", attendanceHint: "Recent check-ins", present: "Present", absent: "Absent", late: "Late", excused: "Excused",
    news: "From the academy", noNews: "There are no recent updates.",
    fees: "Membership", monthly: "Monthly fee", expiry: "Covered through", clear: "All up to date",
    owed: "Months outstanding", balance: "Amount due", paid: "Paid", expiring: "Renewal soon", expired: "Expired", noSubscription: "No active subscription",
    payments: "Payment history", noPayments: "No payments in the last 12 months.", renewal: "Renewal", fee: "Fee",
    months: "months", until: "until", due: "Due", waived: "Waived", whatsapp: "WhatsApp", callAcademy: "Call academy",
    privacy: "Shared privately with your family", contact: "WhatsApp academy", secure: "Private family link",
    loading: "Preparing your family view…", errorTitle: "This family link is unavailable", error: "The link may have expired or been replaced. Please ask your academy for a current link.", retry: "Try again",
    today: "Today", upcoming: "UP NEXT", score: "Final score",
  },
  ar: {
    eyebrow: "مساحة العائلة", welcome: "خطوة أقرب إلى", academy: "رحلته الكروية.",
    intro: "نافذة خاصة لمتابعة مشوار لاعبكم في الأكاديمية.",
    player: "اللاعب", squad: "الفريق", number: "رقم القميص", position: "المركز",
    schedule: "القادم", scheduleHint: "تدريبات ومباريات الأكاديمية",
    training: "تدريب", match: "مباراة", noSessions: "لا توجد مواعيد خلال هذه الفترة.",
    attendance: "الحضور", attendanceHint: "آخر سجلات الحضور", present: "حاضر", absent: "غائب", late: "متأخر", excused: "بعذر",
    news: "أخبار الأكاديمية", noNews: "لا توجد تحديثات جديدة.",
    fees: "الاشتراك", monthly: "الرسوم الشهرية", expiry: "مشمول حتى", clear: "كل شيء محدّث",
    owed: "أشهر مستحقة", balance: "المبلغ المستحق", paid: "مدفوع", expiring: "موعد التجديد قريب", expired: "منتهي", noSubscription: "لا يوجد اشتراك حالي",
    payments: "سجل المدفوعات", noPayments: "لا توجد مدفوعات خلال آخر ١٢ شهراً.", renewal: "تجديد", fee: "رسوم",
    months: "أشهر", until: "حتى", due: "مستحق", waived: "معفى", whatsapp: "واتساب", callAcademy: "اتصال بالأكاديمية",
    privacy: "مشاركة خاصة مع العائلة", contact: "مراسلة الأكاديمية", secure: "رابط عائلي خاص",
    loading: "يتم تجهيز مساحة العائلة…", errorTitle: "رابط العائلة غير متاح", error: "قد يكون الرابط منتهي الصلاحية أو تم استبداله. يرجى طلب رابط جديد من الأكاديمية.", retry: "إعادة المحاولة",
    today: "اليوم", upcoming: "الموعد القادم", score: "النتيجة النهائية",
  },
};

export default function AcademyFamilyPage({ source = "token" }: { source?: "token" | "me" }) {
  const params = useParams<{ token?: string }>();
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const { locale: appLocale } = useTranslation();
  const requestedLanguage = new URLSearchParams(search).get("lang");
  const isEnglish = requestedLanguage === "en" || (
    requestedLanguage === null && source === "me" && appLocale === "en"
  );
  const lang = isEnglish ? "en" : "ar";
  const labels = copy[lang];
  const locale = isEnglish ? "en" : "ar-JO";
  const dateRange = useMemo(() => {
    const now = new Date();
    const from = new Date(now);
    const to = new Date(now);
    from.setDate(from.getDate() - 30);
    to.setDate(to.getDate() + 60);
    return { from: dateOnly(from), to: dateOnly(to) };
  }, []);
  const queryParams = { token: params.token ?? "", ...dateRange };
  const publicFamilyQuery = useGetPublicAcademyFamily(queryParams, {
    query: {
      queryKey: getGetPublicAcademyFamilyQueryKey(queryParams),
      enabled: source === "token" && Boolean(params.token),
      retry: false,
    },
  });
  const meFamilyQuery = useGetAcademyFamilyMe(dateRange, {
    query: {
      queryKey: getGetAcademyFamilyMeQueryKey(dateRange),
      enabled: source === "me",
      retry: false,
    },
  });
  const familyQuery = source === "me" ? meFamilyQuery : publicFamilyQuery;
  const family = familyQuery.data;
  const academyContact = guardianContactLinks(family?.academy.contactPhone);
  const toggleLanguage = () => {
    const nextSearch = new URLSearchParams(search);
    if (isEnglish && source === "me" && appLocale === "en") nextSearch.set("lang", "ar");
    else if (isEnglish) nextSearch.delete("lang");
    else nextSearch.set("lang", "en");
    setLocation(`${location.split("?")[0]}${nextSearch.size ? `?${nextSearch.toString()}` : ""}`);
  };
  const statusLabel = (status: string) => ({
    present: labels.present, absent: labels.absent, late: labels.late, excused: labels.excused,
  }[status] ?? status);
  const financeStatus = family?.finance?.subscriptionStatus;
  const attendanceRate = family?.attendanceSummary.percentPresent;
  const upcomingSessions = family?.sessions.filter((session) => new Date(session.startsAt).getTime() >= Date.now()) ?? [];
  const nextSession = upcomingSessions[0];

  return (
    <main className="family-portal" dir={isEnglish ? "ltr" : "rtl"} lang={isEnglish ? "en" : "ar"} data-testid="academy-family-page">
      <style>{`
        .family-portal{--fp-ink:#203b32;--fp-muted:#718078;--fp-line:#e1e8de;--fp-paper:#f5f7f0;--fp-card:#fffef9;--fp-green:#73965d;--fp-soft:#eaf0e2;min-height:100dvh;overflow:hidden;color:var(--fp-ink);background:radial-gradient(ellipse at 4% 2%,rgba(193,218,159,.28),transparent 32rem),radial-gradient(ellipse at 95% 72%,rgba(234,210,164,.2),transparent 30rem),var(--fp-paper);font-family:var(--app-font-arabic,var(--app-font-sans));}
        .family-portal *{box-sizing:border-box}.family-portal button{font:inherit}.fp-header{height:70px;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(18px,5vw,76px);border-bottom:1px solid rgba(32,59,50,.1);background:rgba(255,254,249,.46);position:relative;z-index:1}.fp-brand{display:flex;align-items:center;gap:10px;font-family:var(--app-font-display);font-size:13px;font-weight:800;letter-spacing:.12em}.fp-brand-mark{display:grid;width:30px;height:30px;place-items:center;border-radius:10px 10px 3px 10px;background:#b8d98a;color:#274637;font-size:15px}.fp-lang{min-height:41px;padding:0 15px;border:1px solid #dce5d9;border-radius:999px;background:rgba(255,254,249,.78);color:var(--fp-ink);font-size:12px;font-weight:800;cursor:pointer;transition:transform .18s,border-color .18s}.fp-lang:hover{transform:translateY(-1px);border-color:#96b280}.fp-wrap{width:min(1110px,calc(100% - 36px));margin:0 auto;padding:48px 0 68px}.fp-intro{display:flex;align-items:flex-end;justify-content:space-between;gap:25px;margin-bottom:34px}.fp-kicker{margin:0 0 12px;color:var(--fp-green);font-family:var(--app-font-mono);font-size:10px;font-weight:800;letter-spacing:.15em;text-transform:uppercase}.fp-intro h1{margin:0;font-family:var(--app-font-display);font-size:clamp(38px,6vw,65px);line-height:.98;letter-spacing:-.045em}.fp-intro h1 em{color:#7e9e62;font-style:normal}.fp-intro-copy{max-width:350px;margin:13px 0 0;color:var(--fp-muted);font-size:14px;line-height:1.8}.fp-trust{display:flex;align-items:center;gap:8px;padding-bottom:4px;color:#718078;font-size:11px}.fp-trust svg{color:#76955e}.fp-academy{display:flex;align-items:center;gap:13px;margin-bottom:15px}.fp-logo{position:relative;display:grid;width:46px;height:46px;flex:0 0 auto;place-items:center;overflow:hidden;border:1px solid var(--fp-line);border-radius:15px;color:var(--fp-green);background:#edf3e6}.fp-logo img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:4px;background:#edf3e6}.fp-academy strong{display:block;font-size:14px}.fp-academy small{display:block;margin-top:3px;color:var(--fp-muted);font-family:var(--app-font-mono);font-size:9px;letter-spacing:.1em}.fp-hero{position:relative;overflow:hidden;padding:clamp(23px,4vw,38px);border:1px solid rgba(32,59,50,.1);border-radius:23px;background:linear-gradient(117deg,rgba(255,254,249,.97),rgba(250,251,244,.86));box-shadow:0 18px 50px rgba(52,74,49,.065)}.fp-hero:after{position:absolute;inset-inline-end:-75px;bottom:-152px;width:340px;height:340px;border:1px solid rgba(119,151,93,.13);border-radius:50%;content:"";box-shadow:0 0 0 24px rgba(119,151,93,.035),0 0 0 58px rgba(119,151,93,.026)}.fp-player{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:22px}.fp-player-main{display:flex;align-items:center;gap:19px;min-width:0}.fp-player-number{display:grid;width:76px;height:76px;flex:0 0 auto;place-items:center;border-radius:22px 22px 7px 22px;color:#456c49;background:#e9f0df;font-family:var(--app-font-display);font-size:37px;font-weight:800}.fp-player h2{margin:0;font-family:var(--app-font-display);font-size:clamp(25px,4vw,36px);letter-spacing:-.025em}.fp-player-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}.fp-chip{padding:6px 10px;border:1px solid #e1e9dd;border-radius:999px;color:#62736a;background:rgba(239,244,233,.7);font-size:11px;font-weight:700}.fp-next{display:flex;align-items:center;gap:13px;min-width:220px;padding:15px 17px;border-inline-start:1px solid var(--fp-line)}.fp-next-icon{display:grid;width:39px;height:39px;flex:0 0 auto;place-items:center;border-radius:13px;color:#557a50;background:#eaf1df}.fp-next small{display:block;color:var(--fp-muted);font-size:9px;font-weight:800;letter-spacing:.1em}.fp-next strong{display:block;margin-top:5px;font-size:12px}.fp-next span{display:block;margin-top:3px;color:var(--fp-muted);font-size:10px}.fp-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(265px,.78fr);gap:17px;margin-top:18px}.fp-card{min-width:0;padding:22px;border:1px solid rgba(32,59,50,.095);border-radius:19px;background:rgba(255,254,249,.9);box-shadow:0 10px 27px rgba(52,74,49,.035)}.fp-card-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:17px}.fp-card-title{margin:0;font-family:var(--app-font-display);font-size:21px;letter-spacing:-.02em}.fp-card-sub{margin:5px 0 0;color:var(--fp-muted);font-size:11px}.fp-count{display:grid;min-width:29px;height:29px;place-items:center;border-radius:10px;color:#698451;background:#edf2e7;font-family:var(--app-font-mono);font-size:11px;font-weight:800}.fp-sessions{display:grid;gap:9px}.fp-session{display:grid;grid-template-columns:63px minmax(0,1fr) auto;align-items:center;gap:13px;padding:13px 12px;border:1px solid #edf0e9;border-radius:13px;background:#fffefa}.fp-date{color:#668054;text-align:center}.fp-date strong{display:block;font-family:var(--app-font-display);font-size:22px;line-height:1}.fp-date span{display:block;margin-top:4px;font-size:9px}.fp-session-info{min-width:0}.fp-session-info strong{display:block;overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.fp-session-info span{display:flex;align-items:center;gap:4px;margin-top:5px;color:var(--fp-muted);font-size:10px}.fp-session-info svg{width:12px;height:12px}.fp-session-type{padding:6px 8px;border-radius:8px;color:#6a805b;background:#eef3e8;font-size:9px;font-weight:800;white-space:nowrap}.fp-score{color:#345643;font-family:var(--app-font-mono);font-size:14px;font-weight:800;white-space:nowrap}.fp-empty{padding:24px 14px;border:1px dashed #dbe4d8;border-radius:13px;color:var(--fp-muted);font-size:12px;text-align:center}.fp-attendance{display:grid;gap:0}.fp-att-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #edf0e9}.fp-att-row:last-child{border-bottom:0}.fp-att-date{color:var(--fp-muted);font-size:10px}.fp-att-type{display:block;margin-top:4px;color:var(--fp-ink);font-size:11px;font-weight:700}.fp-status{padding:5px 9px;border-radius:999px;color:#497a5b;background:#eaf3e8;font-size:9px;font-weight:800}.fp-status.absent{color:#a45e4d;background:#f8ece5}.fp-status.late{color:#9b7337;background:#f7f0dd}.fp-status.excused{color:#687c86;background:#edf1f3}.fp-news-list{display:grid;gap:13px}.fp-news-item{padding-bottom:13px;border-bottom:1px solid #edf0e9}.fp-news-item:last-child{padding-bottom:0;border:0}.fp-news-item h3{margin:0;font-size:12px}.fp-news-item p{margin:7px 0 0;color:#68766e;font-size:11px;line-height:1.75;white-space:pre-line}.fp-news-item time{display:block;margin-top:6px;color:#98a39a;font-size:9px}.fp-finance{position:relative;overflow:hidden;color:#f4f5ec;background:linear-gradient(145deg,#385b48,#284436)}.fp-finance:after{position:absolute;inset-inline-end:-52px;bottom:-118px;width:230px;height:230px;border:1px solid rgba(236,243,218,.15);border-radius:50%;content:"";box-shadow:0 0 0 20px rgba(236,243,218,.035),0 0 0 47px rgba(236,243,218,.025)}.fp-finance .fp-card-head,.fp-finance dl,.fp-finance .fp-pay-status{position:relative;z-index:1}.fp-finance .fp-card-sub{color:rgba(244,245,236,.64)}.fp-finance .fp-count{color:#d2e5b2;background:rgba(245,248,235,.13)}.fp-pay-status{display:flex;align-items:center;gap:7px;margin-bottom:19px;color:#d3e9bd;font-size:11px;font-weight:800}.fp-finance dl{display:grid;gap:13px;margin:0}.fp-finance dl div{display:flex;align-items:center;justify-content:space-between;gap:12px}.fp-finance dt{color:rgba(244,245,236,.68);font-size:11px}.fp-finance dd{margin:0;font-size:13px;font-weight:800}.fp-finance .due{color:#f2c789}.fp-footer{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:26px;padding:0 4px;color:#819087;font-size:10px}.fp-footer a{color:#557b53;font-weight:800;text-decoration:none}.fp-skeleton{height:78px;border-radius:16px;background:linear-gradient(100deg,#e9eee5 20%,#f3f5ef 38%,#e9eee5 56%);background-size:200% 100%;animation:fp-shimmer 1.5s ease infinite}@keyframes fp-shimmer{to{background-position-x:-200%}}.fp-error{width:min(540px,calc(100% - 32px));margin:12vh auto;padding:36px;border:1px solid rgba(32,59,50,.1);border-radius:22px;background:var(--fp-card);text-align:center}.fp-error-mark{display:grid;width:56px;height:56px;margin:0 auto 19px;place-items:center;border-radius:18px;color:#648557;background:#edf3e5}.fp-error h1{margin:0;font-family:var(--app-font-display);font-size:28px}.fp-error p{color:var(--fp-muted);font-size:13px;line-height:1.8}.fp-retry{min-height:43px;margin-top:12px;padding:0 18px;border:0;border-radius:10px;color:#244333;background:#c3dc91;font-weight:800;cursor:pointer}
        @media(max-width:760px){.fp-wrap{padding-top:32px}.fp-intro{align-items:flex-start;flex-direction:column;margin-bottom:23px}.fp-trust{padding:0}.fp-grid{grid-template-columns:1fr}.fp-hero{padding:21px}.fp-player{align-items:flex-start;flex-direction:column}.fp-next{width:100%;min-width:0;border-inline-start:0;border-top:1px solid var(--fp-line);padding:14px 0 0}.fp-card{padding:18px}.fp-finance{grid-row:auto}.fp-footer{align-items:flex-start;flex-direction:column}}@media(max-width:440px){.fp-wrap{width:calc(100% - 24px)}.fp-header{height:60px;padding-inline:14px}.fp-intro h1{font-size:43px}.fp-player-main{gap:13px}.fp-player-number{width:61px;height:61px;font-size:30px;border-radius:18px 18px 6px 18px}.fp-session{grid-template-columns:51px minmax(0,1fr);gap:9px}.fp-session-type,.fp-score{grid-column:2;justify-self:start}.fp-session-type{margin-top:-3px}.fp-session-info{grid-column:2}.fp-date{grid-row:1 / span 2}.fp-session{align-items:start}.fp-session-info strong{white-space:normal}.fp-error{padding:28px 20px}}
      `}</style>
      <style>{`
        .family-portal{--fp-ink:var(--replay-text);--fp-muted:var(--replay-muted);--fp-line:var(--replay-line);--fp-paper:var(--replay-void);--fp-card:var(--replay-surface);--fp-green:var(--replay-turf);--fp-soft:color-mix(in srgb,var(--replay-turf) 13%,var(--replay-surface));background:radial-gradient(ellipse at 4% 2%,color-mix(in srgb,var(--replay-turf) 13%,transparent),transparent 32rem),radial-gradient(ellipse at 95% 72%,color-mix(in srgb,var(--replay-floodlight) 7%,transparent),transparent 30rem),var(--replay-void);color:var(--replay-text)}
        .fp-header,.fp-hero,.fp-card{border-color:var(--replay-line);background:var(--replay-surface);color:var(--replay-text)}
        .fp-header{background:color-mix(in srgb,var(--replay-surface) 92%,transparent)}
        .fp-lang{border-color:var(--replay-line);background:var(--replay-surface);color:var(--replay-text)}
        .fp-brand-mark,.fp-retry{background:var(--replay-floodlight);color:var(--replay-void)}
        .fp-logo,.fp-player-number,.fp-next-icon,.fp-chip,.fp-session-type,.fp-count{border-color:var(--replay-line);background:color-mix(in srgb,var(--replay-turf) 13%,var(--replay-surface));color:var(--replay-turf)}
        .fp-session{border-color:var(--replay-line);background:var(--replay-void)}
        .fp-session-info span,.fp-news-item p,.fp-att-date,.fp-card-sub,.fp-intro-copy,.fp-footer{color:var(--replay-muted)}
        .fp-status{background:color-mix(in srgb,var(--replay-turf) 15%,var(--replay-surface));color:var(--replay-turf)}
        .fp-status.absent{background:color-mix(in srgb,#e78263 17%,var(--replay-surface));color:#f09b7e}
        .fp-status.late{background:color-mix(in srgb,var(--replay-floodlight) 14%,var(--replay-surface));color:var(--replay-floodlight)}
        .fp-status.excused{background:var(--replay-void);color:var(--replay-muted)}
        .fp-empty{border-color:var(--replay-line);color:var(--replay-muted)}
        .fp-news-item,.fp-att-row{border-color:var(--replay-line)}
        .fp-finance{border-color:var(--replay-line);background:linear-gradient(145deg,color-mix(in srgb,var(--replay-turf) 24%,var(--replay-surface)),var(--replay-surface));color:var(--replay-text)}
        .fp-finance .fp-card-sub,.fp-finance dt{color:var(--replay-muted)}
        .fp-finance .fp-pay-status{color:var(--replay-turf)}
        .fp-finance .fp-count{background:color-mix(in srgb,var(--replay-turf) 20%,var(--replay-surface));color:var(--replay-turf)}
        .fp-score{color:var(--replay-turf)}
        .fp-footer a{color:var(--replay-turf)}
        .fp-error{border-color:var(--replay-line);background:var(--replay-surface);color:var(--replay-text)}
        .fp-error-mark{background:color-mix(in srgb,var(--replay-turf) 13%,var(--replay-surface));color:var(--replay-turf)}
        .fp-att-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:12px 0 14px}
        .fp-att-tile{min-width:0;padding:9px 5px;border:1px solid var(--replay-line);border-radius:11px;background:var(--replay-void);text-align:center}
        .fp-att-tile strong{display:block;font-size:18px;line-height:1.25;color:var(--replay-text)}
        .fp-att-tile span{display:block;margin-top:3px;font-size:10px;color:var(--replay-muted)}
        .fp-payment-list{display:grid;gap:8px}
        .fp-payment-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 12px;border:1px solid var(--replay-line);border-radius:12px;background:var(--replay-void)}
        .fp-payment-detail{display:grid;min-width:0;gap:4px}
        .fp-payment-detail strong{font-size:13px;line-height:1.5;color:var(--replay-text)}
        .fp-payment-detail span{font-size:11px;color:var(--replay-muted)}
        .fp-payment-amount{flex-shrink:0;text-align:end;font-size:13px;font-weight:800;color:var(--replay-text)}
        .fp-payment-status{display:inline-flex;width:max-content;align-items:center;border-radius:999px;padding:3px 8px;background:color-mix(in srgb,var(--replay-turf) 13%,var(--replay-surface));color:var(--replay-turf);font-size:10px;font-weight:800}
        .fp-payment-status.due{background:color-mix(in srgb,var(--replay-floodlight) 14%,var(--replay-surface));color:var(--replay-floodlight)}
        .fp-payment-status.waived{color:var(--replay-muted)}
        .fp-contact-actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
      `}</style>
      <header className="fp-header">
        <div className="fp-brand"><span className="fp-brand-mark" aria-hidden="true">S</span><span>SOCCERWATCH</span></div>
        <button type="button" className="fp-lang" onClick={toggleLanguage} aria-label={isEnglish ? "التبديل إلى العربية" : "Switch to English"} data-testid="button-family-language">{isEnglish ? "العربية" : "English"}</button>
      </header>
      {!family && familyQuery.isLoading ? (
        <div className="fp-wrap" aria-label={labels.loading} data-testid="family-loading">
          <div className="fp-skeleton" style={{ height: 215, marginBottom: 17 }} />
          <div className="fp-grid"><div className="fp-skeleton" style={{ height: 290 }} /><div className="fp-skeleton" style={{ height: 290 }} /></div>
        </div>
      ) : !family || familyQuery.isError ? (
        <section className="fp-error" data-testid="family-load-error">
          <span className="fp-error-mark"><ShieldCheck size={24} aria-hidden="true" /></span>
          <h1>{labels.errorTitle}</h1><p>{labels.error}</p>
          <button className="fp-retry" type="button" onClick={() => void familyQuery.refetch()} data-testid="button-family-retry">{labels.retry}</button>
        </section>
      ) : (
        <>
          <div className="fp-wrap">
            <section className="fp-intro">
              <div><p className="fp-kicker">{labels.eyebrow}</p><h1>{labels.welcome}<br /><em>{labels.academy}</em></h1><p className="fp-intro-copy">{labels.intro}</p></div>
              <div className="fp-trust"><ShieldCheck size={16} aria-hidden="true" />{labels.secure}</div>
            </section>
            <section className="fp-hero" data-testid="family-player-summary">
              <div className="fp-academy">
                <span className="fp-logo" data-testid="academy-logo">{family.academy.logoUrl && <img src={family.academy.logoUrl} alt="" />}</span>
                <span><small>{labels.eyebrow}</small><strong dir="auto" data-testid="text-academy-name">{family.academy.name}</strong></span>
              </div>
              <div className="fp-player">
                <div className="fp-player-main">
                  <span className="fp-player-number" data-testid="text-player-jersey">{family.player.jerseyNumber ?? "—"}</span>
                  <div><p className="fp-kicker" style={{ marginBottom: 6 }}>{labels.player}</p><h2 dir="auto" data-testid="text-player-name">{family.player.name}</h2>
                    <div className="fp-player-meta">
                      {family.player.squadName && <span className="fp-chip" data-testid="text-player-squad">{labels.squad} · {family.player.squadName}</span>}
                      {family.player.position && <span className="fp-chip" data-testid="text-player-position">{labels.position} · {family.player.position}</span>}
                    </div>
                  </div>
                </div>
                {nextSession && <div className="fp-next" data-testid="family-next-session">
                  <span className="fp-next-icon"><CalendarDays size={18} aria-hidden="true" /></span>
                  <span><small>{labels.upcoming}</small><strong>{formatDate(nextSession.startsAt, locale)}</strong><span>{new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(nextSession.startsAt))} · {nextSession.type === "match" ? labels.match : labels.training}</span></span>
                </div>}
              </div>
            </section>
            <div className="fp-grid">
              <section className="fp-card" data-testid="family-schedule">
                <div className="fp-card-head"><div><h2 className="fp-card-title">{labels.schedule}</h2><p className="fp-card-sub">{labels.scheduleHint}</p></div><span className="fp-count">{upcomingSessions.length}</span></div>
                {upcomingSessions.length ? <div className="fp-sessions">{upcomingSessions.map((session, index) => {
                  const date = new Date(session.startsAt);
                  return <article className="fp-session" key={`${session.startsAt}-${index}`} data-testid={`family-session-${index}`}>
                    <div className="fp-date"><strong>{new Intl.DateTimeFormat(locale, { day: "numeric" }).format(date)}</strong><span>{new Intl.DateTimeFormat(locale, { month: "short" }).format(date)}</span></div>
                    <div className="fp-session-info"><strong>{session.type === "match" ? `${labels.match}${session.opponent ? ` · ${session.opponent}` : ""}` : labels.training}</strong><span><Clock3 aria-hidden="true" />{new Intl.DateTimeFormat(locale, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date)}{session.endsAt ? ` – ${new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(session.endsAt))}` : ""}</span><span><MapPin aria-hidden="true" />{session.location}</span></div>
                    {session.type === "match" && session.ownScore !== null && session.opponentScore !== null ? <span className="fp-score" aria-label={labels.score}>{session.ownScore} : {session.opponentScore}</span> : <span className="fp-session-type">{session.type === "match" ? labels.match : labels.training}</span>}
                  </article>;
                })}</div> : <div className="fp-empty" data-testid="family-schedule-empty">{labels.noSessions}</div>}
              </section>
              <section className="fp-card" data-testid="family-attendance">
                <div className="fp-card-head"><div><h2 className="fp-card-title">{labels.attendance}{attendanceRate != null ? ` · ${new Intl.NumberFormat(locale).format(attendanceRate)}%` : ""}</h2><p className="fp-card-sub">{labels.attendanceHint}</p></div><span className="fp-count">{family.attendance.length}</span></div>
                <div className="fp-att-summary" data-testid="family-attendance-summary">
                  {[
                    { label: labels.present, value: family.attendanceSummary.present },
                    { label: labels.late, value: family.attendanceSummary.late },
                    { label: labels.absent, value: family.attendanceSummary.absent },
                    { label: labels.excused, value: family.attendanceSummary.excused },
                  ].map((item) => <div className="fp-att-tile" key={item.label}><strong>{new Intl.NumberFormat(locale).format(item.value)}</strong><span>{item.label}</span></div>)}
                </div>
                {family.attendance.length ? <div className="fp-attendance">{family.attendance.slice(0, 6).map((item, index) => <div className="fp-att-row" key={`${item.startsAt}-${index}`} data-testid={`family-attendance-${index}`}>
                  <span><span className="fp-att-date">{formatDate(item.startsAt, locale, { day: "numeric", month: "short", year: "numeric" })} · {item.location}</span><strong className="fp-att-type">{item.type === "match" ? labels.match : labels.training}</strong></span>
                  <span className={`fp-status ${item.status}`} data-testid={`family-attendance-status-${index}`}>{statusLabel(item.status)}</span>
                </div>)}</div> : <div className="fp-empty" data-testid="family-attendance-empty">—</div>}
              </section>
              <section className="fp-card" data-testid="family-announcements">
                <div className="fp-card-head"><div><h2 className="fp-card-title">{labels.news}</h2></div><span className="fp-count">{family.announcements.length}</span></div>
                {family.announcements.length ? <div className="fp-news-list">{family.announcements.map((item, index) => <article className="fp-news-item" key={`${item.createdAt}-${index}`} data-testid={`family-announcement-${index}`}>
                  <h3 dir="auto">{item.title}</h3><p dir="auto">{item.body}</p><time dateTime={item.createdAt}>{formatDate(item.createdAt, locale, { day: "numeric", month: "long", year: "numeric" })}</time>
                </article>)}</div> : <div className="fp-empty" data-testid="family-announcements-empty">{labels.noNews}</div>}
              </section>
              <section className="fp-card fp-finance" data-testid="family-finance">
                <div className="fp-card-head"><div><h2 className="fp-card-title">{labels.fees}</h2><p className="fp-card-sub">{family.finance ? labels.monthly : labels.noSubscription}</p></div><span className="fp-count"><WalletCards size={15} aria-hidden="true" /></span></div>
                {family.finance ? <>
                  <div className="fp-pay-status"><Check size={15} aria-hidden="true" />{financeStatus === "paid" ? labels.paid : financeStatus === "expiring" ? labels.expiring : financeStatus === "expired" ? labels.expired : labels.noSubscription}</div>
                  <dl>
                    <div><dt>{labels.monthly}</dt><dd data-testid="family-monthly-fee">{formatMoney(family.finance.effectiveMonthlyFeeFils, locale)}</dd></div>
                    {family.finance.subscriptionExpiresOn && <div><dt>{labels.expiry}</dt><dd data-testid="family-subscription-expiry">{formatDate(family.finance.subscriptionExpiresOn, locale, { day: "numeric", month: "short", year: "numeric" })}</dd></div>}
                    {family.finance.monthsOwed > 0 && <div><dt>{labels.owed}</dt><dd className="due" data-testid="family-months-owed">{new Intl.NumberFormat(locale).format(family.finance.monthsOwed)}</dd></div>}
                    {family.finance.outstandingFils > 0 ? <div><dt>{labels.balance}</dt><dd className="due" data-testid="family-outstanding-balance">{formatMoney(family.finance.outstandingFils, locale)}</dd></div> : <div><dt>{labels.balance}</dt><dd data-testid="family-outstanding-balance">{labels.clear}</dd></div>}
                  </dl>
                </> : <div className="fp-pay-status"><Trophy size={15} aria-hidden="true" />{labels.noSubscription}</div>}
              </section>
              <section className="fp-card" data-testid="family-payments">
                <div className="fp-card-head">
                  <div><h2 className="fp-card-title">{labels.payments}</h2></div>
                  <span className="fp-count">{family.payments.length}</span>
                </div>
                {family.payments.length ? (
                  <div className="fp-payment-list">
                    {family.payments.map((payment) => {
                      const title = payment.kind === "renewal"
                        ? `${labels.renewal} · ${new Intl.NumberFormat(locale).format(payment.monthsPurchased ?? 0)} ${labels.months} → ${labels.until} ${formatDate(payment.newExpiresOn ?? payment.date, locale, { day: "numeric", month: "short", year: "numeric" })}`
                        : payment.label ?? labels.fee;
                      const status = payment.status === "paid"
                        ? labels.paid
                        : payment.status === "waived"
                          ? labels.waived
                          : labels.due;
                      return (
                        <article className="fp-payment-row" key={payment.id} data-testid={`family-payment-${payment.id}`}>
                          <div className="fp-payment-detail">
                            <strong dir="auto">{title}</strong>
                            <span>
                              {formatDate(payment.date, locale, { day: "numeric", month: "short", year: "numeric" })}
                              {payment.dueDate ? ` · ${labels.due} ${formatDate(payment.dueDate, locale, { day: "numeric", month: "short", year: "numeric" })}` : ""}
                            </span>
                            <span className={`fp-payment-status ${payment.status}`}>{status}</span>
                          </div>
                          <span className="fp-payment-amount">{formatMoney(payment.amountFils, locale)}</span>
                        </article>
                      );
                    })}
                  </div>
                ) : <div className="fp-empty" data-testid="family-payments-empty">{labels.noPayments}</div>}
              </section>
            </div>
            <footer className="fp-footer">
              <span>{labels.privacy}</span>
              {academyContact && (
                <span className="fp-contact-actions">
                  <a href={academyContact.whatsappUrl} target="_blank" rel="noreferrer" data-testid="link-contact-academy-whatsapp">{labels.contact}</a>
                  <a href={academyContact.callUrl} data-testid="link-contact-academy-call">{labels.callAcademy}</a>
                </span>
              )}
            </footer>
          </div>
        </>
      )}
    </main>
  );
}
