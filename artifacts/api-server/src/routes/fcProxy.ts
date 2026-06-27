import { Router } from "express";

const router = Router();

const FC_URL = "https://camgetter-pvjknghkae.me-central-1.fcapp.run/compute";

router.get("/fc/compute", async (req, res) => {
  try {
    const params = new URLSearchParams();
    if (typeof req.query.camera === "string") params.set("camera", req.query.camera);
    if (typeof req.query.date === "string") params.set("date", req.query.date);

    const upstream = await fetch(`${FC_URL}?${params.toString()}`);
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "FC proxy error");
    res.status(502).json({ error: "Failed to reach camera server" });
  }
});

export default router;
