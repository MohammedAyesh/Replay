import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Camera, ImagePlus, Scissors, Star, Trash2, Upload, UserRound } from "lucide-react";
import { matchShootFiles } from "@workspace/api-zod";
import { usePlayerPhotosCopy } from "@/i18n/player-photos-strings";
import {
  CHECKER,
  PLAYER_PHOTO_ACCEPT,
  PLAYER_PHOTO_MAX_MB,
  photoSrc,
  useDeletePlayerPhoto,
  usePlayerGallery,
  useUpdatePlayerPhoto,
  useUploadPlayerPhoto,
  useUploadShoot,
  type PlayerPhoto,
} from "@/lib/player-photos-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Players → photos. A player's gallery (add many, pick the main one, label,
 * delete) and the photoshoot upload: drop a whole shoot, each file matched to
 * a player by the shirt number in its name, reviewed before anything is saved.
 * Pictures show on a checkerboard so a cut-out's transparency is visible.
 */

export type PhotoPlayer = { id: number; name: string; jerseyNumber: number | null; isActive: boolean };

const OK_TYPES = new Set(PLAYER_PHOTO_ACCEPT.split(","));
const fileProblem = (f: File, copy: ReturnType<typeof usePlayerPhotosCopy>): string | null =>
  !OK_TYPES.has(f.type) ? copy.badType : f.size > PLAYER_PHOTO_MAX_MB * 1024 * 1024 ? copy.tooBig(PLAYER_PHOTO_MAX_MB) : null;

/** A small square of a player's main photo (or a placeholder), on the checkerboard. */
export function PlayerPhotoThumb({ photo, className }: { photo: PlayerPhoto | null | undefined; className?: string }) {
  return (
    <span className={cn("grid shrink-0 place-items-center overflow-hidden rounded-xl", photo ? "" : "bg-raised text-turf", className)} style={photo ? CHECKER : undefined}>
      {photo ? <img src={photoSrc(photo)} alt="" loading="lazy" className="h-full w-full object-contain object-bottom" /> : <UserRound className="h-5 w-5" aria-hidden />}
    </span>
  );
}

