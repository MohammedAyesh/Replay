import { useEffect, useRef, useState } from "react";

export type InstallPlatform = "ios-safari" | "android-chrome" | null;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "replay_pwa_dismissed_v2";

function detectPlatform(): InstallPlatform {
  const ua = navigator.userAgent;
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  if (isStandalone) return null;

  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isAndroid = /android/i.test(ua);
  const isSafari = /safari/i.test(ua) && !/chrome/i.test(ua) && !/crios/i.test(ua) && !/fxios/i.test(ua);
  const isChrome = /chrome/i.test(ua) && !/chromium/i.test(ua) && !/edg\//i.test(ua) && !/opr\//i.test(ua);

  if (isIOS && isSafari) return "ios-safari";
  if (isAndroid && isChrome) return "android-chrome";
  return null;
}

export function useInstallPrompt() {
  const [platform] = useState<InstallPlatform>(() => detectPlatform());
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [isDismissed, setIsDismissed] = useState(() => {
    return localStorage.getItem(DISMISS_KEY) === "1";
  });

  useEffect(() => {
    if (platform !== "android-chrome") return;
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, [platform]);

  const canShow =
    !isDismissed &&
    (platform === "ios-safari" || (platform === "android-chrome" && deferred !== null));

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === "accepted") {
      setDismissed();
    }
    setDeferred(null);
  };

  const dismissRef = useRef(false);
  const setDismissed = () => {
    if (dismissRef.current) return;
    dismissRef.current = true;
    localStorage.setItem(DISMISS_KEY, "1");
    setIsDismissed(true);
  };

  return { platform, canShow, install, dismiss: setDismissed };
}
