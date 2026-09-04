import { spawn } from "child_process";
import { logger } from "./logger";
import { cropRectAt } from "./ffmpegExport";
import { EXPORT_SOURCE_WIDTH, EXPORT_SOURCE_HEIGHT } from "./exportSource";
import { BUNNY_STORAGE_API_KEY, isBunnyStorageUrl } from "./bunny";

/**
 * Poster frames for share cards.
 *
 * A shared link is the cheapest acquisition channel this product has, and the
 * card WhatsApp draws for it is decided entirely by four `og:` tags and one JPEG.
 * Three specific things about this system make that JPEG harder than it sounds,
 * and each one is a line of code below:
 *
 *  1. Bunny's own poster is the SOURCE video's, and `thumbnail.jpg?time=` is
 *     ignored. So the poster has to be generated here; there is nothing to ask
 *     Bunny for.
 *  2. The source is an hour-long 3840x1080 panorama and the clip is a moving
 *     window inside it. A frame of the whole panorama is not what the clip
 *     shows — it is 32:9 of mostly empty pitch. The poster has to be the crop.
 *  3. An hour of archive routinely opens on black, and a clip cut near the top of
 *     an hour therefore produces a black tile. Taking "the midpoint frame" and
 *     trusting it is how you ship a share card that is a black rectangle.
 *
 * So: sample a few frames around the midpoint at thumbnail size, score them,
 * and encode the best one. The scoring pass is four seeks at 64x36 — cheap
 * enough that the whole thing stays sub-second, which is what lets it run
 * inline on the share request.
 */

/**
 * 1200x630 is the large-card shape (1.91:1). It is not the clip's aspect ratio,
 * and that is deliberate: WhatsApp and Twitter fall back to the small square
 * thumbnail for images that are near-square or tall, which is the single
 * biggest difference between a link that gets tapped and one that does not.
 * A 9:16 clip is letterboxed onto a blurred copy of its own frame rather than
 * cropped to 1.91:1, which would throw away the player.
 */
export const POSTER_WIDTH = 1200;
export const POSTER_HEIGHT = 630;
const POSTER_ASPECT = POSTER_WIDTH / POSTER_HEIGHT;

/** Score at which the search stops looking for a better frame. */
export const GOOD_ENOUGH_SCORE = 24;

/** Aspect ratio below which covering would crop away the subject. */
const COVER_ASPECT_FLOOR = POSTER_ASPECT / 1.35;

/** Size of the scoring thumbnails. Small enough that stats cost nothing. */
export const SCORE_W = 64;
export const SCORE_H = 36;

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const POSTER_TIMEOUT_MS = Math.max(
  5_000,
  parseInt(process.env.POSTER_TIMEOUT_MS ?? "45000", 10) || 45_000,
);

export interface FrameStats {
  /** Mean luma, 0-255. */
  mean: number;
  /** Standard deviation of luma — how much is going on in the frame. */
  stddev: number;
}

/** Luma mean and standard deviation of a raw 8-bit grayscale frame. */
export function frameStats(gray: Uint8Array): FrameStats {
  if (gray.length === 0) return { mean: 0, stddev: 0 };
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i]!;
  const mean = sum / gray.length;
  let acc = 0;
  for (let i = 0; i < gray.length; i++) {
    const d = gray[i]! - mean;
    acc += d * d;
  }
  return { mean, stddev: Math.sqrt(acc / gray.length) };
}

