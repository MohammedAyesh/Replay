import { describe, expect, it } from "vitest";
import type { TrackingManifest } from "@workspace/db";
import { withFreshManifest, type RecordingPlay } from "./matchPlayLoad";

describe("cached recording play manifests", () => {
  it("returns cached derived play with the freshly read manifest", () => {
    const oldManifest = { identities: [{ id: "old" }] } as unknown as TrackingManifest;
    const freshManifest = { identities: [{ id: "claimed" }] } as unknown as TrackingManifest;
    const cached = {
      manifest: oldManifest,
      recordingId: 393,
      touches: [],
    } as unknown as RecordingPlay;

    const result = withFreshManifest(cached, freshManifest);

    expect(result).not.toBe(cached);
    expect(result.manifest).toBe(freshManifest);
    expect(cached.manifest).toBe(oldManifest);
    expect(result.touches).toBe(cached.touches);
  });
});
