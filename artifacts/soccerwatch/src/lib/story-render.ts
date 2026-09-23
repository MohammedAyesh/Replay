/**
 * 9:16 story renderer: turns an exported clip MP4 into a branded 1080×1920 story
 * video in the browser (the same pipeline as the Story Studio prototype).
 *
 * WebCodecs H.264 + AAC into a faststart MP4, frames stepped by seeking so the
 * timing is exact regardless of how fast the device renders. Audio is decoded
 * from the source file. mp4-muxer is loaded on demand from jsDelivr so it adds
 * nothing to the app bundle.
 */

export type StoryInput = {
  videoBlob: Blob;
  playerName: string;
  shirtNumber?: number | null;
  avatarUrl?: string | null;
  teamColor?: string | null;
  fieldName: string;
  dateLabel: string;
  title?: string | null;
  matchCode?: string | null;
  score?: { a: number; b: number } | null;
  locale: "en" | "ar";
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

export type StoryResult = { blob: Blob; mime: string; seconds: number };

const W = 1080;
const H = 1920;
const FPS = 30;
const END_HOLD = 2.2;
const C = {
  void: "#0B0F1A",
  surface: "#141B2C",
  raised: "#1B2338",
  line: "#232C42",
  text: "#F2F4F8",
  muted: "#8A93A6",
  flood: "#D4FF4F",
  violet: "#7B5CFF",
  turf: "#2FD8C4",
};

type MuxerModule = {
  Muxer: new (opts: Record<string, unknown>) => {
    addVideoChunk: (c: EncodedVideoChunk, m?: EncodedVideoChunkMetadata) => void;
    addAudioChunk: (c: EncodedAudioChunk, m?: EncodedAudioChunkMetadata) => void;
    finalize: () => void;
  };
  ArrayBufferTarget: new () => { buffer: ArrayBuffer };
};

let muxerPromise: Promise<MuxerModule> | null = null;
function loadMuxer(): Promise<MuxerModule> {
  const url = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm";
  muxerPromise ??= import(/* @vite-ignore */ url) as Promise<MuxerModule>;
  return muxerPromise;
}

export function canRenderStory(): boolean {
  return typeof window !== "undefined" && "VideoEncoder" in window && "VideoFrame" in window;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    const timer = window.setTimeout(() => reject(new Error("The clip took too long to open")), 20_000);
    v.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("The clip could not be read"));
    };
    v.onloadeddata = async () => {
      // Some recorders write no duration (Infinity): seek far ahead once to learn it.
      if (!Number.isFinite(v.duration)) {
        await new Promise<void>((r) => {
          const done = () => {
            v.removeEventListener("durationchange", check);
            r();
          };
          const check = () => {
            if (Number.isFinite(v.duration)) done();
          };
          v.addEventListener("durationchange", check);
          v.currentTime = 1e7;
          window.setTimeout(done, 5000);
        });
        v.currentTime = 0;
      }
      window.clearTimeout(timer);
      resolve(v);
    };
    v.src = url;
  });
}

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return resolve();
    const done = () => {
      v.removeEventListener("seeked", done);
      resolve();
    };
    v.addEventListener("seeked", done);
    v.currentTime = t;
    window.setTimeout(done, 3000);
  });
}

async function pickVideoConfig(): Promise<VideoEncoderConfig | null> {
  for (const codec of ["avc1.640028", "avc1.4D0028", "avc1.420028"]) {
    const cfg: VideoEncoderConfig = { codec, width: W, height: H, bitrate: 8_000_000, framerate: FPS, avc: { format: "avc" } };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return r.config ?? cfg;
    } catch {
      /* try the next profile */
    }
  }
  return null;
}

async function pickAudioConfig(sampleRate: number): Promise<AudioEncoderConfig | null> {
  if (!("AudioEncoder" in window)) return null;
  const cfg: AudioEncoderConfig = { codec: "mp4a.40.2", sampleRate, numberOfChannels: 2, bitrate: 128_000 };
  try {
    const r = await AudioEncoder.isConfigSupported(cfg);
    return r.supported ? r.config ?? cfg : null;
  } catch {
    return null;
  }
}

