import { useEffect, useRef } from "react";
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
import { useAuth } from "@/lib/auth";
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
    <div className="relative h-[100dvh] min-h-[100dvh] overflow-x-hidden overflow-y-auto no-scrollbar bg-[#0B0F1A]">
      <style>{`
        @keyframes rpDrift {
          0%, 100% { transform: translate(0, 0); }
          50% { transform: translate(-3%, 3%); }
        }
        .cl-cardBox,
        .cl-cardBox .cl-footer,
        .cl-cardBox .cl-footerAction {
          background: #141B2C !important;
          background-color: #141B2C !important;
          border-color: transparent !important;
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
        className="absolute -inset-[10%] z-0"
        style={{
          background: `
            radial-gradient(60% 45% at 15% 10%, rgba(47,216,196,.22), transparent 60%),
            radial-gradient(55% 50% at 90% 20%, rgba(123,92,255,.2), transparent 60%),
            radial-gradient(65% 55% at 25% 95%, rgba(212,255,79,.09), transparent 60%),
            radial-gradient(70% 60% at 100% 100%, rgba(47,216,196,.12), transparent 60%),
            linear-gradient(160deg, #0B0F1A, #0D1220 45%, #0B0F1A)
          `,
          animation: "rpDrift 18s ease-in-out infinite",
        }}
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 z-0 opacity-50"
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,.05) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
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
          className="fixed top-3 z-50 flex h-[34px] w-[34px] items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white"
          style={{ left: "max(12px, calc(50% - 220px + 12px))" }}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}

      {/* Language toggle — physical top-right within the app frame in both languages */}
      <button
        type="button"
        onClick={() => setLocale(locale === "ar" ? "en" : "ar")}
        aria-label={t.language}
        className="fixed top-3 z-50 flex items-center gap-1.5 rounded-[99px] border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-semibold text-white"
        style={{ right: "max(12px, calc(50% - 220px + 12px))" }}
      >
        <Globe className="h-4 w-4" aria-hidden="true" />
        <span>{locale.toUpperCase()}</span>
      </button>

      {/* Tiny logo row */}
      <div className="relative z-10 flex justify-center px-[14px] pt-5">
        <svg viewBox="-5 0 225 200" width="26" height="24" aria-hidden="true">
          <defs>
            <clipPath id="authMarkClip">
              <circle cx="95" cy="96" r="88" />
            </clipPath>
          </defs>
          <g clipPath="url(#authMarkClip)">
            <polygon points="95,60 126.2,78 126.2,114 95,132 63.8,114 63.8,78" fill="#22C7B5" />
            <polygon points="126.2,6 157.4,24 157.4,60 126.2,78 95,60 95,24" fill="#BFFF5C" />
            <polygon points="63.8,6 95,24 95,60 63.8,78 32.6,60 32.6,24" fill="#3FE0C9" />
            <polygon points="157.4,60 188.6,78 188.6,114 157.4,132 126.2,114 126.2,78" fill="#1FA79B" />
            <polygon points="32.6,60 63.8,78 63.8,114 32.6,132 1.4,114 1.4,78" fill="#186E7E" />
            <polygon points="126.2,114 157.4,132 157.4,168 126.2,186 95,168 95,132" fill="#1C8AA0" />
            <polygon points="63.8,114 95,132 95,168 63.8,186 32.6,168 32.6,132" fill="#6C4FE0" />
          </g>
          <polygon points="170,62 170,134 210,98" fill="#0B0F1A" />
          <polygon points="172,68 172,128 206,98" fill="#D4FF4F" />
          <circle cx="178" cy="46" r="7.5" fill="#0B0F1A" />
          <circle cx="178" cy="46" r="5.5" fill="#FF5A3C" />
        </svg>
      </div>
      {/* Independently centered auth content */}
      <div className="relative z-[5] flex min-h-[calc(100vh-46px)] flex-col justify-center p-6">
        {children}
      </div>
    </div>
  );
}

function SignInPage() {
  return (
    <AuthHeroLayout>
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        forceRedirectUrl={`${basePath}/home`}
      />
    </AuthHeroLayout>
  );
}

function SignUpPage() {
  return (
    <AuthHeroLayout>
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        forceRedirectUrl={`${basePath}/home`}
      />
    </AuthHeroLayout>
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

    // If Clerk says the user IS signed in but our local user record isn't
    // ready yet (common right after sign-in), don't do anything — let the
    // page stay so we don't bounce back to login while the server catches up.
    if (isSignedIn && !user && !isGuest) return;

    if (!user || isGuest) return;

    const isPublicPage = location === "/" || location.startsWith("/sign-in") || location.startsWith("/sign-up");
    if (isPublicPage) {
      setLocation("/home");
      return;
    }
    if (!user.profileComplete && location !== "/onboarding") {
      setLocation("/onboarding");
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
        <Route path="/fields" component={Fields} />
        <Route path="/fields/:id" component={FieldDetail} />
        <Route path="/academies" component={Academies} />
        <Route path="/player/:id" component={Player} />
        <Route path="/players/:id" component={Profile} />
        <Route path="/my-clips" component={MyClips} />
        <Route path="/live" component={Live} />
        <Route path="/account" component={Account} />
        <Route path="/admin" component={Admin} />
        <Route path="/admin/setup" component={AdminSetup} />
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
