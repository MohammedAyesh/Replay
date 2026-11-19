#!/opt/replay/venv/bin/python3
"""A booking on a portable camera that sends its recordings by FTP.

    ftp_window_job.py <cam> "<start>" "<end>" "<title>" <jobId>     (Amman local "YYYY-MM-DD HH:MM:SS")

control.py starts this instead of scheduled_pull.py / sdpull_cli_job.py when kits.json says the
camera's footage arrives by FTP (pull=ftp). Same job JSON (/opt/replay/jobs/hq/<cam>/<jobId>.json)
and statuses, so the app polls it like any booking:

  scheduled -> recording -> waiting   (the camera uploads each recording after it closes)
  -> exec sdpull_cli_job.py with SDPULL_FILES: trim, assemble, 8K handling and upload are that
     job's, unchanged.

The clips this booking needs are reserved (/opt/replay/jobs/ftpwin/<cam>.<jobId>) so kitftp.py's
storage cap can't delete them, then hard-linked into the job's work dir before the hand-over.
"""
import calendar
import datetime
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, "/opt/replay")
import kitftp  # noqa: E402

CAM, START_S, END_S, TITLE, JOB = sys.argv[1:6]
SETTLE = int(os.environ.get("FTPWIN_SETTLE_SECONDS", "300"))     # after the end, before deciding
DEADLINE = int(os.environ.get("FTPWIN_DEADLINE_SECONDS", "2700"))  # give up waiting for uploads
JDIR = f"/opt/replay/jobs/hq/{CAM}"
JPATH = f"{JDIR}/{JOB}.json"
WORK = f"/opt/reocam/rescue/job_{JOB}"
RESERVE = os.path.join(kitftp.RESERVE_DIR, f"{CAM}.{JOB}")
os.makedirs(JDIR, exist_ok=True)
os.makedirs(kitftp.RESERVE_DIR, exist_ok=True)


def parse(s):
    if s.endswith(" 24:00:00"):
        return datetime.datetime.strptime(s[:10], "%Y-%m-%d") + datetime.timedelta(days=1)
    return datetime.datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


def epoch(amman_dt):
    return calendar.timegm(amman_dt.timetuple()) - 3 * 3600


T0, T1 = parse(START_S), parse(END_S)
E0, E1 = epoch(T0), epoch(T1)

try:
    state = json.load(open(JPATH))
except (OSError, ValueError):
    state = {}
state.update({"jobId": JOB, "cam": CAM, "source": "ftp", "engine": "ftp", "title": TITLE,
              "requested": {"start": START_S, "end": END_S}, "videoId": None, "playbackUrl": None,
              "error": None, "percent": 0})


def flush(**kw):
    state.update(kw, updatedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    with open(JPATH + ".tmp", "w") as f:
        json.dump(state, f)
    os.replace(JPATH + ".tmp", JPATH)


def done_reserving():
    try:
        os.remove(RESERVE)
    except OSError:
        pass


def duration(path):
    try:
        out = subprocess.run(["timeout", "5", "ffprobe", "-v", "error", "-show_entries", "format=duration",
                              "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()
        return float(out)
    except Exception:
        return 0.0


def settled(path):
    """Not still being uploaded: size unchanged for 5 s."""
    try:
        a = os.path.getsize(path)
        time.sleep(5)
        return a == os.path.getsize(path) and a > 0
    except OSError:
        return False


with open(RESERVE, "w") as f:
    f.write(f"{E0}|{E1}\n")

try:
    # 1. wait for the match to be played
    while time.time() < E0:
        flush(status="scheduled", phase="scheduled", message="scheduled")
        time.sleep(min(60, max(1, E0 - time.time())))
    while time.time() < E1:
        flush(status="recording", phase="recording", message="the camera is recording; clips arrive by FTP")
        time.sleep(min(60, max(1, E1 - time.time())))

    # 2. wait for the uploads: a clip that starts after the end, or the deadline
    give_up = E1 + DEADLINE
    while True:
        c = kitftp.clips(CAM)
        after = [p for t, p, _ in c if t >= E1]
        if time.time() >= E1 + SETTLE and (after or time.time() >= give_up):
            break
        flush(status="recording", phase="waiting",
              message=f"waiting for the camera to upload ({len([1 for t, _, _ in c if E0 - 3600 <= t < E1])} clip(s) so far)")
        time.sleep(30)

    # 3. the clips that overlap the window
    picked = []
    for t, path, _ in kitftp.clips(CAM):
        if t >= E1 or t < E0 - 3 * 3600:
            continue
        d = duration(path)
        if d <= 1 or t + d <= E0 or not settled(path):
            continue
        picked.append((t, path))
    if not picked:
        flush(status="failed", phase="failed", error="no clips arrived by FTP for this time",
              message="No recordings arrived by FTP for this time. Is FTP on in the Reolink app, with a schedule?")
        sys.exit(1)

    # 4. hard-link into the work dir (the storage cap may then clean the originals freely)
    os.makedirs(WORK, exist_ok=True)
    files = []
    for i, (t, path) in enumerate(sorted(picked)):
        dst = os.path.join(WORK, f"ftp_{i:04d}.mp4")
        if not os.path.exists(dst):
            os.link(path, dst)
        amman = datetime.datetime.utcfromtimestamp(t + 3 * 3600)
        files.append({"start": amman.strftime("%Y-%m-%d %H:%M:%S"), "path": dst})
    with open(os.path.join(WORK, "ftp_files.json"), "w") as f:
        json.dump(files, f)
    done_reserving()
    flush(status="running", phase="assemble", message=f"{len(files)} clip(s) received; assembling")

    # 5. hand over: same jobId, same JSON
    env = {**os.environ, "SDPULL_FILES": os.path.join(WORK, "ftp_files.json")}
    sys.stdout.flush()
    os.execve("/opt/replay/venv/bin/python3",
              ["/opt/replay/venv/bin/python3", "/opt/replay/sdpull_cli_job.py", CAM, START_S, END_S, TITLE, JOB], env)
except SystemExit:
    done_reserving()
    raise
except Exception as e:
    done_reserving()
    flush(status="failed", phase="failed", error=f"crashed: {str(e)[:200]}", message="the FTP booking crashed")
    raise
