#!/opt/replay/venv/bin/python
"""
Give every finished vps1 clip export a permanent copy in Bunny Storage.

Mohammed, 2026-09-29: "Clips should never be deleted ever." A vps1 export
lives on one disk with no backup; this copies it to the same storage zone and
folder Method A uses (galaxyfield/clips/), so the app can switch the clip to an
ordinary Storage URL and vps1 keeps its own copy as the second one.

  to_storage.py <job>     copy one ready job (called by render.py after a render)
  to_storage.py --all     copy every ready job that has no copy yet (cron, backfill)

The upload is streamed (curl -T), the key goes to curl on stdin (-K -), never
argv, and Bunny verifies the file against a SHA-256 Checksum header, so a copy
is recorded only when Bunny holds exactly the bytes on disk. The result is
written into the job's state as {"storage": {"url", "path", "bytes", "sha256",
"uploadedAt"}} and the control API reports it as storageUrl.
"""
import fcntl
import glob
import hashlib
import json
import os
import subprocess
import sys
import time

JOBS_DIR = "/opt/replay/jobs/clipexport"
OUT_DIR = "/opt/replay/exports"
ZONE = "galaxyfield"
FOLDER = "clips"
LOCK = "/run/lock/clipexport-to-storage.lock"
LOG = "/var/log/replay-clipexport.log"


def read_key():
    key = ""
    try:
        for line in open("/opt/replay/env"):
            if line.startswith("BUNNY_STORAGE_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")  # last one wins
    except OSError:
        pass
    return key


def log(msg):
    line = "%s [to_storage] %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg)
    try:
        with open(LOG, "a") as f:
            f.write(line)
    except OSError:
        sys.stderr.write(line)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest().upper()


def update_state(job, storage):
    path = os.path.join(JOBS_DIR, job + ".json")
    with open(path) as f:
        st = json.load(f)
    st["storage"] = storage
    tmp = path + ".storage.tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, path)


def copy_one(job, key):
    path = os.path.join(JOBS_DIR, job + ".json")
    try:
        with open(path) as f:
            st = json.load(f)
    except (OSError, ValueError):
        return "no-state"
    if st.get("status") != "ready":
        return "not-ready"
    if (st.get("storage") or {}).get("url"):
        return "already"
    mp4 = os.path.join(OUT_DIR, job + ".mp4")
    if not os.path.exists(mp4):
        return "no-file"
    size = os.path.getsize(mp4)
    digest = sha256(mp4)
    rel = "%s/%s.mp4" % (FOLDER, job)
    url = "https://storage.bunnycdn.com/%s/%s" % (ZONE, rel)
    cfg = 'header = "AccessKey: %s"\nheader = "Checksum: %s"\nheader = "Content-Type: video/mp4"\n' % (key, digest)
    r = subprocess.run(["curl", "-s", "-K", "-", "-o", "/dev/null", "-w", "%{http_code}",
                        "--max-time", "900", "-X", "PUT", "-T", mp4, url],
                       input=cfg, capture_output=True, text=True)
    code = r.stdout.strip()
    if code != "201":
        log("%s upload failed: HTTP %s %s" % (job, code, r.stderr.strip()[-200:]))
        return "failed:%s" % code
    # Read back the object's size: a 201 with a verified checksum is already
    # strong, this also proves it is listable where the app will look.
    chk = subprocess.run(["curl", "-s", "-K", "-", "-o", "/dev/null", "-D", "-", "-r", "0-0", url],
                         input='header = "AccessKey: %s"\n' % key, capture_output=True, text=True)
    total = None
    for line in chk.stdout.splitlines():
        if line.lower().startswith("content-range:") and "/" in line:
            try:
                total = int(line.rsplit("/", 1)[1].strip())
            except ValueError:
                pass
    if total != size:
        log("%s read-back mismatch: storage %s bytes, disk %d" % (job, total, size))
        return "mismatch"
    update_state(job, {"url": url, "path": "%s/%s" % (ZONE, rel), "bytes": size,
                       "sha256": digest, "uploadedAt": time.time()})
    log("%s copied to storage (%d bytes)" % (job, size))
    return "copied"


def main():
    key = read_key()
    if not key:
        sys.exit("BUNNY_STORAGE_KEY missing from /opt/replay/env")
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    lock = open(LOCK, "w")
    if sys.argv[1:] == ["--all"]:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # another sweep is running
        jobs = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(JOBS_DIR, "c*.json")))
        tally = {}
        for job in jobs:
            res = copy_one(job, key)
            tally[res.split(":")[0]] = tally.get(res.split(":")[0], 0) + 1
        if tally.get("copied") or tally.get("failed") or tally.get("mismatch"):
            log("sweep: %s" % json.dumps(tally, sort_keys=True))
        if sys.stdout.isatty():
            print(json.dumps(tally, sort_keys=True))
        return 0
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    fcntl.flock(lock, fcntl.LOCK_SH)  # never overlap a sweep on the same job
    res = copy_one(sys.argv[1], key)
    print(res)
    return 0 if res in ("copied", "already") else 1


if __name__ == "__main__":
    sys.exit(main())
