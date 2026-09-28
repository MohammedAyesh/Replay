import { useEffect, useState } from "react";
import SoccerWatchDemo, { type DemoClip } from "@/pages/demo";
import { fetchLiveSource, type LiveSource } from "@/lib/liveSource";

const SAMPLE_VIDEO_URL = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

interface PublicDemoFeed {
  panorama: DemoClip | null;
  clips: DemoClip[];
}

async function fetchPublicDemoFeed(): Promise<PublicDemoFeed> {
  const response = await fetch(`${basePath}/api/demo/media`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load demo media (${response.status})`);
  return response.json() as Promise<PublicDemoFeed>;
}

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
      fetchPublicDemoFeed(),
      fetchLiveSource("camera1", "hls"),
      fetchLiveSource("camera2", "hls"),
    ]).then((results) => {
      if (cancelled) return;

      const mediaFeed = results[0].status === "fulfilled" ? results[0].value : null;
      const recordedClips: DemoClip[] = (mediaFeed?.clips ?? []).map((clip) => ({
        ...clip,
        title: undefined,
        label: undefined,
        isSample: false,
      }));
      const liveClips: DemoClip[] = results.slice(1).flatMap((result, index) => {
        if (result.status !== "fulfilled") return [];
        const source = result.value as LiveSource;
        if (!source.proxyUrl) return [];
        return [{
          id: source.camera,
          duration: formatDuration(source.status.dvrSeconds),
          src: source.proxyUrl,
          rawSrc: source.url,
          isSample: false,
        }];
      });
      const uniqueClips = new Map<string, DemoClip>();
      for (const clip of [...recordedClips, ...liveClips]) {
        if (!uniqueClips.has(String(clip.id))) uniqueClips.set(String(clip.id), clip);
      }
      const realClips = [...uniqueClips.values()];

      if (realClips.length > 0) {
        setClips(realClips);
      } else {
        setClips([{
          id: "public-sample",
          src: SAMPLE_VIDEO_URL,
          duration: "00:18",
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