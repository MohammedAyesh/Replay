import { Router, type IRouter } from "express";
import { compute, listCameras } from "../compute.js";

const router: IRouter = Router();

/**
 * GET /api/oss/compute?camera=Cam01&date=2026-06-27
 *
 * Returns:
 *  - cameras   : all camera folders in the bucket (Cam01 always first)
 *  - videos    : list of signed video URLs for the chosen camera + date
 *  - fieldImageUrl : signed URL for {camera}/field.png (24-hour TTL)
 *  - date      : the resolved date (YYYY-MM-DD)
 *  - camera    : the resolved camera name
 */
router.get("/oss/compute", async (req, res): Promise<void> => {
  try {
    const camera = typeof req.query.camera === "string" ? req.query.camera : undefined;
    const date = typeof req.query.date === "string" ? req.query.date : undefined;

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD" });
      return;
    }

    const result = await compute(camera, date);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "OSS compute failed");
    res.status(500).json({ error: "Failed to list OSS videos" });
  }
});

/**
 * GET /api/oss/cameras
 *
 * Returns just the list of camera folders (cheap, no video listing).
 */
router.get("/oss/cameras", async (req, res): Promise<void> => {
  try {
    const cameras = await listCameras();
    res.json({ cameras });
  } catch (err) {
    req.log.error({ err }, "OSS listCameras failed");
    res.status(500).json({ error: "Failed to list cameras" });
  }
});

export default router;
