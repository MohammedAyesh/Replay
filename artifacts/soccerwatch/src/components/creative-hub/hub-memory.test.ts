import { afterEach, describe, expect, it } from "vitest";
import { rememberedHub } from "./hub";

const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }, location: { search: "" } };

afterEach(() => store.clear());

describe("the Creative hub remembers where you were", () => {
  it("reopens the last tab and design for that academy, and ignores anything broken", () => {
    store.set("replay:creative-hub:7", JSON.stringify({ tab: "publish", projectId: 42 }));
    expect(rememberedHub(7)).toEqual({ tab: "publish", projectId: 42 });
    expect(rememberedHub(8)).toEqual({ tab: null, projectId: null });
    store.set("replay:creative-hub:9", "{nope");
    expect(rememberedHub(9)).toEqual({ tab: null, projectId: null });
    store.set("replay:creative-hub:10", JSON.stringify({ tab: "elsewhere", projectId: -3 }));
    expect(rememberedHub(10)).toEqual({ tab: null, projectId: null });
  });
});
