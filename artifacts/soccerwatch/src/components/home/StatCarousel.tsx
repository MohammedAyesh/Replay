import { useCallback, useEffect, useRef, useState } from "react";
import { StatTileCard } from "@/components/home/StatTile";
import { BetaPill, StatsBetaNote } from "@/components/match/StatsBeta";
import { useMatchCopy } from "@/i18n/match-strings";
import type { StatTile } from "@/lib/stat-tile";
import { cn } from "@/lib/utils";

/** Which slide is showing, from how far the rail has scrolled (RTL scrolls negative). */
export function slideIndex(scrollLeft: number, slideWidth: number, count: number): number {
  if (slideWidth <= 0 || count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(Math.abs(scrollLeft) / slideWidth)));
}

/**
 * Home's stat tiles as a swipeable row, most impressive first. Each slide is a
 * little narrower than the screen so the next one peeks in from the edge.
 * One tile renders on its own, without the carousel chrome.
 */
export function StatCarousel({ tiles }: { tiles: StatTile[] }) {
  const copy = useMatchCopy();
  const rail = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const step = useCallback(() => {
    const el = rail.current;
    const first = el?.children[0] as HTMLElement | undefined;
    if (!el || !first) return 0;
    const gap = parseFloat(getComputedStyle(el).columnGap || "0") || 0;
    return first.offsetWidth + gap;
  }, []);

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const onScroll = () => setActive(slideIndex(el.scrollLeft, step(), tiles.length));
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [step, tiles.length]);

  if (tiles.length === 0) return null;
  // The beta note sits outside the tile: the tiles keep their fixed height.
  if (tiles.length === 1) {
    return (
      <section aria-label={copy.yourNumbers} data-testid="home-stat-single">
        <StatsBetaNote className="mb-2 px-1" />
        <StatTileCard tile={tiles[0]} />
      </section>
    );
  }

  const go = (index: number) => {
    const el = rail.current;
    const slide = el?.children[index] as HTMLElement | undefined;
    if (!el || !slide) return;
    slide.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
  };

  return (
    <section aria-roledescription="carousel" aria-label={copy.yourNumbers} data-testid="home-stat-carousel">
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="flex items-center gap-2 text-sm font-bold">{copy.yourNumbers}<BetaPill /></h2>
        <span dir="ltr" className="text-xs font-semibold tabular-nums text-muted-text">{copy.slideOf(active + 1, tiles.length)}</span>
      </div>
      <p className="-mt-1 mb-2 px-1 text-[11px] leading-4 text-muted-text" data-testid="stats-beta-note">{copy.statsBeta.note}</p>
      <div
        ref={rail}
        className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-2.5 overflow-x-auto scroll-px-4 px-4"
      >
        {tiles.map((tile, index) => (
          <div
            key={`${tile.kind}-${index}`}
            role="group"
            aria-roledescription="slide"
            aria-label={copy.slideLabel(index + 1, tiles.length)}
            className="flex shrink-0 basis-[88%] snap-start sm:basis-[360px] [&>*]:w-full"
          >
            <StatTileCard tile={tile} />
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-center gap-1.5">
        {tiles.map((_, index) => (
          <button
            key={index}
            type="button"
            onClick={() => go(index)}
            aria-label={copy.slideLabel(index + 1, tiles.length)}
            aria-current={index === active ? "true" : undefined}
            className="flex h-6 items-center px-0.5"
          >
            <span className={cn("block h-1.5 rounded-full transition-all", index === active ? "w-[18px] bg-floodlight" : "w-1.5 bg-[#2C3650]")} />
          </button>
        ))}
      </div>
    </section>
  );
}
