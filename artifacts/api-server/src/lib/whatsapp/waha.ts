import { createHmac } from "node:crypto";

/**
 * WAHA (WhatsApp HTTP API) client. WAHA runs as a Docker container on vps1.
 *
 * Configuration needs no new deployment secrets: by default the API is the
 * control-API host on port 3000, and the WAHA key is the control key (vps1 stores
 * only its SHA-512). WAHA_URL / WAHA_API_KEY / WAHA_WEBHOOK_SECRET override.
 */

export type WahaSessionStatus =
  | "STOPPED"
  | "STARTING"
  | "SCAN_QR_CODE"
  | "PASSKEY_REQUIRED"
  | "PASSKEY_CONFIRMATION_REQUIRED"
  | "WORKING"
  | "FAILED";

export type WahaSession = {
  name: string;
  status: WahaSessionStatus | string;
  me: { id: string; pushName?: string | null } | null;
};

export class WahaError extends Error {
  status: number;
  transient: boolean;
  constructor(status: number, message: string, transient: boolean) {
    super(message);
    this.status = status;
    this.transient = transient;
  }
}

export function wahaBaseUrl(): string {
  const explicit = process.env.WAHA_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  let control = process.env.CONTABO_CONTROL_URL?.trim() ?? "";
  if (!control) return "";
  if (!/^https?:\/\//i.test(control)) control = `http://${control}`;
  try {
    const url = new URL(control);
    url.port = process.env.WAHA_PORT?.trim() || "3000";
    url.pathname = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function wahaApiKey(): string {
  return process.env.WAHA_API_KEY?.trim() || process.env.CONTABO_CONTROL_KEY?.trim() || "";
}

export function wahaConfigured(): boolean {
  return Boolean(wahaBaseUrl() && wahaApiKey());
}

/** HMAC key WAHA signs webhooks with. Derived from the API key unless set explicitly. */
export function wahaWebhookSecret(): string {
  const explicit = process.env.WAHA_WEBHOOK_SECRET?.trim();
  if (explicit) return explicit;
  const key = wahaApiKey();
  if (!key) return "";
  return createHmac("sha256", key).update("replay-whatsapp-webhook-v1").digest("hex");
}

/** Shared key vps1's cron presents to /api/whatsapp/tick. */
export function whatsappTickKey(): string {
  return process.env.WHATSAPP_TICK_KEY?.trim() || process.env.CONTABO_CONTROL_KEY?.trim() || "";
}

export function publicBaseUrl(): string {
  return (process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_BASE_URL || "https://replayjo.com").replace(/\/+$/, "");
}

export function webhookUrl(): string {
  return `${publicBaseUrl()}/api/whatsapp/webhook`;
}

export const REPLAY_SESSION = "replay";

export function academySessionName(academyId: number): string {
  return `academy-${academyId}`;
}

export function academyIdFromSessionName(name: string | null | undefined): number | null {
  const match = /^academy-(\d+)$/.exec(name ?? "");
  return match ? Number(match[1]) : null;
}

async function wahaRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { timeoutMs?: number; accept?: string } = {},
): Promise<T> {
  const base = wahaBaseUrl();
  const key = wahaApiKey();
  if (!base || !key) throw new WahaError(503, "WhatsApp service is not configured", false);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "x-api-key": key,
        accept: options.accept ?? "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = (error as { name?: string })?.name === "AbortError";
    throw new WahaError(504, aborted ? "WhatsApp service timed out" : "WhatsApp service unreachable", true);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message = typeof data === "object" && data !== null
      ? String((data as { message?: unknown; error?: unknown }).message ?? (data as { error?: unknown }).error ?? response.statusText)
      : typeof data === "string" && data ? data.slice(0, 300) : response.statusText;
    throw new WahaError(response.status, message, response.status >= 500 || response.status === 429);
  }
  return data as T;
}

function toSession(raw: unknown): WahaSession | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { name?: unknown; status?: unknown; me?: unknown };
  const me = r.me && typeof r.me === "object"
    ? { id: String((r.me as { id?: unknown }).id ?? ""), pushName: ((r.me as { pushName?: unknown }).pushName as string | null) ?? null }
    : null;
  return { name: String(r.name ?? ""), status: String(r.status ?? "STOPPED"), me: me?.id ? me : null };
}

export async function wahaVersion(): Promise<Record<string, unknown>> {
  return wahaRequest("GET", "/api/server/version", undefined, { timeoutMs: 6_000 });
}

export async function listSessions(): Promise<WahaSession[]> {
  const raw = await wahaRequest<unknown[]>("GET", "/api/sessions?all=true", undefined, { timeoutMs: 8_000 });
  return (Array.isArray(raw) ? raw : []).map(toSession).filter((s): s is WahaSession => s !== null);
}

export async function getSession(name: string): Promise<WahaSession | null> {
  try {
    return toSession(await wahaRequest("GET", `/api/sessions/${encodeURIComponent(name)}`, undefined, { timeoutMs: 5_000 }));
  } catch (error) {
    if (error instanceof WahaError && error.status === 404) return null;
    throw error;
  }
}

