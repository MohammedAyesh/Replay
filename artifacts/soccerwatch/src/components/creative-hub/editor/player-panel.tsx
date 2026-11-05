import { ImagePlus, Scissors, UserRound, X } from "lucide-react";
import type { MediaSource } from "@workspace/api-zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { useCreativeBrand } from "@/lib/creative-hub-api";
import { getPath } from "@/lib/creative-editor-state";
import type { PickedPlayer } from "@/components/creative-hub/library/players";
import type { EditorApi } from "./editor-api";

/**
 * Editor → Player: the one place to say who a player design is about. "Choose a player" opens
 * the Players tab of the picker; his photo, shirt number, position and (names shown) first name
 * come in together. A photo without its background (a PNG cut-out) stands in front of the
 * stadium; one with a background shows as it is.
 */
export function PlayerPanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  const t = copy.player;
  const showNames = useCreativeBrand(ed.academyId).data?.showPlayerNames === true;
  const photo = getPath(ed.data, "player.photo") as MediaSource | undefined;
  const number = getPath(ed.data, "player.number");
  const name = getPath(ed.data, "player.name");
  const position = getPath(ed.data, "player.position");
  const url = photo ? ed.mediaUrl({ id: "player-preview", kind: "image", src: photo, x: 0, y: 0, w: 1, h: 1, fit: "contain" } as never) : null;
  const cutout = Boolean(photo && "cutout" in photo && photo.cutout);

  const choose = (tab: "players" | "library") => ed.pick("image", (src, meta) => {
    ed.setData("player.photo", src);
    const who = (meta as { player?: PickedPlayer }).player;
    if (who) {
      if (who.number !== null) ed.setData("player.number", who.number);
      if (who.position) ed.setData("player.position", who.position);
      ed.setData("player.name", showNames && who.firstName ? who.firstName : undefined);
    }
  }, { tab });

  const field = (path: string, label: string, value: unknown, numeric = false) => (
    <div className="space-y-1">
      <Label htmlFor={`player-${path}`} className="text-xs font-semibold text-muted-text">{label}</Label>
      <Input id={`player-${path}`} value={value === undefined || value === null ? "" : String(value)} dir={numeric ? "ltr" : "auto"} inputMode={numeric ? "numeric" : undefined}
        maxLength={numeric ? 3 : 40} data-testid={`editor-player-${path.split(".")[1]}`}
        onChange={(e) => ed.setData(path, e.target.value === "" ? undefined : numeric ? Number(e.target.value.replace(/\D/g, "")) || undefined : e.target.value)}
        className="min-h-10 rounded-xl bg-surface" />
    </div>
  );

  return (
    <div className="space-y-4" data-testid="editor-player-panel">
      <p className="text-xs text-muted-text">{t.hint}</p>
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
        <span className="grid h-24 w-20 shrink-0 place-items-center overflow-hidden rounded-xl bg-raised">
          {url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <UserRound className="h-7 w-7 text-muted-text" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-lg font-bold text-text" dir="auto">{(showNames && name ? String(name) : "") || (number !== undefined && number !== null ? `#${String(number)}` : "—")}</span>
          {position ? <span className="block truncate text-xs text-muted-text" dir="auto">{String(position)}</span> : null}
          <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-muted-text">
            {photo ? (cutout ? <><Scissors className="h-3 w-3" />{t.cutout}</> : t.card) : t.noPhoto}
          </span>
        </span>
        {photo ? (
          <button type="button" aria-label={t.remove} onClick={() => ed.setData("player.photo", undefined)} className="grid h-9 w-9 place-items-center rounded-lg text-muted-text hover:text-text">
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Button type="button" className="min-h-11 w-full rounded-xl" onClick={() => choose("players")} data-testid="editor-player-choose">
          <UserRound className="me-1.5 h-4 w-4" />{photo || number !== undefined ? t.change : t.choose}
        </Button>
        <p className="text-[11px] leading-4 text-muted-text">{t.chooseHint}</p>
      </div>
      <div className="space-y-1.5">
        <Button type="button" variant="outline" className="min-h-10 w-full rounded-xl" onClick={() => choose("library")} data-testid="editor-player-upload">
          <ImagePlus className="me-1.5 h-4 w-4" />{t.upload}
        </Button>
        <p className="text-[11px] leading-4 text-muted-text">{t.uploadHint}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 border-t border-line pt-4">
        {field("player.number", copy.fields["player.number"] ?? "#", number, true)}
        {field("player.position", copy.fields["player.position"] ?? "", position)}
        {showNames ? <div className="col-span-2">{field("player.name", copy.fields["player.name"] ?? "", name)}</div> : <p className="col-span-2 text-[11px] text-muted-text">{t.namesOff}</p>}
      </div>
    </div>
  );
}
