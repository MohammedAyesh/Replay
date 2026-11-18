"""Portable camera kits: status, a snapshot and WiFi, for the app's Set up a camera flow.

Mounted into control.py (x-api-key like every other route):

    from kit_api import router as kit_router
    app.include_router(kit_router)

    GET  /kit/{cam}/status    -> {online, ssid, signal, link}
    GET  /kit/{cam}/snapshot  -> image/jpeg (cmd=Snap, channel 0, the stitched panorama)
    POST /kit/{cam}/wifi      {ssid, password} -> SetWifi, read-modify-write
    POST /kit/{cam}/register  {uid, user?, password} -> a camera added in the app, reached by Reolink UID
    POST /kit/{cam}/preview   start the low-quality live preview (kit_preview.py); GET = its state
    GET  /kit/{cam}/preview/index.m3u8 | seg_NNNNNN.ts   the preview itself (HLS, H.264)
    DELETE /kit/{cam}/preview stop it now (it also stops by itself 60 s after the last request)

A kit camera sits behind the kit's MiFi, not the Jordan Galaxy router, so its address
comes from /etc/replay/kits.json:

    {"camera4": {"host": "192.168.67.101"}, "camera5": {"host": "192.168.68.101", "passEnv": "/etc/replay/cam5.env:CAM5_PASS"}}

cam1..cam3 keep their DHCP reservations on 192.168.66.x. Rules from CLAUDE.md: the
password never goes to argv or a log, every login is logged out in a finally (32 session
slots, hour-long leases), and nothing here retries a login.
"""
import json
import os
import re
import secrets
import subprocess
import urllib.request

from fastapi import APIRouter, Body, Header, HTTPException, Response

router = APIRouter()

DEFAULT_HOSTS = {"cam1": "192.168.66.101", "cam2": "192.168.66.102", "cam3": "192.168.66.103"}
# cam3 has its own password (and firmware 4989 may refuse the plain login anyway).
DEFAULT_PASS_ENV = {"cam3": "/etc/replay/cam3.env:CAM3_PASS"}
KITS_FILE = "/etc/replay/kits.json"
TIMEOUT = 8


def _key():
    for line in open("/opt/replay/env"):
        if line.startswith("CONTROL_KEY="):
            return line.split("=", 1)[1].strip()
    return ""


def _auth(k):
    if not k or k != _key():
        raise HTTPException(401)


def _short(cam):
    return cam.strip().replace("camera", "cam")


def _env_value(path, name):
    for line in open(path):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def kit_entry(cam):
    """This camera's entry in kits.json, keyed "cam4" or "camera4"."""
    short = _short(cam)
    try:
        kits = json.load(open(KITS_FILE))
    except (OSError, ValueError):
        return {}
    return kits.get(cam) or kits.get(short) or kits.get(short.replace("cam", "camera", 1)) or {}


def _camera(cam):
    """(host, user, password) for a camera name the app uses ("camera4" or "cam4")."""
    short = _short(cam)
    entry = kit_entry(cam)
    host = entry.get("host") or DEFAULT_HOSTS.get(short)
    if not host and not entry.get("uid"):
        raise HTTPException(404, "unknown camera")
    password = None
    if entry.get("passFile"):
        try:
            password = json.load(open(entry["passFile"])).get("password")
        except (OSError, ValueError):
            password = None
    pass_env = entry.get("passEnv") or DEFAULT_PASS_ENV.get(short)
    if password is None and pass_env:
        path, _, name = pass_env.partition(":")
        password = _env_value(path, name)
    if password is None and not entry.get("passFile"):
        password = _env_value("/opt/replay/env", "CAM_PASS")
    if not password:
        raise HTTPException(500, "no camera password configured")
    return host or None, entry.get("user", "admin"), password


def _call(host, cmd, param, token=None, action=None):
    q = f"http://{host}/api.cgi?cmd={cmd}" + (f"&token={token}" if token else "")
    body = {"cmd": cmd, "param": param}
    if action is not None:
        body["action"] = action
    req = urllib.request.Request(q, data=json.dumps([body]).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())[0]


class _Session:
    def __init__(self, cam):
        self.host, self.user, self.password = _camera(cam)
        self.token = None

    def __enter__(self):
        if not self.host:
            raise HTTPException(409, "cloud-only camera")
        try:
            r = _call(self.host, "Login", {"User": {"Version": "0", "userName": self.user, "password": self.password}})
        except OSError as e:
            raise HTTPException(503, "camera unreachable") from e
        if r.get("code") != 0:
            raise HTTPException(502, "camera refused the login")
        self.token = r["value"]["Token"]["name"]
        return self

    def __exit__(self, *exc):
        try:
            _call(self.host, "Logout", {}, token=self.token)
        except Exception:
            pass

    def call(self, cmd, param, action=None):
        return _call(self.host, cmd, param, token=self.token, action=action)


