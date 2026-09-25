import { useEffect, useRef, useState } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, useClerk, useUser } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { arSA } from "@clerk/localizations";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { clerkAppearance } from "@/lib/clerkAppearance";
import { LocaleProvider, useLocale, useTranslation } from "@/i18n";
import { FullscreenVideoProvider } from "@/lib/fullscreen-video";

import Landing from "@/pages/login";
import Home from "@/pages/home";
// import Watch from "@/pages/watch";
import Fields from "@/pages/fields";
import FieldDetail from "@/pages/field-detail";
import Player from "@/pages/player";
import Profile from "@/pages/profile";
import MyClips from "@/pages/my-clips";
import Account from "@/pages/account";
import Admin from "@/pages/admin";
import AdminSetup from "@/pages/admin-setup";
import Onboarding from "@/pages/onboarding";
import NotFound from "@/pages/not-found";
import Academies from "@/pages/academies";
import View from "@/pages/view";
import Live from "@/pages/live";
import ClaimDemo from "@/pages/claim-demo";
import ClaimChain from "@/pages/claim-chain";
import ClaimFind from "@/pages/claim-find";
import ClaimGame from "@/pages/claim-game";
import IdentityBoard from "@/pages/identity-board";
import Owner from "@/pages/owner";
import OwnerVar from "@/pages/owner-var";
import OwnerShare from "@/pages/owner-share";
import MatchPage from "@/pages/match";
import Matches from "@/pages/matches";
import BookPage from "@/pages/book";
import { useAuth } from "@/lib/auth";
import { getRedirectPathFromSearch, getSafeRedirectPath, withRedirectPath } from "@/lib/auth-redirect";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft, Globe } from "lucide-react";

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
      <div className="relative z-[5] flex min-h-[calc(100vh-46px)] flex-col justify-center p-6">
        {children}
      </div>
    </div>
  );
}

function SignInPage() {
  const redirectPath = getRedirectPathFromSearch();

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
  const isArabic = locale === "ar";
  const redirectPath = getRedirectPathFromSearch();
  const copy = isArabic
    ? {
        recordingTitle: "أوافق على أن يتم تصويري",
        recordingDescription: "تقوم الكاميرات بتسجيل المباريات حتى يتمكن اللاعبون من المشاهدة وتحديد لحظاتهم.",
        socialTitle: "أوافق على استخدام مقاطعي على وسائل التواصل الاجتماعي",
        socialDescription: "تسمح هذه الموافقة لـ Replay بمشاركة المقاطع التي تظهر فيها على قنواتها الاجتماعية. هذا اختياري.",
        required: "مطلوب",
        optional: "اختياري",
        error: "يرجى الموافقة على التصوير للمتابعة.",
      }
    : {
        recordingTitle: "I agree to be recorded",
        recordingDescription: "Cameras record matches so players can watch and claim their moments.",
        socialTitle: "I agree to let Replay use my videos on social media",
        socialDescription: "This lets Replay share clips featuring you on its social channels. This is optional.",
        required: "Required",
        optional: "Optional",
        error: "Please agree to being recorded to continue.",
      };
  const blockWithoutRecordingConsent = (event: React.SyntheticEvent) => {
    if (recordingConsent) return;
    event.preventDefault();
    event.stopPropagation();
    setShowConsentError(true);
  };

  return (
    <AuthHeroLayout>
      <div
        className="flex w-[440px] max-w-full flex-col items-stretch gap-3"
        onSubmitCapture={blockWithoutRecordingConsent}
        onClickCapture={(event) => {
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
          dir={isArabic ? "rtl" : "ltr"}
          className={`rounded-2xl border border-line bg-surface p-4 text-text ${isArabic ? "text-right" : "text-left"}`}
        >
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
          {showConsentError && (
            <p className="mt-3 flex items-center gap-2 text-xs font-medium text-muted-foreground" role="alert">
              <span aria-hidden="true">!</span>{copy.error}
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
  const { user, isLoading, isGuest } = useAuth();
  const { isSignedIn } = useUser();
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (isLoading) return;
    const pathname = location.split("?")[0];
    const isOwnerShare = pathname.startsWith("/w/") || pathname.startsWith("/m/");
    const isAuthPage = pathname === "/" || pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up");

    // If Clerk says the user IS signed in but our local user record isn't
    // ready yet (common right after sign-in), don't do anything — let the
    // page stay so we don't bounce back to login while the server catches up.
    if (isSignedIn && !user && !isGuest) return;

    if (!user || isGuest) return;

    // Public owner links must remain usable for signed-in users, including
    // users whose profile still needs onboarding.
    if (isOwnerShare) return;

    if (isAuthPage) {
      if (pathname !== "/" && !user.profileComplete) {
        const returnPath = getRedirectPathFromSearch();
        setLocation(withRedirectPath("/onboarding", returnPath));
        return;
      }
      setLocation(pathname === "/" ? "/home" : getRedirectPathFromSearch());
      return;
    }

    if (!user.profileComplete && pathname !== "/onboarding") {
      setLocation(withRedirectPath("/onboarding", getSafeRedirectPath(pathname)));
    }
  }, [isLoading, user, isGuest, isSignedIn, location, setLocation]);

  return null;
}

function AppRouter() {
  return (
    <Layout>
      <AuthRedirectGuard />
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/onboarding">
          <AuthHeroLayout showBackButton={false}>
            <Onboarding />
          </AuthHeroLayout>
        </Route>
        <Route path="/home" component={Home} />
        {/* <Route path="/watch" component={Watch} /> */}
        <Route path="/view" component={View} />
        <Route path="/fields"><Fields /></Route>
        <Route path="/fields/:id" component={FieldDetail} />
        <Route path="/academies"><Academies /></Route>
        <Route path="/player/:id" component={Player} />
        <Route path="/players/:id" component={Profile} />
        <Route path="/my-clips" component={MyClips} />
        <Route path="/live" component={Live} />
        <Route path="/claim/demo" component={ClaimDemo} />
        <Route path="/find/:id" component={ClaimGame} />
        <Route path="/find-quick/:id" component={ClaimFind} />
        <Route path="/claim/:id" component={ClaimChain} />
        <Route path="/account" component={Account} />
        <Route path="/owner" component={Owner} />
        <Route path="/owner/var/:requestId" component={OwnerVar} />
        <Route path="/w/:token" component={OwnerShare} />
        <Route path="/m/:code" component={MatchPage} />
        <Route path="/matches" component={Matches} />
        <Route path="/book" component={BookPage} />
        <Route path="/admin" component={Admin} />
        <Route path="/admin/setup" component={AdminSetup} />
        <Route path="/admin/recordings/:id/identities" component={IdentityBoard} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
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

function App() {
  return (
    <WouterRouter base={basePath}>
      <QueryClientProvider client={queryClient}>
        <LocaleProvider>
          <FullscreenVideoProvider>
            <ClerkProviderWithRoutes />
          </FullscreenVideoProvider>
        </LocaleProvider>
      </QueryClientProvider>
    </WouterRouter>
  );
}

export default App;
