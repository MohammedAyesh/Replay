#!/opt/replay/venv/bin/python
"""Low-quality live preview of a kit camera, for the app. One run per camera, on demand.

    systemctl start replay-kitpreview@cam4      (kit_api.py does this when someone opens it)

1. Find the camera. If vps1 reaches it over WireGuard (TCP 9000 answers), neolink connects
   straight to it ("direct"). Otherwise neolink reaches it through Reolink's own P2P relay by
   its UID ("cloud"): the only path to a kit behind a phone hotspot. The relay carries ~0.5
   Mbps, enough for the 1536x432 sub stream and nothing more (findings doc 2026-11-18).
2. neolink (Docker image quantumentangledandy/neolink, it bundles the GStreamer parts vps1
   lacks) serves the camera as RTSP on 127.0.0.1; ffmpeg copies the sub stream (H.264, no
   audio) into a short rolling HLS window under /run/replay-kitpreview/<cam>/hls.
3. kit_api.py serves that folder and touches .../access on every request. Nobody fetching
   for IDLE_S seconds, a dead ffmpeg or neolink, or MAX_S in total ends the run.

The UID comes from /etc/replay/kits.json ({"cam4": {"uid": "9527..."}}), else from the
camera's GetP2p over HTTP (cached in /var/lib/replay-kitpreview/uids.json). The password
goes into a 0600 config under /run for neolink and is deleted on exit; never argv, never logs.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time

sys.path.insert(0, "/opt/replay")
import kit_api  # noqa: E402  (host, user and password lookup shared with the control API)

IMAGE = "quantumentangledandy/neolink:latest"
RUN_ROOT = "/run/replay-kitpreview"
UID_CACHE = "/var/lib/replay-kitpreview/uids.json"
CONNECT_S = 60      # neolink must log in within this
FIRST_SEGMENTS_S = 45
IDLE_S = 60         # stop this long after the last viewer request
MAX_S = 30 * 60
NOBODY = 65534


def now():
    return time.time()


class Run:
    def __init__(self, cam):
        if not re.fullmatch(r"cam\d{1,3}", cam):
            raise SystemExit("bad camera name")
        self.cam = cam
        self.dir = os.path.join(RUN_ROOT, cam)
        self.hls = os.path.join(self.dir, "hls")
        self.access = os.path.join(self.dir, "access")
        self.cfg_dir = os.path.join(self.dir, "neolink")
        self.port = 18600 + int(cam[3:])
        self.container = f"replay-kitpreview-{cam}"
        self.started = now()
        self.via = None
        self.ffmpeg = None

    # ── state the control API reads ──
    def state(self, state, message=None):
        tmp = os.path.join(self.dir, "state.json.tmp")
        with open(tmp, "w") as f:
            json.dump({"state": state, "via": self.via, "message": message, "startedAt": self.started, "updatedAt": now()}, f)
        os.replace(tmp, os.path.join(self.dir, "state.json"))
        print(f"{time.strftime('%H:%M:%S')} {self.cam} {state} via={self.via} {message or ''}", flush=True)

    def last_access(self):
        try:
            return os.path.getmtime(self.access)
        except OSError:
            return self.started

    # ── camera ──
    def uid(self, host, user, password):
        entry = kit_api.kit_entry(self.cam)
        if entry.get("uid"):
            return entry["uid"]
        cache = {}
        try:
            cache = json.load(open(UID_CACHE))
        except (OSError, ValueError):
            pass
        if not host:
            return None
        try:
            with kit_api._Session(self.cam) as s:
                r = s.call("GetP2p", {}, action=0)
            uid = ((r.get("value") or {}).get("P2p") or {}).get("uid")
            if uid:
                cache[self.cam] = uid
                os.makedirs(os.path.dirname(UID_CACHE), exist_ok=True)
                with open(UID_CACHE + ".tmp", "w") as f:
                    json.dump(cache, f)
                os.replace(UID_CACHE + ".tmp", UID_CACHE)
                return uid
        except Exception:
            pass
        return cache.get(self.cam)

    @staticmethod
    def reachable(host):
        try:
            with socket.create_connection((host, 9000), timeout=2):
                return True
        except OSError:
            return False

    # ── neolink ──
    def write_config(self, user, password, target_line):
        os.makedirs(self.cfg_dir, exist_ok=True)
        os.chown(self.cfg_dir, NOBODY, NOBODY)
        os.chmod(self.cfg_dir, 0o700)
        path = os.path.join(self.cfg_dir, "cfg.toml")
        esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(f'bind = "127.0.0.1"\nbind_port = {self.port}\n[[cameras]]\nname = "{self.cam}"\n'
                    f'username = "{esc(user)}"\npassword = "{esc(password)}"\nstream = "subStream"\n{target_line}\n')
        os.chown(path, NOBODY, NOBODY)

    def docker(self, *args, **kw):
        return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=kw.get("timeout", 30))

    def start_neolink(self):
        self.docker("rm", "-f", self.container)
        r = self.docker("run", "-d", "--pull=never", "--name", self.container, "--network", "host",
                        "--user", f"{NOBODY}:{NOBODY}", "--memory", "256m",
                        "-v", f"{self.cfg_dir}:/w:ro", "--entrypoint", "neolink", IMAGE, "rtsp", "--config", "/w/cfg.toml")
        if r.returncode != 0:
            raise RuntimeError("neolink did not start: " + r.stderr.strip()[-200:])

    def neolink_log(self):
        r = self.docker("logs", self.container, timeout=10)
        return r.stdout + r.stderr

    def neolink_alive(self):
        r = self.docker("inspect", "-f", "{{.State.Running}}", self.container, timeout=10)
        return r.stdout.strip() == "true"

    REFUSED = re.compile(r"(?i)(password|credential|login fail|unauthori|AuthFail)")

    def wait_logged_in(self, limit):
        """True once streaming; "refused" the moment the camera turns the password down.

        Stopping at the first refusal matters: neolink keeps retrying, and Reolink cameras
        lock their logins after a few failures, which would lock the owner out too.
        """
        end = now() + limit
        while now() < end:
            log = self.neolink_log()
            if "Connected and logged in" in log and f"Available at /{self.cam}/sub" in log:
                return True
            if self.REFUSED.search(log):
                return "refused"
            if not self.neolink_alive():
                return False
            time.sleep(1)
        return False

    # ── ffmpeg ──
    def start_ffmpeg(self):
        shutil.rmtree(self.hls, ignore_errors=True)
        os.makedirs(self.hls)
        self.ffmpeg = subprocess.Popen([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "warning",
            "-fflags", "+genpts", "-rtsp_transport", "tcp", "-i", f"rtsp://127.0.0.1:{self.port}/{self.cam}/sub",
            "-an", "-c:v", "copy",
            "-f", "hls", "-hls_time", "2", "-hls_list_size", "8",
            "-hls_flags", "delete_segments+omit_endlist+temp_file+independent_segments",
            "-hls_segment_filename", os.path.join(self.hls, "seg_%06d.ts"),
            os.path.join(self.hls, "index.m3u8"),
        ], stdin=subprocess.DEVNULL)

    def segments(self):
        try:
            return sum(1 for n in os.listdir(self.hls) if n.endswith(".ts"))
        except OSError:
            return 0

    # ── the run ──
    def main(self):
        os.makedirs(self.dir, exist_ok=True)
        self.state("starting", "Finding the camera")
        host, user, password = kit_api._camera(self.cam)
        attempts = []
        # "via": "cloud" in kits.json (or KITPREVIEW_VIA=cloud for a test) skips the direct path.
        cloud_only = os.environ.get("KITPREVIEW_VIA") == "cloud" or kit_api.kit_entry(self.cam).get("via") == "cloud"
        if not cloud_only and host and self.reachable(host):
            attempts.append(("direct", f'address = "{host}:9000"'))
        uid = self.uid(host, user, password)
        if uid:
            attempts.append(("cloud", f'uid = "{uid}"\ndiscovery = "relay"'))
        if not attempts:
            self.state("failed", "The camera isn't reachable and its Reolink UID isn't known yet")
            return 2
        result = False
        for via, line in attempts:
            self.via = via
            self.state("starting", "Connecting through Reolink's cloud" if via == "cloud" else "Connecting")
            self.write_config(user, password, line)
            self.start_neolink()
            result = self.wait_logged_in(CONNECT_S if via == "cloud" else 25)
            if result is True:
                break
            self.docker("rm", "-f", self.container)
            if result == "refused":
                break  # never try a wrong password again down another path
        if result is not True:
            self.state("failed", "password" if result == "refused" else "offline" if self.via == "cloud" else "The camera didn't answer")
            return 3
        # The config holds the password: gone as soon as neolink has read it.
        shutil.rmtree(self.cfg_dir, ignore_errors=True)

        self.start_ffmpeg()
        ready_by = now() + FIRST_SEGMENTS_S
        while self.segments() < 2:
            if now() > ready_by or self.ffmpeg.poll() is not None:
                self.state("failed", "No picture came through")
                return 4
            time.sleep(1)
        self.state("ready")
        os.utime(self.access, None) if os.path.exists(self.access) else open(self.access, "w").close()

        while True:
            time.sleep(3)
            if self.ffmpeg.poll() is not None or not self.neolink_alive():
                self.state("failed", "The stream dropped")
                return 5
            if now() - self.last_access() > IDLE_S:
                self.state("stopped", "Nobody watching")
                return 0
            if now() - self.started > MAX_S:
                self.state("stopped", "Preview time limit")
                return 0

    def cleanup(self):
        if self.ffmpeg and self.ffmpeg.poll() is None:
            self.ffmpeg.terminate()
            try:
                self.ffmpeg.wait(5)
            except subprocess.TimeoutExpired:
                self.ffmpeg.kill()
        try:
            self.docker("rm", "-f", self.container)
        except Exception:
            pass
        shutil.rmtree(self.cfg_dir, ignore_errors=True)
        shutil.rmtree(self.hls, ignore_errors=True)


def _on_term(signum, frame):
    raise SystemExit(0)  # so systemctl stop still runs cleanup() (the container outlives us otherwise)


if __name__ == "__main__":
    import signal
    signal.signal(signal.SIGTERM, _on_term)
    run = Run(sys.argv[1])
    code = 1
    try:
        code = run.main()
    except SystemExit:
        run.state("stopped", "Stopped")
        code = 0
    except Exception as e:  # message only: nothing here carries the password
        try:
            run.state("failed", str(e)[:200])
        except Exception:
            pass
    finally:
        run.cleanup()
    sys.exit(code)
