import { useEffect, useMemo, useState } from "react";
import { TEMPLATE_AUDIENCES, type CreativeBrand, type CreativeData, type CreativeFormat, type Scene, type TemplateAudience } from "@workspace/api-zod";
import { SceneCanvas } from "@/components/creative-hub/scene-canvas";

/**
 * Admin → Template library (2026-11-08): add a template by uploading its file, no code change and no
 * deploy. Every field (or academy) then has it in its Creative hub; "Use instead of …" makes it
 * stand in for a built-in everywhere, the Instagram autopilots included (a field's own "use
 * instead" in My templates still wins). Start a new one from any built-in: download it, edit the
 * file, give it a new key, upload it. The file format is in lib/api-zod/src/templateFiles.ts.
 * API: GET/POST /admin/creative/template-library, PATCH|DELETE …/:key, GET …/:key/file,
 * GET /admin/creative/template-builtins, GET …/:key/file.
 */

export type LibraryRow = {
  id: number;
  key: string;
  title: { en: string; ar: string };
  description: string | null;
  audience: TemplateAudience;
  academyIds: number[] | null;
  baseKey: string | null;
  replacesBase: boolean;
  clips: number | null;
  format: CreativeFormat;
  kind: "image" | "video";
  scene: Scene;
  sampleData: { custom?: Record<string, string> } | null;
  active: boolean;
  updatedAt: string;
};
type BuiltIn = { key: string; group: "field" | "academy" | "catalogue"; title: { en: string; ar: string } };
type UploadResult = { name: string; ok: boolean; lines: string[] };

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const api = (p: string) => `${basePath}/api${p}`;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : undefined;
  const res = await fetch(api(path), { credentials: "include", ...init, headers: { ...(headers ?? {}), ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => null) as { error?: string; errors?: string[] } | null;
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `Request failed (${res.status})`), { errors: body?.errors ?? [] });
  return body as T;
}

const BRAND: CreativeBrand = { primary: "#F4CF1F", accent: "#F4CF1F", ink: "#0B0F1A", paper: "#FFFFFF", muted: "#8A93A6", nameEn: "Sample field", nameAr: "ملعب تجريبي" };
const AUDIENCE_LABEL: Record<TemplateAudience, string> = { field: "Fields", academy: "Academies", all: "Fields and academies" };
const small = "rounded-md border border-zinc-700 px-2 py-1 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-30";
const field = "rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-white";

/** What a preview fills with: the file's own sample words and a sample field's name and phone. */
const previewData = (row: LibraryRow): CreativeData => ({
  ...(row.sampleData ?? {}),
  academy: { name: BRAND.nameEn, nameAr: BRAND.nameAr, phone: "07X XXX XXXX" },
});

