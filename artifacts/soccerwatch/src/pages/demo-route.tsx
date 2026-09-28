import { useEffect, useState } from "react";
import SoccerWatchDemo, { type DemoClip } from "@/pages/demo";
import { fetchLiveSource } from "@/lib/liveSource";

const SAMPLE_VIDEO_URL = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export default function DemoRoute() {
  const [clips, setClips] = useState<DemoClip[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void Promise.allSettled([
      fetchLiveSource("camera1", "hls"),
      fetchLiveSource("camera2", "hls"),
    ]).then((results) => {
      if (cancelled) return;

      const realClips: DemoClip[] = results.flatMap((result, index) => {
        if (result.status !== "fulfilled") return [];
        const source = result.value;
        if (!source.proxyUrl) return [];
        const cameraNumber = index + 1;
        return [{
          id: source.camera,
          title: `Camera ${cameraNumber}`,
          label: `Camera ${cameraNumber}`,
          timestamp: source.status.liveEdgeAt ?? undefined,
          duration: formatDuration(source.status.dvrSeconds),
          src: source.proxyUrl,
          rawSrc: source.url,
          sourceLabel: "recorded",
          isSample: false,
        }];
      });

      if (realClips.length > 0) {
        setClips(realClips);
      } else {
        setClips([{
          id: "public-sample",
          label: "sample",
          src: SAMPLE_VIDEO_URL,
          duration: "00:18",
          sourceLabel: "sample",
          isSample: true,
        }]);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SoccerWatchDemo
      clips={clips}
      isClipsLoading={loading}
      onOpenClaim={() => {
        window.open("/claim/demo", "_blank", "noopener,noreferrer");
      }}
    />
  );
}