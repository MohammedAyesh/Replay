import { useEffect, useState } from "react";
import type { PackStyle } from "@workspace/api-zod";

/**
 * Admin → Academies → Edit: the academy's Creative hub brand pack.
 *
 * Only the academy given a pack sees that pack's style in its Creative hub.
 * Choosing a pack never changes the academy's colours; "Apply pack colours to
 * Branding" copies the pack palette's primary and accent into the academy's
 * branding profile, and only when clicked.
 * API: GET/PUT /admin/academies/:id/creative-pack, POST …/creative-pack/apply-colours.
 */

type PackOption = { key: PackStyle; name: string; franchise: boolean; primary: string; accent: string };
type PackState = { pack: PackStyle | null; packs: PackOption[] };

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${basePath}/api${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export default function CreativePackPanel({ academyId }: { academyId: number }) {
  const [state, setState] = useState<PackState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setState(null);
    setError(null);
    call<PackState>(`/admin/academies/${academyId}/creative-pack`)
      .then((s) => { if (live) setState(s); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [academyId]);

  const save = async (pack: PackStyle | null) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setState(await call<PackState>(`/admin/academies/${academyId}/creative-pack`, { method: "PUT", body: JSON.stringify({ pack }) }));
      setNote(pack ? "Pack saved." : "Pack removed.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applyColours = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const c = await call<{ primaryColor: string; accentColor: string }>(`/admin/academies/${academyId}/creative-pack/apply-colours`, { method: "POST" });
      setNote(`Branding colours set to ${c.primaryColor} / ${c.accentColor}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const current = state?.packs.find((p) => p.key === state.pack) ?? null;

  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-2" data-testid={`admin-creative-pack-${academyId}`}>
      <label className="block text-xs text-zinc-400" htmlFor={`creative-pack-${academyId}`}>Creative brand pack</label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={`creative-pack-${academyId}`}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-white disabled:opacity-50"
          value={state?.pack ?? ""}
          disabled={!state || busy}
          onChange={(e) => void save((e.target.value || null) as PackStyle | null)}
          data-testid={`admin-creative-pack-select-${academyId}`}
        >
          <option value="">None</option>
          {(state?.packs ?? []).map((p) => (
            <option key={p.key} value={p.key}>{p.name}{p.franchise ? " (franchise)" : ""}</option>
          ))}
        </select>
        {current ? (
          <>
            <span className="flex items-center gap-1" aria-label="Pack colours">
              <span className="h-4 w-4 rounded-full border border-zinc-700" style={{ background: current.primary }} title={current.primary} />
              <span className="h-4 w-4 rounded-full border border-zinc-700" style={{ background: current.accent }} title={current.accent} />
            </span>
            <button
              type="button"
              onClick={() => void applyColours()}
              disabled={busy}
              className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              data-testid={`admin-creative-pack-apply-${academyId}`}
            >
              Apply pack colours to Branding
            </button>
          </>
        ) : null}
      </div>
      <p className="text-[11px] text-zinc-500">
        Only this academy sees the pack&apos;s style in its Creative hub. Its Branding colours change only if you apply them.
        {current?.franchise ? " Franchise pack: head-office rules apply; get the academy's sign-off." : ""}
      </p>
      {note ? <p className="text-xs text-emerald-400">{note}</p> : null}
      {error ? <p className="text-xs text-red-400" role="alert">{error}</p> : null}
    </div>
  );
}
