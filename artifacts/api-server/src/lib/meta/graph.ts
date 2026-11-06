import { createHmac } from "node:crypto";
import { metaConfig, type MetaConfig } from "./config";

export class MetaGraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number, readonly subcode?: number) {
    super(message);
  }
}

function withAuth(params: Record<string, string>, config: MetaConfig, token?: string): URLSearchParams {
  const access = token ?? config.token;
  if (!access) throw new MetaGraphError("Meta is not connected (META_ACCESS_TOKEN is not set)", 503);
  const search = new URLSearchParams(params);
  search.set("access_token", access);
  if (config.appSecret) search.set("appsecret_proof", createHmac("sha256", config.appSecret).update(access).digest("hex"));
  return search;
}

async function parse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as {
    error?: { message?: string; code?: number; error_subcode?: number };
  } | null;
  if (!response.ok || data?.error) {
    throw new MetaGraphError(
      data?.error?.message ?? `Meta returned ${response.status}`,
      response.status,
      data?.error?.code,
      data?.error?.error_subcode,
    );
  }
  return data as T;
}

export async function graphGetWithStatus<T>(
  path: string,
  params: Record<string, string> = {},
  options: { token?: string; config?: MetaConfig } = {},
): Promise<{ data: T; status: number }> {
  const config = options.config ?? metaConfig();
  const url = `https://graph.facebook.com/${config.graphVersion}/${path.replace(/^\//, "")}?${withAuth(params, config, options.token)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  return { data: await parse<T>(response), status: response.status };
}

export async function graphGet<T>(path: string, params: Record<string, string> = {}, options: { token?: string; config?: MetaConfig } = {}): Promise<T> {
  return (await graphGetWithStatus<T>(path, params, options)).data;
}

export async function graphPost<T>(path: string, params: Record<string, string> = {}, options: { token?: string; config?: MetaConfig } = {}): Promise<T> {
  const config = options.config ?? metaConfig();
  const url = `https://graph.facebook.com/${config.graphVersion}/${path.replace(/^\//, "")}`;
  return parse<T>(await fetch(url, { method: "POST", body: withAuth(params, config, options.token), signal: AbortSignal.timeout(20_000) }));
}

/** Every page of a list edge, up to a sane cap. */
export async function graphAll<T>(path: string, params: Record<string, string> = {}, maxPages = 20, token?: string): Promise<T[]> {
  const config = metaConfig();
  const out: T[] = [];
  let page = await graphGet<{ data: T[]; paging?: { next?: string } }>(path, params, { config, token });
  out.push(...(page.data ?? []));
  for (let n = 1; n < maxPages && page.paging?.next; n += 1) {
    page = await parse<{ data: T[]; paging?: { next?: string } }>(await fetch(page.paging.next, { signal: AbortSignal.timeout(20_000) }));
    out.push(...(page.data ?? []));
  }
  return out;
}

export async function graphDelete(path: string, options: { token?: string } = {}): Promise<void> {
  const config = metaConfig();
  const url = `https://graph.facebook.com/${config.graphVersion}/${path.replace(/^\//, "")}?${withAuth({}, config, options.token)}`;
  await parse(await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(20_000) }));
}

/**
 * Upload a video file to an ad account (graph-video host, multipart, streamed from disk).
 * Returns Meta's video id; it is processed afterwards (see waitForVideo).
 */
export async function graphUploadVideo(act: string, filePath: string, name: string, options: { token?: string } = {}): Promise<string> {
  const { openAsBlob } = await import("node:fs");
  const config = metaConfig();
  const form = new FormData();
  for (const [key, value] of withAuth({ name: name.slice(0, 100) || "Replay video" }, config, options.token)) form.append(key, value);
  form.append("source", await openAsBlob(filePath, { type: "video/mp4" }), "video.mp4");
  const url = `https://graph-video.facebook.com/${config.graphVersion}/${act.replace(/^\//, "")}/advideos`;
  const res = await parse<{ id?: string }>(await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(15 * 60_000) }));
  if (!res.id) throw new MetaGraphError("Meta didn't accept the video", 502);
  return res.id;
}

export type VideoState = "ready" | "processing" | "error";

export async function videoState(videoId: string, options: { token?: string } = {}): Promise<VideoState> {
  const res = await graphGet<{ status?: { video_status?: string } }>(videoId, { fields: "status" }, options);
  const status = res.status?.video_status ?? "processing";
  return status === "ready" ? "ready" : status === "error" ? "error" : "processing";
}

/** Poll until Meta has processed the video, or the time runs out. */
export async function waitForVideo(videoId: string, options: { token?: string; timeoutMs?: number; intervalMs?: number } = {}): Promise<VideoState> {
  const until = Date.now() + (options.timeoutMs ?? 90_000);
  for (;;) {
    const state = await videoState(videoId, options);
    if (state !== "processing" || Date.now() >= until) return state;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 5000));
  }
}
