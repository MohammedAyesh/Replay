import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  BarChart3, Check, FileText, Film, Image as ImageIcon, Loader2, MapPin, Mic, Paperclip, Plus, Search, Send, Trash2, UserRoundCheck, Users, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useChatNativeCopy } from "@/i18n/chat-native-strings";
import { useAcademyProfile } from "@/lib/academy-profile-api";
import { parseLocation } from "@/lib/chat-location";
import {
  MAX_CHAT_FILE_BYTES,
  checkChatNumber,
  pickGif,
  uploadChatFile,
  useAssignChat,
  useChatAssignees,
  useContacts,
  useCreateGroup,
  useFollowGroup,
  useGifSearch,
  usePhoneGroups,
  useSendChat,
  useWhatsappOverview,
  type ChatContent,
  type MediaRef,
  type OutgoingContent,
} from "@/lib/academy-whatsapp-api";

// ─── Showing a message ───────────────────────────────────────────────────────

function mapsLink(lat: number, lng: number) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function fileSize(bytes: number | null) {
  if (!bytes) return "";
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A photo, video, GIF, voice note, file, location or poll inside a chat bubble. */
export function ChatContentView({ content, body }: { content: ChatContent; body: string }) {
  const copy = useChatNativeCopy();
  const caption = "caption" in content && content.caption ? content.caption : null;
  if ("media" in content && !content.media.url) {
    return (
      <p className="flex items-center gap-2 text-sm italic text-muted-text">
        {content.media.pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileText className="h-4 w-4" aria-hidden="true" />}
        {content.media.pending ? copy.fileLoading : `${body} · ${copy.fileUnavailable}`}
      </p>
    );
  }
  switch (content.type) {
    case "image":
      return (
        <figure className="space-y-1.5">
          <a href={content.media.url!} target="_blank" rel="noreferrer">
            <img src={content.media.url!} alt="" loading="lazy" className="max-h-80 w-full max-w-xs rounded-xl object-cover" />
          </a>
          {caption && <figcaption dir="auto" className="whitespace-pre-wrap break-words leading-6">{caption}</figcaption>}
        </figure>
      );
    case "sticker":
      return <img src={content.media.url!} alt="" loading="lazy" className="h-32 w-32 object-contain" />;
    case "video":
      return (
        <figure className="space-y-1.5">
          {content.gif
            ? <video src={content.media.url!} autoPlay loop muted playsInline className="max-h-72 w-full max-w-xs rounded-xl" />
            : <video src={content.media.url!} controls preload="metadata" playsInline className="max-h-80 w-full max-w-xs rounded-xl bg-black" />}
          {content.gif && <span className="inline-block rounded bg-black/40 px-1.5 text-[10px] font-bold text-white">GIF</span>}
          {caption && <figcaption dir="auto" className="whitespace-pre-wrap break-words leading-6">{caption}</figcaption>}
        </figure>
      );
    case "audio":
      return (
        <div className="flex items-center gap-2">
          {content.voice && <Mic className="h-4 w-4 shrink-0 text-turf" aria-label={copy.voice} />}
          <audio src={content.media.url!} controls preload="metadata" className="h-10 max-w-[16rem]" />
        </div>
      );
    case "document":
      return (
        <div className="space-y-1.5">
          <a href={content.media.url!} target="_blank" rel="noreferrer" download={content.media.filename ?? undefined}
            className="flex items-center gap-3 rounded-xl border border-line bg-surface/60 p-2.5 hover:bg-surface">
            <FileText className="h-8 w-8 shrink-0 text-floodlight" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold" dir="auto">{content.media.filename || copy.document}</span>
              <span className="text-[11px] text-muted-text">{[fileSize(content.media.size), content.media.mimetype.split("/").pop()?.toUpperCase()].filter(Boolean).join(" · ")}</span>
            </span>
          </a>
          {caption && <p dir="auto" className="whitespace-pre-wrap break-words leading-6">{caption}</p>}
        </div>
      );
    case "location":
      return (
        <a href={mapsLink(content.latitude, content.longitude)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-line bg-surface/60 hover:bg-surface">
          <span className="flex h-24 items-center justify-center bg-[radial-gradient(circle,rgba(47,216,196,0.18),transparent_70%)]">
            <MapPin className="h-8 w-8 text-red-400" aria-hidden="true" />
          </span>
          <span className="block p-2.5">
            <span className="block text-sm font-semibold" dir="auto">{content.name || copy.location}</span>
            {content.address && <span className="block text-xs text-muted-text" dir="auto">{content.address}</span>}
            <span className="mt-0.5 block text-xs text-floodlight">{copy.openInMaps}</span>
          </span>
        </a>
      );
    case "poll": {
      const max = Math.max(1, ...content.tally.map((t) => t.count));
      return (
        <div className="min-w-[14rem] space-y-2" data-testid="chat-poll">
          <p className="flex items-start gap-1.5 font-semibold" dir="auto"><BarChart3 className="mt-1 h-4 w-4 shrink-0 text-turf" aria-hidden="true" />{content.name}</p>
          <ul className="space-y-1.5">
            {content.tally.map((t) => (
              <li key={t.option} title={t.voters.join(", ")}>
                <span className="flex items-baseline justify-between gap-2 text-sm"><span dir="auto">{t.option}</span><span className="text-xs text-muted-text">{t.count}</span></span>
                <span className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-surface"><span className="block h-full rounded-full bg-turf" style={{ width: `${(t.count / max) * 100}%` }} /></span>
                {t.voters.length > 0 && <span className="block truncate text-[11px] text-muted-text" dir="auto">{t.voters.join("، ")}</span>}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-text">{content.voters > 0 ? copy.voters(content.voters) : copy.noVotes}</p>
        </div>
      );
    }
  }
}

// ─── Composing ───────────────────────────────────────────────────────────────

type Attachment = { media: MediaRef; kind: "image" | "video" | "document" | "gif"; previewUrl: string | null; name: string };

function kindForFile(file: File): Attachment["kind"] {
  if (file.type === "image/gif") return "gif";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return "document";
}

function recorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
}

/**
 * The bottom of a WhatsApp chat: text, files (photo, video, document), GIFs, voice notes,
 * locations and polls. Text typed while a file is attached becomes its caption.
 */
export function ChatComposer({ academyId, phone, placeholder, disabled }: { academyId: number; phone: string; placeholder: string; disabled?: boolean }) {
  const copy = useChatNativeCopy();
  const send = useSendChat(academyId, phone);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "location" | "poll" | "gif">(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => { setDraft(""); setAttachment(null); setError(null); }, [phone]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  const deliver = (message: string | OutgoingContent, after?: () => void) => {
    setError(null);
    send.mutate(message, { onSuccess: () => after?.(), onError: (err) => setError((err as Error).message) });
  };

  const upload = async (file: File | Blob, name: string) => {
    if (file.size > MAX_CHAT_FILE_BYTES) {
      setError(copy.tooBig);
      return null;
    }
    setUploading(true);
    setError(null);
    try {
      return await uploadChatFile(academyId, file, name);
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setUploading(false);
    }
  };

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    const kind = kindForFile(file);
    const result = await upload(file, file.name);
    if (!result) return;
    setAttachment({ media: result.media, kind: result.gif ? "gif" : kind, previewUrl: kind === "document" ? null : URL.createObjectURL(file), name: file.name });
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (attachment) {
      const caption = text || null;
      const content: OutgoingContent = attachment.kind === "image" ? { type: "image", media: attachment.media, caption }
        : attachment.kind === "video" ? { type: "video", media: attachment.media, caption }
        : attachment.kind === "gif" ? { type: "video", media: attachment.media, caption, gif: true }
        : { type: "document", media: attachment.media, caption };
      deliver(content, () => { setDraft(""); setAttachment(null); });
      return;
    }
    if (!text) return;
    deliver(text, () => setDraft(""));
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = recorderMime();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      rec.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.current.push(ev.data); };
      recorder.current = rec;
      rec.start();
      setSeconds(0);
      setRecording(true);
    } catch {
      setError(copy.micBlocked);
    }
  };

  const stopRecording = (sendIt: boolean) => {
    const rec = recorder.current;
    if (!rec) return;
    rec.onstop = async () => {
      rec.stream.getTracks().forEach((t) => t.stop());
      recorder.current = null;
      setRecording(false);
      if (!sendIt || chunks.current.length === 0) return;
      const type = rec.mimeType || "audio/webm";
      const blob = new Blob(chunks.current, { type: type.split(";")[0] });
      const result = await upload(blob, `voice.${type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm"}`);
      if (result) deliver({ type: "audio", media: result.media, voice: true });
    };
    rec.stop();
  };

  const busy = send.isPending || uploading;

  return (
    <div className="border-t border-line">
      {attachment && (
        <div className="flex items-center gap-3 border-b border-line bg-raised/40 px-3 py-2" data-testid="chat-attachment">
          {attachment.previewUrl && (attachment.kind === "image"
            ? <img src={attachment.previewUrl} alt="" className="h-14 w-14 rounded-lg object-cover" />
            : <video src={attachment.previewUrl} muted autoPlay={attachment.kind === "gif"} loop className="h-14 w-14 rounded-lg object-cover" />)}
          {!attachment.previewUrl && <FileText className="h-8 w-8 text-floodlight" aria-hidden="true" />}
          <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{attachment.kind === "gif" ? "GIF" : attachment.name}</span>
          <Button type="button" variant="ghost" size="icon" onClick={() => setAttachment(null)} aria-label={copy.cancel}><X className="h-4 w-4" aria-hidden="true" /></Button>
        </div>
      )}
      {recording ? (
        <div className="flex items-center gap-3 p-3" data-testid="chat-recording">
          <Button type="button" variant="ghost" size="icon" onClick={() => stopRecording(false)} aria-label={copy.cancel}><Trash2 className="h-4 w-4 text-red-400" aria-hidden="true" /></Button>
          <span className="flex flex-1 items-center gap-2 text-sm text-text">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
            {copy.recording} {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          </span>
          <Button type="button" onClick={() => stopRecording(true)} className="h-11 w-11 shrink-0 rounded-full bg-floodlight p-0 text-void" aria-label={copy.stopAndSend}>
            <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex items-end gap-2 p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 rounded-full" disabled={disabled || busy} aria-label={copy.attach} data-testid="button-chat-attach">
                {uploading ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Paperclip className="h-5 w-5" aria-hidden="true" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="min-w-44">
              <DropdownMenuItem onSelect={() => mediaInput.current?.click()}><ImageIcon className="me-2 h-4 w-4 text-sky-300" aria-hidden="true" />{copy.photoVideo}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => docInput.current?.click()}><FileText className="me-2 h-4 w-4 text-violet-300" aria-hidden="true" />{copy.document}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("gif")}><Film className="me-2 h-4 w-4 text-pink-300" aria-hidden="true" />{copy.gif}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("location")}><MapPin className="me-2 h-4 w-4 text-red-300" aria-hidden="true" />{copy.location}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("poll")} data-testid="menu-chat-poll"><BarChart3 className="me-2 h-4 w-4 text-amber-300" aria-hidden="true" />{copy.poll}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input ref={mediaInput} type="file" accept="image/*,video/*" className="hidden" onChange={(e) => { void onPick(e.target.files?.[0]); e.target.value = ""; }} />
          <input ref={docInput} type="file" className="hidden" onChange={(e) => { void onPick(e.target.files?.[0]); e.target.value = ""; }} />
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder={attachment ? copy.captionPlaceholder : placeholder}
            rows={1}
            dir="auto"
            disabled={disabled}
            className="max-h-40 min-h-11 resize-none"
            data-testid="input-chat-message"
          />
          {draft.trim() || attachment ? (
            <Button type="submit" disabled={busy || disabled} className="h-11 w-11 shrink-0 rounded-full bg-floodlight p-0 text-void" aria-label={copy.send} data-testid="button-chat-send">
              {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />}
            </Button>
          ) : (
            <Button type="button" onClick={() => void startRecording()} disabled={busy || disabled || typeof MediaRecorder === "undefined"} className="h-11 w-11 shrink-0 rounded-full bg-floodlight p-0 text-void" aria-label={copy.voice} data-testid="button-chat-voice">
              <Mic className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </form>
      )}
      {error && <p className="px-3 pb-2 text-xs text-red-400" role="alert">{error}</p>}
      <LocationDialog academyId={academyId} open={dialog === "location"} onOpenChange={(o) => setDialog(o ? "location" : null)}
        onSend={(loc) => deliver({ type: "location", ...loc }, () => setDialog(null))} pending={send.isPending} />
      <PollDialog open={dialog === "poll"} onOpenChange={(o) => setDialog(o ? "poll" : null)}
        onSend={(poll) => deliver({ type: "poll", ...poll }, () => setDialog(null))} pending={send.isPending} />
      <GifDialog academyId={academyId} open={dialog === "gif"} onOpenChange={(o) => setDialog(o ? "gif" : null)}
        upload={(file) => upload(file, file.name)}
        onSend={(media) => deliver({ type: "video", media, gif: true, caption: draft.trim() || null }, () => { setDialog(null); setDraft(""); })} pending={send.isPending} />
    </div>
  );
}

function LocationDialog({ academyId, open, onOpenChange, onSend, pending }: {
  academyId: number; open: boolean; onOpenChange: (open: boolean) => void; pending: boolean;
  onSend: (location: { latitude: number; longitude: number; name: string | null }) => void;
}) {
  const copy = useChatNativeCopy();
  const profile = useAcademyProfile(academyId);
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pitch = useMemo(() => {
    const p = profile.data;
    if (!p) return null;
    if (p.latitude != null && p.longitude != null) return { latitude: p.latitude, longitude: p.longitude, name: p.field?.name ?? p.name };
    if (p.field?.latitude != null && p.field?.longitude != null) return { latitude: p.field.latitude, longitude: p.field.longitude, name: p.field.name };
    return null;
  }, [profile.data]);
  useEffect(() => { if (open) { setLink(""); setName(""); setError(null); } }, [open]);

  const mine = () => {
    if (!navigator.geolocation) return setError(copy.locationFailed);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); onSend({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, name: name.trim() || null }); },
      () => { setLocating(false); setError(copy.locationFailed); },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };
  const fromLink = () => {
    const parsed = parseLocation(link);
    if (!parsed) return setError(copy.badLink);
    onSend({ ...parsed, name: name.trim() || null });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-line bg-surface text-text" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <DialogHeader className="text-start"><DialogTitle>{copy.locationTitle}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {pitch && (
            <Button type="button" variant="outline" className="w-full justify-start" disabled={pending} onClick={() => onSend({ latitude: pitch.latitude, longitude: pitch.longitude, name: name.trim() || pitch.name })}>
              <MapPin className="me-2 h-4 w-4 text-red-300" aria-hidden="true" />{copy.academyPitch}<span className="ms-auto truncate text-xs text-muted-text" dir="auto">{pitch.name}</span>
            </Button>
          )}
          <Button type="button" variant="outline" className="w-full justify-start" disabled={pending || locating} onClick={mine}>
            {locating ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <MapPin className="me-2 h-4 w-4 text-sky-300" aria-hidden="true" />}
            {locating ? copy.locating : copy.myLocation}
          </Button>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-text">{copy.pasteLink}</p>
            <div className="flex gap-2">
              <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder={copy.pastePlaceholder} dir="ltr" />
              <Button type="button" disabled={!link.trim() || pending} onClick={fromLink}>{copy.send}</Button>
            </div>
          </div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={copy.placeName} maxLength={200} dir="auto" />
          {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PollDialog({ open, onOpenChange, onSend, pending }: {
  open: boolean; onOpenChange: (open: boolean) => void; pending: boolean;
  onSend: (poll: { name: string; options: string[]; multipleAnswers: boolean }) => void;
}) {
  const copy = useChatNativeCopy();
  const [name, setName] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  useEffect(() => { if (open) { setName(""); setOptions(["", ""]); setMultiple(false); } }, [open]);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const unique = new Set(filled.map((o) => o.toLocaleLowerCase())).size === filled.length;
  const valid = name.trim().length > 0 && filled.length >= 2 && unique;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-line bg-surface text-text" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <DialogHeader className="text-start">
          <DialogTitle>{copy.pollTitle}</DialogTitle>
          <DialogDescription className="text-start">{copy.pollNote}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) onSend({ name: name.trim(), options: filled, multipleAnswers: multiple }); }}>
          <label className="block space-y-1 text-sm font-semibold">
            {copy.question}
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={copy.questionPlaceholder} maxLength={255} dir="auto" data-testid="input-poll-question" />
          </label>
          {options.map((option, i) => (
            <div key={i} className="flex gap-2">
              <Input value={option} onChange={(e) => setOptions((all) => all.map((o, j) => (j === i ? e.target.value : o)))} placeholder={copy.option(i + 1)} maxLength={100} dir="auto" data-testid={`input-poll-option-${i}`} />
              {options.length > 2 && <Button type="button" variant="ghost" size="icon" onClick={() => setOptions((all) => all.filter((_, j) => j !== i))} aria-label={copy.cancel}><X className="h-4 w-4" aria-hidden="true" /></Button>}
            </div>
          ))}
          {options.length < 12 && <Button type="button" variant="ghost" size="sm" onClick={() => setOptions((all) => [...all, ""])}><Plus className="me-1 h-4 w-4" aria-hidden="true" />{copy.addOption}</Button>}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} className="h-4 w-4 accent-[var(--turf,#2fd8c4)]" />
            {copy.multiple}
          </label>
          <DialogFooter>
            <Button type="submit" disabled={!valid || pending} className="bg-floodlight font-bold text-void" data-testid="button-poll-send">
              {pending && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}{copy.send}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GifDialog({ academyId, open, onOpenChange, onSend, upload, pending }: {
  academyId: number; open: boolean; onOpenChange: (open: boolean) => void; pending: boolean;
  onSend: (media: MediaRef) => void;
  upload: (file: File) => Promise<{ media: MediaRef; gif: boolean } | null>;
}) {
  const copy = useChatNativeCopy();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useGifSearch(academyId, query, open);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);
  const choose = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const picked = await pickGif(academyId, id);
      onSend(picked.media);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const fromFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy("upload");
    const result = await upload(file);
    setBusy(null);
    if (result) onSend(result.media);
  };
  const enabled = search.data?.enabled === true;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-line bg-surface text-text sm:max-w-xl" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <DialogHeader className="text-start"><DialogTitle>{copy.gifTitle}</DialogTitle></DialogHeader>
        {enabled && (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" aria-hidden="true" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={copy.gifSearch} className="ps-9" />
            </div>
            <div className="grid max-h-80 grid-cols-3 gap-2 overflow-y-auto">
              {search.isLoading && [0, 1, 2, 3, 4, 5].map((n) => <div key={n} className="aspect-square animate-pulse rounded-lg bg-raised" />)}
              {(search.data?.results ?? []).map((g) => (
                <button key={g.id} type="button" disabled={Boolean(busy) || pending} onClick={() => void choose(g.id)} className="relative overflow-hidden rounded-lg bg-raised" title={g.title}>
                  <video src={g.preview ?? undefined} poster={g.still ?? undefined} autoPlay loop muted playsInline className="aspect-square w-full object-cover" />
                  {busy === g.id && <span className="absolute inset-0 grid place-items-center bg-black/50"><Loader2 className="h-5 w-5 animate-spin text-white" aria-hidden="true" /></span>}
                </button>
              ))}
            </div>
            <p className="text-end text-[10px] text-muted-text">{copy.poweredByGiphy}</p>
          </>
        )}
        <div className="space-y-1.5">
          {!enabled && <p className="text-sm text-muted-text">{copy.gifUploadHint}</p>}
          <Button type="button" variant="outline" disabled={Boolean(busy) || pending} onClick={() => input.current?.click()}>
            {busy === "upload" ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Film className="me-2 h-4 w-4" aria-hidden="true" />}{copy.gifUpload}
          </Button>
          <input ref={input} type="file" accept="image/gif" className="hidden" onChange={(e) => { void fromFile(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

// ─── Starting chats and groups ───────────────────────────────────────────────

export function NewChatDialog({ academyId, open, onOpenChange, onOpen }: { academyId: number; open: boolean; onOpenChange: (open: boolean) => void; onOpen: (phone: string) => void }) {
  const copy = useChatNativeCopy();
  const contacts = useContacts(academyId);
  const [q, setQ] = useState("");
  const [number, setNumber] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setQ(""); setNumber(""); setError(null); } }, [open]);
  const matches = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return (contacts.data ?? []).filter((c) => !needle || [c.name, c.display, c.phone, ...c.players.map((p) => p.playerName)].join(" ").toLocaleLowerCase().includes(needle)).slice(0, 50);
  }, [contacts.data, q]);
  const start = async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await checkChatNumber(academyId, number);
      if (result.onWhatsapp === false) setError(copy.notOnWhatsapp);
      else onOpen(result.phone);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-line bg-surface text-text" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <DialogHeader className="text-start">
          <DialogTitle>{copy.newChatTitle}</DialogTitle>
          <DialogDescription className="text-start">{copy.newChatBody}</DialogDescription>
        </DialogHeader>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (number.trim()) void start(); }}>
          <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder={copy.numberPlaceholder} inputMode="tel" dir="ltr" data-testid="input-new-chat-number" />
          <Button type="submit" disabled={!number.trim() || checking}>{checking ? copy.checking : copy.start}</Button>
        </form>
        {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={copy.searchPeople} className="ps-9" />
        </div>
        <ul className="max-h-72 divide-y divide-line overflow-y-auto">
          {matches.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onOpen(c.phone)} className="flex w-full items-center gap-2 px-1 py-2.5 text-start hover:bg-raised">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold" dir="auto">{c.name || c.display}</span>
                  <span className="block truncate text-xs text-muted-text" dir="auto">{[c.display, ...c.players.map((p) => p.playerName)].join(" · ")}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export function NewGroupDialog({ academyId, open, onOpenChange, onCreated }: { academyId: number; open: boolean; onOpenChange: (open: boolean) => void; onCreated: (phone: string) => void }) {
  const copy = useChatNativeCopy();
  const overview = useWhatsappOverview(academyId);
  const contacts = useContacts(academyId);
  const create = useCreateGroup(academyId);
  const [subject, setSubject] = useState("");
  const [squadIds, setSquadIds] = useState<number[]>([]);
  const [contactIds, setContactIds] = useState<number[]>([]);
  const [numbers, setNumbers] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { if (open) { setSubject(""); setSquadIds([]); setContactIds([]); setNumbers(""); setQ(""); create.reset(); } }, [open]);
  const squads = overview.data?.squads ?? [];
  const matches = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return (contacts.data ?? []).filter((c) => !needle || [c.name, c.display, ...c.players.map((p) => p.playerName)].join(" ").toLocaleLowerCase().includes(needle)).slice(0, 60);
  }, [contacts.data, q]);
  const phones = numbers.split(/[\n,]+/).map((n) => n.trim()).filter(Boolean);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const valid = subject.trim() && (squadIds.length > 0 || contactIds.length > 0 || phones.length > 0);
  const submit = () => create.mutate({
    subject: subject.trim(),
    contactIds: contactIds.length ? contactIds : undefined,
    phones: phones.length ? phones : undefined,
    audience: squadIds.length ? { roles: ["parents"], squadIds, playerIds: null } : undefined,
  }, { onSuccess: (r) => onCreated(r.phone) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-line bg-surface text-text sm:max-w-lg" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <DialogHeader className="text-start">
          <DialogTitle>{copy.groupTitle}</DialogTitle>
          <DialogDescription className="text-start">{copy.groupBody}</DialogDescription>
        </DialogHeader>
        <label className="block space-y-1 text-sm font-semibold">
          {copy.groupName}
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={copy.groupNamePlaceholder} maxLength={100} dir="auto" data-testid="input-group-name" />
        </label>
        {squads.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-semibold">{copy.addSquads}</p>
            <div className="flex flex-wrap gap-1.5">
              {squads.map((s) => (
                <button key={s.id} type="button" onClick={() => setSquadIds((ids) => toggle(ids, s.id))}
                  className={cn("min-h-8 rounded-full px-3 text-xs font-semibold", squadIds.includes(s.id) ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>
                  {squadIds.includes(s.id) && <Check className="me-1 inline h-3 w-3" aria-hidden="true" />}{s.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">{copy.addPeople}{contactIds.length ? ` · ${copy.members(contactIds.length)}` : ""}</p>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={copy.searchPeople} />
          <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {matches.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2 px-2.5 py-2 hover:bg-raised">
                  <input type="checkbox" checked={contactIds.includes(c.id)} onChange={() => setContactIds((ids) => toggle(ids, c.id))} className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{c.name || c.display}</span>
                  <span className="text-xs text-muted-text" dir="ltr">{c.display}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <label className="block space-y-1 text-sm font-semibold">
          {copy.addNumbers}
          <Textarea value={numbers} onChange={(e) => setNumbers(e.target.value)} placeholder={copy.numbersPlaceholder} rows={2} dir="ltr" />
        </label>
        {create.isError && <p className="text-xs text-red-400" role="alert">{(create.error as Error).message}</p>}
        <DialogFooter>
          <Button type="button" disabled={!valid || create.isPending} onClick={submit} className="bg-floodlight font-bold text-void" data-testid="button-group-create">
            {create.isPending ? <><Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />{copy.creating}</> : <><Users className="me-2 h-4 w-4" aria-hidden="true" />{copy.createGroup}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The owner picks which of the phone's groups appear in Chats. */
export function FollowGroupsSheet({ academyId, open, onOpenChange, onOpen }: { academyId: number; open: boolean; onOpenChange: (open: boolean) => void; onOpen: (phone: string) => void }) {
  const copy = useChatNativeCopy();
  const groups = usePhoneGroups(academyId, open);
  const follow = useFollowGroup(academyId);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={copy.locale === "ar" ? "left" : "right"} className="w-full overflow-y-auto border-line bg-surface text-text sm:max-w-md" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <SheetHeader className="px-8 text-start">
          <SheetTitle>{copy.followTitle}</SheetTitle>
          <SheetDescription className="text-start">{copy.followBody}</SheetDescription>
        </SheetHeader>
        <div className="mt-4 px-4">
          {groups.isLoading && <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-text" aria-hidden="true" />}
          {groups.isError && <p className="text-sm text-muted-text">{(groups.error as Error).message || copy.ownNumberOnly}</p>}
          <ul className="divide-y divide-line">
            {(groups.data ?? []).map((g) => (
              <li key={g.id} className="flex items-center gap-2 py-3">
                <Users className="h-4 w-4 shrink-0 text-muted-text" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold" dir="auto">{g.subject}</span>
                  {g.participants != null && <span className="text-xs text-muted-text">{copy.members(g.participants)}</span>}
                </span>
                {g.followed
                  ? <span className="text-xs text-turf">{copy.following}</span>
                  : <Button type="button" size="sm" variant="outline" disabled={follow.isPending}
                      onClick={() => follow.mutate({ groupId: g.id, subject: g.subject }, { onSuccess: (r) => onOpen(r.phone) })}>{copy.follow}</Button>}
              </li>
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Assigning ───────────────────────────────────────────────────────────────

/** "Hand this chat to…": anyone on the team, or nobody. */
export function AssignMenu({ academyId, assignedUserId, onAssign, pending }: { academyId: number; assignedUserId: number | null; onAssign: (userId: number | null) => void; pending?: boolean }) {
  const copy = useChatNativeCopy();
  const team = useChatAssignees(academyId);
  const current = (team.data ?? []).find((m) => m.id === assignedUserId) ?? null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={pending} className={cn("max-w-[10rem] gap-1.5", current ? "text-turf" : "text-muted-text")} data-testid="button-chat-assign">
          <UserRoundCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{current ? current.name : copy.assign}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel>{copy.assignTo}</DropdownMenuLabel>
        {(team.data ?? []).map((m) => (
          <DropdownMenuItem key={m.id} onSelect={() => onAssign(m.id)}>
            <span className="flex-1 truncate">{m.name}</span>
            <span className="ms-2 text-[11px] text-muted-text">{copy.roles[m.role] ?? m.role}</span>
            {m.id === assignedUserId && <Check className="ms-2 h-4 w-4 text-turf" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onAssign(null)}>{copy.unassigned}{assignedUserId === null && <Check className="ms-auto h-4 w-4 text-turf" aria-hidden="true" />}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Assign for a WhatsApp chat or group. */
export function WhatsappAssign({ academyId, phone, assignedUserId }: { academyId: number; phone: string; assignedUserId: number | null }) {
  const assign = useAssignChat(academyId);
  return <AssignMenu academyId={academyId} assignedUserId={assignedUserId} pending={assign.isPending} onAssign={(userId) => assign.mutate({ phone, userId })} />;
}

export function AssigneeBadge({ academyId, userId }: { academyId: number; userId: number | null | undefined }) {
  const team = useChatAssignees(academyId);
  const member = userId ? (team.data ?? []).find((m) => m.id === userId) : null;
  if (!member) return null;
  return (
    <span className="inline-flex max-w-[7rem] items-center gap-0.5 truncate rounded-full bg-turf/10 px-1.5 py-0.5 text-[10px] font-semibold text-turf">
      <UserRoundCheck className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />{member.name.split(" ")[0]}
    </span>
  );
}

