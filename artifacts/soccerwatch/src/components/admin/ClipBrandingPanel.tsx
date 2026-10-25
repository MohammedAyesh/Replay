import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Drawn clip branding for one scope: the venue's look (crest, colours, names,
 * booking line), the switches that decide what its clips get, and a preview of
 * the result over real Jordan Galaxy footage.
 *
 * The switches are ordinary settings. For "Everyone" they change the base
 * value; for a field or an academy they write (or update, or remove) a rule
 * scoped to it — the same rules the Settings tab lists, so nothing here is a
 * second source of truth.
 */

export type ScopeType = "academy" | "field" | "global";
export type Scope = { type: ScopeType; id: number };

export interface BrandingProfile {
  id: number;
  scopeType: ScopeType;
  scopeId: number;
  nameEn: string;
  nameAr: string | null;
  taglineAr: string | null;
  primaryColor: string;
  accentColor: string | null;
  bookingPhone: string | null;
  instagram: string | null;
  crestUrl: string | null;
  crestPreset: string | null;
  showPlayerNames: boolean;
  updatedAt: string;
}

export interface BrandingPresetInfo { key: string; label: string; source: string }

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`${basePath}/api${path}`, {
    credentials: "include",
    headers: opts?.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body;
}

const scopeKey = (s: Scope) => (s.type === "global" ? "global" : `${s.type}:${s.id}`);

// ── The look ──────────────────────────────────────────────────────────────

type Draft = {
  nameEn: string;
  nameAr: string;
  taglineAr: string;
  primaryColor: string;
  accentColor: string;
  bookingPhone: string;
  instagram: string;
  showPlayerNames: boolean;
};

const EMPTY_DRAFT: Draft = {
  nameEn: "", nameAr: "", taglineAr: "", primaryColor: "#2FD8C4", accentColor: "",
  bookingPhone: "", instagram: "", showPlayerNames: false,
};

function draftFrom(p: BrandingProfile | null): Draft {
  if (!p) return EMPTY_DRAFT;
  return {
    nameEn: p.nameEn,
    nameAr: p.nameAr ?? "",
    taglineAr: p.taglineAr ?? "",
    primaryColor: p.primaryColor,
    accentColor: p.accentColor ?? "",
    bookingPhone: p.bookingPhone ?? "",
    instagram: p.instagram ?? "",
    showPlayerNames: p.showPlayerNames,
  };
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  dir?: "rtl" | "ltr";
  placeholder?: string;
  hint?: string;
}) {
  const id = `cbp-${props.label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-muted-text text-[11px] uppercase tracking-wider">{props.label}</label>
      <input
        id={id}
        dir={props.dir}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full bg-void border border-line rounded px-2 py-1.5 text-sm text-text"
      />
      {props.hint && <p className="text-muted-text text-[11px]">{props.hint}</p>}
    </div>
  );
}

function ColorField(props: { label: string; value: string; onChange: (v: string) => void; optional?: boolean }) {
  const id = `cbp-${props.label.replace(/\W+/g, "-").toLowerCase()}`;
  const valid = /^#[0-9a-fA-F]{6}$/.test(props.value);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-muted-text text-[11px] uppercase tracking-wider">{props.label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${props.label} picker`}
          value={valid ? props.value : props.optional ? "#000000" : "#2FD8C4"}
          onChange={(e) => props.onChange(e.target.value.toUpperCase())}
          className={cn("h-9 w-11 rounded border border-line bg-void p-0.5", props.optional && !valid && "opacity-30")}
        />
        <input
          id={id}
          value={props.value}
          placeholder={props.optional ? "none" : "#F4CF1F"}
          onChange={(e) => props.onChange(e.target.value)}
          className="w-28 bg-void border border-line rounded px-2 py-1.5 text-sm text-text font-mono"
        />
        {props.optional && props.value && (
          <button type="button" onClick={() => props.onChange("")} className="text-muted-text text-xs hover:text-text">Clear</button>
        )}
      </div>
    </div>
  );
}

