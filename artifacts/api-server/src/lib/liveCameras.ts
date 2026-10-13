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