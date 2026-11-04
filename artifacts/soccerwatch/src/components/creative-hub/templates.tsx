import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import {
  CREATIVE_TEMPLATES,
  CLUB_TEMPLATES,
  FIELD_TEMPLATES,
  TEMPLATE_CATEGORIES,
  packLookOf,
  buildTemplateScene,
  type CreativeBrand,
  type CreativeFormat,
  type CreativeStyle,
  type MediaSource,
  type Scene,
  type SceneLayer,
  type TemplateCategory,
} from "@workspace/api-zod";
import { useCreativeTemplatesCopy } from "@/i18n/creative-templates-strings";
import { useCreateCreativeProject, useCreativeBrand, useCreativeSessionData } from "@/lib/creative-hub-api";
import { creativeMediaUrl } from "@/lib/creative-hub-media";
import { followTheBall } from "@/lib/creative-framing";
import { useLibraryMatches } from "@/lib/creative-hub-library-api";
import { offeredStyles } from "@/lib/creative-styles";
import { cn } from "@/lib/utils";
import { useConsoleKind } from "@/lib/console-kind";
import { projectTitle, seedKind, seedMedia, startingData } from "./templates/data";
import { useElementWidth } from "./templates/hooks";
import { StyleSwatch } from "./templates/style-swatch";
import { TemplateCard } from "./templates/template-card";
import { StarButton } from "./star-button";
import { starredFirst, useFavorites } from "@/lib/favorites-api";
import type { SectionProps, TemplateSeed } from "./types";

/**
 * Creative hub → Templates. Pick a look, a size and the post's language;
 * every design previews live in the academy's colours, crest and footage
 * (the seed's, else the latest match's). Tapping one creates a project and
 * opens it in the Editor.
 *
 * A field console (kind 'venue') also gets the field pack, an academy the
 * academy pack, as its own first chip and the default (unless a match was
 * picked: its facts fill the other templates): one look driven by the
 * branding, so the style picker hides there, and story or post only.
 */

const FORMATS: CreativeFormat[] = ["post", "square", "story"];
const FIELD_FORMATS: CreativeFormat[] = ["story", "post"];
type Group = TemplateCategory | "all" | "pack";
const POST_LOCALES: Array<"ar" | "en"> = ["ar", "en"];
const FALLBACK_BRAND: CreativeBrand = { primary: "#7B5CFF", accent: "#D4FF4F", ink: "#0B0F1A", paper: "#FFFFFF", muted: "#8A93A6", nameEn: "", nameAr: null };
type MediaLayer = Extract<SceneLayer, { kind: "image" | "video" }>;

function Chip({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} aria-pressed={active}
      className={cn("min-h-9 shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
        active ? "border-turf bg-turf text-void" : "border-line text-muted-text hover:text-text")}>
      {children}
    </button>
  );
}

