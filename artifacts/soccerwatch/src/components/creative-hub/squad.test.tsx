import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SquadGrid } from "@/lib/academy-featured-api";
import { featuredStrings } from "@/i18n/featured-strings";

// The app's components use the automatic JSX runtime; this config compiles JSX classically.
(globalThis as { React?: typeof React }).React = React;

const state = vi.hoisted(() => ({ locale: "en" as "en" | "ar", grid: null as unknown }));

vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: state.locale, setLocale: () => {} }) }));
vi.mock("wouter", () => ({ Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("@/hooks/use-toast", () => ({ toast: () => {} }));
vi.mock("@/lib/academy-featured-api", () => ({
  useSquadGrid: () => ({ isLoading: false, isError: false, data: state.grid }),
  useSaveTargets: () => ({ mutate: () => {}, isPending: false }),
}));

import { CreativeSquad } from "./squad";

const grid: SquadGrid = {
  month: "2026-11",
  targets: { publicPostsPerMonth: 1, privateClipPerMatch: true },
  cells: [
    { playerId: 1, number: 7, name: "Omar Khaled", squadName: "U12", mode: "public", status: "green", lastFeaturedAt: "2026-11-02T10:00:00Z", daysSince: 1, month: { publicSolo: 1, publicAll: 1, private: 1, analysedMatches: 1, clipsReceived: 1 }, missing: [] },
    { playerId: 2, number: 11, name: "Ali Hasan", squadName: "U12", mode: "private_only", status: "amber", lastFeaturedAt: "2026-09-20T10:00:00Z", daysSince: 44, month: { publicSolo: 0, publicAll: 0, private: 0, analysedMatches: 1, clipsReceived: 0 }, missing: ["private_clip"] },
    { playerId: 3, number: 19, name: "Karim Saleh", squadName: "U12", mode: "private_only", status: "red", lastFeaturedAt: null, daysSince: null, month: { publicSolo: 0, publicAll: 0, private: 0, analysedMatches: 0, clipsReceived: 0 }, missing: ["any"] },
  ],
  summary: { featured: 1, total: 3, notYet: [{ playerId: 2, number: 11, name: "Ali Hasan" }, { playerId: 3, number: 19, name: "Karim Saleh" }] },
  gaps: [{ playerId: 3, number: 19, name: "Karim Saleh", matches: 3, latestSessionId: 55 }],
  squads: [{ id: 1, name: "U12" }],
  canEdit: true,
};

const render = (locale: "en" | "ar") => {
  state.locale = locale;
  state.grid = grid;
  return renderToStaticMarkup(<CreativeSquad academyId={1} />);
};

describe("Creative hub → Squad grid", () => {
  it("shows one square per shirt number with its colour, and the summary line", () => {
    const html = render("en");
    expect(html).toContain('data-testid="squad-cell-7" data-status="green"');
    expect(html).toContain('data-testid="squad-cell-11" data-status="amber"');
    expect(html).toContain('data-testid="squad-cell-19" data-status="red"');
    expect(html).toContain("1 of 3 featured this month.");
    expect(html).toContain("#11, #19");
    expect(html).toContain("44 days ago");
    expect(html).toContain("Never featured");
    expect(html).toContain("Private only");
  });

  it("flags a child with no footage and links to the match's Who's who step", () => {
    const html = render("en");
    expect(html).toContain("No footage of #19 in the last 3 matches");
    expect(html).toContain('href="/academy/matches?match=55&amp;step=who"');
  });

  it("reads right to left in Arabic, in Ammani", () => {
    const html = render("ar");
    expect(html).toContain("1 من 3 طلعوا هالشهر.");
    expect(html).toContain("ما في فيديو لـ #19 بآخر 3 مباريات");
    expect(html).toContain("خاص بس");
    expect(html).not.toMatch(/featured this month/);
  });
});

describe("every-child strings", () => {
  const keysOf = (o: object, prefix = ""): string[] => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
  it("Arabic has every English string", () => {
    expect(keysOf(featuredStrings.ar).sort()).toEqual(keysOf(featuredStrings.en).sort());
  });
  it("words a child's note against his own usual, never anyone else's", () => {
    const n = { kind: "above" as const, stat: "dribblesWon", value: 3, usual: 1 };
    expect(featuredStrings.en.clips.note(n)).toBe("3 dribbles won, more than his usual 1");
    expect(featuredStrings.ar.clips.note(n)).toBe("3 مراوغات ناجحة، أكثر من معدّله (1)");
    expect(featuredStrings.ar.clips.note({ kind: "best", stat: "goals", value: 2 })).toBe("جولين، أحسن رقم إله لهلأ");
    expect(featuredStrings.en.clips.note({ kind: "first" })).toBe("");
  });
  it("uses the consent wording Mohammed chose", () => {
    expect(featuredStrings.en.consent.label).toBe("Parent agreed: photos and clips of this player can be posted on the academy's public pages.");
    expect(featuredStrings.ar.consent.label).toBe("الأهل موافقين ننشر صور وفيديوهات اللاعب على صفحات الأكاديمية العامة.");
  });
});
