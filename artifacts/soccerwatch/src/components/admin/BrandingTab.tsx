import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The overlay and end card burned into exported clips.
 *
 * Built around the resolution order rather than around the table, because that
 * is the question an operator actually has: this clip came out with the wrong
 * logo — whose was it? Academy, then field, then global, each kind resolved
 * separately, so an academy with an overlay and no end card gets the global end
 * card rather than none.
 *
 * The other thing this page has to say out loud is geometry. An overlay is
 * composited at 0,0 with no scaling, so one authored at the wrong size does not
 * fail: it sits in a corner, and nobody finds out until a clip is shared.
 */

type ScopeType = "academy" | "field" | "global";
type Kind = "overlay" | "endCard";

interface Asset {
  id: number;
  scopeType: ScopeType;
  scopeId: number;
  kind: Kind;
  assetUrl: string;
  width: number | null;
  height: number | null;
  bytes: number;
  updatedAt: string;
  fitsLandscape: boolean | null;
  fitsPortrait: boolean | null;
}

interface Scope { id: number; name: string }

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

const scopeKey = (scopeType: ScopeType, scopeId: number) =>
  scopeType === "global" ? "global" : `${scopeType}:${scopeId}`;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const KIND_LABEL: Record<Kind, string> = { overlay: "Overlay", endCard: "End card" };
const KIND_HINT: Record<Kind, string> = {
  overlay: "A PNG with transparency, at the export size. Drawn over the whole frame.",
  endCard: "A short video appended after the clip.",
};

