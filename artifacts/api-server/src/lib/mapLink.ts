/**
 * Coordinates from what an academy owner pastes as "location": a Google Maps link
 * (long or the maps.app.goo.gl short form shared from the phone app), an Apple or
 * OpenStreetMap link, or plain "31.95, 35.91".
 */

export type LatLng = { latitude: number; longitude: number };

function valid(lat: number, lng: number): LatLng | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(lng * 1e6) / 1e6 };
}

const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";

/** Coordinates written in the text itself, most specific form first. */
export function coordsFromText(raw: string): LatLng | null {
  const text = (() => {
    try { return decodeURIComponent(raw.trim()); } catch { return raw.trim(); }
  })();
  // A dropped pin or a place: "!3d31.95!4d35.91" is the pin, "@31.9,35.8,15z" only the map's centre.
  const patterns = [
    new RegExp(`!3d${NUM}!4d${NUM}`),
    new RegExp(`[?&](?:q|query|ll|sll|destination|daddr|center)=${NUM}\\s*,\\s*${NUM}`),
    new RegExp(`[?&]mlat=${NUM}&mlon=${NUM}`),
    new RegExp(`#map=\\d+/${NUM}/${NUM}`),
    new RegExp(`/search/${NUM}\\s*,\\s*\\+?${NUM}`),
    new RegExp(`@${NUM},${NUM}`),
    new RegExp(`^${NUM}\\s*[, ]\\s*${NUM}$`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const found = valid(Number(match[1]), Number(match[2]));
      if (found) return found;
    }
  }
  return null;
}

const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "g.co", "maps.apple.com", "maps.google.com", "www.google.com", "google.com", "consent.google.com"]);

function allowedUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (SHORT_HOSTS.has(host) || /^(www\.)?google\.[a-z.]{2,6}$/.test(host)) return url;
    return null;
  } catch {
    return null;
  }
}

/**
 * Coordinates from a pasted link, following a short link's redirects (only to Google
 * and Apple map hosts, at most five hops) without reading any page body.
 */
export async function coordsFromMapLink(raw: string, fetcher: typeof fetch = fetch): Promise<LatLng | null> {
  const direct = coordsFromText(raw);
  if (direct) return direct;
  let url = allowedUrl(raw.trim());
  for (let hop = 0; url && hop < 5; hop += 1) {
    const response = await fetcher(url.toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000) });
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (!location) return null;
    const next = new URL(location, url).toString();
    const found = coordsFromText(next);
    if (found) return found;
    // Google's consent wall carries the real address in "continue".
    const continued = new URL(next).searchParams.get("continue");
    if (continued) {
      const behind = coordsFromText(continued);
      if (behind) return behind;
    }
    url = allowedUrl(next);
  }
  return null;
}
