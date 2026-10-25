"""
End screen for Method B (vps1) -- the same end screen the app draws, laid over
the last seconds of a finished render.

The app draws the card itself (crest, names, stats, QR) with the code its own
exports use, encodes it as a short VP9 video with an alpha channel and uploads
it to Bunny Storage; the job spec carries its URL. This module only does what
needs the clip:

  1. the render forces a keyframe where the card starts (start_for());
  2. the head is stream-copied up to that keyframe with the segment muxer;
  3. the tail is re-encoded: blurred (quarter-size gblur faded in over the sharp
     frame), the card laid on top, the clip's sound ducked to 30%;
  4. head + tail are joined with the concat demuxer.

A clip too short to cover gets the card after its last frame instead (the last
frame is held). Every failure raises; render.py catches it and keeps the plain
clip, because branding must never cost a clip.

Kept in step with artifacts/api-server/src/lib/clipBranding/endScreenVideo.ts.
Added 2026-10-25.
"""
import os
import subprocess
import urllib.parse

FPS = 30
MIN_OVERLAP_CLIP_SECONDS = 6.0
RAMP = 0.4
MAX_CARD_BYTES = 25 * 1024 * 1024
# The same encode as render.py's main pass, so the concat demuxer can join the
# copied head and the re-encoded tail without a second encode of the clip.
VIDEO_ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(FPS)]
AUDIO_ENC = ["-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"]


def validate(raw):
    """The spec's endScreen, cleaned, or None. Never raises."""
    if not isinstance(raw, dict):
        return None
    url = raw.get("cardUrl")
    if not isinstance(url, str):
        return None
    try:
        u = urllib.parse.urlparse(url)
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    bunny = u.scheme == "https" and (host.endswith("storage.bunnycdn.com") or host.endswith(".b-cdn.net"))
    # The off-box test (render.py's CLIP_EXPORT_TEST_ROOT) serves its card locally.
    local_test = bool(os.environ.get("CLIP_EXPORT_TEST_ROOT")) and u.scheme == "http" and host == "127.0.0.1"
    if not (bunny or local_test):
        return None

    def num(key, lo, hi, default):
        v = raw.get(key)
        try:
            v = float(v)
        except (TypeError, ValueError):
            return default
        return max(lo, min(hi, v)) if v == v else default

    return {
        "cardUrl": url,
        "seconds": num("seconds", 2.0, 6.0, 3.0),
        "blur": num("blur", 0.0, 40.0, 22.0),
        "dim": num("dim", 0.0, 0.9, 0.5),
        "kind": str(raw.get("kind") or "")[:20],
    }


def start_for(clip_dur, seconds):
    """Where the card begins inside the clip, or None when it is appended."""
    if clip_dur < max(MIN_OVERLAP_CLIP_SECONDS, seconds + 3):
        return None
    # Whole frames, so the forced keyframe and the cut land on the same frame.
    return round((clip_dur - seconds) * FPS) / FPS


def fetch_card(url, dest, http_get, storage_key):
    headers = {}
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if host.endswith("storage.bunnycdn.com") and storage_key:
        headers["AccessKey"] = storage_key
    # No Stream Referer: Bunny Storage answers 401 to the iframe Referer.
    data = http_get(url, headers=headers, timeout=30, referer=False)
    if not data or len(data) > MAX_CARD_BYTES:
        raise RuntimeError("card is %d bytes" % len(data or b""))
    with open(dest, "wb") as f:
        f.write(data)
    return dest


def _run(ffmpeg, args, timeout=300):
    r = subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-y", *args],
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed: %s" % r.stderr.strip()[-400:])


def _duration(ffprobe, path):
    r = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True, timeout=60)
    try:
        return float(r.stdout.strip().splitlines()[0])
    except (ValueError, IndexError):
        raise RuntimeError("could not probe %s: %s" % (path, r.stderr.strip()[-200:]))