function sessionConfig(metadata: Record<string, string>) {
  const secret = wahaWebhookSecret();
  return {
    metadata,
    webhooks: [
      {
        url: webhookUrl(),
        events: ["message.any", "message.ack", "session.status"],
        ...(secret ? { hmac: { key: secret } } : {}),
        retries: { policy: "constant", delaySeconds: 5, attempts: 6 },
      },
    ],
  };
}

/** Create the session if missing (or refresh its webhook config) and start it. */
export async function ensureSessionStarted(name: string, metadata: Record<string, string>): Promise<WahaSession> {
  const existing = await getSession(name);
  const config = sessionConfig(metadata);
  if (!existing) {
    const created = await wahaRequest("POST", "/api/sessions", { name, start: true, config });
    return toSession(created) ?? { name, status: "STARTING", me: null };
  }
  await wahaRequest("PUT", `/api/sessions/${encodeURIComponent(name)}`, { name, config });
  if (existing.status === "STOPPED" || existing.status === "FAILED") {
    if (existing.status === "FAILED") {
      await wahaRequest("POST", `/api/sessions/${encodeURIComponent(name)}/restart`).catch(() => undefined);
    } else {
      await wahaRequest("POST", `/api/sessions/${encodeURIComponent(name)}/start`);
    }
  }
  return (await getSession(name)) ?? existing;
}

/** Unlink the phone and stop the session. The session record stays so the owner can relink. */
export async function logoutSession(name: string): Promise<void> {
  await wahaRequest("POST", `/api/sessions/${encodeURIComponent(name)}/logout`).catch((error) => {
    if (!(error instanceof WahaError) || error.status !== 404) throw error;
  });
  await wahaRequest("POST", `/api/sessions/${encodeURIComponent(name)}/stop`).catch(() => undefined);
}

/** QR code as a data URL, or null when WAHA has none (not in SCAN_QR_CODE). */
export async function getQrDataUrl(name: string): Promise<string | null> {
  try {
    const raw = await wahaRequest<{ mimetype?: string; data?: string }>(
      "GET",
      `/api/${encodeURIComponent(name)}/auth/qr?format=image`,
      undefined,
      { accept: "application/json", timeoutMs: 10_000 },
    );
    if (raw && typeof raw.data === "string" && raw.data) return `data:${raw.mimetype || "image/png"};base64,${raw.data}`;
    return null;
  } catch (error) {
    if (error instanceof WahaError && (error.status === 404 || error.status === 422 || error.status === 400)) return null;
    throw error;
  }
}

/** 8-character code the owner types into WhatsApp → Linked devices → Link with phone number. */
export async function requestPairingCode(name: string, phone: string): Promise<string> {
  const raw = await wahaRequest<{ code?: string }>(
    "POST",
    `/api/${encodeURIComponent(name)}/auth/request-code`,
    { phoneNumber: phone },
    { timeoutMs: 20_000 },
  );
  if (!raw?.code) throw new WahaError(502, "WhatsApp did not return a pairing code", true);
  return raw.code;
}

const lidCache = new Map<string, string>();

/**
 * The phone number behind a linked id ("…@lid"), from the session's own mapping. Null when
 * WhatsApp hasn't shared it with this number.
 */
export async function phoneForLid(session: string, lid: string): Promise<string | null> {
  const key = `${session}|${lid}`;
  const cached = lidCache.get(key);
  if (cached) return cached;
  try {
    const raw = await wahaRequest<{ lid?: string; pn?: string | null }>(
      "GET",
      `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`,
      undefined,
      { timeoutMs: 6_000 },
    );
    const pn = typeof raw?.pn === "string" ? raw.pn : null;
    const local = pn?.split("@")[0]?.split(":")[0] ?? "";
    if (!/^\d{8,15}$/.test(local)) return null;
    if (lidCache.size > 5000) lidCache.clear();
    lidCache.set(key, local);
    return local;
  } catch (error) {
    if (error instanceof WahaError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

/** WhatsApp chat id for a number, or null when the number has no WhatsApp account. */
export async function checkNumber(session: string, phone: string): Promise<string | null> {
  const raw = await wahaRequest<{ numberExists?: boolean; chatId?: string }>(
    "GET",
    `/api/contacts/check-exists?phone=${encodeURIComponent(phone)}&session=${encodeURIComponent(session)}`,
    undefined,
    { timeoutMs: 15_000 },
  );
  if (!raw?.numberExists) return null;
  return raw.chatId || `${phone}@c.us`;
}

function messageIdFrom(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { id?: unknown; key?: { id?: unknown } };
  if (typeof r.id === "string") return r.id;
  if (r.id && typeof r.id === "object") {
    const serialized = (r.id as { _serialized?: unknown; id?: unknown })._serialized ?? (r.id as { id?: unknown }).id;
    if (typeof serialized === "string") return serialized;
  }
  if (r.key && typeof r.key.id === "string") return r.key.id;
  return null;
}

export async function sendText(session: string, chatId: string, text: string): Promise<string | null> {
  const raw = await wahaRequest("POST", "/api/sendText", { session, chatId, text, linkPreview: true }, { timeoutMs: 30_000 });
  return messageIdFrom(raw);
}

/** Bare message id for matching acks: WEBJS ids look like "true_9627…@c.us_ABC", GOWS ids are bare. */
export function bareMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const parts = id.split("_");
  return parts.length >= 3 ? parts.slice(2).join("_") : id;
}