function LookSection(props: {
  scope: Scope;
  scopeLabel: string;
  profile: BrandingProfile | null;
  inherited: BrandingProfile | null;
  presets: BrandingPresetInfo[];
  profilesReady: boolean;
  onSaved: () => Promise<void>;
}) {
  const { scope, profile } = props;
  const [draft, setDraft] = useState<Draft>(draftFrom(profile));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setDraft(draftFrom(profile ?? null)); setError(null); }, [profile, scope.type, scope.id]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await props.onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const save = () => run("save", () => api("/admin/branding/profile", {
    method: "PUT",
    body: JSON.stringify({
      scope: scopeKey(scope),
      ...draft,
      accentColor: draft.accentColor.trim() || null,
    }),
  }));
  const applyPreset = (preset: string) => run(`preset:${preset}`, () => api("/admin/branding/preset", {
    method: "POST",
    body: JSON.stringify({ scope: scopeKey(scope), preset }),
  }));
  const remove = () => run("remove", () => api(`/admin/branding/profile?scope=${encodeURIComponent(scopeKey(scope))}`, { method: "DELETE" }));
  const uploadCrest = (file: File) => run("crest", () => {
    const form = new FormData();
    form.append("scope", scopeKey(scope));
    form.append("asset", file);
    return api("/admin/branding/crest", { method: "PUT", body: form });
  });

  const crestSrc = profile?.crestPreset
    ? `${basePath}/api/admin/branding/preset-crest/${profile.crestPreset}`
    : profile?.crestUrl ?? null;

  return (
    <div className="rounded border border-line bg-surface/40 p-3 space-y-3">
      <div>
        <p className="text-text text-sm font-semibold">
          {scope.type === "global" ? "The default look on clips" : `How ${props.scopeLabel} looks on clips`}
        </p>
        <p className="text-muted-text text-xs mt-0.5">
          The crest, colour and names the export draws on the overlay and the end screen.
          {!profile && props.inherited && ` Not set here, so clips use ${props.inherited.nameEn}'s.`}
          {!profile && !props.inherited && " Not set: clips would use the name alone, in Turf."}
        </p>
      </div>

      {!props.profilesReady && (
        <p className="text-muted-text text-xs rounded border border-line px-2 py-1.5">
          The branding_profiles table is not in this database yet. In development run
          {" "}<code>pnpm --filter @workspace/db run push</code>; production gets it on the next Publish from the Replit website.
        </p>
      )}

      {props.presets.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-muted-text text-[11px] uppercase tracking-wider">Use a real venue's branding</p>
          <div className="flex flex-wrap gap-2">
            {props.presets.map((p) => (
              <button
                key={p.key}
                type="button"
                disabled={!!busy}
                onClick={() => void applyPreset(p.key)}
                title={`From ${p.source}`}
                className="px-3 py-1.5 rounded-full border border-violet text-text text-xs font-semibold hover:bg-violet/15 disabled:opacity-50"
              >
                {busy === `preset:${p.key}` ? "Applying…" : p.label}
              </button>
            ))}
          </div>
          <p className="text-muted-text text-[11px]">Crest, colour, Arabic name and phone, taken from the venue's own public pages.</p>
        </div>
      )}

      <div className="flex items-start gap-3">
        <div
          className="w-24 h-24 shrink-0 rounded border border-line flex items-center justify-center"
          style={{
            backgroundImage:
              "linear-gradient(45deg,color-mix(in srgb,var(--replay-line) 55%,var(--replay-void)) 25%,transparent 25%,transparent 75%,color-mix(in srgb,var(--replay-line) 55%,var(--replay-void)) 75%)," +
              "linear-gradient(45deg,color-mix(in srgb,var(--replay-line) 55%,var(--replay-void)) 25%,transparent 25%,transparent 75%,color-mix(in srgb,var(--replay-line) 55%,var(--replay-void)) 75%)",
            backgroundSize: "12px 12px",
            backgroundPosition: "0 0, 6px 6px",
          }}
        >
          {crestSrc
            ? <img src={crestSrc} alt={`${profile?.nameEn ?? "Venue"} crest`} className="max-w-[88px] max-h-[88px] object-contain" />
            : <span className="text-muted-text text-[11px] text-center px-1">No crest: initials are drawn</span>}
        </div>
        <div className="space-y-1.5 min-w-0">
          <label className="text-muted-text text-[11px] uppercase tracking-wider block" htmlFor="cbp-crest">Crest</label>
          <input
            id="cbp-crest"
            type="file"
            accept="image/png"
            disabled={!!busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadCrest(f); e.target.value = ""; }}
            className="block w-full text-xs text-muted-text file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-raised file:text-text file:text-xs"
          />
          <p className="text-muted-text text-[11px]">A PNG with a transparent background, about 600 px tall.</p>
          {busy === "crest" && <p className="text-muted-text text-xs">Uploading…</p>}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name (English)" value={draft.nameEn} onChange={(v) => set("nameEn", v)} placeholder="Required, as it should appear" />
        <TextField label="Name (Arabic)" dir="rtl" value={draft.nameAr} onChange={(v) => set("nameAr", v)} placeholder="Optional" />
        <TextField label="Line on the sign-off (Arabic)" dir="rtl" value={draft.taglineAr} onChange={(v) => set("taglineAr", v)} placeholder="Optional" />
        <TextField label="Booking phone" value={draft.bookingPhone} onChange={(v) => set("bookingPhone", v)} placeholder="Optional, e.g. 07 9xxx xxxx" />
        <TextField label="Instagram" value={draft.instagram} onChange={(v) => set("instagram", v)} placeholder="handle, without @" hint="Shown when there is no phone." />
        <div className="grid grid-cols-1 gap-3">
          <ColorField label="Main colour" value={draft.primaryColor} onChange={(v) => set("primaryColor", v)} />
          <ColorField label="Second colour" value={draft.accentColor} onChange={(v) => set("accentColor", v)} optional />
        </div>
      </div>

      {scope.type === "academy" && (
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={draft.showPlayerNames} onChange={(e) => set("showPlayerNames", e.target.checked)} />
          Show players' first names (off: shirt numbers only — most academy players are children)
        </label>
      )}

      {error && <p className="text-text text-sm rounded border border-line px-2 py-1.5">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!!busy || !props.profilesReady}
          className="px-4 py-2 rounded-full bg-floodlight text-void text-sm font-bold disabled:opacity-50"
        >
          {busy === "save" ? "Saving…" : "Save look"}
        </button>
        {profile && (
          <button type="button" onClick={() => void remove()} disabled={!!busy} className="text-muted-text text-xs hover:text-text">
            Remove this look
          </button>
        )}
      </div>
    </div>
  );
}

