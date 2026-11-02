/**
 * Pieces shared by the public home page (/) and the owner page (/demo), so the
 * two read as one site. Styles live in landing.css (.lp-*).
 */
import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";

import { withBase, type DemoClip, type DemoReport } from "@/pages/demo/data";

export const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Line icons, 24×24, stroked in currentColor. */
export const ICONS = {
  clips: "M6.5 8.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Zm0 12a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5ZM8.3 7.6 20 19M20 5 8.3 16.4",
  stats: "M4 20V11M10 20V4M16 20v-7M22 20H2",
  live: "M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2",
  history: "M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4M12 7.5V12l3 2",
  calendar: "M4 6h16v14H4zM4 10h16M8 3.5v4M16 3.5v4",
  var: "M3 5h18v12H3zM8 21h8M12 17v4M10 9l4 2-4 2z",
  bookings: "M5 12.5l4.5 4.5L19 7.5",
  players: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6.5 6.5 0 0 1 3.5 6",
  hands: "M7 12V5.5a1.5 1.5 0 0 1 3 0V11M10 10V4.5a1.5 1.5 0 0 1 3 0V11M13 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-.5A5.5 5.5 0 0 1 5 16.8L3.6 13a1.4 1.4 0 0 1 2.4-1.4L7 13",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 28 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Chevron() {
  return (
    <svg className="lp-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand() {
  return (
    <>
      <img src={`${import.meta.env.BASE_URL}replay-mark.svg`} alt="" aria-hidden="true" />
      <span className="replay-wordmark" aria-label="Replay">
        <span className="replay-wordmark-ar" lang="ar">ريبلاي</span>
        <span className="replay-wordmark-en">REPLAY</span>
      </span>
    </>
  );
}

/**
 * A muted looping clip that plays only while on screen, and never plays when
 * the visitor has asked for reduced motion (the poster stays instead).
 */
export function LoopVideo({ clip, fallback, className }: { clip: DemoClip | null | undefined; fallback: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const video = ref.current;
    if (!video || reduceMotion || !clip) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.25 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [clip, reduceMotion]);

  if (!clip || reduceMotion) {
    return <img className={className} src={clip ? withBase(clip.poster) : fallback} alt="" aria-hidden="true" />;
  }
  return (
    <video
      ref={ref}
      className={className}
      src={withBase(clip.src)}
      poster={withBase(clip.poster)}
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden="true"
    />
  );
}

/**
 * The clips the public pages may show. Only the demo's own branded copies
 * (crest in the corner, end card) qualify: both pages say clips are branded,
 * so an unbranded original never appears. Order is the admin's pin order.
 * With no branded copy ready, callers show a still instead.
 */
export function brandedClips(showcase: { clips?: DemoClip[]; socialClips?: DemoClip[] } | undefined): { wide: DemoClip[]; tall: DemoClip[] } {
  const all = [...(showcase?.clips ?? []), ...(showcase?.socialClips ?? [])].filter((clip) => clip.branded);
  return {
    wide: all.filter((clip) => clip.aspectRatio === "16:9"),
    tall: all.filter((clip) => clip.aspectRatio === "9:16"),
  };
}

export function formatLongDate(iso: string, rtl: boolean): string {
  const parsed = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat(rtl ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(parsed);
}

export type StatsLabels = {
  possession: string;
  goals: string;
  shots: string;
  passes: string;
  dribbles: string;
  note: (date: string) => string;
};

/**
 * Team numbers from the demo's real, anonymised match. Rows where both teams
 * have 0 are left out: a 0–0 row says nothing. Null when there is no report.
 */
export function MatchStatsCard({ report, labels, rtl }: { report: DemoReport | null; labels: StatsLabels; rtl: boolean }) {
  const team = report?.team;
  if (!report || !team) return null;
  const rows = ([
    [labels.goals, team.goals],
    [labels.shots, team.shots],
    [labels.passes, team.passesCompleted],
    [labels.dribbles, team.dribblesWon],
  ] as const).filter(([, pair]) => pair[0] + pair[1] > 0);
  return (
    <figure className="lp-stats" style={{ margin: 0 }}>
      <div className="lp-stats-row">
        <b>{team.possessionPercent[0]}%</b>
        <span>{labels.possession}</span>
        <b>{team.possessionPercent[1]}%</b>
      </div>
      <div className="lp-bar" aria-hidden="true">
        {/* kit colours can be near-black, so the bar uses the brand pair */}
        <i style={{ width: `${team.possessionPercent[0]}%`, background: "var(--replay-floodlight)" }} />
        <i style={{ width: `${team.possessionPercent[1]}%`, background: "var(--replay-violet)" }} />
      </div>
      {rows.map(([label, pair]) => (
        <div className="lp-stats-row" key={label}>
          <b>{pair[0]}</b>
          <span>{label}</span>
          <b>{pair[1]}</b>
        </div>
      ))}
      <figcaption className="lp-stats-note">{labels.note(formatLongDate(report.date, rtl))}</figcaption>
    </figure>
  );
}
