import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The decision logic is pure; the database is never touched in these tests.
vi.mock("@workspace/db", () => ({ db: {}, userClipsTable: {} }));
vi.mock("./bunny", () => ({
  BUNNY_STORAGE_API_KEY: "test-storage-key",
  BUNNY_STORAGE_ZONE: "galaxyfield",
  isBunnyStorageUrl: (candidate: string) => {
    try {
      return new URL(candidate).hostname === "storage.test";
    } catch {
      return false;
    }
  },
}));

import { decideBackupAction, BACKUP_MAX_RELAUNCHES, backupSpecFor } from "./exportFailover";
import {
  backupExportRef,
  backupJobFromRef,
  fetchExportObject,
  isBackupExportRef,
  isBackupExportConfigured,
  validatedBackupStorageUrl,
} from "./backupExport";

const st = (status: string, errorKind: string | null = null) => ({
  status: status as "queued" | "fetching" | "encoding" | "ready" | "failed",
  errorKind,
  progress: 0,
  stage: null,
  error: null,
});

describe("decideBackupAction — when is an export really failed", () => {
  it("finishes on ready and waits while the backup is working", () => {
    expect(decideBackupAction(st("ready"), 0)).toBe("done");
    for (const s of ["queued", "fetching", "encoding"]) expect(decideBackupAction(st(s), 0)).toBe("running");
  });

  it("maps a recording that no longer exists to expired, never to a retry", () => {
    expect(decideBackupAction(st("failed", "source_gone"), 0)).toBe("expired");
  });

  it("does not retry a request that can never succeed", () => {
    expect(decideBackupAction(st("failed", "permanent"), 0)).toBe("error");
  });

  it("relaunches transient failures, lost workers and disk pauses a bounded number of times", () => {
    for (const kind of ["transient", "lost", "disk", null]) {
      expect(decideBackupAction(st("failed", kind), 0)).toBe("relaunch");
      expect(decideBackupAction(st("failed", kind), BACKUP_MAX_RELAUNCHES - 1)).toBe("relaunch");
      expect(decideBackupAction(st("failed", kind), BACKUP_MAX_RELAUNCHES)).toBe("error");
    }
  });
});

describe("backup export references", () => {
  it("round-trips a job id and rejects anything else", () => {
    const ref = backupExportRef("c658-0123456789abcdef");
    expect(ref).toBe("vps1-export:c658-0123456789abcdef");
    expect(isBackupExportRef(ref)).toBe(true);
    expect(backupJobFromRef(ref)).toBe("c658-0123456789abcdef");
    expect(backupJobFromRef("vps1-export:../../etc/passwd")).toBeNull();
    expect(isBackupExportRef("https://storage.bunnycdn.com/galaxyfield/clips/1-x.mp4")).toBe(false);
    expect(isBackupExportRef(null)).toBe(false);
  });

  it("builds the spec from the stored clip row, fractions untouched", () => {
    const spec = backupSpecFor({
      id: 658, videoId: "1e69d9ea-e5ef-4c20-990d-a4fd678f7ace", startTime: "0.763406", endTime: "0.765336",
      cropPath: [{ t: 0, x: 0.5, y: 0, w: 0.5, h: 1 }], aspectRatio: "16:9", title: "Roman Goal",
    } as never, "https://storage.bunnycdn.com/galaxyfield/branding/global/overlay.png");
    expect(spec).toMatchObject({ clipId: 658, startTime: 0.763406, endTime: 0.765336, aspectRatio: "16:9" });
    expect(spec.overlayUrl).toContain("overlay.png");
  });

  it("accepts only the validated Bunny Storage object for that clip and vps1 job", () => {
    const job = "c658-0123456789abcdef";
    const expected = `https://storage.test/galaxyfield/clips/${job}.mp4`;
    const status = {
      job,
      clipId: 658,
      storageUrl: expected,
    } as Parameters<typeof validatedBackupStorageUrl>[0];

    expect(validatedBackupStorageUrl(status)).toBe(expected);
    expect(validatedBackupStorageUrl({
      ...status,
      storageUrl: `https://storage.test/other-zone/clips/${job}.mp4`,
    })).toBeNull();
    expect(validatedBackupStorageUrl({
      ...status,
      storageUrl: "https://storage.test/galaxyfield/clips/c659-0123456789abcdef.mp4",
    })).toBeNull();
    expect(validatedBackupStorageUrl({
      ...status,
      storageUrl: `${expected}?download=1`,
    })).toBeNull();
    expect(validatedBackupStorageUrl({
      ...status,
      storageUrl: expected.replace("https:", "http:"),
    })).toBeNull();
  });
});

describe("fetchExportObject — one reader for both methods' files", () => {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  let calls: { url: string; headers: Record<string, string> }[] = [];
  beforeEach(() => {
    calls = [];
    process.env.CONTABO_CONTROL_URL = "169.58.73.17:8080";
    process.env.CONTABO_CONTROL_KEY = "k";
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("x", { status: 206 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = { ...env };
  });

  it("reads a backup export from the vps1 control API with the key and the Range", async () => {
    expect(isBackupExportConfigured()).toBe(true);
    await fetchExportObject("vps1-export:c658-0123456789abcdef", { range: "bytes=0-0" });
    expect(calls[0].url).toBe("http://169.58.73.17:8080/export/clip/c658-0123456789abcdef/file");
    expect(calls[0].headers["X-Api-Key"]).toBe("k");
    expect(calls[0].headers.Range).toBe("bytes=0-0");
  });

  it("never sends the control key to a storage URL", async () => {
    await fetchExportObject("https://example.com/clips/1.mp4");
    expect(calls[0].url).toBe("https://example.com/clips/1.mp4");
    expect(calls[0].headers["X-Api-Key"]).toBeUndefined();
  });

  it("can be switched off without a deploy", () => {
    process.env.BACKUP_EXPORT_DISABLED = "1";
    expect(isBackupExportConfigured()).toBe(false);
  });
});
