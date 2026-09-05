import { useEffect, useState } from "react";
import { Radio } from "lucide-react";
import { HlsPlayer } from "@/components/HlsPlayer";
import { fetchLiveSource, nextPollMs, type LiveSource } from "@/lib/liveSource";

const CAMERAS = [
  { id: "camera1", label: "Camera 1" },
  { id: "camera2", label: "Camera 2" },
];

/**
 * One camera, played from the CDN.
 *
 * The url comes from the server rather than being built here, because the
 * server is also the only thing that knows whether there is anything at the
 * other end of it. When no camera is pushing, the origin keeps serving the
 * playlist it last wrote — so the player attaches happily to a frame that is
 * days old and the viewer gets a spinner with no explanation. Asking for the
 * source and thestatus together is what turns that into a sentence.
 */
function LiveCamera({ id, label }: { id: string; label: string }) {
  const [source, setSource] = useState<LiveSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const next = await fetchLiveSource(id);
        if (cancelled) return;
        setSource(next);
        setError(null);
        timer = setTimeout(poll, nextPollMs(next.status));
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        timer = setTimeout(poll, nextPollMs(null));
      }
    };

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id]);

  if (error) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <p className="text-white text-sm font-semibold">{label}</p>
        <p className="text-zinc-500 text-xs mt-1">{error}</p>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <p className="text-white text-sm font-semibold">{label}</p>
        <p className="text-zinc-500 text-xs mt-1">Checking…</p>
      </div>
    );
  }

  if (!source.status.live) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
          <p className="text-white text-sm font-semibold">{label}</p>
        </div>
        <p className="text-zinc-400 text-xs mt-1.5">{source.message ?? "No live feed."}</p>
        <p className="text-zinc-600 text-xs mt-1">Checking again every 15 seconds.</p>
      </div>
    );
  }

  return <HlsPlayer key={source.url} url={source.url} label={label} retryOnNetworkError />;
}

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
          <LiveCamera key={cam.id} id={cam.id} label={cam.label} />
        ))}
      </div>
    </div>
  );
}
