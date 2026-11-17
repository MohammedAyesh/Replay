#!/opt/replay/venv/bin/python
"""Measure the pitch for portable-camera set-ups whose footage and analysis are in.

cron (*/10):  /opt/replay/autocal/bin/kit_autocal_worker.py >> /var/log/replay-kit-autocal.log 2>&1

  GET  {REPLAY_API_BASE}/api/worker/kit-setups/pending          (x-worker-key)
  run  autocal_session.py --guid <video> --t0 --t1 --job <analysis job> --mast-height <typed>
  POST {REPLAY_API_BASE}/api/worker/kit-setups/<id>/calibration  {ok, lengthM, widthM, ..., pitchModel}

The saved pitch size is deliberately NOT given to autocal: the app compares the measurement
with it (3% rule), which only means something if the measurement didn't start from it.
One set-up at a time (flock); a set-up whose analysis isn't done yet is left for the next run.
"""
import fcntl
import json
import os
import subprocess
import sys
import urllib.request

ENV = "/etc/replay/gpu-worker.env"
SESSION = "/opt/replay/autocal/src/autocal_session.py"
PY = "/opt/replay/venv/bin/python"
DONE_ANALYSIS = {"succeeded", "complete", "completed", "done"}
FAILED_ANALYSIS = {"failed", "cancelled"}


def env(name):
    for line in open(ENV):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"{name} missing from {ENV}")


def api(method, path, body=None):
    req = urllib.request.Request(env("REPLAY_API_BASE").rstrip("/") + "/api" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", "x-worker-key": env("ANALYSIS_WORKER_KEY")})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def wall_minutes(local):
    d, t = local.split(" ")
    y, m, dd = map(int, d.split("-"))
    hh, mm = map(int, t.split(":")[:2])
    import datetime
    return int(datetime.datetime(y, m, dd, hh, mm).timestamp() // 60)


def window(s):
    """10 minutes of play, starting 10 minutes in (players settled, light the same as the match)."""
    dur = max(0, (wall_minutes(s["endLocal"]) - wall_minutes(s["startLocal"])) * 60)
    t0 = min(600.0, dur * 0.3)
    t1 = min(t0 + 600.0, dur * 0.9)
    return t0, t1


def summary(out):
    cal = json.load(open(os.path.join(out, "calibration.json")))
    pol = cal.get("polished") or {}
    pitch = pol.get("pitch") or cal.get("pitch") or {}
    cam = pol.get("camera") or cal.get("camera") or {}
    checks = cal.get("checks") or {}
    verdict = cal.get("verdict") or {}
    if verdict.get("status") == "fail":
        return {"ok": False, "error": verdict.get("line") or "We couldn't measure the pitch from this recording."}
    warnings = list(dict.fromkeys((checks.get("warnings") or []) + (verdict.get("reasons") or [])))
    model = json.load(open(os.path.join(out, "pitchmodel.json")))
    aspect = checks.get("circle_aspect")
    return {
        "ok": True,
        "lengthM": pitch.get("length_m"), "widthM": pitch.get("width_m"),
        "tiltDeg": cam.get("tilt_deg"), "rollDeg": cam.get("roll_deg"),
        "linesPx": checks.get("line_rms_worst_px"),
        "circleAspectPct": (abs(aspect - 1) * 100) if isinstance(aspect, (int, float)) else None,
        "statureM": checks.get("stature_median"),
        "warnings": warnings[:10],
        "pitchModel": model,
    }


def main():
    lock = open("/run/lock/kit-autocal.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    for s in api("GET", "/worker/kit-setups/pending").get("setups", []):
        sid = s["setupId"]
        status = (s.get("analysisStatus") or "").lower()
        if status in FAILED_ANALYSIS:
            api("POST", f"/worker/kit-setups/{sid}/calibration", {"ok": False, "error": "The match analysis failed, so the pitch couldn't be measured."})
            continue
        if status not in DONE_ANALYSIS or not s.get("analysisJobId"):
            print(f"setup {sid}: analysis {status or 'not queued'}; later")
            continue
        t0, t1 = window(s)
        if t1 - t0 < 120:
            api("POST", f"/worker/kit-setups/{sid}/calibration", {"ok": False, "error": "The recording is too short to measure the pitch."})
            continue
        out = f"/opt/replay/autocal/sessions/kit-setup-{sid}"
        cmd = [PY, SESSION, "--guid", s["videoId"], "--t0", str(t0), "--t1", str(t1), "--job", str(s["analysisJobId"]),
               "--mast-height", str(s["mastHeightM"]), "--cam", s["cameraId"].replace("camera", "cam"), "--label", f"kit-setup-{sid}", "--out", out]
        print("RUN", " ".join(cmd))
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        print(r.stdout[-1500:], r.stderr[-800:])
        try:
            body = summary(out)
        except (OSError, ValueError) as e:
            body = {"ok": False, "error": "We couldn't measure the pitch: %s" % (r.stderr.strip().splitlines() or [str(e)])[-1][:200]}
        print(sid, api("POST", f"/worker/kit-setups/{sid}/calibration", body))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - cron log
        print("kit autocal:", e, file=sys.stderr)
        sys.exit(1)
