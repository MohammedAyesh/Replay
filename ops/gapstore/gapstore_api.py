"""FastAPI routes for the off-schedule FTP gap store, mounted into control.py:

    from gapstore_api import router as gapstore_router
    app.include_router(gapstore_router)

Every route needs the control API's x-api-key. The key is read the same way
control.py reads it (CONTROL_KEY in /opt/replay/env). With no key found every call is refused.

  GET    /gapstore/status
  GET    /gapstore/{cam}/available[?date=YYYY-MM-DD]
  GET    /gapstore/{cam}/coverage?start=...&end=...
  POST   /gapstore/{cam}/pull?start=...&end=...&title=...
  GET    /gapstore/pulls
  GET    /gapstore/{cam}/pull/{job_id}
  DELETE /gapstore/{cam}/pull/{job_id}

start/end are "YYYY-MM-DD HH:MM[:SS]" Amman local, as for /record-hq.
"""
from __future__ import annotations

import hmac
import os
import sys

from fastapi import APIRouter, Header, HTTPException, Query

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gapstore as gs  # noqa: E402

KEY_ENV_NAMES = [n for n in os.environ.get(
    "GAPSTORE_API_KEY_ENV", "CONTROL_KEY").split(",") if n]


def _expected_key() -> str | None:
    env_file = gs.read_env_file(gs.REPLAY_ENV_FILE)   # control.py reads CONTROL_KEY here (last wins)
    for name in KEY_ENV_NAMES:
        value = env_file.get(name) or os.environ.get(name)
        if value:
            return value
    return None


def _auth(x_api_key: str | None) -> None:
    expected = _expected_key()
    if not expected or not x_api_key or not hmac.compare_digest(expected, x_api_key):
        raise HTTPException(status_code=401, detail="invalid api key")


def _cam(cam: str) -> str:
    try:
        name = gs.norm_cam(cam)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid camera")
    if name not in gs.load_config()["cameras"]:
        raise HTTPException(status_code=404, detail="Unknown camera")
    return name


router = APIRouter()


@router.get("/gapstore/status")
def gap_status(x_api_key: str | None = Header(default=None)):
    _auth(x_api_key)
    return gs.status(gs.load_config())


@router.get("/gapstore/{cam}/available")
def gap_available(cam: str, date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                  x_api_key: str | None = Header(default=None)):
    _auth(x_api_key)
    return gs.available(gs.load_config(), _cam(cam), date)


@router.get("/gapstore/{cam}/coverage")
def gap_coverage(cam: str, start: str, end: str, x_api_key: str | None = Header(default=None)):
    _auth(x_api_key)
    try:
        s, e = gs.amman_wall_to_utc(start), gs.amman_wall_to_utc(end)
    except ValueError:
        raise HTTPException(status_code=400, detail="start/end must be YYYY-MM-DD HH:MM[:SS]")
    return {"cam": _cam(cam), **gs.coverage(_cam(cam), s, e)}


@router.post("/gapstore/{cam}/pull")
def gap_pull(cam: str, start: str, end: str, title: str, x_api_key: str | None = Header(default=None)):
    _auth(x_api_key)
    name = _cam(cam)
    try:
        job = gs.create_job(name, start, end, title)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    gs.launch_job(job["jobId"])
    return {**job, "poll": f"/gapstore/{name}/pull/{job['jobId']}"}


@router.get("/gapstore/pulls")
def gap_pulls(x_api_key: str | None = Header(default=None)):
    _auth(x_api_key)
    return {"jobs": gs.list_jobs()}


@router.get("/gapstore/{cam}/pull/{job_id}")
def gap_pull_status(cam: str, job_id: str, x_api_key: str | None = Header(default=None)):
    _auth(x_api_key)
    try:
        job = gs.read_job(job_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="bad job id")
    if not job or job.get("cam") != _cam(cam):
        raise HTTPException(status_code=404, detail="job not found")
    return job


@router.delete("/gapstore/{cam}/pull/{job_id}")
def gap_pull_cancel(cam: str, job_id: str, x_api_key: str | None = Header(default=None)):
    _auth(x_api_key)
    try:
        job = gs.read_job(job_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="bad job id")
    if not job or job.get("cam") != _cam(cam):
        raise HTTPException(status_code=404, detail="job not found")
    return gs.cancel_job(job_id)
