import React from "react";
import { Link, useLocation } from "wouter";
import { Home, MapPin, Bookmark, User as UserIcon, GraduationCap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import { InstallBanner } from "@/components/install-banner";
import { OrientationLock } from "@/components/orientation-lock";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { t } = useTranslation();

  const isLogin = location === "/";
  const isImmersivePlayer = location.startsWith("/player/");
  const isWatchFeed = location === "/home";
  const { isFullscreenVideo } = useFullscreenVideo();

  const isAuthPage = location.startsWith("/sign-in") || location.startsWith("/sign-up") || location === "/onboarding";
  const hideTabBar = isLogin || isImmersivePlayer || isAuthPage || isFullscreenVideo;
  const useTranslucentBar = isWatchFeed;

  return (
    <div className="mx-auto w-full max-w-[420px] h-[100dvh] bg-background relative overflow-hidden flex flex-col shadow-2xl">
      <main className="flex-1 min-h-0 w-full flex flex-col overflow-hidden relative">
        {children}
      </main>

      <OrientationLock />
      <InstallBanner />

      {!hideTabBar && (
        <nav
          className={cn(
            "absolute bottom-0 start-0 end-0 z-50 flex items-center justify-around pb-safe pt-2 px-4 h-16 backdrop-blur-md border-t",
            useTranslucentBar
              ? "bg-black/85 border-white/5 text-white"
              : "bg-zinc-950/95 border-zinc-800/60 text-muted-foreground"
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
            href="/fields"
            icon={<MapPin className="w-6 h-6" />}
            label={t.nav.fields}
            isActive={location.startsWith("/fields")}
            isTranslucent={useTranslucentBar}
          />
          {/* Academies tab — hidden until feature is ready
          <NavItem
            href="/academies"
            icon={<GraduationCap className="w-6 h-6" />}
            label={t.nav.academies}
            isActive={location === "/academies"}
            isTranslucent={useTranslucentBar}
          />
          */}
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
    <Link href={href} className="flex flex-col items-center justify-center gap-0.5 w-16 py-1">
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
          "text-[10px] font-medium transition-colors",
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
