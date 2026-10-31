import { useCallback } from "react";
import { useLocation } from "wouter";
import { pageBackTarget, previousInAppLocation } from "./find-nav";

/** Back for an ordinary app page: an earlier Replay page if there is one, else `fallback`. */
export function usePageBack(fallback = "/home"): () => void {
  const [location, setLocation] = useLocation();
  return useCallback(() => {
    const target = pageBackTarget(previousInAppLocation(), location, fallback);
    if (target.kind === "history") window.history.back();
    else setLocation(target.path);
  }, [fallback, location, setLocation]);
}
