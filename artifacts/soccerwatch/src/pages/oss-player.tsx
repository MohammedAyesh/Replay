import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { loadOSSVideo } from "@/lib/fc";
import { ChevronLeft, Volume2, VolumeX } from "lucide-react";

export default function OSSPlayer() {
  const [, navigate] = useLocation();
  const video = loadOSSVideo();

  const videoRef = useRef<HTMLVideoElement>(null);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(true);

  useEffect(() => {
    if (!video) navigate("/fields");
  }, []);

  if (!video) return null;

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

  return (
    <div
      className="relative w-full h-[100dvh] bg-black overflow-hidden"
      onClick={togglePlay}
    >
      <video
        ref={videoRef}
        src={video.url}
        className="absolute inset-0 w-full h-full object-contain"
        playsInline
        autoPlay
        muted={isMuted}
        controls={false}
      />

      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/80 pointer-events-none" />

      {/* Top bar */}
      <div className="absolute top-safe pt-4 px-4 w-full flex justify-between items-start pointer-events-auto z-10">
        <button
          onClick={(e) => { e.stopPropagation(); navigate("~"); }}
          className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white backdrop-blur-md"
        >
          <ChevronLeft className="w-6 h-6 ml-[-2px]" />
        </button>
        <button
          onClick={toggleMute}
          className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white backdrop-blur-md"
        >
          {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </button>
      </div>

      {/* Bottom info */}
      <div className="absolute bottom-safe w-full px-6 pb-8 pointer-events-none z-10">
        <div className="bg-primary text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase inline-block mb-2 shadow-sm">
          {video.camera}
        </div>
        <h2 className="text-xl font-bold text-white mb-1 drop-shadow-md line-clamp-2">
          {video.filename}
        </h2>
        <p className="text-white/70 text-sm drop-shadow-md">
          {video.date}
        </p>
      </div>

      {/* Pause indicator */}
      {!isPlaying && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="w-20 h-20 bg-black/50 rounded-full flex items-center justify-center backdrop-blur-sm">
            <div className="w-0 h-0 border-t-[14px] border-b-[14px] border-l-[24px] border-t-transparent border-b-transparent border-l-white ml-2" />
          </div>
        </div>
      )}
    </div>
  );
}
