import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Switch, Route, Router as WouterRouter, useLocation, useParams } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, useClerk, useUser } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { arSA } from "@clerk/localizations";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { AuthIdentityPanel } from "@/components/auth-identity-panel";
import { clerkAppearance } from "@/lib/clerkAppearance";
import { LocaleProvider, useLocale, useTranslation } from "@/i18n";
import { FullscreenVideoProvider } from "@/lib/fullscreen-video";
import { lazyPage } from "@/lib/lazy-page";
import { useAuth } from "@/lib/auth";
import { consoleHomeTarget, consumeExplicitAuthRedirect, getIncompleteProfileOnboardingRedirect, getPostAuthLanding, getRedirectPathFromSearch, getSafeRedirectPath, rememberExplicitAuthRedirect, withRedirectPath } from "@/lib/auth-redirect";
import { isPublicStandalonePath } from "@/lib/public-paths";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft, Globe } from "lucide-react";

// Every page loads its own code when first opened (lib/lazy-page.ts).

const Landing = lazyPage(() => import("@/pages/login"));
const Home = lazyPage(() => import("@/pages/home"));
// import Watch from "@/pages/watch";
const Fields = lazyPage(() => import("@/pages/fields"));
const FieldDetail = lazyPage(() => import("@/pages/field-detail"));
const Player = lazyPage(() => import("@/pages/player"));
const Profile = lazyPage(() => import("@/pages/profile"));
const MyClips = lazyPage(() => import("@/pages/my-clips"));
const Account = lazyPage(() => import("@/pages/account"));
const Admin = lazyPage(() => import("@/pages/admin"));
const AdminDebug = lazyPage(() => import("@/pages/admin-debug"));
const AdminSetup = lazyPage(() => import("@/pages/admin-setup"));
const Onboarding = lazyPage(() => import("@/pages/onboarding"));
const NotFound = lazyPage(() => import("@/pages/not-found"));
const InstagramCallbackPage = lazyPage(() => import("@/pages/instagram-callback"));
const Academies = lazyPage(() => import("@/pages/academies"));
const View = lazyPage(() => import("@/pages/view"));
const Live = lazyPage(() => import("@/pages/live"));
const ClaimDemo = lazyPage(() => import("@/pages/claim-demo"));
const ClaimChain = lazyPage(() => import("@/pages/claim-chain"));
const ClaimGame = lazyPage(() => import("@/pages/claim-game"));
const CheckDeckPage = lazyPage(() => import("@/pages/check-deck"));
const IdentityBoard = lazyPage(() => import("@/pages/identity-board"));
const Owner = lazyPage(() => import("@/pages/owner"));
const OwnerVar = lazyPage(() => import("@/pages/owner-var"));
const OwnerShare = lazyPage(() => import("@/pages/owner-share"));
const KidClipPage = lazyPage(() => import("@/pages/kid-clip"));
const ValueReportPage = lazyPage(() => import("@/pages/value-report"));
const MatchPage = lazyPage(() => import("@/pages/match"));
const Matches = lazyPage(() => import("@/pages/matches"));
const FriendsPage = lazyPage(() => import("@/pages/friends"));
const FriendLinkPage = lazyPage(() => import("@/pages/friend-link"));
const BookPage = lazyPage(() => import("@/pages/book"));
const LegalPage = lazyPage(() => import("@/pages/legal").then((m) => ({ default: m.LegalPage })));
const DeleteAccountPage = lazyPage(() => import("@/pages/delete-account"));
const BlockedPlayers = lazyPage(() => import("@/pages/blocked-players"));
const LegacyDemoPage = lazyPage(() => import("@/pages/demo-route"));
const DemoPage = lazyPage(() => import("@/pages/demo/DemoPage"));
const SimpleDemo = lazyPage(() => import("@/pages/demo/SimpleDemo"));
const AcademyConsole = lazyPage(() => import("@/pages/academy-console"));
const FieldConsole = lazyPage(() => import("@/pages/field-console"));
const VenueSitePage = lazyPage(() => import("@/pages/venue-site"));
const VenueAwardsPage = lazyPage(() => import("@/pages/venue-awards"));
const AcademyJoinPage = lazyPage(() => import("@/pages/academy-join"));
const AcademyFamilyPage = lazyPage(() => import("@/pages/academy-family"));
const AcademyMatchPage = lazyPage(() => import("@/pages/academy-match"));
const AcademyInvitePage = lazyPage(() => import("@/pages/academy-invite"));
const WeeklyHighlightPage = lazyPage(() => import("@/pages/weekly-highlight"));

