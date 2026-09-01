import { createRoot } from "react-dom/client";
import App from "./App";
import { primeVideoCacheWorker } from "./lib/video-cache";
import { isTransientClerkSessionTouchError } from "./lib/clerk-network";
import "./index.css";

// Register early so the worker controls Claim Match before HLS initializes.
// It does not cache anything until the player sends its first Play event.
void primeVideoCacheWorker();

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

createRoot(document.getElementById("root")!).render(<App />);
