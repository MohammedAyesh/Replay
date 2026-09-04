import { BUNNY_CDN_HOSTNAME, getBunnyPlaybackUrl } from "./bunny";

export const REQUIRED_SOURCE_WIDTH = 3840;
export const REQUIRED_SOURCE_HEIGHT = 1080;

export type ExportSourcePath =
  | "HEAD-verified direct MP4"
  | "verified HLS variant playlist";

export type HlsVariant = {
  url: string;
  folder: string;
  width: number;
  height: number;
};

export class ExportSourceResolutionError extends Error {
  readonly variants: Array<{ width: number; height: number; url: string }>;

  constructor(variants: Array<{ width: number; height: number; url: string }>) {
    const seen = variants.length > 0
      ? variants.map((variant) => `${variant.width}x${variant.height}`).join(", ")
      : "none";
    super(
      `No export source declares the required ${REQUIRED_SOURCE_WIDTH}x${REQUIRED_SOURCE_HEIGHT} geometry; ` +
      `variants seen: ${seen}`,
    );
    this.name = "ExportSourceResolutionError";
    this.variants = variants;
  }
}

function parseAttributes(value: string): Record<string, string> {
  return Object.fromEntries(
    value.split(/,(?=[A-Z0-9-]+=)/).map((entry) => {
      const separator = entry.indexOf("=");
      return separator < 0
        ? [entry, ""]
        : [entry.slice(0, separator), entry.slice(separator + 1).replace(/^"|"$/g, "")];
    }),
  );
}

function variantFolder(url: string): string {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/\/([^/]+)\/(?:video|playlist)\.m3u8$/i);
  if (!match?.[1]) {
    throw new Error(`Could not determine the rendition folder from HLS variant URL: ${url}`);
  }
  return match[1];
}

export function parseHlsMasterVariants(master: string, masterUrl: string): HlsVariant[] {
  const lines = master.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    const attributes = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
    const [widthText, heightText] = (attributes.RESOLUTION ?? "").split("x");
    const width = Number.parseInt(widthText ?? "", 10);
    const height = Number.parseInt(heightText ?? "", 10);
    const uri = lines
      .slice(index + 1)
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate && !candidate.startsWith("#"));
    if (!uri || !Number.isFinite(width) || !Number.isFinite(height)) continue;

    const url = new URL(uri, masterUrl).href;
    variants.push({ url, folder: variantFolder(url), width, height });
  }
  return variants;
}

export async function selectExportSource(options: {
  videoId: string;
  hasMP4Fallback: boolean;
  referer: string;
}): Promise<{
  url: string;
  path: ExportSourcePath;
  variant: HlsVariant;
}> {
  const { videoId, hasMP4Fallback, referer } = options;
  const masterUrl = getBunnyPlaybackUrl(videoId);
  const masterResponse = await fetch(masterUrl, {
    headers: { Referer: referer },
  });
  if (!masterResponse.ok) {
    throw new Error(`Failed to fetch Bunny master playlist for ${videoId}: HTTP ${masterResponse.status}`);
  }

  const variants = parseHlsMasterVariants(await masterResponse.text(), masterUrl);
  const matchingVariant = variants.find(
    (variant) =>
      variant.width === REQUIRED_SOURCE_WIDTH
      && variant.height === REQUIRED_SOURCE_HEIGHT,
  );
  if (!matchingVariant) {
    throw new ExportSourceResolutionError(
      variants.map(({ width, height, url }) => ({ width, height, url })),
    );
  }

  if (hasMP4Fallback) {
    const directUrl = buildDirectMp4Url(videoId, matchingVariant.folder);
    try {
      const response = await fetch(directUrl, {
        method: "HEAD",
        headers: { Referer: referer },
      });
      if (response.status === 200 || response.status === 206) {
        return { url: directUrl, path: "HEAD-verified direct MP4", variant: matchingVariant };
      }
    } catch {
      // The matched HLS variant remains the safe source if the optional MP4 is unavailable.
    }
  }

  const variantResponse = await fetch(matchingVariant.url, {
    headers: { Referer: referer },
  });
  if (!variantResponse.ok) {
    throw new Error(
      `The matched ${REQUIRED_SOURCE_WIDTH}x${REQUIRED_SOURCE_HEIGHT} HLS variant ` +
      `could not be fetched: HTTP ${variantResponse.status}`,
    );
  }
  const playlist = await variantResponse.text();
  if (!playlist.trim()) {
    throw new Error(
      `The matched ${REQUIRED_SOURCE_WIDTH}x${REQUIRED_SOURCE_HEIGHT} HLS variant returned an empty playlist`,
    );
  }
  return { url: matchingVariant.url, path: "verified HLS variant playlist", variant: matchingVariant };
}

export function buildDirectMp4Url(videoId: string, folder: string): string {
  if (!/^[^/]+p$/i.test(folder)) {
    throw new Error(`Invalid Bunny rendition folder for direct MP4: ${folder}`);
  }
  return `https://${BUNNY_CDN_HOSTNAME}/${videoId}/play_${folder}.mp4`;
}