function Segmented<T extends string>({ label, value, options, onChange, render }: {
  label: string; value: T; options: T[]; onChange: (v: T) => void; render: (v: T) => ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-semibold text-muted-text">{label}</span>
      <div className="flex rounded-full border border-line p-0.5" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(o)}
            className={cn("min-h-8 rounded-full px-3 text-xs font-semibold transition-colors", value === o ? "bg-turf text-void" : "text-muted-text hover:text-text")}>
            {render(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CreativeTemplates({ academyId, nav, seed }: SectionProps & { seed?: TemplateSeed | null }) {
  const copy = useCreativeTemplatesCopy();
  const brandQ = useCreativeBrand(academyId);
  const fav = useFavorites(academyId);
  const [active, setActive] = useState<TemplateSeed | null>(seed ?? null);
  useEffect(() => setActive(seed ?? null), [seed]);

  const sessionId = active?.type === "session" ? active.sessionId : null;
  const sessionQ = useCreativeSessionData(academyId, sessionId);
  const matches = useLibraryMatches(academyId, {});
  const stills = useMemo(() => matches.items.map((m) => m.still).filter((s): s is NonNullable<typeof s> => !!s).slice(0, 3) as MediaSource[], [matches.items]);

  const kind = seedKind(active);
  const venue = useConsoleKind() === "venue";
  const PACK = venue ? FIELD_TEMPLATES : CLUB_TEMPLATES;
  const [category, setCategory] = useState<Group>(seed?.type === "session" ? "all" : "pack");
  const fieldOnly = category === "pack";
  const [picked, setStyle] = useState<CreativeStyle | null>(null);
  const [format, setFormat] = useState<CreativeFormat>(kind === "video" ? "story" : "post");
  const [postLocale, setPostLocale] = useState<"ar" | "en">(copy.locale);
  const create = useCreateCreativeProject(academyId);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [gridRef, gridWidth] = useElementWidth<HTMLDivElement>();

  const brand = brandQ.data?.brand ?? FALLBACK_BRAND;
  const info = brandQ.data;
  // House styles plus the academy's own pack, first; the pack is the default look.
  const styles = useMemo(() => offeredStyles(info?.pack), [info?.pack]);
  const style: CreativeStyle = picked && styles.includes(picked) ? picked : styles[0];
  const styleOf = useCallback((key: string): CreativeStyle => packLookOf(key) ?? style, [style]);
  const academy = useMemo(() => ({
    nameEn: info?.brand.nameEn ?? "",
    nameAr: info?.brand.nameAr ?? null,
    phone: info?.phone ?? null,
    instagram: info?.instagram ?? null,
    showPlayerNames: info?.showPlayerNames ?? false,
  }), [info]);

  const templates = useMemo(() => {
    const list = category === "pack" ? PACK
      : category === "all" ? [...PACK, ...CREATIVE_TEMPLATES]
      : CREATIVE_TEMPLATES.filter((t) => t.category === category);
    // Footage first for a clip; stills first for a frame. Starred templates before both.
    const byKind = kind ? [...list].sort((a, b) => Number(b.kind === kind) - Number(a.kind === kind)) : list;
    return starredFirst(byKind, (t) => t.key, fav.data.template);
  }, [category, kind, fav.data.template, PACK]);

  const scenes = useMemo(() => new Map([...CREATIVE_TEMPLATES, ...PACK]
    .map((t) => [t.key, buildTemplateScene(t.key, styleOf(t.key), format, postLocale)])), [styleOf, format, postLocale, PACK]);
  const dataFor = useCallback((key: string) => startingData({ key, locale: postLocale, academy, seed: active, session: sessionQ.data ?? null, stills }),
    [postLocale, academy, active, sessionQ.data, stills]);

  const mediaUrl = useCallback((layer: MediaLayer) => creativeMediaUrl(academyId, layer.src, "still"), [academyId]);

  const open = async (key: string, title: string) => {
    setPending(key);
    setFailed(null);
    try {
      const data = dataFor(key);
      // A clip or moment with no camera chosen yet starts following the ball, not on the middle of the pitch.
      const footage = active && (active.type === "clip" || active.type === "recording") && active.framing === undefined ? seedMedia(active) : null;
      const framing = footage ? await followTheBall(academyId, footage) : null;
      const seed = framing && active ? { ...active, framing } as TemplateSeed : active;
      const project = await create.mutateAsync({
        title: projectTitle(title, data, active),
        templateKey: key,
        style: styleOf(key),
        scene: withSeedCamera(buildTemplateScene(key, styleOf(key), format, postLocale), seed),
        data,
        sourceSessionId: sessionId,
      });
      nav.openInEditor(project.id);
    } catch {
      setFailed(key);
    } finally {
      setPending(null);
    }
  };

  const cols = gridWidth < 560 ? 2 : gridWidth < 900 ? 3 : 4;
  const gap = 12;
  const cardW = gridWidth > 0 ? Math.floor((gridWidth - gap * (cols - 1)) / cols) : 0;
  const seedThumb = seedMedia(active);
  const seedThumbUrl = seedThumb ? creativeMediaUrl(academyId, seedThumb, "still") : null;
  const sessionLine = sessionQ.data?.match
    ? [sessionQ.data.match.opponent, sessionQ.data.match.date].filter(Boolean).join(" · ")
    : null;

  return (
    <section className="space-y-4" data-testid="creative-templates">
      <header>
        <h2 className="font-display text-lg font-bold text-text">{copy.heading}</h2>
        <p className="mt-0.5 text-sm text-muted-text">{copy.intro}</p>
      </header>

      {active ? (
        <div className="flex items-center gap-3 rounded-2xl border border-turf/40 bg-turf/10 p-2.5" data-testid="creative-templates-seed">
          {seedThumbUrl ? <img src={seedThumbUrl} alt="" className="h-12 w-16 shrink-0 rounded-lg bg-raised object-cover" /> : null}
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-semibold text-text">{copy.startingFrom} {copy.seeds[active.type]}</p>
            {active.type === "session" ? (
              <p className="truncate text-xs text-muted-text" dir="auto">
                {sessionQ.isLoading ? copy.loadingSession : sessionQ.isError ? copy.sessionFailed : sessionLine}
              </p>
            ) : null}
          </div>
          <button type="button" onClick={() => setActive(null)} data-testid="creative-templates-clear-seed"
            className="flex min-h-9 shrink-0 items-center gap-1 rounded-full border border-line px-3 text-xs font-semibold text-muted-text hover:text-text">
            <X className="h-3.5 w-3.5" aria-hidden />{copy.clearSeed}
          </button>
        </div>
      ) : null}

      <div className="space-y-3">
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          <Chip active={fieldOnly} onClick={() => { setCategory("pack"); if (!FIELD_FORMATS.includes(format)) setFormat("story"); }}
            testId={venue ? "creative-templates-cat-field" : "creative-templates-cat-club"}>{venue ? copy.fieldPack : copy.clubPack}</Chip>
          <Chip active={category === "all"} onClick={() => setCategory("all")} testId="creative-templates-cat-all">{copy.all}</Chip>
          {TEMPLATE_CATEGORIES.map((c) => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)} testId={`creative-templates-cat-${c}`}>{copy.categories[c]}</Chip>
          ))}
        </div>

        {fieldOnly ? <p className="text-xs text-muted-text" data-testid="creative-templates-field-hint">{venue ? copy.fieldPackHint : copy.clubPackHint}</p> : (
        <div>
          <p className="mb-1.5 text-xs font-semibold text-muted-text">{copy.styleLabel}</p>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="radiogroup" aria-label={copy.styleLabel}>
            {styles.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={style === s} onClick={() => setStyle(s)} title={copy.styleHints[s]}
                data-testid={`creative-templates-style-${s}`}
                className={cn("w-[84px] shrink-0 rounded-xl border p-1 text-start transition-colors", style === s ? "border-turf" : "border-line hover:border-muted-text")}>
                <span className="block h-14"><StyleSwatch style={s} brand={brand} /></span>
                <span className={cn("mt-1 block truncate px-0.5 text-[11px] font-semibold", style === s ? "text-text" : "text-muted-text")}>{copy.styles[s]}</span>
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-text">{copy.styleHints[style]}</p>
        </div>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Segmented label={copy.formatLabel} value={format} options={fieldOnly ? FIELD_FORMATS : FORMATS} onChange={(v) => setFormat(v as CreativeFormat)}
            render={(f: CreativeFormat) => <>{copy.formats[f]} <span className="font-mono opacity-70">{copy.formatHints[f]}</span></>} />
          <Segmented label={copy.languageLabel} value={postLocale} options={POST_LOCALES} onChange={(v) => setPostLocale(v as "ar" | "en")}
            render={(l: "ar" | "en") => <span lang={l}>{copy.languages[l]}</span>} />
        </div>
      </div>

      {brandQ.isError ? <p className="text-sm text-red-400" role="alert">{(brandQ.error as Error).message}</p> : null}

      <div ref={gridRef} className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap }}>
        {brandQ.isLoading
          ? Array.from({ length: cols * 2 }, (_, i) => <div key={i} className="aspect-[4/5] animate-pulse rounded-xl bg-raised" />)
          : templates.map((t) => {
            const title = t.title[copy.locale];
            return (
              <TemplateCard key={t.key} meta={t} title={title} scene={scenes.get(t.key)!} data={dataFor(t.key)} brand={brand} width={cardW}
                mediaUrl={mediaUrl} onOpen={() => void open(t.key, title)} busy={pending === t.key} disabled={pending !== null}
                failed={failed === t.key ? copy.createFailed : null}
                labels={{ video: copy.video, seconds: copy.seconds, creating: copy.creating, open: copy.open(title) }}
                star={<StarButton on={fav.isStarred("template", t.key)} onToggle={() => fav.toggle("template", t.key)} testId={`star-template-${t.key}`} />} />
            );
          })}
      </div>
      {!brandQ.isLoading && templates.length === 0 ? <p className="text-sm text-muted-text">{copy.noTemplates}</p> : null}
      {!active ? <p className="text-xs text-muted-text">{copy.sampleNote}</p> : null}
    </section>
  );
}

/**
 * Footage that came through the clip framer keeps its camera: the template's
 * main video slot (src {{media}}) gets the framing, the scene the branding.
 */
function withSeedCamera(scene: Scene, seed: TemplateSeed | null): Scene {
  if (!seed || (seed.type !== "clip" && seed.type !== "recording")) return scene;
  const { framing, branding } = seed;
  if (framing === undefined && !branding) return scene;
  return {
    ...scene,
    ...(branding ? { branding } : {}),
    layers: scene.layers.map((l) => {
      if (l.kind !== "video" || l.src.type !== "binding" || l.src.path !== "media") return l;
      const { framing: _old, ...rest } = l;
      return framing ? { ...rest, framing } : rest;
    }),
  };
}
