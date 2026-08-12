import React from "react";
import { Radio } from "lucide-react";
import { HlsPlayer } from "@/components/HlsPlayer";

const LIVE_PLAYBACK_BASE = "/api/live";

const CAMERAS = [
  { id: "camera1", label: "Camera 1" },
  { id: "camera2", label: "Camera 2" },
];

export default function Live() {
  return (
    <div className="flex-1 overflow-y-auto no-scrollbar bg-background">
      <div className="px-4 pt-6 pb-4 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Radio className="w-5 h-5 text-red-500" />
          <h1 className="text-white text-xl font-bold">Live</h1>
        </div>
      </div>

      <div className="px-4 pb-8 space-y-4">
        {CAMERAS.map((cam) => (
          <HlsPlayer
            key={cam.id}
            url={`${LIVE_PLAYBACK_BASE}/${cam.id}/index.m3u8`}
            label={cam.label}
          />
        ))}
      </div>
    </div>
  );
}
