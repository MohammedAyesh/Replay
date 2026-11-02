import { createHmac } from "node:crypto";
import { metaConfig, type MetaConfig } from "./config";

export class MetaGraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
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
  const data = (await response.json().catch(() => null)) as { error?: { message?: string; code?: number } } | null;
  if (!response.ok || data?.error) {
    throw new MetaGraphError(data?.error?.message ?? `Meta returned ${response.status}`, response.status, data?.error?.code);
  }
  return data as T;
}

export async function graphGet<T>(path: string, params: Record<string, string> = {}, options: { token?: string; config?: MetaConfig } = {}): Promise<T> {
  const config = options.config ?? metaConfig();
  const url = `https://graph.facebook.com/${config.graphVersion}/${path.replace(/^\//, "")}?${withAuth(params, config, options.token)}`;
  return parse<T>(await fetch(url, { signal: AbortSignal.timeout(20_000) }));
}

export async function graphPost<T>(path: string, params: Record<string, string> = {}, options: { token?: string; config?: MetaConfig } = {}): Promise<T> {
  const config = options.config ?? metaConfig();
  const url = `https://graph.facebook.com/${config.graphVersion}/${path.replace(/^\//, "")}`;
  return parse<T>(await fetch(url, { method: "POST", body: withAuth(params, config, options.token), signal: AbortSignal.timeout(20_000) }));
}

/** Every page of a list edge, up to a sane cap. */
export async function graphAll<T>(path: string, params: Record<string, string> = {}, maxPages = 20): Promise<T[]> {
  const config = metaConfig();
  const out: T[] = [];
  let page = await graphGet<{ data: T[]; paging?: { next?: string } }>(path, params, { config });
  out.push(...(page.data ?? []));
  for (let n = 1; n < maxPages && page.paging?.next; n += 1) {
    page = await parse<{ data: T[]; paging?: { next?: string } }>(await fetch(page.paging.next, { signal: AbortSignal.timeout(20_000) }));
    out.push(...(page.data ?? []));
  }
  return out;
}
