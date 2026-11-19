#!/opt/replay/venv/bin/python
"""Kit FTP: a private, encrypted FTP login per portable camera, set up by the user in the app.

    kitftp.py sync        (replay-kitnet.timer, every 2 min: storage cap + age limit)

The user types the details the app shows into the Reolink app's FTP page with "FTPS only" on. The
camera then uploads its recordings to /opt/reocam/incoming/camN/upload/ and bookings for that
camera are assembled from those clips (ftp_window_job.py) instead of the SD card.

Per camera: system user reoftp_camN (no shell, chrooted by vsftpd), a 24-character random password
shown once, a vsftpd per-user file that refuses unencrypted logins and data, and a live-hold marker
so the public hourly archive (process-all.sh) never publishes these clips.

Disk: clips arrive at 4-5 GB an hour, and vps1 is shared. Each camera keeps at most
KITFTP_MAX_GB (default 8) and nothing older than KITFTP_MAX_HOURS (default 24); clips a booking
still needs are kept. If the disk falls under KITFTP_MIN_FREE_GB (default 12), the oldest kit clips
go first. Replay's own cameras' folders are never touched.
"""
import calendar
import fcntl
import json
import os
import pwd
import re
import secrets
import shutil
import string
import subprocess
import sys
import time

sys.path.insert(0, "/opt/replay")

INCOMING = "/opt/reocam/incoming"
USERLIST = "/etc/vsftpd.reocam_users"
USER_CONF = "/etc/vsftpd_user_conf"
HOLD_DIR = "/opt/reocam/live-hold"
SERVER = os.environ.get("KITFTP_SERVER", "169.58.73.17")
MAX_GB = float(os.environ.get("KITFTP_MAX_GB", "8"))
MAX_HOURS = float(os.environ.get("KITFTP_MAX_HOURS", "24"))
MIN_FREE_GB = float(os.environ.get("KITFTP_MIN_FREE_GB", "12"))
RESERVE_DIR = "/opt/replay/jobs/ftpwin"   # <cam>.<jobId> -> "start|end" (Amman) a booking still needs
OWN_CAMS = {"cam1", "cam2", "cam3"}
TS = re.compile(r"(\d{14})(?=\D*$)")


def sh(*cmd, input=None):
    r = subprocess.run(cmd, input=input, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]}: {r.stderr.strip()[:200]}")
    return r.stdout


def _short(cam):
    s = cam.replace("camera", "cam", 1)
    if not re.fullmatch(r"cam\d{1,3}", s) or s in OWN_CAMS:
        raise ValueError("bad camera")
    return s


