#!/opt/replay/venv/bin/python
"""
Method B clip exporter (vps1) -- the independent backup for the app's export.

The app (Replit, Node, FFmpeg 7.1, Bunny Storage) is Method A. This is Method B:
a different machine, language, FFmpeg build (Ubuntu 6.1.1), renderer and set of
credentials. It shares exactly one thing with Method A, the source footage on
Bunny Stream, because that is the only place a recording lives.

Deliberately NOT shared with Method A:
  - no code: the crop model is re-implemented here from its specification, and
    rendered per frame with an exact sub-pixel affine warp (cv2) rather than
    FFmpeg's zoompan;
  - no Bunny Stream API key: the source is found by parsing the public HLS
    master playlist, and the duration by summing its segments;
  - no Bunny Storage: the MP4 is kept on vps1 and served by the control API;
  - no branding dependency: the overlay is best effort and can never fail a job.

Usage:  render.py <job>        (spec in /opt/replay/jobs/clipexport/<job>.json)
Launched by clip_export_api.py in its own transient systemd unit.

Written 2026-09-29 after five consecutive production export failures caused by
the branding overlay returning 401 from Bunny Storage.

2026-09-29 (evening): two changes, both measured on a real 16 s clip.
  - How many renders run at once is decided from the box's measured idle CPU
    (see "admission" below) instead of a fixed two, first come first served.
  - The render is pipelined: the decoder, the warp and the encoder run in
    parallel threads instead of lock-step over 64 KB pipes, the audio is fetched
    while the video renders, and the source lookup is cached per video.
    Same 16 s clip, same box: 46.5 s -> 13.9 s, byte-identical MP4 (bench/prof.py).
"""
import fcntl
import json
import math
import os
import queue
import re
import select
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

try:
    import endscreen  # clip_export/endscreen.py, added 2026-10-25
except Exception:  # noqa: BLE001 -- branding must never stop a render
    endscreen = None
import cv2
import numpy as np

SRC_W, SRC_H = 3840, 1080
FPS = 30
MAX_CLIP_SECONDS = 1800
MAX_FRAME_SCALE = 4.5

# Overridable only so the renderer can be exercised end to end off-box.
_ROOT = os.environ.get("CLIP_EXPORT_TEST_ROOT")
JOBS_DIR = os.path.join(_ROOT, "jobs") if _ROOT else "/opt/replay/jobs/clipexport"
OUT_DIR = os.path.join(_ROOT, "exports") if _ROOT else "/opt/replay/exports"
WORK_DIR = os.path.join(OUT_DIR, "work")
LOCK_DIR = os.path.join(_ROOT, "lock") if _ROOT else "/run/lock"
SRC_CACHE_DIR = os.path.join(WORK_DIR, "srccache")
SRC_CACHE_TTL = 3600
SLOT_WAIT_SEC = 3600
MIN_FREE_GB = 15
MAX_ATTEMPTS = 3
READ_STALL_SEC = 120
PIPE_DEPTH = 4  # frames buffered between decoder -> warp -> encoder

# ---- admission defaults; /opt/replay/clip_export/slots.json overrides any of them
TUNING_FILE = os.environ.get("CLIP_EXPORT_TUNING", "/opt/replay/clip_export/slots.json")
ADMISSION_DEFAULTS = {
    "minSlots": 1,          # always this many, however busy the box is (renders are nice 10)
    "maxSlots": 6,          # never more, however idle
    "coresPerRender": 2.5,  # what one render needs; measured, see bench/
    "settleSec": 8,         # a render admitted this recently is counted as if already running
    "minMemGB": 3.0,        # MemAvailable below this admits nothing beyond minSlots
    "sampleSec": 2.0,       # /proc/stat sampling window
}

FFMPEG = "/usr/bin/ffmpeg"
FFPROBE = "/usr/bin/ffprobe"
REFERER = "https://iframe.mediadelivery.net/"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36")


class SourceGone(Exception):
    """The recording no longer exists on Bunny Stream. Not retryable."""


class Permanent(Exception):
    """A request that can never succeed (bad window, bad geometry). Not retryable."""


# --------------------------------------------------------------------------- env

def read_env(path="/opt/replay/env"):
    env = {}
    try:
        for line in open(path):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")  # last one wins
    except OSError:
        pass
    return env


ENV = read_env(os.environ.get("CLIP_EXPORT_ENV_FILE", "/opt/replay/env"))
STREAM_HOST = ENV.get("BUNNY_STREAM_HOST", "")
# https://<pull zone> in production; a plain-http base only in the off-box test.
STREAM_BASE = ENV.get("CLIP_EXPORT_STREAM_BASE") or ("https://%s" % STREAM_HOST if STREAM_HOST else "")
STORAGE_KEY = ENV.get("BUNNY_STORAGE_KEY", "")


