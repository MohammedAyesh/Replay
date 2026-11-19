export type HlsQualityLevel = {
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
  index: number;
};

export type VideoDimensions = {
  width?: number | null;
  height?: number | null;
};

export type SourceQualityOption = "8k" | "4k" | "hd" | "stream";

function isPositiveDimension(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasRealDimensions(level: HlsQualityLevel): boolean {
  return isPositiveDimension(level.width) && isPositiveDimension(level.height);
}

export function shouldShowQualityPicker(levels: readonly HlsQualityLevel[]): boolean {
  return levels.length >= 2 && levels.some(hasRealDimensions);
}

export function qualityLevelDisplay(
  level: HlsQualityLevel,
  video: VideoDimensions = {},
): { label: string | null; details: string | null } {
  const dimensions = hasRealDimensions(level)
    ? { width: level.width, height: level.height }
    : isPositiveDimension(video.width) && isPositiveDimension(video.height)
      ? { width: video.width, height: video.height }
      : null;
  const bitrateMbps = isPositiveDimension(level.bitrate)
    ? (level.bitrate / 1_000_000).toFixed(1)
    : null;
  const bitrateLabel = bitrateMbps && Number(bitrateMbps) > 0
    ? `${bitrateMbps} Mbps`
    : null;
  const details = [
    dimensions ? `${dimensions.width}×${dimensions.height}` : null,
    bitrateLabel,
  ].filter((part): part is string => part !== null).join(" · ");

  return {
    label: dimensions ? `${dimensions.height}p` : null,
    details: details || null,
  };
}

export function availableSourceQualityOptions(options: {
  streamlessStorage: boolean;
  eightKAvailable: boolean;
  uhdAvailable: boolean;
  h264Available: boolean;
}): SourceQualityOption[] {
  const { streamlessStorage, eightKAvailable, uhdAvailable, h264Available } = options;
  return [
    ...(!streamlessStorage && eightKAvailable ? ["8k" as const] : []),
    ...(uhdAvailable ? ["4k" as const] : []),
    ...(h264Available ? ["hd" as const] : []),
    ...(!streamlessStorage ? ["stream" as const] : []),
  ];
}

export function sourceQualityButtonLabel(stage: string, streamlessStorage: boolean): string {
  if (stage === "8k") return "8K";
  if (stage === "uhd") return "4K";
  if (stage === "h264") return streamlessStorage ? "HD" : "H.264";
  return "Stream";
}
