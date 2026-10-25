import { describe, expect, it, vi } from "vitest";
import { enterKitAfterLoadingCurrentChunk } from "./roster-navigation";

describe("enterKitAfterLoadingCurrentChunk", () => {
  it("loads the current chunk before navigating to the kit step", async () => {
    const calls: string[] = [];
    const ensure = vi.fn(async (chunk: number) => {
      calls.push(`loaded:${chunk}`);
    });
    const navigate = vi.fn((step: "kit") => {
      calls.push(`step:${step}`);
    });

    await enterKitAfterLoadingCurrentChunk(4, ensure, navigate);

    expect(calls).toEqual(["loaded:4", "step:kit"]);
    expect(ensure).toHaveBeenCalledWith(4);
    expect(navigate).toHaveBeenCalledWith("kit");
  });
});