def _render_tail(ffmpeg, main, card, out, es, start, appended, out_w, out_h):
    portrait = out_h > out_w
    scale = out_w / (1080.0 if portrait else 1920.0)
    sigma = max(0.5, es["blur"] * scale)
    s = "%.3f" % es["seconds"]
    seek = max(0.0, start - 0.1) if appended else start
    if appended:
        # The last frame, held for the whole card.
        video_in = ("[0:v]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=%s,"
                    "trim=duration=%s,setpts=PTS-STARTPTS" % (s, s))
        audio = "[2:a]atrim=duration=%s,asetpts=PTS-STARTPTS[a]" % s
    else:
        video_in = "[0:v]setpts=PTS-STARTPTS,trim=duration=%s,setpts=PTS-STARTPTS" % s
        # The clip's sound carries on, ducked to 30% as the card lands.
        audio = ("[0:a]asetpts=PTS-STARTPTS,atrim=duration=%s,"
                 "volume='if(lt(t,%s),1-0.7*t/%s,0.3)':eval=frame[a]" % (s, RAMP, RAMP))
    graph = ";".join([
        "%s,fps=%d,format=yuv420p,split=2[sharp][toblur]" % (video_in, FPS),
        "[toblur]scale=trunc(iw/8)*2:trunc(ih/8)*2,gblur=sigma=%.2f,scale=%d:%d:flags=bilinear,"
        "format=yuva420p,fade=t=in:st=0:d=%s:alpha=1[blurred]" % (sigma / 4, out_w, out_h, RAMP),
        "[sharp][blurred]overlay=0:0[bg]",
        # The card is drawn at the export size; scaled only if it is not.
        "[1:v]scale=%d:%d,format=rgba[card]" % (out_w, out_h),
        "[bg][card]overlay=0:0:format=auto:shortest=1,format=yuv420p[v]",
        audio,
    ])
    _run(ffmpeg, [
        "-ss", "%.3f" % seek, "-i", main,
        # libvpx, not FFmpeg's native vp9 decoder: only libvpx keeps the alpha.
        "-c:v", "libvpx-vp9", "-i", card,
        "-f", "lavfi", "-t", s, "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-t", s,
        *VIDEO_ENC, *AUDIO_ENC, "-movflags", "+faststart", out,
    ])


def _cut_head(ffmpeg, main, start, work_dir, stem):
    """Everything before the keyframe at `start`, stream-copied.

    Not `-t start -c copy`: that cuts in decode order and, with B-frames, puts
    the keyframe and the frame after it in the head too, so the footage jumps
    back two frames where the card begins. The segment muxer splits on the
    keyframe itself.
    """
    seg_dir = os.path.join(work_dir, stem + ".seg")
    os.makedirs(seg_dir, exist_ok=True)
    try:
        _run(ffmpeg, ["-i", main, "-map", "0", "-c", "copy", "-f", "segment",
                      "-segment_times", "%.4f" % max(0.0, start - 0.5 / FPS),
                      "-reset_timestamps", "1", "-segment_format", "mp4",
                      os.path.join(seg_dir, "seg%d.mp4")])
        head = os.path.join(work_dir, stem + ".head.mp4")
        os.replace(os.path.join(seg_dir, "seg0.mp4"), head)
        return head
    finally:
        for name in os.listdir(seg_dir) if os.path.isdir(seg_dir) else []:
            try:
                os.unlink(os.path.join(seg_dir, name))
            except OSError:
                pass
        try:
            os.rmdir(seg_dir)
        except OSError:
            pass


def apply(main, es, start, clip_dur, out_w, out_h, work_dir, stem, ffmpeg, ffprobe, http_get, storage_key):
    """Return the path of `main` with the end screen. Raises on any failure."""
    # Absolute paths: the concat demuxer resolves relative entries against the
    # list file's own folder, not the working directory.
    main = os.path.abspath(main)
    work_dir = os.path.abspath(work_dir)
    appended = start is None
    card = os.path.join(work_dir, stem + ".card.webm")
    tail = os.path.join(work_dir, stem + ".tail.mp4")
    lst = os.path.join(work_dir, stem + ".concat.txt")
    out = os.path.join(work_dir, stem + ".es.mp4")
    temps = [card, tail, lst]
    try:
        fetch_card(es["cardUrl"], card, http_get, storage_key)
        _render_tail(ffmpeg, main, card, tail, es, clip_dur if appended else start, appended, out_w, out_h)
        head = main
        if not appended:
            head = _cut_head(ffmpeg, main, start, work_dir, stem)
            temps.append(head)
        with open(lst, "w") as f:
            f.write("file '%s'\nfile '%s'\n" % (head, tail))
        _run(ffmpeg, ["-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", out])
        want = clip_dur + (es["seconds"] if appended else 0.0)
        got = _duration(ffprobe, out)
        if abs(got - want) > 0.35:
            raise RuntimeError("end screen output is %.2fs, expected %.2fs" % (got, want))
        return out
    except Exception:
        try:
            os.unlink(out)
        except OSError:
            pass
        raise
    finally:
        for p in temps:
            try:
                os.unlink(p)
            except OSError:
                pass
