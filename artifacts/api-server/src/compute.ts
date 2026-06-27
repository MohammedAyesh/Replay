import OSS from "ali-oss";

const BUCKET = process.env.OSS_BUCKET ?? "cam9";
const REGION = process.env.OSS_REGION ?? "oss-me-central-1";
const PRIMARY_CAMERA = "Cam01";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".ts", ".m4v"]);

function createClient(): OSS {
  return new OSS({
    region: REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID ?? "",
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET ?? "",
    bucket: BUCKET,
  });
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * List all top-level "camera" folders in the bucket.
 * Cam01 is always first; every other prefix follows alphabetically.
 */
export async function listCameras(): Promise<string[]> {
  const client = createClient();
  const result = await client.list({ delimiter: "/", "max-keys": "100" } as Parameters<typeof client.list>[0], {});
  const prefixes: string[] = (result as { prefixes?: string[] }).prefixes ?? [];
  const folders = prefixes
    .map((p) => p.replace(/\/$/, ""))
    .filter((f) => /^Cam\d+$/i.test(f));

  const others = folders.filter((f) => f !== PRIMARY_CAMERA).sort();
  return [PRIMARY_CAMERA, ...others];
}

/**
 * List video objects for a given camera folder and date (YYYY-MM-DD).
 *
 * OSS layout assumed:
 *   {camera}/
 *     {YYYY}/          ← year folder
 *       …/{date}/      ← any sub-path that includes the ISO date string
 *         *.mp4 / *.ts / …
 *
 * We list all objects under {camera}/{YYYY}/ and keep those whose path
 * contains the full date string and has a recognised video extension.
 */
export async function listVideosForDate(
  camera: string,
  date: string            // YYYY-MM-DD
): Promise<string[]> {
  const client = createClient();
  const [year] = date.split("-");
  const prefix = `${camera}/${year}/`;

  const all: string[] = [];
  let marker: string | undefined;

  // Paginate through all matching objects
  do {
    const query: Record<string, string> = { prefix, "max-keys": "1000" };
    if (marker) query.marker = marker;

    const result = (await client.list(query as Parameters<typeof client.list>[0], {})) as {
      objects?: { name: string }[];
      nextMarker?: string;
      isTruncated?: boolean;
    };

    for (const obj of result.objects ?? []) {
      if (obj.name.includes(date) && VIDEO_EXTENSIONS.has(extOf(obj.name))) {
        all.push(obj.name);
      }
    }

    marker = result.isTruncated ? result.nextMarker : undefined;
  } while (marker);

  return all;
}

/**
 * Generate a signed (time-limited) URL for a private OSS object.
 */
function signUrl(client: OSS, objectKey: string, expiresSeconds = 3600): string {
  return client.signatureUrl(objectKey, { expires: expiresSeconds });
}

export interface ComputeResult {
  cameras: string[];
  date: string;
  camera: string;
  videos: Array<{ key: string; url: string; filename: string }>;
  fieldImageUrl: string | null;
}

/**
 * Main compute function.
 *
 * @param camera  Camera folder name, e.g. "Cam01". Defaults to primary camera.
 * @param date    ISO date string "YYYY-MM-DD". Defaults to today (Riyadh time UTC+3).
 */
export async function compute(
  camera: string = PRIMARY_CAMERA,
  date?: string
): Promise<ComputeResult> {
  // Default to today in Riyadh time (UTC+3)
  if (!date) {
    const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
    date = now.toISOString().slice(0, 10);
  }

  const client = createClient();

  const [cameras, keys] = await Promise.all([
    listCameras(),
    listVideosForDate(camera, date),
  ]);

  const videos = keys.map((key) => ({
    key,
    url: signUrl(client, key),
    filename: key.split("/").pop() ?? key,
  }));

  // field.png lives at {camera}/field.png
  let fieldImageUrl: string | null = null;
  const fieldKey = `${camera}/field.png`;
  try {
    await client.head(fieldKey);
    fieldImageUrl = signUrl(client, fieldKey, 86400); // 24-hour URL
  } catch {
    // field.png not found for this camera — return null
  }

  return { cameras, date, camera, videos, fieldImageUrl };
}
