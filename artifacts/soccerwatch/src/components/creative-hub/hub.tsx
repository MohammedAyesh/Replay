import { useState } from "react";
import { Clapperboard, ImagePlus, LayoutTemplate, Library, PenTool, Send, Sparkles, Users } from "lucide-react";
import { useFavoriteCopy } from "@/i18n/favorite-strings";
import { StudioClipsPanel, StudioQuickPosts } from "@/components/academy-console/studio-section";
import { useCreativeCopy } from "@/i18n/creative-strings";
import { useFeaturedCopy } from "@/i18n/featured-strings";
import { CreativeSquad } from "./squad";
import { cn } from "@/lib/utils";
import { CreativeForYou } from "./for-you";
import { CreativeLibrary } from "./library";
import { CreativeTemplates } from "./templates";
import { CreativeEditor } from "./editor";
import { CreativePublish } from "./publish";
import type { HubNav, TemplateSeed } from "./types";

export type HubTab = "forYou" | "squad" | "library" | "clips" | "templates" | "quick" | "editor" | "publish";
type Tab = HubTab;
const TABS: Array<{ id: Tab; icon: typeof Sparkles }> = [
  { id: "forYou", icon: Sparkles },
  { id: "squad", icon: Users },
  { id: "library", icon: Library },
  // Clips and Quick posts were the Studio section's two tabs.
  { id: "clips", icon: Clapperboard },
  { id: "templates", icon: LayoutTemplate },
  { id: "quick", icon: ImagePlus },
  { id: "editor", icon: PenTool },
  { id: "publish", icon: Send },
];

const isTab = (v: string | null): v is Tab => TABS.some((t) => t.id === v);

/** The tab a link asks for (?tab=clips), e.g. from an old /studio link. */
export function tabFromUrl(search: string): Tab | null {
  const v = new URLSearchParams(search).get("tab");
  return isTab(v) ? v : null;
}

/** Academy console → Creative hub (owner only). Also holds what used to be the Studio section. */
export function AcademyCreativeHub({ academyId, initialTab }: { academyId: number; initialTab?: Tab | null }) {
  const copy = useCreativeCopy();
  const featured = useFeaturedCopy();
  const fav = useFavoriteCopy();
  const tabLabel = (id: Tab) => (id === "squad" ? featured.squad.tab : id === "clips" || id === "quick" ? fav.tabs[id] : copy.tabs[id]);
  const [tab, setTab] = useState<Tab>(initialTab ?? (typeof window === "undefined" ? null : tabFromUrl(window.location.search)) ?? "forYou");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [seed, setSeed] = useState<TemplateSeed | null>(null);

  const nav: HubNav = {
    openInEditor: (id) => { setProjectId(id); setTab("editor"); },
    openInPublish: (id) => { setProjectId(id); setTab("publish"); },
    openTemplates: (s) => { setSeed(s ?? null); setTab("templates"); },
  };

  return (
    <div className="flex min-h-0 flex-col gap-4" dir={copy.locale === "ar" ? "rtl" : "ltr"} data-testid="creative-hub">
      <header>
        <h1 className="font-display text-2xl font-bold text-text">{copy.title}</h1>
        <p className="mt-1 text-sm text-muted-text">{copy.intro}</p>
      </header>
      <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist">
        {TABS.map(({ id, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            data-testid={`creative-tab-${id}`}
            className={cn("flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors",
              tab === id ? "border-turf bg-turf text-void" : "border-line text-muted-text hover:text-text")}>
            <Icon className="h-4 w-4" aria-hidden />
            {tabLabel(id)}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        {tab === "forYou" ? <CreativeForYou academyId={academyId} nav={nav} />
          : tab === "squad" ? <CreativeSquad academyId={academyId} />
          : tab === "library" ? <CreativeLibrary academyId={academyId} nav={nav} />
          : tab === "clips" ? <StudioClipsPanel academyId={academyId} onMakePost={(clipId) => nav.openTemplates({ type: "clip", clipId })} />
          : tab === "quick" ? <StudioQuickPosts academyId={academyId} />
          : tab === "templates" ? <CreativeTemplates academyId={academyId} nav={nav} seed={seed} />
          : tab === "editor" ? <CreativeEditor academyId={academyId} nav={nav} projectId={projectId} />
          : <CreativePublish academyId={academyId} nav={nav} projectId={projectId} />}
      </div>
    </div>
  );
}
