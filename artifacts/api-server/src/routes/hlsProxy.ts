import { Router } from "express";
import OSS from "ali-oss";

const router = Router();

const BUCKET = "cam9";
const REGION = "oss-me-central-1";

function getClient() {
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) return null;
  return new OSS({ region: REGION, accessKeyId, accessKeySecret, bucket: BUCKET });
}

// GET /hls/presign?chunkKey=Cam01/2025/07/15/hls/Field_00_.../
// Returns a signed URL for master.m3u8 in that chunk folder
router.get("/hls/presign", async (req, res) => {
  const chunkKey = typeof req.query.chunkKey === "string" ? req.query.chunkKey : null;
  if (!chunkKey) {
    res.status(400).json({ error: "chunkKey required" });
    return;
  }

  const client = getClient();
  if (!client) {
    res.status(503).json({ error: "OSS credentials not configured" });
    return;
  }

  try {
    const key = chunkKey.replace(/\/$/, "") + "/master.m3u8";
    const url = client.signatureUrl(key, { expires: 3600, method: "GET" });
    res.json({ url });
  } catch (err) {
    req.log.error({ err }, "HLS presign error");
    res.status(500).json({ error: "Failed to sign URL" });
  }
});

export default router;