// ── The switches ──────────────────────────────────────────────────────────

type RuleRef = {
  id: number;
  scopeType: string;
  scopeId: number | null;
  daysOfWeek: number[] | null;
  startMinute: number | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
};
type Explained = {
  definition: { key: string; type: string; options?: string[]; min?: number; max?: number; defaultValue: unknown };
  resolution: { value: unknown; source: "rule" | "default" | "shipped"; matched: RuleRef[]; rule: RuleRef | null };
};

const KEYS = {
  overlayEnabled: "branding.overlayEnabled",
  style: "branding.overlayStyle",
  endOn: "branding.endScreenEnabled",
  player: "branding.endScreen.player",
  match: "branding.endScreen.match",
  academy: "branding.endScreen.academy",
  signOff: "branding.endScreen.signOff",
  seconds: "branding.endScreen.seconds",
  blur: "branding.endScreen.blur",
  dim: "branding.endScreen.dim",
} as const;

const STYLE_LABEL: Record<string, string> = {
  uploaded: "Uploaded PNG",
  cornerCrest: "Corner crest",
  broadcastBar: "Name bar + date",
  academyFrame: "Academy frame",
};

/** A rule this panel owns: scoped to exactly this venue, no time window. */
function ownRule(e: Explained | undefined, scope: Scope): RuleRef | null {
  if (!e || scope.type === "global") return null;
  return e.resolution.matched.find((r) =>
    r.scopeType === scope.type && r.scopeId === scope.id &&
    !r.daysOfWeek?.length && r.startMinute == null && !r.effectiveFrom && !r.effectiveUntil,
  ) ?? null;
}

