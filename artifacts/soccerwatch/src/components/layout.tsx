import React from "react";
import { Link, useLocation } from "wouter";
import { Home, MapPin, Bookmark, User as UserIcon } from "lucide-react";
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
  const isWatchFeed = location === "/watch";
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
            "absolute bottom-0 start-0 end-0 z-50 flex items-center justify-around pb-safe pt-2 px-4 h-16 backdrop-blur-md",
            useTranslucentBar
              ? "bg-black/80 text-white"
              : "bg-background/95 text-muted-foreground"
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
    <Link href={href} className="flex flex-col items-center justify-center gap-1 w-16">
      <div
        className={cn(
          "transition-colors",
          isActive
            ? "text-primary"
            : isTranslucent
            ? "text-white/70 hover:text-white"
            : "text-muted-foreground hover:text-foreground"
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
            ? "text-white/70"
            : "text-muted-foreground"
        )}
      >
        {label}
      </span>
    </Link>
  );
}
