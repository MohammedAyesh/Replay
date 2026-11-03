import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrialView } from "@/lib/academy-trials-api";

(globalThis as { React?: typeof React }).React = React;

const state = vi.hoisted(() => ({ locale: "en" as "en" | "ar", trials: [] as unknown[] }));
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: state.locale, setLocale: () => {} }) }));
vi.mock("@workspace/api-client-react", () => ({
  getListAcademyConsoleSessionsQueryKey: () => ["s"],
  useListAcademyConsoleSessions: () => ({ data: [{ id: 9, startsAt: "2026-11-03T13:00:00Z", squadName: "U10", type: "training" }] }),
}));
vi.mock("@/lib/academy-trials-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/academy-trials-api")>();
  const m = { mutate: () => {}, isPending: false };
  return { ...actual, useTrials: () => ({ isLoading: false, isError: false, data: state.trials }), useSetTrialSession: () => m, useMakeTrialClip: () => m, useSendTrialClip: () => m };
});

import { TrialsCard } from "./trials-card";

const now = new Date("2026-11-03T17:00:00Z").getTime();
const base: TrialView = { contactId: 1, name: "Abu Yazan", phone: "962790000401", stage: "trial", session: null, dueBy: null, clip: null };
const session = { id: 9, startsAt: "2026-11-03T13:00:00Z", endsAt: "2026-11-03T14:30:00Z", type: "training", hasVideo: true };

const render = (trials: TrialView[], locale: "en" | "ar" = "en") => {
  state.locale = locale;
  state.trials = trials;
  return renderToStaticMarkup(<TrialsCard academyId={1} now={now} />);
};

describe("trials card", () => {
  it("says what to do when no one is at the trial stage", () => {
    expect(render([])).toContain('data-testid="trials-empty"');
  });
  it("asks for the moment once the video is in, with the time left to send", () => {
    const html = render([{ ...base, session, dueBy: "2026-11-04T14:30:00Z" }]);
    expect(html).toContain('data-testid="trial-moment"');
    expect(html).toContain("Send within 22 h");
  });
  it("says late after 24 hours, and waits for the video before asking for a moment", () => {
    expect(render([{ ...base, session, dueBy: "2026-11-03T10:00:00Z" }])).toContain("Late");
    const noVideo = render([{ ...base, session: { ...session, hasVideo: false }, dueBy: "2026-11-04T14:30:00Z" }]);
    expect(noVideo).toContain("The video isn&#x27;t in yet");
    expect(noVideo).not.toContain('data-testid="trial-moment"');
  });
  it("offers to send a prepared clip, then shows sent, opened and the follow-up", () => {
    const clip = { id: 3, childName: "Yazan", momentSeconds: 750, status: "prepared" as const, exportStatus: "done", url: "https://x/kc/a", sentAt: null, openedAt: null, followUpStatus: null, followUpAt: null };
    const prepared = render([{ ...base, session, dueBy: "2026-11-04T14:30:00Z", clip }]);
    expect(prepared).toContain('data-testid="trial-send"');
    expect(prepared).toContain("12:30");
    const sent = render([{ ...base, session, dueBy: "2026-11-04T14:30:00Z", clip: { ...clip, status: "sent", sentAt: "2026-11-03T16:00:00Z", openedAt: "2026-11-03T16:30:00Z", followUpStatus: "pending", followUpAt: "2026-11-05T16:00:00Z" } }]);
    expect(sent).not.toContain('data-testid="trial-send"');
    expect(sent).not.toContain('data-testid="trial-due"');
    expect(sent).toContain("Opened");
    expect(sent).toContain("Follow-up");
  });
  it("is Arabic in Arabic", () => {
    const html = render([{ ...base, session, dueBy: "2026-11-04T14:30:00Z" }], "ar");
    expect(html).toContain("الحصص التجريبية");
    expect(html).toContain("ابعتوه خلال 22 ساعة");
  });
});