export default function TemplateLibraryTab() {
  const [rows, setRows] = useState<LibraryRow[] | null>(null);
  const [builtIns, setBuiltIns] = useState<BuiltIn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState("field-open-slots");
  const [startLocale, setStartLocale] = useState<"ar" | "en">("ar");

  useEffect(() => {
    call<{ templates: LibraryRow[] }>("/admin/creative/template-library").then((r) => setRows(r.templates)).catch((e: Error) => setError(e.message));
    call<{ templates: BuiltIn[] }>("/admin/creative/template-builtins").then((r) => setBuiltIns(r.templates)).catch(() => undefined);
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, LibraryRow[]>();
    for (const r of rows ?? []) m.set(r.key, [...(m.get(r.key) ?? []), r]);
    return [...m.values()];
  }, [rows]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const out: UploadResult[] = [];
    for (const f of Array.from(files)) {
      try {
        const json = JSON.parse(await f.text()) as unknown;
        const r = await call<{ saved: Array<{ key: string; format: string; created: boolean }>; templates: LibraryRow[] }>("/admin/creative/template-library", {
          method: "POST", body: JSON.stringify(json),
        });
        setRows(r.templates);
        out.push({ name: f.name, ok: true, lines: r.saved.map((s) => `${s.created ? "Added" : "Updated"} ${s.key} (${s.format})`) });
      } catch (e) {
        const err = e as Error & { errors?: string[] };
        out.push({ name: f.name, ok: false, lines: [e instanceof SyntaxError ? "Not valid JSON" : err.message, ...(err.errors ?? [])] });
      }
    }
    setResults(out);
    setBusy(false);
  };

  const change = async (key: string, body: Record<string, unknown>) => {
    setError(null);
    try {
      const r = await call<{ templates: LibraryRow[] }>(`/admin/creative/template-library/${key}`, { method: "PATCH", body: JSON.stringify(body) });
      setRows(r.templates);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (key: string) => {
    if (!window.confirm(`Delete "${key}" from the library? Fields stop seeing it, and posts that used it go back to the built-in.`)) return;
    setError(null);
    try {
      const res = await fetch(api(`/admin/creative/template-library/${key}`), { method: "DELETE", credentials: "include" });
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
      setRows((cur) => (cur ?? []).filter((r) => r.key !== key));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-5 p-4" data-testid="admin-template-library">
      <div>
        <h2 className="text-lg font-bold text-white">Template library</h2>
        <p className="max-w-3xl text-sm text-zinc-400">
          Add a template by uploading its file: no code change, no publish. Fields (or academies) see it in their Creative hub under My templates.
          Turn on &ldquo;Use instead of …&rdquo; and it replaces that built-in everywhere, the Instagram autopilot included. A field&apos;s own choice in My templates still wins.
        </p>
      </div>

      <section className="space-y-2 rounded-lg border border-zinc-800 p-3">
        <h3 className="text-sm font-bold text-white">Upload template files</h3>
        <p className="text-xs text-zinc-400">One or more <code>.json</code> files. Uploading a file with a key that is already here updates it. A file with any problem keeps nothing, and the problems are listed.</p>
        <input type="file" accept="application/json,.json" multiple disabled={busy} data-testid="template-library-upload"
          onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} className="block text-sm text-zinc-300" />
        {busy ? <p className="text-xs text-zinc-400">Checking…</p> : null}
        {results.map((r) => (
          <div key={r.name} className={r.ok ? "text-xs text-emerald-400" : "text-xs text-red-400"} role={r.ok ? "status" : "alert"}>
            <p className="font-semibold">{r.name}</p>
            <ul className="list-disc ps-5">{r.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </div>
        ))}
      </section>

      <section className="space-y-2 rounded-lg border border-zinc-800 p-3">
        <h3 className="text-sm font-bold text-white">Start from a built-in</h3>
        <p className="text-xs text-zinc-400">Download a built-in template as a file, change it (or ask Claude to), give it a new key and upload it. Keep its baseKey to fill it like the built-in.</p>
        <div className="flex flex-wrap items-center gap-2">
          <select value={start} onChange={(e) => setStart(e.target.value)} className={field} aria-label="Built-in template">
            {(["field", "academy", "catalogue"] as const).map((g) => (
              <optgroup key={g} label={g === "field" ? "Field pack" : g === "academy" ? "Academy pack" : "Catalogue"}>
                {builtIns.filter((b) => b.group === g).map((b) => <option key={b.key} value={b.key}>{b.title.en} ({b.key})</option>)}
              </optgroup>
            ))}
          </select>
          <select value={startLocale} onChange={(e) => setStartLocale(e.target.value === "en" ? "en" : "ar")} className={field} aria-label="Language">
            <option value="ar">Arabic</option>
            <option value="en">English</option>
          </select>
          <a href={api(`/admin/creative/template-builtins/${start}/file?locale=${startLocale}`)} className={small} data-testid="template-library-download-builtin">Download file</a>
        </div>
      </section>

      {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}
      {!rows ? <p className="text-sm text-zinc-500">Loading…</p> : !groups.length ? <p className="text-sm text-zinc-500" data-testid="template-library-empty">No templates uploaded yet.</p> : (
        <ul className="space-y-3">
          {groups.map((g) => {
            const t = g[0];
            return (
              <li key={t.key} className="rounded-lg border border-zinc-800 p-3" data-testid={`template-library-${t.key}`}>
                <div className="flex flex-wrap items-start gap-4">
                  <div className="flex gap-2">
                    {g.map((r) => (
                      <div key={r.id} className="space-y-1">
                        <SceneCanvas scene={r.scene} brand={BRAND} data={previewData(r)} width={r.format === "story" ? 90 : 120} timeMs={r.kind === "video" ? 1600 : undefined} />
                        <p className="text-center text-[10px] text-zinc-500">{r.format}</p>
                      </div>
                    ))}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="text-sm font-bold text-white">{t.title.en} <span dir="rtl" className="font-normal text-zinc-400">· {t.title.ar}</span></p>
                    <p className="text-xs text-zinc-500"><code>{t.key}</code>{t.kind === "video" ? " · video" : " · still"}{t.clips ? ` · ${t.clips} clips` : ""}{t.baseKey ? <> · fills like <code>{t.baseKey}</code></> : null}</p>
                    {t.description ? <p className="text-xs text-zinc-400">{t.description}</p> : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1 text-xs text-zinc-300">
                        <input type="checkbox" checked={t.active} onChange={(e) => void change(t.key, { active: e.target.checked })} data-testid={`template-library-active-${t.key}`} />
                        Shown
                      </label>
                      <select value={t.audience} onChange={(e) => void change(t.key, { audience: e.target.value })} className={field} aria-label="Who sees it">
                        {TEMPLATE_AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
                      </select>
                      {t.baseKey ? (
                        <label className="flex items-center gap-1 text-xs text-zinc-300">
                          <input type="checkbox" checked={t.replacesBase} onChange={(e) => void change(t.key, { replacesBase: e.target.checked })} data-testid={`template-library-replaces-${t.key}`} />
                          Use instead of {t.baseKey}
                        </label>
                      ) : null}
                      <a href={api(`/admin/creative/template-library/${t.key}/file`)} className={small}>Download</a>
                      <button type="button" onClick={() => void remove(t.key)} className={small} data-testid={`template-library-delete-${t.key}`}>Delete</button>
                    </div>
                    {t.academyIds?.length ? <p className="text-xs text-zinc-500">Only for academy ids {t.academyIds.join(", ")}</p> : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