@router.get("/kit/{cam}/status")
def kit_status(cam: str, x_api_key: str = Header(None)):
    _auth(x_api_key)
    try:
        with _Session(cam) as s:
            out = {"online": True, "ssid": None, "signal": None, "link": None}
            try:
                link = s.call("GetLocalLink", {}, action=0)
                out["link"] = ((link.get("value") or {}).get("LocalLink") or {}).get("activeLink")
            except Exception:
                pass
            try:
                wifi = s.call("GetWifi", {}, action=0)
                out["ssid"] = ((wifi.get("value") or {}).get("Wifi") or {}).get("ssid")
            except Exception:
                pass
            try:
                sig = s.call("GetWifiSignal", {"channel": 0}, action=0)
                out["signal"] = (sig.get("value") or {}).get("wifiSignal")
            except Exception:
                pass
            return out
    except HTTPException as e:
        if e.status_code in (502, 503):
            return {"online": False, "reason": "offline"}
        if e.status_code == 409:
            return {"online": False, "reason": "cloud"}
        raise


@router.get("/kit/{cam}/snapshot")
def kit_snapshot(cam: str, x_api_key: str = Header(None)):
    _auth(x_api_key)
    with _Session(cam) as s:
        url = f"http://{s.host}/cgi-bin/api.cgi?cmd=Snap&channel=0&rs={secrets.token_hex(6)}&token={s.token}"
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                data, kind = r.read(), r.headers.get("Content-Type", "")
        except OSError as e:
            raise HTTPException(503, "camera unreachable") from e
    if not kind.startswith("image/") or len(data) < 1000:
        raise HTTPException(502, "camera sent no picture")
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# ── A new camera, connected from the app ────────────────────────────────────────────────

KITPASS_DIR = "/etc/replay/kitpass"
_UID = re.compile(r"^[A-Z0-9]{12,24}$")


