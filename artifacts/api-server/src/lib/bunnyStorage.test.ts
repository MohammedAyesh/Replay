/**
 * Coverage for the Bunny Storage leg of the clip export.
 *
 * If the upload silently fails or lands on the wrong path, the symptom the user
 * sees is a download that 404s — so this exercises the real upload against a
 * local HTTPS origin standing in for storage.bunnycdn.com, and checks the
 * round trip lands where getBunnyExportUrl says it will.
 *
 * The upload streams from disk rather than buffering (a CRF-16 export runs to
 * hundreds of megabytes), which needs `duplex: "half"` and an explicit
 * Content-Length; both are easy to break silently, hence the byte comparison.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import https from "https";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";

const PORT = 8943;
const ZONE = "galaxyfield";
const KEY = "test-storage-key";

process.env.BUNNY_STORAGE_HOSTNAME = `127.0.0.1:${PORT}`;
process.env.BUNNY_STORAGE_ZONE = ZONE;
process.env.BUNNY_STORAGE_API_KEY = KEY;
process.env.BUNNY_STORAGE_CDN_URL = `https://127.0.0.1:${PORT}/${ZONE}`;
process.env.CLIP_EXPORT_URL_SECRET = "unit-test-secret";
// The stand-in origin uses a self-signed certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { uploadToBunnyStorage, getBunnyExportUrl, getBunnyExportPath, deleteBunnyExport } =
  await import("./bunny");

/** Everything the fake storage origin received, keyed by path. */
const stored = new Map<string, Buffer>();
const requests: { method: string; url: string; accessKey?: string; contentLength?: string }[] = [];

let server: https.Server;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bunny-test-"));
  const keyPath = path.join(tmpDir, "k.pem");
  const certPath = path.join(tmpDir, "c.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=127.0.0.1",
  ], { stdio: "ignore" });

  server = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (req, res) => {
      const url = req.url ?? "";
      requests.push({
        method: req.method ?? "",
        url,
        accessKey: req.headers.accesskey as string | undefined,
        contentLength: req.headers["content-length"] as string | undefined,
      });
      if (req.headers.accesskey !== KEY) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === "PUT" && url.includes("/clips/999-")) {
        // Sentinel: lets a test drive uploadToBunnyStorage's failure path.
        req.resume();
        res.writeHead(507);
        res.end("insufficient storage");
        return;
      }
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          stored.set(url, Buffer.concat(chunks));
          res.writeHead(201);
          res.end(JSON.stringify({ HttpCode: 201 }));
        });
        return;
      }
      if (req.method === "DELETE") {
        const existed = stored.delete(url);
        res.writeHead(existed ? 200 : 404);
        res.end();
        return;
      }
      const body = stored.get(url);
      if (!body) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(body.length) });
      res.end(body);
    },
  );
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("clip export storage round trip", () => {
  it("streams the rendered file up intact and returns the URL it can be fetched from", async () => {
    // 3 MB, larger than a single socket write, so a truncating bug shows up.
    const payload = crypto.randomBytes(3 * 1024 * 1024);
    const filePath = path.join(tmpDir, "render.mp4");
    fs.writeFileSync(filePath, payload);

    const url = await uploadToBunnyStorage(filePath, 4242);

    expect(url).toBe(getBunnyExportUrl(4242));
    const put = requests.find((r) => r.method === "PUT");
    expect(put?.accessKey).toBe(KEY);
    // Streamed with a declared length, not chunked and not buffered.
    expect(put?.contentLength).toBe(String(payload.length));

    const uploaded = stored.get(`/${ZONE}/${getBunnyExportPath(4242)}`);
    expect(uploaded).toBeDefined();
    expect(Buffer.compare(uploaded!, payload)).toBe(0);

    // And it is actually readable back from the path the URL points at.
    const fetched = await fetch(url, { headers: { AccessKey: KEY } });
    expect(fetched.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await fetched.arrayBuffer()), payload)).toBe(0);
  });

  it("puts the export on an unguessable path, not clips/<id>.mp4", () => {
    const p = getBunnyExportPath(4242);
    expect(p).not.toBe("clips/4242.mp4");
    expect(p).toMatch(/^clips\/4242-[0-9a-f]{24}\.mp4$/);
    // Deterministic, so an existing row's URL can always be re-derived...
    expect(getBunnyExportPath(4242)).toBe(p);
    // ...but neighbouring ids are not walkable from it.
    expect(getBunnyExportPath(4243).slice("clips/4243-".length))
      .not.toBe(p.slice("clips/4242-".length));
  });

  it("throws on a failed upload instead of returning a URL that would 404", async () => {
    const filePath = path.join(tmpDir, "render2.mp4");
    fs.writeFileSync(filePath, crypto.randomBytes(1024));

    // The caller marks the clip exportStatus:"error" off the back of this
    // throw. Swallowing it would leave a row pointing at a path with no object.
    await expect(uploadToBunnyStorage(filePath, 999)).rejects.toThrow(/507/);
    expect(stored.has(`/${ZONE}/${getBunnyExportPath(999)}`)).toBe(false);
  });

  it("deletes both the current and the legacy export paths", async () => {
    stored.set(`/${ZONE}/${getBunnyExportPath(77)}`, Buffer.from("new"));
    stored.set(`/${ZONE}/clips/77.mp4`, Buffer.from("legacy"));

    await deleteBunnyExport(77);

    expect(stored.has(`/${ZONE}/${getBunnyExportPath(77)}`)).toBe(false);
    // Clips exported before the HMAC path existed still live at the old,
    // enumerable location — that is exactly the one worth removing.
    expect(stored.has(`/${ZONE}/clips/77.mp4`)).toBe(false);
  });
});
