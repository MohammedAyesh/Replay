/**
 * Phone videos and photos sorted by match time (shared by the browser and the server).
 *
 * 1. Read when a file was filmed, before it is uploaded (the iPhone picker can
 *    convert a video and drop its date), from the file's own bytes:
 *      - iPhone video: moov/meta "com.apple.quicktime.creationdate", local
 *        time with its offset ("2026-11-01T18:05:32+0300"). The best source.
 *      - Android video: moov/mvhd creation time, normally UTC. Some phones
 *        write local time labelled as UTC (3 h late in Amman), some write the
 *        time recording STOPPED. Both are told apart with the clip's duration
 *        and the file's last-modified time (resolveCaptureTime).
 *      - Photos: EXIF DateTimeOriginal + OffsetTimeOriginal.
 *      - WhatsApp-forwarded files (VID-YYYYMMDD-WA…): WhatsApp rewrites the
 *        file, so only the date in the name is reliable: the coach is asked.
 *    GPS is read too, only to say whether it was filmed at the venue; the
 *    coordinates are never stored, and the server strips them from the file.
 * 2. Sort it against the day's sessions (classifyCapture): before (ends before
 *    kick-off, starts at most 3 h before), during (overlaps; with its offset
 *    into the panoramic recording), after (starts at most 3 h after the end),
 *    else not linked. ±5 minutes either way. Several sessions that day: the
 *    one it overlaps, else the nearest.
 */

// ── Reading bytes ────────────────────────────────────────────────────────────

/** Reads `length` bytes at `offset` (a Blob slice in the browser, a file handle on the server). */
export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>;

const MAC_EPOCH_MS = Date.UTC(1904, 0, 1);
const MAX_MOOV_BYTES = 16 * 1024 * 1024;

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
/** UTF-8 bytes to a string (no TextDecoder: this library builds without the DOM types). */
function utf8(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length;) {
    const c = b[i];
    let cp = c;
    let n = 0;
    if (c >= 0xf0) { cp = c & 0x07; n = 3; } else if (c >= 0xe0) { cp = c & 0x0f; n = 2; } else if (c >= 0xc0) { cp = c & 0x1f; n = 1; }
    for (let k = 1; k <= n; k++) cp = (cp << 6) | ((b[i + k] ?? 0) & 0x3f);
    out += String.fromCodePoint(cp);
    i += n + 1;
  }
  return out;
}

export type Mp4Meta = {
  /** moov/mvhd creation time as stored (seconds since 1904, read as UTC); null when 0 / missing. */
  mvhdCreation: string | null;
  durationSec: number | null;
  /** com.apple.quicktime.creationdate (iPhone), as written. */
  quicktimeCreationDate: string | null;
  /** ISO 6709 location ("+31.9539+035.9106+0800.000/"), iPhone or Android (©xyz). Never stored. */
  location: string | null;
  /** ©day / other date tags some Android phones write. */
  otherDate: string | null;
  make: string | null;
  model: string | null;
};

type Box = { type: string; start: number; header: number; size: number };

function boxesIn(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32(b, o);
    const type = ascii(b, o + 4, 4);
    let header = 8;
    if (size === 1 && o + 16 <= to) { size = u64(b, o + 8); header = 16; } else if (size === 0) size = to - o;
    if (size < header || o + size > to) break;
    out.push({ type, start: o, header, size });
    o += size;
  }
  return out;
}

