#!/usr/bin/env python3
"""Off-schedule FTP gap store for vps1.

The cameras record to SD only in the hours their continuous (TIMING) recording
row is on. In every other hour this module has the camera FTP-push its clips to
vps1, keeps them in a rolling store capped at 100 GB, and assembles any window
of them (video + audio) into one MP4 that it uploads to Bunny Stream, with the
same job contract as /record-hq so the app can treat it as one more source.

Subcommands
  sync-schedule [--cam camN] [--dry-run]   camera FTP schedule := NOT(TIMING row)
  ingest                                   move finished clips into the store, prune
  pull <jobId>                             worker for one pull job (started by the API)
  status                                   store summary as JSON
  available <cam> [YYYY-MM-DD]             availability JSON (what the API serves)

Python stdlib only (system python3 on vps1 has no numpy/cv2). Times: camera
filenames are Amman local wall time (UTC+3, no DST); everything stored is UTC
epoch seconds. Never datetime.now() for local time: vps1's clock is Berlin.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

# ── configuration ────────────────────────────────────────────────────────────

ROOT = os.environ.get("GAPSTORE_ROOT", "/opt/reocam/gapstore")
CONFIG_PATH = os.environ.get("GAPSTORE_CONFIG", "/etc/reocam/gapstore.json")
INCOMING = os.environ.get("GAPSTORE_INCOMING", "/opt/reocam/incoming")
HOLD_DIRS = [d for d in os.environ.get(
    "GAPSTORE_HOLD_DIRS", "/opt/reocam/live-hold:/opt/reocam/var-only").split(":") if d]
# Our own hold marker. process-all.sh then leaves the camera out of the hourly
# archive and ftp_guard.sh stops deleting its clips on arrival; this module takes
# over ftp_guard's job for that camera (deletes clips from recorded hours, prunes
# stale live segments) whenever no live/VAR hold is present.
MARKER_DIR = os.environ.get("GAPSTORE_MARKER_DIR", HOLD_DIRS[0] if HOLD_DIRS else "/opt/reocam/live-hold")
MARKER_SUFFIX = ".gapstore"
FTPLIVE_DIR = os.environ.get("GAPSTORE_FTPLIVE_DIR", "/opt/replay/ftplive")
CAM_FTP = os.environ.get("GAPSTORE_CAM_FTP", "/opt/replay/ops/cam_ftp.py")
REPLAY_ENV_FILE = os.environ.get("GAPSTORE_REPLAY_ENV", "/opt/replay/env")
CAM_ENV_FILE = os.environ.get("GAPSTORE_CAM_ENV", "/opt/replay/env")
BUNNY_ENV_FILE = os.environ.get("GAPSTORE_BUNNY_ENV", "/etc/reocam/bunny.env")
COLLECTIONS_FILE = os.environ.get("GAPSTORE_COLLECTIONS", "/etc/reocam/collections.json")
FFMPEG = os.environ.get("GAPSTORE_FFMPEG", "/usr/bin/ffmpeg")    # 6.1.1; /opt/ffmpeg7 is mux-only
FFPROBE = os.environ.get("GAPSTORE_FFPROBE", "/usr/bin/ffprobe")
CAMERA_UTC_OFFSET_S = 3 * 3600
BUNNY_BASE = os.environ.get("GAPSTORE_BUNNY_BASE", "https://video.bunnycdn.com")

DEFAULTS = {
    "capBytes": 100 * 10**9,          # rolling cap for the whole store (all cameras)
    "minFreeBytes": 20 * 10**9,       # keep this free on the disk too (bookings pause < 12 GB)
    "cameras": {
        "cam1": {"ip": "192.168.66.101", "enabled": True},
        "cam2": {"ip": "192.168.66.102", "enabled": False},
        "cam3": {"ip": "192.168.66.103", "enabled": False},
    },
    "camUser": "admin",
    "stableSeconds": 45,              # a clip must keep its size this long ...
    "minAgeSeconds": 30,              # ... and be at least this old before it is taken
    "partialRatio": 0.95,             # delivered/requested below this -> "partial"
    "bunnyLibraryId": "694315",
    "bunnyPollSeconds": 3 * 3600,
    "bunnyPollInterval": 20,
}

TS_RE = re.compile(r"(\d{14})")


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULTS))
    try:
        with open(CONFIG_PATH) as fh:
            user = json.load(fh)
        for key, value in user.items():
            if key == "cameras" and isinstance(value, dict):
                for cam, cam_cfg in value.items():
                    cfg["cameras"].setdefault(cam, {}).update(cam_cfg)
            else:
                cfg[key] = value
    except FileNotFoundError:
        pass
    return cfg


def log(msg: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{stamp} {msg}", flush=True)


def norm_cam(cam: str) -> str:
    """App names cameras camera1/camera2; vps1 names them cam1/cam2."""
    m = re.fullmatch(r"(?:camera|cam)(\d+)", cam.strip().lower())
    if not m:
        raise ValueError(f"bad camera name {cam!r}")
    return f"cam{int(m.group(1))}"


def read_env_file(path: str) -> dict:
    """KEY=VALUE file, duplicate keys allowed (last wins, as /opt/replay/env relies on)."""
    out: dict = {}
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[7:]
                key, value = line.split("=", 1)
                out[key.strip()] = value.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out


# ── time helpers ─────────────────────────────────────────────────────────────

def camera_ts_to_utc(ts14: str) -> float:
    """'YYYYMMDDHHMMSS' in camera (Amman) wall time -> UTC epoch seconds."""
    naive = datetime.strptime(ts14, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    return naive.timestamp() - CAMERA_UTC_OFFSET_S


def amman_wall_to_utc(text: str) -> float:
    """'YYYY-MM-DD HH:MM[:SS]' Amman wall time -> UTC epoch seconds."""
    text = text.strip().replace("T", " ")
    fmt = "%Y-%m-%d %H:%M:%S" if text.count(":") == 2 else "%Y-%m-%d %H:%M"
    naive = datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
    return naive.timestamp() - CAMERA_UTC_OFFSET_S


def utc_to_amman_wall(epoch: float) -> str:
    return datetime.fromtimestamp(epoch + CAMERA_UTC_OFFSET_S, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def week_index_amman(epoch: float) -> int:
    """Index into a Reolink 168-char week table (Sunday first, 24 hours a day)."""
    wall = datetime.fromtimestamp(epoch + CAMERA_UTC_OFFSET_S, tz=timezone.utc)
    return ((wall.weekday() + 1) % 7) * 24 + wall.hour   # Python Monday=0 -> Reolink Sunday=0


# ── paths and index ──────────────────────────────────────────────────────────

def ensure_dirs() -> None:
    for sub in ("", "clips", "jobs", "state", "work"):
        os.makedirs(os.path.join(ROOT, sub), exist_ok=True)


def db() -> sqlite3.Connection:
    ensure_dirs()
    conn = sqlite3.connect(os.path.join(ROOT, "index.db"), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS clips (
        path TEXT PRIMARY KEY,
        cam TEXT NOT NULL,
        start_utc REAL NOT NULL,
        dur REAL NOT NULL,
        bytes INTEGER NOT NULL,
        width INTEGER, height INTEGER, vcodec TEXT,
        has_audio INTEGER NOT NULL,
        added REAL NOT NULL)""")
    conn.execute("CREATE INDEX IF NOT EXISTS clips_cam_start ON clips(cam, start_utc)")
    return conn


