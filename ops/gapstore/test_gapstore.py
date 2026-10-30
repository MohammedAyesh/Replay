#!/usr/bin/env python3
"""Local tests for the gap store: synthetic camera clips (HEVC + AAC, flash and
beep every 5 s), a fake Reolink camera and a fake Bunny Stream API.

    python3 ops/gapstore/test_gapstore.py
"""
from __future__ import annotations

import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="gapstore-test-")
os.environ.update({
    "GAPSTORE_ROOT": os.path.join(TMP, "store"),
    "GAPSTORE_INCOMING": os.path.join(TMP, "incoming"),
    "GAPSTORE_HOLD_DIRS": os.path.join(TMP, "live-hold") + ":" + os.path.join(TMP, "var-only"),
    "GAPSTORE_CONFIG": os.path.join(TMP, "gapstore.json"),
    "GAPSTORE_CAM_ENV": os.path.join(TMP, "env"),
    "GAPSTORE_BUNNY_ENV": os.path.join(TMP, "bunny.env"),
    "GAPSTORE_COLLECTIONS": os.path.join(TMP, "collections.json"),
    "GAPSTORE_FFMPEG": shutil.which("ffmpeg") or "ffmpeg",
    "GAPSTORE_FFPROBE": shutil.which("ffprobe") or "ffprobe",
    "GAPSTORE_REPLAY_ENV": os.path.join(TMP, "env"),
    "GAPSTORE_FTPLIVE_DIR": os.path.join(TMP, "ftplive"),
    "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
})
sys.path.insert(0, HERE)
import gapstore as gs  # noqa: E402

FPS = 20


def make_clip(path: str, seconds: int, audio: bool = True, size: str = "1024x288") -> None:
    """Flash (video) and beep (audio) for 50 ms at every 5 s of clip time."""
    vf = "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,5),0.05)'"
    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=black:s={size}:r={FPS}:d={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i",
                 f"aevalsrc='0.8*sin(2*PI*1000*t)*lt(mod(t,5),0.05)':s=16000:d={seconds}"]
    args += ["-vf", vf, "-c:v", "libx265", "-x265-params", f"keyint={2 * FPS}:min-keyint={2 * FPS}:bframes=0:log-level=none",
             "-preset", "ultrafast", "-tag:v", "hvc1"]
    if audio:
        args += ["-c:a", "aac", "-ac", "1"]
    args += [path]
    subprocess.run(args, check=True)


def flashes_and_beeps(path: str) -> tuple[list[float], list[float]]:
    v = subprocess.run(["ffprobe", "-v", "error", "-f", "lavfi", "-i",
                        f"movie='{path}',signalstats", "-show_entries", "frame=pts_time:frame_tags=lavfi.signalstats.YAVG",
                        "-of", "csv=p=0"], capture_output=True, text=True).stdout
    flashes, prev = [], False
    for line in v.splitlines():
        parts = line.split(",")
        if len(parts) < 2:
            continue
        bright = float(parts[1]) > 128
        if bright and not prev:
            flashes.append(float(parts[0]))
        prev = bright
    a = subprocess.run(["ffmpeg", "-v", "info", "-i", path, "-map", "0:a:0", "-af",
                        "silencedetect=n=-30dB:d=0.02", "-f", "null", "-"], capture_output=True, text=True).stderr
    beeps = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", a)]
    return flashes, beeps


# ── fakes ────────────────────────────────────────────────────────────────────

