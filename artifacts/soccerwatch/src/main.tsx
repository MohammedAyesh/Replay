import { createRoot } from "react-dom/client";
import App from "./App";
import { primeVideoCacheWorker } from "./lib/video-cache";
import { watchForNewBuilds } from "./lib/fresh-build";
import { isTransientClerkSessionTouchError } from "./lib/clerk-network";
import { isVenueHost } from "./lib/venue-host";
import "./index.css";

// Register early so the worker controls Claim Match before HLS initializes.
// It does not cache anything until the player sends its first Play event.
if (!isVenueHost(window.location.hostname)) void primeVideoCacheWorker();

// Clerk refreshes active sessions in the background. A temporary network failure
// must not make the preview look like the app crashed, but it also must not be
// treated as a successful auth state. Clerk keeps ownership of the session and
// will retry its refresh; log only a safe, actionable diagnostic.
if (import.meta.env.DEV) {
  window.addEventListener("unhandledrejection", (event) => {
    if (!isTransientClerkSessionTouchError(event.reason)) return;

    event.preventDefault();
    console.warn(
      "[Clerk] Temporary session refresh network error; authentication state is unchanged and Clerk will retry.",
    );
  });
}

// A field's own domain (proxied to Replay by vps1's Caddy) shows only that field's booking
// website, without the app, sign-in or the video cache around it.
if (isVenueHost(window.location.hostname)) {
  void import("./pages/venue-site").then(({ VenueSiteStandalone }) => {
    createRoot(document.getElementById("root")!).render(<VenueSiteStandalone host={window.location.hostname} />);
  });
} else {
  createRoot(document.getElementById("root")!).render(<App />);

  // The published HTML has no Cache-Control, so browsers can keep last week's app
  // after a publish; reload once when the live build is newer.
  watchForNewBuilds();
}
