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
import shareRouter from "./routes/share";
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

/**
 * `origin: true` reflects whatever Origin the caller sends, and combined with
 * `credentials: true` that lets any site on the internet make credentialed calls
 * to /api/* and read the response. The guest cookie is SameSite=Lax so it is not
 * attached cross-site, but Clerk's __session cookie is SameSite=None on
 * development and satellite-domain instances — in that configuration any page
 * could drive /api/admin/* as a signed-in admin.
 *
 * Allowed origins come from CORS_ALLOWED_ORIGINS (comma-separated), and nothing
 * else — deliberately no `*.replit.app` wildcard, because anyone can deploy on
 * that domain in minutes and would inherit the same credentialed access.
 *
 * The app itself does not need any entry here: the frontend and this API are
 * served under one origin (BASE_PATH "/" with the API mounted at /api), and the
 * browser applies no CORS check to a same-origin request.
 */
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      // No Origin header: same-origin, curl, or a native app. Nothing to guard.
      if (!origin) return callback(null, true);
      const normalized = origin.replace(/\/$/, "");
      if (allowedOrigins.includes(normalized)) return callback(null, true);
      // Reject by simply not emitting the CORS headers — the browser blocks the
      // read. Throwing here would turn a cross-origin probe into a 500.
      return callback(null, false);
    },
  }),
);

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
// Tracking bundles contain every-second-frame boxes and can be several MB for
// a ten-minute clip. Keep the normal JSON API behavior while allowing the
// authenticated admin upload to carry a real bundle.
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// Public share pages and their media proxies are deliberately outside /api:
// crawlers do not send cookies, and these immutable media responses must not
// inherit the authenticated API's no-store cache policy.
app.use(shareRouter);

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
