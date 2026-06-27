import { useEffect, useRef, useState } from "react";
import { useListClips, useToggleLike, useSaveClip, useUnsaveClip, getListClipsQueryKey, getListSavedClipsQueryKey, Clip } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Heart, Share, Bookmark, Volume2, VolumeX, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

const FALLBACK_VIDEOS = [
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4"
];

export default function Watch() {
  const { data: clips, isLoading } = useListClips();

  if (isLoading) {
    return <div className="flex-1 bg-black flex items-center justify-center text-white">Loading feed...</div>;
  }

  if (!clips || clips.length === 0) {
    return <div className="flex-1 bg-black flex items-center justify-center text-white">No clips available right now.</div>;
  }

  return (
    <div className="flex-1 bg-black overflow-y-scroll snap-y snap-mandatory no-scrollbar h-[100dvh]">
      {clips.map((clip, idx) => (
        <ClipScreen key={clip.id} clip={clip} index={idx} />
      ))}
    </div>
  );
}

function ClipScreen({ clip, index }: { clip: Clip; index: number }) {
  const queryClient = useQueryClient();
  const { isGuest } = useAuth();
  const { toast } = useToast();
  
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const toggleLikeMutation = useToggleLike();
  const saveClipMutation = useSaveClip();
  const unsaveClipMutation = useUnsaveClip();

  // Intersection Observer for autoplay
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          videoRef.current?.play().catch(() => {});
          setIsPlaying(true);
        } else {
          videoRef.current?.pause();
          setIsPlaying(false);
        }
      },
      { threshold: 0.6 }
    );

    if (videoRef.current) observer.observe(videoRef.current);
    return () => observer.disconnect();
  }, []);

  const handleToggleLike = () => {
    if (isGuest) {
      toast({ title: "Sign in to like", description: "Create an account to save your favorite moments." });
      return;
    }
    toggleLikeMutation.mutate(
      { id: clip.id },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(getListClipsQueryKey(), (old: Clip[] | undefined) => 
            old?.map(c => c.id === clip.id ? { ...c, isLiked: data.liked, likeCount: data.likeCount } : c)
          );
        }
      }
    );
  };

  const handleToggleSave = () => {
    if (isGuest) {
      toast({ title: "Sign in to save", description: "Create an account to build your highlight reel." });
      return;
    }
    
    if (clip.isSaved) {
      unsaveClipMutation.mutate(
        { data: { clipId: clip.id } },
        {
          onSuccess: () => {
            queryClient.setQueryData(getListClipsQueryKey(), (old: Clip[] | undefined) => 
              old?.map(c => c.id === clip.id ? { ...c, isSaved: false } : c)
            );
            queryClient.invalidateQueries({ queryKey: getListSavedClipsQueryKey() });
          }
        }
      );
    } else {
      saveClipMutation.mutate(
        { data: { clipId: clip.id } },
        {
          onSuccess: () => {
            queryClient.setQueryData(getListClipsQueryKey(), (old: Clip[] | undefined) => 
              old?.map(c => c.id === clip.id ? { ...c, isSaved: true } : c)
            );
            queryClient.invalidateQueries({ queryKey: getListSavedClipsQueryKey() });
            toast({ title: "Saved to My Clips", className: "bg-primary text-white border-none" });
          }
        }
      );
    }
  };

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const videoSrc = clip.videoUrl || FALLBACK_VIDEOS[index % FALLBACK_VIDEOS.length];

  return (
    <div className="relative w-full h-[100dvh] snap-start bg-black overflow-hidden" onClick={togglePlay}>
      {/* Background field pattern if video is small */}
      <div className="absolute inset-0 field-pattern opacity-30" />
      
      <video
        ref={videoRef}
        src={videoSrc}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline
        loop
        muted={isMuted}
      />

      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/80 pointer-events-none" />

      {/* Top Bar */}
      <div className="absolute top-0 left-0 w-full h-1 bg-white/20">
        <div className="h-full bg-primary w-1/3" /> {/* Fake progress */}
      </div>

      <div className="absolute top-safe pt-4 px-4 w-full flex justify-between items-start pointer-events-none">
        <div className="bg-primary/90 text-white px-3 py-1.5 rounded-full text-xs font-bold shadow-lg flex items-center gap-1.5">
          <CrownIcon className="w-3 h-3" />
          {clip.rank === 1 ? "#1 Clip of the Week" : `#${clip.rank} This Week`}
        </div>
        <button 
          onClick={toggleMute}
          className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white pointer-events-auto backdrop-blur-md"
        >
          {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </button>
      </div>

      {/* Right Rail */}
      <div className="absolute right-4 bottom-28 flex flex-col items-center gap-6 pointer-events-auto">
        <div className="flex flex-col items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button 
            onClick={handleToggleLike}
            className="w-12 h-12 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md transition-transform active:scale-90"
          >
            <Heart className={cn("w-6 h-6 transition-colors", clip.isLiked ? "fill-destructive text-destructive" : "text-white")} />
          </button>
          <span className="text-white font-medium text-xs shadow-black drop-shadow-md">{clip.likeCount}</span>
        </div>

        <div className="flex flex-col items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button 
            onClick={handleToggleSave}
            className="w-12 h-12 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md transition-transform active:scale-90"
          >
            <Bookmark className={cn("w-6 h-6 transition-colors", clip.isSaved ? "fill-primary text-primary" : "text-white")} />
          </button>
        </div>

        <div className="flex flex-col items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button className="w-12 h-12 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md transition-transform active:scale-90">
            <Share className="w-6 h-6 text-white" />
          </button>
        </div>
      </div>

      {/* Bottom Info */}
      <div className="absolute bottom-24 left-4 right-20 text-white pointer-events-auto">
        <div className="bg-primary text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase inline-block mb-2">
          {clip.momentLabel}
        </div>
        <h2 className="text-xl font-bold mb-1 shadow-black drop-shadow-md">{clip.fieldName || "Local Pitch"}</h2>
        <p className="text-white/80 text-sm mb-3 shadow-black drop-shadow-md">{clip.court || "Court 1"} • {clip.date || "Recent"}</p>
        
        {clip.playerTags && clip.playerTags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {clip.playerTags.map((tag) => (
              <span key={tag} className="text-xs bg-white/20 backdrop-blur-md px-2.5 py-1 rounded-full border border-white/10 font-medium">
                @{tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CrownIcon(props: any) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinelinejoin="round" {...props}>
      <path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14" />
    </svg>
  );
}