/** Find moov at the top level of an MP4/MOV without reading mdat (a phone video can be hundreds of MB). */
export async function readMp4Meta(read: ByteReader, fileSize: number): Promise<Mp4Meta | null> {
  let o = 0;
  let moov: Uint8Array | null = null;
  let isMp4 = false;
  while (o + 8 <= fileSize) {
    const h = await read(o, 16);
    if (h.length < 8) break;
    let size = u32(h, 0);
    const type = ascii(h, 4, 4);
    let header = 8;
    if (size === 1) { size = u64(h, 8); header = 16; } else if (size === 0) size = fileSize - o;
    if (!/^[\x20-\x7e]{4}$/.test(type) || size < header) break;
    if (type === "ftyp" || type === "moov" || type === "mdat" || type === "wide" || type === "free") isMp4 = true;
    if (type === "moov") {
      if (size > MAX_MOOV_BYTES) return null;
      moov = await read(o, size);
      break;
    }
    o += size;
  }
  if (!moov || !isMp4) return null;
  const meta: Mp4Meta = { mvhdCreation: null, durationSec: null, quicktimeCreationDate: null, location: null, otherDate: null, make: null, model: null };
  const top = boxesIn(moov, 8, moov.length);

  const mvhd = top.find((x) => x.type === "mvhd");
  if (mvhd) {
    const p = mvhd.start + mvhd.header;
    const version = moov[p];
    const created = version === 1 ? u64(moov, p + 4) : u32(moov, p + 4);
    const timescale = version === 1 ? u32(moov, p + 20) : u32(moov, p + 12);
    const duration = version === 1 ? u64(moov, p + 24) : u32(moov, p + 16);
    if (created > 0) meta.mvhdCreation = new Date(MAC_EPOCH_MS + created * 1000).toISOString();
    if (timescale > 0) meta.durationSec = Math.round((duration / timescale) * 1000) / 1000;
  }

  // QuickTime metadata (iPhone): moov/meta with hdlr "mdta", keys and ilst.
  const metaBox = top.find((x) => x.type === "meta");
  if (metaBox) readMdta(moov, metaBox, meta);
  // udta: ©xyz (location), ©day (date), and sometimes a nested meta.
  const udta = top.find((x) => x.type === "udta");
  if (udta) {
    for (const c of boxesIn(moov, udta.start + udta.header, udta.start + udta.size)) {
      const body = moov.subarray(c.start + c.header, c.start + c.size);
      if (c.type === "\xa9xyz" && body.length > 4) meta.location ??= utf8(body.subarray(4)).replace(/\0+$/, "");
      if (c.type === "\xa9day" && body.length > 4) meta.otherDate ??= utf8(body.subarray(4)).replace(/\0+$/, "");
      if (c.type === "meta") readMdta(moov, c, meta, true);
    }
  }
  return meta;
}

function readMdta(b: Uint8Array, box: Box, meta: Mp4Meta, fullBox = false) {
  // `meta` is a full box in udta (version + flags) and usually not in moov (QuickTime).
  let first = box.start + box.header;
  const peek = boxesIn(b, first, box.start + box.size);
  if (fullBox || !peek.length || !["hdlr", "keys", "ilst"].includes(peek[0].type)) first += 4;
  const kids = boxesIn(b, first, box.start + box.size);
  const keysBox = kids.find((k) => k.type === "keys");
  const ilst = kids.find((k) => k.type === "ilst");
  if (!ilst) return;
  const keys: string[] = [];
  if (keysBox) {
    let o = keysBox.start + keysBox.header + 8; // version/flags + entry count
    const end = keysBox.start + keysBox.size;
    while (o + 8 <= end) {
      const size = u32(b, o);
      if (size < 8 || o + size > end) break;
      keys.push(utf8(b.subarray(o + 8, o + size)));
      o += size;
    }
  }
  for (const item of boxesIn(b, ilst.start + ilst.header, ilst.start + ilst.size)) {
    // With keys (QuickTime mdta), an item's type is the 1-based index of its key.
    const name = keys.length ? keys[u32(b, item.start + 4) - 1] ?? "" : item.type;
    const data = boxesIn(b, item.start + item.header, item.start + item.size).find((d) => d.type === "data");
    if (!data) continue;
    const value = utf8(b.subarray(data.start + data.header + 8, data.start + data.size)).replace(/\0+$/, "");
    if (name === "com.apple.quicktime.creationdate") meta.quicktimeCreationDate = value;
    else if (name === "com.apple.quicktime.location.ISO6709" || name === "\xa9xyz") meta.location ??= value;
    else if (name === "com.apple.quicktime.make" || name === "com.android.manufacturer") meta.make ??= value;
    else if (name === "com.apple.quicktime.model" || name === "com.android.model") meta.model ??= value;
    else if (name === "\xa9day") meta.otherDate ??= value;
  }
}