@router.post("/kit/{cam}/register")
def kit_register(cam: str, body: dict = Body(...), x_api_key: str = Header(None)):
    """Remember a camera someone set up in the Reolink app: its UID and password.

    vps1 reaches it through Reolink's cloud by UID (kit_preview.py). The password goes to
    /etc/replay/kitpass/<cam>.json (0600), never to kits.json, argv or a log. Replay's own
    cameras (cam1-cam3) can't be overwritten from here.
    """
    _auth(x_api_key)
    short = _short(cam)
    if not re.fullmatch(r"cam\d{1,3}", short):
        raise HTTPException(400, "bad camera name")
    if short in DEFAULT_HOSTS:
        raise HTTPException(409, "that camera belongs to Replay")
    uid = re.sub(r"[\s-]", "", str(body.get("uid") or "")).upper()
    user = str(body.get("user") or "admin").strip()
    password = body.get("password")
    if not _UID.match(uid):
        raise HTTPException(400, "uid")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,32}", user):
        raise HTTPException(400, "user")
    if password is not None and (not isinstance(password, str) or not (1 <= len(password) <= 64) or any(ord(ch) < 32 for ch in password)):
        raise HTTPException(400, "password")
    import fcntl
    os.makedirs(KITPASS_DIR, mode=0o700, exist_ok=True)
    with open(KITS_FILE + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            kits = json.load(open(KITS_FILE))
        except (OSError, ValueError):
            kits = {}
        for other, entry in kits.items():
            if _short(other) != short and str(entry.get("uid") or "").upper() == uid:
                raise HTTPException(409, "uid in use")
        entry = dict(kits.get(short) or {})
        for k in ("host", "passEnv"):
            entry.pop(k, None)
        pass_file = os.path.join(KITPASS_DIR, short + ".json")
        if password is not None:
            fd = os.open(pass_file + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump({"password": password}, f)
            os.replace(pass_file + ".tmp", pass_file)
        elif not os.path.exists(pass_file):
            raise HTTPException(400, "password")
        entry.update({"uid": uid, "user": user, "via": "cloud", "passFile": pass_file})
        for k in [k for k in kits if _short(k) == short]:
            kits.pop(k)
        kits[short] = entry
        with open(KITS_FILE + ".tmp", "w") as f:
            json.dump(kits, f, indent=1)
        os.replace(KITS_FILE + ".tmp", KITS_FILE)
    # A preview still running with the old details would keep showing the old camera.
    subprocess.run(["systemctl", "stop", "--no-block", f"replay-kitpreview@{short}"], timeout=15)
    return {"ok": True, "camera": short}


# ── Low-quality live preview (kit_preview.py, replay-kitpreview@<cam>) ──────────────────

PREVIEW_ROOT = "/run/replay-kitpreview"
_PREVIEW_FILE = re.compile(r"^(index\.m3u8|seg_\d{6}\.ts)$")


def _preview_cam(cam):
    short = _short(cam)
    if not re.fullmatch(r"cam\d{1,3}", short):
        raise HTTPException(404, "unknown camera")
    _camera(short)  # 404 for a camera vps1 knows nothing about
    return short


def _preview_touch(short):
    d = os.path.join(PREVIEW_ROOT, short)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "access")
    with open(p, "a"):
        os.utime(p, None)


def _preview_state(short):
    active = subprocess.run(["systemctl", "is-active", f"replay-kitpreview@{short}"], capture_output=True, text=True).stdout.strip()
    try:
        s = json.load(open(os.path.join(PREVIEW_ROOT, short, "state.json")))
    except (OSError, ValueError):
        s = {"state": "starting" if active in ("active", "activating") else "stopped"}
    if active not in ("active", "activating") and s.get("state") in ("starting", "ready"):
        s["state"] = "stopped"
    return {"state": s.get("state"), "via": s.get("via"), "message": s.get("message")}


@router.post("/kit/{cam}/preview")
def kit_preview_start(cam: str, x_api_key: str = Header(None)):
    """Start the preview if it isn't running (anyone already watching shares it)."""
    _auth(x_api_key)
    short = _preview_cam(cam)
    _preview_touch(short)
    state = _preview_state(short)
    if state["state"] not in ("starting", "ready"):
        try:
            os.remove(os.path.join(PREVIEW_ROOT, short, "state.json"))
        except OSError:
            pass
        subprocess.run(["systemctl", "start", "--no-block", f"replay-kitpreview@{short}"], check=True, timeout=15)
        state = {"state": "starting", "via": None, "message": None}
    return state


@router.get("/kit/{cam}/preview")
def kit_preview_status(cam: str, x_api_key: str = Header(None)):
    _auth(x_api_key)
    short = _preview_cam(cam)
    _preview_touch(short)
    return _preview_state(short)


@router.delete("/kit/{cam}/preview")
def kit_preview_stop(cam: str, x_api_key: str = Header(None)):
    _auth(x_api_key)
    short = _preview_cam(cam)
    subprocess.run(["systemctl", "stop", "--no-block", f"replay-kitpreview@{short}"], timeout=15)
    return {"state": "stopped"}


@router.get("/kit/{cam}/preview/{name}")
def kit_preview_file(cam: str, name: str, x_api_key: str = Header(None)):
    _auth(x_api_key)
    short = _short(cam)
    if not re.fullmatch(r"cam\d{1,3}", short) or not _PREVIEW_FILE.match(name):
        raise HTTPException(404)
    path = os.path.join(PREVIEW_ROOT, short, "hls", name)
    try:
        data = open(path, "rb").read()
    except OSError:
        raise HTTPException(404, "not ready")
    _preview_touch(short)
    kind = "application/vnd.apple.mpegurl" if name.endswith(".m3u8") else "video/mp2t"
    return Response(content=data, media_type=kind, headers={"Cache-Control": "no-store"})


@router.post("/kit/{cam}/wifi")
def kit_wifi(cam: str, body: dict = Body(...), x_api_key: str = Header(None)):
    _auth(x_api_key)
    ssid = str(body.get("ssid") or "").strip()
    password = str(body.get("password") or "")
    if not ssid or len(ssid) > 32 or not (8 <= len(password) <= 63):
        raise HTTPException(400, "ssid, and a password of 8-63 characters")
    with _Session(cam) as s:
        cur = s.call("GetWifi", {}, action=1)
        wifi = dict(((cur.get("value") or {}).get("Wifi")) or {})
        wifi["ssid"] = ssid
        wifi["password"] = password
        r = s.call("SetWifi", {"Wifi": wifi})
        if r.get("code") != 0:
            raise HTTPException(502, "camera refused the WiFi change: %s" % json.dumps(r.get("error")))
    # The camera now leaves this network for the new one; there is nothing to read back here.
    return {"ok": True, "ssid": ssid}
