import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildTemplateScene } from "@workspace/api-zod";
import type { EditorApi } from "./editor-api";

(globalThis as { React?: typeof React }).React = React;
const state = vi.hoisted(() => ({ locale: "en" as "en" | "ar", names: true }));
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: state.locale, setLocale: () => {} }) }));
vi.mock("@/lib/console-kind", () => ({ useConsoleKind: () => "academy", useConsoleWording: <T,>(x: T) => x }));
vi.mock("@/lib/creative-hub-api", () => ({ useCreativeBrand: () => ({ data: { showPlayerNames: state.names } }) }));

import { PlayerPanel } from "./player-panel";

const ed = (data: Record<string, unknown>) => ({
  academyId: 1, scene: buildTemplateScene("club-player", "club", "story", "en"), data, setData: () => {}, pick: () => {}, mediaUrl: () => "/x.png",
} as unknown as EditorApi);

describe("Player panel", () => {
  it("shows who the design is about, with a cut-out badge and the way to choose him", () => {
    state.locale = "en"; state.names = true;
    const html = renderToStaticMarkup(<PlayerPanel ed={ed({ player: { name: "Omar", number: 10, position: "MF", photo: { type: "player-photo", photoId: 3, cutout: true } } })} />);
    expect(html).toContain("Omar");
    expect(html).toContain("Cut-out");
    expect(html).toContain('data-testid="editor-player-choose"');
    expect(html).toContain("Change player");
    expect(html).toContain('data-testid="editor-player-name"');
  });
  it("without names shows the number, hides the name field, in Arabic", () => {
    state.locale = "ar"; state.names = false;
    const html = renderToStaticMarkup(<PlayerPanel ed={ed({ player: { number: 7 } })} />);
    expect(html).toContain("#7");
    expect(html).toContain("غيّر اللاعب");
    expect(html).not.toContain('data-testid="editor-player-name"');
    expect(html).toContain("الأسماء مخفية");
  });
});
