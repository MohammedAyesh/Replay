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

function AuthHeroLayout({ children }: { children: React.ReactNode }) {
  const { t, locale, setLocale } = useTranslation();
  const [, setLocation] = useLocation();

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      setLocation("/");
    }
  };

  return (
    <div className="relative min-h-[100dvh] bg-[#0B0F1A] overflow-x-hidden">
      <img
        src={`${basePath}/auth-hero.png`}
        alt=""
        className="absolute inset-0 w-full h-full object-cover object-center"
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/40 to-black/80" />
      {/* Ambient glow */}
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        <div className="absolute -top-20 left-1/2 -translate-x-1/2 w-[420px] h-[420px] rounded-full bg-[#2FD8C4]/20 blur-[90px]" />
        <div className="absolute bottom-0 left-1/4 w-[320px] h-[320px] rounded-full bg-[#7B5CFF]/15 blur-[100px]" />
        <div className="absolute top-1/3 right-0 w-[220px] h-[220px] rounded-full bg-[#D4FF4F]/10 blur-[80px]" />
      </div>

      {/* Back button — fixed, physical top-left in both languages */}
      <button
        type="button"
        onClick={handleBack}
        aria-label="Back"
        className="fixed left-3 top-3 z-50 flex h-[34px] w-[34px] items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>

      {/* Language toggle — fixed, physical top-right in both languages */}
      <button
        type="button"
        onClick={() => setLocale(locale === "ar" ? "en" : "ar")}
        aria-label={t.language}
        className="fixed right-3 top-3 z-50 flex items-center gap-1.5 rounded-[99px] border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-semibold text-white"
      >
        <Globe className="h-4 w-4" aria-hidden="true" />
        <span>{locale.toUpperCase()}</span>
      </button>

      {/* Content — tiny logo mark above, children below */}
      <div className="relative z-10 flex flex-col items-center w-full pt-16 pb-12 px-4 gap-5">
        {/* Tiny logo mark — 26 px, ball geometry */}
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
          <AuthHeroLayout>
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
