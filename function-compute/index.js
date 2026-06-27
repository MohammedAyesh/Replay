/**
 * SoccerWatch – Alibaba Cloud Function Compute handler
 *
 * HTTP Trigger  →  GET /compute?camera=Cam01&date=2026-06-27
 *
 * Environment variables (set in the FC console):
 *   OSS_BUCKET            – bucket name, e.g. "cam9"
 *   OSS_REGION            – region, e.g. "oss-me-central-2"
 *   OSS_ACCESS_KEY_ID     – Alibaba Cloud access key ID
 *   OSS_ACCESS_KEY_SECRET – Alibaba Cloud access key secret
 *
 * Response shape:
 * {
 *   camera        : string          – resolved camera folder name
 *   date          : string          – resolved date (YYYY-MM-DD)
 *   cameras       : string[]        – all camera folders, Cam01 first
 *   videos        : [{ key, url, filename }]
 *   fieldImageUrl : string | null   – 24-h signed URL for {camera}/field.png
 * }
 */

"use strict";

const OSS = require("ali-oss");
const url = require("url");

// ─── Configuration ───────────────────────────────────────────────────────────

const BUCKET         = process.env.OSS_BUCKET            || "cam9";
const REGION         = process.env.OSS_REGION            || "oss-me-central-2";
const ACCESS_KEY_ID  = process.env.OSS_ACCESS_KEY_ID     || "";
const ACCESS_KEY_SEC = process.env.OSS_ACCESS_KEY_SECRET || "";
const PRIMARY_CAM    = "Cam01";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".ts", ".m4v", ".flv"]);

// ─── OSS helpers ─────────────────────────────────────────────────────────────

function client() {
  return new OSS({
    region:          REGION,
    accessKeyId:     ACCESS_KEY_ID,
    accessKeySecret: ACCESS_KEY_SEC,
    bucket:          BUCKET,
  });
}

function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * List top-level "camera" folders in the bucket.
 * Cam01 is always first; everything else is sorted alphabetically.
 */
async function listCameras(oss) {
  const result = await oss.list({ delimiter: "/", "max-keys": "100" });
  const prefixes = result.prefixes || [];
  const cams = prefixes
    .map((p) => p.replace(/\/$/, ""))
    .filter((f) => /^[A-Za-z]+\d+$/.test(f)); // e.g. Cam01, Cam02

  const others = cams.filter((c) => c !== PRIMARY_CAM).sort();
  return [PRIMARY_CAM, ...others];
}

/**
 * List all video objects under {camera}/{year}/ whose path contains the
 * full ISO date string (YYYY-MM-DD).  Handles any sub-folder depth.
 */
async function listVideos(oss, camera, date) {
  const [year] = date.split("-");
  const prefix = `${camera}/${year}/`;
  const keys   = [];
  let marker;

  do {
    const query = { prefix, "max-keys": "1000" };
    if (marker) query.marker = marker;

    const result = await oss.list(query);

    for (const obj of result.objects || []) {
      if (obj.name.includes(date) && VIDEO_EXTS.has(extOf(obj.name))) {
        keys.push(obj.name);
      }
    }

    marker = result.isTruncated ? result.nextMarker : null;
  } while (marker);

  return keys;
}

/**
 * Generate a signed URL valid for `expires` seconds.
 */
function sign(oss, key, expires = 3600) {
  return oss.signatureUrl(key, { expires });
}

// ─── Core compute ────────────────────────────────────────────────────────────

async function compute(camera, date) {
  // Default date = today in Riyadh time (UTC+3)
  if (!date) {
    const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
    date = now.toISOString().slice(0, 10);
  }
  camera = camera || PRIMARY_CAM;

  const oss = client();

  const [cameras, videoKeys] = await Promise.all([
    listCameras(oss),
    listVideos(oss, camera, date),
  ]);

  const videos = videoKeys.map((key) => ({
    key,
    url:      sign(oss, key, 3600),       // 1-hour signed URL
    filename: key.split("/").pop() || key,
  }));

  // field.png cover image – 24-hour signed URL
  let fieldImageUrl = null;
  const fieldKey = `${camera}/field.png`;
  try {
    await oss.head(fieldKey);
    fieldImageUrl = sign(oss, fieldKey, 86400);
  } catch (_) {
    // field.png not present for this camera
  }

  return { camera, date, cameras, videos, fieldImageUrl };
}

// ─── HTTP Trigger handler ─────────────────────────────────────────────────────

module.exports.handler = async function (req, resp, context) {
  // CORS – allow requests from your SoccerWatch app domain
  resp.setHeader("Access-Control-Allow-Origin", "*");
  resp.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  resp.setHeader("Access-Control-Allow-Headers", "Content-Type");
  resp.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    resp.setStatusCode(204);
    resp.send("");
    return;
  }

  if (req.method !== "GET") {
    resp.setStatusCode(405);
    resp.send(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    // Parse query string: ?camera=Cam01&date=2026-06-27
    const parsed = url.parse(req.path + "?" + (req.rawQuery || ""), true);
    const camera = typeof parsed.query.camera === "string" ? parsed.query.camera : undefined;
    const date   = typeof parsed.query.date   === "string" ? parsed.query.date   : undefined;

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      resp.setStatusCode(400);
      resp.send(JSON.stringify({ error: "date must be YYYY-MM-DD" }));
      return;
    }

    const result = await compute(camera, date);
    resp.setStatusCode(200);
    resp.send(JSON.stringify(result));
  } catch (err) {
    console.error("[compute] error:", err);
    resp.setStatusCode(500);
    resp.send(JSON.stringify({ error: "Internal server error", message: err.message }));
  }
};
