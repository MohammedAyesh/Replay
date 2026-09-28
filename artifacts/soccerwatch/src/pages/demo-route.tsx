import { useEffect, useState } from "react";
import SoccerWatchDemo, { type DemoClip } from "@/pages/demo";

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

interface PublicDemoFeed {
  panorama: DemoClip | null;
  clips: Array<DemoClip & { date?: string; timeSlot?: string }>;
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
  const [panorama, setPanorama] = useState<DemoClip>();
  const [clips, setClips] = useState<DemoClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [mediaError, setMediaError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void fetchPublicDemoFeed()
      .then((feed) => {
        if (cancelled) return;
        setPanorama(feed.panorama ?? undefined);
        setClips((feed.clips ?? [])
          .filter((clip) => clip.src || clip.rawSrc)
          .map((clip) => ({
            ...clip,
            duration: clip.duration ?? (
              Number.isFinite(clip.startTime) && Number.isFinite(clip.endTime)
                ? formatDuration((clip.endTime ?? 0) - (clip.startTime ?? 0))
                : undefined
            ),
            timestamp: clip.timestamp ?? [
              clip.date,
              Number.isFinite(clip.startTime) ? formatDuration(clip.startTime ?? 0) : null,
            ].filter(Boolean).join(" · "),
          })));
        setMediaError(null);
      })
      .catch((error: Error) => {
        if (!cancelled) setMediaError(error.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {mediaError && (
        <p role="alert" data-testid="alert-demo-media" className="mx-auto max-w-[920px] bg-red-950 px-4 py-3 text-sm text-white">
          Could not load Jordan Galaxy footage: {mediaError}
        </p>
      )}
      <SoccerWatchDemo
        panorama={panorama}
        clips={clips}
        isClipsLoading={loading}
        onOpenClaim={() => {
          window.open("/claim/demo", "_blank", "noopener,noreferrer");
        }}
      />
    </>
  );
}