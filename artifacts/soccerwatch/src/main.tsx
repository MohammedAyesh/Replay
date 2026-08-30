import { createRoot } from "react-dom/client";
import App from "./App";
import { primeVideoCacheWorker } from "./lib/video-cache";
import "./index.css";

// Register early so the worker controls Claim Match before HLS initializes.
// It does not cache anything until the player sends its first Play event.
void primeVideoCacheWorker();

createRoot(document.getElementById("root")!).render(<App />);
