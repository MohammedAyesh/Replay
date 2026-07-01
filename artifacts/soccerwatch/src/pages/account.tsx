import * as React from "react";
import { useGetMe, useGetAccountStats, getGetAccountStatsQueryKey, getGetMeQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { useClerk } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, Bookmark, Shield, HelpCircle, ChevronRight, ChevronLeft, LogOut, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Account() {
  const { isGuest, user: authUser } = useAuth();
  const { t, locale, setLocale } = useTranslation();
  const { signOut } = useClerk();
  const queryClient = useQueryClient();

  const { data: user } = useGetMe({ query: { enabled: !isGuest, queryKey: getGetMeQueryKey() } });
  const displayUser = user ?? authUser;
  const { data: stats } = useGetAccountStats({ query: { enabled: !isGuest, queryKey: getGetAccountStatsQueryKey() } });

  const [isLoggingOut, setIsLoggingOut] = React.useState(false);

  const handleLogout = () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);

    // Wipe all cached queries so the next user doesn't see stale data
    queryClient.clear();

    if (isGuest) {
      window.location.href = `${basePath}/`;
      return;
    }

    // Clear backend session (fire-and-forget)
    fetch(`${basePath}/api/auth/logout`, { method: "POST", credentials: "include" })
      .catch(() => {});

    // Sign out of Clerk, then navigate.  We race against a 2-second timeout
    // so the user isn't stuck if signOut hangs or never resolves.
    const signOutPromise = signOut().catch(() => {});
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 2000));
    Promise.race([signOutPromise, timeoutPromise]).then(() => {
      window.location.replace(`${basePath}/`);
    });
  };

  const initial = displayUser?.name?.charAt(0)?.toUpperCase() || "G";
  const name = isGuest ? t.account.guestName : displayUser?.name || t.account.playerFallback;
  const email = isGuest ? t.account.guestEmail : displayUser?.email || "";

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <div className="pt-safe px-4 py-6 bg-white border-b shadow-sm">
        <h1 className="text-2xl font-bold text-foreground">{t.account.title}</h1>
        <p className="text-muted-foreground text-sm">{isGuest ? t.account.guestSubtitle : t.account.subtitle}</p>
      </div>

      <div className="flex-1 overflow-y-auto pb-24">
        {/* Profile Card */}
        <div className="p-6 flex flex-col items-center border-b bg-white">
          <div className="w-24 h-24 rounded-full bg-[#0d1f0d] text-primary flex items-center justify-center text-4xl font-bold mb-4 shadow-inner">
            {initial}
          </div>
          <h2 className="text-xl font-bold text-foreground">{name}</h2>
          <p className="text-muted-foreground text-sm">{email}</p>
          {!isGuest && (
            <div className="flex flex-wrap justify-center gap-2 mt-3">
              {displayUser?.position && (
                <span className="px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold capitalize">
                  {displayUser.position}
                </span>
              )}
              {displayUser?.age != null && (
                <span className="px-2.5 py-1 rounded-full bg-muted text-muted-foreground text-xs font-semibold">
                  {displayUser.age} yrs
                </span>
              )}
              {displayUser?.gender && (
                <span className="px-2.5 py-1 rounded-full bg-muted text-muted-foreground text-xs font-semibold capitalize">
                  {displayUser.gender.replace(/_/g, " ")}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Stats */}
        {!isGuest && (
          <div className="p-4 bg-white border-b">
            <div className="grid grid-cols-3 gap-4">
              <StatCard label={t.account.savedClips} value={stats?.savedClips ?? 0} />
              <StatCard label={t.account.likesGiven} value={stats?.likesGiven ?? 0} />
              <StatCard label={t.account.fields} value={stats?.fieldsVisited ?? 0} />
            </div>
          </div>
        )}

        {/* Settings List */}
        <div className="mt-4 bg-white border-y">
          <SettingRow icon={<Bell className="w-5 h-5 text-muted-foreground" />} label={t.account.notifications} />
          <SettingRow icon={<Bookmark className="w-5 h-5 text-muted-foreground" />} label={t.account.savedFields} />
          <SettingRow icon={<Shield className="w-5 h-5 text-muted-foreground" />} label={t.account.privacy} />
          <SettingRow icon={<HelpCircle className="w-5 h-5 text-muted-foreground" />} label={t.account.help} />
          {/* Language toggle */}
          <div className="w-full flex items-center justify-between p-4 bg-white border-b border-border">
            <div className="flex items-center gap-3">
              <Globe className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium text-foreground">{t.account.language}</span>
            </div>
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
              <button
                onClick={() => setLocale("en")}
                className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors ${
                  locale === "en"
                    ? "bg-white text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                EN
              </button>
              <button
                onClick={() => setLocale("ar")}
                className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors ${
                  locale === "ar"
                    ? "bg-white text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                عربي
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 mt-4">
          <Button
            type="button"
            variant="outline"
            disabled={isLoggingOut}
            className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive py-6 rounded-xl font-semibold disabled:opacity-50"
            onClick={handleLogout}
          >
            <LogOut className="w-5 h-5 me-2" />
            {isLoggingOut
              ? (isGuest ? "Redirecting..." : "Signing out...")
              : (isGuest ? t.account.signInRegister : t.account.signOut)}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-muted/50 rounded-xl p-3 text-center border border-border">
      <div className="text-2xl font-bold text-foreground mb-1">{value}</div>
      <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">{label}</div>
    </div>
  );
}

function SettingRow({ icon, label, borderBottom = true }: { icon: React.ReactNode; label: string; borderBottom?: boolean }) {
  return (
    <button className={`w-full flex items-center justify-between p-4 bg-white hover:bg-muted/50 transition-colors ${borderBottom ? 'border-b border-border' : ''}`}>
      <div className="flex items-center gap-3">
        {icon}
        <span className="font-medium text-foreground">{label}</span>
      </div>
      <ChevronRight className="w-5 h-5 text-muted-foreground rtl:hidden" />
      <ChevronLeft className="w-5 h-5 text-muted-foreground ltr:hidden" />
    </button>
  );
}