/**
 * How good a share card this frame would make. Higher is better; 0 means
 * unusable.
 *
 * THE THRESHOLDS ARE MEASURED, NOT CHOSEN.
 *
 * The obvious rule — "a black frame has mean luma 0" — is wrong on real video,
 * and getting it wrong here is exactly the bug this module exists to prevent.
 * H.264 encodes black at limited-range Y=16, and decoding that through
 * `format=gray` gives, measured on a `color=c=black` clip encoded exactly the
 * way the archive encodes:
 *
 *     black frame    mean 6.611   stddev 1.603   (range 0..7)
 *     testsrc2 frame mean 128.5   stddev 79.7    (range 23..235)
 *
 * A `mean < 6` floor would have passed that black frame as usable. The floor is
 * therefore 12, comfortably above the measured value and far below anything with
 * content in it.
 *
 * The second rule catches what a luma floor cannot: a flat mid-grey — a lens cap,
 * a fogged dome, a solid colour card — has a perfectly respectable mean and no
 * content whatsoever. Under ~3 units of spread there is nothing in the frame.
 *
 * Detail (stddev) is then the score itself, because a pitch with players on it
 * has plenty and a fade has almost none. Mean luma only ever rules frames out,
 * never in: a legitimately dark night frame under floodlights has low mean and
 * high stddev, and scoring by brightness would throw away every night match.
 */
export const BLACK_LUMA_FLOOR = 12;
export const BLOWN_LUMA_CEILING = 244;
export const FLAT_FRAME_STDDEV = 3;

export function scoreFrame(stats: FrameStats): number {
  if (stats.mean < BLACK_LUMA_FLOOR) return 0;      // black, measured at 6.611
  if (stats.mean > BLOWN_LUMA_CEILING) return 0;    // blown out
  if (stats.stddev < FLAT_FRAME_STDDEV) return 0;   // flat: lens cap, colour card
  const midtoneBonus = 1 - Math.abs(stats.mean - 128) / 255;
  return stats.stddev * (0.6 + 0.4 * midtoneBonus);
}

/**
 * Where to sample, in clip-relative seconds, most-preferred first.
 *
 * The midpoint leads because it is what the brief asks for and is usually right.
 * The rest walk outwards from it and stay clear of the first and last moments,
 * which is where fades, cuts and the black head of an archive hour live.
 */
export function posterCandidateTimes(
  startSec: number,
  endSec: number,
  count = 4,
): number[] {
  const duration = Math.max(0, endSec - startSec);
  if (duration <= 0) return [startSec];
  const mid = startSec + duration / 2;
  const offsets = [0, 0.18, -0.18, 0.32, -0.32, 0.42];
  const lo = startSec + Math.min(1, duration * 0.08);
  const hi = endSec - Math.min(1, duration * 0.08);

  const out: number[] = [];
  for (const o of offsets) {
    if (out.length >= count) break;
    const t = Math.min(hi, Math.max(lo, mid + o * duration));
    if (!out.some((existing) => Math.abs(existing - t) < 0.25)) out.push(t);
  }
  return out.length ? out : [mid];
}

export interface PosterFilter {
  filter: string;
  /** True when the filter has labelled pads and needs -filter_complex. */
  complex: boolean;
}

/**
 * The filter chain that turns a source frame into a 1200x630 card.
 *
 * Wide crops (a 16:9 clip out of the panorama) are scaled to cover and trimmed.
 * Tall or square crops are scaled to fit on a blurred, darkened copy of
 * themselves — the standard treatment, and the only one that keeps a 9:16 clip's
 * subject on the card at all.
 */
export function buildPosterFilter(
  crop: CropRect | null | undefined,
  outW = POSTER_WIDTH,
  outH = POSTER_HEIGHT,
  /** Frame aspect when there is no crop — the source's own. Defaults to 16:9. */
  sourceAspect = 16 / 9,
): PosterFilter {
  const c = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "";
  const aspect = crop ? crop.w / crop.h : sourceAspect;

  if (aspect >= COVER_ASPECT_FLOOR) {
    return {
      complex: false,
      filter: `${c}scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1`,
    };
  }

  return {
    complex: true,
    filter:
      `[0:v]${c}split=2[fg][bg];` +
      `[bg]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},` +
      `gblur=sigma=30,eq=brightness=-0.2[bgb];` +
      `[fg]scale=-2:${outH}[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:0,setsar=1[out]`,
  };
}

/** Spawn a process and collect stdout as bytes. `run` in ffmpegExport decodes
 *  stdout as UTF-8, which silently mangles a JPEG. */
