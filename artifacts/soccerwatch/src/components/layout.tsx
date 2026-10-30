import React from "react";
import { Link, useLocation } from "wouter";
import { Globe, Home, Bookmark, User as UserIcon, MapPin, CalendarDays, GraduationCap, LayoutDashboard } from "lucide-react";
import { useMatchCopy } from "@/i18n/match-strings";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import { InstallBanner } from "@/components/install-banner";
import { OrientationLock } from "@/components/orientation-lock";
import { useAuth } from "@/lib/auth";
import { isPublicStandalonePath } from "@/lib/public-paths";
import { useMyMatches } from "@/lib/match-api";
import { useGetAcademyConsoleMemberships, getGetAcademyConsoleMembershipsQueryKey, useGetAcademyFamilyMe, getGetAcademyFamilyMeQueryKey } from "@workspace/api-client-react";
import { recordInAppLocation } from "@/lib/find-nav";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { t, locale, setLocale } = useTranslation();
  const { user, isGuest } = useAuth();
  const matchCopy = useMatchCopy();
  const myMatches = useMyMatches(Boolean(user) && !isGuest);
  const academyFamily = useGetAcademyFamilyMe(undefined, { query: { queryKey: getGetAcademyFamilyMeQueryKey(), enabled: Boolean(user) && !isGuest, retry: false } });
  const academyMemberships = useGetAcademyConsoleMemberships({
    query: {
      enabled: !isGuest && Boolean(user),
      queryKey: getGetAcademyConsoleMembershipsQueryKey(),
    },
  });
  const hasAcademyLinks = Boolean(academyFamily.data) || (academyMemberships.data?.length ?? 0) > 0;
  const inviteCount = myMatches.data?.invites.length ?? 0;


  // Find yourself can go back to wherever the player came from inside the app.
  React.useEffect(() => { recordInAppLocation(location); }, [location]);

  const isLogin = location === "/";
  const isImmersivePlayer = location.startsWith("/player/") || location.startsWith("/claim/") || location.startsWith("/find-quick/") || location.startsWith("/week/");
  const isWeeklyHighlight = location.startsWith("/week/");
  const isPortfolio = location.startsWith("/portfolio/");
  // Find yourself is part of the app (header, language switch, tab bar) but
  // scrolls as a document, so its tab bar is pinned to the viewport.
  const isWholeGameClaim = location.startsWith("/find/");
  const isLegalDocument = location === "/privacy" || location === "/terms" || location === "/delete-account";
  const isOwnerShare = location.startsWith("/w/");
  const isOwnerVar = location.startsWith("/owner/var/");
  const isMatchRoom = location.startsWith("/m/");
  const isGuidedDemo = location === "/demo" || location.startsWith("/demo/");
  const isAcademyConsole = location === "/academy" || location.startsWith("/academy/");
  const { isFullscreenVideo } = useFullscreenVideo();

  const isAuthPage = location.startsWith("/sign-in") || location.startsWith("/sign-up") || location === "/consent" || location === "/onboarding";
  const hideHeader = isLogin || isImmersivePlayer || isPortfolio || isAuthPage || isFullscreenVideo || isOwnerShare || isOwnerVar || isMatchRoom || isGuidedDemo || isAcademyConsole;
  const hideTabBar = hideHeader || location.startsWith("/f/") || isPublicStandalonePath(location);

  return (
    <div
      className={cn(
        "app-shell mx-auto w-full bg-background relative flex flex-col rp-glow",
        isGuidedDemo ? "max-w-none app-shell--wide" : isAcademyConsole ? "max-w-none" : isLegalDocument ? "max-w-[680px]" : "max-w-[440px]",
        (isLogin || isAuthPage || isWholeGameClaim || isGuidedDemo || isAcademyConsole) ? "min-h-[100dvh] overflow-visible" : "h-[100dvh] overflow-hidden",
        !hideTabBar && "app-shell--player-nav",
        hasAcademyLinks && !hideTabBar && "app-shell--academy-links",
      )}
    >
      {!hideHeader && (
        <header className={`replay-header sticky top-3 z-40 mx-3 mt-3 mb-2 shrink-0 rounded-2xl border border-line bg-surface/95 px-4 py-2.5 backdrop-blur-md ${hasAcademyLinks ? "replay-header--with-academy" : ""}`}>
          <div className={`replay-header-content flex items-center justify-between ${hasAcademyLinks ? "gap-2" : "gap-3"}`}>
            <div className={`replay-lockup flex min-w-0 items-center ${hasAcademyLinks ? "replay-lockup--with-academy gap-2.5" : "gap-2"}`}>
              <LogoMark size={34} />
              <span className="replay-wordmark" aria-label="Replay">
                <span className="replay-wordmark-ar" lang="ar">ريبلاي</span>
                <span className="replay-wordmark-en">REPLAY</span>
              </span>
              {hasAcademyLinks && (
                <div className="replay-academy-links inline-flex h-11 shrink-0 items-center gap-0.5 rounded-full border border-line bg-raised p-0.5" role="group" aria-label="الأكاديمية/Academy">
                  {academyFamily.data && (
                    <Link href="/academy/me" data-testid="link-my-academy-family" aria-label={t.account.myAcademy} className="replay-academy-link inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] font-semibold leading-none text-foreground transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turf focus-visible:ring-offset-2 focus-visible:ring-offset-raised">
                      <GraduationCap className="h-4 w-4 shrink-0 text-turf" strokeWidth={2} aria-hidden="true" />
                      <span className="replay-academy-label">{locale === "ar" ? "أكاديميتي" : t.account.myAcademy}</span>
                    </Link>
                  )}
                  {academyFamily.data && (academyMemberships.data?.length ?? 0) > 0 && <span className="replay-academy-divider h-4 w-px shrink-0 bg-line" aria-hidden="true" />}
                  {(academyMemberships.data?.length ?? 0) > 0 && (
                    <Link href="/academy" data-testid="link-academy-console" aria-label={t.account.academyConsole} className="replay-academy-link inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] font-semibold leading-none text-foreground transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turf focus-visible:ring-offset-2 focus-visible:ring-offset-raised">
                      <LayoutDashboard className="h-4 w-4 shrink-0 text-[#B9A8FF]" strokeWidth={2} aria-hidden="true" />
                      <span className="replay-academy-label replay-academy-console-short">{locale === "ar" ? t.account.academyConsole : t.account.academyConsoleShort}</span>
                      <span className="replay-academy-label replay-academy-console-full">{t.account.academyConsole}</span>
                    </Link>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setLocale(locale === "ar" ? "en" : "ar")}
              aria-label="Change language"
              className={hasAcademyLinks
                ? "replay-language-toggle flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-[13px] font-semibold text-foreground"
                : "replay-language-toggle flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-raised px-3.5 py-2 text-sm font-semibold text-foreground"}
            >
              {!hasAcademyLinks && <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />}
              <span>{locale.toUpperCase()}</span>
            </button>
          </div>
        </header>
      )}

      <main
        className={cn(
          "w-full flex flex-col relative",
          isGuidedDemo || isAcademyConsole ? "min-h-0 flex-1 overflow-visible" : (isLogin || isAuthPage || isWholeGameClaim) ? "overflow-visible" : "flex-1 min-h-0 overflow-hidden",
        )}
      >
        {children}
      </main>

      {!isGuidedDemo && !isWeeklyHighlight && <OrientationLock />}
      {!isGuidedDemo && !isWeeklyHighlight && <InstallBanner />}

      {!hideTabBar && (
        <nav
          className={cn(
            isWholeGameClaim ? "fixed" : "absolute",
            "bottom-3 start-3 end-3 z-50 mx-auto grid h-[66px] max-w-[408px] grid-flow-col auto-cols-fr items-center gap-0.5 rounded-[22px] border border-line bg-raised p-1.5 text-muted-foreground shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
          )}
        >
          <NavItem
            href="/home"
            icon={<Home className="h-[22px] w-[22px]" />}
            label={t.nav.home}
            isActive={location === "/home"}
          />
          <NavItem
            href="/view"
            icon={<MapPin className="h-[22px] w-[22px]" />}
            label={t.nav.fields}
            isActive={location === "/view"}
          />
          <NavItem
            href="/matches"
            icon={<CalendarDays className="h-[22px] w-[22px]" />}
            label={t.nav.myMatches}
            isActive={location === "/matches"}
            badge={inviteCount}
            badgeLabel={matchCopy.invites}
          />
          <NavItem
            href="/my-clips"
            icon={<Bookmark className="h-[22px] w-[22px]" />}
            label={t.nav.myClips}
            isActive={location === "/my-clips"}
          />
          <NavItem
            href="/account"
            icon={<UserIcon className="h-[22px] w-[22px]" />}
            label={t.nav.me}
            isActive={location === "/account"}
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
  badge = 0,
  badgeLabel,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  badge?: number;
  badgeLabel?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={badge > 0 ? `${label}: ${badge} ${badgeLabel ?? ""}`.trim() : label}
      className={cn(
        "flex h-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-2xl border-0 transition-colors",
        isActive ? "bg-turf text-void" : "bg-transparent text-muted-text"
      )}
    >
      <div
        className={cn(
          "relative transition-colors"
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
          "text-[11px] font-bold leading-none transition-colors"
        )}
      >
        {label}
      </span>
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
