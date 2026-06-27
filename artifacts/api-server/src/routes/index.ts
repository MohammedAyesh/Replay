import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import fieldsRouter from "./fields";
import recordingsRouter from "./recordings";
import clipsRouter from "./clips";
import savedClipsRouter from "./savedClips";
import accountRouter from "./account";
import ossComputeRouter from "./ossCompute";
import fcProxyRouter from "./fcProxy";
import hlsProxyRouter from "./hlsProxy";
import hlsTranscodeRouter from "./hlsTranscode";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(fieldsRouter);
router.use(recordingsRouter);
router.use(clipsRouter);
router.use(savedClipsRouter);
router.use(accountRouter);
router.use(ossComputeRouter);
router.use(fcProxyRouter);
router.use(hlsProxyRouter);
router.use(hlsTranscodeRouter);

export default router;
