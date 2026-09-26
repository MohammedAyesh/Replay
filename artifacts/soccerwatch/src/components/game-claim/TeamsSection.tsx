import type React from "react";
import { mmss } from "@/lib/game-claim/model";
import { hexToLab, labCss, labHex, sameLab, type Lab, type Play } from "@/lib/game-claim/play";
import type { GameStrings } from "@/i18n/game-strings";
import { Section, Stat } from "./bits";
import { cn } from "@/lib/utils";

/**
 * Teams, passes and possession: pick a shirt colour for each team from the
 * kits actually on the pitch, and possession, passing and your own share fall
 * out of the touches. The prototype's section, fed by the server's single
 * definition of a pass (api-server lib/matchPlay.ts).
 */
export function TeamsSection({ copy, play, loading, onPick }: {
  copy: GameStrings;
  play: Play | null;
  loading: boolean;
  onPick: (pick: { a: Lab; b: Lab }) => void;
}) {
  const c = copy.teams;
  if (loading && !play) return <Section title={c.title}><p className="text-sm text-muted-text">{c.loading}</p></Section>;
  if (!play?.available) return <Section title={c.title}><p className="text-sm text-muted-text">{c.unavailable}</p></Section>;
  if (!play.hasKits || !play.teams) return <Section title={c.title}><p className="text-sm text-muted-text">{c.noKits}</p></Section>;
  const { a, b } = play.teams;
  const s = play.team;
  const set = (which: 0 | 1, lab: Lab) => onPick(which === 0 ? { a: lab, b } : { a, b: lab });
  const row = (which: 0 | 1) => {
    const sel = which === 0 ? a : b;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 text-xs text-muted-text">{which === 0 ? c.one : c.other}</span>
        {play.kits.map((k, i) => (
          <button
            key={i}
            type="button"
            title={`${mmss(k.secs)}`}
            onClick={() => set(which, k.lab)}
            className={cn("h-9 w-9 rounded-full ring-1 ring-white/20", sameLab(sel, k.lab) && "ring-[3px] ring-floodlight")}
            style={{ background: labCss(k.lab) }}
          />
        ))}
        <input
          type="color"
          aria-label={c.anyColour}
          title={c.anyColour}
          value={labHex(sel)}
          onChange={(e) => set(which, hexToLab(e.target.value))}
          className="h-9 w-9 cursor-pointer rounded-full border border-line bg-transparent"
        />
      </div>
    );
  };
  const bar = (label: React.ReactNode, frac: number, right: string) => (
    <div className="grid grid-cols-[minmax(6.5rem,auto)_1fr_auto] items-center gap-3 text-sm">
      <span className="text-text">{label}</span>
      <div className="h-2.5 overflow-hidden rounded-full" style={{ background: labCss(b) }}>
        <i className="block h-full" style={{ width: `${(100 * Math.max(0, Math.min(1, frac))).toFixed(1)}%`, background: labCss(a) }} />
      </div>
      <span dir="ltr" className="text-xs tabular-nums text-muted-text">{right}</span>
    </div>
  );
  const pct = (x: number, y: number) => (y ? Math.round((100 * x) / y) : 0);
  const aT = s ? s.passesTried[0] + s.passesTried[1] : 0;
  const cT = s ? s.passesCompleted[0] + s.passesCompleted[1] : 0;
  return (
    <Section title={c.title}>
      <p className="max-w-[62ch] text-sm leading-6 text-muted-text">{c.lead}</p>
      <div className="flex flex-col gap-2">{row(0)}{row(1)}</div>
      {s && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Stat value={cT} label={c.completed} />
            <Stat value={aT - cT} label={c.notFound} />
            <Stat value={`${Math.round(s.completionPercent)}%`} label={c.completion} />
          </div>
          <div className="flex flex-col gap-2">
            {bar(c.possession, s.possessionPercent[0] / 100, `${Math.round(s.possessionPercent[0])}% / ${Math.round(s.possessionPercent[1])}%`)}
            {bar(c.completionRow, pct(s.passesCompleted[0], s.passesTried[0]) / 100, `${pct(s.passesCompleted[0], s.passesTried[0])}% / ${pct(s.passesCompleted[1], s.passesTried[1])}%`)}
            {bar(c.tried, s.passesTried[0] / Math.max(1, aT), `${s.passesTried[0]} / ${s.passesTried[1]}`)}
            {bar(c.touches, s.touches[0] / Math.max(1, s.total), `${s.touches[0]} / ${s.touches[1]}`)}
            {s.dribblesWon && bar(c.dribblesRow, s.dribblesWon[0] / Math.max(1, s.dribblesWon[0] + s.dribblesWon[1]), `${s.dribblesWon[0]} / ${s.dribblesWon[1]}`)}
            {s.shots && (s.shots[0] + s.shots[1] > 0) && bar(c.shotsRow, s.shots[0] / Math.max(1, s.shots[0] + s.shots[1]), `${s.shots[0]} / ${s.shots[1]}`)}
          </div>
          <p className="text-xs leading-5 text-muted-text">{c.alsoSeen(s.contested, play.rule.passMetres, s.carries, s.longestPassRun)}</p>
        </>
      )}
      <div className="grid grid-cols-3 gap-2">
        <Stat value={play.mine.touches.length} label={c.yourTouches} />
        <Stat value={`${play.mine.passesCompleted}/${play.mine.passesTried}`} label={c.yourPasses} />
        <Stat value={play.mine.passesReceived} label={c.toYou} />
      </div>
      {play.mine.dribblesWon !== undefined && (
        <div className="grid grid-cols-3 gap-2">
          <Stat value={play.mine.dribblesWon} label={c.yourDribbles} />
          <Stat value={play.mine.dribblesLost ?? 0} label={c.yourDribblesLost} />
          <Stat value={play.mine.shots?.length ?? 0} label={c.yourShots} />
        </div>
      )}
      {play.dribbleRule && (
        <p className="text-xs leading-5 text-muted-text">{c.dribbleNote(play.dribbleRule.pressureMetres, play.dribbleRule.outcomeSeconds)}</p>
      )}
      <p className="rounded-xl border border-line bg-surface p-3 text-xs leading-5 text-muted-text">
        {c.note(play.rule.maxGapSeconds, play.rule.contestMetres, play.rule.passMetres, s?.ambiguous ?? 0, s?.total ?? play.totals.touches)}
      </p>
    </Section>
  );
}
