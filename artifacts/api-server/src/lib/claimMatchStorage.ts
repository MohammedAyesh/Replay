import { Storage } from "@google-cloud/storage";
import { gzipSync, gunzipSync } from "node:zlib";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const parts = normalized.split("/");
  if (parts.length < 3 || !parts[1] || !parts.slice(2).join("/")) {
    throw new Error("Invalid object storage path");
  }
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

function privateObjectPath(relativePath: string): string {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR is not configured");
  const base = privateDir.replace(/\/$/, "");
  const fullPath = `${base}/claim-match/${relativePath.replace(/^\/+/, "")}`;
  const { objectName } = parseObjectPath(fullPath);
  return `/objects/${objectName.replace(/^.*?\/(?=claim-match\/)/, "")}`;
}

function fileForObjectPath(objectPath: string) {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir || !objectPath.startsWith("/objects/")) {
    throw new Error("Invalid private object path");
  }
  const { bucketName } = parseObjectPath(privateDir);
  const objectName = `${privateDir.replace(/^\/[^/]+\/?/, "").replace(/\/$/, "")}/${objectPath.slice("/objects/".length)}`;
  return objectStorageClient.bucket(bucketName).file(objectName);
}

export async function writeClaimSegment(
  relativePath: string,
  payload: unknown,
): Promise<{ objectPath: string; compressedBytes: number }> {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 6 });
  const objectPath = privateObjectPath(relativePath);
  const file = fileForObjectPath(objectPath);
  await file.save(body, {
    resumable: false,
    metadata: {
      contentType: "application/json",
      contentEncoding: "gzip",
      cacheControl: "private, max-age=3600",
    },
  });
  return { objectPath, compressedBytes: body.byteLength };
}

export async function deleteClaimSegment(objectPath: string): Promise<void> {
  const file = fileForObjectPath(objectPath);
  await file.delete({ ignoreNotFound: true });
}

export async function readClaimSegment(objectPath: string): Promise<Buffer> {
  const file = fileForObjectPath(objectPath);
  const [body] = await file.download({ decompress: false });
  return gunzipSync(body);
}

export async function readCompressedClaimSegment(objectPath: string): Promise<Buffer> {
  const file = fileForObjectPath(objectPath);
  // GCS auto-decompresses objects with contentEncoding=gzip by default.
  // Keep the wire format intact because the segment route forwards this
  // buffer with Content-Encoding: gzip for browser-side decoding.
  const [body] = await file.download({ decompress: false });
  return body;
}