import type { RecordingViewInput, RecordingWatchTimeInput } from "@workspace/api-client-react";

export interface RecordingViewSource {
  id: number;
  fieldId: number;
  videoUrl: string;
}

export function getRecordingViewInput(recording: RecordingViewSource | null | undefined): RecordingViewInput | null {
  if (
    !recording
    || !Number.isSafeInteger(recording.id)
    || recording.id < 1
    || !Number.isSafeInteger(recording.fieldId)
    || recording.fieldId < 1
  ) {
    return null;
  }

  try {
    const pathname = new URL(recording.videoUrl).pathname;
    if (!pathname.toLowerCase().endsWith(".m3u8")) return null;
    const videoId = pathname.split("/").filter(Boolean)[0];
    if (!videoId || videoId.startsWith("live:") || videoId.length > 128) return null;
    return { fieldId: recording.fieldId, videoId };
  } catch {
    return null;
  }
}

export function createRecordingViewCallbacks(
  input: RecordingViewInput | null,
  recordView: (input: RecordingViewInput) => void,
  recordWatchTime: (input: RecordingWatchTimeInput) => void,
) {
  let pendingSeconds = 0;

  const flush = () => {
    if (!input) {
      pendingSeconds = 0;
      return;
    }
    const seconds = Math.floor(pendingSeconds);
    if (seconds > 0) {
      const amount = Math.min(30, seconds);
      pendingSeconds -= amount;
      recordWatchTime({ ...input, seconds: amount });
    }
  };

  return {
    onPlaybackStart: () => {
      if (input) recordView(input);
    },
    onPlaybackProgress: (seconds: number) => {
      if (!input || !Number.isFinite(seconds) || seconds <= 0) return;
      pendingSeconds += seconds;
      while (pendingSeconds >= 10) {
        const amount = Math.min(30, Math.floor(pendingSeconds));
        pendingSeconds -= amount;
        recordWatchTime({ ...input, seconds: amount });
      }
    },
    flush,
  };
}
