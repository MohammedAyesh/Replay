"""
Method B clip export -- control API routes (x-api-key), included by control.py.

  POST   /export/clip                 submit (idempotent per clip + parameters)
  GET    /export/clip/{job}           status
  GET    /export/clip/{job}/file      the MP4 (Range supported)
  DELETE /export/clip/{job}           refused; exports and job state are retained
  GET    /export/health               can this method take work right now?

Each render runs in its own transient systemd unit (clipexport-<job>), so a
restart of replay-control never touches a render in progress, and a render can
never take the control API down with it (MemoryMax, Nice).

See clip_export/render.py for why this exists. Added 2026-09-29.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import time

from fastapi import APIRouter, Body, Header, HTTPException
from fastapi.responses import FileResponse

JOBS_DIR = "/opt/replay/jobs/clipexport"
OUT_DIR = "/opt/replay/exports"
RENDER = "/opt/replay/clip_export/render.py"
PYTHON = "/opt/replay/venv/bin/python"
LOG = "/var/log/replay-clipexport.log"
MIN_FREE_GB = 15
# A job whose worker is gone and which has not written its state for this long
# is dead (killed, reboot) and is relaunched on the next submit.
STALE_SEC = 180

router = APIRouter()


def _key():
    key = ""
    try:
        for line in open("/opt/replay/env"):
            if line.startswith("CONTROL_KEY="):
                key = line.split("=", 1)[1].strip()
    except OSError:
        pass
    return key


def _auth(k):
    if not k or k != _key():
        raise HTTPException(401)


def _valid_job(job):
    if not re.fullmatch(r"c\d{1,12}-[0-9a-f]{16}", job or ""):
        raise HTTPException(400, "bad job id")


def _state(job):
    try:
        with open(os.path.join(JOBS_DIR, job + ".json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _unit(job):
    return "clipexport-%s" % job


def _unit_active(job):
    r = subprocess.run(["systemctl", "is-active", "--quiet", _unit(job)])
    return r.returncode == 0


def _public(st):
    """What the app sees -- never the spec's URLs or local paths."""
    if st is None:
        return None
    out = st.get("output") or {}
    return {
        "job": st.get("job"),
        "clipId": st.get("clipId"),
        "status": st.get("status"),
        "stage": st.get("stage"),
        "progress": st.get("progress", 0),
        "error": st.get("error"),
        "errorKind": st.get("errorKind"),
        "attempt": st.get("attempt"),
        "createdAt": st.get("createdAt"),
        "updatedAt": st.get("updatedAt"),
        "finishedAt": st.get("finishedAt"),
        "renderSeconds": st.get("renderSeconds"),
        "output": {k: out.get(k) for k in ("bytes", "duration", "width", "height", "hasAudio", "branded")}
        if out else None,
        "running": _unit_active(st["job"]) if st.get("job") else False,
    }


def _launch(job):
    subprocess.run(["systemctl", "reset-failed", _unit(job)], capture_output=True)
    r = subprocess.run(
        ["systemd-run", "--unit", _unit(job), "--collect", "--quiet",
         "-p", "Nice=10", "-p", "MemoryMax=6G", "-p", "RuntimeMaxSec=7200",
         "-p", "StandardOutput=append:%s" % LOG, "-p", "StandardError=append:%s" % LOG,
         PYTHON, RENDER, job],
        capture_output=True, text=True)
    if r.returncode != 0:
        raise HTTPException(503, "could not start render: %s" % r.stderr.strip()[-200:])


def job_id(spec):
    # Branding is deliberately not part of the identity: it is best effort, and
    # two callers that resolved it differently must still land on the same job.
    canon = json.dumps({k: spec.get(k) for k in
                        ("videoId", "startTime", "endTime", "cropPath", "aspectRatio")},
                       sort_keys=True, separators=(",", ":"))
    return "c%d-%s" % (int(spec["clipId"]), hashlib.sha256(canon.encode()).hexdigest()[:16])


