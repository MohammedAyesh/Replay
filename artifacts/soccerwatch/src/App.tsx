import { useEffect, useRef } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { arSA } from "@clerk/localizations";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { clerkAppearance } from "@/lib/clerkAppearance";
import { LocaleProvider, useLocale } from "@/i18n";
import { FullscreenVideoProvider } from "@/lib/fullscreen-video";

import Landing from "@/pages/login";
import Watch from "@/pages/watch";
import Fields from "@/pages/fields";
import FieldDetail from "@/pages/field-detail";
import Player from "@/pages/player";
import MyClips from "@/pages/my-clips";
import Account from "@/pages/account";
import Onboarding from "@/pages/onboarding";
import NotFound from "@/pages/not-found";
import { useAuth } from "@/lib/auth";

const queryClient = new QueryClient();

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

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center field-pattern relative">
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative z-10 w-full flex justify-center px-4 py-12">
        <SignIn
          routing="path"
          path={`${basePath}/sign-in`}
          signUpUrl={`${basePath}/sign-up`}
          forceRedirectUrl={`${basePath}/watch`}
        />
      </div>
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center field-pattern relative">
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative z-10 w-full flex justify-center px-4 py-12">
        <SignUp
          routing="path"
          path={`${basePath}/sign-up`}
          signInUrl={`${basePath}/sign-in`}
          forceRedirectUrl={`${basePath}/watch`}
        />
      </div>
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
  const { user, isLoading, isGuest } = useAuth();
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (isLoading) return;
    if (!user || isGuest) return;

    const isPublicPage = location === "/" || location.startsWith("/sign-in") || location.startsWith("/sign-up");
    if (!user.profileComplete && !isPublicPage && location !== "/onboarding") {
      setLocation("/onboarding");
    }
  }, [isLoading, user, isGuest, location, setLocation]);

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
        <Route path="/watch" component={Watch} />
        <Route path="/fields" component={Fields} />
        <Route path="/fields/:id" component={FieldDetail} />
        <Route path="/player/:id" component={Player} />
        <Route path="/my-clips" component={MyClips} />
        <Route path="/account" component={Account} />
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
          start: { title: "Welcome back", subtitle: "Sign in to your SoccerWatch account" },
        },
        signUp: {
          start: { title: "Join SoccerWatch", subtitle: "Create your account to save and like clips" },
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
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <AppRouter />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <LocaleProvider>
        <FullscreenVideoProvider>
          <ClerkProviderWithRoutes />
        </FullscreenVideoProvider>
      </LocaleProvider>
    </WouterRouter>
  );
}

export default App;