# ------------------------------------------------------------------------- state

def state_path(job):
    return os.path.join(JOBS_DIR, job + ".json")


def load_state(job):
    with open(state_path(job)) as f:
        return json.load(f)


def save_state(job, **fields):
    st = load_state(job)
    st.update(fields)
    st["updatedAt"] = time.time()
    tmp = state_path(job) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, state_path(job))
    return st


def log(job, msg):
    print("%s [%s] %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), job, msg), flush=True)


# ------------------------------------------------------------------------ source

def http_get(url, headers=None, timeout=30, referer=True):
    base = {"Referer": REFERER, "User-Agent": UA} if referer else {"User-Agent": UA}
    req = urllib.request.Request(url, headers={**base, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _cache_path(video_id):
    return os.path.join(SRC_CACHE_DIR, "%s.json" % video_id)


def resolve_source(video_id):
    """resolve_source_uncached, remembered per video for an hour.

    A burst of clips from one match (the usual shape: a player saves all their
    moments at once) otherwise re-reads two playlists and runs two ffprobes over
    HTTP for every clip. Only a fully verified result is cached, and a finished
    recording's playlist does not change.
    """
    if not re.fullmatch(r"[0-9a-fA-F-]{16,64}", video_id or ""):
        raise Permanent("bad video id %r" % video_id)
    path = _cache_path(video_id)
    try:
        if time.time() - os.path.getmtime(path) < SRC_CACHE_TTL:
            with open(path) as f:
                c = json.load(f)
            return c["variant"], float(c["duration"]), float(c["startPts"])
    except (OSError, ValueError, KeyError, TypeError):
        pass
    variant, duration, start_pts = resolve_source_uncached(video_id)
    try:
        os.makedirs(SRC_CACHE_DIR, exist_ok=True)
        tmp = path + ".%d.tmp" % os.getpid()
        with open(tmp, "w") as f:
            json.dump({"variant": variant, "duration": duration, "startPts": start_pts}, f)
        os.replace(tmp, path)
    except OSError:
        pass
    return variant, duration, start_pts


def resolve_source_uncached(video_id):
    """Find the variant that DECLARES 3840x1080 and its total duration.

    Rendition labels on this library do not identify geometry (the same "1080p"
    label is 3840x1080 on one video and 1920x540 on another), so only the
    RESOLUTION attribute is trusted -- and the decoded frame is checked again
    later, because a playlist can lie.
    """
    if not STREAM_BASE:
        raise RuntimeError("BUNNY_STREAM_HOST missing from /opt/replay/env")
    if not re.fullmatch(r"[0-9a-fA-F-]{16,64}", video_id or ""):
        raise Permanent("bad video id %r" % video_id)
    master_url = "%s/%s/playlist.m3u8" % (STREAM_BASE, video_id)
    try:
        master = http_get(master_url).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code in (403, 404, 410):
            raise SourceGone("master playlist HTTP %d" % e.code)
        raise
    variant = None
    lines = master.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            m = re.search(r"RESOLUTION=(\d+)x(\d+)", line)
            if m and int(m.group(1)) == SRC_W and int(m.group(2)) == SRC_H:
                for nxt in lines[i + 1:]:
                    if nxt.strip() and not nxt.startswith("#"):
                        variant = urllib.parse.urljoin(master_url, nxt.strip())
                        break
            if variant:
                break
    if not variant:
        raise Permanent("no %dx%d variant in master playlist" % (SRC_W, SRC_H))
    media = http_get(variant).decode("utf-8", "replace")
    duration = sum(float(m) for m in re.findall(r"#EXTINF:([0-9.]+)", media))
    if duration <= 0:
        raise RuntimeError("variant playlist has no segments")
    # The playlist's word is not enough: every crop is multiplied by 3840x1080,
    # so measure a decoded frame of the variant before trusting it.
    p = subprocess.run(
        [FFPROBE, "-v", "error", *http_input_args(), "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", variant],
        capture_output=True, text=True, timeout=90)
    q = subprocess.run(
        [FFPROBE, "-v", "error", *http_input_args(), "-show_entries", "format=start_time",
         "-of", "csv=p=0", variant],
        capture_output=True, text=True, timeout=90)
    try:
        start_pts = float(q.stdout.strip().splitlines()[0])
    except (ValueError, IndexError):
        raise RuntimeError("could not read the source start time: %s" % q.stderr.strip()[-300:])
    # HLS reports the stream once per program; every report must agree.
    dims = {ln.strip() for ln in p.stdout.splitlines() if ln.strip()}
    if p.returncode != 0 or not dims:
        raise RuntimeError("could not probe the source variant: %s" % p.stderr.strip()[-300:])
    if dims != {"%dx%d" % (SRC_W, SRC_H)}:
        raise Permanent("variant decodes as %s, expected %dx%d" % (sorted(dims), SRC_W, SRC_H))
    return variant, duration, start_pts


# -------------------------------------------------------------------- crop model
# Re-implemented from the specification the app's editor writes (not ported
# line by line): a keyframe is {t, x, y, w, h}; t is 0..1 of the clip, the rest
# are fractions of the 3840x1080 source; the frame may hang off the source
# (black bars). Frames written before the frame model existed are normalised to
# a zoom-1 frame at the same horizontal centre.

def output_dims(is_916):
    # Same output contract as the app: 1920x1080, or 608x1080 (1080*9/16 rounded up to even).
    return (608, SRC_H) if is_916 else (1920, SRC_H)


def _num(v, fallback):
    return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else fallback


def clean_keyframes(raw, is_916):
    out_aspect = 9 / 16 if is_916 else 16 / 9
    src_aspect = SRC_W / SRC_H
    base_w = out_aspect / src_aspect
    kfs = []
    for kf in raw if isinstance(raw, list) else []:
        if not isinstance(kf, dict):
            continue
        clamp = lambda v, lo, hi: max(lo, min(hi, v))
        k = {
            "t": clamp(_num(kf.get("t"), 0.0), 0.0, 1.0),
            "x": clamp(_num(kf.get("x"), 0.0), -MAX_FRAME_SCALE, MAX_FRAME_SCALE),
            "y": clamp(_num(kf.get("y"), 0.0), -MAX_FRAME_SCALE, MAX_FRAME_SCALE),
            "w": clamp(_num(kf.get("w"), 0.0), 0.0, MAX_FRAME_SCALE),
            "h": clamp(_num(kf.get("h"), 1.0), 0.0, MAX_FRAME_SCALE),
        }
        w = k["w"] if k["w"] > 0 else base_w
        derived_h = w * src_aspect / out_aspect
        if abs(k["h"] - derived_h) > 0.05:  # legacy shape
            cx = k["x"] + w / 2
            lo, hi = min(0.0, 1 - base_w), max(0.0, 1 - base_w)
            k = {"t": k["t"], "x": max(lo, min(hi, cx - base_w / 2)), "y": 0.0,
                 "w": base_w, "h": base_w * src_aspect / out_aspect}
        else:
            k["w"] = w
        kfs.append(k)
    kfs.sort(key=lambda k: k["t"])
    dedup = []
    for k in kfs:
        if dedup and abs(dedup[-1]["t"] - k["t"]) <= 1e-9:
            dedup[-1] = k
        else:
            dedup.append(k)
    if not dedup:  # no path: a centred zoom-1 frame
        w = base_w
        dedup = [{"t": 0.0, "x": (1 - w) / 2, "y": 0.0, "w": w, "h": 1.0}]
    return dedup


def sample(kfs, t):
    if len(kfs) == 1 or t <= kfs[0]["t"]:
        return kfs[0]
    if t >= kfs[-1]["t"]:
        return kfs[-1]
    for i in range(1, len(kfs)):
        if kfs[i]["t"] > t:
            a, b = kfs[i - 1], kfs[i]
            span = b["t"] - a["t"]
            p = (t - a["t"]) / span if span > 1e-6 else 0.0
            return {c: a[c] + (b[c] - a[c]) * p for c in ("x", "y", "w", "h")}
    return kfs[-1]


def rect_px(kf):
    """Source-pixel rectangle (x, y, w, h) as floats; w/h at least 2 px."""
    return (kf["x"] * SRC_W, kf["y"] * SRC_H, max(2.0, kf["w"] * SRC_W), max(2.0, kf["h"] * SRC_H))


# ---------------------------------------------------------------------- overlay

def load_overlay(url, out_w, out_h, job):
    """Best effort. Any failure returns None and the clip exports unbranded."""
    if not url:
        return None
    try:
        headers = {}
        host = urllib.parse.urlparse(url).hostname or ""
        if host.endswith("storage.bunnycdn.com") and STORAGE_KEY:  # incl. regional hosts
            headers["AccessKey"] = STORAGE_KEY
        # No Stream Referer here: Bunny Storage answers 401 to a request that
        # carries the iframe.mediadelivery.net Referer, even with a valid key.
        data = http_get(url, headers=headers, timeout=20, referer=False)
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
        if img is None or img.ndim != 3 or img.shape[2] != 4:
            log(job, "overlay is not an RGBA image -- exporting unbranded")
            return None
        canvas = np.zeros((out_h, out_w, 4), np.uint8)  # composited at 0,0, unscaled
        h, w = min(out_h, img.shape[0]), min(out_w, img.shape[1])
        canvas[:h, :w] = img[:h, :w]
        alpha = canvas[:, :, 3:4].astype(np.uint16)
        if int(alpha.max()) == 0:
            return None
        return canvas[:, :, :3].astype(np.uint16) * alpha, (255 - alpha)
    except Exception as e:  # noqa: BLE001 -- branding must never cost a clip
        log(job, "overlay unavailable (%s) -- exporting unbranded" % e)
        return None


# ----------------------------------------------------------------------- render

def free_gb(path):
    return shutil.disk_usage(path).free / 1e9


def probe(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
         "-of", "json", path], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError("ffprobe failed: %s" % out.stderr[-300:])
    return json.loads(out.stdout)


def http_input_args():
    hdr = "Referer: %s\r\nUser-Agent: %s\r\n" % (REFERER, UA)
    return ["-headers", hdr, "-reconnect", "1", "-reconnect_streamed", "1",
            "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10",
            "-rw_timeout", "30000000"]


def _put(q, item, stop):
    """queue.put that gives up once `stop` is set, so no thread blocks forever."""
    while not stop.is_set():
        try:
            q.put(item, timeout=0.5)
            return True
        except queue.Full:
            continue
    return False


def _get(q, stop):
    while True:
        try:
            return q.get(timeout=0.5)
        except queue.Empty:
            if stop.is_set():
                return None


_CHILDREN = []  # ffmpeg processes of the current attempt


def _reap_children():
    """Kill whatever a failed attempt left running (e.g. the parallel audio fetch)."""
    for p in _CHILDREN:
        try:
            if p.poll() is None:
                p.kill()
            p.wait(timeout=10)
        except Exception:  # noqa: BLE001
            pass
    _CHILDREN.clear()


def render(job, spec, attempt):
    _reap_children()
    is_916 = spec.get("aspectRatio") == "9:16"
    out_w, out_h = output_dims(is_916)

    save_state(job, status="fetching", stage="Resolving source", progress=2, attempt=attempt)
    variant, duration, start_pts = resolve_source(spec["videoId"])

    st, en = float(spec["startTime"]), float(spec["endTime"])
    if not (math.isfinite(st) and math.isfinite(en)):
        raise Permanent("non-numeric window")
    start = min(duration, max(0.0, st * duration))
    end = min(duration, max(start, en * duration))
    clip_dur = end - start
    if clip_dur < 0.1:
        raise Permanent("empty window after clamping to the %.1fs recording" % duration)
    if clip_dur > MAX_CLIP_SECONDS:
        raise Permanent("clip is %ds, longer than the %ds limit" % (clip_dur, MAX_CLIP_SECONDS))

    # The app's drawn end screen (Admin -> Branding), if the spec carries one.
    # It plays after the clip, over the footage that follows it (2026-10-25):
    # render that much further, with a keyframe at the clip's end.
    es = endscreen.validate(spec.get("endScreen")) if endscreen else None
    es_start = endscreen.start_for(clip_dur) if es else None
    run_on = endscreen.run_on(end, duration, es["seconds"]) if es else 0.0
    render_dur = clip_dur + run_on
    key_args = ["-force_key_frames", "%.3f" % es_start] if es and run_on > 0 else []
    n_frames = int(math.ceil(render_dur * FPS - 1e-6))

    kfs = clean_keyframes(spec.get("cropPath"), is_916)
    rects = [rect_px(sample(kfs, (i / FPS) / clip_dur if clip_dur > 1e-6 else 0.0))
             for i in range(n_frames)]

    # Only decode the part of the panorama the path visits.
    x0 = max(0, int(math.floor(min(r[0] for r in rects))) - 2)
    y0 = max(0, int(math.floor(min(r[1] for r in rects))) - 2)
    x1 = min(SRC_W, int(math.ceil(max(r[0] + r[2] for r in rects))) + 2)
    y1 = min(SRC_H, int(math.ceil(max(r[1] + r[3] for r in rects))) + 2)
    if x1 - x0 < 16 or y1 - y0 < 16:  # the path never touches the source
        x0, y0, x1, y1 = 0, 0, SRC_W, SRC_H
    x0 -= x0 % 2
    y0 -= y0 % 2
    bw = (x1 - x0) // 2 * 2
    bh = (y1 - y0) // 2 * 2
    frame_bytes = bw * bh * 3

    # Clip time 0 is the player's time `start`, i.e. raw PTS start_pts + start.
    # Seeking is done explicitly on raw timestamps (-copyts + trim) rather than
    # with a plain input -ss: on HLS, FFmpeg 6.1 lands a video-only input seek
    # 1.4 s early (the MPEG-TS start offset) but an audio+video one correctly,
    # so the plain form's accuracy depends on which streams are read. Measured
    # 2026-09-29. The coarse -ss only has to land somewhere before the target.
    t0 = start_pts + start
    t1 = t0 + render_dur
    coarse = ["-ss", "%.3f" % max(0.0, start - 8.0)] if start > 8.0 else []

    os.makedirs(WORK_DIR, exist_ok=True)
    audio_path = os.path.join(WORK_DIR, job + ".m4a")
    video_path = os.path.join(WORK_DIR, job + ".v.mp4")
    tmp_out = os.path.join(WORK_DIR, job + ".mp4")
    for p in (audio_path, video_path, tmp_out):
        if os.path.exists(p):
            os.unlink(p)

    save_state(job, status="fetching", stage="Fetching source", progress=5,
               source={"variant": variant, "duration": duration, "start": start, "end": end, "runOn": run_on})
    # Audio is fetched while the video renders; it is small and joins at the mux.
    aud = subprocess.Popen(
        [FFMPEG, "-nostdin", "-v", "error", *http_input_args(), *coarse, "-copyts", "-i", variant,
         "-vn", "-map", "0:a:0?", "-af", "atrim=start=%.4f:end=%.4f,asetpts=PTS-STARTPTS" % (t0, t1),
         "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-y", audio_path],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    _CHILDREN.append(aud)

    overlay = load_overlay(spec.get("overlayUrl"), out_w, out_h, job)

    save_state(job, status="encoding", stage="Rendering", progress=8)
    dec = subprocess.Popen(
        [FFMPEG, "-nostdin", "-v", "error", *http_input_args(), *coarse, "-copyts", "-i", variant,
         "-map", "0:v:0",
         "-vf", "trim=start=%.4f:end=%.4f,setpts=PTS-STARTPTS,fps=%d,crop=%d:%d:%d:%d"
         % (t0, t1 + 0.2, FPS, bw, bh, x0, y0),
         "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    enc = subprocess.Popen(
        [FFMPEG, "-nostdin", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
         "-s", "%dx%d" % (out_w, out_h), "-r", str(FPS), "-i", "pipe:0",
         "-map", "0:v:0", "-t", "%.3f" % render_dur,
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
         "-r", str(FPS), *key_args, "-an", "-y", video_path],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    _CHILDREN.extend([dec, enc])

    # Three stages in parallel: reader (decoder pipe -> q_in), this thread
    # (warp), writer (q_out -> encoder pipe). Before this they ran lock-step,
    # each blocked on the others through 64 KB pipes carrying 6-12 MB frames.
    stop = threading.Event()
    q_in = queue.Queue(maxsize=PIPE_DEPTH)
    q_out = queue.Queue(maxsize=PIPE_DEPTH)
    errs = {}

    def reader():
        try:
            for i in range(n_frames):
                buf = bytearray(frame_bytes)
                view = memoryview(buf)
                filled = 0
                while filled < frame_bytes:
                    if stop.is_set():
                        return
                    ready, _, _ = select.select([dec.stdout], [], [], READ_STALL_SEC)
                    if not ready:
                        raise RuntimeError("source stalled for %ds at frame %d" % (READ_STALL_SEC, i))
                    n = dec.stdout.readinto(view[filled:])
                    if not n:
                        break
                    filled += n
                if filled < frame_bytes:
                    return
                if not _put(q_in, buf, stop):
                    return
        except Exception as e:  # noqa: BLE001
            errs["reader"] = e
        finally:
            _put(q_in, None, stop)

    def writer():
        try:
            while True:
                item = _get(q_out, stop)
                if item is None:
                    return
                enc.stdin.write(item)
        except Exception as e:  # noqa: BLE001 -- e.g. BrokenPipe when the encoder died
            errs["writer"] = e
            stop.set()

    rt = threading.Thread(target=reader, name="reader", daemon=True)
    wt = threading.Thread(target=writer, name="writer", daemon=True)
    rt.start()
    wt.start()

    got = 0
    try:
        while got < n_frames:
            buf = _get(q_in, stop)
            if buf is None or "writer" in errs:
                break
            src = np.frombuffer(buf, np.uint8).reshape(bh, bw, 3)
            rx, ry, rw, rh = rects[got]
            sx, sy = out_w / rw, out_h / rh
            m = np.array([[sx, 0.0, -(rx - x0) * sx], [0.0, sy, -(ry - y0) * sy]], np.float32)
            interp = cv2.INTER_AREA if sx < 1 else cv2.INTER_LINEAR
            frame = cv2.warpAffine(src, m, (out_w, out_h), flags=interp,
                                   borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
            if overlay is not None:
                premul, inv = overlay
                frame = ((frame.astype(np.uint16) * inv + premul) // 255).astype(np.uint8)
            if not _put(q_out, np.ascontiguousarray(frame), stop):
                break
            got += 1
            if got % 30 == 0:
                save_state(job, progress=8 + int(85 * got / max(1, n_frames)))
        _put(q_out, None, stop)
        wt.join(timeout=600)
    finally:
        stop.set()
        try:
            enc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        dec.kill()
        dec_err = (dec.stderr.read() or b"").decode("utf-8", "replace")[-600:]
        dec.wait()
        rt.join(timeout=10)
    enc_rc = enc.wait(timeout=600)
    enc_err = (enc.stderr.read() or b"").decode("utf-8", "replace")[-600:]

    if "reader" in errs:
        raise errs["reader"]
    if "writer" in errs:
        raise RuntimeError("encoder pipe failed (%s): %s" % (errs["writer"], enc_err.strip()))
    clip_frames = int(math.ceil(clip_dur * FPS - 1e-6))
    if got < n_frames - 3:
        if es and run_on > 0 and got >= clip_frames - 3:
            # The recording ended inside the run-on (playlist durations are
            # approximate): keep what there is; the card holds its last frame.
            log(job, "run-on footage ended early: %d of %d frames" % (got, n_frames))
            render_dur = max(clip_dur, got / float(FPS))
            run_on = render_dur - clip_dur
        else:
            raise RuntimeError("source ended early: %d of %d frames (%s)" % (got, n_frames, dec_err.strip()))
    if enc_rc != 0:
        raise RuntimeError("encoder exited %s: %s" % (enc_rc, enc_err.strip()))

    # Join the audio (fetched in parallel) to the finished video.
    save_state(job, progress=95, stage="Finishing")
    try:
        aud_rc = aud.wait(timeout=600)
    except subprocess.TimeoutExpired:
        aud.kill()
        aud_rc = -1
    aud_err = (aud.stderr.read() or b"").decode("utf-8", "replace")[-200:]
    has_audio = aud_rc == 0 and os.path.exists(audio_path) and os.path.getsize(audio_path) > 1000
    if not has_audio:
        log(job, "no usable audio (%s) -- adding a silent track" % (aud_err.strip() or "none"))
    audio_in = (["-i", audio_path] if has_audio
                else ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"])
    mux = subprocess.run(
        [FFMPEG, "-nostdin", "-v", "error", "-i", video_path, *audio_in,
         "-map", "0:v:0", "-map", "1:a:0", "-t", "%.3f" % render_dur,
         "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
         "-movflags", "+faststart", "-y", tmp_out],
        capture_output=True, text=True, timeout=300)
    if mux.returncode != 0:
        raise RuntimeError("mux failed: %s" % mux.stderr.strip()[-300:])

    info = probe(tmp_out)
    vid = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    dur = float(info.get("format", {}).get("duration", 0) or 0)
    if not vid or vid[0].get("width") != out_w or vid[0].get("height") != out_h:
        raise RuntimeError("output geometry wrong: %s" % vid)
    if abs(dur - render_dur) > 0.6:
        raise RuntimeError("output is %.2fs, expected %.2fs" % (dur, render_dur))

    end_screen = None
    if es:
        try:
            save_state(job, progress=97, stage="Adding the end screen")
            branded = endscreen.apply(tmp_out, es, es_start, out_w, out_h, WORK_DIR, job,
                                      FFMPEG, FFPROBE, http_get, STORAGE_KEY)
            os.replace(branded, tmp_out)
            end_screen = es["kind"] or "card"
        except Exception as e:  # noqa: BLE001 -- branding must never cost a clip
            log(job, "end screen unavailable (%s) -- exporting without it" % e)
            if run_on > 0:
                # Without the card the run-on seconds are not what he chose.
                try:
                    os.replace(endscreen.trim_to(tmp_out, es_start, WORK_DIR, job, FFMPEG), tmp_out)
                except Exception as e2:  # noqa: BLE001
                    # Never ship seconds he did not choose: re-encode the clip alone.
                    log(job, "could not cut the run-on footage (%s) -- re-encoding the clip alone" % e2)
                    cut = os.path.join(WORK_DIR, job + ".cut.mp4")
                    r = subprocess.run(
                        [FFMPEG, "-nostdin", "-v", "error", "-i", tmp_out, "-t", "%.3f" % clip_dur,
                         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                         "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
                         "-movflags", "+faststart", "-y", cut],
                        capture_output=True, text=True, timeout=600)
                    if r.returncode != 0:
                        raise RuntimeError("could not cut the clip back to its end: %s" % r.stderr.strip()[-300:])
                    os.replace(cut, tmp_out)
        dur = float(probe(tmp_out).get("format", {}).get("duration", 0) or 0)

    final = os.path.join(OUT_DIR, job + ".mp4")
    os.replace(tmp_out, final)
    for p in (audio_path, video_path):
        if os.path.exists(p):
            os.unlink(p)
    return {"path": final, "bytes": os.path.getsize(final), "duration": round(dur, 3),
            "width": out_w, "height": out_h, "frames": got, "hasAudio": has_audio,
            "branded": overlay is not None or end_screen is not None, "endScreen": end_screen}


# --------------------------------------------------------------------- admission
# How many renders run at once is decided from what the box is doing, not a
# fixed number. vps1 also runs live, VAR and booking pulls; renders run at nice
# 10 so those always come first, and a render only starts when the measured idle
# CPU can hold one more.
#
#  - Waiters form a FIFO: one ticket per waiting job, ordered by the job's
#    submission time. Only the oldest live ticket may ask for admission.
#  - The decision is taken under one admission lock, so two waiters can never
#    both see the same idle cores.
#  - A render admitted less than settleSec ago may not have ramped up yet, so it
#    is subtracted from the measured idle cores as if it were already running.
#  - minSlots always run, however busy the box is: an export is never starved.
#  - A running render holds one of maxSlots flock files, as before, so the
#    count survives crashes (the kernel drops a dead process's lock).

def tuning():
    cfg = dict(ADMISSION_DEFAULTS)
    try:
        with open(TUNING_FILE) as f:
            over = json.load(f)
        for k, v in over.items():
            if k in cfg and isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
                cfg[k] = v
    except (OSError, ValueError, AttributeError):
        pass
    cfg["minSlots"] = max(1, int(cfg["minSlots"]))
    cfg["maxSlots"] = max(cfg["minSlots"], int(cfg["maxSlots"]))
    return cfg


def cpu_idle_fraction(sample_sec):
    def read():
        with open("/proc/stat") as f:
            vals = [int(v) for v in f.readline().split()[1:9]]
        return vals[3] + vals[4], sum(vals)  # idle + iowait, total (user..steal)
    i0, t0 = read()
    time.sleep(sample_sec)
    i1, t1 = read()
    return max(0.0, min(1.0, (i1 - i0) / max(1, t1 - t0)))


def mem_available_gb():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1048576.0
    except OSError:
        pass
    return 99.0


def admit_decision(rendering, recent, idle_cores, mem_gb, cfg):
    """Pure: may one more render start? -> (bool, reason)."""
    if rendering >= cfg["maxSlots"]:
        return False, "at the %d-render cap" % cfg["maxSlots"]
    if rendering < cfg["minSlots"]:
        return True, "below the minimum of %d" % cfg["minSlots"]
    if mem_gb < cfg["minMemGB"]:
        return False, "only %.1f GB memory available" % mem_gb
    spare = idle_cores - recent * cfg["coresPerRender"]
    if spare >= cfg["coresPerRender"]:
        return True, "%.1f cores idle" % spare
    return False, "%.1f cores idle, a render needs %.1f" % (max(0.0, spare), cfg["coresPerRender"])


def _slot_path(i):
    return os.path.join(LOCK_DIR, "clipexport-slot%d.lock" % i)


def _probe_slots(n):
    """(number of slot locks held by others, fd of the first free slot or None)."""
    held, free_fd = 0, None
    for i in range(n):
        fd = os.open(_slot_path(i), os.O_CREAT | os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            held += 1
            continue
        if free_fd is None:
            free_fd = fd  # keep it locked: it is ours if we are admitted
        else:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
    return held, free_fd


def _queue_dir():
    d = os.path.join(LOCK_DIR, "clipexport-queue")
    os.makedirs(d, exist_ok=True)
    return d


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _live_tickets():
    d = _queue_dir()
    out = []
    for name in sorted(os.listdir(d)):
        path = os.path.join(d, name)
        try:
            pid = int(open(path).read().strip() or 0)
        except (OSError, ValueError):
            pid = 0
        if pid and _pid_alive(pid):
            out.append(name)
        else:
            try:
                os.unlink(path)
            except OSError:
                pass
    return out


def _recent_admits(settle):
    path = os.path.join(LOCK_DIR, "clipexport-admits.json")
    now = time.time()
    try:
        with open(path) as f:
            ts = [t for t in json.load(f) if now - float(t) < settle]
    except (OSError, ValueError, TypeError):
        ts = []
    return ts, path


def acquire_slot(job, created_at):
    deadline = time.time() + SLOT_WAIT_SEC
    ticket = "%017.6f-%s" % (created_at, job)
    tpath = os.path.join(_queue_dir(), ticket)
    with open(tpath, "w") as f:
        f.write(str(os.getpid()))
    admit_fd = os.open(os.path.join(LOCK_DIR, "clipexport-admit.lock"), os.O_CREAT | os.O_RDWR)
    last_stage = last_reason = None
    try:
        while time.time() < deadline:
            cfg = tuning()
            tickets = _live_tickets()
            ahead = tickets.index(ticket) if ticket in tickets else 0
            reason = None
            if ahead == 0:
                try:
                    fcntl.flock(admit_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    reason = "another render is being admitted"
                else:
                    try:
                        held, free_fd = _probe_slots(cfg["maxSlots"])
                        recent, rpath = _recent_admits(cfg["settleSec"])
                        if free_fd is None:
                            ok, reason = False, "at the %d-render cap" % cfg["maxSlots"]
                        else:
                            idle = cpu_idle_fraction(cfg["sampleSec"]) * (os.cpu_count() or 1)
                            ok, reason = admit_decision(held, len(recent), idle, mem_available_gb(), cfg)
                        if ok:
                            tmp = rpath + ".tmp"
                            with open(tmp, "w") as f:
                                json.dump(recent + [time.time()], f)
                            os.replace(tmp, rpath)
                            log(job, "admitted (%s; %d rendering when checked)" % (reason, held))
                            return free_fd
                        if free_fd is not None:
                            fcntl.flock(free_fd, fcntl.LOCK_UN)
                            os.close(free_fd)
                    finally:
                        fcntl.flock(admit_fd, fcntl.LOCK_UN)
            stage = ("Waiting for a render slot (%d ahead)" % ahead) if ahead else \
                "Waiting for a render slot (server busy)"
            if reason and reason != last_reason:
                log(job, "waiting: %s" % reason)
                last_reason = reason
            if stage != last_stage:
                save_state(job, status="queued", stage=stage, progress=1)
                last_stage = stage
            time.sleep(2 if ahead == 0 else 3)
        raise RuntimeError("no render slot free for %ds" % SLOT_WAIT_SEC)
    finally:
        os.close(admit_fd)
        try:
            os.unlink(tpath)
        except OSError:
            pass


def main():
    job = sys.argv[1]
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,80}", job):
        sys.exit("bad job id")
    st0 = load_state(job)
    spec = st0["spec"]
    save_state(job, status="queued", stage="Starting", progress=0, pid=os.getpid(),
               startedAt=time.time(), error=None, errorKind=None, lastError=None, output=None)
    try:
        os.nice(10)  # live and VAR transcodes on this box come first
    except OSError:
        pass
    slot = acquire_slot(job, float(st0.get("createdAt") or time.time()))
    try:
        if free_gb(OUT_DIR) < MIN_FREE_GB:
            save_state(job, status="failed", stage="Server disk low", error="disk: %.1f GB free" % free_gb(OUT_DIR),
                       errorKind="disk", finishedAt=time.time())
            return 1
        last = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                t0 = time.time()
                out = render(job, spec, attempt)
                save_state(job, status="ready", stage="Ready", progress=100, output=out,
                           renderSeconds=round(time.time() - t0, 1), finishedAt=time.time(), error=None)
                log(job, "ready %s" % json.dumps(out))
                return 0
            except SourceGone as e:
                save_state(job, status="failed", stage="Source footage is gone", error=str(e),
                           errorKind="source_gone", finishedAt=time.time())
                log(job, "source gone: %s" % e)
                return 1
            except Permanent as e:
                save_state(job, status="failed", stage="Cannot export this clip", error=str(e),
                           errorKind="permanent", finishedAt=time.time())
                log(job, "permanent: %s" % e)
                return 1
            except Exception as e:  # noqa: BLE001
                _reap_children()
                last = "%s: %s" % (type(e).__name__, e)
                log(job, "attempt %d failed: %s\n%s" % (attempt, last, traceback.format_exc()))
                save_state(job, stage="Retrying (attempt %d failed)" % attempt, lastError=last)
                time.sleep(10 * attempt)
        save_state(job, status="failed", stage="Failed after %d attempts" % MAX_ATTEMPTS, error=last,
                   errorKind="transient", finishedAt=time.time())
        return 1
    finally:
        os.close(slot)


if __name__ == "__main__":
    rc = main()
    if rc == 0 and not _ROOT:
        # Permanent copy in Bunny Storage, after the render slot is released.
        # Best effort: the 10-minute to_storage.py --all sweep retries failures.
        try:
            subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "to_storage.py"),
                            sys.argv[1]], timeout=1200)
        except Exception:  # noqa: BLE001
            pass
    sys.exit(rc)
