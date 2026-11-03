import { createCanvas } from "@napi-rs/canvas";

/** Test helper (not a test file): builds photos with EXIF the way phones write it. */
/** A minimal EXIF JPEG: Make, Orientation, DateTimeOriginal (+ OffsetTimeOriginal), GPS. */
export function jpegWithExif(o: { date: string; offset?: string; lat?: number; lon?: number; orientation?: number; w?: number; h?: number }): Buffer {
  const c = createCanvas(o.w ?? 40, o.h ?? 20);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, (o.w ?? 40) / 2, o.h ?? 20);
  ctx.fillStyle = "#0000ff"; ctx.fillRect((o.w ?? 40) / 2, 0, (o.w ?? 40) / 2, o.h ?? 20);
  const jpeg = c.toBuffer("image/jpeg");
  // Big-endian TIFF. Layout: header(8) | IFD0 | ExifIFD | GPS IFD | data.
  const parts: number[] = [];
  const data: number[] = [];
  const dataBase = 8 + (2 + 4 * 12 + 4) + (2 + 2 * 12 + 4) + (2 + 4 * 12 + 4);
  const put = (bytes: number[]) => { const at = dataBase + data.length; data.push(...bytes); return at; };
  const str = (s: string) => [...Buffer.from(`${s}\0`, "ascii")];
  const u16 = (v: number) => [(v >> 8) & 255, v & 255];
  const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const rat = (v: number) => { const den = 1_000_000; return [...u32(Math.round(v * den)), ...u32(den)]; };
  const dms = (v: number) => { const a = Math.abs(v); const d = Math.floor(a); const m = Math.floor((a - d) * 60); const s = ((a - d) * 60 - m) * 60; return [...rat(d), ...rat(m), ...rat(s)]; };
  const entry = (tag: number, type: number, count: number, value: number[]) => [...u16(tag), ...u16(type), ...u32(count), ...(value.length <= 4 ? [...value, 0, 0, 0, 0].slice(0, 4) : u32(put(value)))];
  const ifd0At = 8;
  const exifAt = ifd0At + 2 + 4 * 12 + 4;
  const gpsAt = exifAt + 2 + 2 * 12 + 4;
  const make = str("Apple");
  parts.push(...[0x4d, 0x4d, 0, 42], ...u32(ifd0At));
  parts.push(...u16(4), ...entry(0x010f, 2, make.length, make), ...entry(0x0112, 3, 1, [...u16(o.orientation ?? 1), 0, 0]),
    ...entry(0x8769, 4, 1, u32(exifAt)), ...entry(0x8825, 4, 1, u32(gpsAt)), ...u32(0));
  const dt = str(o.date);
  const off = str(o.offset ?? "");
  parts.push(...u16(2), ...entry(0x9003, 2, dt.length, dt), ...entry(o.offset ? 0x9011 : 0x9010, 2, off.length, off), ...u32(0));
  const lat = o.lat ?? 0;
  const lon = o.lon ?? 0;
  parts.push(...u16(4), ...entry(1, 2, 2, [lat < 0 ? 83 : 78, 0]), ...entry(2, 5, 3, dms(lat)), ...entry(3, 2, 2, [lon < 0 ? 87 : 69, 0]), ...entry(4, 5, 3, dms(lon)), ...u32(0));
  const tiff = Buffer.from([...parts, ...data]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from(u16(tiff.length + 8)), Buffer.from("Exif\0\0", "ascii"), tiff]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

