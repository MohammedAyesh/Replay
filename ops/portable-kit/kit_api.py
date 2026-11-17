"""Portable camera kits: status, a snapshot and WiFi, for the app's Set up a camera flow.

Mounted into control.py (x-api-key like every other route):

    from kit_api import router as kit_router
    app.include_router(kit_router)

    GET  /kit/{cam}/status    -> {online, ssid, signal, link}
    GET  /kit/{cam}/snapshot  -> image/jpeg (cmd=Snap, channel 0, the stitched panorama)
    POST /kit/{cam}/wifi      {ssid, password} -> SetWifi, read-modify-write

A kit camera sits behind the kit's MiFi, not the Jordan Galaxy router, so its address
comes from /etc/replay/kits.json:

    {"camera4": {"host": "192.168.67.101"}, "camera5": {"host": "192.168.68.101", "passEnv": "/etc/replay/cam5.env:CAM5_PASS"}}

cam1..cam3 keep their DHCP reservations on 192.168.66.x. Rules from CLAUDE.md: the
password never goes to argv or a log, every login is logged out in a finally (32 session
slots, hour-long leases), and nothing here retries a login.
"""
import json
import os
import secrets
import urllib.request

from fastapi import APIRouter, Body, Header, HTTPException, Response

router = APIRouter()

DEFAULT_HOSTS = {"cam1": "192.168.66.101", "cam2": "192.168.66.102", "cam3": "192.168.66.103"}
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


def _camera(cam):
    """(host, user, password) for a camera name the app uses ("camera4" or "cam4")."""
    short = _short(cam)
    entry = {}
    try:
        kits = json.load(open(KITS_FILE))
        entry = kits.get(cam) or kits.get(short) or {}
    except (OSError, ValueError):
        pass
    host = entry.get("host") or DEFAULT_HOSTS.get(short)
    if not host:
        raise HTTPException(404, "unknown camera")
    password = None
    if entry.get("passEnv"):
        path, _, name = entry["passEnv"].partition(":")
        password = _env_value(path, name)
    if password is None:
        password = _env_value("/opt/replay/env", "CAM_PASS")
    if not password:
        raise HTTPException(500, "no camera password configured")
    return host, entry.get("user", "admin"), password


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
