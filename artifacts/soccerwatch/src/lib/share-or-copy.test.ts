import { afterEach, describe, expect, it, vi } from "vitest";
import { shareOrCopy } from "./match-api";

const payload = { title: "Match", text: "Join us", url: "https://example.com/m/abc" };

function stubNavigator(nav: Partial<Navigator>) {
  vi.stubGlobal("navigator", nav);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shareOrCopy", () => {
  it("returns cancelled, and copies nothing, when the person closes the share sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({
      share: vi.fn().mockRejectedValue(new DOMException("Share canceled", "AbortError")),
      clipboard: { writeText } as unknown as Clipboard,
    });
    await expect(shareOrCopy(payload)).resolves.toBe("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("returns shared when the share sheet completes", async () => {
    stubNavigator({ share: vi.fn().mockResolvedValue(undefined) });
    await expect(shareOrCopy(payload)).resolves.toBe("shared");
  });

  it("falls back to copying when sharing fails for another reason", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({
      share: vi.fn().mockRejectedValue(new DOMException("Not allowed", "NotAllowedError")),
      clipboard: { writeText } as unknown as Clipboard,
    });
    await expect(shareOrCopy(payload)).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith("Join us https://example.com/m/abc");
  });

  it("copies when there is no share sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ clipboard: { writeText } as unknown as Clipboard });
    await expect(shareOrCopy(payload)).resolves.toBe("copied");
  });

  it("returns failed when neither sharing nor copying works", async () => {
    stubNavigator({ clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } as unknown as Clipboard });
    await expect(shareOrCopy(payload)).resolves.toBe("failed");
  });
});