const InstagramDevPreview = import.meta.env.DEV
  ? lazy(() => import("@/pages/instagram-dev-preview"))
  : null;
const MatchReportDevPreview = import.meta.env.DEV
  ? lazy(() => import("@/pages/match-report-dev-preview"))
  : null;
const EarlyPlayDevPreview = import.meta.env.DEV
  ? lazy(() => import("@/pages/early-play-dev-preview"))
  : null;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      retry: 1,
    },
  },
});

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

function AuthHeroLayout({
  children,
  showBackButton = true,
}: {
  children: React.ReactNode;
  showBackButton?: boolean;
}) {
  const { t, locale, setLocale } = useTranslation();
  const [, setLocation] = useLocation();

  useEffect(() => {
    const hideDevelopmentBadge = () => {
      const card = document.querySelector(".cl-cardBox");
      if (!card) return;

      const exactTextElement = Array.from(card.querySelectorAll("*")).find(
        (element) =>
          element.children.length === 0 &&
          element.textContent?.trim().toLowerCase() === "development mode",
      );

      if (!exactTextElement) return;

      let badge: HTMLElement | null = exactTextElement as HTMLElement;
      while (
        badge.parentElement &&
        badge.parentElement !== card &&
        badge.parentElement.textContent?.trim().toLowerCase() ===
          "development mode"
      ) {
        badge = badge.parentElement;
      }

      badge.style.display = "none";
    };

    hideDevelopmentBadge();
    const observer = new MutationObserver(hideDevelopmentBadge);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => observer.disconnect();
  }, []);

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      setLocation("/");
    }
  };

  return (
    <div className="auth-shell relative h-[100dvh] min-h-[100dvh] overflow-x-hidden overflow-y-auto no-scrollbar bg-void">
      <style>{`
        @keyframes rpDrift {
          0%, 100% { transform: translate(0, 0); }
          50% { transform: translate(-3%, 3%); }
        }
        .cl-cardBox,
        .cl-cardBox .cl-footer,
        .cl-cardBox .cl-footerAction {
          background: var(--replay-surface) !important;
          background-color: var(--replay-surface) !important;
          border-color: var(--replay-line) !important;
          box-shadow: none !important;
        }
        .cl-cardBox .cl-footer {
          padding: 0 24px 26px !important;
        }
        .cl-cardBox .cl-footerAction {
          display: flex !important;
          flex-direction: row !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 4px !important;
          margin: 0 !important;
          padding: 0 !important;
          white-space: nowrap !important;
        }
        .cl-cardBox .cl-footerActionText,
        .cl-cardBox .cl-footerActionLink {
          margin: 0 !important;
          white-space: nowrap !important;
        }
        .cl-cardBox [class*="development"],
        .cl-cardBox [data-localization-key*="development"] {
          display: none !important;
        }
      `}</style>
      <div
        className="replay-auth-atmosphere absolute -inset-[10%] z-0"
        style={{
          background: `
            radial-gradient(60% 45% at 88% 6%, color-mix(in srgb, var(--replay-turf) 13%, transparent), transparent 60%),
            radial-gradient(55% 50% at 12% 94%, color-mix(in srgb, var(--replay-violet) 14%, transparent), transparent 60%),
            var(--replay-void)
          `,
          animation: "rpDrift 18s ease-in-out infinite",
        }}
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 z-0 opacity-30"
        style={{
          backgroundImage: "radial-gradient(color-mix(in srgb, var(--replay-text) 10%, transparent) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage: "radial-gradient(60% 60% at 50% 30%, #000, transparent)",
          WebkitMaskImage: "radial-gradient(60% 60% at 50% 30%, #000, transparent)",
        }}
        aria-hidden="true"
      />

      {/* Auth controls stay fixed inside the centered 440px app frame on desktop. */}
      {showBackButton && (
        <button
          type="button"
          onClick={handleBack}
          aria-label="Back"
          className="fixed top-3 z-50 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-text"
          style={{ left: "max(12px, calc(50% - 220px + 12px))" }}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}

      {/* Language toggle — physical top-right within the app frame in both languages */}
      <button
        type="button"
        onClick={() => setLocale(locale === "ar" ? "en" : "ar")}
        aria-label="Change language"
        className="fixed top-3 z-50 flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-sm font-semibold text-text"
        style={{ right: "max(12px, calc(50% - 220px + 12px))" }}
      >
        <Globe className="h-4 w-4" aria-hidden="true" />
        <span>{locale.toUpperCase()}</span>
      </button>

      {/* Tiny logo row */}
      <div className="relative z-10 flex justify-center px-[14px] pt-5">
        <img src="/replay-mark.svg" alt="Replay" className="h-8 w-9 object-contain" />
      </div>
      {/* Independently centered auth content */}
      <div className="relative z-[5] flex min-h-[calc(100vh-46px)] flex-col items-center justify-center p-6">
        <div className="mx-auto w-full max-w-[400px]">
          {children}
        </div>
      </div>
    </div>
  );
}

function SignInPage() {
  const redirectPath = getRedirectPathFromSearch();
  useEffect(() => rememberExplicitAuthRedirect(), []);

  return (
    <AuthHeroLayout>
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={withRedirectPath(`${basePath}/sign-up`, redirectPath)}
        forceRedirectUrl={redirectPath}
      />
    </AuthHeroLayout>
  );
}

function SignUpPage() {
  const { locale } = useTranslation();
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [socialMediaConsent, setSocialMediaConsent] = useState(false);
  const [showConsentError, setShowConsentError] = useState(false);
  const consentRef = useRef<HTMLDivElement>(null);
  const isArabic = locale === "ar";
  const redirectPath = getRedirectPathFromSearch();
  useEffect(() => rememberExplicitAuthRedirect(), []);
  const copy = isArabic
    ? {
        recordingTitle: "أوافق على أن يتم تصويري",
        recordingDescription: "تقوم الكاميرات بتسجيل المباريات حتى يتمكن اللاعبون من المشاهدة وتحديد لحظاتهم.",
        socialTitle: "أوافق على استخدام مقاطعي على وسائل التواصل الاجتماعي",
        socialDescription: "تسمح هذه الموافقة لـ Replay بمشاركة المقاطع التي تظهر فيها على قنواتها الاجتماعية. هذا اختياري.",
        consentHeading: "قبل إنشاء حسابك",
        consentIntro: "موافقة التصوير مطلوبة للمتابعة. مشاركة المقاطع على السوشال ميديا اختيارية.",
        required: "مطلوب",
        optional: "اختياري",
        error: "يرجى تحديد موافقة التصوير المطلوبة أدناه للمتابعة.",
         agreementBeforeTerms: "بإنشاء حساب، أنت توافق على ",
         agreementBetween: " و",
         agreementAfterPrivacy: ".",
         termsLabel: "شروط الاستخدام",
         privacyLabel: "سياسة الخصوصية",
      }
    : {
        recordingTitle: "I agree to be recorded",
        recordingDescription: "Cameras record matches so players can watch and claim their moments.",
        socialTitle: "I agree to let Replay use my videos on social media",
        socialDescription: "This lets Replay share clips featuring you on its social channels. This is optional.",
        consentHeading: "Before you create your account",
        consentIntro: "Recording consent is required to continue. Social media sharing is optional.",
        required: "Required",
        optional: "Optional",
        error: "Please check the required recording consent below to continue.",
         agreementBeforeTerms: "By creating an account you agree to our ",
         agreementBetween: " and ",
         agreementAfterPrivacy: ".",
         termsLabel: "Terms of Use",
         privacyLabel: "Privacy Policy",
      };
  const blockWithoutRecordingConsent = (event: React.SyntheticEvent) => {
    if (event.target instanceof Element && event.target.closest("[data-legal-link]")) return;
    if (recordingConsent) return;
    event.preventDefault();
    event.stopPropagation();
    setShowConsentError(true);
    consentRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    consentRef.current?.focus({ preventScroll: true });
  };

  return (
    <AuthHeroLayout>
      <div
        className="flex w-full max-w-[400px] self-center flex-col items-stretch gap-3"
        onSubmitCapture={blockWithoutRecordingConsent}
        onClickCapture={(event) => {
          if (event.target instanceof Element && event.target.closest("[data-legal-link]")) return;
          const button = (event.target as HTMLElement).closest("button");
          if (!button) return;
          const buttonText = `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`.toLowerCase();
          const isSignupAction = button.type === "submit"
            || /google|apple|github|continue|sign up|create account|register|إنشاء|متابعة/.test(buttonText);
          if (isSignupAction) blockWithoutRecordingConsent(event);
        }}
      >
        <SignUp
          routing="path"
          path={`${basePath}/sign-up`}
          signInUrl={withRedirectPath(`${basePath}/sign-in`, redirectPath)}
          forceRedirectUrl={redirectPath}
          unsafeMetadata={{
            soccerwatchRecordingConsent: recordingConsent,
            soccerwatchSocialMediaConsent: socialMediaConsent,
          }}
        />
        <div
          ref={consentRef}
          dir={isArabic ? "rtl" : "ltr"}
          role="group"
          aria-labelledby="signup-consent-heading"
          aria-describedby={showConsentError ? "signup-recording-consent-error" : undefined}
          tabIndex={-1}
          className={`rounded-2xl border bg-surface p-4 text-text outline-none transition-colors ${isArabic ? "text-right" : "text-left"} ${showConsentError ? "border-destructive ring-2 ring-destructive/20" : "border-line"}`}
        >
          <h2 id="signup-consent-heading" className="text-sm font-bold">{copy.consentHeading}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{copy.consentIntro}</p>
          <SignupConsentOption
            id="signup-recording-consent"
            checked={recordingConsent}
            onCheckedChange={(checked) => {
              setRecordingConsent(checked);
              setShowConsentError(false);
            }}
            title={copy.recordingTitle}
            description={copy.recordingDescription}
            badge={copy.required}
          />
          <SignupConsentOption
            id="signup-social-media-consent"
            checked={socialMediaConsent}
            onCheckedChange={setSocialMediaConsent}
            title={copy.socialTitle}
            description={copy.socialDescription}
            badge={copy.optional}
          />
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {copy.agreementBeforeTerms}
            <a
              href={`${basePath}/terms`}
              target="_blank"
              rel="noopener noreferrer"
              data-legal-link
              className="underline underline-offset-2"
            >
              {copy.termsLabel}
            </a>
            {copy.agreementBetween}
            <a
              href={`${basePath}/privacy`}
              target="_blank"
              rel="noopener noreferrer"
              data-legal-link
              className="underline underline-offset-2"
            >
              {copy.privacyLabel}
            </a>
            {copy.agreementAfterPrivacy}
          </p>
          {showConsentError && (
            <p
              id="signup-recording-consent-error"
              className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-semibold text-destructive"
              role="alert"
            >
              <span aria-hidden="true">!</span><span>{copy.error}</span>
            </p>
          )}
        </div>
      </div>
    </AuthHeroLayout>
  );
}

function SignupConsentOption({
  id,
  checked,
  onCheckedChange,
  title,
  description,
  badge,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  title: string;
  description: string;
  badge: string;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer gap-3 py-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        className="mt-0.5 border-line data-[state=checked]:border-turf"
      />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {title}
          <span className="rounded-full border border-line bg-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {badge}
          </span>
        </span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

/** While a page's code downloads: the app's own background, so nothing flashes. */
function PageLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center" aria-busy="true">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-turf" aria-hidden="true" />
    </div>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function AuthRedirectGuard() {
  const [location, setLocation] = useLocation();
  const pathname = location.split(/[?#]/)[0];
  const isPublicLegalRoute = ["/privacy", "/terms", "/delete-account"].includes(pathname);
  const { user, isLoading, isGuest } = useAuth({ skipSignedOutQuery: isPublicLegalRoute });
  const { isSignedIn } = useUser();

  useEffect(() => {
    if (isLoading) return;
    const isAuthPage = pathname === "/" || pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up");

    // AppRouter renders the identity-confirmation screen before protected
    // routes whenever Clerk is signed in but the local user is unavailable.
    if (isSignedIn && !user && !isGuest) return;

    if (!user || isGuest) return;

    // Public standalone pages must remain available, even before onboarding.
    if (isPublicStandalonePath(pathname)) return;

    if (isAuthPage) {
      if (pathname !== "/" && !user.profileComplete) {
        const returnPath = getRedirectPathFromSearch();
        setLocation(withRedirectPath("/onboarding", returnPath));
        return;
      }
      setLocation(pathname === "/" ? "/home" : getRedirectPathFromSearch());
      return;
    }

    if (pathname === "/home") {
      const explicitHome = consumeExplicitAuthRedirect("/home");
      if (user.isGuardianOnly && !explicitHome) { setLocation(getPostAuthLanding(null, true)); return; }
      // Only if they're still on the home page when the answer comes back.
      if (!explicitHome) void consoleHomeTarget().then((target) => { if (target && /\/home\/?$/.test(window.location.pathname)) setLocation(target); });
      return;
    }

    if (!user.profileComplete && pathname !== "/onboarding") {
      setLocation(getIncompleteProfileOnboardingRedirect(location, window.location.search, window.location.hash));
    }
  }, [isLoading, user, isGuest, isSignedIn, location, setLocation]);

  return null;
}

function FindQuickRedirect() {
  const { id } = useParams<{ id?: string }>();
  const [, setLocation] = useLocation();

  useEffect(() => {
    // Keep ?match=... so the match is still known on /find.
    if (id) setLocation(`/find/${encodeURIComponent(id)}${window.location.search}`, { replace: true });
  }, [id, setLocation]);

  return null;
}

function AppRouter() {
  const [location] = useLocation();
  const routePath = location.split(/[?#]/)[0];
  const isPublicLegalRoute = ["/privacy", "/terms", "/delete-account"].includes(routePath);
  const { user, isLoading, isGuest, isSignedIn, refetchLocalUser } = useAuth({ skipSignedOutQuery: isPublicLegalRoute });
  const { signOut } = useClerk();
  const { locale } = useLocale();
  const isPublicJoinRoute = location.split("?")[0].startsWith("/join/") || location.split("?")[0].startsWith("/v/");
  const isPublicFamilyRoute = location.split(/[?#]/)[0].startsWith("/p/") || location.split(/[?#]/)[0].startsWith("/academy/invite/");
  const isPublicStandaloneRoute = isPublicJoinRoute || isPublicFamilyRoute;
  const isFamilyMeRoute = location.split(/[?#]/)[0] === "/academy/me" || location.split(/[?#]/)[0].startsWith("/academy/me/match/");
  // "Is this you?" is a full-screen swipe deck: no app bars around it
  const isDeckRoute = /^\/find\/\d+\/check\/?$/.test(location.split(/[?#]/)[0]);
  const isReportPreviewRoute = import.meta.env.DEV && location.split(/[?#]/)[0] === "/__dev/match-report";
  const isStandaloneRoute = isPublicStandaloneRoute || isFamilyMeRoute || isDeckRoute || isReportPreviewRoute;
  const [retryingIdentity, setRetryingIdentity] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  if (isSignedIn && !user && !isGuest && !isPublicStandaloneRoute && !isPublicLegalRoute) {
    const retryIdentity = async () => {
      setRetryingIdentity(true);
      try {
        await refetchLocalUser();
      } finally {
        setRetryingIdentity(false);
      }
    };

    const signInAgain = async () => {
      setSignOutPending(true);
      setSignOutFailed(false);
      try {
        await signOut({ redirectUrl: `${basePath}/sign-in` });
      } catch {
        setSignOutPending(false);
        setSignOutFailed(true);
      }
    };

    return (
      <AuthHeroLayout showBackButton={false}>
        <AuthIdentityPanel
          locale={locale}
          isLoading={isLoading}
          retrying={retryingIdentity}
          signOutPending={signOutPending}
          signOutFailed={signOutFailed}
          onRetry={() => void retryIdentity()}
          onSignInAgain={() => void signInAgain()}
        />
      </AuthHeroLayout>
    );
  }

  const routes = (
    <>
      <AuthRedirectGuard />
      <Suspense fallback={<PageLoading />}>
      <Switch>
        <Route path="/connect/instagram/callback" component={InstagramCallbackPage} />
        <Route path="/join/:code" component={AcademyJoinPage} />
        <Route path="/p/:token"><AcademyFamilyPage source="token" /></Route>
        <Route path="/academy/invite/:token" component={AcademyInvitePage} />
        <Route path="/" component={Landing} />
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/onboarding">
          <AuthHeroLayout showBackButton={false}>
            <Onboarding />
          </AuthHeroLayout>
        </Route>
        <Route path="/home" component={Home} />
        <Route path="/week/:id" component={WeeklyHighlightPage} />
        {/* <Route path="/watch" component={Watch} /> */}
        <Route path="/view" component={View} />
        <Route path="/fields"><Fields /></Route>
        <Route path="/fields/:id" component={FieldDetail} />
        <Route path="/academies"><Academies /></Route>
        <Route path="/player/:id" component={Player} />
        <Route path="/players/:id" component={Profile} />
        <Route path="/portfolio/:id" component={Profile} />
        <Route path="/my-clips" component={MyClips} />
        <Route path="/live" component={Live} />
        <Route path="/claim/demo" component={ClaimDemo} />
        <Route path="/find/:id/check" component={CheckDeckPage} />
        <Route path="/find/:id" component={ClaimGame} />
        <Route path="/find-quick/:id" component={FindQuickRedirect} />
        <Route path="/claim/:id" component={ClaimChain} />
        <Route path="/account" component={Account} />
        <Route path="/academy/me/match/:sessionId" component={AcademyMatchPage} />
        <Route path="/academy/me"><AcademyFamilyPage source="me" /></Route>
        <Route path="/academy/*?" component={AcademyConsole} />
        <Route path="/field/*?" component={FieldConsole} />
        <Route path="/v/:slug" component={VenueSitePage} />
        <Route path="/awards/:slug" component={VenueAwardsPage} />
        <Route path="/account/blocked" component={BlockedPlayers} />
        <Route path="/owner"><Owner /></Route>
        <Route path="/owner/var/:requestId"><OwnerVar /></Route>
        <Route path="/w/:token" component={OwnerShare} />
        <Route path="/kc/:token" component={KidClipPage} />
        <Route path="/vr/:token" component={ValueReportPage} />
        {MatchReportDevPreview && (
          <Route path="/__dev/match-report">
            <Suspense fallback={null}><MatchReportDevPreview /></Suspense>
          </Route>
        )}
        {InstagramDevPreview && (
          <Route path="/__dev/instagram">
            <Suspense fallback={null}><InstagramDevPreview /></Suspense>
          </Route>
        )}
        {EarlyPlayDevPreview && (
          <Route path="/__dev/early-play">
            <Suspense fallback={null}><EarlyPlayDevPreview /></Suspense>
          </Route>
        )}
        <Route path="/m/:code" component={MatchPage} />
        <Route path="/friends" component={FriendsPage} />
        <Route path="/f/:code" component={FriendLinkPage} />
        <Route path="/matches" component={Matches} />
        <Route path="/book" component={BookPage} />
        <Route path="/demo" component={SimpleDemo} />
        <Route path="/demo/full" component={DemoPage} />
        <Route path="/demo/old" component={LegacyDemoPage} />
        <Route path="/privacy"><LegalPage doc="privacy" /></Route>
        <Route path="/terms"><LegalPage doc="terms" /></Route>
        <Route path="/delete-account" component={DeleteAccountPage} />
        <Route path="/admin" component={Admin} />
        <Route path="/admin/debug" component={AdminDebug} />
        <Route path="/admin/setup" component={AdminSetup} />
        <Route path="/admin/recordings/:id/identities" component={IdentityBoard} />
        <Route component={NotFound} />
      </Switch>
      </Suspense>
    </>
  );

  return isStandaloneRoute ? routes : <Layout>{routes}</Layout>;
}

function ClerkProviderWithRoutes() {
  const [location, setLocation] = useLocation();
  const { locale } = useLocale();

  const localization = locale === "ar"
    ? arSA
    : {
        signIn: {
          start: { title: "Welcome back", subtitle: "Sign in to your Replay account" },
        },
        signUp: {
          start: { title: "Join Replay", subtitle: "Create your account to save and like clips" },
        },
      };

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={localization}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <ClerkQueryClientCacheInvalidator />
      <TooltipProvider>
        <AppRouter />
        <Toaster />
      </TooltipProvider>
    </ClerkProvider>
  );
}

function AppContent() {
  const [location] = useLocation();
  // /demo is the short page; /demo/full the long one. Both are public, with
  // no sign-in and no app chrome.
  const publicDemo = location === "/demo" || location === "/demo/full";
  const publicLegalPage = ["/privacy", "/terms", "/delete-account"].includes(location.split(/[?#]/)[0]);
  return (
    <LocaleProvider publicPage={publicDemo || publicLegalPage} defaultLocale={publicLegalPage ? "en" : undefined}>
      <FullscreenVideoProvider>
        {publicDemo
          ? <Suspense fallback={<PageLoading />}>{location === "/demo" ? <SimpleDemo /> : <DemoPage />}</Suspense>
          : <ClerkProviderWithRoutes />}
      </FullscreenVideoProvider>
    </LocaleProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <QueryClientProvider client={queryClient}>
        <AppContent />
      </QueryClientProvider>
    </WouterRouter>
  );
}

export default App;
