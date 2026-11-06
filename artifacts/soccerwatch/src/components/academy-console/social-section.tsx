import { useMemo, useRef, useState } from "react";
import { CalendarClock, Check, EyeOff, Facebook, ImagePlus, Instagram, Loader2, MessageCircle, RefreshCw, Send, Trash2, Upload } from "lucide-react";
import { useSocialCopy } from "@/i18n/social-strings";
import { useAcademyInstagramCopy } from "@/i18n/academy-instagram-strings";
import { AcademyInstagramAutopilot } from "./instagram-autopilot";
import { InstagramUnifiedLogin } from "./instagram-unified-login";
import {
  apiUrl,
  useCommentAction,
  useCreatePost,
  usePostAction,
  useSelectPage,
  useSocialComments,
  useSocialConnect,
  useSocialDisconnect,
  useSocialMedia,
  useSocialOverview,
  useSocialPages,
  useSocialPosts,
  useSocialSync,
  useUploadSocialPhoto,
  type Insights,
  type SocialComment,
  type SocialOverview,
  type SocialPost,
} from "@/lib/academy-social-api";
import { facebookBusinessLogin, resizeImage } from "@/lib/facebook-sdk";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Tab = "overview" | "comments" | "posts" | "autopilot";

const fmtNumber = (locale: string, n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { notation: n >= 10000 ? "compact" : "standard" }).format(n));
const fmtWhen = (locale: string, iso: string) => new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" }).format(new Date(iso));