async function decodeAudio(blob: Blob): Promise<AudioBuffer | null> {
  try {
    const Ctx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    const ctx = new Ctx(2, 48000, 48000);
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function renderStory(input: StoryInput): Promise<StoryResult> {
  if (!canRenderStory()) throw new Error("This browser can't make story videos. Open Replay in Chrome.");
  const [muxerMod, videoCfg] = await Promise.all([loadMuxer(), pickVideoConfig()]);
  if (!videoCfg) throw new Error("This device can't encode H.264 video.");

  const ar = input.locale === "ar";
  const display = ar ? "Cairo" : "Rajdhani";
  await Promise.all([
    document.fonts?.load(`700 64px ${display}`).catch(() => undefined),
    document.fonts?.load("700 40px Rajdhani").catch(() => undefined),
    document.fonts?.load("600 34px Inter").catch(() => undefined),
  ]);

  const url = URL.createObjectURL(input.videoBlob);
  try {
    const video = await loadVideo(url);
    const [mark, avatar, audio] = await Promise.all([
      loadImage("/replay-mark.svg"),
      input.avatarUrl ? loadImage(input.avatarUrl) : Promise.resolve(null),
      decodeAudio(input.videoBlob),
    ]);
    const rawDur = Number.isFinite(video.duration) ? video.duration : 0;
    if (rawDur <= 0) throw new Error("The clip has no length");
    const clipDur = Math.min(120, Math.max(0.5, rawDur));
    const total = clipDur + END_HOLD;
    const nFrames = Math.round(total * FPS);

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;

    // Video box: portrait clips fill the card, landscape clips sit in a band.
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const portrait = vh > vw;
    const box = portrait
      ? { x: 60, y: 300, w: 960, h: 1240 }
      : { x: 40, y: 560, w: 1000, h: Math.round(1000 * (vh / vw)) };

    const accent = input.teamColor && /^#[0-9a-f]{6}$/i.test(input.teamColor) ? input.teamColor : C.turf;
    const dir: CanvasDirection = ar ? "rtl" : "ltr";

    const text = (s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = "center", d: CanvasDirection = dir) => {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.direction = d;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(s, x, y);
    };

    const background = () => {
      ctx.fillStyle = C.void;
      ctx.fillRect(0, 0, W, H);
      let g = ctx.createRadialGradient(W * 0.9, 0, 0, W * 0.9, 0, 900);
      g.addColorStop(0, "rgba(47,216,196,0.22)");
      g.addColorStop(1, "rgba(47,216,196,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      g = ctx.createRadialGradient(0, H, 0, 0, H, 1000);
      g.addColorStop(0, "rgba(123,92,255,0.22)");
      g.addColorStop(1, "rgba(123,92,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    };

    const header = () => {
      if (mark) ctx.drawImage(mark, W / 2 - 150, 92, 64, 58);
      text("REPLAY", W / 2 - 70, 142, "700 52px Rajdhani", C.text, "left", "ltr");
      text(input.title || input.fieldName, W / 2, 240, `700 56px ${display}`, C.text);
      text(`${input.title ? `${input.fieldName} · ` : ""}${input.dateLabel}`, W / 2, 292, "500 32px Inter", C.muted);
    };

    const drawVideoBox = (alpha: number) => {
      ctx.save();
      roundRect(ctx, box.x, box.y, box.w, box.h, 36);
      ctx.clip();
      ctx.fillStyle = C.surface;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.globalAlpha = alpha;
      // cover-fit into the box
      const s = Math.max(box.w / vw, box.h / vh);
      const dw = vw * s;
      const dh = vh * s;
      ctx.drawImage(video, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh);
      ctx.restore();
      ctx.lineWidth = 3;
      ctx.strokeStyle = C.line;
      roundRect(ctx, box.x, box.y, box.w, box.h, 36);
      ctx.stroke();
    };

    const playerChip = (y: number) => {
      const h = 132;
      const x = 60;
      const w = W - 120;
      roundRect(ctx, x, y, w, h, 66);
      ctx.fillStyle = C.surface;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = C.line;
      ctx.stroke();
      const cx = ar ? x + w - 66 : x + 66;
      const cy = y + h / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 48, 0, Math.PI * 2);
      ctx.clip();
      if (avatar) {
        const s = Math.max(96 / avatar.width, 96 / avatar.height);
        ctx.drawImage(avatar, cx - (avatar.width * s) / 2, cy - (avatar.height * s) / 2, avatar.width * s, avatar.height * s);
      } else {
        ctx.fillStyle = C.raised;
        ctx.fillRect(cx - 48, cy - 48, 96, 96);
        const initials = input.playerName.trim().split(/\s+/).slice(0, 2).map((p) => Array.from(p)[0] ?? "").join("").toUpperCase();
        text(initials || "?", cx, cy + 16, "700 44px Rajdhani", C.text, "center", "ltr");
      }
      ctx.restore();
      ctx.lineWidth = 6;
      ctx.strokeStyle = accent;
      ctx.beginPath();
      ctx.arc(cx, cy, 48, 0, Math.PI * 2);
      ctx.stroke();
      const nameX = ar ? cx - 80 : cx + 80;
      text(input.playerName, nameX, cy + 14, `700 50px ${display}`, C.text, ar ? "right" : "left");
      if (input.shirtNumber != null) {
        text(`#${input.shirtNumber}`, ar ? x + 60 : x + w - 60, cy + 16, "700 56px Rajdhani", accent, ar ? "left" : "right", "ltr");
      } else if (input.score) {
        text(`${input.score.a}–${input.score.b}`, ar ? x + 60 : x + w - 60, cy + 16, "700 56px Rajdhani", C.text, ar ? "left" : "right", "ltr");
      }
    };

    const footer = (alpha = 1) => {
      ctx.globalAlpha = alpha * 0.8;
      const link = input.matchCode ? `replayjo.com/m/${input.matchCode}` : "replayjo.com";
      text(link, W / 2, H - 150, "700 36px Rajdhani", C.text, "center", "ltr");
      ctx.globalAlpha = 1;
    };

    const endCard = (p: number) => {
      // p: 0..1 over the first 0.4 s of the hold
      background();
      header();
      const cardY = 620;
      const cardH = 620;
      ctx.globalAlpha = p;
      roundRect(ctx, 80, cardY, W - 160, cardH, 48);
      ctx.fillStyle = C.surface;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = C.line;
      ctx.stroke();
      if (mark) ctx.drawImage(mark, W / 2 - 80, cardY + 70, 160, 145);
      text(ar ? "شوف الماتش كامل" : "Watch the full match", W / 2, cardY + 330, `700 64px ${display}`, C.text);
      text(ar ? "على ريبلاي" : "on Replay", W / 2, cardY + 395, "600 36px Inter", C.muted);
      const pillW = 640;
      roundRect(ctx, W / 2 - pillW / 2, cardY + 450, pillW, 110, 55);
      ctx.fillStyle = C.flood;
      ctx.fill();
      text(input.matchCode ? `replayjo.com/m/${input.matchCode}` : "replayjo.com", W / 2, cardY + 522, "700 44px Rajdhani", C.void, "center", "ltr");
      ctx.globalAlpha = 1;
    };

    const drawFrame = (t: number) => {
      if (t < clipDur) {
        background();
        header();
        drawVideoBox(1);
        playerChip(box.y + box.h + 48);
        footer();
      } else {
        endCard(Math.min(1, (t - clipDur) / 0.4));
      }
    };

    const target = new muxerMod.ArrayBufferTarget();
    const audioCfg = audio ? await pickAudioConfig(audio.sampleRate) : null;
    const muxer = new muxerMod.Muxer({
      target,
      fastStart: "in-memory",
      firstTimestampBehavior: "offset",
      video: { codec: "avc", width: W, height: H, frameRate: FPS },
      audio: audioCfg && audio ? { codec: "aac", numberOfChannels: 2, sampleRate: audio.sampleRate } : undefined,
    });
    let encodeError: unknown = null;

    if (audioCfg && audio) {
      const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { encodeError = e; } });
      aenc.configure(audioCfg);
      const sr = audio.sampleRate;
      const totalSamples = Math.round(total * sr);
      const left = audio.getChannelData(0);
      const right = audio.getChannelData(Math.min(1, audio.numberOfChannels - 1));
      for (let off = 0; off < totalSamples; off += 1024) {
        const n = Math.min(1024, totalSamples - off);
        const data = new Float32Array(2 * n);
        for (let i = 0; i < n; i += 1) {
          const k = off + i;
          data[i] = k < left.length ? left[k] : 0;
          data[n + i] = k < right.length ? right[k] : 0;
        }
        const ad = new AudioData({ format: "f32-planar", sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off / sr) * 1e6), data });
        aenc.encode(ad);
        ad.close();
      }
      await aenc.flush();
      aenc.close();
    }

    const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { encodeError = e; } });
    venc.configure(videoCfg);
    for (let i = 0; i < nFrames; i += 1) {
      if (input.signal?.aborted) throw new DOMException("Stopped", "AbortError");
      if (encodeError) throw encodeError;
      const t = i / FPS;
      if (t < clipDur) await seekTo(video, Math.min(t, Math.max(0, clipDur - 0.04)));
      drawFrame(t);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
      venc.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
      frame.close();
      if (venc.encodeQueueSize > 6) await new Promise((r) => venc.addEventListener("dequeue", r, { once: true }));
      if (i % 10 === 0) {
        input.onProgress?.(i / nFrames);
        await new Promise((r) => window.setTimeout(r, 0));
      }
    }
    await venc.flush();
    venc.close();
    if (encodeError) throw encodeError;
    muxer.finalize();
    input.onProgress?.(1);
    return { blob: new Blob([target.buffer], { type: "video/mp4" }), mime: "video/mp4", seconds: total };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function shareStory(result: StoryResult, filename: string): Promise<"shared" | "downloaded"> {
  const file = new File([result.blob], filename, { type: result.mime });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return "shared";
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(result.blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  return "downloaded";
}
