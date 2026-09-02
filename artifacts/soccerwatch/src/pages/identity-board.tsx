/**
 * Admin identity board for Claim Match.
 *
 * A row is a proposed person and each part is a frame-bounded piece of a
 * tracker track. Automatic grouping is deliberately conservative: it compares
 * a new piece with every compatible piece in a row, not only the row's last
 * piece. Drag edits become same/different constraints and survive recompute.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import type { TrackingIdentity, TrackingManifest } from "@workspace/api-client-react";
import { identityMapMatchesBundle } from "@/lib/claim-match-identities";

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
type Drag = { kind: "crop" | "row"; rowId: string; trackId?: string; frame?: number };
type HistoryEntry = { rows: Row[]; same: Set<string>; different: Set<string> };
type Crop = { trackId: string; frame: number; j?: string; boundary?: boolean };
type Issue = { rowId: string; message: string };

const K_PER_ROW = 14;
const MAX_GAP_SECONDS = 8;
const MAX_SPEED_MPS = 8;

function partKey(part: Part) {
  return `${part.trackId}:${part.fromFrame}-${part.toFrame}`;
}

function pairKey(a: Part, b: Part) {
  const left = partKey(a);
  const right = partKey(b);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function boxAt(track: Track | undefined, frame: number): Box | null {
  if (!track?.boxes.length) return null;
  const boxes = track.boxes;
  let lo = 0;
  let hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxes[mid].frame < frame) lo = mid + 1;
    else hi = mid;
  }
  const current = boxes[lo];
  const before = lo > 0 ? boxes[lo - 1] : current;
  return Math.abs(before.frame - frame) < Math.abs(current.frame - frame) ? before : current;
}

function overlaps(a: Part, b: Part) {
  return a.fromFrame <= b.toFrame && b.fromFrame <= a.toFrame;
}

/** Elapsed span, rather than the sum of pieces (scattered appearances are long spans). */
function rowSpan(row: Row) {
  if (!row.parts.length) return 0;
  return Math.max(...row.parts.map((p) => p.toFrame)) - Math.min(...row.parts.map((p) => p.fromFrame)) + 1;
}

