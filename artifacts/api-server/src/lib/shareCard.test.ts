import { describe, it, expect } from "vitest";

process.env.CLIP_SHARE_URL_SECRET = "test-share-secret";

const {
  shareToken, verifyShareToken, shareCardPath, escapeHtml,
  buildShareTitle, buildShareDescription, buildShareCardHtml,
} = await import("./shareCard");

const base = {
  clipId: 4821,
  title: "Volley from the edge of the box",
  baseUrl: "https://replayjo.com",
  posterUrl: "https://replayjo.com/s/4821/tok/poster.jpg",
  videoUrl: "https://replayjo.com/s/4821/tok/clip.mp4",
  appUrl: "https://replayjo.com/watch/4821",
};

describe("share tokens", () => {
  it("is deterministic, so a link keeps working without a column to store it", () => {
    expect(shareToken(4821)).toBe(shareToken(4821));
  });

  it("differs per clip, so one link does not unlock the next id", () => {
    expect(shareToken(4821)).not.toBe(shareToken(4822));
  });

  it("verifies the right token and rejects everything else", () => {
    const t = shareToken(4821);
    expect(verifyShareToken(4821, t)).toBe(true);
    expect(verifyShareToken(4822, t)).toBe(false);
    expect(verifyShareToken(4821, t.slice(0, -1) + "0")).toBe(false);
    expect(verifyShareToken(4821, "")).toBe(false);
    expect(verifyShareToken(4821, undefined as unknown as string)).toBe(false);
  });

  it("does not throw on a length mismatch, which timingSafeEqual would", () => {
    expect(() => verifyShareToken(1, "short")).not.toThrow();
    expect(verifyShareToken(1, "short")).toBe(false);
  });

  it("builds the path the card is served at", () => {
    expect(shareCardPath(4821)).toBe(`/s/4821/${shareToken(4821)}`);
  });
});

describe("titles", () => {
  it("leads with the player's name when identity has resolved one", () => {
    expect(buildShareTitle({ ...base, subjectName: "Yousef Haddad" } as never))
      .toBe("Yousef Haddad — Volley from the edge of the box");
  });

  it("falls back to the clip title", () => {
    expect(buildShareTitle(base as never)).toBe("Volley from the edge of the box");
  });

  it("falls back again rather than emitting an empty og:title", () => {
    expect(buildShareTitle({ ...base, title: "   " } as never)).toBe("A moment on Replay");
  });

  it("describes the clip, not the site", () => {
    expect(buildShareDescription({ ...base, creatorName: "Mohammed", fieldName: "Jordan Galaxy" } as never))
      .toBe("Clipped by Mohammed · Jordan Galaxy · Watch on Replay");
  });
});

describe("the rendered card", () => {
  const html = buildShareCardHtml(base as never);

  it("states og:image with explicit dimensions — the large-card trigger", () => {
    expect(html).toContain(`<meta property="og:image" content="${base.posterUrl}" />`);
    expect(html).toContain(`<meta property="og:image:width" content="1200" />`);
    expect(html).toContain(`<meta property="og:image:height" content="630" />`);
    expect(html).toContain(`<meta name="twitter:card" content="summary_large_image" />`);
  });

  it("uses absolute URLs — a relative og:image is dropped by every scraper", () => {
    const ogImage = /property="og:image" content="([^"]+)"/.exec(html)?.[1];
    const ogUrl = /property="og:url" content="([^"]+)"/.exec(html)?.[1];
    expect(ogImage?.startsWith("https://")).toBe(true);
    expect(ogUrl).toBe(`https://replayjo.com${shareCardPath(4821)}`);
  });

  it("emits og:video for platforms that honour it", () => {
    expect(html).toContain(`<meta property="og:video" content="${base.videoUrl}" />`);
    expect(html).toContain(`<meta property="og:video:type" content="video/mp4" />`);
  });

  it("puts a muted autoplaying inline player above the fold", () => {
    const bodyStart = html.indexOf("<body>");
    const video = html.indexOf("<video", bodyStart);
    expect(video).toBeGreaterThan(-1);
    expect(html).toMatch(/<video[^>]*\bautoplay\b/s);
    expect(html).toMatch(/<video[^>]*\bmuted\b/s);
    expect(html).toMatch(/<video[^>]*\bplaysinline\b/s);
    // Nothing between <body> and the player: no interstitial, no consent gate.
    expect(html.slice(bodyStart + 6, video)).toMatch(/^\s*<div class="stage">\s*$/);
  });

  it("carries no login, install prompt or interstitial", () => {
    expect(html.toLowerCase()).not.toMatch(/sign in|log in|create an account|install the app/);
  });

  it("sets the poster attribute so the first paint is the frame, not black", () => {
    expect(html).toMatch(/poster="https:\/\/replayjo\.com\/s\/4821\/tok\/poster\.jpg"/);
  });

  it("degrades to an image when the export is not ready", () => {
    const pending = buildShareCardHtml({ ...base, videoUrl: null } as never);
    expect(pending).not.toContain("<video");
    expect(pending).toContain("<img src=");
    expect(pending).toContain("og:image");
    expect(pending).not.toContain("og:video");
  });

  it("falls back to the small card rather than a broken og:image when there is no poster", () => {
    const noPoster = buildShareCardHtml({ ...base, posterUrl: null } as never);
    expect(noPoster).not.toContain("og:image");
    expect(noPoster).toContain(`<meta name="twitter:card" content="summary" />`);
  });
});

describe("escaping", () => {
  it("escapes a title containing markup", () => {
    expect(escapeHtml(`<script>"x"&'y'`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;");
  });

  it("cannot be broken out of by a hostile clip title", () => {
    // Clip titles are user input and land in both a meta attribute and the body.
    const html = buildShareCardHtml({
      ...base,
      title: `"><script>alert(1)</script><meta property="og:image" content="https://evil/x.png`,
    } as never);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`content="https://evil/x.png`);
    expect(/property="og:image" content="[^"]*"/.exec(html)?.[0]).toBe(
      `property="og:image" content="${base.posterUrl}"`,
    );
  });
});
