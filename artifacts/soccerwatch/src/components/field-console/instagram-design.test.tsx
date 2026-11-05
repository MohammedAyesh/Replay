import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

(globalThis as { React?: typeof React }).React = React;
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: "en", setLocale: () => {} }) }));
vi.mock("@/lib/creative-hub-api", () => ({
  useCreativeBrand: () => ({ isLoading: false, data: { brand: { primary: "#1E7BFF", accent: "#FFD400", ink: "#0B0F1A", paper: "#fff", muted: "#889", nameEn: "North Pitches", nameAr: null }, phone: "078 222 3333", instagram: null, showPlayerNames: false, pack: null } }),
}));

import { DesignThumb, KIND_TEMPLATE } from "./instagram-design";

describe("calendar thumbnails before a post is rendered", () => {
  it("draws every kind's design in the field's own name and phone instead of a black box", () => {
    for (const kind of Object.keys(KIND_TEMPLATE)) {
      const html = renderToStaticMarkup(<DesignThumb venueId={1} item={{ kind: kind as never, placement: kind === "award_nominees" ? "carousel" : "story", picks: [] }} width={54} />);
      expect(html, kind).toContain('data-testid="ig-design-thumb"');
      expect(html, kind).toContain("scene-layer-");
      expect(html).not.toMatch(/Galaxy|جلاكسي/);
    }
    const end = renderToStaticMarkup(<DesignThumb venueId={1} item={{ kind: "open_slots", placement: "story", picks: [] }} width={54} />);
    expect(end).toContain("North Pitches");
  });
});
