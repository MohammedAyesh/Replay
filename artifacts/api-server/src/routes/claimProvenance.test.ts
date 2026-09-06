/**
 * The pipeline's provenance surviving upload.
 *
 * relink2.py writes the whole chain -- detector, conf, tile settings,
 * `linker=relink2.py`, its gates, the source json -- into the bundle's
 * manifest.provenance, and the identity board has a display for it. Both
 * upload parsers built the stored manifest from a fixed key allowlist that
 * provenance was not on, so the relinker wrote it, the board rendered its
 * "no provenance (original linker)" fallback, and no recording could be
 * attributed to the linker that produced it. Which is the one thing you need
 * when you are comparing linker branches against each other.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/claimMatchStorage", () => ({
  deleteClaimSegment: vi.fn(),
  readClaimSegment: vi.fn(),
  readCompressedClaimSegment: vi.fn(),
  writeClaimSegment: vi.fn(),
}));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalAccountUserId: vi.fn(),
  getLocalUserId: vi.fn(),
  unauthenticatedResponse: vi.fn(),
}));

import { sanitizeUploadedProvenance } from "./claimMatch";

/** The shape the 08-30 notes record relink2.py writing. */
const REAL_CHAIN = "detector=yolo11s-seg.pt conf=0.25 conf_low=0.1 tilew=1536 "
  + "linker=relink2.py reemerge_m=9.0 reach_mps=4.0 occ_max_s=14.0 app_gate=0.7 "
  + "prov_src=match\\c0_clean_tile.json";

describe("carrying the pipeline's provenance through", () => {
  it("keeps a keyed stamp, which is what the identity board reads", () => {
    expect(sanitizeUploadedProvenance({ linker: "relink2.py (occ_max_s=14.0)" }))
      .toEqual({ linker: "relink2.py (occ_max_s=14.0)" });
  });

  it("keeps a bare one-line chain under `chain` rather than dropping it", () => {
    // The writer is on the GPU workstation and its exact shape is not pinned
    // down here, so both readings of "the whole chain in one line" survive.
    expect(sanitizeUploadedProvenance(REAL_CHAIN)).toEqual({ chain: REAL_CHAIN });
  });

  it("keeps scalars of every kind and drops structures", () => {
    expect(sanitizeUploadedProvenance({
      linker: "relink2.py",
      occ_max_s: 14,
      tiled: true,
      nested: { no: 1 },
      list: [1, 2],
      nothing: null,
    })).toEqual({ linker: "relink2.py", occ_max_s: 14, tiled: true });
  });

  it("refuses to let an upload forge the server's own fingerprints", () => {
    // These are written downstream. Taken from the upload, a bundle could
    // claim its identity map matches tracking it was never built from, and
    // usableIdentityMap would then hand out a map for the wrong bundle.
    expect(sanitizeUploadedProvenance({
      bundleFingerprint: "forged",
      identityMapBundleFingerprint: "forged",
      linker: "relink2.py",
    })).toEqual({ linker: "relink2.py" });
  });

  it("bounds what an upload can park in the manifest jsonb", () => {
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) huge[`k${i}`] = "x".repeat(9000);
    const out = sanitizeUploadedProvenance(huge)!;
    expect(Object.keys(out)).toHaveLength(24);
    expect((out.k0 as string).length).toBe(2000);
  });

  it("is absent rather than empty when there is nothing to record", () => {
    expect(sanitizeUploadedProvenance(undefined)).toBeUndefined();
    expect(sanitizeUploadedProvenance(null)).toBeUndefined();
    expect(sanitizeUploadedProvenance("   ")).toBeUndefined();
    expect(sanitizeUploadedProvenance([1, 2])).toBeUndefined();
    expect(sanitizeUploadedProvenance({ nested: { only: 1 } })).toBeUndefined();
  });
});
