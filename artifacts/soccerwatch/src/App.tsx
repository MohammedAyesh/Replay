import { useEffect, useRef } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, useClerk, useUser } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { arSA } from "@clerk/localizations";
import { ChevronLeft, ChevronRight, Globe } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout, LogoMark } from "@/components/layout";
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

const AUTH_PAGE_COPY = {
  signIn: {
    en: { title: "Sign In", subtitlePrefix: "Continue to" },
    ar: { title: "تسجيل الدخول", subtitlePrefix: "للمتابعة إلى" },
  },
  signUp: {
    en: { title: "Create Account", subtitlePrefix: "Continue to" },
    ar: { title: "إنشاء حساب جديد", subtitlePrefix: "للمتابعة إلى" },
  },
  verify: {
    en: { title: "Verify your email", subtitlePrefix: "Continue to" },
    ar: { title: "تحقق من بريدك الإلكتروني", subtitlePrefix: "للمتابعة إلى" },
  },
} as const;

function AuthHeroLayout({
  children,
  screen,
}: {
  children: React.ReactNode;
  screen: keyof typeof AUTH_PAGE_COPY;
}) {
  const [, setLocation] = useLocation();
  const { locale, setLocale } = useTranslation();
  const copy = AUTH_PAGE_COPY[screen][locale];
  const isArabic = locale === "ar";

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      setLocation("/");
    }
  };

  return (
    <div
      dir={isArabic ? "rtl" : "ltr"}
      aria-label={`${copy.title}. ${copy.subtitlePrefix} Replay`}
      className="relative flex min-h-[100dvh] w-full justify-center overflow-visible bg-[#0B0F1A] text-[#F3F6FA]"
      style={{
        background:
          "radial-gradient(90% 55% at 0% 0%, rgba(47,216,196,.18), transparent 62%), radial-gradient(85% 60% at 100% 0%, rgba(123,92,255,.18), transparent 64%), radial-gradient(70% 45% at 50% 100%, rgba(212,255,79,.07), transparent 70%), #0B0F1A",
        fontFamily: isArabic ? "'Tajawal','Inter',sans-serif" : "'Inter','Tajawal',sans-serif",
      }}
    >
      <button
        type="button"
        aria-label={isArabic ? "رجوع" : "Back"}
        onClick={handleBack}
        className="fixed left-4 top-4 z-50 flex h-[34px] w-[34px] items-center justify-center rounded-[11px] border border-white/[0.1] bg-white/[0.04] text-[#F3F6FA] transition-colors hover:bg-white/[0.08]"
      >
        {isArabic ? <ChevronRight className="h-4 w-4" aria-hidden="true" /> : <ChevronLeft className="h-4 w-4" aria-hidden="true" />}
      </button>
      <button
        type="button"
        aria-label={isArabic ? "تغيير اللغة" : "Change language"}
        onClick={() => setLocale(isArabic ? "en" : "ar")}
        className="fixed right-4 top-4 z-50 flex items-center gap-1.5 rounded-full border-0 bg-white/[0.07] px-3.5 py-2 text-xs font-semibold tracking-[0.03em] text-[#F3F6FA] transition-colors hover:bg-white/[0.11]"
      >
        <Globe className="h-3.5 w-3.5" aria-hidden="true" />
        {locale.toUpperCase()}
      </button>
      <div className="relative z-10 flex w-full max-w-[440px] flex-col items-center px-4 pb-12 pt-20">
        <LogoMark size={52} />
        <div className="mt-4 w-full">{children}</div>
      </div>
    </div>
  );
}

function SignInPage() {
  return (
    <AuthHeroLayout screen="signIn">
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
    <AuthHeroLayout screen="signUp">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        forceRedirectUrl={`${basePath}/home`}
      />
    </AuthHeroLayout>
  );
}

function FieldsRoute() {
  return <Fields />;
}

function AcademiesRoute() {
  return <Academies />;
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
        <Route path="/onboarding" component={Onboarding} />
        <Route path="/home" component={Home} />
        {/* <Route path="/watch" component={Watch} /> */}
        <Route path="/view" component={View} />
        <Route path="/fields" component={FieldsRoute} />
        <Route path="/fields/:id" component={FieldDetail} />
        <Route path="/academies" component={AcademiesRoute} />
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
