import { useEffect, useMemo, useState } from "react";
import { Ban, Check } from "lucide-react";
import {
  CREATIVE_FORMATS, FIELD_STYLE, parsePlateKey, resolveColor, resolveTint,
  type CreativeStyle, type LayerTint, type Scene,
} from "@workspace/api-zod";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { changeStyle, plateOf } from "@/lib/creative-editor-state";
import { useCreativeBrand } from "@/lib/creative-hub-api";
import { creativeMediaUrl, useCreativeBackgrounds } from "@/lib/creative-hub-media";
import { offeredStyles } from "@/lib/creative-styles";
import { cn } from "@/lib/utils";
import { SceneCanvas } from "../scene-canvas";
import { NumberSlider, Section, Toggle, panelEmpty } from "./controls";
import { FadeSliders } from "./layer-common";
import type { EditorApi } from "./editor-api";

/**
 * The seven house looks, plus the academy's own brand pack first when it has
 * one (never another academy's), each previewed with the manager's own text
 * and pictures carried over.
 */
export function StylePanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  const brandInfo = useCreativeBrand(ed.academyId);
  const styles = useMemo(() => offeredStyles(brandInfo.data?.pack), [brandInfo.data?.pack]);
  const current = ed.scene.template?.style ?? null;
  const previews = useMemo(() => {
    if (!ed.scene.template) return null;
    const out = {} as Partial<Record<CreativeStyle, Scene>>;
    for (const s of styles) out[s] = s === current ? ed.scene : changeStyle(ed.scene, s);
    return out;
  }, [ed.scene, current, styles]);
  if (!previews) return <p className={panelEmpty}>{copy.noTemplate}</p>;
  if (current === FIELD_STYLE) return <p className={panelEmpty} data-testid="editor-style-field">{copy.fieldLook}</p>;
  return (
    <div className="space-y-5">
      <div className="space-y-3" data-testid="editor-style-panel">
        <p className="text-xs text-muted-text">{copy.styleHint}</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3">
          {styles.map((s) => (
            <button key={s} type="button" onClick={() => ed.setStyle(s)} aria-pressed={current === s} data-testid={`editor-style-${s}`}
              className={cn("group relative flex flex-col items-center gap-1.5 rounded-xl border p-1.5 transition-colors",
                current === s ? "border-turf bg-turf/10" : "border-line bg-surface hover:border-muted-text")}>
              <div className="pointer-events-none w-full overflow-hidden rounded-lg">
                <SceneCanvas scene={previews[s] ?? ed.scene} brand={ed.brand} data={ed.data} width={96} mediaUrl={ed.mediaUrl} className="mx-auto" />
              </div>
              <span className="text-[11px] font-semibold text-text">{copy.styles[s]}</span>
              {current === s ? <Check className="absolute end-2 top-2 h-4 w-4 rounded-full bg-turf p-0.5 text-void" /> : null}
            </button>
          ))}
        </div>
      </div>
      {current ? <BackgroundRow ed={ed} style={current} /> : null}
    </div>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const BRAND_TINTS = ["@primary", "@accent"] as const;

/** A tint with one thing changed, keeping the rest (amount 1 is stored as "no amount"). */
function nextTint(tint: LayerTint | undefined, change: Partial<LayerTint>): LayerTint {
  const color = change.color ?? tint?.color ?? "@primary";
  const mode = change.mode ?? tint?.mode;
  const amount = "amount" in change ? change.amount : tint?.amount;
  return { color, ...(mode ? { mode } : {}), ...(amount !== undefined && amount < 1 ? { amount: Math.max(0, Math.round(amount * 100) / 100) } : {}) };
}

/**
 * Background: the style's greyscale plates, previewed in the tint they would
 * get, "None", and the tint (main colour, second colour or a hex of their
 * own, and how strongly). Every change edits the "plate" layer.
 */
function BackgroundRow({ ed, style }: { ed: EditorApi; style: CreativeStyle }) {
  const copy = useCreativeEditorCopy();
  const plates = useCreativeBackgrounds(ed.academyId, style);
  const plate = plateOf(ed.scene);
  const shown = plate && !plate.hidden ? plate : null;
  const currentKey = shown?.src.type === "artwork" ? shown.src.key : null;
  const ownPicture = !!shown && !(shown.src.type === "artwork" && parsePlateKey(shown.src.key));
  const tint = plate?.tint;
  // Thumbnails show the tint the plate would get (the style's default when there is no plate layer yet).
  const previewTint = plate ? resolveTint(tint, ed.brand) : resolveTint({ color: "@primary" }, ed.brand);
  const { w, h } = CREATIVE_FORMATS[ed.scene.format];
  const list = plates.data ?? [];
  const tile = "relative flex flex-col items-center gap-1 rounded-xl border p-1 transition-colors";

  const custom = !!tint && !tint.color.startsWith("@");
  const resolved = resolveColor(tint?.color ?? "@primary", ed.brand, "#FFFFFF").slice(0, 7);
  const [hex, setHex] = useState(resolved);
  useEffect(() => setHex(resolved), [resolved]);

  return (
    <Section title={copy.background}>
      <p className="text-xs text-muted-text">{copy.backgroundHint}</p>
      {plates.isSuccess && !list.length && !ownPicture ? (
        <p className="text-xs text-muted-text" data-testid="editor-background-none-available">{copy.backgroundNoArt}</p>
      ) : (
        <div className="grid grid-cols-4 gap-2" data-testid="editor-backgrounds" role="group" aria-label={copy.background}>
          <button type="button" className={cn(tile, !shown ? "border-turf bg-turf/10" : "border-line bg-surface hover:border-muted-text")}
            aria-pressed={!shown} onClick={() => ed.setPlate({ hidden: true })} data-testid="editor-background-off">
            <span className="grid w-full place-items-center rounded-lg bg-raised text-muted-text" style={{ aspectRatio: `${w} / ${h}` }}>
              <Ban className="h-5 w-5" aria-hidden />
            </span>
            <span className="text-[11px] font-semibold text-text">{copy.backgroundNone}</span>
          </button>
          {list.map((p) => {
            const active = currentKey === p.key;
            const url = creativeMediaUrl(ed.academyId, { type: "artwork", key: p.key }, "still", { format: ed.scene.format, tint: previewTint, size: 384 });
            return (
              <button key={p.key} type="button" aria-pressed={active} data-testid={`editor-background-${p.n}`}
                onClick={() => ed.setPlate({ src: { type: "artwork", key: p.key }, hidden: false })}
                className={cn(tile, active ? "border-turf bg-turf/10" : "border-line bg-surface hover:border-muted-text")}>
                <span className="block w-full overflow-hidden rounded-lg bg-raised" style={{ aspectRatio: `${w} / ${h}` }}>
                  {url ? <img src={url} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" /> : null}
                </span>
                <span className="text-[11px] font-semibold text-text">{copy.backgroundArt(p.n)}</span>
                {active ? <Check className="absolute end-1.5 top-1.5 h-4 w-4 rounded-full bg-turf p-0.5 text-void" /> : null}
              </button>
            );
          })}
        </div>
      )}

      {shown && (list.length > 0 || ownPicture) ? (
        <div className="space-y-3 pt-1" data-testid="editor-background-tint">
          <span className="text-sm text-text">{copy.tintColour}</span>
          <div className="flex flex-wrap items-center gap-2">
            {BRAND_TINTS.map((t) => (
              <button key={t} type="button" aria-pressed={tint?.color === t} onClick={() => ed.setPlate({ tint: nextTint(tint, { color: t }) })}
                data-testid={`editor-background-tint-${t.slice(1)}`}
                className={cn("flex min-h-9 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold",
                  tint?.color === t ? "border-turf text-text" : "border-line text-muted-text")}>
                <span className="h-5 w-5 rounded-full border border-white/20" style={{ background: resolveColor(t, ed.brand) }} />
                {t === "@primary" ? copy.tintMain : copy.tintSecond}
              </button>
            ))}
            <label className={cn("flex min-h-9 items-center gap-1.5 rounded-full border py-1 pe-2 ps-1 text-[11px] font-semibold",
              custom ? "border-turf text-text" : "border-line text-muted-text")}>
              <input type="color" value={HEX.test(resolved) ? resolved : "#ffffff"} aria-label={copy.tintCustom}
                onChange={(e) => ed.setPlate({ tint: nextTint(tint, { color: e.target.value.toUpperCase() }) }, "tint-colour")}
                className="h-7 w-7 cursor-pointer rounded-full border-0 bg-transparent p-0" data-testid="editor-background-tint-custom" />
              {copy.tintCustom}
            </label>
            <input value={hex} dir="ltr" spellCheck={false} aria-label={copy.hex}
              onChange={(e) => { setHex(e.target.value); if (HEX.test(e.target.value)) ed.setPlate({ tint: nextTint(tint, { color: e.target.value.toUpperCase() }) }, "tint-colour"); }}
              className={cn("h-9 w-24 rounded-lg border bg-surface px-2 font-mono text-xs text-text", custom ? "border-turf/60" : "border-line opacity-70")} />
          </div>
          <NumberSlider label={copy.tintStrength} value={Math.round((tint ? tint.amount ?? 1 : 0) * 100)} min={0} max={100} unit="%"
            testId="editor-background-strength"
            onChange={(v) => ed.setPlate({ tint: nextTint(tint, { amount: v / 100 }) }, "tint-amount")} />
        </div>
      ) : null}

      {shown && ed.isVideo ? <BackgroundFades ed={ed} plate={shown} /> : null}
    </Section>
  );
}

/** The clip the background steps aside for: the main footage (the template's {{media}} slot), else the biggest video layer. */
export function mainClipWindow(scene: Scene): { fromMs: number; toMs: number } | null {
  const D = scene.durationMs ?? 0;
  const videos = scene.layers.filter((l) => l.kind === "video" && !l.hidden);
  if (!videos.length || !D) return null;
  const main = videos.find((l) => l.kind === "video" && l.src.type === "binding" && l.src.path === "media")
    ?? [...videos].sort((a, b) => b.w * b.h - a.w * a.h)[0]!;
  const fromMs = main.startMs ?? 0;
  const toMs = Math.min(main.endMs ?? D, D);
  return toMs > fromMs ? { fromMs, toMs } : null;
}

const DIP_MS = 600;

/** Video designs: the background fades in and out, and can step aside while the clip plays. */
function BackgroundFades({ ed, plate }: { ed: EditorApi; plate: NonNullable<ReturnType<typeof plateOf>> }) {
  const copy = useCreativeEditorCopy();
  const clip = mainClipWindow(ed.scene);
  return (
    <div className="space-y-3 border-t border-line pt-3" data-testid="editor-background-fades">
      <span className="text-sm font-semibold text-text">{copy.backgroundFades}</span>
      <FadeSliders ed={ed} layer={plate} onChange={(change, key) => ed.setPlate(change, key)} />
      {clip ? (
        <div className="space-y-1">
          <Toggle id="editor-background-dip" label={copy.dipForClip} checked={!!plate.dip} testId="editor-background-dip"
            onChange={(on) => ed.setPlate({ dip: on ? { ...clip, fadeMs: DIP_MS } : null })} />
          <p className="text-[11px] text-muted-text">{copy.dipForClipHint}</p>
        </div>
      ) : null}
    </div>
  );
}
