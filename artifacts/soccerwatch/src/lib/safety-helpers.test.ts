import { describe, expect, it } from "vitest";
import { hiddenClipNoticeText, hiddenNoticeFor, reportErrorMessage, reportReasonsFor } from "@/i18n/safety-strings";

describe("safety helpers", () => {
  it("only offers the removal request reason for clips", () => {
    expect(reportReasonsFor("user_clip")).toContain("im_in_this_clip");
    expect(reportReasonsFor("user")).not.toContain("im_in_this_clip");
  });

  it.each([
    ["already_reported", "You've already reported this.", "إنت بلّغت عن هاد من قبل."],
    ["rate_limited", "You've sent a lot of reports today. Try again tomorrow.", "بعثت بلاغات كثيرة اليوم. جرّب بكرا."],
    ["self", "You can't report or block yourself.", "ما بتقدر تبلّغ أو تحظر حالك."],
    ["unknown", "Something went wrong. Try again.", "صار إشي غلط. جرّب مرة ثانية."],
  ])("maps %s errors exactly in English and Arabic", (reason, en, ar) => {
    expect(reportErrorMessage(reason, "en")).toBe(en);
    expect(reportErrorMessage(reason, "ar")).toBe(ar);
  });

  it("uses generic copy for any unrecognized report error", () => {
    expect(reportErrorMessage("not_known", "en")).toBe("Something went wrong. Try again.");
    expect(reportErrorMessage("not_known", "ar")).toBe("صار إشي غلط. جرّب مرة ثانية.");
  });

  it.each(["removal_request", "reports", "admin"] as const)("chooses the %s hidden notice in both locales", (reason) => {
    expect(hiddenNoticeFor(reason, "en")).toBeTruthy();
    expect(hiddenNoticeFor(reason, "ar")).toBeTruthy();
  });

  it("uses the Replay fallback when there is no hidden reason", () => {
    expect(hiddenNoticeFor(null, "en")).toBe("Hidden by Replay.");
    expect(hiddenNoticeFor(undefined, "ar")).toBe("مخفي من Replay.");
  });

  it("exposes the integration helper for every hidden state", () => {
    expect(hiddenClipNoticeText("removal_request", "en")).toContain("asked for it");
    expect(hiddenClipNoticeText("reports", "ar")).toContain("بلاغات");
    expect(hiddenClipNoticeText("admin", "en")).toBe("Hidden by Replay.");
    expect(hiddenClipNoticeText(null, "ar")).toBe("مخفي من Replay.");
  });
});
