/**
 * Identity board - /admin/recordings/:id/identities
 *
 * One row per person, and along the row the pieces of that person the tracker
 * found, as crops in time order. The tracker's grouping is the starting point;
 * a human fixes it by dragging:
 *
 *   drag a CROP onto another row   -> that track is someone else from this
 *                                     crop on: cut it here, move the rest
 *   drag a ROW HANDLE onto a row   -> the whole row is the same person: merge
 *   drop on "New row"              -> split off as a new person
 *
 * Coexistence is enforced at drop time: two pieces that overlap in time are two
 * people, so a drop that would put them in one row is refused. That is the one
 * rule the tracker can never get wrong, and it is the one rule a tired human
 * would.
 *
 * Rows are sorted by how much of the match they cover; short fragments sit in
 * a tray below with a suggested row each (the unique continuation rule from
 * the claim page: starts after the row ends, within 6 s, reachable at 8 m/s).
 *
 * Saving writes the identity map to the manifest. The claim page merges tracks
 * from it at load, so a player then follows one long track across segment
 * boundaries instead of 100+ fragments.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import type { TrackingIdentity, TrackingManifest } from "@workspace/api-client-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${basePath}/api${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

type Box = { frame: number; x: number; y: number; w: number; h: number };
type Track = { id: string; label?: string | null; startFrame: number; endFrame: number; boxes: Box[] };
type Segment = { segmentIndex: number; tracks: Track[] };
type Sprite = { f: number; j: string };
type Part = { trackId: string; fromFrame: number; toFrame: number };
type Row = { id: string; name: string; parts: Part[] };

const K_PER_ROW = 14;

function boxAt(track: Track, frame: number): Box | null {
  const boxes = track.boxes;
  let lo = 0, hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxes[mid].frame < frame) lo = mid + 1; else hi = mid;
  }
  const b = boxes[lo];
  const before = lo > 0 ? boxes[lo - 1] : b;
  return Math.abs(before.frame - frame) < Math.abs(b.frame - frame) ? before : b;
}

function overlaps(a: Part, b: Part) {
  return a.fromFrame <= b.toFrame && b.fromFrame <= a.toFrame;
}

function rowSpan(row: Row) {
  return row.parts.reduce((sum, p) => sum + (p.toFrame - p.fromFrame + 1), 0);
}

function fmt(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function IdentityBoard() {
  const params = useParams<{ id: string }>();
  const recordingId = Number(params.id);
  const [, setLocation] = useLocation();
  const { user, isAdmin, isLoading } = useAuth();
  const [manifest, setManifest] = useState<TrackingManifest | null>(null);
  const [tracks, setTracks] = useState<Record<string, Track>>({});
  const [sprites, setSprites] = useState<Record<string, Sprite[]>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState("Loading…");
  const [drag, setDrag] = useState<{ kind: "crop" | "row"; rowId: string; trackId?: string; frame?: number } | null>(null);
  const [flash, setFlash] = useState("");
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<Row[][]>([]);
  const [spriteCoverage, setSpriteCoverage] = useState<Array<{ name: string; ok: boolean; reason?: string }>>([]);

  const fps = manifest?.frameRate ?? 20;

  // ── load ──────────────────────────────────────────────────────────────────
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId || !isAdmin || !recordingId) return;
    let cancelled = false;
    (async () => {
      try {
        const claim = await get<{ manifest: TrackingManifest }>(`/recordings/${recordingId}/claim-match`);
        if (cancelled) return;
        setManifest(claim.manifest);
        const all: Record<string, Track> = {};
        const spr: Record<string, Sprite[]> = {};
        const coverage: Array<{ name: string; ok: boolean; reason?: string }> = [];
        for (const entry of claim.manifest.segments) {
          setStatus(`Loading ${entry.name}…`);
          const segment = await get<Segment>(`/recordings/${recordingId}/claim-match/segments/${entry.index}`);
          for (const t of segment.tracks) all[t.id] = t;
          try {
            const s = await get<Record<string, Sprite[]>>(`/recordings/${recordingId}/claim-match/sprites/${entry.index}`);
            const matched = Object.keys(s).filter((k) => segment.tracks.some((t) => t.id === k)).length;
            Object.assign(spr, s);
            coverage.push(matched > 0
              ? { name: entry.name, ok: true }
              : { name: entry.name, ok: false, reason: `${Object.keys(s).length} strips but none match this segment's track ids (e.g. ${Object.keys(s)[0] ?? "-"} vs ${segment.tracks[0]?.id ?? "-"})` });
          } catch (error) {
            coverage.push({ name: entry.name, ok: false, reason: error instanceof Error && error.message.endsWith("404") ? "bundle carried no sprites for it" : (error instanceof Error ? error.message : "failed") });
          }
          if (cancelled) return;
        }
        setTracks(all);
        setSprites(spr);
        setSpriteCoverage(coverage);
        const saved = claim.manifest.identities;
        if (saved && saved.length) {
          setRows(saved.map((i: TrackingIdentity) => ({ id: i.id, name: i.name ?? "", parts: i.parts })));
        } else {
          setRows(autoRows(all, claim.manifest.frameRate));
        }
        setStatus("");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not load");
      }
    })();
    return () => { cancelled = true; };
  }, [userId, isAdmin, recordingId]);

  // ── auto grouping: one row per track, then stitch unique continuations ────
  function autoRows(all: Record<string, Track>, frameRate: number): Row[] {
    const list = Object.values(all).sort((a, b) => a.startFrame - b.startFrame);
    const rowOf = new Map<string, number>();
    const out: Row[] = [];
    for (const t of list) {
      // does exactly one existing row end shortly before this track starts, within reach?
      const first = t.boxes[0];
      const cands: number[] = [];
      for (let r = 0; r < out.length; r++) {
        const last = out[r].parts[out[r].parts.length - 1];
        const lt = all[last.trackId];
        const gap = (t.startFrame - last.toFrame) / frameRate;
        if (gap <= 0 || gap > 6) continue;
        const lb = boxAt(lt, last.toFrame);
        if (!lb) continue;
        const mpp = 1.75 / Math.max(lb.h, 1);
        const dist = Math.hypot(first.x + first.w / 2 - (lb.x + lb.w / 2), first.y + first.h - (lb.y + lb.h)) * mpp;
        if (dist / Math.max(gap, 0.05) <= 8) cands.push(r);
      }
      if (cands.length === 1) {
        out[cands[0]].parts.push({ trackId: t.id, fromFrame: t.startFrame, toFrame: t.endFrame });
        rowOf.set(t.id, cands[0]);
      } else {
        out.push({ id: `p${out.length + 1}`, name: "", parts: [{ trackId: t.id, fromFrame: t.startFrame, toFrame: t.endFrame }] });
        rowOf.set(t.id, out.length - 1);
      }
    }
    return out;
  }

  // ── derived ───────────────────────────────────────────────────────────────
  const sortedRows = useMemo(() => [...rows].sort((a, b) => rowSpan(b) - rowSpan(a)), [rows]);
  const mainRows = useMemo(() => sortedRows.filter((r) => rowSpan(r) / fps >= 20), [sortedRows, fps]);
  const fragments = useMemo(() => sortedRows.filter((r) => rowSpan(r) / fps < 20).sort((a, b) => a.parts[0].fromFrame - b.parts[0].fromFrame), [sortedRows, fps]);
  const duration = manifest?.duration ?? 1;

  const cropsForRow = useCallback((row: Row): Array<{ trackId: string; frame: number; j?: string }> => {
    const items: Array<{ trackId: string; frame: number; j?: string }> = [];
    for (const part of row.parts) {
      const strips = (sprites[part.trackId] ?? []).filter((s) => s.f >= part.fromFrame && s.f <= part.toFrame);
      if (strips.length) {
        for (const s of strips) items.push({ trackId: part.trackId, frame: s.f, j: s.j });
      } else {
        items.push({ trackId: part.trackId, frame: part.fromFrame });
      }
    }
    items.sort((a, b) => a.frame - b.frame);
    if (items.length <= K_PER_ROW) return items;
    const step = (items.length - 1) / (K_PER_ROW - 1);
    return Array.from({ length: K_PER_ROW }, (_, i) => items[Math.round(i * step)]);
  }, [sprites]);

  const suggestionFor = useCallback((frag: Row): Row | null => {
    const first = frag.parts[0];
    const ft = tracks[first.trackId];
    if (!ft) return null;
    const fb = boxAt(ft, first.fromFrame);
    if (!fb) return null;
    let best: { row: Row; score: number } | null = null;
    for (const row of mainRows) {
      if (row.parts.some((p) => frag.parts.some((q) => overlaps(p, q)))) continue;
      // nearest end of a part before the fragment starts
      for (const p of row.parts) {
        const gap = (first.fromFrame - p.toFrame) / fps;
        if (gap <= 0 || gap > 8) continue;
        const lb = boxAt(tracks[p.trackId], p.toFrame);
        if (!lb) continue;
        const mpp = 1.75 / Math.max(lb.h, 1);
        const dist = Math.hypot(fb.x + fb.w / 2 - (lb.x + lb.w / 2), fb.y + fb.h - (lb.y + lb.h)) * mpp;
        if (dist / gap > 8) continue;
        const score = dist + gap;
        if (!best || score < best.score) best = { row, score };
      }
    }
    return best?.row ?? null;
  }, [fps, mainRows, tracks]);

  // ── edits ─────────────────────────────────────────────────────────────────
  const commit = useCallback((next: Row[], message: string) => {
    setHistory((h) => [...h.slice(-30), rows]);
    setRows(next.filter((r) => r.parts.length > 0));
    setFlash(message);
    window.setTimeout(() => setFlash(""), 2500);
  }, [rows]);

  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setRows(prev);
  };

  /** move the tail of a track (from `frame` on) from row `fromId` to row `toId` ("new" = a new row) */
  const moveTail = (fromId: string, trackId: string, frame: number, toId: string) => {
    const from = rows.find((r) => r.id === fromId);
    if (!from || fromId === toId) return;
    const part = from.parts.find((p) => p.trackId === trackId && p.fromFrame <= frame && frame <= p.toFrame);
    if (!part) return;
    const head: Part | null = frame > part.fromFrame ? { ...part, toFrame: frame - 1 } : null;
    const tail: Part = { trackId, fromFrame: frame, toFrame: part.toFrame };
    const to = toId === "new" ? null : rows.find((r) => r.id === toId);
    if (to && to.parts.some((p) => overlaps(p, tail))) {
      setFlash("Refused: those two are on the pitch at the same time — they can't be one person");
      window.setTimeout(() => setFlash(""), 3000);
      return;
    }
    const next = rows.map((r) => {
      if (r.id === fromId) return { ...r, parts: r.parts.flatMap((p) => (p === part ? (head ? [head] : []) : [p])) };
      if (to && r.id === toId) return { ...r, parts: [...r.parts, tail].sort((a, b) => a.fromFrame - b.fromFrame) };
      return r;
    });
    if (!to) next.push({ id: `p${Date.now().toString(36)}`, name: "", parts: [tail] });
    commit(next, to ? `Moved ${fmt(frame / fps)} onwards to ${to.name || to.id}` : `Split off a new person from ${fmt(frame / fps)}`);
  };

  const mergeRows = (fromId: string, toId: string) => {
    const from = rows.find((r) => r.id === fromId);
    const to = rows.find((r) => r.id === toId);
    if (!from || !to || from === to) return;
    if (from.parts.some((p) => to.parts.some((q) => overlaps(p, q)))) {
      setFlash("Refused: those two are on the pitch at the same time — they can't be one person");
      window.setTimeout(() => setFlash(""), 3000);
      return;
    }
    const next = rows
      .filter((r) => r.id !== fromId)
      .map((r) => (r.id === toId ? { ...r, parts: [...r.parts, ...from.parts].sort((a, b) => a.fromFrame - b.fromFrame) } : r));
    commit(next, `Merged into ${to.name || to.id}`);
  };

  const rename = (id: string, name: string) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, name } : r)));

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${basePath}/api/admin/recordings/${recordingId}/identities`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identities: rows.map((r) => ({ id: r.id, name: r.name || null, parts: r.parts })) }),
      });
      if (!res.ok) throw new Error(`save -> ${res.status}`);
      setFlash(`Saved ${rows.length} people`);
    } catch (error) {
      setFlash(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
      window.setTimeout(() => setFlash(""), 3000);
    }
  };

  // ── drag plumbing (HTML5 DnD; desktop admin tool) ────────────────────────
  const onDropRow = (toId: string) => {
    if (!drag) return;
    if (drag.kind === "row") mergeRows(drag.rowId, toId);
    else if (drag.trackId && drag.frame !== undefined) moveTail(drag.rowId, drag.trackId, drag.frame, toId);
    setDrag(null);
  };

  if (isLoading) return <main className="idb"><p className="idb-status">Loading…</p></main>;
  if (!user || !isAdmin) return <main className="idb"><p className="idb-status">Admin only.</p></main>;

  const renderRow = (row: Row, compact: boolean) => {
    const crops = cropsForRow(row);
    const span = rowSpan(row) / fps;
    const suggestion = compact ? suggestionFor(row) : null;
    return (
      <div
        key={row.id}
        className={`idb-row ${drag && drag.rowId !== row.id ? "is-target" : ""}`}
        onDragOver={(e) => { if (drag && drag.rowId !== row.id) e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); onDropRow(row.id); }}
        data-testid={`idb-row-${row.id}`}
      >
        <div
          className="idb-handle"
          draggable
          onDragStart={() => setDrag({ kind: "row", rowId: row.id })}
          onDragEnd={() => setDrag(null)}
          title="Drag the whole row onto another row to merge"
        >
          <input className="idb-name" value={row.name} placeholder={row.id} onChange={(e) => rename(row.id, e.target.value)} onClick={(e) => e.stopPropagation()} />
          <span className="idb-meta">{fmt(span)} · {row.parts.length} piece{row.parts.length === 1 ? "" : "s"}</span>
          <div className="idb-timeline" aria-hidden="true">
            {row.parts.map((p, i) => (
              <span key={`${p.trackId}-${i}`} style={{ left: `${(p.fromFrame / fps / duration) * 100}%`, width: `${Math.max(0.3, ((p.toFrame - p.fromFrame) / fps / duration) * 100)}%` }} />
            ))}
          </div>
          {suggestion && (
            <button type="button" className="idb-suggest" onClick={() => mergeRows(row.id, suggestion.id)}>
              → {suggestion.name || suggestion.id}
            </button>
          )}
        </div>
        <div className="idb-strip">
          {crops.map((c, i) => (
            <div
              key={`${c.trackId}-${c.frame}-${i}`}
              className={`idb-crop ${drag?.kind === "crop" && drag.trackId === c.trackId && drag.frame === c.frame ? "is-dragging" : ""}`}
              draggable
              onDragStart={() => setDrag({ kind: "crop", rowId: row.id, trackId: c.trackId, frame: c.frame })}
              onDragEnd={() => setDrag(null)}
              title={`${fmt(c.frame / fps)} · ${c.trackId} — drag to say "someone else from here"`}
            >
              {c.j ? <img src={`data:image/jpeg;base64,${c.j}`} alt="" /> : <span className="idb-nocrop" />}
              <small>{fmt(c.frame / fps)}</small>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <main className="idb" dir="ltr" data-testid="page-identity-board">
      <header className="idb-header">
        <button type="button" className="idb-back" onClick={() => setLocation("/admin")}>← Admin</button>
        <div>
          <h1>Who is who</h1>
          <p>{manifest?.label} · {rows.length} people · drag a crop to say "someone else from here", drag a row handle to merge</p>
        </div>
        <div className="idb-actions">
          <button type="button" onClick={undo} disabled={!history.length}>Undo</button>
          <button type="button" className="is-primary" onClick={save} disabled={saving || !rows.length}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </header>
      {(status || flash) && <p className={`idb-status ${flash.startsWith("Refused") ? "is-warn" : ""}`}>{status || flash}</p>}
      {spriteCoverage.length > 0 && (
        <p className="idb-coverage">
          Crops: {spriteCoverage.map((c) => `${c.name} ${c.ok ? "✓" : `✗ (${c.reason})`}`).join(" · ")}
          {" · bundle: "}{manifest?.provenance?.linker ? String(manifest.provenance.linker).split(" (")[0] : "no provenance (original linker)"}
        </p>
      )}

      <section className="idb-rows">{mainRows.map((row) => renderRow(row, false))}</section>

      <div
        className={`idb-newrow ${drag ? "is-target" : ""}`}
        onDragOver={(e) => { if (drag) e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); onDropRow("new"); }}
      >
        Drop here to make a new person
      </div>

      {fragments.length > 0 && (
        <section className="idb-frags">
          <h2>Fragments under 20 s ({fragments.length}) — each with a suggested row</h2>
          {fragments.map((row) => renderRow(row, true))}
        </section>
      )}
    </main>
  );
}
