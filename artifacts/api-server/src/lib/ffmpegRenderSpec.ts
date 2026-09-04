/**
 * The encoded stream contract shared by the main clip render, normalized
 * intros, and pre-built end cards. Stream-copy concatenation is only safe when
 * every one of these values matches.
 */
export const CLIP_RENDER_ENCODER = {
  videoCodec: "libx264",
  videoPreset: "veryfast",
  videoCrf: 23,
  pixelFormat: "yuv420p",
  frameRate: 30,
  frameRateMode: "cfr",
  audioCodec: "aac",
  audioBitrate: "128k",
  audioSampleRate: 44100,
  audioChannels: 2,
} as const;

export function clipVideoEncoderArgs(): string[] {
  return [
    "-c:v", CLIP_RENDER_ENCODER.videoCodec,
    "-preset", CLIP_RENDER_ENCODER.videoPreset,
    "-crf", String(CLIP_RENDER_ENCODER.videoCrf),
    "-pix_fmt", CLIP_RENDER_ENCODER.pixelFormat,
    "-r", String(CLIP_RENDER_ENCODER.frameRate),
    "-fps_mode", CLIP_RENDER_ENCODER.frameRateMode,
  ];
}

export function clipAudioEncoderArgs(): string[] {
  return [
    "-c:a", CLIP_RENDER_ENCODER.audioCodec,
    "-b:a", CLIP_RENDER_ENCODER.audioBitrate,
    "-ar", String(CLIP_RENDER_ENCODER.audioSampleRate),
    "-ac", String(CLIP_RENDER_ENCODER.audioChannels),
  ];
}