function SliderRow(props: {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  current: number;
  disabled: boolean;
  origin: ReactNode;
  onCommit: (value: number) => void;
}) {
  const [local, setLocal] = useState(props.current);
  useEffect(() => setLocal(props.current), [props.current]);
  const commit = () => { if (local !== props.current) props.onCommit(local); };
  return (
    <div className="space-y-1 py-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={props.id} className="text-sm text-text">
          {props.label}: <span className="font-mono">{local}{props.unit}</span>
        </label>
        {props.origin}
      </div>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={local}
        disabled={props.disabled}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="w-full accent-[var(--replay-turf)]"
      />
    </div>
  );
}

function SwitchesSection(props: {
  scope: Scope;
  scopeLabel: string;
  onChanged: (values: Record<string, unknown>) => void;
}) {
  const { scope } = props;
  const [explained, setExplained] = useState<Record<string, Explained>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const q = scope.type === "field" ? `?fieldId=${scope.id}` : scope.type === "academy" ? `?academyId=${scope.id}` : "";
    try {
      const data = await api(`/admin/settings/preview${q}`);
      const map: Record<string, Explained> = {};
      for (const row of (data.settings ?? []) as Explained[]) map[row.definition.key] = row;
      setExplained(map);
      setError(data.schemaReady === false ? (data.message ?? "Settings tables are missing.") : null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [scope.type, scope.id]);

  useEffect(() => { void load(); }, [load]);

  // What the admin just chose, shown until the server's answer replaces it, so a
  // switch moves when clicked rather than a round trip later.
  const [pending, setPending] = useState<Record<string, unknown>>({});
  const value = (key: string) => (key in pending ? pending[key] : explained[key]?.resolution.value);
  useEffect(() => {
    const values: Record<string, unknown> = {};
    for (const key of Object.values(KEYS)) values[key] = value(key);
    props.onChanged(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explained]);

  async function change(key: string, next: unknown) {
    setBusy(key);
    setError(null);
    setPending((p) => ({ ...p, [key]: next }));
    try {
      if (scope.type === "global") {
        await api(`/admin/settings/defaults/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value: next }) });
      } else {
        const own = ownRule(explained[key], scope);
        if (own) {
          await api(`/admin/settings/rules/${own.id}`, { method: "PATCH", body: JSON.stringify({ value: next }) });
        } else {
          await api("/admin/settings/rules", {
            method: "POST",
            body: JSON.stringify({
              key,
              value: next,
              scopeType: scope.type,
              scopeId: scope.id,
              // Above the default 0, so a venue's own choice beats a broad rule.
              priority: 10,
              note: `Set for ${props.scopeLabel} in Admin → Branding`,
            }),
          });
        }
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending((p) => { const { [key]: _drop, ...rest } = p; return rest; });
      setBusy(null);
    }
  }

  async function reset(key: string) {
    const own = ownRule(explained[key], scope);
    if (!own) return;
    setBusy(key);
    try {
      await api(`/admin/settings/rules/${own.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const origin = (key: string) => {
    const e = explained[key];
    if (!e) return null;
    if (scope.type !== "global") {
      const own = ownRule(e, scope);
      if (own && e.resolution.rule?.id === own.id) return { text: `set for ${props.scopeLabel}`, own: true };
      if (own) return { text: "set here, but a stronger rule in Settings wins", own: true };
      if (e.resolution.source === "rule") return { text: "from a rule in Settings", own: false };
      return { text: "same as everyone", own: false };
    }
    return { text: e.resolution.source === "shipped" ? "shipped default" : "base value", own: false };
  };

  const originNode = (k: string) => {
    const o = origin(k);
    if (!o) return null;
    return (
      <span className="text-[10px] uppercase tracking-wider text-muted-text">
        {o.text}
        {o.own && (
          <button type="button" onClick={() => void reset(k)} className="ml-2 underline hover:text-text">use everyone's</button>
        )}
      </span>
    );
  };

  const toggle = (k: string, label: string) => (
    <div key={k} className="flex items-center justify-between gap-3 py-1.5">
      <label className="flex items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={value(k) === true}
          disabled={busy === k || !explained[k]}
          onChange={(e) => void change(k, e.target.checked)}
        />
        {label}
      </label>
      {originNode(k)}
    </div>
  );

  const slider = (k: string, label: string, unit: string, min: number, max: number, step = 1) => (
    <SliderRow
      key={k}
      id={`cbp-${k}`}
      label={label}
      unit={unit}
      min={min}
      max={max}
      step={step}
      current={Number(value(k) ?? min)}
      disabled={busy === k || !explained[k]}
      origin={originNode(k)}
      onCommit={(v) => void change(k, v)}
    />
  );

  const style = String(value(KEYS.style) ?? "uploaded");
  const endOn = value(KEYS.endOn) === true;

  return (
    <div className="rounded border border-line bg-surface/40 p-3 space-y-3">
      <div>
        <p className="text-text text-sm font-semibold">
          {scope.type === "global" ? "What clips get, everywhere" : `What ${props.scopeLabel}'s clips get`}
        </p>
        <p className="text-muted-text text-xs mt-0.5">
          {scope.type === "global"
            ? "The base for every venue. A field or academy can override any of these."
            : "Changes here apply to this venue only. They show up as rules in Settings."}
          {" "}New exports only.
        </p>
      </div>
      {error && <p className="text-text text-sm rounded border border-line px-2 py-1.5">{error}</p>}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-text text-[11px] uppercase tracking-wider">Overlay during the clip</p>
          {originNode(KEYS.style)}
        </div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Overlay during the clip">
          {Object.keys(STYLE_LABEL).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={style === s}
              disabled={busy === KEYS.style || !explained[KEYS.style]}
              onClick={() => style !== s && void change(KEYS.style, s)}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-semibold border",
                style === s ? "bg-turf text-void border-turf" : "border-line text-muted-text hover:text-text",
              )}
            >
              {STYLE_LABEL[s]}
            </button>
          ))}
        </div>
        {value(KEYS.overlayEnabled) === false && (
          <p className="text-muted-text text-[11px]">The overlay master switch (Settings → Branding overlay) is off, so no overlay is drawn.</p>
        )}
      </div>

      <div className="border-t border-line pt-2">
        {toggle(KEYS.endOn, "End screen over the end of the clip")}
        <div className={cn("pl-5 border-l border-line ml-1.5", !endOn && "opacity-50")}>
          <p className="text-muted-text text-[11px] pt-1">Checked top to bottom; the first that fits the clip wins.</p>
          {toggle(KEYS.academy, "1 · Academy progress")}
          {toggle(KEYS.player, "2 · Player stats (the clip owner's own, when unlocked)")}
          {toggle(KEYS.match, "3 · Match result")}
          {toggle(KEYS.signOff, "4 · Venue sign-off")}
          {slider(KEYS.seconds, "Length", " s", 2, 6, 0.5)}
          {slider(KEYS.blur, "Blur", " px", 0, 40)}
          {slider(KEYS.dim, "Darkening", "%", 0, 90, 5)}
        </div>
      </div>
    </div>
  );
}

// ── Preview ───────────────────────────────────────────────────────────────

const PREVIEW_KINDS: Array<{ what: string; label: string; video: boolean }> = [
  { what: "player", label: "Player stats", video: true },
  { what: "match", label: "Match result", video: true },
  { what: "academy", label: "Academy", video: true },
  { what: "signOff", label: "Sign-off", video: true },
  { what: "cornerCrest", label: "Corner crest", video: false },
  { what: "broadcastBar", label: "Name bar", video: false },
  { what: "academyFrame", label: "Academy frame", video: false },
];

function PreviewSection(props: { scope: Scope; version: number; settings: Record<string, unknown> }) {
  const [what, setWhat] = useState("player");
  const [aspect, setAspect] = useState<"9:16" | "16:9">("9:16");
  const [asVideo, setAsVideo] = useState(false);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const kind = PREVIEW_KINDS.find((k) => k.what === what)!;
  const params = useMemo(() => {
    const q = new URLSearchParams({
      scope: scopeKey(props.scope),
      what,
      aspect,
      seconds: String(props.settings[KEYS.seconds] ?? 3),
      blur: String(props.settings[KEYS.blur] ?? 22),
      dim: String(props.settings[KEYS.dim] ?? 50),
      v: String(props.version),
    });
    return q;
  }, [props.scope, what, aspect, props.settings, props.version]);
  const src = `${basePath}/api/admin/branding/preview?${params.toString()}${asVideo && kind.video ? "&format=mp4" : ""}`;

  return (
    <div className="rounded border border-line bg-surface/40 p-3 space-y-3">
      <div>
        <p className="text-text text-sm font-semibold">Preview</p>
        <p className="text-muted-text text-xs mt-0.5">
          Real Jordan Galaxy footage with sample numbers. Crest, colours, names, fonts and timing are exactly what an export draws.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {PREVIEW_KINDS.map((k) => (
          <button
            key={k.what}
            type="button"
            onClick={() => setWhat(k.what)}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs font-semibold border",
              what === k.what ? "bg-turf text-void border-turf" : "border-line text-muted-text hover:text-text",
            )}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {(["9:16", "16:9"] as const).map((a) => (
          <label key={a} className="flex items-center gap-1.5 text-text">
            <input type="radio" name="cbp-aspect" checked={aspect === a} onChange={() => setAspect(a)} /> {a}
          </label>
        ))}
        {kind.video && (
          <label className="flex items-center gap-1.5 text-text">
            <input type="checkbox" checked={asVideo} onChange={(e) => setAsVideo(e.target.checked)} />
            Play the transition (renders a short video, a few seconds)
          </label>
        )}
      </div>
      <div className={cn("rounded border border-line overflow-hidden bg-void", aspect === "9:16" ? "max-w-[280px]" : "max-w-[640px]")}>
        {failedSrc === src
          ? (
            <p className="text-muted-text text-xs p-3">
              {props.scope.type === "global"
                ? "Nothing to preview: there is no default look yet. Save one above, or pick a field or academy."
                : "The preview could not be drawn. Save the look above and try again."}
            </p>
          )
          : asVideo && kind.video
            ? <video key={src} src={src} controls autoPlay muted loop playsInline className="w-full block" onError={() => setFailedSrc(src)} />
            : <img key={src} src={src} alt={`${kind.label} preview`} className="w-full block" onError={() => setFailedSrc(src)} />}
      </div>
    </div>
  );
}

// ── The panel ─────────────────────────────────────────────────────────────

export default function ClipBrandingPanel(props: {
  scope: Scope;
  scopeLabel: string;
  profiles: BrandingProfile[];
  presets: BrandingPresetInfo[];
  profilesReady: boolean;
  /** The field an academy plays at, for "inherited from" — optional. */
  academyFieldId?: number | null;
  reload: () => Promise<void>;
}) {
  const { scope, profiles } = props;
  const [version, setVersion] = useState(0);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const own = profiles.find((p) => p.scopeType === scope.type && p.scopeId === scope.id) ?? null;
  const inherited = own
    ? null
    : (scope.type === "academy" && props.academyFieldId
      ? profiles.find((p) => p.scopeType === "field" && p.scopeId === props.academyFieldId) ?? null
      : null) ?? (scope.type !== "global" ? profiles.find((p) => p.scopeType === "global") ?? null : null);

  return (
    <div className="space-y-4">
      <LookSection
        scope={scope}
        scopeLabel={props.scopeLabel}
        profile={own}
        inherited={inherited}
        presets={props.presets}
        profilesReady={props.profilesReady}
        onSaved={async () => { await props.reload(); setVersion((v) => v + 1); }}
      />
      <SwitchesSection
        scope={scope}
        scopeLabel={props.scopeLabel}
        onChanged={(values) => { setSettings(values); setVersion((v) => v + 1); }}
      />
      <PreviewSection scope={scope} version={version} settings={settings} />
    </div>
  );
}
