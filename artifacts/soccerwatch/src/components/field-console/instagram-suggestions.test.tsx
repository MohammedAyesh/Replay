import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IgToday } from "@/lib/instagram-api";

(globalThis as { React?: typeof React }).React = React;
const state = vi.hoisted(() => ({ locale: "en" as "en" | "ar", today: null as unknown }));
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: state.locale, setLocale: () => {} }) }));
vi.mock("@/lib/venue-api", async (orig) => ({ ...(await orig<typeof import("@/lib/venue-api")>()), ammanToday: () => "2026-11-05" }));
vi.mock("@/lib/instagram-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/instagram-api")>()),
  useAddSuggestion: () => ({ mutate: () => {}, isPending: false, error: null }),
  useInstagramToday: () => ({ data: state.today, isLoading: false, isError: false, error: null }),
}));

import { SuggestionList } from "./instagram-suggestions";
import { InstagramToday } from "./dashboard-section";

const suggestions = [
  { kind: "open_slots", placement: "story", at: "2026-11-05 17:00", originKey: "slots:2026-11-05" },
  { kind: "top5", placement: "reel", at: "2026-11-09 21:00", originKey: "top5:2026-11-01" },
] as const;

describe("Instagram suggestions", () => {
  it("lists each next post with its time and an Add now button", () => {
    state.locale = "en";
    const html = renderToStaticMarkup(<SuggestionList venueId={1} suggestions={[...suggestions]} />);
    expect(html).toContain('data-testid="ig-suggestion-open_slots"');
    expect(html).toContain("Free tonight");
    expect(html).toContain("Today");
    expect(html).toContain("Top 5 of the week");
    expect(html).toContain("Reel");
    expect(html.match(/Add now/g)).toHaveLength(2);
  });
  it("is in Arabic in Arabic", () => {
    state.locale = "ar";
    const html = renderToStaticMarkup(<SuggestionList venueId={1} suggestions={[...suggestions]} />);
    expect(html).toContain("فاضي الليلة");
    expect(html).toContain("اليوم");
    expect(html).toContain("ضيف هلأ");
  });
});

describe("Instagram on Today", () => {
  it("shows today's posts, how many need an OK, and the suggestions", () => {
    state.locale = "en";
    state.today = {
      autopilot: true, consentMode: "ask", publishMode: "approve",
      items: [{ id: 3, kind: "booking_clip", placement: "story", status: "planned", slotLocal: "2026-11-05 18:00", reference: "GL-7F2", pinned: false } as never],
      suggestions: [...suggestions],
    } satisfies IgToday;
    const html = renderToStaticMarkup(<InstagramToday venueId={1} onOpen={() => {}} />);
    expect(html).toContain("Instagram today");
    expect(html).toContain("Booking GL-7F2");
    expect(html).toContain("1 post needs your OK");
    expect(html).toContain('data-testid="ig-suggestions"');
  });
  it("says when nothing goes out, and that the autopilot is off, in Arabic", () => {
    state.locale = "ar";
    state.today = { autopilot: false, consentMode: "ask", publishMode: "approve", items: [], suggestions: [...suggestions] } satisfies IgToday;
    const html = renderToStaticMarkup(<InstagramToday venueId={1} onOpen={() => {}} />);
    expect(html).toContain("إنستغرام اليوم");
    expect(html).toContain("ما في إشي نازل على إنستغرام اليوم.");
    expect(html).toContain("الأوتوبايلوت مطفي");
  });
});
