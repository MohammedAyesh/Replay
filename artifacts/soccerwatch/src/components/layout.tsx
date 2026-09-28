import React from "react";
import { Link, useLocation } from "wouter";
import { Globe, Home, Bookmark, User as UserIcon, MapPin, CalendarDays } from "lucide-react";
import { useMatchCopy } from "@/i18n/match-strings";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import { InstallBanner } from "@/components/install-banner";
import { OrientationLock } from "@/components/orientation-lock";
import { useAuth } from "@/lib/auth";
import { isPublicStandalonePath } from "@/lib/public-paths";
import { useMyMatches } from "@/lib/match-api";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { t, locale, setLocale } = useTranslation();
  const { user, isGuest } = useAuth();
  const matchCopy = useMatchCopy();
  const myMatches = useMyMatches(Boolean(user) && !isGuest);
  const inviteCount = myMatches.data?.invites.length ?? 0;


  const isLogin = location === "/";
  const isImmersivePlayer = location.startsWith("/player/") || location.startsWith("/claim/") || location.startsWith("/find/") || location.startsWith("/find-quick/");
  const isPortfolio = location.startsWith("/portfolio/");
  const isWholeGameClaim = location.startsWith("/find/");
  const isWatchFeed = location === "/home";
  const isLegalDocument = location === "/privacy" || location === "/terms" || location === "/delete-account";
  const isOwnerShare = location.startsWith("/w/");
  const isOwnerVar = location.startsWith("/owner/var/");
  const isMatchRoom = location.startsWith("/m/");
  const isGuidedDemo = location === "/demo";
  const { isFullscreenVideo } = useFullscreenVideo();

  const isAuthPage = location.startsWith("/sign-in") || location.startsWith("/sign-up") || location === "/consent" || location === "/onboarding";
  const hideHeader = isLogin || isImmersivePlayer || isPortfolio || isAuthPage || isFullscreenVideo || isOwnerShare || isOwnerVar || isMatchRoom || isGuidedDemo;
  const hideTabBar = hideHeader || location.startsWith("/f/") || isPublicStandalonePath(location);
  const useTranslucentBar = isWatchFeed;

  return (
    <div
      className={cn(
        "app-shell mx-auto w-full bg-background relative flex flex-col rp-glow",
        isGuidedDemo ? "max-w-none" : isLegalDocument ? "max-w-[680px]" : "max-w-[440px]",
        (isLogin || isAuthPage || isWholeGameClaim || isGuidedDemo) ? "min-h-[100dvh] overflow-visible" : "h-[100dvh] overflow-hidden",
      )}
    >
      {!hideHeader && (
        <header className="replay-header sticky top-3 z-40 mx-3 mt-3 mb-2 shrink-0 rounded-2xl border border-line bg-surface/95 px-4 py-2.5 backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <div className="replay-lockup flex min-w-0 items-center gap-2">
              <LogoMark size={34} />
              <span className="replay-wordmark" aria-label="Replay">
                <span className="replay-wordmark-ar" lang="ar">ريبلاي</span>
                <span className="replay-wordmark-en">REPLAY</span>
              </span>
            </div>
            <button
              type="button"
              onClick={() => setLocale(locale === "ar" ? "en" : "ar")}
              aria-label="Change language"
              className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-raised px-3.5 py-2 text-sm font-semibold text-foreground"
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
          isGuidedDemo ? "min-h-0 flex-1 overflow-visible" : (isLogin || isAuthPage || isWholeGameClaim) ? "overflow-visible" : "flex-1 min-h-0 overflow-hidden",
        )}
      >
        {children}
      </main>

      <OrientationLock />
      <InstallBanner />

      {!hideTabBar && (
        <nav
          className={cn(
            "absolute bottom-3 start-3 end-3 z-50 flex h-[70px] mx-auto max-w-[408px] items-center justify-around gap-1 rounded-2xl border border-line px-2 pb-safe pt-2 backdrop-blur-md",
            useTranslucentBar
              ? "bg-void/85 text-text"
              : "bg-surface/95 text-muted-foreground"
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
            icon={<MapPin className="w-6 h-6" />}
            label={t.nav.fields}
            isActive={location === "/view"}
            isTranslucent={useTranslucentBar}
          />
          <NavItem
            href="/matches"
            icon={<CalendarDays className="w-6 h-6" />}
            label={t.nav.myMatches}
            isActive={location === "/matches"}
            isTranslucent={useTranslucentBar}
            badge={inviteCount}
            badgeLabel={matchCopy.invites}
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
            label={t.nav.me}
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
  badge = 0,
  badgeLabel,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  isTranslucent: boolean;
  badge?: number;
  badgeLabel?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={badge > 0 ? `${label}: ${badge} ${badgeLabel ?? ""}`.trim() : label}
      className={cn(
        "flex h-[54px] min-w-0 flex-1 max-w-16 flex-col items-center justify-center gap-0.5 rounded-xl border-0 py-1 transition-colors",
        isActive ? "bg-turf/10" : "bg-transparent"
      )}
    >
      <div
        className={cn(
          "relative transition-colors",
          isActive
             ? "text-turf"
            : isTranslucent
             ? "text-muted-foreground hover:text-text"
             : "text-muted-foreground hover:text-text"
        )}
      >
        {icon}
        {badge > 0 && (
          <span aria-hidden="true" className="absolute -end-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-floodlight px-1 text-[9px] font-black leading-none text-void">
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </div>
      <span
        className={cn(
          "text-[10px] font-medium uppercase transition-colors",
          isActive
             ? "text-turf"
            : isTranslucent
             ? "text-muted-foreground"
             : "text-muted-foreground"
        )}
      >
        {label}
      </span>
      {isActive && (
        <span className="mt-0.5 h-1 w-6 rounded-full bg-turf" />
      )}
    </Link>
  );
}

function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <span className="block shrink-0" style={{ width: size, height: size * (200 / 220) }}>
      <img src="/replay-mark.svg" alt="" aria-hidden="true" className="h-full w-full object-contain" />
    </span>
  );
}
