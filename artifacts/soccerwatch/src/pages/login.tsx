import { useLocation } from "wouter";
import { useLoginAsGuest, listBanners, getBunnyCollections, getListBannersQueryKey, getGetBunnyCollectionsQueryKey, getGetMeQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Globe } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/react";
import { useEffect } from "react";

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 28 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay, ease: "easeOut" as const },
});

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { t, locale, setLocale } = useTranslation();
  const guestMutation = useLoginAsGuest();
  const queryClient = useQueryClient();
  const { signOut } = useClerk();
  const { isSignedIn, isLoaded } = useUser();

  // If already signed in, redirect straight to home — avoids the
  // "press login again" symptom after Clerk's own redirect stalls.
  useEffect(() => {
    if (isLoaded && isSignedIn) {
      setLocation("/home");
    }
  }, [isLoaded, isSignedIn, setLocation]);

  const preloadHomeData = () => {
    queryClient.prefetchQuery({
      queryKey: getListBannersQueryKey(),
      queryFn: () => listBanners(),
      staleTime: 0,
    });
    queryClient.prefetchQuery({
      queryKey: getGetBunnyCollectionsQueryKey(),
      queryFn: () => getBunnyCollections(),
      staleTime: 5 * 60 * 1000,
    });
  };

  const handleGuest = async () => {
    await signOut().catch(() => {});
    queryClient.clear();
    preloadHomeData();
    guestMutation.mutate(undefined, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetMeQueryKey(), data.user);
        setLocation("/home");
      },
      onError: () => {
        toast({ variant: "destructive", title: t.login.guestLoginFailed, description: t.login.guestLoginError });
      },
    });
  };

  const [tagline1, tagline2] = t.login.tagline.split("\n");

  return (
    <div className="flex-1 flex flex-col relative text-white overflow-hidden bg-black">
      {/* Full-bleed hero image */}
      <img
        src={`${basePath}/auth-hero.png`}
        alt=""
        className="absolute inset-0 w-full h-full object-cover object-center"
        aria-hidden="true"
      />
      {/* Dark gradient overlay — heavier at bottom for button legibility */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/50 to-black/85" />

      {/* Language selector — top right */}
      <div className="absolute top-safe right-4 z-20">
        <button
          onClick={() => setLocale(locale === "en" ? "ar" : "en")}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-white/10 backdrop-blur-md text-white/80 hover:text-white hover:bg-white/20 transition-colors text-xs font-semibold"
        >
          <Globe className="w-3.5 h-3.5" />
          {locale === "en" ? "EN" : "عربي"}
        </button>
      </div>

      <div className="relative z-10 flex-1 flex flex-col justify-between p-6">
        <div className="pt-12">
          <motion.div {...fadeUp(0)} className="flex items-center gap-2 mb-8">
            <span className="font-display font-black text-2xl tracking-tight text-white uppercase">REPLAY</span>
          </motion.div>

          <motion.h1
            {...fadeUp(0.12)}
            className="font-display font-black text-6xl leading-[0.95] mb-4 uppercase tracking-tight"
          >
            {tagline1}<br />
            <span className="text-primary">{tagline2}</span>
          </motion.h1>
          <motion.p {...fadeUp(0.2)} className="text-base text-white/75 leading-snug">
            {t.login.description}
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 60 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.28, ease: "easeOut" as const }}
          className="space-y-3 mb-4"
        >
          <Button
            asChild
            className="w-full bg-primary hover:bg-primary/90 text-black font-bold py-6 rounded-xl text-base uppercase tracking-wide"
          >
            <a href={`${basePath}/sign-in`}>{t.login.signIn}</a>
          </Button>

          <Button
            asChild
            variant="outline"
            className="w-full font-semibold py-6 rounded-xl text-base bg-white/10 border-white/20 text-white hover:bg-white/20 hover:text-white"
          >
            <a href={`${basePath}/sign-up`}>{t.login.createAccount}</a>
          </Button>

          <div className="relative my-2 flex justify-center">
            <span className="px-2 text-white/40 text-xs uppercase">{t.login.or}</span>
          </div>

          <Button
            type="button"
            variant="ghost"
            className="w-full text-white/60 hover:text-white hover:bg-white/10 font-medium py-4 rounded-xl"
            onClick={handleGuest}
            disabled={guestMutation.isPending}
          >
            {guestMutation.isPending ? t.login.startingGuest : t.login.browseAsGuest}
          </Button>
        </motion.div>
      </div>
    </div>
  );
}
