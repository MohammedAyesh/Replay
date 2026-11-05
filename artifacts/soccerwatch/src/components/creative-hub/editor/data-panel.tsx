import { useState } from "react";
import { useCreativeBrand } from "@/lib/creative-hub-api";
import type { PickedPlayer } from "@/components/creative-hub/library/players";
import { ImagePlus, Plus, X } from "lucide-react";
import type { MediaSource } from "@workspace/api-zod";
import { fieldLabel, useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { getPath, isMediaField, isNumericField, parseFieldValue } from "@/lib/creative-editor-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EditorApi } from "./editor-api";

/** The template's {{details}}, stored in project.data. */
export function DataPanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  const [newKey, setNewKey] = useState("");
  const [extra, setExtra] = useState<string[]>([]);
  const showNames = useCreativeBrand(ed.academyId).data?.showPlayerNames === true;
  const [offer, setOffer] = useState<PickedPlayer | null>(null);
  const customKeys = [...Object.keys(ed.data.custom ?? {}).map((k) => `custom.${k}`), ...extra];
  // A line-up's row photos only exist for an academy that shows players' names (the server drops them otherwise).
  // A template's footage slots (Video 1, Video 2 …) are set in the Videos tab, with their camera and length.
  const slotPaths = new Set(ed.slots.map((s) => s.path));
  const fields = [...new Set([...ed.fields, ...customKeys])].filter((f) => (showNames || !/^photos\.\d+$/.test(f)) && !slotPaths.has(f));
  const playerFields = ed.fields.some((f) => f.startsWith("player."));
  const fillPlayer = (p: PickedPlayer) => {
    if (p.number !== null) ed.setData("player.number", p.number);
    if (p.position) ed.setData("player.position", p.position);
    if (showNames && p.firstName) ed.setData("player.name", p.firstName);
    setOffer(null);
  };

  const addCustom = () => {
    const key = newKey.trim().replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
    if (!key) return;
    setExtra((list) => (list.includes(`custom.${key}`) ? list : [...list, `custom.${key}`]));
    setNewKey("");
  };

  return (
    <div className="space-y-4" data-testid="editor-data-panel">
      <p className="text-xs text-muted-text">{copy.dataHint}</p>
      {slotPaths.size ? <p className="rounded-xl bg-violet/10 p-2.5 text-xs text-violet-200" data-testid="editor-data-videos-note">{copy.videos.inDetails}</p> : null}
      {offer ? (
        <div className="space-y-2 rounded-xl border border-turf/50 bg-turf/10 p-3" data-testid="editor-data-fill-player">
          <p className="text-xs text-muted-text">{copy.fillPlayerHint}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" className="min-h-9 flex-1 rounded-xl" onClick={() => fillPlayer(offer)}>
              {copy.fillPlayer(showNames && offer.firstName ? offer.firstName : offer.number !== null ? `#${offer.number}` : "")}
            </Button>
            <button type="button" aria-label={copy.clear} onClick={() => setOffer(null)} className="grid h-9 w-9 place-items-center rounded-lg text-muted-text hover:text-text">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}
      {fields.map((path) => {
        const id = `field-${path.replace(/\./g, "-")}`;
        const label = fieldLabel(copy, path);
        if (isMediaField(path)) {
          const src = getPath(ed.data, path) as MediaSource | undefined;
          return (
            <div key={path} className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-text">{label}</Label>
              <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-2 ps-3">
                <span className="flex-1 truncate text-sm text-text">{src ? copy.mediaKinds[src.type] ?? src.type : "—"}</span>
                <Button type="button" size="sm" variant="outline" className="min-h-9 rounded-xl" data-testid={`editor-data-pick-${path}`}
                  onClick={() => ed.pick(path === "media" ? "any" : "image", (picked, meta) => {
                    ed.setData(path, picked);
                    // Picked from the Player picker: offer his number, position and (names allowed) first name.
                    const who = (meta as { player?: PickedPlayer }).player;
                    if (who && playerFields) setOffer(who);
                  })}>
                  <ImagePlus className="h-4 w-4" />{copy.pick}
                </Button>
                {src ? (
                  <button type="button" aria-label={copy.clear} onClick={() => ed.setData(path, undefined)} className="grid h-9 w-9 place-items-center rounded-lg text-muted-text hover:text-text">
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            </div>
          );
        }
        const raw = getPath(ed.data, path);
        const value = raw === undefined || raw === null ? "" : String(raw);
        const numeric = isNumericField(path);
        return (
          <div key={path} className="space-y-1.5">
            <Label htmlFor={id} className="text-xs font-semibold text-muted-text">{label}</Label>
            <Input id={id} value={value} data-testid={`editor-data-${path}`}
              inputMode={numeric ? "numeric" : undefined} dir={numeric ? "ltr" : "auto"}
              placeholder={copy.placeholders[path] ?? ""} maxLength={numeric ? 4 : 200}
              onChange={(e) => ed.setData(path, numeric ? parseFieldValue(path, e.target.value) : e.target.value === "" ? undefined : e.target.value)}
              className="min-h-10 rounded-xl bg-surface" />
            {path === "player.name" ? <p className="text-[11px] text-muted-text">{copy.playerNameHint}</p> : null}
          </div>
        );
      })}
      <div className="space-y-1.5 border-t border-line pt-4">
        <Label htmlFor="editor-custom-key" className="text-xs font-semibold text-muted-text">{copy.addCustom}</Label>
        <div className="flex gap-2">
          <Input id="editor-custom-key" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder={copy.customName} dir="ltr"
            onKeyDown={(e) => { if (e.key === "Enter") addCustom(); }} className="min-h-10 rounded-xl bg-surface" />
          <Button type="button" variant="outline" className="min-h-10 rounded-xl" onClick={addCustom} aria-label={copy.addCustom}><Plus className="h-4 w-4" /></Button>
        </div>
      </div>
    </div>
  );
}
