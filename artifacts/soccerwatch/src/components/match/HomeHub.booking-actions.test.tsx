import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FreeMatchStatus } from "@/lib/match-api";

const state = vi.hoisted(() => ({
  freeMatch: null as FreeMatchStatus | null,
}));

vi.mock("wouter", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Link: ({ href, children, ...props }: { href: string; children: React.ReactNode; [key: string]: unknown }) =>
      React.createElement("a", { href, ...props }, children),
  };
});

vi.mock("@workspace/api-client-react", () => ({
  getListUserClipsQueryKey: () => ["clips"],
  useListUserClips: () => ({ data: [] }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 12, name: "Alex Player", ownedFieldIds: [] }, isGuest: false }),
}));

vi.mock("@/lib/match-api", () => ({
  formatJod: () => "JOD 20",
  useAvatarRemove: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useAvatarUpload: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useBookingFields: () => ({ data: { enabled: true, fields: [{ id: 1 }], pricePerHourFils: 2000 } }),
  useMyMatches: () => ({
    data: { live: [], upcoming: [], recent: [], invites: [], freeMatch: state.freeMatch },
    isLoading: false,
  }),
  useReplayProfile: () => ({ data: null }),
}));

vi.mock("@/components/home/FirstClipChecklist", () => ({ FirstClipChecklist: () => null }));
vi.mock("@/components/home/StatCarousel", () => ({ StatCarousel: () => null }));
vi.mock("@/components/match/MatchCard", () => ({ MatchCard: () => null }));
vi.mock("@/components/match/bits", () => ({
  PlayerAvatar: () => null,
  formatDay: () => "",
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <>{children}</> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/i18n/context", () => ({ useLocale: () => ({ locale: "en" }) }));
vi.mock("@/i18n/match-strings", () => ({
  useMatchCopy: () => ({
    bookFootage: () => "Book footage",
    book: { why: [{ title: "Get your match recorded" }] },
    hello: (name: string) => `Hello, ${name}`,
    helloGuest: "Hello",
    homeNoMatch: "No match booked yet",
    homeSteps: ["Book", "Play", "Watch"],
    photo: {
      tooBig: "Too big",
      updated: "Updated",
      failed: "Failed",
      removed: "Removed",
      change: "Change photo",
      add: "Add photo",
      title: "Profile photo",
      changeAction: "Choose another",
      remove: "Remove",
      cancel: "Cancel",
    },
  }),
}));
vi.mock("@/i18n/explainer-strings", () => ({
  useExplainerCopy: () => ({
    firstClip: { hide: "Hide" },
    free: {
      applied: "Free booking ready",
      appliedSub: () => "Use it before it expires",
      book: "Book a match",
      bookFree: "Book for free",
      chip: "Challenge",
      findMe: "Find yourself",
      free: "Free",
      friendsLeft: () => "Friends still need to join",
      how: "How it works",
      lead: () => "Invite friends after your match",
      loyaltyEarned: () => "Loyalty reward",
      of: (done: number, total: number) => `${done} of ${total}`,
      open: "Open match",
      rule4Title: "Your reward",
      rule1Title: "Book",
      rule1: "Book a match.",
      rule2Title: "Pay",
      rule2: "Pay for the match.",
      rule3Title: "Find friends",
      rule3: () => "Find your friends.",
      rule4: () => "Get a free match.",
      rulesSmall: "Terms apply.",
      recording: "Recording",
      recordingValue: () => "One hour",
      pitch: "Pitch",
      anyPitch: "Any pitch",
      useBy: "Use by",
      worth: "Worth",
      worthValue: () => "JOD 20",
      thanks: (names: string) => names,
      foundSelf: "Found",
      notFound: "Not found",
      remindName: (name: string) => `Remind ${name}`,
      remind: "Remind",
      friendsLead: "Invite friends",
      deadline: () => "Deadline",
      cliqCounts: "Payment counts",
      cliqProgress: "Progress",
      reportNote: "Find yourself in the report.",
      sendLink: "Send match link",
      shareText: (url: string) => `Join me: ${url}`,
      stepAccount: "Create an account",
      stepBook: "Book a match",
      stepBookSub: () => "Paid booking",
      stepFind: "Find yourself in the recording",
      stepFriends: (count: number) => `Invite ${count} friends`,
      stepFriendsCount: (found: number, required: number) => `${found} of ${required} friends`,
      stepPay: "Pay for your booking",
      stepPayWaiting: "Waiting for payment",
      title: "Play with friends",
      unlockedLead: () => "Your friends found themselves",
      unlockedChip: () => "Reward unlocked",
      loyaltyTitle: (every: number) => `Every ${every} matches`,
      loyaltyCount: (count: number, every: number) => `${count} of ${every}`,
      loyaltyStart: (every: number) => `Play ${every} matches`,
      loyaltyLeft: (left: number) => `${left} to go`,
      loyaltyRule: "Paid matches count",
    },
  }),
}));
vi.mock("@/lib/first-time", () => ({ useFirstTime: () => [true, vi.fn()] }));

import { HomeHub } from "./HomeHub";

const baseStatus: FreeMatchStatus = {
  enabled: true,
  canEarn: true,
  friendsRequired: 3,
  freeHours: 1,
  useWithinDays: 30,
  deadlineDays: 14,
  pricePerHourFils: 2000,
  attempt: null,
  reward: null,
  latestEarned: null,
  loyalty: { enabled: false, every: 5, count: 0, total: 0, earned: 0 },
};

function homeMarkup(status: FreeMatchStatus) {
  state.freeMatch = status;
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(HomeHub));
}

function countBookLinks(markup: string) {
  return markup.match(/href="\/book"/g)?.length ?? 0;
}

describe("HomeHub booking and free-match actions", () => {
  beforeEach(() => {
    state.freeMatch = null;
  });

  it("shows one booking action in the no-match state", () => {
    const markup = homeMarkup(baseStatus);

    expect(markup).toContain('data-testid="home-no-match"');
    expect(markup).toContain('data-testid="link-home-book"');
    expect(countBookLinks(markup)).toBe(1);
    expect(markup).not.toContain('data-testid="link-free-match-start"');
    expect(markup).not.toContain('data-testid="link-loyalty-book"');
  });

  it("shows the find action when the active challenge is waiting for the player", () => {
    const markup = homeMarkup({
      ...baseStatus,
      attempt: {
        code: "MATCH1",
        fieldName: "Main Field",
        startMs: 0,
        endMs: 1,
        phase: "ready",
        paid: true,
        payPending: false,
        findRecordingId: 77,
        bookerFound: false,
        friendsFound: 0,
        friends: [],
        deadline: null,
        capped: false,
      },
    });

    expect(markup).toContain('data-testid="link-free-match-find"');
    expect(markup).toContain(`href="/find/77?match=MATCH1"`);
    expect(markup).not.toContain('data-testid="button-free-match-share"');
    expect(countBookLinks(markup)).toBe(1);
  });

  it("shows the share action when the player has found themselves", () => {
    const markup = homeMarkup({
      ...baseStatus,
      attempt: {
        code: "MATCH1",
        fieldName: "Main Field",
        startMs: 0,
        endMs: 1,
        phase: "ready",
        paid: true,
        payPending: false,
        findRecordingId: 77,
        bookerFound: true,
        friendsFound: 1,
        friends: [],
        deadline: null,
        capped: false,
      },
    });

    expect(markup).toContain('data-testid="button-free-match-share"');
    expect(markup).not.toContain('data-testid="link-free-match-find"');
    expect(countBookLinks(markup)).toBe(1);
  });

  it("shows one free-booking action when a reward is ready", () => {
    const markup = homeMarkup({
      ...baseStatus,
      reward: {
        id: 8,
        kind: "challenge",
        freeHours: 1,
        worthFils: 2000,
        expiresAt: "2026-12-01T00:00:00.000Z",
        sourceCode: "MATCH1",
        thanks: [],
        usedCode: null,
        status: "available",
      },
    });

    expect(markup).toContain('data-testid="free-match-home-reward"');
    expect(markup).toContain('data-testid="link-free-match-book"');
    expect(markup).toContain("Book for free");
    expect(markup).not.toContain('data-testid="link-home-book"');
    expect(countBookLinks(markup)).toBe(1);
  });
});
