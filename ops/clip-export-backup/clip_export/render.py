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
"""
import fcntl
import json
import math
import os
import re
import select
import shutil
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

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
SLOTS = 2
SLOT_WAIT_SEC = 3600
MIN_FREE_GB = 15
MAX_ATTEMPTS = 3
READ_STALL_SEC = 120

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

def http_get(url, headers=None, timeout=30):
    req = urllib.request.Request(url, headers={"Referer": REFERER, "User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def resolve_source(video_id):
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
        if host == "storage.bunnycdn.com" and STORAGE_KEY:
            headers["AccessKey"] = STORAGE_KEY
        data = http_get(url, headers=headers, timeout=20)
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


def render(job, spec, attempt):
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
    n_frames = int(math.ceil(clip_dur * FPS - 1e-6))

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
    t1 = t0 + clip_dur
    coarse = ["-ss", "%.3f" % max(0.0, start - 8.0)] if start > 8.0 else []

    os.makedirs(WORK_DIR, exist_ok=True)
    audio_path = os.path.join(WORK_DIR, job + ".m4a")
    tmp_out = os.path.join(WORK_DIR, job + ".mp4")
    for p in (audio_path, tmp_out):
        if os.path.exists(p):
            os.unlink(p)

    # Audio first: small, and it proves the source window is reachable.
    save_state(job, status="fetching", stage="Fetching audio", progress=5,
               source={"variant": variant, "duration": duration, "start": start, "end": end})
    a = subprocess.run(
        [FFMPEG, "-nostdin", "-v", "error", *http_input_args(), *coarse, "-copyts", "-i", variant,
         "-vn", "-map", "0:a:0?", "-af", "atrim=start=%.4f:end=%.4f,asetpts=PTS-STARTPTS" % (t0, t1),
         "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-y", audio_path],
        capture_output=True, text=True, timeout=600)
    has_audio = a.returncode == 0 and os.path.exists(audio_path) and os.path.getsize(audio_path) > 1000
    if not has_audio:
        log(job, "no usable audio (%s) -- adding a silent track" % (a.stderr.strip()[-200:] or "none"))

    overlay = load_overlay(spec.get("overlayUrl"), out_w, out_h, job)

    save_state(job, status="encoding", stage="Rendering", progress=8)
    dec = subprocess.Popen(
        [FFMPEG, "-nostdin", "-v", "error", *http_input_args(), *coarse, "-copyts", "-i", variant,
         "-map", "0:v:0",
         "-vf", "trim=start=%.4f:end=%.4f,setpts=PTS-STARTPTS,fps=%d,crop=%d:%d:%d:%d"
         % (t0, t1 + 0.2, FPS, bw, bh, x0, y0),
         "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    audio_in = (["-i", audio_path] if has_audio
                else ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"])
    enc = subprocess.Popen(
        [FFMPEG, "-nostdin", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
         "-s", "%dx%d" % (out_w, out_h), "-r", str(FPS), "-i", "pipe:0", *audio_in,
         "-map", "0:v:0", "-map", "1:a:0", "-t", "%.3f" % clip_dur,
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
         "-r", str(FPS), "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
         "-movflags", "+faststart", "-y", tmp_out],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    buf = bytearray(frame_bytes)
    view = memoryview(buf)
    got = 0
    try:
        for i in range(n_frames):
            filled = 0
            while filled < frame_bytes:
                ready, _, _ = select.select([dec.stdout], [], [], READ_STALL_SEC)
                if not ready:
                    raise RuntimeError("source stalled for %ds at frame %d" % (READ_STALL_SEC, i))
                n = dec.stdout.readinto(view[filled:])
                if not n:
                    break
                filled += n
            if filled < frame_bytes:
                break
            got += 1
            src = np.frombuffer(buf, np.uint8).reshape(bh, bw, 3)
            rx, ry, rw, rh = rects[i]
            sx, sy = out_w / rw, out_h / rh
            m = np.array([[sx, 0.0, -(rx - x0) * sx], [0.0, sy, -(ry - y0) * sy]], np.float32)
            interp = cv2.INTER_AREA if sx < 1 else cv2.INTER_LINEAR
            frame = cv2.warpAffine(src, m, (out_w, out_h), flags=interp,
                                   borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
            if overlay is not None:
                premul, inv = overlay
                frame = ((frame.astype(np.uint16) * inv + premul) // 255).astype(np.uint8)
            enc.stdin.write(frame.tobytes())
            if i % 30 == 0:
                save_state(job, progress=8 + int(87 * i / max(1, n_frames)))
    finally:
        try:
            enc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        dec.kill()
        dec_err = (dec.stderr.read() or b"").decode("utf-8", "replace")[-600:]
        dec.wait()
    enc_rc = enc.wait(timeout=600)
    enc_err = (enc.stderr.read() or b"").decode("utf-8", "replace")[-600:]

    if got < n_frames - 3:
        raise RuntimeError("source ended early: %d of %d frames (%s)" % (got, n_frames, dec_err.strip()))
    if enc_rc != 0:
        raise RuntimeError("encoder exited %s: %s" % (enc_rc, enc_err.strip()))

    info = probe(tmp_out)
    vid = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    dur = float(info.get("format", {}).get("duration", 0) or 0)
    if not vid or vid[0].get("width") != out_w or vid[0].get("height") != out_h:
        raise RuntimeError("output geometry wrong: %s" % vid)
    if abs(dur - clip_dur) > 0.6:
        raise RuntimeError("output is %.2fs, expected %.2fs" % (dur, clip_dur))

    final = os.path.join(OUT_DIR, job + ".mp4")
    os.replace(tmp_out, final)
    if os.path.exists(audio_path):
        os.unlink(audio_path)
    return {"path": final, "bytes": os.path.getsize(final), "duration": round(dur, 3),
            "width": out_w, "height": out_h, "frames": got, "hasAudio": has_audio,
            "branded": overlay is not None}


# ------------------------------------------------------------------------- slots

def acquire_slot(job):
    deadline = time.time() + SLOT_WAIT_SEC
    announced = False
    while time.time() < deadline:
        for i in range(SLOTS):
            fd = os.open(os.path.join(LOCK_DIR, "clipexport-slot%d.lock" % i), os.O_CREAT | os.O_RDWR)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fd
            except BlockingIOError:
                os.close(fd)
        if not announced:
            save_state(job, status="queued", stage="Waiting for a render slot", progress=1)
            announced = True
        time.sleep(3)
    raise RuntimeError("no render slot free for %ds" % SLOT_WAIT_SEC)


def main():
    job = sys.argv[1]
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,80}", job):
        sys.exit("bad job id")
    spec = load_state(job)["spec"]
    save_state(job, status="queued", stage="Starting", progress=0, pid=os.getpid(),
               startedAt=time.time(), error=None, errorKind=None, lastError=None, output=None)
    try:
        os.nice(10)  # live and VAR transcodes on this box come first
    except OSError:
        pass
    slot = acquire_slot(job)
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
    sys.exit(main())
