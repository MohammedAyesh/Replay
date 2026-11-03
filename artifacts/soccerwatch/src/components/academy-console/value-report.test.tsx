import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ValueReport } from "@/lib/value-report-api";
import { valueReportStrings } from "@/i18n/value-report-strings";

(globalThis as { React?: typeof React }).React = React;

const state = vi.hoisted(() => ({ locale: "en" as "en" | "ar", data: null as unknown }));
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: state.locale, setLocale: () => {} }) }));
vi.mock("@/lib/value-report-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/value-report-api")>();
  return {
    ...actual,
    useValueReport: () => ({ isLoading: false, isError: false, data: state.data }),
    useShareReport: () => ({ mutate: () => {}, isPending: false }),
    useRevokeShare: () => ({ mutate: () => {}, isPending: false }),
  };
});

import { AcademyValueReportSection, ValueReportView } from "./value-report";
import { recentMonths } from "@/lib/value-report-api";

const report: ValueReport = {
  academy: { id: 1, name: "JUFA", logoUrl: null },
  month: "2026-10",
  partial: false,
  generatedAt: "2026-11-01T08:00:00Z",
  footage: { matchVideos: 6, clipsMade: 41, privateClipsSent: 28 },
  posts: { published: 9, reach: 4210 },
  messages: { sent: 133, read: 101 },
  families: { total: 24, reached: 22, opened: 19, openedPct: 79 },
  featured: { featured: 26, total: 28, publicTarget: 1, notYet: [{ number: 11 }, { number: 19 }] },
  people: { enquiries: 14, trials: 6, joined: 3, trackedSince: "2026-11-03T18:00:00Z" },
  ads: { ran: true, spendJod: 45, joinedFromAds: 2, costPerJoinedJod: 22.5 },
};

describe("value report view", () => {
  it("shows the month in English, with the children not yet featured by shirt number", () => {
    state.locale = "en";
    const html = renderToStaticMarkup(<ValueReportView report={report} />);
    expect(html).toContain("October 2026");
    expect(html).toContain("26 of 28");
    expect(html).toContain('Not yet: <bdi dir="ltr">#11, #19</bdi>');
    expect(html).toContain("79%");
    expect(html).toContain("19 of 24 families");
    expect(html).toContain("22.50 JOD per player joined");
    expect(html).toContain("45 JOD spent");
    expect(html).toContain("Reached 4,210 people");
    // The people pipeline began recording after the month started: say so.
    expect(html).toContain("Counted from 3 November 2026");
    expect(html).toContain('dir="ltr"');
  });

  it("is Arabic and right to left in Arabic", () => {
    state.locale = "ar";
    const html = renderToStaticMarkup(<ValueReportView report={report} />);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("26 من 28");
    expect(html).toContain('لسا: <bdi dir="ltr">#11, #19</bdi>');
    expect(html).toContain("22.50 دينار لكل لاعب سجّل");
    expect(html).toContain("تشرين الأول 2026");
  });

  it("says no ads ran instead of a cost, and shows an em dash when no family is linked", () => {
    state.locale = "en";
    const html = renderToStaticMarkup(<ValueReportView report={{ ...report, ads: { ran: false, spendJod: null, joinedFromAds: 0, costPerJoinedJod: null }, families: { total: 0, reached: 0, opened: 0, openedPct: null } }} />);
    expect(html).toContain(valueReportStrings.en.ads.none);
    expect(html).not.toContain("per player joined");
    expect(html).toContain(valueReportStrings.en.families.none);
  });

  it("names the academy and the month on the shared page", () => {
    state.locale = "en";
    const html = renderToStaticMarkup(<ValueReportView report={{ ...report, featured: { ...report.featured, notYet: [] } }} shared />);
    expect(html).toContain("JUFA · October 2026");
    expect(html).not.toContain("Not yet");
  });

  it("puts share, download and the last twelve months in the console section", () => {
    state.locale = "en";
    state.data = { report, share: null };
    const html = renderToStaticMarkup(<AcademyValueReportSection academyId={1} />);
    expect(html).toContain('data-testid="vr-share"');
    expect(html).toContain('data-testid="vr-download"');
    expect((html.match(/<option /g) ?? []).length).toBe(12);
    state.data = { report, share: { id: 4, token: "a".repeat(32), createdAt: "2026-11-01T08:00:00Z" } };
    const shared = renderToStaticMarkup(<AcademyValueReportSection academyId={1} />);
    expect(shared).toContain(`/vr/${"a".repeat(32)}`);
    expect(shared).toContain('data-testid="vr-turn-off"');
  });

  it("steps back across a year", () => {
    expect(recentMonths("2026-02", 3)).toEqual(["2026-02", "2026-01", "2025-12"]);
  });

  it("has every English string in Arabic", () => {
    const keys = (o: object, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(valueReportStrings.ar).sort()).toEqual(keys(valueReportStrings.en).sort());
  });
});
