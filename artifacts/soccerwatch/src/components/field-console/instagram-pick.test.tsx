import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

(globalThis as { React?: typeof React }).React = React;
const state = vi.hoisted(() => ({ locale: "en" as "en" | "ar", lib: null as unknown }));
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: state.locale, setLocale: () => {} }) }));
vi.mock("@/lib/instagram-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/instagram-api")>()),
  useItemLibrary: () => state.lib,
}));

import { LibraryPane } from "./instagram-pick";

const clip = (id: number, title: string, origin: "player" | "auto", date: string, time: string) => ({
  clipId: id, title, status: "ready", aspectRatio: "16:9", createdAt: `${date}T20:00:00Z`, date, durationMs: 16_000, sessionId: 7,
  source: { type: "clip", clipId: id }, window: null, still: null, thumbnailUrl: null, videoUrl: null,
  origin, madeBy: origin === "player" ? "Omar" : null, player: { key: "u:1", name: "Omar" },
  match: { key: `rec:${date}`, recordingId: 7, date, time, pitch: "Pitch 1", startsAt: `${date}T${time}:00+03:00` },
  kind: title.startsWith("Goal") ? "goal" : "pass",
});

const page = (oneGame = false) => ({
  items: [
    clip(1, "Goal · 24:10", "auto", "2026-11-05", "21:00"),
    clip(2, "Pass found · 12 m · 41:43", "auto", "2026-11-05", "21:00"),
    clip(3, "My goal", "player", "2026-10-28", "19:00"),
  ],
  counts: { all: 159, player: 32, auto: 127 },
  kindCounts: { goal: 40, dribble: 12, pass: 70, shot: 9, other: 28 },
  groupSizes: {}, oneGame, isLoading: false, isError: false, error: null, hasNextPage: true, isFetchingNextPage: false, fetchNextPage: () => {},
});

const item = { id: 5, kind: "day_best" } as never;

describe("Picking clips from the library", () => {
  it("groups clips by game day, offers kind, maker and date filters with counts, and numbers the picks", () => {
    state.locale = "en";
    state.lib = page();
    const html = renderToStaticMarkup(<LibraryPane venueId={1} item={item} single={false} onToggle={() => {}} orderOf={(k) => (k === "lib:3" ? 0 : -1)} />);
    expect(html).toContain("By players · 32");
    expect(html).toContain("By Replay · 127");
    expect(html).toContain("Goals · 40");
    expect(html).toContain("Dribbles · 12");
    expect(html).toContain("Passes · 70");
    expect(html).toContain("By date");
    expect(html).toContain("By match");
    expect(html).toContain('data-testid="ig-pick-from"');
    // Two days, newest first, each with its clips.
    expect(html.indexOf('data-testid="ig-pick-group-2026-11-05"')).toBeLessThan(html.indexOf('data-testid="ig-pick-group-2026-10-28"'));
    expect(html).toContain('data-testid="ig-pick-lib:1"');
    expect(html).toContain("Pass found · 12 m · 41:43");
    expect(html).toContain("Omar");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Show more");
    expect(html).not.toContain("only that game");
  });
  it("says when a post takes one game's clips only, and is in Arabic in Arabic", () => {
    state.locale = "ar";
    state.lib = page(true);
    const html = renderToStaticMarkup(<LibraryPane venueId={1} item={item} single onToggle={() => {}} orderOf={() => -1} />);
    expect(html).toContain("هالبوست عن ماتش واحد");
    expect(html).toContain("جوالات · 40");
    expect(html).toContain("من ريبلاي · 127");
    expect(html).toContain("حسب اليوم");
  });
});