export default function BrandingTab() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [academies, setAcademies] = useState<Scope[]>([]);
  const [fields, setFields] = useState<Scope[]>([]);
  const [sizes, setSizes] = useState<{ landscape: { w: number; h: number }; portrait: { w: number; h: number } } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scope, setScope] = useState<{ type: ScopeType; id: number }>({ type: "global", id: 0 });
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    try {
      const data = await api("/admin/branding");
      setAssets(data.assets ?? []);
      setSizes(data.outputSizes ?? null);
      setNotice(
        data.schemaReady === false
          ? (data.message ?? "The branding table is missing.")
          : data.storageReady === false
            ? "Bunny Storage is not configured, so branding cannot be uploaded."
            : null,
      );
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    api("/admin/academies").then((rows) => setAcademies(rows ?? [])).catch(() => undefined);
    api("/fields").then((rows) => setFields(rows ?? [])).catch(() => undefined);
  }, [load]);

  const current = useMemo(
    () => (kind: Kind) =>
      assets.find((a) => a.kind === kind && a.scopeType === scope.type && a.scopeId === scope.id) ?? null,
    [assets, scope],
  );

  /**
   * What a clip in this scope would actually get, walking the same order the
   * renderer walks. Shown because "nothing uploaded here" and "nothing anywhere"
   * are very different answers and the table cannot tell them apart.
   */
  const effective = useMemo(
    () => (kind: Kind): Asset | null => {
      const forKind = assets.filter((a) => a.kind === kind);
      if (scope.type === "academy") {
        const academy = forKind.find((a) => a.scopeType === "academy" && a.scopeId === scope.id);
        if (academy) return academy;
      }
      if (scope.type === "field") {
        const field = forKind.find((a) => a.scopeType === "field" && a.scopeId === scope.id);
        if (field) return field;
      }
      return forKind.find((a) => a.scopeType === "global") ?? null;
    },
    [assets, scope],
  );

  async function upload(kind: Kind, file: File) {
    setBusy(kind);
    setError(null);
    try {
      const form = new FormData();
      form.append("scope", scopeKey(scope.type, scope.id));
      form.append("asset", file);
      await api(`/admin/branding/${kind}`, { method: "PUT", body: form });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
      const input = inputs.current[kind];
      if (input) input.value = "";
    }
  }

  async function remove(kind: Kind) {
    setBusy(kind);
    setError(null);
    try {
      await api(`/admin/branding/${kind}?scope=${encodeURIComponent(scopeKey(scope.type, scope.id))}`, {
        method: "DELETE",
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-text font-display font-black text-xl uppercase tracking-tight">Branding</h2>
        <p className="text-muted-text text-xs mt-1">
          Burned into exported clips. An academy's own branding wins, then the field's,
          then the global one — each piece falling back on its own.
        </p>
      </div>

      {notice && (
        <div className="rounded border border-line bg-surface px-3 py-2.5">
          <p className="text-muted-text text-xs">{notice}</p>
        </div>
      )}
      {error && (
        <div className="rounded border border-line bg-surface text-text text-sm px-3 py-2">{error}</div>
      )}

      {/* Scope picker */}
      <div className="rounded border border-line bg-surface/40 p-3 space-y-2">
        <p className="text-text text-sm font-semibold">Whose branding are you editing?</p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setScope({ type: "global", id: 0 })}
            className={cn(
              "px-3 py-1.5 rounded text-xs font-semibold",
              scope.type === "global" ? "bg-floodlight text-void" : "border border-line text-muted-text",
            )}
          >
            Everyone
          </button>
          <select
            className="bg-void border border-line rounded px-2 py-1.5 text-xs text-text"
            value={scope.type === "field" ? String(scope.id) : ""}
            onChange={(e) => e.target.value && setScope({ type: "field", id: Number(e.target.value) })}
          >
            <option value="">A field…</option>
            {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select
            className="bg-void border border-line rounded px-2 py-1.5 text-xs text-text"
            value={scope.type === "academy" ? String(scope.id) : ""}
            onChange={(e) => e.target.value && setScope({ type: "academy", id: Number(e.target.value) })}
          >
            <option value="">An academy…</option>
            {academies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      </div>

      {(["overlay", "endCard"] as Kind[]).map((kind) => {
        const own = current(kind);
        const inUse = effective(kind);
        const inherited = !own && inUse;
        return (
          <div key={kind} className="rounded border border-line bg-surface/40 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <p className="text-text text-sm font-semibold">{KIND_LABEL[kind]}</p>
              {inherited && (
                <span className="text-[10px] uppercase tracking-wider text-sky-300">
                  inherited from {inUse.scopeType === "global" ? "everyone" : inUse.scopeType}
                </span>
              )}
            </div>
            <p className="text-muted-text text-xs">{KIND_HINT[kind]}</p>

            {kind === "overlay" && sizes && (
              <p className="text-muted-text text-xs">
                Export size is {sizes.landscape.w}×{sizes.landscape.h} landscape,
                {" "}{sizes.portrait.w}×{sizes.portrait.h} portrait.
              </p>
            )}

            {inUse ? (
              <div className="flex items-start gap-3">
                {inUse.kind === "overlay" ? (
                  <img
                    src={inUse.assetUrl}
                    alt=""
                    className="w-40 h-24 object-contain rounded border border-line"
                    style={{
                      // Checkerboard, so a transparent overlay is visibly
                      // transparent rather than looking like a black rectangle.
                      backgroundImage:
                        "linear-gradient(45deg,color-mix(in srgb,var(--replay-line) 55%,var(--replay-void)) 25%,transparent 25%,transparent 75%,color-mix(in srgb,var(--replay-line) 55%,var(--replay-void)) 75%)," +
                        "linear-gradient(45deg,color-mix(in srgb,var(--replay-line) 55%,var(--replay-void)) 25%,transparent 25%,transparent 75%,color-mix(in srgb,var(--replay-line) 55%,var(--replay-void)) 75%)",
                      backgroundSize: "12px 12px",
                      backgroundPosition: "0 0, 6px 6px",
                    }}
                  />
                ) : (
                  <video src={inUse.assetUrl} controls muted
                    className="w-40 rounded border border-line bg-void" />
                )}
                <div className="text-xs space-y-1 min-w-0">
                  {inUse.width && (
                    <p className={cn(inUse.fitsLandscape === false ? "text-muted-text" : "text-muted-text")}>
                      {inUse.width}×{inUse.height}
                      {inUse.fitsLandscape === false && sizes &&
                        ` — not ${sizes.landscape.w}×${sizes.landscape.h}, so it will sit in a corner rather than covering the frame`}
                    </p>
                  )}
                  <p className="text-muted-text">{formatBytes(inUse.bytes)}</p>
                  {own && (
                    <button onClick={() => void remove(kind)} disabled={busy === kind}
                      className="text-muted-text hover:text-text">
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-muted-text text-xs">Nothing set anywhere — clips export without it.</p>
            )}

            <input
              ref={(el) => { inputs.current[kind] = el; }}
              type="file"
              accept={kind === "overlay" ? "image/png" : "video/mp4"}
              disabled={busy === kind}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(kind, f); }}
              className="block w-full text-xs text-muted-text file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-raised file:text-text file:text-xs"
            />
            {busy === kind && <p className="text-muted-text text-xs">Uploading…</p>}
          </div>
        );
      })}
    </div>
  );
}