def unit_active(unit: str) -> bool:
    if not shutil.which("systemctl"):
        return False
    return subprocess.run(["systemctl", "is-active", "--quiet", unit], check=False,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def hold_present(cam: str) -> bool:
    """True while live, auto-pan or VAR owns the camera's FTP push: the same tests
    ftp_guard.sh makes (markers + the bunnylive/livepan units), minus our own marker."""
    for directory in HOLD_DIRS:
        for path in glob.glob(os.path.join(directory, cam + "*")):
            name = os.path.basename(path)
            if name.endswith(MARKER_SUFFIX) or name.endswith(".bunnylive-was-active"):
                continue
            # cam1 must not match cam10..; the marker is "<cam>" + a separator or the end.
            if name == cam or not name[len(cam)].isdigit():
                return True
    return unit_active(f"replay-bunnylive@{cam}") or unit_active(f"replay-livepan@{cam}")


def marker_path(cam: str) -> str:
    return os.path.join(MARKER_DIR, cam + MARKER_SUFFIX)


def ensure_markers(cfg: dict) -> None:
    for cam, cam_cfg in cfg["cameras"].items():
        path = marker_path(cam)
        if cam_cfg.get("enabled"):
            if not os.path.exists(path):
                os.makedirs(MARKER_DIR, exist_ok=True)
                with open(path, "w") as fh:
                    fh.write("off-schedule FTP gap store (/opt/reocam/gapstore)\n")
        elif os.path.exists(path):
            os.unlink(path)


def gap_table_path(cam: str) -> str:
    return os.path.join(ROOT, "state", f"{cam}.gaptable")


def read_gap_table(cam: str) -> str | None:
    try:
        with open(gap_table_path(cam)) as fh:
            table = fh.read().strip()
        return table if len(table) == 168 and set(table) <= {"0", "1"} else None
    except FileNotFoundError:
        return None


# ── ffprobe ──────────────────────────────────────────────────────────────────

def probe(path: str) -> dict | None:
    """Duration, geometry and audio presence; None while the MP4 is still being
    written (no moov atom yet), which is also how an unfinished upload looks."""
    try:
        out = subprocess.run(
            ["timeout", "20", FFPROBE, "-v", "error", "-show_entries",
             "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", path],
            capture_output=True, text=True, check=False)
    except OSError:
        return None
    if out.returncode != 0:
        return None
    try:
        data = json.loads(out.stdout or "{}")
        dur = float(data.get("format", {}).get("duration") or 0)
    except (ValueError, TypeError):
        return None
    if dur <= 0:
        return None
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if not video:
        return None
    has_audio = any(s.get("codec_type") == "audio" for s in data.get("streams", []))
    return {"dur": dur, "width": video.get("width"), "height": video.get("height"),
            "vcodec": video.get("codec_name"), "has_audio": has_audio}


def keyframe_at_or_before(path: str, t: float) -> float:
    """Latest video keyframe time <= t, so a stream-copied cut starts on it and the
    audio cut starts at the same instant (no A/V offset)."""
    if t <= 0.05:
        return 0.0
    lo = max(0.0, t - 12.0)
    out = subprocess.run(
        ["timeout", "30", FFPROBE, "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
         "-show_entries", "frame=pts_time,best_effort_timestamp_time", "-of", "csv=p=0",
         "-read_intervals", f"{lo:.3f}%{t + 0.05:.3f}", path],
        capture_output=True, text=True, check=False)
    best = 0.0 if lo == 0 else None
    for line in out.stdout.splitlines():
        for field in line.split(","):
            try:
                value = float(field)
            except ValueError:
                continue
            if value <= t + 1e-3 and (best is None or value > best):
                best = value
            break
    return best if best is not None else lo


# ── camera API (Reolink) ─────────────────────────────────────────────────────

class CameraError(RuntimeError):
    pass


class Camera:
    """Minimal Reolink client. Tries user/password first (no session-pool slot);
    falls back to a token session, which is always logged out in close()."""

    def __init__(self, ip: str, user: str, password: str, timeout: float = 15.0):
        self.base = f"http://{ip}/cgi-bin/api.cgi"
        self.user, self.password, self.timeout = user, password, timeout
        self.token: str | None = None
        self.use_token = False

    def _post(self, query: dict, body: list) -> list:
        url = self.base + "?" + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            data = json.loads(resp.read().decode() or "[]")
        if not isinstance(data, list) or not data:
            raise CameraError(f"unexpected reply: {str(data)[:200]}")
        return data

    def _login(self) -> None:
        reply = self._post({"cmd": "Login"}, [{"cmd": "Login", "param": {"User": {
            "Version": "0", "userName": self.user, "password": self.password}}}])
        token = (((reply[0].get("value") or {}).get("Token") or {}).get("name"))
        if not token:
            raise CameraError(f"login refused: {json.dumps(reply[0])[:200]}")
        self.token = token

    def call(self, cmd: str, action: int = 0, param: dict | None = None) -> dict:
        body = [{"cmd": cmd, "action": action, "param": param or {}}]
        if not self.use_token:
            reply = self._post({"cmd": cmd, "user": self.user, "password": self.password}, body)[0]
            if reply.get("code") == 0:
                return reply.get("value") or {}
            # rspCode -4 "param error" / -6 "please login first" = wrong auth form for this command
            self.use_token = True
        if not self.token:
            self._login()
        reply = self._post({"cmd": cmd, "token": self.token}, body)[0]
        if reply.get("code") != 0:
            raise CameraError(f"{cmd} failed: {json.dumps(reply.get('error') or reply)[:200]}")
        return reply.get("value") or {}

    def close(self) -> None:
        if self.token:
            try:
                self._post({"cmd": "Logout", "token": self.token}, [{"cmd": "Logout", "param": {}}])
            except Exception:  # noqa: BLE001 - best effort; the lease expires in 3600 s anyway
                pass
            self.token = None


def camera_for(cfg: dict, cam: str) -> Camera:
    env = read_env_file(CAM_ENV_FILE)
    password = os.environ.get("CAM_PASS") or env.get("CAM_PASS")
    if not password:
        raise CameraError(f"CAM_PASS not found in {CAM_ENV_FILE}")
    user = os.environ.get("CAM_USER") or env.get("CAM_USER") or cfg.get("camUser", "admin")
    return Camera(cfg["cameras"][cam]["ip"], user, password)


def timing_row(rec_value: dict) -> str:
    rec = rec_value.get("Rec") or {}
    table = (rec.get("schedule") or {}).get("table")
    row = table.get("TIMING") if isinstance(table, dict) else table
    if not isinstance(row, str) or len(row) != 168:
        raise CameraError("GetRecV20 has no 168-hour TIMING row")
    return row


def complement(row: str) -> str:
    return "".join("0" if c == "1" else "1" for c in row)


def ftp_with_schedule(ftp: dict, rows: dict, enable: int) -> dict:
    """Read-modify-write: the camera's own object with only the schedule gates changed.
    Set replaces the whole object, so nothing is built by hand. rows = {"TIMING": str,
    "*": str for every other trigger row}."""
    ftp = json.loads(json.dumps(ftp))
    ftp["enable"] = enable
    if "scheduleEnable" in ftp:
        ftp["scheduleEnable"] = enable
    schedule = ftp.get("schedule")
    if not isinstance(schedule, dict):
        raise CameraError("FTP object has no schedule to set")
    if "enable" in schedule:
        schedule["enable"] = enable
    table = schedule.get("table")
    if isinstance(table, dict):
        if "TIMING" not in table:
            raise CameraError("FTP schedule table has no TIMING row")
        for key in list(table):
            table[key] = rows["TIMING"] if key == "TIMING" else rows["*"]
    elif isinstance(table, str):
        schedule["table"] = rows["TIMING"]
    else:
        raise CameraError("FTP schedule table has an unknown shape")
    return ftp


def ftp_matches(ftp: dict, rows: dict, enable: int) -> bool:
    if int(ftp.get("enable", -1)) != enable:
        return False
    if "scheduleEnable" in ftp and int(ftp["scheduleEnable"]) != enable:
        return False
    schedule = ftp.get("schedule") or {}
    if "enable" in schedule and int(schedule["enable"]) != enable:
        return False
    table = schedule.get("table")
    if isinstance(table, dict):
        return table.get("TIMING") == rows["TIMING"] and all(
            v == rows["*"] for k, v in table.items() if k != "TIMING")
    return table == rows["TIMING"]


def wanted_ftp(cam: str, gap: str, now: float) -> tuple[str, dict, int]:
    """The camera FTP state this module wants right now.

    hold     live / auto-pan / VAR own the camera: every hour on (what cam_ftp.py
             'on' sets), so a live session that runs past a schedule boundary
             keeps its footage.
    gap-on   off-schedule hour, no hold: enable 1, schedule = the off hours.
    gap-off  recorded hour, no hold: enable 0, so livehold.py (which only turns
             FTP on when enable is 0) still switches it on for Start Live.
    """
    if hold_present(cam):
        return "hold", {"TIMING": "1" * 168, "*": "1" * 168}, 1
    rows = {"TIMING": gap, "*": "0" * 168}
    return ("gap-on", rows, 1) if gap[week_index_amman(now)] == "1" else ("gap-off", rows, 0)


def mode_path(cam: str) -> str:
    return os.path.join(ROOT, "state", f"{cam}.mode.json")


def sync_schedule(cfg: dict, cams: list[str], dry_run: bool = False, verify_every: float = 600.0,
                  now: float | None = None) -> int:
    """Every minute from cron. Talks to the camera only when the wanted state
    changes (hour boundary, hold appears or ends) or every verify_every seconds."""
    ensure_dirs()
    ensure_markers(cfg)   # before FTP goes on, so ftp_guard.sh never races the first clips
    failures = 0
    now = time.time() if now is None else now
    for cam in cams:
        cam_cfg = cfg["cameras"].get(cam) or {}
        if not cam_cfg.get("enabled"):
            continue
        try:
            with open(mode_path(cam)) as fh:
                last = json.load(fh)
        except (FileNotFoundError, ValueError):
            last = {}
        gap = read_gap_table(cam)
        if gap is not None:
            mode, _, _ = wanted_ftp(cam, gap, now)
            if not dry_run and last.get("mode") == mode and now - last.get("verifiedAt", 0) < verify_every:
                continue
        client = camera_for(cfg, cam)
        try:
            gap = complement(timing_row(client.call("GetRecV20", 0, {"channel": 0})))
            with open(gap_table_path(cam) + ".tmp", "w") as fh:
                fh.write(gap)
            os.replace(gap_table_path(cam) + ".tmp", gap_table_path(cam))
            mode, rows, enable = wanted_ftp(cam, gap, now)
            ftp = (client.call("GetFtpV20", 1, {}).get("Ftp")) or {}
            if not ftp:
                raise CameraError("GetFtpV20 returned no Ftp object")
            if mode == "hold" and int(ftp.get("enable", 0)) != 1:
                # the holder is still switching it on (or failed to); leave it to them
                log(f"[sched] {cam}: hold present, FTP not on yet; leaving it to live/VAR")
                continue
            if not ftp_matches(ftp, rows, enable):
                if dry_run:
                    log(f"[sched] {cam}: would set {mode} (enable={enable}, {rows['TIMING'].count('1')}/168 h) (dry run)")
                    continue
                if mode != "hold" and hold_present(cam):   # a live start raced us
                    log(f"[sched] {cam}: hold appeared, not writing")
                    continue
                client.call("SetFtpV20", 0, {"Ftp": ftp_with_schedule(ftp, rows, enable)})
                back = (client.call("GetFtpV20", 1, {}).get("Ftp")) or {}
                if not ftp_matches(back, rows, enable):
                    raise CameraError("SetFtpV20 returned success but the read-back differs")
                log(f"[sched] {cam}: FTP {mode} (enable={enable}, {rows['TIMING'].count('1')}/168 h, read back OK)")
            with open(mode_path(cam) + ".tmp", "w") as fh:
                json.dump({"mode": mode, "verifiedAt": now}, fh)
            os.replace(mode_path(cam) + ".tmp", mode_path(cam))
        except Exception as exc:  # noqa: BLE001
            failures += 1
            log(f"[sched] {cam}: FAILED {exc}")
        finally:
            client.close()
    return failures


# ── ingest and rolling cap ───────────────────────────────────────────────────

def clip_in_gap_hours(cam: str, start_utc: float, dur: float) -> bool | None:
    table = read_gap_table(cam)
    if table is None:
        return None
    t = start_utc
    end = start_utc + max(dur, 1.0)
    while t < end:
        if table[week_index_amman(t)] == "1":
            return True
        t = (int(t // 3600) + 1) * 3600
    return False


def candidate_files(cam: str) -> list[str]:
    base = os.path.join(INCOMING, cam, "upload")
    found = []
    # depth 3: the camera has been seen creating date subfolders (2026/09/...)
    for pattern in ("*.mp4", "*/*.mp4", "*/*/*.mp4", "*/*/*/*.mp4"):
        found.extend(glob.glob(os.path.join(base, pattern)))
    return sorted(found)


def ingest(cfg: dict) -> dict:
    ensure_dirs()
    conn = db()
    sizes_path = os.path.join(ROOT, "state", "sizes.json")
    try:
        with open(sizes_path) as fh:
            seen_sizes = json.load(fh)
    except (FileNotFoundError, ValueError):
        seen_sizes = {}
    now = time.time()
    new_sizes: dict = {}
    taken = discarded = 0
    ensure_markers(cfg)
    for cam, cam_cfg in cfg["cameras"].items():
        if not cam_cfg.get("enabled"):
            continue
        held = hold_present(cam)
        if not held:
            discarded += discard_strays(cam)
            prune_live_segments(cam)
        for src in candidate_files(cam):
            try:
                st = os.stat(src)
            except FileNotFoundError:
                continue
            key = f"{src}|{st.st_ino}"
            prev = seen_sizes.get(key)
            new_sizes[key] = [st.st_size, prev[1] if prev and prev[0] == st.st_size else now]
            stable_since = new_sizes[key][1]
            if st.st_size == 0 or now - st.st_mtime < cfg["minAgeSeconds"] or now - stable_since < cfg["stableSeconds"]:
                continue
            match = TS_RE.search(os.path.basename(src))
            if not match:
                continue
            info = probe(src)
            if info is None:
                # still being written (no moov yet) or broken; an abandoned upload is
                # dropped after 30 min, as ftp_guard.sh would have dropped it at once
                if not held and now - st.st_mtime > 1800:
                    os.unlink(src)
                    discarded += 1
                continue
            if info["dur"] < 1.0:
                if not held:
                    os.unlink(src)   # sub-second junk fragment
                continue
            start_utc = camera_ts_to_utc(match.group(1))
            in_gap = clip_in_gap_hours(cam, start_utc, info["dur"])
            if in_gap is False or (in_gap is None and held):
                # a recorded hour: the SD card has it. Live/VAR own their clips;
                # otherwise discard it, which is what ftp_guard.sh did before us.
                if not held:
                    os.unlink(src)
                    discarded += 1
                continue
            day = datetime.fromtimestamp(start_utc, tz=timezone.utc).strftime("%Y%m%d")
            dest_dir = os.path.join(ROOT, "clips", cam, day)
            os.makedirs(dest_dir, exist_ok=True)
            dest = os.path.join(dest_dir, f"{cam}_{int(start_utc)}_{match.group(1)}.mp4")
            if os.path.exists(dest):
                if not held:
                    os.unlink(src)
                continue
            if held:
                os.link(src, dest)   # live/VAR still read and later delete their copy
            else:
                os.rename(src, dest)  # same filesystem; nobody else needs it
            conn.execute(
                "INSERT OR REPLACE INTO clips VALUES (?,?,?,?,?,?,?,?,?,?)",
                (dest, cam, start_utc, info["dur"], st.st_size, info["width"], info["height"],
                 info["vcodec"], 1 if info["has_audio"] else 0, now))
            conn.commit()
            trim_overlaps(conn, cam, start_utc)
            new_sizes.pop(key, None)
            taken += 1
            log(f"[ingest] {cam}: {os.path.basename(src)} -> store "
                f"({info['dur']:.0f}s, {st.st_size / 1e6:.0f} MB, audio={'yes' if info['has_audio'] else 'NO'}"
                f"{', linked during hold' if held else ''})")
    with open(sizes_path + ".tmp", "w") as fh:
        json.dump(new_sizes, fh)
    os.replace(sizes_path + ".tmp", sizes_path)
    pruned = prune(cfg, conn)
    conn.close()
    if discarded:
        log(f"[ingest] discarded {discarded} clip(s) from recorded hours / dead uploads")
    return {"taken": taken, "pruned": pruned, "discarded": discarded}


def discard_strays(cam: str) -> int:
    """Pictures are never wanted (ftp_guard.sh deleted them too)."""
    n = 0
    base = os.path.join(INCOMING, cam, "upload")
    for pattern in ("*.jpg", "*/*.jpg", "*/*/*.jpg"):
        for path in glob.glob(os.path.join(base, pattern)):
            try:
                os.unlink(path)
                n += 1
            except OSError:
                pass
    for depth in ("*/*/*", "*/*", "*"):   # empty date subfolders, deepest first
        for path in glob.glob(os.path.join(base, depth)):
            if os.path.isdir(path):
                try:
                    os.rmdir(path)
                except OSError:
                    pass
    return n


def prune_live_segments(cam: str) -> None:
    """ftp_guard.sh's other job: live/VAR segments older than an hour, when nothing is live."""
    cutoff = time.time() - 3600
    for sub in ("hevc", "hls"):
        for pattern in ("*.m4s", "*.ts"):
            for path in glob.glob(os.path.join(FTPLIVE_DIR, cam, sub, pattern)):
                try:
                    if os.path.getmtime(path) < cutoff:
                        os.unlink(path)
                except OSError:
                    pass


def trim_overlaps(conn: sqlite3.Connection, cam: str, start_utc: float, reach: float = 600) -> int:
    """The camera's clips overlap: each repeats the first ~4 s of the next one
    (measured 2026-10-30: identical packets, next clip frame 0 == previous clip
    frame 200 of 280). Cut the stored neighbour clips back to where the following
    clip starts, by stream copy, so the store holds each second once (~30% more
    footage in the same 100 GB) and joins never repeat footage."""
    rows = conn.execute(
        "SELECT path, start_utc, dur FROM clips WHERE cam=? AND start_utc BETWEEN ? AND ? ORDER BY start_utc",
        (cam, start_utc - reach, start_utc + reach)).fetchall()
    pins = None
    trimmed = 0
    for (path, s0, d0), (_, s1, _) in zip(rows, rows[1:]):
        keep = s1 - s0
        if d0 - keep < 0.5 or keep < 1.0:
            continue
        if pins is None:
            pins = pinned_paths()
        if path in pins:
            continue
        tmp = path + ".trim.mp4"
        try:
            run_ffmpeg(["-i", path, "-t", f"{keep:.3f}", "-map", "0", "-c", "copy",
                        "-movflags", "+faststart", tmp], timeout=120)
            info = probe(tmp)
            if not info or abs(info["dur"] - keep) > 0.6:
                raise RuntimeError(f"trim gave {info}")
            os.replace(tmp, path)
            conn.execute("UPDATE clips SET dur=?, bytes=? WHERE path=?", (info["dur"], os.path.getsize(path), path))
            conn.commit()
            trimmed += 1
        except Exception as exc:  # noqa: BLE001 - an untrimmed clip is still correct footage
            log(f"[ingest] could not trim overlap of {os.path.basename(path)}: {exc}")
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
    return trimmed


def pinned_paths() -> set[str]:
    """Clips a running pull job is reading; never pruned under it."""
    pins: set[str] = set()
    for pin in glob.glob(os.path.join(ROOT, "jobs", "*.pins")):
        job_path = pin[:-5] + ".json"
        try:
            with open(job_path) as fh:
                job = json.load(fh)
        except (FileNotFoundError, ValueError):
            continue
        if job.get("status") in ("done", "partial", "failed", "cancelled"):
            continue
        with open(pin) as fh:
            pins.update(line.strip() for line in fh if line.strip())
    return pins


def prune(cfg: dict, conn: sqlite3.Connection) -> int:
    """Oldest first, until the store is under capBytes and the disk keeps minFreeBytes."""
    # forget rows whose file vanished (e.g. removed by hand)
    for (path,) in conn.execute("SELECT path FROM clips").fetchall():
        if not os.path.exists(path):
            conn.execute("DELETE FROM clips WHERE path=?", (path,))
    conn.commit()
    total = conn.execute("SELECT COALESCE(SUM(bytes),0) FROM clips").fetchone()[0]
    free = shutil.disk_usage(ROOT).free
    pins = pinned_paths()
    removed = 0
    if total <= cfg["capBytes"] and free >= cfg["minFreeBytes"]:
        return 0
    for path, size in conn.execute("SELECT path, bytes FROM clips ORDER BY start_utc").fetchall():
        if total <= cfg["capBytes"] and free >= cfg["minFreeBytes"]:
            break
        if path in pins:
            continue
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        conn.execute("DELETE FROM clips WHERE path=?", (path,))
        total -= size
        free += size
        removed += 1
    conn.commit()
    for day_dir in glob.glob(os.path.join(ROOT, "clips", "*", "*")):
        try:
            os.rmdir(day_dir)   # only succeeds when empty
        except OSError:
            pass
    if removed:
        log(f"[prune] removed {removed} oldest clip(s); store {total / 1e9:.1f} GB, disk free {free / 1e9:.1f} GB")
    return removed


# ── availability ─────────────────────────────────────────────────────────────

def clips_between(conn: sqlite3.Connection, cam: str, start_utc: float, end_utc: float) -> list[dict]:
    rows = conn.execute(
        "SELECT path, start_utc, dur, bytes, width, height, has_audio FROM clips "
        "WHERE cam=? AND start_utc < ? AND start_utc + dur > ? ORDER BY start_utc",
        (cam, end_utc, start_utc)).fetchall()
    return [{"path": r[0], "start": r[1], "dur": r[2], "bytes": r[3], "width": r[4], "height": r[5],
             "audio": bool(r[6])} for r in rows]


def merged_spans(clips: list[dict], start_utc: float, end_utc: float) -> list[tuple[float, float]]:
    spans: list[list[float]] = []
    for clip in clips:
        a, b = max(clip["start"], start_utc), min(clip["start"] + clip["dur"], end_utc)
        if b <= a:
            continue
        if spans and a <= spans[-1][1] + 1.5:   # camera clips butt up to within ~1 s
            spans[-1][1] = max(spans[-1][1], b)
        else:
            spans.append([a, b])
    return [(a, b) for a, b in spans]


def coverage(cam: str, start_utc: float, end_utc: float) -> dict:
    conn = db()
    try:
        spans = merged_spans(clips_between(conn, cam, start_utc, end_utc), start_utc, end_utc)
    finally:
        conn.close()
    covered = sum(b - a for a, b in spans)
    gaps, cursor = [], start_utc
    for a, b in spans:
        if a - cursor > 1.5:
            gaps.append({"start": utc_to_amman_wall(cursor), "end": utc_to_amman_wall(a)})
        cursor = b
    if end_utc - cursor > 1.5:
        gaps.append({"start": utc_to_amman_wall(cursor), "end": utc_to_amman_wall(end_utc)})
    return {"requestedSeconds": round(end_utc - start_utc, 1), "coveredSeconds": round(covered, 1), "gaps": gaps}


def available(cfg: dict, cam: str, date: str | None = None) -> dict:
    conn = db()
    try:
        bounds = conn.execute("SELECT MIN(start_utc), MAX(start_utc + dur), COALESCE(SUM(bytes),0), COUNT(*) "
                              "FROM clips WHERE cam=?", (cam,)).fetchone()
        used = conn.execute("SELECT COALESCE(SUM(bytes),0) FROM clips").fetchone()[0]
        out: dict = {
            "cam": cam, "source": "ftp",
            "earliest": utc_to_amman_wall(bounds[0]) if bounds[0] else None,
            "latest": utc_to_amman_wall(bounds[1]) if bounds[1] else None,
            "camBytes": bounds[2], "camClips": bounds[3],
            "usedBytes": used, "capBytes": cfg["capBytes"],
            "gapHoursPerWeek": (read_gap_table(cam) or "").count("1") or None,
        }
        if date:
            day_start = amman_wall_to_utc(f"{date} 00:00:00")
            clips = clips_between(conn, cam, day_start, day_start + 86400)
            hours = []
            for hour in range(24):
                h0 = day_start + hour * 3600
                spans = merged_spans(clips, h0, h0 + 3600)
                secs = sum(b - a for a, b in spans)
                if secs >= 60:
                    in_hour = [c for c in clips if c["start"] < h0 + 3600 and c["start"] + c["dur"] > h0]
                    hours.append({"hour": hour, "seconds": round(secs), "segments": len(in_hour),
                                  "bytes": sum(c["bytes"] for c in in_hour), "source": "ftp"})
            out.update({"date": date, "hours": hours, "totalSegments": len(clips)})
            window = clips
        else:
            window = clips_between(conn, cam, time.time() - 48 * 3600, time.time() + 3600)
        spans = merged_spans(window, window[0]["start"], window[-1]["start"] + window[-1]["dur"]) if window else []
        out["clips"] = [{"start": utc_to_amman_wall(a), "end": utc_to_amman_wall(b),
                         "seconds": round(b - a), "bytes": None} for a, b in spans]
        out["note"] = "Off-schedule FTP footage kept on vps1 (rolling cap)."
        return out
    finally:
        conn.close()


# ── pull jobs ────────────────────────────────────────────────────────────────

def job_path(job_id: str) -> str:
    if not re.fullmatch(r"gs-[0-9a-f]{12}", job_id):
        raise ValueError("bad job id")
    return os.path.join(ROOT, "jobs", f"{job_id}.json")


def read_job(job_id: str) -> dict | None:
    try:
        with open(job_path(job_id)) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


def write_job(job: dict) -> None:
    job["updatedAt"] = datetime.now(timezone.utc).isoformat()
    path = job_path(job["jobId"])
    with open(path + ".tmp", "w") as fh:
        json.dump(job, fh)
    os.replace(path + ".tmp", path)


def update_job(job_id: str, **fields) -> dict:
    job = read_job(job_id) or {"jobId": job_id}
    if job.get("status") == "cancelled" and fields.get("status") not in (None, "cancelled"):
        raise SystemExit(0)    # cancelled while running: stop quietly
    job.update(fields)
    write_job(job)
    return job


def create_job(cam: str, start: str, end: str, title: str) -> dict:
    ensure_dirs()
    start_utc, end_utc = amman_wall_to_utc(start), amman_wall_to_utc(end)
    if end_utc <= start_utc:
        raise ValueError("end must be after start")
    if end_utc - start_utc > 6 * 3600:
        raise ValueError("windows are limited to 6 hours")
    cov = coverage(cam, start_utc, end_utc)
    if cov["coveredSeconds"] < 5:
        raise LookupError("No off-schedule FTP footage on the server for that window")
    job = {
        "jobId": "gs-" + uuid.uuid4().hex[:12], "cam": cam, "cameraId": cam.replace("cam", "camera"),
        "source": "ftp", "engine": "ftp", "status": "queued", "phase": "search", "progress": 0,
        "title": title, "start": start, "end": end,
        "requestedSeconds": cov["requestedSeconds"], "coveredSeconds": cov["coveredSeconds"],
        "gaps": cov["gaps"], "note": "Queued", "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    write_job(job)
    return job


def launch_job(job_id: str) -> None:
    """Own transient unit, so a control-API restart never kills a running pull."""
    me = os.path.abspath(__file__)
    cmd = ["systemd-run", f"--unit=gapstore-pull-{job_id}", "--collect", "--property=Nice=10",
           "--property=MemoryMax=3G", "--setenv", f"GAPSTORE_ROOT={ROOT}",
           "--setenv", f"GAPSTORE_CONFIG={CONFIG_PATH}", sys.executable, me, "pull", job_id]
    if shutil.which("systemd-run"):
        subprocess.run(cmd, check=True, capture_output=True)
    else:   # dev / test machines
        subprocess.Popen([sys.executable, me, "pull", job_id], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cancel_job(job_id: str) -> dict | None:
    job = read_job(job_id)
    if not job:
        return None
    if job.get("status") in ("done", "partial", "failed", "cancelled"):
        return job
    job["status"], job["note"] = "cancelled", "Cancelled"
    write_job(job)
    if shutil.which("systemctl"):
        subprocess.run(["systemctl", "stop", f"gapstore-pull-{job_id}"], capture_output=True)
    return job


def run_ffmpeg(args: list[str], timeout: int) -> None:
    proc = subprocess.run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error", "-y", *args],
                          capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "ffmpeg failed").strip()[-400:])


def bunny_settings(cfg: dict) -> dict:
    env = read_env_file(BUNNY_ENV_FILE)
    env.update({k: v for k, v in os.environ.items() if k.startswith("BUNNY")})
    key = next((env[k] for k in ("BUNNY_STREAM_API_KEY", "BUNNY_STREAM_KEY", "BUNNY_LIBRARY_API_KEY",
                                 "BUNNY_API_KEY") if env.get(k)), None)
    lib = next((env[k] for k in ("BUNNY_LIBRARY_ID", "BUNNY_STREAM_LIBRARY_ID", "BUNNY_STREAM_LIBRARY",
                                 "LIBRARY_ID") if env.get(k)), None) or str(cfg["bunnyLibraryId"])
    if not key:
        raise RuntimeError(f"no Bunny Stream key in {BUNNY_ENV_FILE}")
    cdn = env.get("BUNNY_STREAM_CDN_HOST") or read_env_file(REPLAY_ENV_FILE).get("BUNNY_STREAM_HOST")
    return {"key": key, "lib": lib, "cdn": cdn}


def bunny_collection(cam: str) -> str | None:
    try:
        with open(COLLECTIONS_FILE) as fh:
            data = json.load(fh)
    except (FileNotFoundError, ValueError):
        return None
    entry = data.get(cam) or data.get(cam.replace("cam", "camera"))
    if isinstance(entry, dict):
        entry = entry.get("guid") or entry.get("id")
    return entry if isinstance(entry, str) else None


def bunny_api(method: str, url: str, key: str, body: dict | None = None, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"AccessKey": key, "Accept": "application/json",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def bunny_upload(path: str, url: str, key: str) -> None:
    """Streamed upload (curl -T); the key goes in on stdin, never argv where ps shows it."""
    proc = subprocess.run(
        ["curl", "-sS", "--fail", "-X", "PUT", "-T", path, "-K", "-", url,
         "-H", "Content-Type: application/octet-stream", "--max-time", "7200"],
        input=f'header = "AccessKey: {key}"\n', capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"upload failed: {(proc.stderr or proc.stdout).strip()[-300:]}")


def assemble_concat(job_id: str, clips: list[dict], start_utc: float, end_utc: float,
                    listing: str, out: str) -> float:
    """Single-pass cut, as ftp_window_clip.py does it: the concat demuxer over the
    stored clips, input-seeked and stream-copied. Video and the camera's own AAC
    audio go through untouched (no re-encode, no drift), and the only extra disk
    is the output. The store has already cut each clip back to where the next one
    starts (trim_overlaps); an `outpoint` covers any clip that wasn't."""
    covered = 0.0
    with open(listing, "w") as fh:
        for i, c in enumerate(clips):
            end = c["start"] + c["dur"]
            fh.write("file '%s'\n" % c["path"].replace("'", "'\\''"))
            if i + 1 < len(clips) and clips[i + 1]["start"] < end - 0.05:
                end = clips[i + 1]["start"]
                fh.write(f"outpoint {end - c['start']:.3f}\n")
            covered += max(0.0, min(end, end_utc) - max(c["start"], start_utc))
    off = max(0.0, start_utc - clips[0]["start"])
    update_job(job_id, phase="assemble", progress=10,
               note=f"Joining {len(clips)} clips ({covered / 60:.0f} min, video + audio)")
    # No -fflags +genpts / -avoid_negative_ts make_zero here (ftp_window_clip.py has
    # both): measured on vps1 2026-10-30, with them ffmpeg 6.1 and 7.0 both ignore
    # -t and start the video 1.9 s after the audio. Without them: exact length,
    # both streams from 0.
    run_ffmpeg(["-f", "concat", "-safe", "0", "-ss", f"{off:.3f}", "-i", listing,
                "-t", f"{covered:.3f}", "-map", "0:v:0", "-map", "0:a:0", "-c", "copy",
                "-tag:v", "hvc1" if (probe(clips[0]["path"]) or {}).get("vcodec") == "hevc" else "avc1",
                "-movflags", "+faststart", out], timeout=3600)
    info = probe(out)
    starts = stream_starts(out)
    if len(set(round(v, 2) for v in starts.values())) > 1 and max(starts.values()) - min(starts.values()) > 0.06:
        raise RuntimeError(f"video and audio start apart in the joined file: {starts}")
    info = probe(out)
    if not info or not info["has_audio"] or info["dur"] < 0.9 * covered or info["dur"] > covered + 3:
        raise RuntimeError(f"joined file failed validation (wanted ~{covered:.0f}s, got {info})")
    return info["dur"]


def stream_starts(path: str) -> dict:
    out = subprocess.run(["timeout", "20", FFPROBE, "-v", "error", "-show_entries", "stream=codec_type,start_time",
                          "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    starts = {}
    for line in out.splitlines():
        kind, _, start = line.partition(",")
        try:
            starts[kind] = float(start)
        except ValueError:
            pass
    return starts


def assemble_parts(job_id: str, clips: list[dict], start_utc: float, end_utc: float, work: str,
                   listing: str, out: str, skipped: list) -> float:
    """Fallback when some clip has no audio track: cut each clip on its own, give
    silent clips a silent track, then join. Slower, and only used when needed."""
    update_job(job_id, phase="assemble", progress=5, note=f"Cutting {len(clips)} clip(s)")
    parts, total = [], 0.0
    for i, c in enumerate(clips):
        a = max(0.0, start_utc - c["start"])
        b = min(c["dur"], end_utc - c["start"])
        if i + 1 < len(clips) and clips[i + 1]["start"] < c["start"] + b:
            b = clips[i + 1]["start"] - c["start"]   # the next clip repeats the rest
        if b - a < 1.0:
            continue
        a = keyframe_at_or_before(c["path"], a) if a > 0 else 0.0
        part = os.path.join(work, f"p{i:04d}.mp4")
        args = ["-ss", f"{a:.3f}", "-i", c["path"]]
        if not c["audio"]:
            args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono"]
        args += ["-t", f"{b - a:.3f}", "-map", "0:v:0", "-map", "0:a:0" if c["audio"] else "1:a:0",
                 "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "1",
                 "-af", "aresample=async=1:first_pts=0", "-avoid_negative_ts", "make_zero",
                 "-movflags", "+faststart", part]
        try:
            run_ffmpeg(args, timeout=900)
        except Exception as exc:  # noqa: BLE001 - one bad clip must not sink the window
            log(f"[pull {job_id}] skipping {os.path.basename(c['path'])}: {exc}")
            skipped.append(c)
            continue
        info = probe(part)
        if not info:
            skipped.append(c)
            continue
        parts.append(part)
        total += info["dur"]
        update_job(job_id, progress=5 + int(55 * (i + 1) / len(clips)),
                   note=f"Cut {i + 1}/{len(clips)} clips ({total / 60:.0f} min)")
    if not parts:
        raise RuntimeError("no usable clips in this window")
    with open(listing, "w") as fh:
        fh.writelines(f"file '{p}'\n" for p in parts)
    update_job(job_id, phase="assemble", progress=62, note="Joining clips")
    run_ffmpeg(["-f", "concat", "-safe", "0", "-i", listing, "-map", "0:v:0", "-map", "0:a:0",
                "-c", "copy", "-tag:v", "hvc1" if (probe(parts[0]) or {}).get("vcodec") == "hevc" else "avc1",
                "-movflags", "+faststart", out], timeout=3600)
    info = probe(out)
    if not info or info["dur"] < 0.9 * total or not info["has_audio"]:
        raise RuntimeError(f"joined file failed validation ({info})")
    for p in parts:
        os.unlink(p)
    return info["dur"]


def pull(cfg: dict, job_id: str) -> None:
    job = read_job(job_id)
    if not job:
        raise SystemExit(f"no job {job_id}")
    cam = job["cam"]
    start_utc, end_utc = amman_wall_to_utc(job["start"]), amman_wall_to_utc(job["end"])
    work = os.path.join(ROOT, "work", job_id)
    os.makedirs(work, exist_ok=True)
    pins = job_path(job_id)[:-5] + ".pins"
    try:
        update_job(job_id, status="running", phase="search", progress=2, note="Finding footage on the server")
        conn = db()
        clips = clips_between(conn, cam, start_utc, end_utc)
        conn.close()
        with open(pins, "w") as fh:
            fh.write("\n".join(c["path"] for c in clips))
        clips = [c for c in clips if os.path.exists(c["path"])]
        if not clips:
            raise RuntimeError("the footage for this window has rolled out of the store")
        # geometry guard: 8K (7680x2160) is rejected by Bunny with no upstream symptom
        geoms: dict = {}
        for c in clips:
            geoms[(c["width"], c["height"])] = geoms.get((c["width"], c["height"]), 0) + c["dur"]
        main_geom = max(geoms, key=geoms.get)
        skipped = [c for c in clips if (c["width"], c["height"]) != main_geom]
        clips = [c for c in clips if (c["width"], c["height"]) == main_geom]
        if main_geom[0] and main_geom[0] > 4096:
            raise RuntimeError(f"footage is {main_geom[0]}x{main_geom[1]} (8K mode?); Bunny rejects it")

        out = os.path.join(work, "out.mp4")
        listing = os.path.join(work, "parts.txt")
        if all(c["audio"] for c in clips):
            delivered = assemble_concat(job_id, clips, start_utc, end_utc, listing, out)
        else:
            delivered = assemble_parts(job_id, clips, start_utc, end_utc, work, listing, out, skipped)

        update_job(job_id, phase="upload", status="running", progress=65,
                   note=f"Uploading {os.path.getsize(out) / 1e9:.1f} GB to Bunny", durationSeconds=round(delivered, 1))
        bunny = bunny_settings(cfg)
        body = {"title": job["title"]}
        collection = bunny_collection(cam)
        if collection:
            body["collectionId"] = collection
        created = bunny_api("POST", f"{BUNNY_BASE}/library/{bunny['lib']}/videos", bunny["key"], body)
        guid = created.get("guid")
        if not guid:
            raise RuntimeError(f"Bunny did not create a video: {str(created)[:200]}")
        update_job(job_id, videoId=guid)
        bunny_upload(out, f"{BUNNY_BASE}/library/{bunny['lib']}/videos/{guid}", bunny["key"])
        update_job(job_id, phase="encode", progress=85, note="Bunny is processing the video")

        # HTTP 200 is not success: poll for status 4 (5 = failed)
        deadline = time.time() + cfg["bunnyPollSeconds"]
        while True:
            meta = bunny_api("GET", f"{BUNNY_BASE}/library/{bunny['lib']}/videos/{guid}", bunny["key"])
            status = meta.get("status")
            if status == 4:
                break
            if status in (5, 6):
                raise RuntimeError(f"Bunny failed to process the video (status {status})")
            if time.time() > deadline:
                raise RuntimeError("Bunny is still processing after the time limit")
            update_job(job_id, progress=min(98, 85 + int(meta.get("encodeProgress") or 0) // 8))
            time.sleep(cfg["bunnyPollInterval"])
        os.unlink(out)

        ratio = delivered / max(1.0, job["requestedSeconds"])
        final = "done" if ratio >= cfg["partialRatio"] else "partial"
        note = "Ready" if final == "done" else (
            f"Ready - {delivered / 60:.0f} of {job['requestedSeconds'] / 60:.0f} min were on the server")
        if skipped:
            note += f"; {len(skipped)} clip(s) skipped"
        playback = f"https://{bunny['cdn']}/{guid}/playlist.m3u8" if bunny.get("cdn") else None
        update_job(job_id, status=final, phase="done", progress=100, note=note, durationSeconds=round(delivered, 1),
                   deliveredSeconds=round(delivered, 1), playback=playback, hasAudio=True)
        log(f"[pull {job_id}] {final}: {delivered:.0f}s -> {guid}")
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        log(f"[pull {job_id}] FAILED {exc}")
        try:
            update_job(job_id, status="failed", phase="failed", error=str(exc), note=str(exc))
        except SystemExit:
            pass
    finally:
        shutil.rmtree(work, ignore_errors=True)
        try:
            os.unlink(pins)
        except FileNotFoundError:
            pass


def list_jobs(limit: int = 50) -> list[dict]:
    jobs = []
    for path in glob.glob(os.path.join(ROOT, "jobs", "gs-*.json")):
        try:
            with open(path) as fh:
                jobs.append(json.load(fh))
        except (ValueError, OSError):
            continue
    jobs.sort(key=lambda j: j.get("createdAt", ""), reverse=True)
    return jobs[:limit]


def status(cfg: dict) -> dict:
    conn = db()
    try:
        per_cam = {cam: {"clips": n, "bytes": b, "earliest": utc_to_amman_wall(lo) if lo else None,
                         "latest": utc_to_amman_wall(hi) if hi else None,
                         "hold": hold_present(cam), "gapHoursPerWeek": (read_gap_table(cam) or "").count("1") or None}
                   for cam, n, b, lo, hi in conn.execute(
                       "SELECT cam, COUNT(*), SUM(bytes), MIN(start_utc), MAX(start_utc+dur) FROM clips GROUP BY cam")}
    finally:
        conn.close()
    used = sum(v["bytes"] or 0 for v in per_cam.values())
    return {"usedBytes": used, "capBytes": cfg["capBytes"], "diskFreeBytes": shutil.disk_usage(ROOT).free,
            "cameras": per_cam, "enabled": [c for c, v in cfg["cameras"].items() if v.get("enabled")]}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sync-schedule")
    s.add_argument("--cam")
    s.add_argument("--dry-run", action="store_true")
    sub.add_parser("ingest")
    sub.add_parser("retrim")
    d = sub.add_parser("disable")
    d.add_argument("cam")
    p = sub.add_parser("pull")
    p.add_argument("job_id")
    sub.add_parser("status")
    a = sub.add_parser("available")
    a.add_argument("cam")
    a.add_argument("date", nargs="?")
    args = parser.parse_args(argv)
    cfg = load_config()
    if args.cmd == "sync-schedule":
        cams = [norm_cam(args.cam)] if args.cam else list(cfg["cameras"])
        return 1 if sync_schedule(cfg, cams, args.dry_run) else 0
    if args.cmd == "disable":
        cam = norm_cam(args.cam)
        try:
            os.unlink(marker_path(cam))
        except FileNotFoundError:
            pass
        if hold_present(cam):
            log(f"[disable] {cam}: live/VAR is on; it will switch FTP off when it stops")
        else:
            out = subprocess.run([CAM_FTP, cam, "off"], capture_output=True, text=True)
            log(f"[disable] {cam}: cam_ftp off -> {(out.stdout or out.stderr).strip()[-200:]}")
        log(f"[disable] {cam}: set \"enabled\": false for {cam} in {CONFIG_PATH} or cron re-enables it")
        return 0
    if args.cmd == "retrim":   # one-off: trim overlaps across everything already stored
        conn = db()
        for cam in cfg["cameras"]:
            print(cam, trim_overlaps(conn, cam, time.time(), reach=400 * 86400))
        conn.close()
        return 0
    if args.cmd == "ingest":
        print(json.dumps(ingest(cfg)))
        return 0
    if args.cmd == "pull":
        pull(cfg, args.job_id)
        return 0
    if args.cmd == "status":
        print(json.dumps(status(cfg), indent=2))
        return 0
    if args.cmd == "available":
        print(json.dumps(available(cfg, norm_cam(args.cam), args.date), indent=2))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
