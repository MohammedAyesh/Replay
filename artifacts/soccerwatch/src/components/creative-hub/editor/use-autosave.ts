import { useCallback, useEffect, useRef, useState } from "react";

export type SaveStatus = "saved" | "unsaved" | "saving" | "error";

/**
 * Debounced autosave. `version` changes whenever something worth saving
 * changes; `payload()` reads the latest value at save time. Saves never
 * overlap: a change made while one is in flight is saved straight after it.
 * Whatever is left unsaved is sent when the editor unmounts (switching tab or
 * project) and the browser warns before the page closes with unsaved work.
 */
export function useAutosave<T>(version: string, payload: () => T, save: (value: T) => Promise<unknown>, delayMs = 900) {
  const [status, setStatus] = useState<SaveStatus>("saved");
  const savedVersion = useRef(version);
  const currentVersion = useRef(version);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const payloadRef = useRef(payload);
  const saveRef = useRef(save);
  payloadRef.current = payload;
  saveRef.current = save;
  currentVersion.current = version;
  const mounted = useRef(true);
  const pending = useRef<Promise<unknown>>(Promise.resolve());

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (inFlight.current || currentVersion.current === savedVersion.current) return;
    inFlight.current = true;
    const v = currentVersion.current;
    if (mounted.current) setStatus("saving");
    try {
      const p = saveRef.current(payloadRef.current());
      pending.current = p.catch(() => undefined);
      await p;
      savedVersion.current = v;
      inFlight.current = false;
      if (!mounted.current) return;
      if (currentVersion.current !== savedVersion.current) { void flush(); return; }
      if (mounted.current) setStatus("saved");
    } catch {
      inFlight.current = false;
      if (!mounted.current) return;
      setStatus("error");
      timer.current = setTimeout(() => void flush(), 4000);
    }
  }, []);

  useEffect(() => {
    if (version === savedVersion.current) return;
    setStatus((s) => (s === "saving" ? s : "unsaved"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delayMs);
  }, [version, delayMs, flush]);

  useEffect(() => {
    mounted.current = true;
    const warn = (e: BeforeUnloadEvent) => {
      if (currentVersion.current === savedVersion.current) return;
      void flush();
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      // The mutation outlives the component: the last edits still reach the server.
      // A save still in flight goes first so the older copy cannot land last.
      if (currentVersion.current !== savedVersion.current) {
        const last = payloadRef.current();
        void pending.current.then(() => saveRef.current(last)).catch(() => undefined);
      }
    };
  }, [flush]);

  return { status, flush };
}
