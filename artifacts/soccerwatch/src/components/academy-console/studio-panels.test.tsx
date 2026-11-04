import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

(globalThis as { React?: typeof React }).React = React;

const state = vi.hoisted(() => ({ locale: "en" as "en" | "ar", starred: { template: [] as string[], clip: [] as string[], project: [] as string[] } }));
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: state.locale, setLocale: () => {} }) }));
vi.mock("@/lib/console-kind", () => ({ useConsoleKind: () => "academy", useConsoleWording: <T,>(x: T) => x }));
vi.mock("@/lib/favorites-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/favorites-api")>();
  return {
    ...actual,
    useFavorites: () => ({
      data: state.starred,
      isStarred: (kind: "template" | "clip" | "project", k: string | number) => state.starred[kind].includes(String(k)),
      toggle: () => {},
    }),
  };
});
vi.mock("@/lib/academy-studio-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/academy-studio-api")>();
  const clip = (id: number, title: string) => ({ id, title, aspectRatio: "16:9", status: "ready", createdAt: "2026-11-01T10:00:00Z", durationSeconds: 12, thumbnailUrl: null, creator: { isYou: true, name: null, role: "owner" } });
  return { ...actual, useStudioClips: () => ({ isLoading: false, isError: false, data: { clips: [clip(1, "First clip"), clip(2, "Second clip"), clip(3, "Third clip")] } }) };
});

import { StudioClipsPanel } from "./studio-section";
import { tabFromUrl } from "@/components/creative-hub/hub";

describe("Studio in the Creative hub", () => {
  it("lists the academy's clips with a star each, starred first", () => {
    state.starred = { template: [], clip: ["3"], project: [] };
    const html = renderToStaticMarkup(<StudioClipsPanel academyId={1} />);
    expect(html.indexOf("Third clip")).toBeLessThan(html.indexOf("First clip"));
    expect(html).toContain('data-testid="star-clip-3"');
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
  });
  it("opens the tab an old Studio link asks for", () => {
    expect(tabFromUrl("?tab=clips")).toBe("clips");
    expect(tabFromUrl("?tab=quick")).toBe("quick");
    expect(tabFromUrl("?tab=nope")).toBeNull();
    expect(tabFromUrl("")).toBeNull();
  });
});
