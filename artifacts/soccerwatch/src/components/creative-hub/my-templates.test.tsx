import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildTemplateScene } from "@workspace/api-zod";

(globalThis as { React?: typeof React }).React = React;
const state = vi.hoisted(() => ({ locale: "en" as "en" | "ar", list: [] as unknown[] }));
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: state.locale, setLocale: () => {} }) }));
vi.mock("@/lib/console-kind", () => ({ useConsoleKind: () => "venue", useConsoleWording: <T,>(x: T) => x }));
vi.mock("@/lib/my-templates-api", () => ({
  useMyTemplates: () => ({ isLoading: false, isError: false, data: state.list }),
  useMyTemplateActions: () => {
    const m = { mutate: () => {}, mutateAsync: async () => ({}), isPending: false, error: null, reset: () => {} };
    return { save: m, update: m, remove: m };
  },
}));
vi.mock("./templates/template-card", () => ({
  TemplateCard: ({ meta, title, star }: { meta: { key: string }; title: string; star?: React.ReactNode }) => React.createElement("div", { "data-card": meta.key }, title, star),
}));

import { MyTemplatesGrid, SaveTemplateButton } from "./my-templates";

const brand = { primary: "#0A7", accent: "#FD0", ink: "#0B0F1A", paper: "#fff", muted: "#889", nameEn: "N", nameAr: null };
const tpl = (id: number, title: string, replacesBase = false) => ({
  id, baseKey: "field-booking-clip", style: "field", format: "story", kind: "video", title, replacesBase,
  scene: { ...buildTemplateScene("field-booking-clip", "field", "story", "en"), template: { key: "field-booking-clip", style: "field", mine: id } },
  sampleData: null, createdAt: "", updatedAt: "",
});
const grid = () => renderToStaticMarkup(<MyTemplatesGrid academyId={1} brand={brand} width={200} cols={3} gap={12} dataFor={() => ({})} mediaUrl={() => null}
  onOpen={() => {}} pending={null} labels={{ video: "Video", seconds: (n) => `${n}s`, creating: "…", open: (t) => t }} />);

describe("My templates", () => {
  it("shows the saved designs, which one is in use instead of the original, and says where it came from", () => {
    state.locale = "en";
    state.list = [tpl(7, "Our booking clip", true), tpl(8, "Night version")];
    const html = grid();
    expect(html).toContain('data-card="my-7"');
    expect(html).toContain('data-card="my-8"');
    expect(html).toContain("In use");
    expect(html).toContain("From Booking clip");
    expect(html).toContain("Stop using instead");
    expect(html).toContain("Use instead of the original");
  });
  it("explains how to make one when there are none, in Arabic", () => {
    state.locale = "ar";
    state.list = [];
    expect(grid()).toContain("لسا ما في قوالب");
  });
  it("puts a Save as template button in the editor", () => {
    state.locale = "en";
    const html = renderToStaticMarkup(<SaveTemplateButton academyId={1} projectId={3} templateKey="field-booking-clip"
      scene={buildTemplateScene("field-booking-clip", "field", "story", "en")} title="Goal" flush={async () => {}} onMarked={() => {}} />);
    expect(html).toContain('data-testid="editor-save-template"');
    expect(html).toContain("Save as template");
  });
});