function fmt(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function validTracks(all: Record<string, Track>) {
  return Object.values(all).filter((track) => track.boxes.length > 0);
}

function canReach(a: Part, b: Part, tracks: Record<string, Track>, fps: number) {
  const earlier = a.fromFrame <= b.fromFrame ? a : b;
  const later = earlier === a ? b : a;
  const gap = (later.fromFrame - earlier.toFrame) / fps;
  if (gap <= 0 || gap > MAX_GAP_SECONDS) return false;
  const from = boxAt(tracks[earlier.trackId], earlier.toFrame);
  const to = boxAt(tracks[later.trackId], later.fromFrame);
  if (!from || !to) return false;
  const metresPerPixel = 1.75 / Math.max(from.h, 1);
  const distance = Math.hypot(
    to.x + to.w / 2 - (from.x + from.w / 2),
    to.y + to.h - (from.y + from.h),
  ) * metresPerPixel;
  return distance / Math.max(gap, 0.05) <= MAX_SPEED_MPS;
}

function stableRowId(parts: Part[], index: number) {
  const first = [...parts].sort((a, b) => a.fromFrame - b.fromFrame)[0];
  return first ? `p-${first.trackId}-${first.fromFrame}` : `p-${index + 1}`;
}

function findPriorRow(parts: Part[], priorRows: Row[]) {
  const partSet = new Set(parts.map(partKey));
  return priorRows
    .map((row) => ({ row, score: row.parts.filter((part) => partSet.has(partKey(part))).length }))
    .sort((a, b) => b.score - a.score)[0]?.row;
}

function buildRows(
  all: Record<string, Track>,
  fps: number,
  pieces: Part[],
  same: Set<string>,
  different: Set<string>,
  priorRows: Row[],
): Row[] {
  const usable = new Set(validTracks(all).map((track) => track.id));
  const input = pieces.filter((part) => usable.has(part.trackId) && part.fromFrame <= part.toFrame);
  const parent = new Map(input.map((part) => [partKey(part), partKey(part)]));
  const find = (key: string): string => {
    let root = parent.get(key) ?? key;
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
    let cursor = key;
    while (parent.get(cursor) && parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const left = find(a);
    const right = find(b);
    if (left !== right) parent.set(right, left);
  };
  for (const pair of same) {
    const [a, b] = pair.split("|");
    union(a, b);
  }

  const components = new Map<string, Part[]>();
  for (const part of input) {
    const root = find(partKey(part));
    (components.get(root) ?? (components.set(root, []), components.get(root)!)).push(part);
  }
  const ordered = [...components.values()].sort((a, b) =>
    Math.min(...a.map((part) => part.fromFrame)) - Math.min(...b.map((part) => part.fromFrame)),
  );
  const groups: Part[][] = [];
  for (const component of ordered) {
    const candidates = groups.map((group, index) => {
      const blocked = component.some((a) => group.some((b) =>
        overlaps(a, b) || different.has(pairKey(a, b)),
      ));
      if (blocked) return null;
      const links = component.flatMap((a) => group.map((b) => canReach(a, b, all, fps) ? 1 : 0)).reduce((sum, value) => sum + value, 0);
      if (!links) return null;
      const distance = component.reduce((sum, a) => sum + Math.min(
        ...group.map((b) => canReach(a, b, all, fps) ? Math.abs(a.fromFrame - b.toFrame) : Number.POSITIVE_INFINITY),
      ), 0);
      return { index, score: distance / Math.max(1, links) };
    }).filter((candidate): candidate is { index: number; score: number } => Boolean(candidate));
    const best = candidates.sort((a, b) => a.score - b.score)[0];
    if (best) groups[best.index].push(...component);
    else groups.push(component);
  }

  return groups.map((parts, index) => {
    const prior = findPriorRow(parts, priorRows);
    return {
      id: prior?.id ?? stableRowId(parts, index),
      name: prior?.name ?? "",
      parts: parts.sort((a, b) => a.fromFrame - b.fromFrame || a.trackId.localeCompare(b.trackId)),
    };
  });
}

function autoRows(all: Record<string, Track>, frameRate: number) {
  const pieces = validTracks(all).map((track) => ({
    trackId: track.id,
    fromFrame: track.startFrame,
    toFrame: track.endFrame,
  }));
  return buildRows(all, frameRate, pieces, new Set(), new Set(), []);
}

function deriveConstraints(rows: Row[]) {
  const same = new Set<string>();
  const different = new Set<string>();
  for (const row of rows) {
    for (let i = 0; i < row.parts.length; i++) {
      for (let j = i + 1; j < row.parts.length; j++) same.add(pairKey(row.parts[i], row.parts[j]));
    }
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      for (const a of rows[i].parts) {
        for (const b of rows[j].parts) if (a.trackId === b.trackId && !overlaps(a, b)) different.add(pairKey(a, b));
      }
    }
  }
  return { same, different };
}

function mergeIntervals(intervals: Array<[number, number]>) {
  const sorted = intervals.filter(([start, end]) => end >= start).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1] + 1) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

function metrics(rows: Row[], tracks: Record<string, Track>, fps: number) {
  const allIntervals = validTracks(tracks).map((track) => [track.startFrame, track.endFrame] as [number, number]);
  const assignedIntervals: Array<[number, number]> = [];
  let unassignedPieces = 0;
  for (const track of validTracks(tracks)) {
    const covered = mergeIntervals(rows.flatMap((row) => row.parts
      .filter((part) => part.trackId === track.id)
      .map((part) => [Math.max(part.fromFrame, track.startFrame), Math.min(part.toFrame, track.endFrame)] as [number, number])));
    assignedIntervals.push(...covered);
    let cursor = track.startFrame;
    for (const [start, end] of covered) {
      if (start > cursor) unassignedPieces++;
      cursor = Math.max(cursor, end + 1);
    }
    if (cursor <= track.endFrame) unassignedPieces++;
  }
  const total = mergeIntervals(allIntervals).reduce((sum, [start, end]) => sum + end - start + 1, 0);
  const assigned = mergeIntervals(assignedIntervals).reduce((sum, [start, end]) => sum + end - start + 1, 0);
  return {
    assignedSeconds: assigned / fps,
    assignedPercent: total ? (assigned / total) * 100 : 0,
    unassignedPieces,
    singlePieceRows: rows.filter((row) => row.parts.length === 1).length,
  };
}