def _kits_update(short, fn):
    import kit_api
    with open(kit_api.KITS_FILE + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            kits = json.load(open(kit_api.KITS_FILE))
        except (OSError, ValueError):
            kits = {}
        e = dict(kits.get(short) or {})
        fn(e)
        kits[short] = e
        with open(kit_api.KITS_FILE + ".tmp", "w") as f:
            json.dump(kits, f, indent=1)
        os.replace(kit_api.KITS_FILE + ".tmp", kit_api.KITS_FILE)


def _userlist(add=None, drop=None):
    with open(USERLIST + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        names = [l.strip() for l in open(USERLIST) if l.strip()]
        if add and add not in names:
            names.append(add)
        if drop:
            names = [n for n in names if n != drop]
        with open(USERLIST + ".tmp", "w") as f:
            f.write("\n".join(names) + "\n")
        shutil.copymode(USERLIST, USERLIST + ".tmp")
        os.replace(USERLIST + ".tmp", USERLIST)


def create(cam):
    """New login (or a new password for an existing one). Returns the details ONCE."""
    short = _short(cam)
    user = f"reoftp_{short}"
    home = os.path.join(INCOMING, short)
    up = os.path.join(home, "upload")
    try:
        pwd.getpwnam(user)
    except KeyError:
        sh("useradd", "-M", "-d", home, "-s", "/usr/sbin/nologin", user)
    # vsftpd chroot rules: the root is root-owned 755, the upload dir is the user's.
    os.makedirs(up, exist_ok=True)
    os.chown(home, 0, 0)
    os.chmod(home, 0o755)
    pw = pwd.getpwnam(user)
    os.chown(up, pw.pw_uid, pw.pw_gid)
    os.chmod(up, 0o755)
    alphabet = string.ascii_letters + string.digits
    password = "".join(secrets.choice(alphabet) for _ in range(24))
    sh("chpasswd", input=f"{user}:{password}\n")
    os.makedirs(USER_CONF, mode=0o755, exist_ok=True)
    with open(os.path.join(USER_CONF, user), "w") as f:
        f.write("force_local_logins_ssl=YES\nforce_local_data_ssl=YES\n")
    _userlist(add=user)
    os.makedirs(HOLD_DIR, exist_ok=True)
    open(os.path.join(HOLD_DIR, f"{short}.kitftp"), "w").write("portable camera FTP: bookings only, never the public archive\n")

    def mark(e):
        e["ftp"] = {"user": user, "since": int(time.time())}
        if e.get("pull") != "cli":
            e["pull"] = "ftp"
    _kits_update(short, mark)
    return {"server": SERVER, "port": 21, "user": user, "password": password, "folder": "/upload", "ftpsOnly": True}


def remove(cam):
    short = _short(cam)
    user = f"reoftp_{short}"
    _userlist(drop=user)
    try:
        sh("usermod", "-L", "-e", "1", user)   # locked, not deleted: the uid keeps owning old clips
    except RuntimeError:
        pass
    for p in (os.path.join(USER_CONF, user), os.path.join(HOLD_DIR, f"{short}.kitftp")):
        try:
            os.remove(p)
        except OSError:
            pass

    def unmark(e):
        e.pop("ftp", None)
        if e.get("pull") == "ftp":
            e.pop("pull")
    _kits_update(short, unmark)
    shutil.rmtree(os.path.join(INCOMING, short, "upload"), ignore_errors=True)
    return {"removed": True}


def clips(short):
    """[(start_epoch_utc, path, size)] oldest first. Camera clocks are Amman (UTC+3)."""
    up = os.path.join(INCOMING, short, "upload")
    out = []
    for root, _, files in os.walk(up):
        for name in files:
            m = TS.search(name)
            if not m or not name.lower().endswith(".mp4"):
                continue
            try:
                t = time.strptime(m.group(1), "%Y%m%d%H%M%S")
            except ValueError:
                continue
            path = os.path.join(root, name)
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            out.append((calendar.timegm(t) - 3 * 3600, path, size))   # Amman is UTC+3 all year
    out.sort()
    return out


def status(cam):
    short = _short(cam)
    import kit_api
    e = kit_api.kit_entry(short)
    if not e.get("ftp"):
        return {"configured": False}
    c = clips(short)
    last = c[-1][0] if c else None
    return {
        "configured": True,
        "server": SERVER, "port": 21, "user": e["ftp"]["user"], "folder": "/upload",
        "lastClipSecondsAgo": int(time.time() - last) if last else None,
        "clips": len(c), "storedGB": round(sum(s for _, _, s in c) / 1e9, 2),
    }


def _reserved(short):
    """Windows (UTC epochs) that pending bookings still need, with a margin."""
    out = []
    try:
        names = os.listdir(RESERVE_DIR)
    except OSError:
        return out
    for n in names:
        if not n.startswith(short + "."):
            continue
        try:
            a, b = open(os.path.join(RESERVE_DIR, n)).read().strip().split("|")
            out.append((int(a) - 1800, int(b) + 600))
        except Exception:
            continue
    return out


def sync():
    import kit_api
    try:
        kits = json.load(open(kit_api.KITS_FILE))
    except (OSError, ValueError):
        kits = {}
    cams = [k for k, e in kits.items() if e.get("ftp") and k not in OWN_CAMS]
    now = time.time()
    victims = []
    for short in cams:
        keep = _reserved(short)
        c = clips(short)
        total = sum(s for _, _, s in c)
        for t, path, size in c:
            if any(a <= t <= b for a, b in keep):
                continue
            too_old = now - t > MAX_HOURS * 3600
            too_big = total > MAX_GB * 1e9
            if too_old or too_big:
                os.remove(path)
                total -= size
                print(f"{short}: removed {os.path.basename(path)} ({'age' if too_old else 'cap'})")
            else:
                victims.append((t, path, size, short))
    # Disk low: oldest unreserved kit clips first, across cameras.
    victims.sort()
    for t, path, size, short in victims:
        if shutil.disk_usage(INCOMING).free >= MIN_FREE_GB * 1e9:
            break
        try:
            os.remove(path)
            print(f"{short}: removed {os.path.basename(path)} (disk low)")
        except OSError:
            pass


if __name__ == "__main__":
    if sys.argv[1:] == ["sync"]:
        sync()
    else:
        print(__doc__)
        sys.exit(2)
