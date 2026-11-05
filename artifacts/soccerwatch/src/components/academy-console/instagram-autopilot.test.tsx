import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

(globalThis as { React?: typeof React }).React = React;
const state = vi.hoisted(() => ({ locale: "en" as "en" | "ar" }));
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: state.locale, setLocale: () => {} }) }));
vi.mock("@/lib/venue-api", async (orig) => ({ ...(await orig<typeof import("@/lib/venue-api")>()), ammanToday: () => "2026-11-05" }));
// The row pictures read each design (useDesign): none here, so they draw an empty frame.
vi.mock("@/lib/creative-hub-api", () => ({ useCreativeProject: () => ({ isLoading: false, data: null }), useCreativeBrand: () => ({ isLoading: false, data: null }) }));
vi.mock("@/lib/academy-instagram-api", () => {
  const proj = (id: number, title: string, kind: "image" | "video", origin: "auto" | "manual" = "auto") => ({ id, title, kind, format: "post", templateKey: null, origin, renderStatus: "none", outputUrl: null, createdAt: "" });
  const item = (id: number, title: string, slot: string | null, status: string, extra = {}) => ({ id, projectId: id, placement: "feed", status, pinned: false, slotAt: slot, slotLocal: slot, error: null, igPermalink: null, publishedAt: null, project: proj(id, title, "image"), ...extra });
  const data = {
    settings: { enabled: true, publishMode: "approve", times: { feed: ["18:00"], reel: ["20:30"], story: ["13:00"] } },
    instagram: { connected: false, username: null },
    items: [item(1, "Full time", "2026-11-05 18:00", "planned"), item(2, "Kid post", null, "skipped", { error: "A player in it has no public-post consent from his family", slotLocal: "2026-11-06 18:00" })],
    suggestions: [{ ...proj(9, "Training highlights", "video", "manual"), placement: "reel" }],
  };
  const m = { mutate: () => {}, isPending: false, isSuccess: false, error: null };
  return {
    useAcademyInstagram: () => ({ isLoading: false, isError: false, data }),
    useAcademyInstagramToday: () => ({ data: { enabled: false, publishMode: "approve", connected: true, items: [], suggestions: data.suggestions } }),
    useAcademyInstagramActions: () => ({ settings: m, add: m, action: m, move: m }),
  };
});

import { AcademyInstagramAutopilot, AcademyInstagramToday } from "./instagram-autopilot";

describe("Academy Instagram autopilot", () => {
  it("shows the switch, times, suggestions and the calendar, and says when Instagram isn't connected", () => {
    state.locale = "en";
    const html = renderToStaticMarkup(<AcademyInstagramAutopilot academyId={1} />);
    expect(html).toContain('data-testid="switch-academy-ig"');
    expect(html).toContain("Connect Instagram first");
    expect(html).toContain('data-testid="academy-ig-times"');
    expect(html).toContain('data-testid="academy-ig-suggestion-9"');
    expect(html).toContain('data-testid="academy-ig-approve-1"');
    expect(html).toContain("Needs your OK");
    expect(html).toContain('data-testid="academy-ig-restore-2"');
  });
  it("is in Arabic, the server's reasons too", () => {
    state.locale = "ar";
    const html = renderToStaticMarkup(<AcademyInstagramAutopilot academyId={1} />);
    expect(html).toContain("أوتوبايلوت إنستغرام");
    expect(html).toContain("في لاعب فيها ما عنده موافقة أهله على النشر العام");
    expect(html).toContain("اقتراحات جاية");
  });
  it("puts today's Instagram and the suggestions on the Overview", () => {
    state.locale = "en";
    const html = renderToStaticMarkup(<AcademyInstagramToday academyId={1} onOpen={() => {}} />);
    expect(html).toContain("Instagram today");
    expect(html).toContain("Nothing goes out on Instagram today.");
    expect(html).toContain("Autopilot off");
    expect(html).toContain("Training highlights");
  });
});