/** Academy console → Instagram & Facebook. */
export function AcademySocialSection({ academyId, onOpenChat, initialTab }: { academyId: number; onOpenChat?: (threadId: number) => void; initialTab?: Tab }) {
  const copy = useSocialCopy();
  const igCopy = useAcademyInstagramCopy();
  const overview = useSocialOverview(academyId);
  const [tab, setTab] = useState<Tab>(initialTab ?? "overview");
  const connected = overview.data?.connection?.status === "connected";
  return (
    <section className="space-y-5" dir={copy.locale === "ar" ? "rtl" : "ltr"} data-testid="academy-social">
      <header>
        <h1 className="font-display text-4xl font-bold tracking-tight text-text">{copy.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.description}</p>
      </header>
      {overview.isLoading ? <div className="h-48 animate-pulse rounded-2xl bg-raised" />
        : overview.isError ? <p className="text-sm text-red-400" role="alert">{(overview.error as Error).message}</p>
          : (
            <>
              {connected && (
                <div className="flex gap-1.5" role="tablist">
                  {(["overview", "comments", "posts", ...(overview.data!.canManage ? ["autopilot" as const] : [])] as const).map((t) => (
                    <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                      className={cn("min-h-9 rounded-full px-4 text-sm font-semibold", tab === t ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")} data-testid={`social-tab-${t}`}>
                      {t === "autopilot" ? igCopy.tab : copy.tabs[t]}{t === "comments" && overview.data!.openComments > 0 ? ` · ${overview.data!.openComments}` : ""}
                    </button>
                  ))}
                </div>
              )}
              {(!connected || tab === "overview") && <Overview academyId={academyId} data={overview.data!} />}
              {connected && tab === "comments" && <Comments academyId={academyId} onOpenChat={onOpenChat} />}
              {connected && tab === "posts" && <Posts academyId={academyId} canManage={overview.data!.canManage} data={overview.data!} />}
              {connected && tab === "autopilot" && overview.data!.canManage && <AcademyInstagramAutopilot academyId={academyId} />}
            </>
          )}
    </section>
  );
}

// ─── Overview: connect + numbers ────────────────────────────────────────────

function Overview({ academyId, data }: { academyId: number; data: SocialOverview }) {
  const copy = useSocialCopy();
  const connect = useSocialConnect(academyId);
  const select = useSelectPage(academyId);
  const disconnect = useSocialDisconnect(academyId);
  const sync = useSocialSync(academyId);
  const posts = useSocialPosts(academyId);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const c = data.connection;
  const pending = c?.status === "pending";
  const instagramPending = c?.error === "instagram_assets_pending";
  const pages = useSocialPages(academyId, Boolean(pending && data.canManage && !instagramPending));
  const [confirmOff, setConfirmOff] = useState(false);

  const start = async () => {
    setError(null);
    setWorking(true);
    try {
      const code = await facebookBusinessLogin(data.app.appId, data.app.graphVersion, data.app.loginConfigId);
      if (code) await connect.mutateAsync(code);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const best = useMemo(() => {
    const month = Date.now() - 30 * 86400_000;
    const score = (p: SocialPost) => (p.insights.instagram?.views ?? p.insights.instagram?.reach ?? 0) + (p.insights.facebook?.reach ?? 0);
    return (posts.data ?? []).filter((p) => p.status === "published" && p.publishedAt && new Date(p.publishedAt).getTime() > month).sort((a, b) => score(b) - score(a))[0] ?? null;
  }, [posts.data]);

  if (!c || c.status !== "connected") {
    return (
      <div className="rounded-2xl border border-line bg-surface p-6" data-testid="social-connect">
        <div className="flex items-center gap-2 text-turf"><Instagram className="h-6 w-6" aria-hidden="true" /><Facebook className="h-6 w-6" aria-hidden="true" /></div>
        <h2 className="mt-3 font-display text-2xl font-bold text-text">{copy.connect.title}</h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-text">{copy.connect.body}</p>
        {c?.status === "error" && c.error && <p className="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100" role="alert">{c.error}</p>}
        {!data.canManage ? <p className="mt-4 text-sm text-amber-200">{copy.connect.ownerOnly}</p>
          : !data.app.configured ? <p className="mt-4 text-sm text-amber-200">{copy.connect.notReady}</p>
            : pending && !instagramPending && (pages.data?.length ?? 0) > 1 ? (
              <div className="mt-5 space-y-2">
                <p className="text-sm font-semibold text-text">{copy.connect.pickPage}</p>
                {pages.data!.map((p) => (
                  <button key={p.id} type="button" disabled={select.isPending} onClick={() => select.mutate(p.id)}
                    className="flex w-full items-center gap-3 rounded-xl border border-line p-3 text-start hover:bg-raised" data-testid={`social-page-${p.id}`}>
                    <Facebook className="h-5 w-5 text-sky-400" aria-hidden="true" />
                    <span className="flex-1 font-semibold text-text" dir="auto">{p.name}</span>
                    <span className="text-xs text-muted-text">{p.instagram ? `@${p.instagram.username}` : copy.connect.noInstagram}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <Button type="button" onClick={() => void start()} disabled={working || connect.isPending} className="rounded-xl bg-[#1877F2] font-bold text-white hover:bg-[#166fe0]" data-testid="button-social-connect">
                  {working || connect.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Facebook className="me-2 h-4 w-4" aria-hidden="true" />}
                  {working || connect.isPending ? copy.connect.working : copy.connect.button}
                </Button>
                {data.canManage && <InstagramUnifiedLogin academyId={academyId} pending={instagramPending} reconnect={c?.status === "error"} />}
              </div>
            )}
        {(error || connect.isError || select.isError) && <p className="mt-3 text-sm text-red-400" role="alert">{error ?? ((connect.error ?? select.error) as Error).message}</p>}
      </div>
    );
  }

  const ig = c.insights?.instagram ?? {};
  const fb = c.insights?.facebook ?? {};
  const tiles: Array<[string, number | null | undefined]> = [
    [copy.stats.followers, ig.followers],
    [copy.stats.reach, ig.reach],
    [copy.stats.views, ig.views],
    [copy.stats.engaged, ig.accounts_engaged],
    [copy.stats.profileViews, ig.profile_views],
    [copy.stats.unread, data.unreadThreads],
    [copy.stats.openComments, data.openComments],
  ];
  if (c.pageId) tiles.splice(5, 0, [copy.stats.fbFollowers, fb.followers]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4">
        {c.igPicture ? <img src={c.igPicture} alt="" className="h-11 w-11 rounded-full object-cover" /> : <Instagram className="h-9 w-9 text-turf" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-text">{c.pageId
            ? <>{c.igUsername ? `@${c.igUsername}` : copy.connect.noInstagram} · <span dir="auto">{c.pageName}</span></>
            : copy.connect.instagramConnected(c.igUsername ?? "Instagram")}</p>
          <p className="text-xs text-turf"><Check className="me-1 inline h-3.5 w-3.5" aria-hidden="true" />{copy.connect.connected}{c.insightsAt ? ` · ${copy.stats.syncedAt(fmtWhen(copy.locale, c.insightsAt))}` : ""}</p>
        </div>
      {data.canManage && (
          <>
            <Button type="button" variant="ghost" size="sm" className="border border-line" disabled={sync.isPending} onClick={() => sync.mutate()} data-testid="button-social-sync">
              <RefreshCw className={cn("me-1.5 h-4 w-4", sync.isPending && "animate-spin")} aria-hidden="true" />{copy.stats.sync}
            </Button>
            {confirmOff ? (
              <span className="flex items-center gap-2 text-xs text-muted-text">
                {copy.connect.disconnectConfirm}
                <Button type="button" size="sm" className="bg-red-500 text-white" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>{copy.connect.disconnect}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmOff(false)}>✕</Button>
              </span>
            ) : <Button type="button" variant="ghost" size="sm" className="text-muted-text" onClick={() => setConfirmOff(true)}>{copy.connect.disconnect}</Button>}
          </>
        )}
      </div>
      {c.pageId && !c.subscribed && <p className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">{copy.connect.notSubscribed}</p>}
      {c.igUsername && <p className="rounded-xl border border-line bg-raised/60 p-3 text-xs leading-5 text-muted-text">{copy.connect.allowMessages}</p>}
      {sync.isError && <p className="text-sm text-red-400" role="alert">{(sync.error as Error).message}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-line bg-surface p-4">
            <p className="text-xs text-muted-text">{label}</p>
            <p className="mt-1 font-display text-2xl font-bold text-text">{fmtNumber(copy.locale, value)}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-text">{copy.stats.smallAccount}</p>
      {best && (
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm font-bold text-text">{copy.stats.best}</p>
          <div className="mt-3"><PostCard post={best} academyId={academyId} canManage={false} /></div>
        </div>
      )}
    </div>
  );
}

// ─── Comments ───────────────────────────────────────────────────────────────

function Comments({ academyId, onOpenChat }: { academyId: number; onOpenChat?: (threadId: number) => void }) {
  const copy = useSocialCopy();
  const [filter, setFilter] = useState<"open" | "all">("open");
  const comments = useSocialComments(academyId, filter);
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        {(["open", "all"] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className={cn("min-h-8 rounded-full px-3 text-xs font-semibold", filter === f ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{copy.comments[f]}</button>
        ))}
      </div>
      {comments.isLoading ? <div className="h-40 animate-pulse rounded-2xl bg-raised" />
        : (comments.data ?? []).length === 0 ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm text-muted-text">{copy.comments.empty}</p>
          : <ul className="space-y-3">{comments.data!.map((c) => <CommentRow key={c.id} academyId={academyId} comment={c} onOpenChat={onOpenChat} />)}</ul>}
    </div>
  );
}

function CommentRow({ academyId, comment, onOpenChat }: { academyId: number; comment: SocialComment; onOpenChat?: (threadId: number) => void }) {
  const copy = useSocialCopy();
  const action = useCommentAction(academyId);
  const [mode, setMode] = useState<null | "reply" | "private">(null);
  const [text, setText] = useState("");
  const Icon = comment.channel === "instagram" ? Instagram : Facebook;
  const send = () => {
    if (!text.trim() || !mode) return;
    action.mutate({ id: comment.id, action: mode === "reply" ? "reply" : "private-reply", text: text.trim() }, { onSuccess: () => { setMode(null); setText(""); } });
  };
  return (
    <li className="rounded-2xl border border-line bg-surface p-4" data-testid={`social-comment-${comment.id}`}>
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", comment.channel === "instagram" ? "text-pink-400" : "text-sky-400")} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm"><span className="font-semibold text-text" dir="auto">{comment.fromName ?? "—"}</span> <span className="text-xs text-muted-text">· {fmtWhen(copy.locale, comment.createdAt)}</span></p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-text" dir="auto">{comment.body}</p>
          {comment.postCaption && <p className="mt-1 truncate text-xs text-muted-text" dir="auto">↳ {comment.postCaption}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {comment.repliedAt && <span className="rounded-full bg-turf/15 px-2 py-0.5 text-turf">{copy.comments.replied}: <span dir="auto">{comment.replyBody}</span></span>}
            {comment.privateRepliedAt && <span className="rounded-full bg-sky-400/15 px-2 py-0.5 text-sky-300">{copy.comments.sentPrivately}</span>}
            {comment.hidden && <span className="rounded-full bg-raised px-2 py-0.5 text-muted-text">{copy.comments.hidden}</span>}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="ghost" className="border border-line" onClick={() => setMode(mode === "reply" ? null : "reply")}><MessageCircle className="me-1.5 h-4 w-4" aria-hidden="true" />{copy.comments.reply}</Button>
        {comment.canPrivateReply && <Button type="button" size="sm" variant="ghost" className="border border-line" onClick={() => { setMode(mode === "private" ? null : "private"); if (!text) setText(copy.comments.trialTemplate); }}><Send className="me-1.5 h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />{copy.comments.privateReply}</Button>}
        {comment.threadId && onOpenChat && <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChat(comment.threadId!)}>{copy.comments.openChat}</Button>}
        <Button type="button" size="sm" variant="ghost" disabled={action.isPending} onClick={() => action.mutate({ id: comment.id, action: "hide", hidden: !comment.hidden })}><EyeOff className="me-1.5 h-4 w-4" aria-hidden="true" />{comment.hidden ? copy.comments.unhide : copy.comments.hide}</Button>
        {comment.postPermalink && <a href={comment.postPermalink} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center px-2 text-xs text-muted-text hover:text-text">{copy.comments.viewPost}</a>}
        {!comment.read && <Button type="button" size="sm" variant="ghost" className="ms-auto text-muted-text" onClick={() => action.mutate({ id: comment.id, action: "read" })}><Check className="me-1 h-4 w-4" aria-hidden="true" />{copy.comments.markRead}</Button>}
      </div>
      {mode && (
        <div className="mt-3 space-y-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === "reply" ? copy.comments.replyPlaceholder : copy.comments.privatePlaceholder} rows={2} maxLength={1000} dir="auto" />
          {mode === "private" && <p className="text-xs text-muted-text">{copy.comments.privateHint}</p>}
          <Button type="button" size="sm" disabled={!text.trim() || action.isPending} onClick={send} className="bg-floodlight font-bold text-void">
            {action.isPending && <Loader2 className="me-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}{mode === "reply" ? copy.comments.sendReply : copy.comments.sendPrivate}
          </Button>
        </div>
      )}
      {action.isError && <p className="mt-2 text-xs text-red-400" role="alert">{(action.error as Error).message}</p>}
    </li>
  );
}

// ─── Posts ──────────────────────────────────────────────────────────────────

function Metrics({ insights, locale }: { insights: Insights | undefined; locale: string }) {
  const copy = useSocialCopy();
  if (!insights) return null;
  const order = ["views", "reach", "likes", "reactions", "comments", "saved", "shares", "clicks", "replies"];
  const shown = order.filter((k) => insights[k] != null);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {shown.map((k) => <span key={k}><span className="font-bold text-text">{fmtNumber(locale, insights[k])}</span> <span className="text-muted-text">{copy.posts.metrics[k] ?? k}</span></span>)}
    </div>
  );
}

function PostCard({ post, academyId, canManage }: { post: SocialPost; academyId: number; canManage: boolean }) {
  const copy = useSocialCopy();
  const action = usePostAction(academyId);
  const when = post.publishedAt ?? post.scheduledFor;
  return (
    <div className="flex gap-3 rounded-2xl border border-line bg-surface p-3" data-testid={`social-post-${post.id}`}>
      <div className="h-24 w-20 shrink-0 overflow-hidden rounded-xl bg-raised">
        {post.thumbnail && <img src={apiUrl(post.thumbnail)} alt="" className="h-full w-full object-cover" loading="lazy" />}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {post.targets.includes("instagram") && <Instagram className="h-3.5 w-3.5 text-pink-400" aria-label="Instagram" />}
          {post.targets.includes("facebook") && <Facebook className="h-3.5 w-3.5 text-sky-400" aria-label="Facebook" />}
          <span className="text-muted-text">{copy.posts.formats[post.format]}</span>
          <span className={cn("rounded-full px-2 py-0.5 font-semibold", post.status === "published" ? "bg-turf/15 text-turf" : post.status === "failed" ? "bg-red-500/15 text-red-300" : "bg-raised text-muted-text")}>
            {post.source === "synced" ? copy.posts.synced : copy.posts.status[post.status]}
          </span>
          {when && <span className="text-muted-text">{fmtWhen(copy.locale, when)}</span>}
        </div>
        {post.caption && <p className="line-clamp-2 text-sm text-text" dir="auto">{post.caption}</p>}
        <Metrics insights={post.insights.instagram} locale={copy.locale} />
        <Metrics insights={post.insights.facebook} locale={copy.locale} />
        {post.error && <p className="text-xs text-red-400">{post.error}</p>}
        <div className="flex flex-wrap gap-2 text-xs">
          {post.igPermalink && <a href={post.igPermalink} target="_blank" rel="noreferrer" className="text-pink-300 hover:underline">Instagram ↗</a>}
          {post.fbPermalink && <a href={post.fbPermalink} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">Facebook ↗</a>}
          {canManage && post.source === "replay" && (post.status === "failed" || post.status === "partial") && (
            <button type="button" className="font-semibold text-turf" disabled={action.isPending} onClick={() => action.mutate({ id: post.id, action: "publish" })}>{copy.posts.retry}</button>
          )}
          {canManage && post.source === "replay" && ["draft", "scheduled", "failed"].includes(post.status) && (
            <button type="button" className="text-muted-text hover:text-red-300" disabled={action.isPending} onClick={() => action.mutate({ id: post.id, action: "delete" })}><Trash2 className="me-0.5 inline h-3.5 w-3.5" aria-hidden="true" />{copy.posts.remove}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Posts({ academyId, canManage, data }: { academyId: number; canManage: boolean; data: SocialOverview }) {
  const copy = useSocialCopy();
  const posts = useSocialPosts(academyId);
  const [composing, setComposing] = useState(false);
  return (
    <div className="space-y-4">
      {canManage && (composing ? <Composer academyId={academyId} hasInstagram={Boolean(data.connection?.igUserId)} hasFacebook={Boolean(data.connection?.pageId)} onDone={() => setComposing(false)} />
        : <Button type="button" onClick={() => setComposing(true)} className="rounded-xl bg-floodlight font-bold text-void" data-testid="button-new-post"><ImagePlus className="me-2 h-4 w-4" aria-hidden="true" />{copy.posts.newPost}</Button>)}
      {posts.isLoading ? <div className="h-40 animate-pulse rounded-2xl bg-raised" />
        : (posts.data ?? []).length === 0 ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm text-muted-text">{copy.posts.empty}</p>
          : <div className="grid gap-3 lg:grid-cols-2">{posts.data!.map((p) => <PostCard key={p.id} post={p} academyId={academyId} canManage={canManage} />)}</div>}
    </div>
  );
}

function Composer({ academyId, hasInstagram, hasFacebook, onDone }: { academyId: number; hasInstagram: boolean; hasFacebook: boolean; onDone: () => void }) {
  const copy = useSocialCopy();
  const media = useSocialMedia(academyId, true);
  const upload = useUploadSocialPhoto(academyId);
  const create = useCreatePost(academyId);
  const file = useRef<HTMLInputElement>(null);
  const [targets, setTargets] = useState<Array<"instagram" | "facebook">>(hasInstagram ? (hasFacebook ? ["instagram", "facebook"] : ["instagram"]) : (hasFacebook ? ["facebook"] : []));
  const [format, setFormat] = useState<"image" | "carousel" | "reel" | "story">("image");
  const [caption, setCaption] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ready = (media.data ?? []).filter((m) => m.status === "ready" && (format === "reel" ? m.kind === "video" : format === "image" ? m.kind === "image" : true));
  const many = format === "carousel";
  const toggle = (id: number) => setPicked((cur) => (many ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, 10)) : [id]));
  const effectiveTargets = format === "story" ? targets.filter((t) => t === "instagram") : targets;
  const valid = effectiveTargets.length > 0 && (many ? picked.length >= 2 : picked.length === 1) && (!later || Boolean(when));

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const dataUrl = await resizeImage(f, 1440, 0.88);
      const res = await upload.mutateAsync({ dataUrl, name: f.name });
      toggle(res.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submit = () => {
    setError(null);
    create.mutate({
      targets: effectiveTargets,
      format: format === "image" && ready.find((m) => m.id === picked[0])?.kind === "video" ? "video" : format,
      caption,
      mediaIds: picked,
      scheduledFor: later && when ? new Date(when).toISOString() : null,
    }, {
      onSuccess: (r) => { if (r.status === "failed") setError(r.error); else onDone(); },
      onError: (e) => setError((e as Error).message),
    });
  };

  return (
    <div className="space-y-4 rounded-2xl border border-line bg-surface p-5" data-testid="social-composer">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-text">{copy.posts.where}</span>
        {(["instagram", "facebook"] as const).filter((t) => t === "facebook" ? hasFacebook : hasInstagram).map((t) => (
          <button key={t} type="button" onClick={() => setTargets((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))}
            className={cn("inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold", targets.includes(t) ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>
            {t === "instagram" ? <Instagram className="h-3.5 w-3.5" aria-hidden="true" /> : <Facebook className="h-3.5 w-3.5" aria-hidden="true" />}{t === "instagram" ? "Instagram" : "Facebook"}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-text">{copy.posts.format}</span>
        {(["image", "carousel", "reel", "story"] as const).filter((f) => f !== "story" || hasInstagram).map((f) => (
          <button key={f} type="button" onClick={() => { setFormat(f); setPicked([]); }} className={cn("min-h-8 rounded-full px-3 text-xs font-semibold", format === f ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{copy.posts.formats[f]}</button>
        ))}
        {format === "story" && <span className="text-xs text-muted-text">{copy.posts.storyIgOnly}</span>}
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-text">{copy.posts.media} <span className="text-xs font-normal text-muted-text">· {many ? copy.posts.pickMany : copy.posts.pickOne}</span></p>
          {format !== "reel" && (
            <>
              <input ref={file} type="file" accept="image/*" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
              <Button type="button" size="sm" variant="ghost" className="border border-line" disabled={upload.isPending} onClick={() => file.current?.click()}>
                {upload.isPending ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="me-1.5 h-4 w-4" aria-hidden="true" />}{copy.posts.upload}
              </Button>
            </>
          )}
        </div>
        <div className="grid max-h-72 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
          {ready.map((m) => {
            const index = picked.indexOf(m.id);
            return (
              <button key={m.id} type="button" onClick={() => toggle(m.id)} className={cn("relative aspect-square overflow-hidden rounded-xl border-2", index >= 0 ? "border-floodlight" : "border-transparent")} aria-pressed={index >= 0}>
                {m.thumbUrl ? <img src={apiUrl(m.thumbUrl)} alt="" className="h-full w-full object-cover" loading="lazy" /> : <div className="h-full w-full bg-raised" />}
                {m.kind === "video" && <span className="absolute bottom-1 start-1 rounded bg-black/60 px-1 text-[10px] text-white">▶ {m.durationSec ? Math.round(m.durationSec) + "s" : ""}</span>}
                {index >= 0 && <span className="absolute end-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-floodlight text-[10px] font-bold text-void">{many ? index + 1 : "✓"}</span>}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted-text">{copy.posts.libraryHint}</p>
      </div>
      {format !== "story" && (
        <div>
          <p className="mb-1 text-sm font-semibold text-text">{copy.posts.caption}</p>
          <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={copy.posts.captionPlaceholder} rows={4} maxLength={2200} dir="auto" />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-text">{copy.posts.when}</span>
        <button type="button" onClick={() => setLater(false)} className={cn("min-h-8 rounded-full px-3 text-xs font-semibold", !later ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{copy.posts.now}</button>
        <button type="button" onClick={() => setLater(true)} className={cn("min-h-8 rounded-full px-3 text-xs font-semibold", later ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}><CalendarClock className="me-1 inline h-3.5 w-3.5" aria-hidden="true" />{copy.posts.later}</button>
        {later && <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="w-auto" />}
      </div>
      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" disabled={!valid || create.isPending} onClick={submit} className="rounded-xl bg-floodlight font-bold text-void" data-testid="button-publish-post">
          {create.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {create.isPending ? copy.posts.publishing : later ? copy.posts.schedule : copy.posts.publish}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>✕</Button>
      </div>
    </div>
  );
}
