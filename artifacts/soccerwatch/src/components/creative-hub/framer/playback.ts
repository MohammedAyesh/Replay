export type FramerPlaybackEngine = "native-hls" | "hls.js" | "mms";
export type FramerPlaybackSourceType = "camera-4k" | "stream";
export type InitialSeekAction = "wait" | "seek" | "ready";

export function framerPlaybackEngine(hlsSupported: boolean, managedMediaSource: boolean): FramerPlaybackEngine {
  if (!hlsSupported) return "native-hls";
  return managedMediaSource ? "mms" : "hls.js";
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
  duration: number;
  target: number;
  currentTime: number;
  seeking: boolean;
}): InitialSeekAction {
  if (!input.sourceKey) return "wait";
  if (input.completedSourceKey === input.sourceKey) return input.seeking ? "wait" : "ready";
  if (!Number.isFinite(input.duration) || input.duration <= 0) return "wait";
  return Math.abs(input.currentTime - input.target) > 0.5 ? "seek" : "ready";
}
