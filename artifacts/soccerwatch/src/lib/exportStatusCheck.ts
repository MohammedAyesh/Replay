import { reconcileExportState, type ExportStatusResponse } from "./downloadQuota";

export type CachedExportFallback = "ready" | "idle";
export type InitialExportResolution =
  | { state: "ready"; url: string }
  | { state: "unavailable" }
  | { state: "polling"; label: string | null }
  | { state: "idle" };

export function cachedExportFallback(
  exportStatus: string | null | undefined,
  exportedUrl: string | null | undefined,
): CachedExportFallback {
  return exportStatus === "done" && !!exportedUrl ? "ready" : "idle";
}

export function resolveInitialExportStatus(status: ExportStatusResponse): InitialExportResolution {
  const next = reconcileExportState(status);
  if (next.state === "ready" && next.url) return { state: "ready", url: next.url };
  if (next.state === "unavailable") return { state: "unavailable" };
  if (status.status === "unverified") return { state: "idle" };
  if (next.resume) return { state: "polling", label: next.label };
  return { state: "idle" };
}

export async function checkInitialExportStatus(
  request: (signal: AbortSignal) => Promise<Response>,
  timeoutMs = 10_000,
): Promise<ExportStatusResponse | null> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      (async (): Promise<ExportStatusResponse | null> => {
        const res = await request(controller.signal);
        if (!res.ok) return null;
        const body: unknown = await res.json();
        if (!body || typeof body !== "object" || Array.isArray(body)
          || typeof (body as { status?: unknown }).status !== "string") {
          return null;
        }
        return body as ExportStatusResponse;
      })(),
      timeout,
    ]);
    return response;
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
