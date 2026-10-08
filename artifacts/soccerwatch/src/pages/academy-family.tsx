import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams, useSearch } from "wouter";
import { AnimatePresence } from "framer-motion";
import {
  useGetAcademyFamilyMe,
  useClaimAcademyFamily,
  getGetAcademyFamilyMeQueryKey,
  type AcademySessionRecording,
} from "@workspace/api-client-react";
import { CalendarDays, Check, Clock3, Globe, MapPin, Play, ShieldCheck, Trophy, WalletCards } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/lib/auth";
import { AcademySidebarBrand } from "@/components/academy-console/academy-brand";
import { ClipPlayer } from "@/components/clip-player/ClipPlayer";
import { getBunnyMp4FallbackSource } from "@/lib/bunnyPlayback";

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
    months: "months", until: "until", due: "Due", waived: "Waived",
    privacy: "Shared privately with your family", contact: "Contact academy", secure: "Private family link",
    inviteTitle: "Connect this player to your family account",
    inviteDescription: "Sign in or create a SoccerWatch account to connect this player and see their academy schedule, attendance, and updates.",
    signIn: "Sign in",
    createAccount: "Create account",
    claiming: "Connecting this player to your account…",
    claimErrorTitle: "This family invite is unavailable",
    claimError: "Ask the academy for a current invite link, then try again.",
    claimRetry: "Try again",
    switchPlayer: "View another linked player",
    loading: "Preparing your family view…", errorTitle: "This family link is unavailable", error: "The link may have expired or been replaced. Please ask your academy for a current link.", retry: "Try again",
    today: "Today", upcoming: "UP NEXT", score: "Final score",
    footage: "Session footage", footageHint: "Recordings shared for sessions in your schedule.",
    noFootage: "No session footage has been shared yet.", watch: "Watch",
    footageStatus: {
      none: "Not booked",
      no_camera: "No camera assigned",
      scheduled: "Footage booked",
      recording: "Recording",
      processing: "Preparing footage",
      ready: "Footage ready",
      failed: "Booking failed",
      unavailable: "No footage available",
    },
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
    months: "أشهر", until: "حتى", due: "مستحق", waived: "معفى",
    privacy: "مشاركة خاصة مع العائلة", contact: "تواصل مع الأكاديمية", secure: "رابط عائلي خاص",
    inviteTitle: "اربط اللاعب بحساب العائلة",
    inviteDescription: "سجّل الدخول أو أنشئ حساب SoccerWatch لربط اللاعب ومتابعة مواعيده وحضوره وأخبار الأكاديمية.",
    signIn: "تسجيل الدخول",
    createAccount: "إنشاء حساب",
    claiming: "جارٍ ربط اللاعب بحسابكم…",
    claimErrorTitle: "رابط العائلة غير متاح",
    claimError: "اطلبوا رابط دعوة حديثًا من الأكاديمية ثم حاولوا مجددًا.",
    claimRetry: "حاول مجددًا",
    switchPlayer: "عرض لاعب آخر مرتبط",
    loading: "يتم تجهيز مساحة العائلة…", errorTitle: "رابط العائلة غير متاح", error: "قد يكون الرابط منتهي الصلاحية أو تم استبداله. يرجى طلب رابط جديد من الأكاديمية.", retry: "إعادة المحاولة",
    today: "اليوم", upcoming: "الموعد القادم", score: "النتيجة النهائية",
    footage: "تسجيلات المواعيد", footageHint: "التسجيلات التي تمت مشاركتها لمواعيد اللاعب.",
    noFootage: "لم تتم مشاركة تسجيلات للمواعيد بعد.", watch: "مشاهدة",
    footageStatus: {
      none: "غير محجوز",
      no_camera: "لا توجد كاميرا مخصصة",
      scheduled: "تم حجز التسجيل",
      recording: "جارٍ التسجيل",
      processing: "جارٍ تجهيز التسجيل",
      ready: "التسجيل جاهز",
      failed: "تعذّر حجز التسجيل",
      unavailable: "لا يتوفر تسجيل لهذا الموعد",
    },
  },
};

function extractBunnyVideoId(value: string): string {
  try {
    return new URL(value).pathname.split("/").filter(Boolean)[0] ?? value;
  } catch {
    return value;
  }
}

