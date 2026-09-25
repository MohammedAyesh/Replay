export const FRAME_DURATION_SECONDS = 0.05;
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1] as const;

export function playbackSpeedForKey(key: string): number | null {
  if (key === "1") return PLAYBACK_SPEEDS[0];
  if (key === "2") return PLAYBACK_SPEEDS[1];
  if (key === "3") return PLAYBACK_SPEEDS[2];
  return null;
}

export function playbackStepForKey(key: string, shiftKey: boolean): number | null {
  if (key === "ArrowLeft") return shiftKey ? -1 : -FRAME_DURATION_SECONDS;
  if (key === "ArrowRight") return shiftKey ? 1 : FRAME_DURATION_SECONDS;
  if (key === ",") return -2 * FRAME_DURATION_SECONDS;
  if (key === ".") return 2 * FRAME_DURATION_SECONDS;
  return null;
}