import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Film, Image as ImageIcon, Scissors, Star, UserRound } from "lucide-react";
import type { MediaSource } from "@workspace/api-zod";
import { useCreativeLibraryCopy } from "@/i18n/creative-library-strings";
import { useLibraryPlayerMedia, useLibraryPlayers, type LibraryPlayerMedia } from "@/lib/creative-hub-library-api";
import { CHECKER, photoSrc } from "@/lib/player-photos-api";
import { cn } from "@/lib/utils";
import { Thumb, formatLength, stillUrls } from "./media";

/**
 * The Library picker's Players tab: the squad (shirt number, first name when
 * the academy shows names, main photo), then one player's gallery with two
 * tabs, Photos (his photo gallery) and Clips (his own clips and the match
 * moments the analysis bound to him).
 *
 * Players are mostly children: an academy that doesn't show names sees
 * numbers only and no photos (the server sends none and refuses to draw them).
 */

/** Who was picked, so the Editor can offer to fill the template's player.* data. */
export type PickedPlayer = { playerId: number; number: number | null; firstName: string | null; position: string | null };

export type PlayerPick = (source: MediaSource, meta: { durationMs?: number; label?: string; player: PickedPlayer }) => void;

export function PlayerPicker({ academyId, accept, onPick }: { academyId: number; accept: "image" | "video" | "any"; onPick: PlayerPick }) {
  const [playerId, setPlayerId] = useState<number | null>(null);
  return playerId === null
    ? <SquadList academyId={academyId} onOpen={setPlayerId} />
    : <PlayerGallery academyId={academyId} playerId={playerId} accept={accept} onPick={onPick} onBack={() => setPlayerId(null)} />;
}

