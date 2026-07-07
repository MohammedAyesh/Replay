import { useRoute, useLocation } from "wouter";
import { useGetUserProfile, useFollowUser, useUnfollowUser, PublicProfile } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Users, UserCheck, Video, UserPlus, UserMinus } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function getProfileQueryKey(id: number) {
  return ["getUserProfile", id];
}

export default function Profile() {
  const [, params] = useRoute("/players/:id");
  const userId = parseInt(params?.id || "0", 10);

  const { data: profile, isLoading, isError } = useGetUserProfile(userId, {
    query: {
      enabled: !!userId,
      queryKey: getProfileQueryKey(userId),
    },
  });

  if (isLoading) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading profile…</div>
      </div>
    );
  }

  if (isError || !profile) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Player not found.</div>
      </div>
    );
  }

  return <ProfileScreen profile={profile} />;
}

function ProfileScreen({ profile }: { profile: PublicProfile }) {
  const [, setLocation] = useLocation();
  const { user, isGuest } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const followMutation = useFollowUser();
  const unfollowMutation = useUnfollowUser();

  const isOwnProfile = !isGuest && user?.id === profile.id;

  const handleFollow = () => {
    if (isGuest) {
      toast({
        title: "Sign in to follow",
        description: "Create an account to follow players.",
      });
      return;
    }

    if (profile.isFollowing) {
      unfollowMutation.mutate(
        { id: profile.id },
        {
          onSuccess: (data) => {
            queryClient.setQueryData(getProfileQueryKey(profile.id), (old: PublicProfile | undefined) =>
              old ? { ...old, isFollowing: false, followerCount: data.followerCount } : old
            );
          },
          onError: () => {
            toast({ title: "Failed to unfollow", variant: "destructive" });
          },
        }
      );
    } else {
      followMutation.mutate(
        { id: profile.id },
        {
          onSuccess: (data) => {
            queryClient.setQueryData(getProfileQueryKey(profile.id), (old: PublicProfile | undefined) =>
              old ? { ...old, isFollowing: true, followerCount: data.followerCount } : old
            );
          },
          onError: () => {
            toast({ title: "Failed to follow", variant: "destructive" });
          },
        }
      );
    }
  };

  const isMutating = followMutation.isPending || unfollowMutation.isPending;

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-y-auto">
      {/* Top bar */}
      <div className="pt-safe px-4 pt-4 flex items-center gap-2 sticky top-0 z-10 bg-background/95 backdrop-blur-md pb-3">
        <button
          onClick={() => history.back()}
          className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-foreground active:scale-95 transition-transform"
        >
          <ChevronLeft className="w-5 h-5 rtl:hidden" />
          <ChevronRight className="w-5 h-5 ltr:hidden" />
        </button>
        <span className="text-sm font-semibold text-muted-foreground flex-1 truncate">{profile.name}</span>
      </div>

      <div className="px-5 py-8">
        {/* Avatar */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="flex flex-col items-center gap-4 mb-8"
        >
          <div className="w-24 h-24 rounded-full bg-primary flex items-center justify-center shadow-lg">
            <span className="text-3xl font-bold text-white">{getInitials(profile.name)}</span>
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold">{profile.name}</h1>
            {profile.position && (
              <p className="text-muted-foreground text-sm capitalize mt-0.5">{profile.position}</p>
            )}
            {profile.age && (
              <p className="text-muted-foreground text-xs mt-0.5">Age {profile.age}</p>
            )}
          </div>
        </motion.div>

        {/* Stats row */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-3 gap-3 mb-8"
        >
          <StatCard value={profile.clipCount} label="Clips" icon={<Video className="w-4 h-4" />} />
          <StatCard value={profile.followerCount} label="Followers" icon={<Users className="w-4 h-4" />} />
          <StatCard value={profile.followingCount} label="Following" icon={<UserCheck className="w-4 h-4" />} />
        </motion.div>

        {/* Follow / Unfollow button */}
        {!isOwnProfile && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
            <button
              onClick={handleFollow}
              disabled={isMutating}
              className={cn(
                "w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all active:scale-95",
                profile.isFollowing
                  ? "bg-muted text-foreground"
                  : "bg-primary text-white"
              )}
            >
              {profile.isFollowing ? (
                <>
                  <UserMinus className="w-4 h-4" />
                  Following
                </>
              ) : (
                <>
                  <UserPlus className="w-4 h-4" />
                  Follow
                </>
              )}
            </button>
          </motion.div>
        )}

        {isOwnProfile && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="text-center text-sm text-muted-foreground py-2"
          >
            This is your profile
          </motion.div>
        )}
      </div>
    </div>
  );
}

function StatCard({ value, label, icon }: { value: number; label: string; icon: React.ReactNode }) {
  return (
    <div className="bg-muted/40 rounded-xl p-3 flex flex-col items-center gap-1">
      <div className="text-muted-foreground">{icon}</div>
      <span className="text-xl font-bold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
