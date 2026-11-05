import { describe, expect, it } from "vitest";
import { isIos, keyBytes, readChatLink } from "./push-notifications";

describe("chat notifications on this device", () => {
  it("reads a notification's link: the academy and the chat", () => {
    expect(readChatLink("?a=12&phone=962790000001")).toEqual({ academyId: 12, phone: "962790000001", thread: null });
    expect(readChatLink("?a=3&thread=41")).toEqual({ academyId: 3, phone: null, thread: 41 });
    expect(readChatLink("?a=x&phone=<script>&thread=-2")).toEqual({ academyId: null, phone: null, thread: null });
    expect(readChatLink("")).toEqual({ academyId: null, phone: null, thread: null });
  });
  it("turns the base64url key into bytes", () => {
    expect([...keyBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });
  it("knows an iPhone (which needs the Home Screen app for notifications)", () => {
    expect(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15")).toBe(true);
    expect(isIos("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130")).toBe(false);
  });
});