// ── JPEG EXIF ───────────────────────────────────────────────────────────────

export type ExifMeta = {
  dateTimeOriginal: string | null;
  offsetTimeOriginal: string | null;
  /** Never stored: only compared with the venue. */
  gps: { lat: number; lon: number } | null;
  make: string | null;
  model: string | null;
  /** EXIF Orientation (1 = upright … 8); re-encoding without EXIF must apply it. */
  orientation: number | null;
};

/** EXIF from the start of a JPEG (the APP1 segment sits in the first 64 KB). */
export function readJpegExif(b: Uint8Array): ExifMeta | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1];
    const len = (b[o + 2] << 8) + b[o + 3];
    if (marker === 0xe1 && ascii(b, o + 4, 4) === "Exif") return readTiff(b.subarray(o + 10, o + 2 + len));
    if (marker === 0xda) return null;
    o += 2 + len;
  }
  return null;
}

function readTiff(t: Uint8Array): ExifMeta {
  const le = ascii(t, 0, 2) === "II";
  const r16 = (o: number) => (le ? t[o] + (t[o + 1] << 8) : (t[o] << 8) + t[o + 1]);
  const r32 = (o: number) => (le ? (t[o] + (t[o + 1] << 8) + (t[o + 2] << 16)) + t[o + 3] * 2 ** 24 : u32(t, o));
  const out: ExifMeta = { dateTimeOriginal: null, offsetTimeOriginal: null, gps: null, make: null, model: null, orientation: null };
  const str = (count: number, valueOffset: number, at: number) => {
    const start = count <= 4 ? at : valueOffset;
    return ascii(t, start, Math.max(0, count - 1)).replace(/\0+$/, "");
  };
  const ifd = (start: number) => {
    const entries: Array<{ tag: number; type: number; count: number; at: number; value: number }> = [];
    if (start <= 0 || start + 2 > t.length) return entries;
    const n = r16(start);
    for (let i = 0; i < n; i++) {
      const at = start + 2 + i * 12;
      if (at + 12 > t.length) break;
      entries.push({ tag: r16(at), type: r16(at + 2), count: r32(at + 4), at: at + 8, value: r32(at + 8) });
    }
    return entries;
  };
  const rational = (o: number) => (r32(o + 4) ? r32(o) / r32(o + 4) : 0);
  const ifd0 = ifd(r32(4));
  for (const e of ifd0) {
    if (e.tag === 0x010f) out.make = str(e.count, e.value, e.at);
    if (e.tag === 0x0110) out.model = str(e.count, e.value, e.at);
    if (e.tag === 0x0112) out.orientation = r16(e.at);
  }
  const exifPtr = ifd0.find((e) => e.tag === 0x8769)?.value;
  for (const e of exifPtr ? ifd(exifPtr) : []) {
    if (e.tag === 0x9003) out.dateTimeOriginal = str(e.count, e.value, e.at);
    if (e.tag === 0x9011) out.offsetTimeOriginal = str(e.count, e.value, e.at);
  }
  const gpsPtr = ifd0.find((e) => e.tag === 0x8825)?.value;
  if (gpsPtr) {
    const g = ifd(gpsPtr);
    const dms = (tag: number) => {
      const e = g.find((x) => x.tag === tag);
      return e ? rational(e.value) + rational(e.value + 8) / 60 + rational(e.value + 16) / 3600 : null;
    };
    const ref = (tag: number) => {
      const e = g.find((x) => x.tag === tag);
      return e ? String.fromCharCode(t[e.at]) : "";
    };
    const lat = dms(0x0002);
    const lon = dms(0x0004);
    if (lat !== null && lon !== null && (lat !== 0 || lon !== 0)) {
      out.gps = { lat: ref(0x0001) === "S" ? -lat : lat, lon: ref(0x0003) === "W" ? -lon : lon };
    }
  }
  return out;
}

