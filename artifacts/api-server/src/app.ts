import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { COOKIE_SECRET } from "./lib/cookies";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ origin: true, credentials: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// Secret enables req.signedCookies — the guest identity cookie is signed so it
// cannot be forged by a client.
app.use(cookieParser(COOKIE_SECRET));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Most /api responses are per-user and cookie-authenticated. Without an
// explicit directive a shared cache (CDN / proxy edge) may store one user's
// response and serve it to another. Default everything to no-store; routes
// that are genuinely public (HLS segments, live segments) set their own
// Cache-Control afterwards, which overrides this.
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Cookie, Authorization");
  next();
});

app.use("/api", router);

export default app;
