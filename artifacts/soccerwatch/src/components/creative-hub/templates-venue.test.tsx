import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

(globalThis as { React?: typeof React }).React = React;

const state = vi.hoisted(() => ({ kind: "venue" as "venue" | "academy" }));
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: "en", setLocale: () => {} }) }));
vi.mock("@/lib/console-kind", () => ({ useConsoleKind: () => state.kind, useConsoleWording: <T,>(x: T) => x }));
vi.mock("@/lib/favorites-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/favorites-api")>()),
  useFavorites: () => ({ data: { template: [], clip: [], project: [] }, isStarred: () => false, toggle: () => {} }),
}));
vi.mock("@/lib/creative-hub-api", () => ({
  useCreativeBrand: () => ({ isLoading: false, isError: false, data: { brand: { primary: "#0A7", accent: "#FD0", ink: "#0B0F1A", paper: "#fff", muted: "#889", nameEn: "North Pitches", nameAr: null }, phone: "078 222 3333", instagram: null, showPlayerNames: false, pack: null } }),
  useCreativeSessionData: () => ({ isLoading: false, isError: false, data: null }),
  useCreateCreativeProject: () => ({ mutateAsync: async () => ({ id: 1 }) }),
}));
vi.mock("@/lib/creative-hub-library-api", () => ({ useLibraryMatches: () => ({ items: [] }), useLibraryClips: () => ({ items: [] }) }));
vi.mock("./templates/template-card", () => ({
  TemplateCard: ({ meta }: { meta: { key: string } }) => React.createElement("div", { "data-card": meta.key }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreativeTemplates as Bare } from "./templates";

// Match stills fetch their camera (useQueries).
const CreativeTemplates = (p: React.ComponentProps<typeof Bare>) =>
  <QueryClientProvider client={new QueryClient()}><Bare {...p} /></QueryClientProvider>;

const nav = { openInEditor: () => {}, openInPublish: () => {}, openTemplates: () => {} };
const cards = (html: string) => [...html.matchAll(/data-card="([^"]+)"/g)].map((m) => m[1]);

describe("Creative hub Templates on a field console", () => {
  it("opens on the field pack, without the style picker", () => {
    state.kind = "venue";
    const html = renderToStaticMarkup(<CreativeTemplates academyId={1} nav={nav} seed={{ type: "clip", clipId: 4 }} />);
    expect(html).toContain('data-testid="creative-templates-cat-field"');
    expect(html).toContain("Field pack");
    expect(html).toContain('data-testid="creative-templates-field-hint"');
    expect(html).not.toContain('data-testid="creative-templates-style-broadcast"');
    const keys = cards(html);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.every((k) => k.startsWith("field-"))).toBe(true);
    // A clip seed puts video designs first.
    expect(keys[0]).not.toBe("field-open-slots");
  });
  it("an academy opens on the academy pack and never sees the field pack", () => {
    state.kind = "academy";
    const html = renderToStaticMarkup(<CreativeTemplates academyId={1} nav={nav} />);
    expect(html).not.toContain("creative-templates-cat-field");
    expect(html).toContain('data-testid="creative-templates-cat-club"');
    const keys = cards(html);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.every((k) => k.startsWith("club-"))).toBe(true);
    // A match picked from For you opens on every template instead (its facts fill them).
    const fromMatch = cards(renderToStaticMarkup(<CreativeTemplates academyId={1} nav={nav} seed={{ type: "session", sessionId: 3 }} />));
    expect(fromMatch.some((k) => k.startsWith("field-"))).toBe(false);
    expect(fromMatch.some((k) => !k.startsWith("club-"))).toBe(true);
  });
});