function runBinary(bin: string, args: string[], timeoutMs = POSTER_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    const chunks: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8000); });
    const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`${bin} exited with ${code}: ${stderr.slice(-800)}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Headers FFmpeg should send when reading the poster source.
 *
 * Two different origins are in play and they want different things. The pinned
 * HLS variant lives on the Stream pull zone, which rejects a request with no
 * Referer (measured: 403). The rendered export lives on the Storage pull zone,
 * which wants the AccessKey — the same key `/user-clips/:id/download` sends to
 * that exact URL. Omitting it is why a poster taken from the export can fail
 * while the download of the same file succeeds.
 */
function headerArgs(url: string, referer?: string): string[] {
  const lines = [
    referer ? `Referer: ${referer}` : null,
    BUNNY_STORAGE_API_KEY && isBunnyStorageUrl(url) ? `AccessKey: ${BUNNY_STORAGE_API_KEY}` : null,
  ].filter((v): v is string => !!v);
  return lines.length ? ["-headers", `${lines.join("\r\n")}\r\n`] : [];
}

/**
 * Seek arguments.
 *
 * `-ss` before `-i` is the fast path — the demuxer seeks the file or the HLS
 * index rather than decoding forward to the timestamp — and for a single still
 * frame its keyframe-granularity imprecision does not matter. This is what keeps
 * a poster sub-second against an hour-long source.
 */
function seekArgs(atSec: number): string[] {
  return ["-ss", Math.max(0, atSec).toFixed(3)];
}

export interface CropRect { x: number; y: number; w: number; h: number }

export interface PosterSourceOptions {
  /**
   * What to take the frame from. Two sources are legitimate and the caller picks:
   *
   *  - the rendered export MP4, when one exists. It is already cropped, branded
   *    and small, so this is both cheaper and a truer preview of what the viewer
   *    will actually watch. `crop` is null on this path.
   *  - the resolution-pinned source variant from selectExportSource, when the
   *    export is not ready. 3840x1080 of mostly-empty panorama, so `crop` must
   *    be supplied or the card shows the wrong part of the pitch.
   */
  sourceUrl: string;
  referer?: string;
  /** Source-pixel rectangle to take, or null to use the whole frame. */
  crop?: CropRect | null;
}

/** `crop=...,` prefix, or nothing when the frame is already the right region. */
function cropClause(crop?: CropRect | null): string {
  return crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "";
}

/** Grayscale thumbnail of one frame, for scoring. */
export async function sampleFrameStats(
  options: PosterSourceOptions & { atSec: number },
): Promise<FrameStats> {
  const { sourceUrl, referer, crop, atSec } = options;
  const raw = await runBinary(FFMPEG, [
    "-nostdin", "-loglevel", "error",
    ...headerArgs(sourceUrl, referer),
    ...seekArgs(atSec),
    "-i", sourceUrl,
    "-frames:v", "1",
    "-vf", `${cropClause(crop)}scale=${SCORE_W}:${SCORE_H},format=gray`,
    "-f", "rawvideo", "-",
  ]);
  return frameStats(raw);
}

/** Encode one frame as the finished 1200x630 JPEG. */
export async function encodePosterFrame(
  options: PosterSourceOptions & { atSec: number; quality?: number; sourceAspect?: number },
): Promise<Buffer> {
  const { sourceUrl, referer, crop, atSec } = options;
  const { filter, complex } = buildPosterFilter(
    crop, POSTER_WIDTH, POSTER_HEIGHT, options.sourceAspect ?? 16 / 9,
  );
  const filterArgs = complex
    ? ["-filter_complex", filter, "-map", "[out]"]
    : ["-vf", filter];

  return runBinary(FFMPEG, [
    "-nostdin", "-loglevel", "error",
    ...headerArgs(sourceUrl, referer),
    ...seekArgs(atSec),
    "-i", sourceUrl,
    "-frames:v", "1",
    ...filterArgs,
    "-q:v", String(options.quality ?? 3),
    "-f", "mjpeg", "-",
  ]);
}

export interface PosterResult {
  buffer: Buffer;
  width: number;
  height: number;
  /** Absolute position in the source video the poster was taken from. */
  atSec: number;
  /** Every candidate that was scored, in the order they were tried. */
  candidates: { atSec: number; stats: FrameStats; score: number }[];
  /**
   * True when every candidate scored 0 and the first was used anyway. The
   * poster is probably black; the caller should still publish it (a card with a
   * dark image beats no card) but it is worth a log line.
   */
  degraded: boolean;
}

/**
 * Generate a clip's poster: pick the crop at the clip midpoint, score a handful
 * of frames around it, and encode the best.
 *
 * `startSec`/`endSec` are absolute positions in the source video, not clip
 * fractions, so this does not need the recording duration.
 */
export async function generatePosterFrame(options: {
  sourceUrl: string;
  referer?: string;
  /** Absolute positions in the source, in seconds. */
  startSec: number;
  endSec: number;
  /** Source-pixel rectangle, or null when the source is already the clip. */
  crop?: CropRect | null;
  /** Frame aspect when crop is null. */
  sourceAspect?: number;
  candidateCount?: number;
}): Promise<PosterResult> {
  const { sourceUrl, referer, startSec, endSec, crop } = options;
  const times = posterCandidateTimes(startSec, endSec, options.candidateCount ?? 4);

  const candidates: PosterResult["candidates"] = [];
  for (const atSec of times) {
    try {
      const stats = await sampleFrameStats({ sourceUrl, referer, crop, atSec });
      const score = scoreFrame(stats);
      candidates.push({ atSec, stats, score });
      // A clearly good frame ends the search — no reason to pay for three more
      // seeks once the midpoint has turned out to be fine, which it usually has.
      if (score >= GOOD_ENOUGH_SCORE) break;
    } catch (err) {
      logger.warn({ err, atSec }, "Poster candidate could not be sampled");
      candidates.push({ atSec, stats: { mean: 0, stddev: 0 }, score: 0 });
    }
  }

  const best = candidates.reduce(
    (a, b) => (b.score > a.score ? b : a),
    candidates[0] ?? { atSec: times[0]!, stats: { mean: 0, stddev: 0 }, score: 0 },
  );
  const degraded = best.score === 0;
  if (degraded) {
    logger.warn(
      { sourceUrl, startSec, endSec, candidates },
      "Every poster candidate scored zero — the source window is probably black",
    );
  }

  const buffer = await encodePosterFrame({
    sourceUrl, referer, crop, atSec: best.atSec, sourceAspect: options.sourceAspect,
  });
  return {
    buffer,
    width: POSTER_WIDTH,
    height: POSTER_HEIGHT,
    atSec: best.atSec,
    candidates,
    degraded,
  };
}

/**
 * The crop a clip's poster should use when it is taken from the panorama.
 * Sampled once at the clip's midpoint and held for every candidate: re-sampling
 * per candidate would compare frames showing different parts of the pitch, which
 * makes the scores meaningless.
 */
export function posterCropForClip(
  cropPath: { t: number; x: number; y: number; w: number; h: number }[],
  aspectRatio: string,
): CropRect {
  return cropRectAt(cropPath, aspectRatio, 0.5);
}

/** Duration of a media file or URL, in seconds. */
export async function probeDuration(sourceUrl: string, referer?: string): Promise<number> {
  const args = [
    "-v", "error",
    ...headerArgs(sourceUrl, referer),
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    sourceUrl,
  ];
  const out = (await runBinary(process.env.FFPROBE_PATH ?? "ffprobe", args)).toString().trim();
  const seconds = Number.parseFloat(out.split(/\s+/)[0] ?? "");
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Could not read a duration from ${sourceUrl}: ${JSON.stringify(out)}`);
  }
  return seconds;
}

/** Where a clip's poster lives in Bunny Storage. */
export function posterStoragePath(clipId: number, token: string): string {
  return `posters/${clipId}-${token}.jpg`;
}

export const POSTER_SOURCE_WIDTH = EXPORT_SOURCE_WIDTH;
export const POSTER_SOURCE_HEIGHT = EXPORT_SOURCE_HEIGHT;
