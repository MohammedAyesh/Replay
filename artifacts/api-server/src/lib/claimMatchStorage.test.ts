import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createReadStreamMock } = vi.hoisted(() => ({
  createReadStreamMock: vi.fn(),
}));

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket() {
      return {
        file() {
          return { createReadStream: createReadStreamMock };
        },
      };
    }
  },
}));

import {
  CLAIM_SEGMENT_DOWNLOAD_TIMEOUT_MS,
  readClaimSegment,
  readCompressedClaimSegment,
} from "./claimMatchStorage";

describe("claim segment storage downloads", () => {
  beforeEach(() => {
    vi.stubEnv("PRIVATE_OBJECT_DIR", "/test/private");
  });

  afterEach(() => {
    createReadStreamMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("uses a 60-second timeout that destroys a stalled segment download", async () => {
    expect(CLAIM_SEGMENT_DOWNLOAD_TIMEOUT_MS).toBe(60_000);

    for (const read of [readClaimSegment, readCompressedClaimSegment]) {
      const stream = new PassThrough();
      createReadStreamMock.mockReturnValueOnce(stream);

      await expect(read("/objects/claim-match/segment.json", 5))
        .rejects.toThrow("timed out after 5ms");
      expect(stream.destroyed).toBe(true);
    }

    expect(createReadStreamMock).toHaveBeenCalledTimes(2);
    expect(createReadStreamMock).toHaveBeenCalledWith({ decompress: false });
  });
});