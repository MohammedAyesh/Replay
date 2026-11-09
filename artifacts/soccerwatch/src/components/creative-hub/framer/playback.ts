import type { CreativePlaybackSource } from "@/lib/creative-hub-media";

export type FramerPlaybackEngine = "native-hls" | "hls.js" | "mms";
export type FramerPlaybackSourceType = "camera-4k-window" | "camera-4k-full" | "stream";
export type InitialSeekAction = "wait" | "seek" | "ready";

export function framerPlaybackEngine(hlsSupported: boolean, managedMediaSource: boolean): FramerPlaybackEngine {
  if (!hlsSupported) return "native-hls";
  return managedMediaSource ? "mms" : "hls.js";
}

/**
 * Native HLS cannot read the window-start response header. Use the full
 * camera playlist there so its media timeline remains the recording timeline;
 * hls.js/MMS can use the bounded playlist and its explicit offset header.
 */
export function resolveFramerPlaybackSource(
  source: CreativePlaybackSource,
  engine: FramerPlaybackEngine,
): { url: string; sourceType: FramerPlaybackSourceType } | null {
  if (source.kind === "stream") return { url: source.url, sourceType: "stream" };
  if (engine === "native-hls") {
    return source.fullUrl ? { url: source.fullUrl, sourceType: "camera-4k-full" } : null;
  }
  return { url: source.url, sourceType: "camera-4k-window" };
}

export function framerSourceKey(
  engine: FramerPlaybackEngine,
  sourceType: FramerPlaybackSourceType,
  url: string,
): string {
  return `${engine}|${sourceType}|${url}`;
}

export function initialSeekAction(input: {
  sourceKey: string | null;
  completedSourceKey: string | null;
  offsetReady: boolean;
  duration: number;
  target: number;
  currentTime: number;
  seeking: boolean;
}): InitialSeekAction {
  if (!input.sourceKey || !input.offsetReady) return "wait";
  if (input.completedSourceKey === input.sourceKey) return input.seeking ? "wait" : "ready";
  if (!Number.isFinite(input.duration) || input.duration <= 0 || input.target > input.duration - 0.1) return "wait";
  return Math.abs(input.currentTime - input.target) > 0.5 ? "seek" : "ready";
}
