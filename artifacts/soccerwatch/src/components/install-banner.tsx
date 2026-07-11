import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useLocation } from "wouter";
import { useInstallPrompt } from "@/hooks/use-install-prompt";
import { useTranslation } from "@/i18n";
import replayLogo from "@/assets/replay-logo.png";

const DELAY_MS = 3500;

function IOSSafariSteps({ t }: { t: { step1: string; step2: string } }) {
  return (
    <div className="flex flex-col gap-2 text-sm text-foreground/80">
      <div className="flex items-center gap-3">
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center">1</span>
        <span className="flex items-center gap-1.5">
          {t.step1}
          <svg className="inline w-4 h-4 text-blue-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
          </svg>
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center">2</span>
        <span>{t.step2}</span>
      </div>
    </div>
  );
}

export function InstallBanner() {
  const { platform, canShow, install, dismiss } = useInstallPrompt();
  const { t, locale } = useTranslation();
  const [location] = useLocation();
  const [visible, setVisible] = useState(false);

  const isAuthPage =
    location === "/" ||
    location.startsWith("/sign-in") ||
    location.startsWith("/sign-up") ||
    location === "/onboarding";

  useEffect(() => {
    if (!canShow || isAuthPage) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), DELAY_MS);
    return () => clearTimeout(timer);
  }, [canShow, isAuthPage]);

  const handleDismiss = () => {
    setVisible(false);
    dismiss();
  };

  const handleInstall = async () => {
    await install();
    setVisible(false);
  };

  const s = t.install;
  const isRTL = locale === "ar";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="install-banner"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: "spring", stiffness: 340, damping: 30 }}
          className="absolute bottom-16 start-3 end-3 z-40 rounded-2xl bg-card border border-border shadow-2xl overflow-hidden"
          dir={isRTL ? "rtl" : "ltr"}
        >
          {/* Dismiss button */}
          <button
            onClick={handleDismiss}
            className="absolute top-3 end-3 w-7 h-7 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="p-4 pe-10">
            {platform === "android-chrome" && (
              <div className="flex items-center gap-3">
                <img src={replayLogo} alt="Replay" className="w-12 h-12 rounded-xl flex-shrink-0 object-contain" />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-foreground text-sm leading-tight">{s.androidTitle}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{s.androidDesc}</p>
                </div>
                <button
                  onClick={handleInstall}
                  className="flex-shrink-0 bg-primary text-white text-xs font-bold px-4 py-2 rounded-full hover:bg-primary/90 active:scale-95 transition-all"
                >
                  {s.installBtn}
                </button>
              </div>
            )}

            {platform === "ios-safari" && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <img src={replayLogo} alt="Replay" className="w-10 h-10 rounded-xl flex-shrink-0 object-contain" />
                  <div>
                    <p className="font-semibold text-foreground text-sm leading-tight">{s.iosTitle}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{s.iosDesc}</p>
                  </div>
                </div>
                <IOSSafariSteps t={{ step1: s.iosStep1, step2: s.iosStep2 }} />
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