class FakeCamera(http.server.BaseHTTPRequestHandler):
    """4518-like: user/password works for GetRecV20 but FTP commands want a token."""
    state = {
        "timing": ("0" * 6 + "1" * 16 + "0" * 2) * 7,   # records 06-22, off 22-06
        "ftp": {"enable": 0, "scheduleEnable": 0, "server": "169.58.73.17", "remoteDir": "/upload",
                "schedule": {"channel": 0, "table": {"TIMING": "0" * 168, "MD": "1" * 168}}},
        "logins": 0, "logouts": 0, "sets": 0,
    }

    def log_message(self, *a):  # quiet
        pass

    def do_POST(self):
        from urllib.parse import parse_qs, urlparse
        q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"[]")
        cmd = q.get("cmd")
        st = self.state
        def reply(obj):
            data = json.dumps([obj]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        if cmd == "Login":
            st["logins"] += 1
            return reply({"cmd": cmd, "code": 0, "value": {"Token": {"name": "tok123", "leaseTime": 3600}}})
        if cmd == "Logout":
            st["logouts"] += 1
            return reply({"cmd": cmd, "code": 0, "value": {}})
        token_ok = q.get("token") == "tok123"
        pw_ok = q.get("user") == "admin" and q.get("password") == "pw"
        if cmd == "GetRecV20" and (pw_ok or token_ok):
            return reply({"cmd": cmd, "code": 0, "value": {"Rec": {"enable": 1, "schedule": {
                "channel": 0, "table": {"TIMING": st["timing"], "MD": "1" * 168}}}}})
        if cmd in ("GetFtpV20", "SetFtpV20") and not token_ok:
            return reply({"cmd": cmd, "code": 1, "error": {"rspCode": -4, "detail": "param error"}})
        if cmd == "GetFtpV20":
            return reply({"cmd": cmd, "code": 0, "value": {"Ftp": json.loads(json.dumps(st["ftp"]))}})
        if cmd == "SetFtpV20":
            st["sets"] += 1
            st["ftp"] = body[0]["param"]["Ftp"]
            return reply({"cmd": cmd, "code": 0, "value": {"rspCode": 200}})
        return reply({"cmd": cmd, "code": 1, "error": {"rspCode": -9}})


class FakeBunny(http.server.BaseHTTPRequestHandler):
    videos: dict = {}

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        assert self.headers.get("AccessKey") == "streamkey"
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        guid = f"guid-{len(self.videos) + 1}"
        self.videos[guid] = {"title": body["title"], "collectionId": body.get("collectionId"), "status": 0}
        self._json({"guid": guid})

    def do_PUT(self):
        assert self.headers.get("AccessKey") == "streamkey"
        guid = self.path.rsplit("/", 1)[-1]
        length = int(self.headers.get("Content-Length", 0))
        out = os.path.join(TMP, f"uploaded-{guid}.mp4")
        with open(out, "wb") as fh:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)
        self.videos[guid].update(status=1, file=out)
        self._json({"success": True})

    def do_GET(self):
        guid = self.path.rsplit("/", 1)[-1]
        v = self.videos[guid]
        v["status"] = min(4, v["status"] + 2)   # 1 -> 3 -> 4
        self._json({"guid": guid, "status": v["status"], "encodeProgress": 50})


def serve(handler) -> int:
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


CAM_PORT = serve(FakeCamera)
BUNNY_PORT = serve(FakeBunny)
os.environ["GAPSTORE_BUNNY_BASE"] = f"http://127.0.0.1:{BUNNY_PORT}"
gs.BUNNY_BASE = os.environ["GAPSTORE_BUNNY_BASE"]


def write_config(**extra):
    cfg = {"capBytes": 10**12, "minFreeBytes": 0, "stableSeconds": 0, "minAgeSeconds": 0,
           "bunnyPollInterval": 0.05,
           "cameras": {"cam1": {"ip": f"127.0.0.1:{CAM_PORT}", "enabled": True},
                       "cam2": {"enabled": False}, "cam3": {"enabled": False}}}
    cfg.update(extra)
    with open(os.environ["GAPSTORE_CONFIG"], "w") as fh:
        json.dump(cfg, fh)


def cam_ts(epoch_utc: float) -> str:
    return time.strftime("%Y%m%d%H%M%S", time.gmtime(epoch_utc + 3 * 3600))


class GapStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for d in ("incoming/cam1/upload", "live-hold", "var-only"):
            os.makedirs(os.path.join(TMP, d), exist_ok=True)
        with open(os.environ["GAPSTORE_CAM_ENV"], "w") as fh:
            fh.write("CONTROL_KEY=old\nCAM_PASS=old\nCAM_PASS=pw\nCONTROL_KEY=k\n")   # duplicate keys: last wins
        with open(os.environ["GAPSTORE_BUNNY_ENV"], "w") as fh:
            fh.write("BUNNY_API_KEY=streamkey\nBUNNY_LIBRARY_ID=694315\n")
        with open(os.environ["GAPSTORE_COLLECTIONS"], "w") as fh:
            json.dump({"cam1": "coll-cam1"}, fh)
        write_config()
        # Sunday 2026-10-25 03:00 Amman = 00:00 UTC, an off-schedule hour in the fake table
        import calendar
        cls.base = float(calendar.timegm(time.strptime("2026-10-25 00:00:00", "%Y-%m-%d %H:%M:%S")))
        cls.master = os.path.join(TMP, "master.mp4")
        make_clip(cls.master, 60)
        cls.silent = os.path.join(TMP, "silent.mp4")
        make_clip(cls.silent, 60, audio=False)

    def drop(self, offset: float, src: str | None = None, name_prefix="Jordan Galaxy 1_00_") -> str:
        path = os.path.join(TMP, "incoming/cam1/upload", f"{name_prefix}{cam_ts(self.base + offset)}.mp4")
        shutil.copy(src or self.master, path)
        return path

    def test_1_schedule_sync_sets_complement_and_logs_out(self):
        cfg = gs.load_config()
        self.assertEqual(gs.sync_schedule(cfg, ["cam1"], now=self.base), 0)   # 03:00 Amman: off-schedule
        ftp = FakeCamera.state["ftp"]
        expected = ("1" * 6 + "0" * 16 + "1" * 2) * 7
        self.assertEqual(ftp["enable"], 1)
        self.assertEqual(ftp["scheduleEnable"], 1)
        self.assertEqual(ftp["schedule"]["table"]["TIMING"], expected)
        self.assertEqual(ftp["schedule"]["table"]["MD"], "0" * 168)   # no motion uploads in recorded hours
        self.assertEqual(ftp["server"], "169.58.73.17")               # rest of the object untouched
        self.assertEqual(FakeCamera.state["logins"], FakeCamera.state["logouts"])
        sets, logins = FakeCamera.state["sets"], FakeCamera.state["logins"]
        gs.sync_schedule(cfg, ["cam1"], now=self.base + 60)           # same mode: camera not contacted
        self.assertEqual((FakeCamera.state["sets"], FakeCamera.state["logins"]), (sets, logins))
        gs.sync_schedule(cfg, ["cam1"], now=self.base + 60, verify_every=0)   # verify: read, no write
        self.assertEqual(FakeCamera.state["sets"], sets)
        self.assertEqual(gs.read_gap_table("cam1"), expected)
        # 13:00 Amman is a recorded hour: enable 0, so livehold.py still switches it on itself
        gs.sync_schedule(cfg, ["cam1"], now=self.base + 10 * 3600)
        self.assertEqual(FakeCamera.state["ftp"]["enable"], 0)
        self.assertEqual(FakeCamera.state["ftp"]["schedule"]["table"]["TIMING"], expected)
        gs.sync_schedule(cfg, ["cam1"], now=self.base)
        self.assertEqual(FakeCamera.state["ftp"]["enable"], 1)

    def test_2_hold_widens_schedule_and_never_switches_on(self):
        cfg = gs.load_config()
        hold = os.path.join(TMP, "live-hold", "cam1.live")
        open(hold, "w").close()
        try:
            FakeCamera.state["ftp"]["enable"] = 0                      # holder hasn't switched it on yet
            sets = FakeCamera.state["sets"]
            gs.sync_schedule(cfg, ["cam1"], now=self.base)
            self.assertEqual(FakeCamera.state["sets"], sets)
            FakeCamera.state["ftp"]["enable"] = 1                      # live is on with the gap table
            gs.sync_schedule(cfg, ["cam1"], now=self.base)
            table = FakeCamera.state["ftp"]["schedule"]["table"]
            self.assertTrue(all(v == "1" * 168 for v in table.values()))   # survives 16:00
            self.assertTrue(gs.hold_present("cam1"))
            open(os.path.join(TMP, "live-hold", "cam10.live"), "w").close()
            os.unlink(hold)
            self.assertFalse(gs.hold_present("cam1"))   # cam10 is not cam1
            os.unlink(os.path.join(TMP, "live-hold", "cam10.live"))
        finally:
            if os.path.exists(hold):
                os.unlink(hold)
        gs.sync_schedule(cfg, ["cam1"], now=self.base)                 # back to the off-hours schedule
        self.assertEqual(FakeCamera.state["ftp"]["schedule"]["table"]["TIMING"], ("1" * 6 + "0" * 16 + "1" * 2) * 7)
        self.assertEqual(FakeCamera.state["ftp"]["schedule"]["table"]["MD"], "0" * 168)

    def test_3_ingest_waits_for_finished_upload_and_indexes(self):
        # an unfinished MP4 (no moov yet) must be left alone
        partial = os.path.join(TMP, "incoming/cam1/upload", f"Jordan Galaxy 1_00_{cam_ts(self.base + 9999)}.mp4")
        with open(self.master, "rb") as src, open(partial, "wb") as dst:
            data = src.read()
            dst.write(data[: len(data) // 2])
        for i in range(3):
            self.drop(i * 60)
        os.makedirs(os.path.join(TMP, "incoming/cam1/upload/2026/10"), exist_ok=True)
        shutil.copy(self.silent, os.path.join(TMP, "incoming/cam1/upload/2026/10",
                                              f"Jordan Galaxy 1_00_{cam_ts(self.base + 180)}.mp4"))
        result = gs.ingest(gs.load_config())
        self.assertEqual(result["taken"], 4)
        self.assertTrue(os.path.exists(partial))
        os.unlink(partial)
        avail = gs.available(gs.load_config(), "cam1", "2026-10-25")
        self.assertEqual(avail["hours"][0]["hour"], 3)          # 00:00 UTC is 03:00 Amman
        self.assertGreaterEqual(avail["hours"][0]["seconds"], 239)

    def test_4_pull_keeps_audio_in_sync(self):
        start = gs.utc_to_amman_wall(self.base + 7.3)            # mid-GOP, mid-clip
        end = gs.utc_to_amman_wall(self.base + 200)               # runs into the silent clip
        job = gs.create_job("cam1", start, end, "cam1_test")
        gs.pull(gs.load_config(), job["jobId"])
        done = gs.read_job(job["jobId"])
        self.assertIn(done["status"], ("done", "partial"), done)
        self.assertEqual(done["videoId"], "guid-1")
        self.assertEqual(FakeBunny.videos["guid-1"]["collectionId"], "coll-cam1")
        up = FakeBunny.videos["guid-1"]["file"]
        info = gs.probe(up)
        self.assertTrue(info["has_audio"])
        self.assertAlmostEqual(info["dur"], 200 - 7.3, delta=2.5)
        flashes, beeps = flashes_and_beeps(up)
        self.assertGreaterEqual(len(flashes), 20)
        # every flash in the clips that had audio has a beep within 1 frame
        for f in [f for f in flashes if f < 170]:
            nearest = min(beeps, key=lambda b: abs(b - f))
            self.assertLess(abs(nearest - f), 1.0 / FPS + 0.02, (f, nearest))
        self.assertFalse(os.path.exists(os.path.join(gs.ROOT, "work", job["jobId"])))

    def test_5_rolling_cap_prunes_oldest(self):
        conn = gs.db()
        sizes = conn.execute("SELECT bytes FROM clips ORDER BY start_utc").fetchall()
        conn.close()
        total = sum(s[0] for s in sizes)
        write_config(capBytes=total - sizes[0][0])                # room for all but the oldest
        self.drop(240)
        gs.ingest(gs.load_config())
        conn = gs.db()
        starts = [r[0] for r in conn.execute("SELECT start_utc FROM clips ORDER BY start_utc")]
        conn.close()
        self.assertGreater(starts[0], self.base + 1)              # oldest gone
        self.assertEqual(starts[-1], self.base + 240)             # newest kept
        write_config()

    def test_6_hold_links_gap_clips_and_leaves_recorded_hours(self):
        hold = os.path.join(TMP, "var-only", "cam1.var")
        open(hold, "w").close()
        try:
            gap = self.drop(300)                                   # 03:05 Amman: off-schedule
            recorded = self.drop(10 * 3600)                        # 13:00 Amman: SD records it
            gs.ingest(gs.load_config())
            self.assertTrue(os.path.exists(gap))                   # VAR's copy stays for VAR
            self.assertEqual(os.stat(gap).st_nlink, 2)             # ... and the store has a link
            self.assertTrue(os.path.exists(recorded))
            conn = gs.db()
            n = conn.execute("SELECT COUNT(*) FROM clips WHERE start_utc=?", (self.base + 10 * 3600,)).fetchone()[0]
            conn.close()
            self.assertEqual(n, 0)
            os.unlink(gap)
            os.unlink(recorded)
        finally:
            os.unlink(hold)

    def test_8_no_hold_discards_recorded_hours_like_ftp_guard(self):
        self.assertTrue(os.path.exists(os.path.join(TMP, "live-hold", "cam1.gapstore")))
        self.assertFalse(gs.hold_present("cam1"))                  # our own marker is not a hold
        recorded = self.drop(10 * 3600 + 60)
        pic = os.path.join(TMP, "incoming/cam1/upload", "Jordan Galaxy 1_00_20261025130000.jpg")
        open(pic, "wb").write(b"x")
        seg_dir = os.path.join(TMP, "ftplive/cam1/hevc")
        os.makedirs(seg_dir, exist_ok=True)
        old_seg, new_seg = os.path.join(seg_dir, "a.m4s"), os.path.join(seg_dir, "b.m4s")
        for p in (old_seg, new_seg):
            open(p, "wb").write(b"x")
        os.utime(old_seg, (time.time() - 7200, time.time() - 7200))
        result = gs.ingest(gs.load_config())
        self.assertFalse(os.path.exists(recorded))
        self.assertFalse(os.path.exists(pic))
        self.assertFalse(os.path.exists(old_seg))
        self.assertTrue(os.path.exists(new_seg))
        self.assertGreaterEqual(result["discarded"], 2)
        conn = gs.db()
        n = conn.execute("SELECT COUNT(*) FROM clips WHERE start_utc=?", (self.base + 10 * 3600 + 60,)).fetchone()[0]
        conn.close()
        self.assertEqual(n, 0)

    def test_9_overlapping_clips_are_trimmed_and_join_cleanly(self):
        # like the real camera: 14 s clips every 10 s, each repeating 4 s of the next
        base = self.base + 2 * 3600   # 05:00 Amman, off-schedule
        src = os.path.join(TMP, "over.mp4")
        make_clip(src, 14)
        for k in range(6):
            self.drop(2 * 3600 + 10 * k, src)
        gs.ingest(gs.load_config())
        conn = gs.db()
        rows = conn.execute("SELECT start_utc, dur FROM clips WHERE start_utc >= ? ORDER BY start_utc",
                            (base,)).fetchall()
        conn.close()
        self.assertEqual(len(rows), 6)
        for (s0, d0), (s1, _) in zip(rows, rows[1:]):
            self.assertAlmostEqual(s0 + d0, s1, delta=0.1)     # no overlap left
        # mid-GOP start: the cut snaps to the keyframe before it, audio must follow
        mid = gs.create_job("cam1", gs.utc_to_amman_wall(base + 13.3), gs.utc_to_amman_wall(base + 47), "mid")
        gs.pull(gs.load_config(), mid["jobId"])
        m = gs.read_job(mid["jobId"])
        self.assertEqual(m["status"], "done", m)
        f2 = FakeBunny.videos[m["videoId"]]["file"]
        self.assertAlmostEqual(gs.probe(f2)["dur"], 47 - 13.3, delta=2.1)
        fl, bp = flashes_and_beeps(f2)
        self.assertGreaterEqual(len(fl), 6)
        for f in fl:
            self.assertLess(min(abs(b - f) for b in bp), 1.0 / FPS + 0.02, (f, bp))
        job = gs.create_job("cam1", gs.utc_to_amman_wall(base), gs.utc_to_amman_wall(base + 60), "overlap")
        self.assertAlmostEqual(job["coveredSeconds"], 60, delta=0.5)
        gs.pull(gs.load_config(), job["jobId"])
        done = gs.read_job(job["jobId"])
        self.assertEqual(done["status"], "done", done)
        info = gs.probe(FakeBunny.videos[done["videoId"]]["file"])
        self.assertAlmostEqual(info["dur"], 60, delta=0.3)        # not 60 + 5 x 4 s of repeats
        flashes, beeps = flashes_and_beeps(FakeBunny.videos[done["videoId"]]["file"])
        self.assertEqual(len(flashes), 12)                          # one per 5 s, none repeated
        for f in flashes:
            self.assertLess(min(abs(b - f) for b in beeps), 1.0 / FPS + 0.02)

    def test_7_api_routes(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        import gapstore_api
        app = FastAPI()
        app.include_router(gapstore_api.router)
        client = TestClient(app)
        self.assertEqual(client.get("/gapstore/status").status_code, 401)
        h = {"x-api-key": "k"}
        r = client.get("/gapstore/camera1/available", params={"date": "2026-10-25"}, headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["hours"][0]["hour"], 3)
        r = client.get("/gapstore/camera1/coverage", params={"start": "2026-10-25 03:00", "end": "2026-10-25 04:00"},
                       headers=h)
        self.assertGreater(r.json()["coveredSeconds"], 100)
        self.assertTrue(r.json()["gaps"])
        r = client.post("/gapstore/camera1/pull", params={"start": "2026-10-26 03:00", "end": "2026-10-26 04:00",
                                                          "title": "x"}, headers=h)
        self.assertEqual(r.status_code, 404)                       # nothing stored then
        self.assertEqual(client.get("/gapstore/camera1/pull/gs-000000000000", headers=h).status_code, 404)
        self.assertEqual(client.get("/gapstore/camera9/available", headers=h).status_code, 404)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
