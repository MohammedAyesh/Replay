import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import fieldsRouter from "./fields";
import recordingsRouter from "./recordings";
import clipsRouter from "./clips";
import savedClipsRouter from "./savedClips";
import accountRouter from "./account";
import adsRouter from "./ads";
import adminRouter from "./admin";
import bunnyVideosRouter from "./bunnyVideos";
import bunnyCollectionsRouter from "./bunnyCollections";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(bunnyCollectionsRouter);
router.use(bunnyVideosRouter);
router.use(fieldsRouter);
router.use(recordingsRouter);
router.use(clipsRouter);
router.use(savedClipsRouter);
router.use(accountRouter);
router.use(adsRouter);
router.use(adminRouter);

export default router;
