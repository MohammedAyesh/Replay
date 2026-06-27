import { Link } from "wouter";
import { useListSavedClips } from "@workspace/api-client-react";
import { Bookmark, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";

export default function MyClips() {
  const { isGuest } = useAuth();
  const { data: clips, isLoading } = useListSavedClips({ query: { enabled: !isGuest } });

  if (isGuest) {
    return (
      <div className="flex-1 bg-background flex flex-col h-full overflow-hidden items-center justify-center p-6 text-center">
        <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
          <Bookmark className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-bold mb-2">Sign in to save clips</h2>
        <p className="text-muted-foreground mb-6">Create an account to build your personal highlight reel from local games.</p>
        <Link href="/">
          <Button className="w-full max-w-[200px] bg-primary text-white">Sign In / Register</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <div className="pt-safe px-4 py-6 bg-white border-b sticky top-0 z-10 shadow-sm flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Clips</h1>
          <p className="text-muted-foreground text-sm">{clips?.length || 0} saved highlights</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 pb-24">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="aspect-[3/4] bg-muted rounded-xl animate-pulse" />
            ))}
          </div>
        ) : !clips || clips.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <Video className="w-8 h-8 text-muted-foreground" />
            </div>
            <p className="text-muted-foreground">No saved clips yet.</p>
            <p className="text-sm text-muted-foreground mt-1">Browse the Watch feed and save your first clip.</p>
            <Link href="/watch">
              <Button variant="outline" className="mt-6">Go to Watch Feed</Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {clips.map(clip => (
              <Link key={clip.id} href={`/player/${clip.id}`}>
                <div className="relative aspect-[3/4] rounded-xl overflow-hidden shadow-sm group">
                  <div className="absolute inset-0 field-pattern bg-[#0d1f0d]" />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                  
                  <div className="absolute top-2 left-2 bg-primary text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow-sm">
                    {clip.momentLabel}
                  </div>
                  
                  <div className="absolute bottom-2 left-2 right-2">
                    <h3 className="text-white font-bold text-sm leading-tight mb-0.5 line-clamp-2">{clip.fieldName}</h3>
                    <p className="text-primary text-[10px] font-medium">{clip.court} • {clip.date}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
