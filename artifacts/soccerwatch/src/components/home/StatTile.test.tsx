import * as React from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StatTile } from "@/lib/stat-tile";

const localeState = vi.hoisted(() => ({ locale: "en" as "en" | "ar" }));

vi.mock("@/i18n/stat-tile-strings", () => ({
  useTileCopy: () => {
    const ar = localeState.locale === "ar";
    return {
      locale: localeState.locale,
      you: ar ? "إنت" : "You",
      duel: {
        title: ar ? "تحدّي المراوغة" : "Dribble duel",
        head: (name: string, diff: number, theyWon: boolean) => ar
          ? `${name} غلبك بـ${diff}.`
          : (theyWon ? `${name} beat you by ${diff}.` : `You beat ${name} by ${diff}.`),
        note: ar ? " هو حاول أكثر، وإنت خسرت الكرة أقل." : " They tried more, you lost the ball less.",
        won: ar ? "نجحت" : "won",
        of: ar ? "من" : "of",
        tries: (n: number) => ar ? (n === 2 ? "محاولتين" : n >= 3 && n <= 10 ? "محاولات" : "محاولة") : (n === 1 ? "try" : "tries"),
        yourSuccess: ar ? "نسبة نجاحك" : "your success",
        theirSuccess: ar ? "نسبة نجاحه" : "their success",
        dribblesInDuel: ar ? "مراوغات بالتحدّي" : "dribbles in duel",
      },
    };
  },
}));

vi.mock("wouter", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Link: ({ href, className, children }: { href: string; className?: string; children: ReactNode }) =>
      React.createElement("a", { href, className }, children),
  };
});

import { StatTileCard } from "./StatTile";

const tile: StatTile = {
  kind: "dribbleDuel",
  match: { code: "DUEL1", startLocal: "2026-10-20 20:00", fieldName: "Jordan Galaxy", players: 12, watch: null },
  me: { won: 5, tries: 8 },
  other: { name: "A very long opposing player name", won: 7, tries: 12 },
};

function markup(locale: "en" | "ar") {
  localeState.locale = locale;
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(StatTileCard, { tile }));
}

describe("dribble duel card", () => {
  it("renders the head-to-head scoreline, proportional animated bar, and requested footer in English", () => {
    const html = markup("en");
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("A very long opposing player name beat you by 2.");
    expect(html).toContain("They tried more, you lost the ball less.");
    expect(html).toContain("of");
    expect(html).toContain("your success");
    expect(html).toContain("their success");
    expect(html).toContain("dribbles in duel");
    expect(html.match(/tile-grow-x/g)).toHaveLength(2);
    expect(html).toContain("flex:5 1 0%");
    expect(html).toContain("flex:7 1 0%");
  });

  it("mirrors the card in Arabic while keeping the score numbers LTR", () => {
    const html = markup("ar");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('dir="ltr" class="tile-num');
    expect(html).toContain("نجحت");
    expect(html).toContain("نسبة نجاحك");
    expect(html).toContain("نسبة نجاحه");
    expect(html).toContain("مراوغات بالتحدّي");
    expect(html.match(/tile-grow-x/g)).toHaveLength(2);
  });
});
