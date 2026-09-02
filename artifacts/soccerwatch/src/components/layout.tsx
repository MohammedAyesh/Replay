import React from "react";
import { Link, useLocation } from "wouter";
import { Globe, Home, Bookmark, User as UserIcon, LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import { InstallBanner } from "@/components/install-banner";
import { OrientationLock } from "@/components/orientation-lock";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { t, locale, setLocale } = useTranslation();


  const isLogin = location === "/";
  const isImmersivePlayer = location.startsWith("/player/") || location.startsWith("/claim-match/");
  const isWatchFeed = location === "/home";
  const { isFullscreenVideo } = useFullscreenVideo();

  const isAuthPage = location.startsWith("/sign-in") || location.startsWith("/sign-up") || location === "/consent" || location === "/onboarding";
  const hideTabBar = isLogin || isImmersivePlayer || isAuthPage || isFullscreenVideo;
  const useTranslucentBar = isWatchFeed;

  return (
    <div
      className={cn(
        "app-shell mx-auto w-full max-w-[440px] bg-background relative flex flex-col shadow-2xl rp-glow",
        (isLogin || isAuthPage) ? "min-h-[100dvh] overflow-visible" : "h-[100dvh] overflow-hidden",
      )}
    >
      {!hideTabBar && (
        <header className="sticky top-3 z-40 mx-3 mt-3 mb-2 shrink-0 rounded-[20px] border border-white/[0.08] bg-[rgba(10,11,13,0.82)] px-4 py-2.5 backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <LogoMark size={34} />
              <span
                className="bg-gradient-to-r from-[#2FD8C4] to-[#7B5CFF] bg-clip-text font-display text-[21px] font-bold tracking-[-0.015em] text-transparent"
              >
                REPLAY
              </span>
            </div>
            <button
              type="button"
              onClick={() => setLocale(locale === "ar" ? "en" : "ar")}
              aria-label="Change language"
              className="flex shrink-0 items-center gap-1.5 rounded-[99px] border-0 bg-white/[0.07] px-3.5 py-2 text-sm font-semibold text-foreground"
            >
              <Globe className="h-4 w-4" aria-hidden="true" />
              <span>{locale.toUpperCase()}</span>
            </button>
          </div>
        </header>
      )}

      <main
        className={cn(
          "w-full flex flex-col relative",
          (isLogin || isAuthPage) ? "overflow-visible" : "flex-1 min-h-0 overflow-hidden",
        )}
      >
        {children}
      </main>

      <OrientationLock />
      <InstallBanner />

      {!hideTabBar && (
        <nav
          className={cn(
            "absolute bottom-3 start-3 end-3 z-50 flex h-[70px] mx-auto max-w-[408px] items-center justify-around gap-1 rounded-[26px] border border-white/[0.08] px-2 pb-safe pt-2 backdrop-blur-md",
            useTranslucentBar
              ? "bg-black/75 text-white"
              : "bg-[rgba(10,11,13,0.9)] text-muted-foreground"
          )}
        >
          <NavItem
            href="/home"
            icon={<Home className="w-6 h-6" />}
            label={t.nav.home}
            isActive={location === "/home"}
            isTranslucent={useTranslucentBar}
          />
          <NavItem
            href="/view"
            icon={<LayoutGrid className="w-6 h-6" />}
            label={t.nav.view}
            isActive={location === "/view"}
            isTranslucent={useTranslucentBar}
          />
          <NavItem
            href="/my-clips"
            icon={<Bookmark className="w-6 h-6" />}
            label={t.nav.myClips}
            isActive={location === "/my-clips"}
            isTranslucent={useTranslucentBar}
          />
          <NavItem
            href="/account"
            icon={<UserIcon className="w-6 h-6" />}
            label={t.nav.account}
            isActive={location === "/account"}
            isTranslucent={useTranslucentBar}
          />
        </nav>
      )}
    </div>
  );
}

function NavItem({
  href,
  icon,
  label,
  isActive,
  isTranslucent,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  isTranslucent: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex h-[54px] w-16 flex-col items-center justify-center gap-0.5 rounded-[14px] border-0 py-1 transition-colors",
        isActive ? "bg-[rgba(212,255,79,0.10)]" : "bg-transparent"
      )}
    >
      <div
        className={cn(
          "transition-colors",
          isActive
            ? "text-primary"
            : isTranslucent
            ? "text-white/60 hover:text-white"
            : "text-zinc-500 hover:text-zinc-300"
        )}
      >
        {icon}
      </div>
      <span
        className={cn(
          "text-[10px] font-medium uppercase transition-colors",
          isActive
            ? "text-primary"
            : isTranslucent
            ? "text-white/50"
            : "text-zinc-500"
        )}
      >
        {label}
      </span>
      {isActive && (
        <span className="w-1 h-1 rounded-full bg-primary mt-0.5" />
      )}
    </Link>
  );
}

function LogoMark({ size = 34 }: { size?: number }) {
  const facets = [
    { cx: 95, cy: 96, color: "#22C7B5" },
    { cx: 126.2, cy: 42, color: "#BFFF5C" },
    { cx: 63.8, cy: 42, color: "#3FE0C9" },
    { cx: 157.4, cy: 96, color: "#1FA79B" },
    { cx: 32.6, cy: 96, color: "#186E7E" },
    { cx: 126.2, cy: 150, color: "#1C8AA0" },
    { cx: 63.8, cy: 150, color: "#6C4FE0" },
  ];

  return (
    <span className="block shrink-0" style={{ width: size, height: size * (200 / 220) }}>
      <svg viewBox="-5 0 225 200" width="100%" height="100%" aria-hidden="true">
        <defs>
          <clipPath id="replay-logo-ball-clip">
            <circle cx="95" cy="96" r="88" />
          </clipPath>
        </defs>
        <g clipPath="url(#replay-logo-ball-clip)">
          {facets.map((facet) => (
            <polygon
              key={`${facet.cx}-${facet.cy}`}
              points={hexPoints(facet.cx, facet.cy, 36)}
              fill={facet.color}
              stroke="#0B0F1A"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          ))}
        </g>
        <circle cx="95" cy="96" r="88" fill="none" stroke="#0B0F1A" strokeWidth="3" opacity="0.35" />
        <polygon
          points="170,62 170,134 210,98"
          fill="#0B0F1A"
          stroke="#0B0F1A"
          strokeWidth="16"
          strokeLinejoin="round"
        />
        <polygon
          points="172,68 172,128 206,98"
          fill="#D4FF4F"
          stroke="#D4FF4F"
          strokeWidth="12"
          strokeLinejoin="round"
        />
        <circle cx="178" cy="46" r="7.5" fill="#0B0F1A" />
        <circle cx="178" cy="46" r="5.5" fill="#FF5A3C" />
      </svg>
    </span>
  );
}

function hexPoints(cx: number, cy: number, size: number) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index - 90);
    return `${(cx + size * Math.cos(angle)).toFixed(1)},${(cy + size * Math.sin(angle)).toFixed(1)}`;
  }).join(" ");
}