function SquadList({ academyId, onOpen }: { academyId: number; onOpen: (playerId: number) => void }) {
  const copy = useCreativeLibraryCopy();
  const q = useLibraryPlayers(academyId);
  const [squadId, setSquadId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const list = useMemo(() => {
    const term = search.trim().replace(/^#/, "").toLowerCase();
    return (q.data?.players ?? []).filter((p) =>
      (!squadId || p.squadId === squadId)
      && (!term || String(p.number ?? "") === term || (p.firstName ?? "").toLowerCase().includes(term)));
  }, [q.data, squadId, search]);

  if (q.isLoading) return <p className="py-8 text-center text-sm text-muted-text">{copy.players.loading}</p>;
  const squads = q.data?.squads ?? [];
  return (
    <div className="space-y-3" data-testid="library-players">
      <p className="text-xs text-muted-text">{copy.players.intro}</p>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={copy.players.search} dir="auto"
        className="min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-text placeholder:text-muted-text" data-testid="library-players-search" />
      {squads.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {[{ id: 0, name: copy.filters.anySquad }, ...squads].map((s) => (
            <button key={s.id} type="button" onClick={() => setSquadId(s.id || null)}
              className={cn("min-h-8 rounded-full border px-3 text-xs font-semibold", (squadId ?? 0) === s.id ? "border-turf bg-turf/15 text-text" : "border-line text-muted-text hover:text-text")}>
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      {!list.length ? <p className="py-8 text-center text-sm text-muted-text">{copy.players.noPlayers}</p> : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {list.map((p) => (
            <button key={p.playerId} type="button" onClick={() => onOpen(p.playerId)} data-testid={`library-player-${p.playerId}`}
              className="flex flex-col items-center gap-1.5 rounded-2xl border border-line bg-surface p-2 text-center transition-colors hover:border-turf">
              <span className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-xl" style={p.photo ? CHECKER : undefined}>
                {p.photo
                  ? <img src={photoSrc(p.photo)} alt="" loading="lazy" className="h-full w-full object-contain object-bottom" />
                  : <span className="font-display text-3xl font-black text-text" dir="ltr">{p.number ?? <UserRound className="h-6 w-6 text-muted-text" aria-hidden />}</span>}
              </span>
              <span className="w-full truncate text-xs font-bold text-text">
                <span dir="ltr">{copy.players.shirt(p.number)}</span>{p.firstName ? ` · ${p.firstName}` : ""}
              </span>
              {p.position ? <span className="w-full truncate text-[10px] text-muted-text">{p.position}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PlayerGallery({ academyId, playerId, accept, onPick, onBack }: {
  academyId: number; playerId: number; accept: "image" | "video" | "any"; onPick: PlayerPick; onBack: () => void;
}) {
  const copy = useCreativeLibraryCopy();
  const q = useLibraryPlayerMedia(academyId, playerId);
  const photosOk = accept !== "video";
  const [tab, setTab] = useState<"photos" | "clips">(photosOk ? "photos" : "clips");
  const Back = copy.locale === "ar" ? ArrowRight : ArrowLeft;
  const d = q.data;
  const who: PickedPlayer | null = d ? { playerId: d.player.playerId, number: d.player.number, firstName: d.player.firstName, position: d.player.position } : null;
  const title = d ? `${copy.players.shirt(d.player.number)}${d.player.firstName ? ` · ${d.player.firstName}` : ""}` : "";

  return (
    <div className="space-y-3" data-testid="library-player-gallery">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-line px-3 text-xs font-semibold text-muted-text hover:text-text">
          <Back className="h-4 w-4" aria-hidden />{copy.players.back}
        </button>
        <span className="truncate font-display text-base font-bold text-text">{title}</span>
      </div>
      <div className="flex gap-1.5" role="tablist">
        {photosOk ? <TabButton on={tab === "photos"} onClick={() => setTab("photos")} icon={<ImageIcon className="h-4 w-4" />} label={copy.players.photos} /> : null}
        <TabButton on={tab === "clips"} onClick={() => setTab("clips")} icon={<Film className="h-4 w-4" />} label={copy.players.clips} />
      </div>
      {!d || !who ? <p className="py-8 text-center text-sm text-muted-text">{copy.players.loading}</p>
        : tab === "photos" ? <PhotosTab d={d} who={who} onPick={onPick} />
          : <ClipsTab academyId={academyId} d={d} who={who} accept={accept} onPick={onPick} />}
    </div>
  );
}

function TabButton({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button type="button" role="tab" aria-selected={on} onClick={onClick}
      className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold", on ? "border-turf bg-turf/15 text-text" : "border-line text-muted-text hover:text-text")}>
      {icon}{label}
    </button>
  );
}

function PhotosTab({ d, who, onPick }: { d: LibraryPlayerMedia; who: PickedPlayer; onPick: PlayerPick }) {
  const copy = useCreativeLibraryCopy();
  if (!d.showNames) return <p className="rounded-xl border border-line bg-surface p-3 text-sm text-muted-text" data-testid="library-player-names-off">{copy.players.namesOff}</p>;
  const primary = d.photos.find((p) => p.isPrimary) ?? null;
  const label = (extra?: string | null) => [copy.players.shirt(who.number), who.firstName, extra].filter(Boolean).join(" · ");
  return (
    <div className="space-y-3">
      {primary || d.hasAvatar ? (
        <button type="button" data-testid="library-player-main"
          onClick={() => onPick({ type: "player", playerId: who.playerId, cutout: primary?.transparent ?? false }, { label: label(copy.players.mainPhoto), player: who })}
          className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface p-2 text-start hover:border-turf">
          <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl" style={CHECKER}>
            {primary ? <img src={photoSrc(primary)} alt="" className="h-full w-full object-contain object-bottom" /> : <UserRound className="h-6 w-6 text-muted-text" aria-hidden />}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-text">{copy.players.mainPhoto}</span>
            <span className="block text-xs text-muted-text">{copy.players.mainPhotoHint}</span>
          </span>
        </button>
      ) : null}
      {!d.photos.length ? <p className="py-6 text-center text-sm text-muted-text">{copy.players.noPhotos}</p> : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {d.photos.map((p) => (
            <button key={p.photoId} type="button" data-testid={`library-player-photo-${p.photoId}`}
              onClick={() => onPick(p.source, { label: label(p.label), player: who })}
              className="group relative overflow-hidden rounded-xl border border-line text-start hover:border-turf">
              <span className="block aspect-[3/4]" style={CHECKER}>
                <img src={photoSrc(p)} alt={p.label ?? ""} loading="lazy" className="h-full w-full object-contain object-bottom" />
              </span>
              <span className="absolute top-1.5 start-1.5 flex gap-1">
                {p.isPrimary ? <Badge icon={<Star className="h-3 w-3" />} text={copy.players.primary} /> : null}
                {p.transparent ? <Badge icon={<Scissors className="h-3 w-3" />} text={copy.players.cutout} /> : null}
              </span>
              {p.label ? <span className="absolute inset-x-0 bottom-0 truncate bg-black/65 px-2 py-1 text-[11px] font-semibold text-white">{p.label}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Badge({ icon, text }: { icon: ReactNode; text: string }) {
  return <span className="inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">{icon}{text}</span>;
}

function ClipsTab({ academyId, d, who, accept, onPick }: { academyId: number; d: LibraryPlayerMedia; who: PickedPlayer; accept: "image" | "video" | "any"; onPick: PlayerPick }) {
  const copy = useCreativeLibraryCopy();
  const still = accept === "image";
  if (!d.clips.length && !d.moments.length) return <p className="py-8 text-center text-sm text-muted-text">{copy.players.noClips}</p>;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {d.clips.map((c) => (
        <button key={`c${c.clipId}`} type="button" data-testid={`library-player-clip-${c.clipId}`}
          onClick={() => onPick(c.source, { durationMs: c.durationMs, label: c.title ?? copy.players.hisClip, player: who })}
          className="space-y-1 rounded-xl border border-line bg-surface p-1.5 text-start hover:border-turf">
          <Thumb urls={stillUrls(academyId, c.source, c.thumbnailUrl)} video={!still} length={formatLength(c.durationMs)} className="aspect-video w-full" />
          <span className="block truncate px-1 text-xs font-semibold text-text">{c.title ?? copy.players.hisClip}</span>
          <span className="block px-1 text-[10px] text-muted-text" dir="ltr">{c.date}</span>
        </button>
      ))}
      {d.moments.map((m) => (
        <button key={`m${m.sessionId}-${m.id}`} type="button" data-testid={`library-player-moment-${m.id}`}
          onClick={() => onPick(still ? m.still : m.source, { durationMs: m.durationMs, label: copy.type[m.type], player: who })}
          className="space-y-1 rounded-xl border border-line bg-surface p-1.5 text-start hover:border-turf">
          <Thumb urls={stillUrls(academyId, m.still, m.thumbnailUrl)} video={!still} length={formatLength(m.durationMs)} className="aspect-video w-full" />
          <span className="block truncate px-1 text-xs font-semibold text-text">{copy.type[m.type]}{m.minute !== null ? ` · ${copy.minute(m.minute)}` : ""}</span>
        </button>
      ))}
    </div>
  );
}
