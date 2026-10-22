import type { ExportStatusResponse } from "./downloadQuota";

export type CachedExportFallback = "ready" | "idle";

export function cachedExportFallback(
  exportStatus: string | null | undefined,
  exportedUrl: string | null | undefined,
): CachedExportFallback {
  return exportStatus === "done" && !!exportedUrl ? "ready" : "idle";
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