@router.post("/export/clip")
def submit(body: dict = Body(...), x_api_key: str = Header(None)):
    _auth(x_api_key)
    try:
        spec = {
            "clipId": int(body["clipId"]),
            "videoId": str(body["videoId"]),
            "startTime": float(body["startTime"]),
            "endTime": float(body["endTime"]),
            "cropPath": body.get("cropPath") or [],
            "aspectRatio": "9:16" if body.get("aspectRatio") == "9:16" else "16:9",
            "title": str(body.get("title") or "")[:120],
            "overlayUrl": body.get("overlayUrl") or None,
        }
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(400, "bad request: %s" % e)
    if not re.fullmatch(r"[0-9a-fA-F-]{16,64}", spec["videoId"]):
        raise HTTPException(400, "videoId is not a Bunny Stream GUID")
    if not isinstance(spec["cropPath"], list) or len(spec["cropPath"]) > 5000:
        raise HTTPException(400, "cropPath must be a list of at most 5000 keyframes")

    job = job_id(spec)
    os.makedirs(JOBS_DIR, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    st = _state(job)
    force = bool(body.get("retry"))

    if st:
        ready = st.get("status") == "ready" and os.path.exists(os.path.join(OUT_DIR, job + ".mp4"))
        if ready:
            return _public(st)
        alive = _unit_active(job) or (time.time() - (st.get("updatedAt") or 0) < STALE_SEC
                                      and st.get("status") not in ("failed", "ready"))
        if alive:
            return _public(st)
        if st.get("status") == "failed" and st.get("errorKind") in ("source_gone", "permanent") and not force:
            return _public(st)
        if st.get("status") == "failed" and not force and time.time() - (st.get("finishedAt") or 0) < 60:
            return _public(st)  # do not hot-loop a failing job; the app retries later

    if shutil.disk_usage(OUT_DIR).free / 1e9 < MIN_FREE_GB:
        raise HTTPException(507, "vps1 disk below %d GB free" % MIN_FREE_GB)

    now = time.time()
    fresh = {"job": job, "clipId": spec["clipId"], "spec": spec, "status": "queued", "stage": "Queued",
             "progress": 0, "createdAt": (st or {}).get("createdAt", now), "updatedAt": now,
             "submissions": (st or {}).get("submissions", 0) + 1}
    tmp = os.path.join(JOBS_DIR, job + ".json.tmp")
    with open(tmp, "w") as f:
        json.dump(fresh, f)
    os.replace(tmp, os.path.join(JOBS_DIR, job + ".json"))
    _launch(job)
    return _public(fresh)


@router.get("/export/clip/{job}")
def status(job: str, x_api_key: str = Header(None)):
    _auth(x_api_key)
    _valid_job(job)
    st = _state(job)
    if st is None:
        raise HTTPException(404, "no such export job")
    pub = _public(st)
    # A worker that died without writing "failed" (OOM kill, reboot) must not
    # look like it is still rendering forever.
    if (pub["status"] not in ("ready", "failed") and not pub["running"]
            and time.time() - (st.get("updatedAt") or 0) > STALE_SEC):
        pub["status"] = "failed"
        pub["errorKind"] = "lost"
        pub["error"] = "render process is gone (last update %ds ago)" % (time.time() - (st.get("updatedAt") or 0))
    return pub


@router.get("/export/clip/{job}/file")
def file(job: str, x_api_key: str = Header(None)):
    _auth(x_api_key)
    _valid_job(job)
    path = os.path.join(OUT_DIR, job + ".mp4")
    st = _state(job)
    if not st or st.get("status") != "ready" or not os.path.exists(path):
        raise HTTPException(404, "export not ready")
    return FileResponse(path, media_type="video/mp4", filename="clip-%s.mp4" % st.get("clipId"))


@router.delete("/export/clip/{job}")
def delete(job: str, x_api_key: str = Header(None)):
    _auth(x_api_key)
    _valid_job(job)
    # vps1-export URLs are durable references.  In particular, do not stop a
    # render or remove either its finished MP4 or the state needed to serve it.
    raise HTTPException(405, "finished clip exports and job records are retained permanently")


@router.get("/export/health")
def health(x_api_key: str = Header(None)):
    _auth(x_api_key)
    free = shutil.disk_usage(OUT_DIR if os.path.isdir(OUT_DIR) else "/").free / 1e9
    running = subprocess.run(["systemctl", "list-units", "--no-legend", "--state=active", "clipexport-*"],
                             capture_output=True, text=True).stdout.count("clipexport-")
    return {"ok": free >= MIN_FREE_GB and os.path.exists(RENDER), "freeGB": round(free, 1),
            "running": running, "method": "vps1"}
