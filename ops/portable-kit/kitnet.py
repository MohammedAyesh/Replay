#!/opt/replay/venv/bin/python
"""Kit routers: a private WireGuard tunnel per portable camera, set up by the user in the app.

    kitnet.py sync        (replay-kitnet.timer, every 2 min and at boot)

A user connects a GL.iNet-style travel router to their phone's hotspot or the pitch WiFi, and the
camera to the router. In the app they press "Connect a router": this module makes a WireGuard peer
for that one camera and hands back a client config, once. The private key is never stored here.

Addressing (never overlaps Jordan Galaxy's 10.99.0.2 + 192.168.66.0/24):
    kit n (1..120): tunnel 10.99.0.(128+n)/32, router LAN 10.199.n.0/24, router address 10.199.n.1
vps1 reaches the camera at 10.199.n.x through the tunnel, exactly like cam1 through Jordan Galaxy's
router, so bookings pull full quality from its card with reolink-cli (alias camN, added here).

Security:
  * one key pair + preshared key per kit; re-issuing a config replaces the old peer at once;
  * the client config routes only 10.99.0.1 into the tunnel, never the user's own traffic;
  * chain REPLAY-KITNET (top of INPUT): a kit may only answer connections vps1 opened, so a kit
    can't reach SSH, the control API or anything else here; REPLAY-KITNET-FWD (top of FORWARD):
    kits never reach each other or Jordan Galaxy;
  * peers live in /etc/replay/kitnet/ (0700), not wg0.conf, so Jordan Galaxy's link is never edited;
    sync re-adds them if wg0 restarts.
"""
import concurrent.futures
import fcntl
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import time

sys.path.insert(0, "/opt/replay")

WG = "wg0"
ENDPOINT = os.environ.get("KITNET_ENDPOINT", "169.58.73.17:51820")
STATE_DIR = "/etc/replay/kitnet"
STATE = os.path.join(STATE_DIR, "peers.json")
KIT_TUNNELS = "10.99.0.128/25"
KIT_LANS = "10.199.0.0/16"
MAX_KITS = 120
ALIASES = "/root/.config/reolink-cli/aliases.toml"
CLI = "/root/.local/bin/reolink-cli"


def sh(*cmd, input=None, check=True):
    r = subprocess.run(cmd, input=input, capture_output=True, text=True, timeout=60)
    if check and r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} {cmd[1] if len(cmd) > 1 else ''}: {r.stderr.strip()[:200]}")
    return r.stdout.strip()


def _short(cam):
    s = cam.replace("camera", "cam", 1)
    if not re.fullmatch(r"cam\d{1,3}", s):
        raise ValueError("bad camera name")
    return s


class _Locked:
    """All changes to peers.json / kits.json / aliases go through one lock."""

    def __enter__(self):
        os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
        self.f = open(os.path.join(STATE_DIR, ".lock"), "a")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def load():
    try:
        return json.load(open(STATE))
    except (OSError, ValueError):
        return {}


def save(peers):
    tmp = STATE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(peers, f, indent=1)
    os.replace(tmp, STATE)


def addresses(n):
    return {
        "tunnel": f"10.99.0.{128 + n}",
        "lan": f"10.199.{n}.0/24",
        "router": f"10.199.{n}.1",
    }


# ── firewall, route, peers: idempotent, safe to run any time ─────────────────────────────

def _ipt(*rule):
    """Add a rule only if it is not there yet (-C first)."""
    if subprocess.run(["iptables", "-C", *rule], capture_output=True).returncode != 0:
        sh("iptables", "-A", *rule)