function rowIssues(rows: Row[], tracks: Record<string, Track>, fps: number): Issue[] {
  const issues: Issue[] = [];
  for (const row of rows) {
    const parts = [...row.parts].sort((a, b) => a.fromFrame - b.fromFrame);
    for (let i = 1; i < parts.length; i++) {
      if (overlaps(parts[i - 1], parts[i])) {
        issues.push({ rowId: row.id, message: "overlapping pieces" });
      } else if (!canReach(parts[i - 1], parts[i], tracks, fps)) {
        issues.push({ rowId: row.id, message: "pieces are not reachable/coexistent" });
      }
    }
  }
  return issues;
}

function serializeRows(rows: Row[]) {
  return JSON.stringify(rows.map((row) => ({
    id: row.id,
    name: row.name,
    parts: [...row.parts].sort((a, b) => partKey(a).localeCompare(partKey(b))),
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

function addUnique(items: Crop[], item: Crop) {
  if (!items.some((current) => current.trackId === item.trackId && current.frame === item.frame)) items.push(item);
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
  const [drag, setDrag] = useState<Drag | null>(null);
  const [flash, setFlash] = useState("");
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [same, setSame] = useState<Set<string>>(new Set());
  const [different, setDifferent] = useState<Set<string>>(new Set());
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [spriteCoverage, setSpriteCoverage] = useState<Array<{ name: string; ok: boolean; reason?: string }>>([]);
  const nameBeforeEdit = useRef(new Map<string, string>());
  const cropCache = useRef(new Map<string, Crop[]>());
  const spriteReference = useRef(sprites);

  const fps = manifest?.frameRate ?? 20;
  const duration = manifest?.duration ?? 1;
  const isDirty = savedSnapshot !== null && savedSnapshot !== serializeRows(rows);

  useEffect(() => {
    if (spriteReference.current !== sprites) {
      spriteReference.current = sprites;
      cropCache.current.clear();
    }
  }, [sprites]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);

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
          for (const track of segment.tracks) if (track.boxes.length) all[track.id] = track;
          try {
            const segmentSprites = await get<Record<string, Sprite[]>>(`/recordings/${recordingId}/claim-match/sprites/${entry.index}`);
            const matched = Object.keys(segmentSprites).filter((key) => segment.tracks.some((track) => track.id === key)).length;
            Object.assign(spr, segmentSprites);
            coverage.push(matched > 0
              ? { name: entry.name, ok: true }
              : { name: entry.name, ok: false, reason: `${Object.keys(segmentSprites).length} strips but none match this segment's track ids (e.g. ${Object.keys(segmentSprites)[0] ?? "-"} vs ${segment.tracks[0]?.id ?? "-"})` });
          } catch (error) {
            coverage.push({ name: entry.name, ok: false, reason: error instanceof Error && error.message.endsWith("404") ? "bundle carried no sprites for it" : (error instanceof Error ? error.message : "failed") });
          }
          if (cancelled) return;
        }
        const saved = claim.manifest.identities ?? [];
        const usableSavedMap = saved.length > 0 && identityMapMatchesBundle(claim.manifest);
        const initialRows = usableSavedMap
          ? saved.map((identity: TrackingIdentity) => ({ id: identity.id, name: identity.name ?? "", parts: identity.parts }))
          : autoRows(all, claim.manifest.frameRate);
        const initialConstraints = usableSavedMap ? deriveConstraints(initialRows) : { same: new Set<string>(), different: new Set<string>() };
        setTracks(all);
        setSprites(spr);
        setSpriteCoverage(coverage);
        setRows(initialRows);
        setSame(initialConstraints.same);
        setDifferent(initialConstraints.different);
        setHistory([]);
        setSavedSnapshot(serializeRows(initialRows));
        setStatus(saved.length > 0 && !usableSavedMap
          ? "Saved identity map does not match this tracking bundle. It was not applied; recompute and save a new map."
          : "");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not load");
      }
    })();
    return () => { cancelled = true; };
  }, [userId, isAdmin, recordingId]);

  const sortedRows = useMemo(() => [...rows].sort((a, b) => rowSpan(b) - rowSpan(a)), [rows]);
  const mainRows = useMemo(() => sortedRows.filter((row) => rowSpan(row) / fps >= 20), [sortedRows, fps]);
  const fragments = useMemo(() => sortedRows.filter((row) => rowSpan(row) / fps < 20).sort((a, b) => a.parts[0].fromFrame - b.parts[0].fromFrame), [sortedRows, fps]);
  const issues = useMemo(() => rowIssues(rows, tracks, fps), [rows, tracks, fps]);
  const issueRows = useMemo(() => new Set(issues.map((issue) => issue.rowId)), [issues]);
  const boardMetrics = useMemo(() => metrics(rows, tracks, fps), [rows, tracks, fps]);

  const cropsForRow = useCallback((row: Row): Crop[] => {
    const cacheKey = row.parts.map(partKey).sort().join("|");
    const cached = cropCache.current.get(cacheKey);
    if (cached) return cached;
    const items: Crop[] = [];
    const sortedParts = [...row.parts].sort((a, b) => a.fromFrame - b.fromFrame);
    const regular: Crop[] = [];
    for (const part of sortedParts) {
      const strips = (sprites[part.trackId] ?? []).filter((sprite) => sprite.f >= part.fromFrame && sprite.f <= part.toFrame);
      if (strips.length) strips.forEach((sprite) => regular.push({ trackId: part.trackId, frame: sprite.f, j: sprite.j }));
      else regular.push({ trackId: part.trackId, frame: part.fromFrame });
    }
    regular.sort((a, b) => a.frame - b.frame);
    if (regular.length <= K_PER_ROW) regular.forEach((item) => addUnique(items, item));
    else {
      const step = (regular.length - 1) / (K_PER_ROW - 1);
      for (let index = 0; index < K_PER_ROW; index++) addUnique(items, regular[Math.round(index * step)]);
    }
    for (let index = 1; index < sortedParts.length; index++) {
      const previous = sortedParts[index - 1];
      const current = sortedParts[index];
      const previousStrips = (sprites[previous.trackId] ?? []).filter((sprite) => sprite.f >= previous.fromFrame && sprite.f <= previous.toFrame);
      const currentStrips = (sprites[current.trackId] ?? []).filter((sprite) => sprite.f >= current.fromFrame && sprite.f <= current.toFrame);
      const before = previousStrips.slice(-2);
      const after = currentStrips.slice(0, 2);
      (before.length ? before : [{ f: previous.toFrame, j: "" }]).forEach((sprite) => addUnique(items, { trackId: previous.trackId, frame: sprite.f, j: sprite.j, boundary: true }));
      (after.length ? after : [{ f: current.fromFrame, j: "" }]).forEach((sprite) => addUnique(items, { trackId: current.trackId, frame: sprite.f, j: sprite.j, boundary: true }));
    }
    items.sort((a, b) => a.frame - b.frame || Number(Boolean(a.boundary)) - Number(Boolean(b.boundary)));
    cropCache.current.set(cacheKey, items);
    return items;
  }, [sprites]);

  const suggestionFor = useCallback((row: Row): Row | null => {
    let best: { row: Row; score: number } | null = null;
    for (const candidate of sortedRows) {
      if (candidate.id === row.id) continue;
      if (candidate.parts.some((a) => row.parts.some((b) => overlaps(a, b)))) continue;
      const links = row.parts.flatMap((a) => candidate.parts.map((b) => canReach(a, b, tracks, fps) ? Math.abs(a.fromFrame - b.toFrame) : Number.POSITIVE_INFINITY));
      const score = Math.min(...links);
      if (Number.isFinite(score) && (!best || score < best.score)) best = { row: candidate, score };
    }
    return best?.row ?? null;
  }, [fps, sortedRows, tracks]);

  const flashMessage = useCallback((message: string, warning = false) => {
    setFlash(`${warning ? "Warning: " : ""}${message}`);
    window.setTimeout(() => setFlash(""), 3500);
  }, []);

  const commit = useCallback((next: Row[], message: string, sameAdd: string[] = [], differentAdd: string[] = []) => {
    const nextSame = new Set(same);
    const nextDifferent = new Set(different);
    sameAdd.forEach((key) => {
      nextSame.add(key);
      nextDifferent.delete(key);
    });
    differentAdd.forEach((key) => {
      nextDifferent.add(key);
      nextSame.delete(key);
    });
    setHistory((historyEntries) => [...historyEntries.slice(-30), { rows, same: new Set(same), different: new Set(different) }]);
    const recomputed = buildRows(tracks, fps, next.flatMap((row) => row.parts), nextSame, nextDifferent, next);
    setSame(nextSame);
    setDifferent(nextDifferent);
    setRows(recomputed);
    flashMessage(message);
  }, [different, flashMessage, fps, rows, same, tracks]);

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((entries) => entries.slice(0, -1));
    setRows(previous.rows);
    setSame(previous.same);
    setDifferent(previous.different);
    flashMessage("Undid the last edit");
  };

  const moveTail = (fromId: string, trackId: string, frame: number, toId: string) => {
    const from = rows.find((row) => row.id === fromId);
    if (!from || fromId === toId) return;
    const part = from.parts.find((candidate) => candidate.trackId === trackId && candidate.fromFrame <= frame && frame <= candidate.toFrame);
    if (!part) return;
    const head: Part | null = frame > part.fromFrame ? { ...part, toFrame: frame - 1 } : null;
    const tail: Part = { trackId, fromFrame: frame, toFrame: part.toFrame };
    const to = toId === "new" ? null : rows.find((row) => row.id === toId);
    if (to && to.parts.some((candidate) => overlaps(candidate, tail))) {
      flashMessage("Those two pieces overlap in time — they cannot be one person", true);
      return;
    }
    const next = rows.map((row) => {
      if (row.id === fromId) return { ...row, parts: row.parts.flatMap((candidate) => candidate === part ? (head ? [head] : []) : [candidate]) };
      if (to && row.id === toId) return { ...row, parts: [...row.parts, tail].sort((a, b) => a.fromFrame - b.fromFrame) };
      return row;
    });
    if (!to) next.push({ id: `p-${trackId}-${frame}`, name: "", parts: [tail] });
    const differentAdd: string[] = [];
    if (head) differentAdd.push(pairKey(head, tail));
    const sameAdd = to ? to.parts.map((candidate) => pairKey(candidate, tail)) : [];
    commit(next, to ? `Moved ${fmt(frame / fps)} onwards to ${to.name || to.id}` : `Split off a new person from ${fmt(frame / fps)}`, sameAdd, differentAdd);
  };

  const mergeRows = (fromId: string, toId: string) => {
    const from = rows.find((row) => row.id === fromId);
    const to = rows.find((row) => row.id === toId);
    if (!from || !to || from === to) return;
    if (from.parts.some((a) => to.parts.some((b) => overlaps(a, b)))) {
      flashMessage("Those two pieces overlap in time — they cannot be one person", true);
      return;
    }
    const next = rows.filter((row) => row.id !== fromId).map((row) =>
      row.id === toId ? { ...row, parts: [...row.parts, ...from.parts].sort((a, b) => a.fromFrame - b.fromFrame) } : row,
    );
    commit(next, `Merged into ${to.name || to.id}`, from.parts.flatMap((a) => to.parts.map((b) => pairKey(a, b))));
  };

  const recompute = useCallback((message = "Recomputed grouping from the current constraints") => {
    const next = buildRows(tracks, fps, rows.flatMap((row) => row.parts), same, different, rows);
    const before = new Map(rows.flatMap((row) => row.parts.map((part) => [partKey(part), row.id] as const)));
    const moved = next.flatMap((row) => row.parts).filter((part) => before.get(partKey(part)) !== rowIdForPart(next, part)).length;
    setRows(next);
    flashMessage(`${message}${moved ? ` · ${moved} piece${moved === 1 ? "" : "s"} moved` : ""}`);
  }, [different, flashMessage, fps, rows, same, tracks]);

  const rename = (id: string, name: string) => setRows((current) => current.map((row) => row.id === id ? { ...row, name } : row));
  const finishRename = (id: string) => {
    const before = nameBeforeEdit.current.get(id);
    const current = rows.find((row) => row.id === id)?.name;
    nameBeforeEdit.current.delete(id);
    if (before !== undefined && current !== before) {
      setHistory((entries) => [...entries.slice(-30), { rows, same: new Set(same), different: new Set(different) }]);
      flashMessage(`Renamed ${id}`);
    }
  };

  const save = async () => {
    const next = buildRows(tracks, fps, rows.flatMap((row) => row.parts), same, different, rows);
    setRows(next);
    setSaving(true);
    try {
      const res = await fetch(`${basePath}/api/admin/recordings/${recordingId}/identities`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundleFingerprint: String(manifest?.provenance?.bundleFingerprint ?? ""),
          identities: next.map((row) => ({ id: row.id, name: row.name || null, parts: row.parts })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `save -> ${res.status}`);
      }
      setSavedSnapshot(serializeRows(next));
      flashMessage(`Saved ${next.length} people and refreshed grouping`);
    } catch (error) {
      flashMessage(error instanceof Error ? error.message : "Save failed", true);
    } finally {
      setSaving(false);
    }
  };

  const leave = () => {
    if (isDirty && !window.confirm("You have unsaved identity edits. Leave without saving?")) return;
    setLocation("/admin");
  };

  const onDropRow = (toId: string) => {
    if (!drag) return;
    if (drag.kind === "row") {
      if (toId === "new") flashMessage("That row is already a separate person. Drag a crop to split it, or merge it into another row.", true);
      else mergeRows(drag.rowId, toId);
    } else if (drag.trackId && drag.frame !== undefined) moveTail(drag.rowId, drag.trackId, drag.frame, toId);
    setDrag(null);
  };

  if (isLoading) return <main className="idb"><p className="idb-status">Loading…</p></main>;
  if (!user || !isAdmin) return <main className="idb"><p className="idb-status">Admin only.</p></main>;

  const renderRow = (row: Row, compact: boolean) => {
    const crops = cropsForRow(row);
    const span = rowSpan(row) / fps;
    const suggestion = suggestionFor(row);
    const issue = issues.find((item) => item.rowId === row.id);
    return (
      <div
        key={row.id}
        className={`idb-row ${drag && drag.rowId !== row.id ? "is-target" : ""} ${issue ? "is-inconsistent" : ""}`}
        onDragOver={(event) => { if (drag && drag.rowId !== row.id) event.preventDefault(); }}
        onDrop={(event) => { event.preventDefault(); onDropRow(row.id); }}
        data-testid={`idb-row-${row.id}`}
      >
        <div className="idb-handle" draggable onDragStart={() => setDrag({ kind: "row", rowId: row.id })} onDragEnd={() => setDrag(null)} title="Drag the whole row onto another row to merge">
          <input
            className="idb-name"
            value={row.name}
            placeholder={row.id}
            onFocus={() => nameBeforeEdit.current.set(row.id, row.name)}
            onChange={(event) => rename(row.id, event.target.value)}
            onBlur={() => finishRename(row.id)}
            onClick={(event) => event.stopPropagation()}
          />
          <span className="idb-meta">{fmt(span)} · {row.parts.length} piece{row.parts.length === 1 ? "" : "s"}{issue ? ` · ${issue.message}` : ""}</span>
          <div className="idb-timeline" aria-hidden="true">
            {row.parts.map((part, index) => (
              <span key={`${partKey(part)}-${index}`} style={{ left: `${(part.fromFrame / fps / duration) * 100}%`, width: `${Math.max(0.3, ((part.toFrame - part.fromFrame + 1) / fps / duration) * 100)}%` }} />
            ))}
          </div>
          {suggestion && (
            <button type="button" className="idb-suggest" onClick={() => mergeRows(row.id, suggestion.id)}>
              → {suggestion.name || suggestion.id}
            </button>
          )}
        </div>
        <div className="idb-strip">
          {crops.map((crop, index) => (
            <div
              key={`${crop.trackId}-${crop.frame}-${index}`}
              className={`idb-crop ${crop.boundary ? "is-boundary" : ""} ${drag?.kind === "crop" && drag.trackId === crop.trackId && drag.frame === crop.frame ? "is-dragging" : ""}`}
              draggable
              onDragStart={() => setDrag({ kind: "crop", rowId: row.id, trackId: crop.trackId, frame: crop.frame })}
              onDragEnd={() => setDrag(null)}
              title={`${fmt(crop.frame / fps)} · ${crop.trackId} — drag to say "someone else from here"`}
            >
              {crop.boundary && <b className="idb-join-marker">JOIN</b>}
              {crop.j ? <img src={`data:image/jpeg;base64,${crop.j}`} alt="" /> : <span className="idb-nocrop" />}
              <small>{fmt(crop.frame / fps)}</small>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const countWarning = rows.length >= 180
    ? `${rows.length} people: the identity map limit is close${rows.length > 200 ? " — reduce rows before saving" : ""}.`
    : "";

  return (
    <main className="idb" dir="ltr" data-testid="page-identity-board">
      <header className="idb-header">
        <button type="button" className="idb-back" onClick={leave}>← Admin</button>
        <div>
          <h1>Who is who</h1>
          <p>{manifest?.label} · {rows.length} people · drag a crop to split, or a row handle to merge</p>
        </div>
        <div className="idb-actions">
          <button type="button" onClick={undo} disabled={!history.length}>Undo</button>
          <button type="button" onClick={() => recompute()} disabled={!rows.length}>Recompute</button>
          <button type="button" className="is-primary" onClick={save} disabled={saving || !rows.length}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </header>
      {status && <p className={`idb-status ${status.includes("does not match") ? "is-warn" : ""}`}>{status}</p>}
      {flash && <p className={`idb-status ${flash.startsWith("Warning") ? "is-warn" : ""}`}>{flash}</p>}
      <div className="idb-metrics">
        <span>Assigned tracked time <b>{fmt(boardMetrics.assignedSeconds)}</b></span>
        <span>Unassigned pieces <b>{boardMetrics.unassignedPieces}</b></span>
        <span>Single-piece rows <b>{boardMetrics.singlePieceRows}</b></span>
        <span>Consistency <b>{issues.length ? `${issues.length} flagged` : "OK"}</b></span>
        {isDirty && <strong>Unsaved changes</strong>}
      </div>
      {countWarning && <p className="idb-status is-warn">{countWarning}</p>}
      {spriteCoverage.length > 0 && (
        <p className="idb-coverage">
          Crops: {spriteCoverage.map((coverage) => `${coverage.name} ${coverage.ok ? "✓" : `✗ (${coverage.reason})`}`).join(" · ")}
          {" · bundle: "}{manifest?.provenance?.linker ? String(manifest.provenance.linker).split(" (")[0] : "no provenance (original linker)"}
        </p>
      )}
      <section className="idb-rows">{mainRows.map((row) => renderRow(row, false))}</section>
      <div className={`idb-newrow ${drag ? "is-target" : ""}`} onDragOver={(event) => { if (drag) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); onDropRow("new"); }}>
        Drop a crop here to make a new person
      </div>
      {fragments.length > 0 && (
        <section className="idb-frags">
          <h2>Short-span rows ({fragments.length}) — suggestions can join fragments too</h2>
          {fragments.map((row) => renderRow(row, true))}
        </section>
      )}
    </main>
  );
}

function rowIdForPart(rows: Row[], part: Part) {
  return rows.find((row) => row.parts.some((candidate) => partKey(candidate) === partKey(part)))?.id;
}