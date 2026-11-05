import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildTemplateScene } from "@workspace/api-zod";
import { videoSlots } from "@/lib/creative-editor-state";
import type { EditorApi } from "./editor-api";

(globalThis as { React?: typeof React }).React = React;
const state = vi.hoisted(() => ({ locale: "en" as "en" | "ar" }));
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: state.locale, setLocale: () => {} }) }));
vi.mock("@/lib/console-kind", () => ({ useConsoleKind: () => "academy", useConsoleWording: <T,>(x: T) => x }));

import { VideosPanel } from "./videos-panel";
import { Timeline } from "./timeline";

function edFor(key: string, data: Record<string, unknown> = {}): EditorApi {
  const scene = buildTemplateScene(key, "broadcast", "story", "en");
  const noop = () => {};
  return {
    academyId: 1, scene, selected: null, select: noop, update: noop, updateScene: noop, addMusic: noop, backToPhoto: noop, add: noop, remove: noop,
    duplicate: noop, move: noop, setFormat: noop, setStyle: noop, setPlate: noop, brand: { primary: "#000", accent: "#fff", ink: "#fff", paper: "#000", muted: "#888", nameEn: "", nameAr: null },
    data, setData: noop, template: null, fields: [], frameFootage: noop, slots: videoSlots(scene), setSlotVideo: noop, pick: noop, mediaUrl: () => null,
    isVideo: true, timeMs: 0, setTimeMs: noop, playing: false, setPlaying: noop,
  };
}

describe("Videos panel", () => {
  it("has a Video 1 and a Video 2 place for the compare template, with the first filled", () => {
    state.locale = "en";
    const html = renderToStaticMarkup(<VideosPanel ed={edFor("field-versus", { media: { type: "recording", recordingId: 4, fromMs: 1000, toMs: 10_000 } })} />);
    expect(html).toContain('data-testid="editor-video-slot-1"');
    expect(html).toContain('data-testid="editor-video-slot-2"');
    expect(html).toContain("This template plays 2 videos");
    expect(html).toContain("0:09.0 long");
    expect(html).toContain('data-testid="editor-video-slot-1-edit"');
    expect(html).toContain("No video yet");
    expect(html).not.toContain('data-testid="editor-video-slot-2-edit"');
  });
  it("is in Arabic in Arabic", () => {
    state.locale = "ar";
    const html = renderToStaticMarkup(<VideosPanel ed={edFor("field-versus")} />);
    expect(html).toContain("فيديو 1");
    expect(html).toContain("فيديو 2");
    expect(html).toContain("هالقالب بيعرض فيديوين");
  });
});

describe("Timeline", () => {
  it("puts each video's parts on one lane, Video 1 and Video 2, first", () => {
    state.locale = "en";
    const html = renderToStaticMarkup(<Timeline ed={edFor("field-versus")} />);
    const v1 = html.indexOf('data-testid="editor-track-slot-media"');
    const v2 = html.indexOf('data-testid="editor-track-slot-more.0"');
    expect(v1).toBeGreaterThan(-1);
    expect(v2).toBeGreaterThan(v1);
    // The three parts of Video 1 are bars on its lane, not lanes of their own.
    const lane1 = html.slice(v1, v2);
    for (const id of ["a-split", "a-full", "a-again"]) expect(lane1).toContain(`data-testid="editor-bar-${id}"`);
    expect(html).not.toContain('data-testid="editor-track-a-full"');
  });
});
