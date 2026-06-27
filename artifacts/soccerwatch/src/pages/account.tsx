import { useGetMe, useGetAccountStats, useLogout, getGetAccountStatsQueryKey, getGetMeQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Bell, Bookmark, Shield, HelpCircle, ChevronRight, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Account() {
  const { isGuest, user: authUser, setUser } = useAuth();
  const [, setLocation] = useLocation();
  const logoutMutation = useLogout();

  const { data: user } = useGetMe({ query: { enabled: !isGuest, queryKey: getGetMeQueryKey() } });
  const displayUser = user ?? authUser;
  const { data: stats } = useGetAccountStats({ query: { enabled: !isGuest, queryKey: getGetAccountStatsQueryKey() } });

  const handleLogout = () => {
    if (isGuest) {
      setUser(null);
      setLocation("/");
      return;
    }
    
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        setUser(null);
        setLocation("/");
      }
    });
  };

  const initial = displayUser?.name?.charAt(0)?.toUpperCase() || "G";
  const name = isGuest ? "Guest User" : displayUser?.name || "Player";
  const email = isGuest ? "Browsing as guest" : displayUser?.email || "";

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <div className="pt-safe px-4 py-6 bg-white border-b shadow-sm">
        <h1 className="text-2xl font-bold text-foreground">Account</h1>
        <p className="text-muted-foreground text-sm">{isGuest ? "Guest session" : "Manage your profile"}</p>
      </div>

      <div className="flex-1 overflow-y-auto pb-24">
        {/* Profile Card */}
        <div className="p-6 flex flex-col items-center border-b bg-white">
          <div className="w-24 h-24 rounded-full bg-[#0d1f0d] text-primary flex items-center justify-center text-4xl font-bold mb-4 shadow-inner">
            {initial}
          </div>
          <h2 className="text-xl font-bold text-foreground">{name}</h2>
          <p className="text-muted-foreground text-sm">{email}</p>
        </div>

        {/* Stats */}
        {!isGuest && (
          <div className="p-4 bg-white border-b">
            <div className="grid grid-cols-3 gap-4">
              <StatCard label="Saved Clips" value={stats?.savedClips ?? 0} />
              <StatCard label="Likes Given" value={stats?.likesGiven ?? 0} />
              <StatCard label="Fields" value={stats?.fieldsVisited ?? 0} />
            </div>
          </div>
        )}

        {/* Settings List */}
        <div className="mt-4 bg-white border-y">
          <SettingRow icon={<Bell className="w-5 h-5 text-muted-foreground" />} label="Notifications" />
          <SettingRow icon={<Bookmark className="w-5 h-5 text-muted-foreground" />} label="Saved Fields" />
          <SettingRow icon={<Shield className="w-5 h-5 text-muted-foreground" />} label="Privacy & Security" />
          <SettingRow icon={<HelpCircle className="w-5 h-5 text-muted-foreground" />} label="Help & Support" borderBottom={false} />
        </div>

        <div className="p-6 mt-4">
          <Button 
            variant="outline" 
            className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive py-6 rounded-xl font-semibold"
            onClick={handleLogout}
          >
            <LogOut className="w-5 h-5 mr-2" />
            {isGuest ? "Sign In / Register" : "Sign Out"}
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
      <ChevronRight className="w-5 h-5 text-muted-foreground" />
    </button>
  );
}