export default function AcademyFamilyPage({ source = "token" }: { source?: "token" | "me" }) {
  const params = useParams<{ token?: string }>();
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const { locale: appLocale } = useTranslation();
  const { user, isLoading: authLoading, isGuest } = useAuth();
  const [playing, setPlaying] = useState<{
    recording: AcademySessionRecording;
    startsAt: string;
    location: string;
  } | null>(null);
  const claim = useClaimAcademyFamily();
  const attemptedToken = useRef<string | null>(null);
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
  const rawPlayerId = new URLSearchParams(search).get("playerId");
  const requestedPlayerId = rawPlayerId && /^\d+$/.test(rawPlayerId) ? Number(rawPlayerId) : undefined;
  const queryParams = {
    ...dateRange,
    ...(source === "me" && Number.isSafeInteger(requestedPlayerId) && requestedPlayerId! > 0
      ? { playerId: requestedPlayerId }
      : {}),
  };
  const familyQuery = useGetAcademyFamilyMe(queryParams, {
    query: {
      queryKey: getGetAcademyFamilyMeQueryKey(queryParams),
      enabled: source === "me",
      retry: false,
    },
  });
  const family = familyQuery.data;
  const familyToken = params.token ?? "";

  useEffect(() => {
    if (source !== "token" || authLoading || !user || isGuest || !familyToken) return;
    if (attemptedToken.current === familyToken) return;
    attemptedToken.current = familyToken;
    void claim.mutateAsync({ data: { token: familyToken } })
      .then((result) => setLocation(`/academy/me?playerId=${result.playerId}`))
      .catch(() => undefined);
  }, [authLoading, claim.mutateAsync, familyToken, isGuest, setLocation, source, user]);

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
  const footageSessions = family?.sessions.filter((session) => (
    session.recordings.length > 0 || session.footage.status !== "none"
  )) ?? [];
  const nextSession = upcomingSessions[0];

  if (source === "token") {
    const invitePath = `/p/${encodeURIComponent(familyToken)}`;
    const signInPath = `/sign-in?redirect_url=${encodeURIComponent(invitePath)}`;
    const signUpPath = `/sign-up?redirect_url=${encodeURIComponent(invitePath)}`;
    const showAuthChoices = !authLoading && (!user || isGuest);
    const showClaimProgress = authLoading || (Boolean(user) && !isGuest && !claim.isError);
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-void px-5 py-10" dir={isEnglish ? "ltr" : "rtl"} lang={isEnglish ? "en" : "ar"} data-testid="academy-family-invite">
        <section className="w-full max-w-lg rounded-3xl border border-line bg-surface p-7 text-center shadow-2xl shadow-black/10 sm:p-9">
          <div className="mx-auto flex justify-center">
            <AcademySidebarBrand academyName="Academy" academyLogoUrl={null} caption={labels.eyebrow} direction={isEnglish ? "ltr" : "rtl"} />
          </div>
          <div className="mx-auto mt-8 grid h-14 w-14 place-items-center rounded-2xl bg-turf/10 text-turf">
            <ShieldCheck size={25} aria-hidden="true" />
          </div>
          <h1 className="mt-5 font-display text-3xl font-bold tracking-tight text-text" data-testid="text-family-invite-title">
            {claim.isError ? labels.claimErrorTitle : labels.inviteTitle}
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-text">
            {claim.isError ? labels.claimError : labels.inviteDescription}
          </p>
          {showAuthChoices ? (
            <div className="mt-7 grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={() => setLocation(signInPath)} className="inline-flex min-h-12 items-center justify-center rounded-xl bg-floodlight px-5 font-bold text-void" data-testid="link-family-sign-in">
                {labels.signIn}
              </button>
              <button type="button" onClick={() => setLocation(signUpPath)} className="inline-flex min-h-12 items-center justify-center rounded-xl border border-line bg-raised px-5 font-bold text-text" data-testid="link-family-sign-up">
                {labels.createAccount}
              </button>
            </div>
          ) : null}
          {showClaimProgress ? (
            <p className="mt-6 text-sm font-semibold text-turf" role="status" data-testid="family-claim-loading">
              {authLoading ? labels.loading : labels.claiming}
            </p>
          ) : null}
          {claim.isError ? (
            <button
              type="button"
              onClick={() => {
                attemptedToken.current = null;
                claim.reset();
              }}
              className="mt-6 min-h-11 rounded-xl bg-floodlight px-5 font-bold text-void"
              data-testid="button-family-claim-retry"
            >
              {labels.claimRetry}
            </button>
          ) : null}
          <button
            type="button"
            onClick={toggleLanguage}
            aria-label="Change language"
            className="mt-7 inline-flex min-h-10 items-center gap-2 rounded-full border border-line bg-raised px-4 text-sm font-semibold text-text"
            data-testid="button-family-invite-language"
          >
            <Globe className="h-4 w-4" aria-hidden="true" />
            {lang.toUpperCase()}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="family-portal" dir={isEnglish ? "ltr" : "rtl"} lang={isEnglish ? "en" : "ar"} data-testid="academy-family-page">
      <style>{`
        .family-portal{--fp-ink:#203b32;--fp-muted:#718078;--fp-line:#e1e8de;--fp-paper:#f5f7f0;--fp-card:#fffef9;--fp-green:#73965d;--fp-soft:#eaf0e2;min-height:100dvh;overflow:hidden;color:var(--fp-ink);background:radial-gradient(ellipse at 4% 2%,rgba(193,218,159,.28),transparent 32rem),radial-gradient(ellipse at 95% 72%,rgba(234,210,164,.2),transparent 30rem),var(--fp-paper);font-family:var(--app-font-arabic,var(--app-font-sans));}
        .family-portal *{box-sizing:border-box}.family-portal button{font:inherit}.fp-wrap{width:min(1110px,calc(100% - 36px));margin:0 auto;padding:48px 0 68px}.fp-intro{display:flex;align-items:flex-end;justify-content:space-between;gap:25px;margin-bottom:34px}.fp-kicker{margin:0 0 12px;color:var(--fp-green);font-family:var(--app-font-mono);font-size:10px;font-weight:800;letter-spacing:.15em;text-transform:uppercase}.fp-intro h1{margin:0;font-family:var(--app-font-display);font-size:clamp(38px,6vw,65px);line-height:.98;letter-spacing:-.045em}.fp-intro h1 em{color:#7e9e62;font-style:normal}.fp-intro-copy{max-width:350px;margin:13px 0 0;color:var(--fp-muted);font-size:14px;line-height:1.8}.fp-trust{display:flex;align-items:center;gap:8px;padding-bottom:4px;color:#718078;font-size:11px}.fp-trust svg{color:#76955e}.fp-hero{position:relative;overflow:hidden;padding:clamp(23px,4vw,38px);border:1px solid rgba(32,59,50,.1);border-radius:23px;background:linear-gradient(117deg,rgba(255,254,249,.97),rgba(250,251,244,.86));box-shadow:0 18px 50px rgba(52,74,49,.065)}.fp-hero:after{position:absolute;inset-inline-end:-75px;bottom:-152px;width:340px;height:340px;border:1px solid rgba(119,151,93,.13);border-radius:50%;content:"";box-shadow:0 0 0 24px rgba(119,151,93,.035),0 0 0 58px rgba(119,151,93,.026)}.fp-player{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:22px}.fp-player-main{display:flex;align-items:center;gap:19px;min-width:0}.fp-player-number{display:grid;width:76px;height:76px;flex:0 0 auto;place-items:center;border-radius:22px 22px 7px 22px;color:#456c49;background:#e9f0df;font-family:var(--app-font-display);font-size:37px;font-weight:800}.fp-player h2{margin:0;font-family:var(--app-font-display);font-size:clamp(25px,4vw,36px);letter-spacing:-.025em}.fp-player-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}.fp-chip{padding:6px 10px;border:1px solid #e1e9dd;border-radius:999px;color:#62736a;background:rgba(239,244,233,.7);font-size:11px;font-weight:700}.fp-next{display:flex;align-items:center;gap:13px;min-width:220px;padding:15px 17px;border-inline-start:1px solid var(--fp-line)}.fp-next-icon{display:grid;width:39px;height:39px;flex:0 0 auto;place-items:center;border-radius:13px;color:#557a50;background:#eaf1df}.fp-next small{display:block;color:var(--fp-muted);font-size:9px;font-weight:800;letter-spacing:.1em}.fp-next strong{display:block;margin-top:5px;font-size:12px}.fp-next span{display:block;margin-top:3px;color:var(--fp-muted);font-size:10px}.fp-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(265px,.78fr);gap:17px;margin-top:18px}.fp-card{min-width:0;padding:22px;border:1px solid rgba(32,59,50,.095);border-radius:19px;background:rgba(255,254,249,.9);box-shadow:0 10px 27px rgba(52,74,49,.035)}.fp-card-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:17px}.fp-card-title{margin:0;font-family:var(--app-font-display);font-size:21px;letter-spacing:-.02em}.fp-card-sub{margin:5px 0 0;color:var(--fp-muted);font-size:11px}.fp-count{display:grid;min-width:29px;height:29px;place-items:center;border-radius:10px;color:#698451;background:#edf2e7;font-family:var(--app-font-mono);font-size:11px;font-weight:800}.fp-sessions{display:grid;gap:9px}.fp-session{display:grid;grid-template-columns:63px minmax(0,1fr) auto;align-items:center;gap:13px;padding:13px 12px;border:1px solid #edf0e9;border-radius:13px;background:#fffefa}.fp-date{color:#668054;text-align:center}.fp-date strong{display:block;font-family:var(--app-font-display);font-size:22px;line-height:1}.fp-date span{display:block;margin-top:4px;font-size:9px}.fp-session-info{min-width:0}.fp-session-info strong{display:block;overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.fp-session-info span{display:flex;align-items:center;gap:4px;margin-top:5px;color:var(--fp-muted);font-size:10px}.fp-session-info svg{width:12px;height:12px}.fp-session-type{padding:6px 8px;border-radius:8px;color:#6a805b;background:#eef3e8;font-size:9px;font-weight:800;white-space:nowrap}.fp-score{color:#345643;font-family:var(--app-font-mono);font-size:14px;font-weight:800;white-space:nowrap}.fp-empty{padding:24px 14px;border:1px dashed #dbe4d8;border-radius:13px;color:var(--fp-muted);font-size:12px;text-align:center}.fp-attendance{display:grid;gap:0}.fp-att-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #edf0e9}.fp-att-row:last-child{border-bottom:0}.fp-att-date{color:var(--fp-muted);font-size:10px}.fp-att-type{display:block;margin-top:4px;color:var(--fp-ink);font-size:11px;font-weight:700}.fp-status{padding:5px 9px;border-radius:999px;color:#497a5b;background:#eaf3e8;font-size:9px;font-weight:800}.fp-status.absent{color:#a45e4d;background:#f8ece5}.fp-status.late{color:#9b7337;background:#f7f0dd}.fp-status.excused{color:#687c86;background:#edf1f3}.fp-news-list{display:grid;gap:13px}.fp-news-item{padding-bottom:13px;border-bottom:1px solid #edf0e9}.fp-news-item:last-child{padding-bottom:0;border:0}.fp-news-item h3{margin:0;font-size:12px}.fp-news-item p{margin:7px 0 0;color:#68766e;font-size:11px;line-height:1.75;white-space:pre-line}.fp-news-item time{display:block;margin-top:6px;color:#98a39a;font-size:9px}.fp-finance{position:relative;overflow:hidden;color:#f4f5ec;background:linear-gradient(145deg,#385b48,#284436)}.fp-finance:after{position:absolute;inset-inline-end:-52px;bottom:-118px;width:230px;height:230px;border:1px solid rgba(236,243,218,.15);border-radius:50%;content:"";box-shadow:0 0 0 20px rgba(236,243,218,.035),0 0 0 47px rgba(236,243,218,.025)}.fp-finance .fp-card-head,.fp-finance dl,.fp-finance .fp-pay-status{position:relative;z-index:1}.fp-finance .fp-card-sub{color:rgba(244,245,236,.64)}.fp-finance .fp-count{color:#d2e5b2;background:rgba(245,248,235,.13)}.fp-pay-status{display:flex;align-items:center;gap:7px;margin-bottom:19px;color:#d3e9bd;font-size:11px;font-weight:800}.fp-finance dl{display:grid;gap:13px;margin:0}.fp-finance dl div{display:flex;align-items:center;justify-content:space-between;gap:12px}.fp-finance dt{color:rgba(244,245,236,.68);font-size:11px}.fp-finance dd{margin:0;font-size:13px;font-weight:800}.fp-finance .due{color:#f2c789}.fp-footer{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:26px;padding:0 4px;color:#819087;font-size:10px}.fp-footer a{color:#557b53;font-weight:800;text-decoration:none}.fp-skeleton{height:78px;border-radius:16px;background:linear-gradient(100deg,#e9eee5 20%,#f3f5ef 38%,#e9eee5 56%);background-size:200% 100%;animation:fp-shimmer 1.5s ease infinite}@keyframes fp-shimmer{to{background-position-x:-200%}}.fp-error{width:min(540px,calc(100% - 32px));margin:12vh auto;padding:36px;border:1px solid rgba(32,59,50,.1);border-radius:22px;background:var(--fp-card);text-align:center}.fp-error-mark{display:grid;width:56px;height:56px;margin:0 auto 19px;place-items:center;border-radius:18px;color:#648557;background:#edf3e5}.fp-error h1{margin:0;font-family:var(--app-font-display);font-size:28px}.fp-error p{color:var(--fp-muted);font-size:13px;line-height:1.8}.fp-retry{min-height:43px;margin-top:12px;padding:0 18px;border:0;border-radius:10px;color:#244333;background:#c3dc91;font-weight:800;cursor:pointer}
        @media(max-width:760px){.fp-wrap{padding-top:32px}.fp-intro{align-items:flex-start;flex-direction:column;margin-bottom:23px}.fp-trust{padding:0}.fp-grid{grid-template-columns:1fr}.fp-hero{padding:21px}.fp-player{align-items:flex-start;flex-direction:column}.fp-next{width:100%;min-width:0;border-inline-start:0;border-top:1px solid var(--fp-line);padding:14px 0 0}.fp-card{padding:18px}.fp-finance{grid-row:auto}.fp-footer{align-items:flex-start;flex-direction:column}}@media(max-width:440px){.fp-wrap{width:calc(100% - 24px)}.fp-intro h1{font-size:43px}.fp-player-main{gap:13px}.fp-player-number{width:61px;height:61px;font-size:30px;border-radius:18px 18px 6px 18px}.fp-session{grid-template-columns:51px minmax(0,1fr);gap:9px}.fp-session-type,.fp-score{grid-column:2;justify-self:start}.fp-session-type{margin-top:-3px}.fp-session-info{grid-column:2}.fp-date{grid-row:1 / span 2}.fp-session{align-items:start}.fp-session-info strong{white-space:normal}.fp-error{padding:28px 20px}}
      `}</style>
      <style>{`
        .family-portal{--fp-ink:var(--replay-text);--fp-muted:var(--replay-muted);--fp-line:var(--replay-line);--fp-paper:var(--replay-void);--fp-card:var(--replay-surface);--fp-green:var(--replay-turf);--fp-soft:color-mix(in srgb,var(--replay-turf) 13%,var(--replay-surface));background:radial-gradient(ellipse at 4% 2%,color-mix(in srgb,var(--replay-turf) 13%,transparent),transparent 32rem),radial-gradient(ellipse at 95% 72%,color-mix(in srgb,var(--replay-floodlight) 7%,transparent),transparent 30rem),var(--replay-void);color:var(--replay-text)}
        .fp-hero,.fp-card{border-color:var(--replay-line);background:var(--replay-surface);color:var(--replay-text)}
        .fp-retry{background:var(--replay-floodlight);color:var(--replay-void)}
        .fp-player-number,.fp-next-icon,.fp-chip,.fp-session-type,.fp-count{border-color:var(--replay-line);background:color-mix(in srgb,var(--replay-turf) 13%,var(--replay-surface));color:var(--replay-turf)}
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
        .fp-switcher{display:grid;max-width:420px;gap:6px;margin-bottom:18px;color:var(--replay-muted);font-size:11px;font-weight:700}
        .fp-switcher select{min-height:42px;width:100%;border:1px solid var(--replay-line);border-radius:11px;background:var(--replay-void);padding:0 12px;color:var(--replay-text);font:inherit}
      `}</style>
      <header className="replay-header sticky top-3 z-40 mx-3 mt-3 mb-2 shrink-0 rounded-2xl border border-line bg-surface/95 px-4 py-2.5 backdrop-blur-md">
        <div className="flex items-center justify-between gap-3">
          <AcademySidebarBrand
            academyName={family?.academy.name ?? "Academy"}
            academyLogoUrl={family?.academy.logoUrl ?? null}
            caption={labels.eyebrow}
            direction={isEnglish ? "ltr" : "rtl"}
          />
          <button
            type="button"
            onClick={toggleLanguage}
            aria-label="Change language"
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-raised px-3.5 py-2 text-sm font-semibold text-foreground"
            data-testid="button-family-language"
          >
            <Globe className="h-4 w-4" aria-hidden="true" />
            <span>{lang.toUpperCase()}</span>
          </button>
        </div>
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
              {family.players.length > 1 && (
                <label className="fp-switcher" htmlFor="family-player-switcher">
                  <span>{labels.switchPlayer}</span>
                  <select
                    id="family-player-switcher"
                    value={family.player.id}
                    onChange={(event) => {
                      const nextSearch = new URLSearchParams(search);
                      nextSearch.set("playerId", event.target.value);
                      const query = nextSearch.toString();
                      setLocation(`/academy/me${query ? `?${query}` : ""}`);
                    }}
                    data-testid="select-family-player"
                  >
                    {family.players.map((linkedPlayer) => (
                      <option key={linkedPlayer.id} value={linkedPlayer.id}>
                        {linkedPlayer.name} · {linkedPlayer.academyName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
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
              <section className="fp-card" data-testid="family-session-footage">
                <div className="fp-card-head">
                  <div><h2 className="fp-card-title">{labels.footage}</h2><p className="fp-card-sub">{labels.footageHint}</p></div>
                  <span className="fp-count">{footageSessions.reduce((total, session) => total + session.recordings.length, 0)}</span>
                </div>
                {footageSessions.length ? <div className="fp-sessions">{footageSessions.flatMap((session, index) => {
                  const date = new Date(session.startsAt);
                  const title = session.type === "match"
                    ? `${labels.match}${session.opponent ? ` · ${session.opponent}` : ""}`
                    : labels.training;
                  if (session.recordings.length === 0) {
                    const statusLabel = labels.footageStatus[session.footage.status];
                    return [<article className="fp-session" key={`footage-status-${session.startsAt}-${index}`} data-testid={`family-footage-status-${index}`}>
                      <div className="fp-date"><strong>{new Intl.DateTimeFormat(locale, { day: "numeric" }).format(date)}</strong><span>{new Intl.DateTimeFormat(locale, { month: "short" }).format(date)}</span></div>
                      <div className="fp-session-info">
                        <strong>{title}</strong>
                        <span><Clock3 aria-hidden="true" />{new Intl.DateTimeFormat(locale, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date)}</span>
                        <span><MapPin aria-hidden="true" />{session.location}</span>
                        <span>{session.footage.note || statusLabel}</span>
                      </div>
                      <span className="fp-session-type">{statusLabel}</span>
                    </article>];
                  }
                  return session.recordings.map((recording) => <article className="fp-session" key={recording.id} data-testid={`family-footage-${recording.id}`}>
                    <div className="fp-date"><strong>{new Intl.DateTimeFormat(locale, { day: "numeric" }).format(date)}</strong><span>{new Intl.DateTimeFormat(locale, { month: "short" }).format(date)}</span></div>
                    <div className="fp-session-info">
                      <strong>{title}</strong>
                      <span><Clock3 aria-hidden="true" />{new Intl.DateTimeFormat(locale, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date)} · {recording.timeSlot}</span>
                      <span><MapPin aria-hidden="true" />{session.location} · {recording.court}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPlaying({ recording, startsAt: session.startsAt, location: session.location })}
                      className="fp-session-type inline-flex items-center gap-1.5 border-0"
                      style={{ cursor: "pointer", background: "var(--replay-floodlight)", color: "var(--replay-void)" }}
                      data-testid={`button-family-watch-${recording.id}`}
                    >
                      <Play size={14} aria-hidden="true" />{labels.watch}
                    </button>
                  </article>);
                })}</div> : <div className="fp-empty" data-testid="family-session-footage-empty">{labels.noFootage}</div>}
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
            <footer className="fp-footer"><span>{labels.privacy}</span>{family.academy.contactPhone && <a href={`tel:${family.academy.contactPhone}`} data-testid="link-contact-academy">{labels.contact}</a>}</footer>
          </div>
        </>
      )}
      {playing && <AnimatePresence>
        <ClipPlayer
          src={playing.recording.videoUrl}
          proxySrc={`/api/hls-proxy/manifest?url=${encodeURIComponent(playing.recording.videoUrl)}`}
          fallbackSrc={getBunnyMp4FallbackSource(playing.recording.videoUrl)}
          title={`${family?.academy.name ?? "Academy"} · ${playing.location} · ${playing.recording.date} ${playing.recording.timeSlot}`}
          source={{ kind: "bunny", videoId: extractBunnyVideoId(playing.recording.videoUrl) }}
          layout="overlay"
          canSave={false}
          onRequireAuth={() => setPlaying(null)}
          onSave={async () => { throw new Error("Saving is unavailable in family view."); }}
          onClose={() => setPlaying(null)}
        />
      </AnimatePresence>}
    </main>
  );
}
