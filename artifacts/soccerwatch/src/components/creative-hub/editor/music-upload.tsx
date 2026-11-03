import { useEffect, useRef, useState } from "react";
import { FileAudio, Loader2, Upload } from "lucide-react";
import { MUSIC_MOODS, MUSIC_UPLOAD_ACCEPT, MUSIC_UPLOAD_MAX_BYTES, type MusicMood } from "@workspace/api-zod";
import { useCreativeMusicCopy } from "@/i18n/creative-music-strings";
import { useUploadCreativeMusic, type MusicTrack } from "@/lib/creative-hub-music-api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Chip } from "./controls";

const EXT = /\.(mp3|m4a|aac|wav)$/i;

/** "Upload music": the academy's own track. The rights box must be ticked; the server checks it too. */
export function MusicUploadDialog({ academyId, open, onOpenChange, onUploaded, defaultMood }: {
  academyId: number; open: boolean; onOpenChange: (o: boolean) => void; onUploaded: (t: MusicTrack) => void; defaultMood?: MusicMood;
}) {
  const copy = useCreativeMusicCopy();
  const upload = useUploadCreativeMusic(academyId);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [mood, setMood] = useState<MusicMood>(defaultMood ?? "hype");
  const [bpm, setBpm] = useState("");
  const [rights, setRights] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null); setTitle(""); setArtist(""); setBpm(""); setRights(false); setError(null); setMood(defaultMood ?? "hype");
  }, [open, defaultMood]);

  const choose = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!EXT.test(f.name)) { setError(copy.wrongType); return; }
    if (f.size > MUSIC_UPLOAD_MAX_BYTES) { setError(copy.tooBig); return; }
    setFile(f);
    if (!title.trim()) setTitle(f.name.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[_-]+/g, " ").trim().slice(0, 80));
  };

  const submit = async () => {
    setError(null);
    if (!file) { setError(copy.wrongType); return; }
    if (!rights) { setError(copy.rightsRequired); return; }
    try {
      const track = await upload.mutateAsync({ file, title: title.trim(), artist: artist.trim(), mood, bpm, rights });
      onUploaded(track);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!upload.isPending) onOpenChange(o); }}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-md overflow-y-auto rounded-2xl border-line bg-void p-5" dir={copy.locale === "ar" ? "rtl" : "ltr"} data-testid="music-upload-dialog">
        <DialogHeader className="text-start">
          <DialogTitle>{copy.uploadTitle}</DialogTitle>
          <DialogDescription>{copy.uploadHint}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <input ref={input} type="file" accept={MUSIC_UPLOAD_ACCEPT} className="hidden" data-testid="music-upload-input"
            onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
          <button type="button" onClick={() => input.current?.click()} data-testid="music-upload-choose"
            className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-dashed border-line bg-surface px-4 text-start hover:border-turf">
            <FileAudio className="h-5 w-5 shrink-0 text-turf" aria-hidden />
            <span className="min-w-0 flex-1">
              <bdi dir="auto" className="block truncate text-sm font-semibold text-text">{file ? file.name : copy.chooseFile}</bdi>
              {file ? <span className="block text-xs text-muted-text">{(file.size / 1024 / 1024).toFixed(1)} MB · {copy.changeFile}</span> : null}
            </span>
          </button>

          <div className="space-y-1.5">
            <Label htmlFor="music-title">{copy.title}</Label>
            <Input id="music-title" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 80))} placeholder={copy.titlePlaceholder} dir="auto" data-testid="music-upload-title" />
          </div>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="music-artist">{copy.artist}</Label>
              <Input id="music-artist" value={artist} onChange={(e) => setArtist(e.target.value.slice(0, 80))} placeholder={copy.artistPlaceholder} dir="auto" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="music-bpm">{copy.bpmLabel}</Label>
              <Input id="music-bpm" value={bpm} onChange={(e) => setBpm(e.target.value.replace(/[^\d]/g, "").slice(0, 3))} placeholder={copy.bpmPlaceholder} inputMode="numeric" dir="ltr" />
            </div>
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-text">{copy.mood}</span>
            <div className="flex flex-wrap gap-1.5">
              {MUSIC_MOODS.map((m) => <Chip key={m} active={mood === m} onClick={() => setMood(m)} testId={`music-upload-mood-${m}`}>{copy.moods[m]}</Chip>)}
            </div>
          </div>

          <div className="space-y-1.5 rounded-xl border border-line bg-surface p-3">
            <div className="flex items-start gap-3">
              <Checkbox id="music-rights" checked={rights} onCheckedChange={(v) => { setRights(v === true); setError(null); }} className="mt-0.5 h-5 w-5" data-testid="music-upload-rights" />
              <Label htmlFor="music-rights" className="text-sm leading-snug text-text">{copy.rights}</Label>
            </div>
            <p className="ps-8 text-xs text-muted-text">{copy.rightsHint}</p>
          </div>

          {error ? <p className="text-sm text-live" role="alert">{error}</p> : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" className="min-h-11 rounded-xl" onClick={() => onOpenChange(false)} disabled={upload.isPending}>{copy.cancel}</Button>
          <Button type="button" className="min-h-11 rounded-xl" onClick={() => void submit()} disabled={!file || !rights || upload.isPending} data-testid="music-upload-save">
            {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
            {upload.isPending ? copy.uploading : copy.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
