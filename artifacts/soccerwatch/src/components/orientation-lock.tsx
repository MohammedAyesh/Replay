import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import { useTranslation } from "@/i18n";

function isLandscape() {
  return window.innerWidth > window.innerHeight;
}

export function OrientationLock() {
  const { isFullscreenVideo } = useFullscreenVideo();
  const { t } = useTranslation();
  const [landscape, setLandscape] = useState(() => isLandscape());

  useEffect(() => {
    const update = () => setLandscape(isLandscape());
    window.addEventListener("resize", update, { passive: true });
    window.addEventListener("orientationchange", update, { passive: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  useEffect(() => {
    if (typeof screen.orientation?.lock !== "function") return;
    screen.orientation.lock("portrait-primary").catch(() => {});
    return () => {
      if (typeof screen.orientation?.unlock === "function") {
        screen.orientation.unlock();
      }
    };
  }, []);

  const show = landscape && !isFullscreenVideo;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="orientation-lock"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="absolute inset-0 z-[500] bg-[#0D1B3E] flex flex-col items-center justify-center gap-6 select-none"
        >
          <motion.div
            animate={{ rotate: [0, 90, 90, 0] }}
            transition={{ repeat: Infinity, duration: 2.6, ease: "easeInOut", times: [0, 0.35, 0.65, 1] }}
          >
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="2" width="14" height="20" rx="2" />
              <circle cx="12" cy="18" r="1" fill="white" stroke="none" />
            </svg>
          </motion.div>
          <div className="flex flex-col items-center gap-2 text-center px-8">
            <p className="text-white text-lg font-bold">{t.orientationLock.title}</p>
            <p className="text-white/60 text-sm leading-relaxed">{t.orientationLock.subtitle}</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
