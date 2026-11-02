/**
 * Configured camera aliases and their on-disk names for live playback and
 * authenticated live controls.
 */
const configuredCameras = (process.env.LIVE_CAMERAS || "camera1:cam1,camera2:cam2")
  .split(",")
  .map((pair) => pair.split(":"))
  .filter((parts): parts is [string, string] => parts.length === 2 && !!parts[0] && !!parts[1]);

export const LIVE_CAMERA_UPSTREAM = new Map(configuredCameras);

export function parseLiveCamera(value: string | string[] | undefined): string | null {
  const camera = Array.isArray(value) ? value[0] : value;
  return camera && LIVE_CAMERA_UPSTREAM.has(camera) ? camera : null;
}

/** Resolve the control-service camera name without exposing camera internals to clients. */
export function parseVarControlCamera(value: string | string[] | undefined): "cam1" | "cam2" | "cam3" | null {
  const camera = Array.isArray(value) ? value[0] : value;
  const match = /^(?:camera|cam)([1-3])$/.exec(camera ?? "");
  return match && parseLiveCamera(`camera${match[1]}`) ? `cam${match[1]}` as "cam1" | "cam2" | "cam3" : null;
}
/**
 * The configured live alias ("camera1") for a camera id in either form a field or a
 * booking may store: "camera1" (owner pitches) or "cam1" (some academy pitches).
 * Null when the camera is not configured for live.
 */
export function liveCameraAlias(value: string | null | undefined): string | null {
  const direct = parseLiveCamera(value ?? undefined);
  if (direct) return direct;
  const control = parseVarControlCamera(value ?? undefined);
  return control ? parseLiveCamera(`camera${control.slice(3)}`) : null;
}

/** vps1's private Bunny VAR playlist, accepted only in its exact published shape. */
export function varCdnUrl(value: unknown): string | null {
  return typeof value === "string" && /^https:\/\/[a-z0-9.-]+\.b-cdn\.net\/var\/cam\d+\/[a-f0-9]{32}\/index\.m3u8$/i.test(value)
    ? value
    : null;
}