export function PlayerPhotosDialog({ academyId, player, onClose, showNamesNote }: {
  academyId: number; player: PhotoPlayer | null; onClose: () => void; showNamesNote?: boolean;
}) {
  const copy = usePlayerPhotosCopy();
  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  const gallery = usePlayerGallery(academyId, player?.id ?? null);
  const upload = useUploadPlayerPhoto(academyId);
  const update = useUpdatePlayerPhoto(academyId);
  const remove = useDeletePlayerPhoto(academyId);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: FileList | File[]) => {
    if (!player) return;
    setError(null);
    for (const file of Array.from(files)) {
      const problem = fileProblem(file, copy);
      if (problem) { setError(`${file.name}: ${problem}`); continue; }
      try {
        await upload.mutateAsync({ playerId: player.id, file });
      } catch (e) {
        setError((e as Error).message || copy.failed);
      }
    }
    void gallery.refetch();
  };

  return (
    <Dialog open={player !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent dir={dir} className="max-h-[90dvh] overflow-y-auto border-line bg-surface text-text sm:max-w-3xl" data-testid="player-photos-dialog">
        <DialogHeader className="text-start">
          <DialogTitle dir="auto">{player ? copy.photosOf(player.name) : ""}</DialogTitle>
          <DialogDescription className="text-start text-muted-text">{copy.galleryHint}</DialogDescription>
        </DialogHeader>
        {showNamesNote ? <p className="rounded-xl border border-line bg-raised p-3 text-xs text-muted-text">{copy.namesOffNote}</p> : null}
        <div>
          <input ref={input} type="file" accept={PLAYER_PHOTO_ACCEPT} multiple className="hidden" data-testid="player-photos-input"
            onChange={(e) => { if (e.target.files?.length) void add(e.target.files); e.target.value = ""; }} />
          <Button type="button" onClick={() => input.current?.click()} disabled={upload.isPending} className="min-h-11 rounded-xl bg-floodlight font-bold text-void hover:bg-floodlight/90" data-testid="player-photos-add">
            <ImagePlus className="me-2 h-4 w-4" aria-hidden />{upload.isPending ? copy.adding : copy.add}
          </Button>
        </div>
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {!gallery.data?.length ? <p className="py-6 text-center text-sm text-muted-text">{gallery.isLoading ? "…" : copy.empty}</p> : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {gallery.data.map((p) => (
              <GalleryCard key={p.photoId} photo={p}
                onMain={() => update.mutate({ photo: p, isPrimary: true }, { onSuccess: () => void gallery.refetch() })}
                onLabel={(label) => update.mutate({ photo: p, label }, { onSuccess: () => void gallery.refetch() })}
                onDelete={() => { if (window.confirm(copy.removeConfirm)) remove.mutate(p, { onSuccess: () => void gallery.refetch() }); }} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function GalleryCard({ photo, onMain, onLabel, onDelete }: { photo: PlayerPhoto; onMain: () => void; onLabel: (label: string | null) => void; onDelete: () => void }) {
  const copy = usePlayerPhotosCopy();
  const [label, setLabel] = useState(photo.label ?? "");
  useEffect(() => setLabel(photo.label ?? ""), [photo.label]);
  const changed = (label.trim() || null) !== (photo.label ?? null);
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-void" data-testid={`player-photo-${photo.photoId}`}>
      <div className="relative aspect-[3/4]" style={CHECKER}>
        <img src={photoSrc(photo)} alt={photo.label ?? ""} loading="lazy" className="h-full w-full object-contain object-bottom" />
        <div className="absolute top-2 start-2 flex flex-wrap gap-1">
          {photo.isPrimary ? <span className="inline-flex items-center gap-1 rounded-md bg-floodlight px-1.5 py-0.5 text-[10px] font-bold text-void"><Star className="h-3 w-3" aria-hidden />{copy.main}</span> : null}
          {photo.transparent ? <span className="inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white"><Scissors className="h-3 w-3" aria-hidden />{copy.cutout}</span> : null}
        </div>
      </div>
      <div className="space-y-2 p-2">
        <div className="flex gap-1.5">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={copy.labelPlaceholder} aria-label={copy.label} maxLength={40} dir="auto"
            onKeyDown={(e) => { if (e.key === "Enter" && changed) onLabel(label.trim() || null); }} className="min-h-9 rounded-lg bg-surface text-xs" />
          {changed ? <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={() => onLabel(label.trim() || null)}>{copy.saveLabel}</Button> : null}
        </div>
        <div className="flex items-center justify-between gap-2">
          {!photo.isPrimary
            ? <Button type="button" size="sm" variant="outline" className="min-h-9 rounded-lg" onClick={onMain} data-testid={`player-photo-main-${photo.photoId}`}><Star className="me-1.5 h-3.5 w-3.5" aria-hidden />{copy.makeMain}</Button>
            : <span />}
          <button type="button" onClick={onDelete} aria-label={copy.remove} className="grid h-9 w-9 place-items-center rounded-lg text-muted-text hover:text-destructive" data-testid={`player-photo-delete-${photo.photoId}`}>
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

const SHOOT_BATCH = 6;

type ShootRow = { key: string; file: File; url: string; number: number | null; reason: "matched" | "no-number" | "no-player" | "ambiguous"; playerId: number | null; problem: string | null };

export function PhotoshootDialog({ academyId, players, open, onClose }: { academyId: number; players: PhotoPlayer[]; open: boolean; onClose: () => void }) {
  const copy = usePlayerPhotosCopy();
  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  const save = useUploadShoot(academyId);
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ShootRow[]>([]);
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const active = useMemo(() => players.filter((p) => p.isActive).sort((a, b) => (a.jerseyNumber ?? 999) - (b.jerseyNumber ?? 999)), [players]);

  // Previews are object URLs: released when the dialog closes or unmounts.
  const urls = useRef<string[]>([]);
  const release = () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); urls.current = []; };
  useEffect(() => release, []);
  useEffect(() => { if (!open) { release(); setRows([]); setResult(null); } }, [open]);

  const addFiles = (list: FileList | File[]) => {
    const files = Array.from(list).filter((f) => f.type.startsWith("image/"));
    const matched = matchShootFiles(files.map((f) => f.name), active);
    setResult(null);
    setRows((old) => [...old, ...files.map((file, i) => ({
      key: `${file.name}-${file.size}-${file.lastModified}-${old.length + i}`,
      file,
      url: (() => { const u = URL.createObjectURL(file); urls.current.push(u); return u; })(),
      number: matched[i].number,
      reason: matched[i].reason,
      playerId: matched[i].playerId,
      problem: fileProblem(file, copy),
    }))]);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };
  const ready = rows.filter((r) => r.playerId !== null && !r.problem);
  const why = (r: ShootRow) => r.problem ?? (r.reason === "matched" ? copy.matched : r.reason === "no-number" ? copy.noNumber : r.reason === "ambiguous" ? copy.twoMatch(r.number!) : copy.noMatch(r.number!));

  const submit = async () => {
    // A few files per request: a whole shoot in one body would be hundreds of MB.
    let added = 0;
    let skipped = 0;
    const done = new Set<string>();
    try {
      for (let i = 0; i < ready.length; i += SHOOT_BATCH) {
        const batch = ready.slice(i, i + SHOOT_BATCH);
        const out = await save.mutateAsync(batch.map((r) => ({ file: r.file, playerId: r.playerId })));
        added += out.added.length;
        skipped += out.skipped.length;
        batch.forEach((r) => done.add(r.key));
      }
      setResult([copy.saved(added), skipped ? copy.skipped(skipped) : ""].filter(Boolean).join(" · "));
    } catch (e) {
      setResult([added ? copy.saved(added) : "", (e as Error).message || copy.failed].filter(Boolean).join(" · "));
    }
    setRows((list) => list.filter((r) => !done.has(r.key)));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent dir={dir} className="max-h-[90dvh] overflow-y-auto border-line bg-surface text-text sm:max-w-3xl" data-testid="photoshoot-dialog">
        <DialogHeader className="text-start">
          <DialogTitle>{copy.shootTitle}</DialogTitle>
          <DialogDescription className="text-start text-muted-text">{copy.shootHint}</DialogDescription>
        </DialogHeader>
        <input ref={input} type="file" accept={PLAYER_PHOTO_ACCEPT} multiple className="hidden" data-testid="photoshoot-input"
          onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ""; }} />
        <button type="button" onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
          className={cn("flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-4 text-sm text-muted-text transition-colors", over ? "border-turf bg-turf/10 text-text" : "border-line hover:border-turf")}
          data-testid="photoshoot-drop">
          <Upload className="h-6 w-6" aria-hidden />{copy.drop}
        </button>
        {rows.length ? (
          <div className="space-y-2" data-testid="photoshoot-review">
            {rows.map((r) => (
              <div key={r.key} className="flex items-center gap-3 rounded-xl border border-line bg-void p-2" data-testid="photoshoot-row">
                <span className="h-16 w-12 shrink-0 overflow-hidden rounded-lg" style={CHECKER}>
                  <img src={r.url} alt="" className="h-full w-full object-contain object-bottom" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-text" dir="ltr">{r.file.name}</p>
                  <p className={cn("text-[11px]", r.problem || r.playerId === null ? "text-destructive" : "text-turf")}>{why(r)}</p>
                </div>
                <select value={r.playerId ?? ""} aria-label={copy.player} disabled={!!r.problem}
                  onChange={(e) => setRows((list) => list.map((x) => (x.key === r.key ? { ...x, playerId: e.target.value ? Number(e.target.value) : null, reason: x.reason } : x)))}
                  className="min-h-10 max-w-[45%] rounded-lg border border-line bg-surface px-2 text-sm text-text">
                  <option value="">{copy.noPlayer}</option>
                  {active.map((p) => <option key={p.id} value={p.id}>{p.jerseyNumber !== null ? `#${p.jerseyNumber} · ` : ""}{p.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        ) : null}
        {result ? <p className="text-sm text-text" role="status">{result}</p> : null}
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-text">{rows.length ? copy.ready(ready.length, rows.length) : ""}</span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="min-h-11" onClick={onClose}>{copy.close}</Button>
            <Button type="button" disabled={!ready.length || save.isPending} onClick={() => void submit()} className="min-h-11 bg-floodlight font-bold text-void hover:bg-floodlight/90" data-testid="photoshoot-save">
              <Camera className="me-2 h-4 w-4" aria-hidden />{save.isPending ? copy.saving : copy.save}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