/** "+31.9539+035.9106+0800.000/" → { lat, lon }. */
export function parseIso6709(s: string | null | undefined): { lat: number; lon: number } | null {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(s ?? "");
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** Metres between two points. */
export function distanceMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Filmed at the venue: within this many metres of it (GPS on a phone is ±10–50 m; pitches are big). */
export const VENUE_RADIUS_M = 400;

// ── When was it filmed? ─────────────────────────────────────────────────────

/** What the browser (or the server's fallback) read from the file. Times as written in the file. */
export type CaptureRaw = {
  kind: "video" | "image";
  fileName: string;
  /** File.lastModified (ms) as the phone's browser reports it; on a phone this is usually when recording ended. */
  lastModifiedMs?: number | null;
  durationSec?: number | null;
  quicktimeCreationDate?: string | null;
  mvhdCreation?: string | null;
  otherDate?: string | null;
  dateTimeOriginal?: string | null;
  offsetTimeOriginal?: string | null;
  make?: string | null;
  model?: string | null;
};

export type CaptureSource = "quicktime" | "exif" | "mvhd" | "mvhd_local_as_utc" | "mvhd_stop_time" | "mvhd_local_stop" | "whatsapp_date" | "file_date" | "none";
export type CaptureConfidence = "high" | "medium" | "low";

export type CaptureTime = {
  /** When filming started and ended (true UTC instants); null when only a date is known. */
  start: string | null;
  end: string | null;
  durationSec: number | null;
  source: CaptureSource;
  confidence: CaptureConfidence;
  /** "YYYY-MM-DD" when only the day is known (a WhatsApp forward): the coach picks the session. */
  dateOnly: string | null;
  /** Why this reading was chosen, for the coach and for debugging. */
  notes: string[];
};

export const AMMAN_OFFSET_MIN = 180;
const WHATSAPP_NAME = /(?:^|[^A-Z])(?:VID|IMG|AUD|PTT)-(\d{4})(\d{2})(\d{2})-WA\d+/i;
const DATE_IN_NAME = /(?:^|[^0-9])(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})(?:[^0-9]|$)/;

