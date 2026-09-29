/**
 * Regression for 2026-09-29: the branding overlay returned 401 from Bunny
 * Storage, FFmpeg exited 8, and five exports in a row failed for a logo. A
 * branding asset that cannot be fetched must come back as "leave it out".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import fs from "fs";
import { fetchBrandingAsset } from "./brandingFetch";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/ok.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(PNG); return; }
    if (req.url === "/denied.png") { res.writeHead(401); res.end('{"HttpCode":401,"Message":"Unauthorized"}'); return; }
    if (req.url === "/empty.png") { res.writeHead(200); res.end(); return; }
    if (req.url === "/hang.png") { return; } // accepts, never answers
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.closeAllConnections?.(); server.close(); });

describe("fetchBrandingAsset", () => {
  it("downloads a reachable asset to a local file", async () => {
    const p = await fetchBrandingAsset(`${base}/ok.png`, "overlay");
    expect(p).toBeTruthy();
    expect(p!.endsWith(".png")).toBe(true);
    expect(fs.readFileSync(p!)).toEqual(PNG);
    fs.unlinkSync(p!);
  });

  it("returns null instead of failing the export on 401 (the production incident)", async () => {
    expect(await fetchBrandingAsset(`${base}/denied.png`, "overlay")).toBeNull();
  });

  it("returns null for a missing, empty or hanging asset", async () => {
    expect(await fetchBrandingAsset(`${base}/missing.png`, "end card")).toBeNull();
    expect(await fetchBrandingAsset(`${base}/empty.png`, "overlay")).toBeNull();
    expect(await fetchBrandingAsset(`${base}/hang.png`, "intro", { timeoutMs: 300 })).toBeNull();
  });

  it("passes a local path through and ignores nothing-to-fetch", async () => {
    expect(await fetchBrandingAsset(undefined, "overlay")).toBeNull();
    expect(await fetchBrandingAsset("/definitely/not/here.png", "overlay")).toBeNull();
    const local = __filename;
    expect(await fetchBrandingAsset(local, "overlay")).toBe(local);
  });
});
