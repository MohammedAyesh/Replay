import { describe, expect, it } from "vitest";
import { mayReloadForChunk } from "./lazy-page";

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
}

describe("reloading for a chunk that is gone after a publish", () => {
  it("reloads once, and not again within a minute", () => {
    const storage = memoryStorage();
    expect(mayReloadForChunk(1_000_000, storage)).toBe(true);
    expect(mayReloadForChunk(1_030_000, storage)).toBe(false);
    expect(mayReloadForChunk(1_061_000, storage)).toBe(true);
  });

  it("never reloads without storage to remember it in", () => {
    expect(mayReloadForChunk(1_000_000, null)).toBe(false);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined };
    expect(mayReloadForChunk(1_000_000, broken)).toBe(false);
  });
});