def ensure_firewall():
    for chain, parent in (("REPLAY-KITNET", "INPUT"), ("REPLAY-KITNET-FWD", "FORWARD")):
        subprocess.run(["iptables", "-N", chain], capture_output=True)
        if subprocess.run(["iptables", "-C", parent, "-j", chain], capture_output=True).returncode != 0:
            sh("iptables", "-I", parent, "1", "-j", chain)
    for src in (KIT_TUNNELS, KIT_LANS):
        _ipt("REPLAY-KITNET", "-i", WG, "-s", src, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")
        _ipt("REPLAY-KITNET", "-i", WG, "-s", src, "-p", "icmp", "-j", "ACCEPT")
        _ipt("REPLAY-KITNET", "-i", WG, "-s", src, "-j", "DROP")
        _ipt("REPLAY-KITNET-FWD", "-i", WG, "-s", src, "-j", "DROP")
        _ipt("REPLAY-KITNET-FWD", "-o", WG, "-d", src, "!", "-s", "10.99.0.1", "-j", "DROP")


def ensure_route():
    sh("ip", "route", "replace", KIT_LANS, "dev", WG)


def _psk_path(short):
    return os.path.join(STATE_DIR, f"{short}.psk")


def ensure_peer(short, p):
    a = addresses(p["n"])
    sh("wg", "set", WG, "peer", p["pub"], "preshared-key", _psk_path(short),
       "allowed-ips", f"{a['tunnel']}/32,{a['lan']}", "persistent-keepalive", "0")


def handshakes():
    out = {}
    for line in sh("wg", "show", WG, "latest-handshakes").splitlines():
        parts = line.split()
        if len(parts) == 2:
            out[parts[0]] = int(parts[1])
    return out


# ── create / remove / status ─────────────────────────────────────────────────────────────

def create(cam):
    """New (or replacement) tunnel for this camera. Returns the client config ONCE."""
    short = _short(cam)
    with _Locked():
        peers = load()
        old = peers.get(short)
        if old:
            subprocess.run(["wg", "set", WG, "peer", old["pub"], "remove"], capture_output=True)
            n = old["n"]
        else:
            used = {p["n"] for p in peers.values()}
            free = [i for i in range(1, MAX_KITS + 1) if i not in used]
            if not free:
                raise RuntimeError("no free kit networks")
            n = free[0]
        priv = sh("wg", "genkey")
        pub = sh("wg", "pubkey", input=priv + "\n")
        psk = sh("wg", "genpsk")
        fd = os.open(_psk_path(short), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(psk + "\n")
        peers[short] = {"n": n, "pub": pub, "created": int(time.time()), "camera": None}
        save(peers)
        ensure_firewall()
        ensure_route()
        ensure_peer(short, peers[short])
        server_pub = sh("wg", "show", WG, "public-key")
    a = addresses(n)
    config = (
        "[Interface]\n"
        f"PrivateKey = {priv}\n"
        f"Address = {a['tunnel']}/32\n"
        "MTU = 1280\n\n"
        "[Peer]\n"
        f"PublicKey = {server_pub}\n"
        f"PresharedKey = {psk}\n"
        f"Endpoint = {ENDPOINT}\n"
        "AllowedIPs = 10.99.0.1/32\n"
        "PersistentKeepalive = 25\n"
    )
    del priv
    return {"config": config, "routerAddress": a["router"], "lan": a["lan"], "tunnel": a["tunnel"]}


def remove(cam):
    short = _short(cam)
    with _Locked():
        peers = load()
        p = peers.pop(short, None)
        if p:
            subprocess.run(["wg", "set", WG, "peer", p["pub"], "remove"], capture_output=True)
            save(peers)
        try:
            os.remove(_psk_path(short))
        except OSError:
            pass
        _forget_camera(short)
    return {"removed": bool(p)}


def status(cam):
    short = _short(cam)
    p = load().get(short)
    if not p:
        return {"configured": False}
    hs = handshakes().get(p["pub"], 0)
    age = int(time.time()) - hs if hs else None
    return {
        "configured": True,
        "routerAddress": addresses(p["n"])["router"],
        "connected": age is not None and age < 180,
        "lastSeenSeconds": age,
        "camera": p.get("camera"),
    }


# ── finding the camera behind the router ────────────────────────────────────────────────

def _open9000(ip):
    try:
        with socket.create_connection((ip, 9000), timeout=1.2):
            return ip
    except OSError:
        return None


def _uid_over_http(ip, user, password):
    """The camera's UID via its HTTP API (firmware 4518/4060). None if it won't say."""
    import requests
    import urllib3
    urllib3.disable_warnings()
    base = f"https://{ip}/api.cgi"
    token = None
    try:
        r = requests.post(f"{base}?cmd=Login", json=[{"cmd": "Login", "param": {"User": {"Version": "0", "userName": user, "password": password}}}],
                          verify=False, timeout=8).json()
        token = r[0]["value"]["Token"]["name"]
        r = requests.post(f"{base}?cmd=GetP2p&token={token}", json=[{"cmd": "GetP2p", "action": 0, "param": {}}], verify=False, timeout=8).json()
        return ((r[0].get("value") or {}).get("P2p") or {}).get("uid")
    except Exception:
        return None
    finally:
        if token:
            try:
                requests.post(f"{base}?cmd=Logout&token={token}", json=[{"cmd": "Logout", "param": {}}], verify=False, timeout=5)
            except Exception:
                pass


def discover(short, n):
    """The camera's address on the kit's LAN, matched by UID where the camera says it."""
    import kit_api
    entry = kit_api.kit_entry(short)
    _, user, password = kit_api._camera(short)
    net = ipaddress.ip_network(addresses(n)["lan"])
    hosts = [str(h) for h in net.hosts() if str(h) != addresses(n)["router"]]
    with concurrent.futures.ThreadPoolExecutor(64) as ex:
        found = [ip for ip in ex.map(_open9000, hosts) if ip]
    want = str(entry.get("uid") or "").upper()
    for ip in found:
        uid = _uid_over_http(ip, user, password) if password else None
        if uid and want and uid.upper() == want:
            return ip
    # Firmware that won't give its UID over HTTP (4989): one Reolink port on the LAN is the camera.
    if len(found) == 1:
        return found[0]
    return None


def _set_alias(short, host, user, password):
    base = [CLI, "device"]
    env = {**os.environ, "HOME": "/root"}
    exists = subprocess.run([CLI, "device", "show", short], capture_output=True, env=env, timeout=30).returncode == 0
    args = (["update", short] if exists else ["add", short]) + ["--host", f"{host}:9000", "--user", user, "--password-stdin"]
    r = subprocess.run(base + args, input=(password or "") + "\n", capture_output=True, text=True, env=env, timeout=30)
    if r.returncode != 0:
        raise RuntimeError("reolink-cli alias: " + (r.stderr or r.stdout).strip()[:200])


def _remember_camera(short, host):
    """kits.json: reachable at host, bookings pull from the card (pull=cli)."""
    import kit_api
    with open(kit_api.KITS_FILE + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            kits = json.load(open(kit_api.KITS_FILE))
        except (OSError, ValueError):
            kits = {}
        e = dict(kits.get(short) or {})
        e.update({"host": host, "pull": "cli", "router": True})
        e.pop("via", None)
        kits[short] = e
        with open(kit_api.KITS_FILE + ".tmp", "w") as f:
            json.dump(kits, f, indent=1)
        os.replace(kit_api.KITS_FILE + ".tmp", kit_api.KITS_FILE)


def _forget_camera(short):
    import kit_api
    with open(kit_api.KITS_FILE + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            kits = json.load(open(kit_api.KITS_FILE))
        except (OSError, ValueError):
            return
        e = dict(kits.get(short) or {})
        if not e.get("router"):
            return
        for k in ("host", "router"):
            e.pop(k, None)
        e["via"] = "cloud"
        e["pull"] = "ftp" if e.get("ftp") else None
        if not e["pull"]:
            e.pop("pull")
        kits[short] = e
        with open(kit_api.KITS_FILE + ".tmp", "w") as f:
            json.dump(kits, f, indent=1)
        os.replace(kit_api.KITS_FILE + ".tmp", kit_api.KITS_FILE)
    env = {**os.environ, "HOME": "/root"}
    subprocess.run([CLI, "device", "remove", short], capture_output=True, env=env, timeout=30)


def sync():
    """Boot / every 2 min: firewall, route and peers in place; find cameras behind live routers."""
    import kit_api
    with _Locked():
        peers = load()
        if peers:
            ensure_firewall()
            ensure_route()
        hs = handshakes()
        live_pubs = set(hs)
        changed = False
        for short, p in peers.items():
            if p["pub"] not in live_pubs:
                ensure_peer(short, p)
                print(f"{short}: peer re-added")
            age = time.time() - hs.get(p["pub"], 0)
            if age > 180:
                continue  # router not connected right now
            cam = p.get("camera")
            if cam and _open9000(cam):
                continue
            ip = discover(short, p["n"])
            if ip and ip != cam:
                _, user, password = kit_api._camera(short)
                _set_alias(short, ip, user, password)
                _remember_camera(short, ip)
                p["camera"] = ip
                changed = True
                print(f"{short}: camera at {ip}")
        if changed:
            save(peers)


if __name__ == "__main__":
    if sys.argv[1:] == ["sync"]:
        sync()
    else:
        print(__doc__)
        sys.exit(2)