/** "2026-11-01T18:05:32+0300" / "+03:00" / "Z" → instant. */
export function parseOffsetDate(s: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec((s ?? "").trim());
  if (!m || !m[7]) return null;
  const [, y, mo, d, h, mi, se, tz] = m;
  let offsetMin = 0;
  if (tz !== "Z") {
    const t = tz.replace(":", "");
    offsetMin = (t[0] === "-" ? -1 : 1) * (Number(t.slice(1, 3)) * 60 + Number(t.slice(3, 5)));
  }
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - offsetMin * 60_000;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** EXIF "2026:11:01 18:05:32" with an optional "+03:00"; without one, Amman time is assumed. */
export function parseExifDate(dt: string | null | undefined, offset: string | null | undefined): { at: Date; hadOffset: boolean } | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec((dt ?? "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const off = /^([+-])(\d{2}):?(\d{2})$/.exec((offset ?? "").trim());
  const offsetMin = off ? (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) : AMMAN_OFFSET_MIN;
  return { at: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - offsetMin * 60_000), hadOffset: Boolean(off) };
}

/** The date a WhatsApp-forwarded file carries in its name ("VID-20261101-WA0012.mp4" → "2026-11-01"). */
export function whatsappNameDate(name: string): string | null {
  const m = WHATSAPP_NAME.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const iso = (d: Date) => d.toISOString();

/**
 * When a phone file was filmed. `uploadedAt` bounds the answer (nothing is
 * filmed after it is uploaded).
 */
export function resolveCaptureTime(raw: CaptureRaw, uploadedAt: Date): CaptureTime {
  const dur = raw.durationSec && raw.durationSec > 0 ? raw.durationSec : raw.kind === "image" ? 0 : null;
  const span = (start: Date, source: CaptureSource, confidence: CaptureConfidence, notes: string[]): CaptureTime => ({
    start: iso(start), end: iso(new Date(start.getTime() + (dur ?? 0) * 1000)), durationSec: dur, source, confidence, dateOnly: null, notes,
  });

  // A WhatsApp forward: WhatsApp re-encodes the file, so its own dates are the forward's. Only the name's date holds.
  const wa = whatsappNameDate(raw.fileName);
  if (wa) {
    return { start: null, end: null, durationSec: dur, source: "whatsapp_date", confidence: "low", dateOnly: wa, notes: ["Forwarded through WhatsApp: only the day is reliable"] };
  }

  if (raw.kind === "video") {
    const qt = parseOffsetDate(raw.quicktimeCreationDate);
    if (qt && qt.getTime() <= uploadedAt.getTime() + 5 * 60_000) return span(qt, "quicktime", "high", ["iPhone creation date, with its time zone"]);

    const mvhd = raw.mvhdCreation ? new Date(raw.mvhdCreation) : null;
    if (mvhd && Number.isFinite(mvhd.getTime()) && mvhd.getUTCFullYear() > 2000) {
      // Four readings of one timestamp: UTC or local-labelled-UTC, recording start or stop.
      const d = (dur ?? 0) * 1000;
      const shift = AMMAN_OFFSET_MIN * 60_000;
      const all: Array<{ start: Date; source: CaptureSource; note: string }> = [
        { start: mvhd, source: "mvhd", note: "Start time in UTC" },
        { start: new Date(mvhd.getTime() - shift), source: "mvhd_local_as_utc", note: "The phone wrote Amman time labelled as UTC" },
        { start: new Date(mvhd.getTime() - d), source: "mvhd_stop_time", note: "The phone wrote when recording stopped" },
        { start: new Date(mvhd.getTime() - shift - d), source: "mvhd_local_stop", note: "Amman stop time labelled as UTC" },
      ];
      const candidates = all.filter((c) => c.start.getTime() + d <= uploadedAt.getTime() + 5 * 60_000);
      if (!candidates.length) return { start: null, end: null, durationSec: dur, source: "none", confidence: "low", dateOnly: null, notes: ["The file's time is after it was uploaded"] };
      // On the phone, the file's last-modified time is when it finished writing: the end of filming.
      const lm = raw.lastModifiedMs ?? null;
      const usable = lm !== null && lm <= uploadedAt.getTime() + 60_000 && Math.abs(lm - mvhd.getTime()) <= 8 * 3_600_000;
      if (usable) {
        const scored = candidates
          .map((c) => ({ ...c, miss: Math.abs(c.start.getTime() + d - lm!) }))
          .sort((a, b) => a.miss - b.miss);
        const best = scored[0];
        const conf: CaptureConfidence = best.miss <= 2 * 60_000 ? "high" : best.miss <= 15 * 60_000 ? "medium" : "low";
        return span(best.start, best.source, conf, [best.note, `Checked against the file's save time (${Math.round(best.miss / 1000)} s apart)`]);
      }
      // No trustworthy save time: UTC start is the standard; the others stay possible.
      return span(candidates[0].start, candidates[0].source, "medium", [candidates[0].note, "No save time to check it against"]);
    }
  } else {
    const ex = parseExifDate(raw.dateTimeOriginal, raw.offsetTimeOriginal);
    if (ex && ex.at.getTime() <= uploadedAt.getTime() + 5 * 60_000) {
      return span(ex.at, "exif", ex.hadOffset ? "high" : "medium", [ex.hadOffset ? "Photo time with its time zone" : "Photo time, Amman time assumed"]);
    }
  }

  // A date and time in the name (Samsung "20261101_180532.mp4"), Amman time.
  const nm = DATE_IN_NAME.exec(raw.fileName);
  if (nm) {
    const at = new Date(Date.UTC(+nm[1], +nm[2] - 1, +nm[3], +nm[4], +nm[5], +nm[6]) - AMMAN_OFFSET_MIN * 60_000);
    if (Number.isFinite(at.getTime()) && at.getTime() <= uploadedAt.getTime()) return span(at, "file_date", "medium", ["Date and time in the file name"]);
  }
  return { start: null, end: null, durationSec: dur, source: "none", confidence: "low", dateOnly: null, notes: ["No date in the file"] };
}

// ── Before, during, after ──────────────────────────────────────────────────

export const PHASE_RULES = {
  toleranceMin: 5,
  beforeHours: 3,
  afterHours: 3,
} as const;

export type Phase = "before" | "during" | "after" | "unlinked";

/** A session as the sort sees it: its window, and where its panoramic recording starts if it has one. */
export type SessionWindow = {
  id: number;
  /** Planned start, or the recording's real start when there is one. */
  start: Date;
  end: Date;
  /** Wall-clock start of the panoramic recording (to give a "during" clip its offset). */
  recordingId: number | null;
  recordingStart: Date | null;
  recordingDurationSec: number | null;
};

export type PhaseResult = {
  phase: Phase;
  sessionId: number | null;
  /** Seconds into the panoramic recording where the clip starts ("during" only, when there is a recording). */
  offsetSec: number | null;
  recordingId: number | null;
  /** Ask the coach which session: only a date, no time, or nothing within reach. */
  needsReview: boolean;
  reason: "time" | "date_only" | "no_time" | "no_session";
  /** For a coach's pick: that day's sessions. */
  candidates: number[];
};

const MIN = 60_000;

/** Sort one capture against the sessions of its day (pass every session within a day of it). */
export function classifyCapture(capture: Pick<CaptureTime, "start" | "end" | "dateOnly">, sessions: SessionWindow[], ammanDayOf: (d: Date) => string): PhaseResult {
  const tol = PHASE_RULES.toleranceMin * MIN;
  if (!capture.start) {
    const day = capture.dateOnly;
    const candidates = day ? sessions.filter((s) => ammanDayOf(s.start) === day).map((s) => s.id) : [];
    return { phase: "unlinked", sessionId: null, offsetSec: null, recordingId: null, needsReview: true, reason: day ? "date_only" : "no_time", candidates };
  }
  const a = new Date(capture.start).getTime();
  const b = Math.max(a, new Date(capture.end ?? capture.start).getTime());
  const sameDay = sessions.filter((s) => Math.abs(s.start.getTime() - a) <= 24 * 3_600_000).map((s) => s.id);

  type Hit = { s: SessionWindow; phase: Exclude<Phase, "unlinked">; distance: number };
  const hits: Hit[] = [];
  for (const s of sessions) {
    const S = s.start.getTime();
    const E = Math.max(S, s.end.getTime());
    if (a <= E + tol && b >= S - tol) hits.push({ s, phase: "during", distance: 0 });
    else if (b <= S + tol && a >= S - PHASE_RULES.beforeHours * 3_600_000 - tol) hits.push({ s, phase: "before", distance: S - b });
    else if (a >= E - tol && a <= E + PHASE_RULES.afterHours * 3_600_000 + tol) hits.push({ s, phase: "after", distance: a - E });
  }
  if (!hits.length) return { phase: "unlinked", sessionId: null, offsetSec: null, recordingId: null, needsReview: true, reason: "no_session", candidates: sameDay };
  // The session it overlaps first; otherwise the nearest.
  hits.sort((x, y) => (x.phase === "during" ? 0 : 1) - (y.phase === "during" ? 0 : 1) || Math.max(0, x.distance) - Math.max(0, y.distance));
  const hit = hits[0];
  let offsetSec: number | null = null;
  if (hit.phase === "during" && hit.s.recordingStart) {
    const off = (a - hit.s.recordingStart.getTime()) / 1000;
    const within = off + (b - a) / 1000 >= 0 && (hit.s.recordingDurationSec === null || off <= hit.s.recordingDurationSec);
    if (within) offsetSec = Math.round(off * 10) / 10;
  }
  return { phase: hit.phase, sessionId: hit.s.id, offsetSec, recordingId: hit.phase === "during" ? hit.s.recordingId : null, needsReview: false, reason: "time", candidates: sameDay };
}
