#!/usr/bin/env bash
# Read-only. Prints what the gap store must fit around on vps1. Prints no secret values.
set -u
echo "== disk"; df -h / /opt 2>/dev/null
echo "== hold markers now"; ls -la /opt/reocam/live-hold /opt/reocam/var-only 2>&1
echo "== how holds are tested"
grep -nE "live-hold|var-only" /opt/reocam/process-all.sh /opt/reocam/process.sh /opt/replay/livehold.py \
  /opt/replay/var_mode.py /opt/replay/ops/cam_ftp.py /opt/replay/livepan*.py 2>/dev/null | head -60
echo "== cam_ftp.py (what live/VAR do to the FTP schedule)"; sed -n 1,400p /opt/replay/ops/cam_ftp.py 2>/dev/null
echo "== who deletes incoming clips"
grep -rnE "incoming" /opt/replay/*.py /opt/replay/*.sh /opt/reocam/*.sh /etc/cron.d/* 2>/dev/null | grep -vE "^\s*#" | head -60
echo "== control.py: app object, auth, record-hq, sd available"
grep -nE "FastAPI\(|include_router|x-api-key|x_api_key|API_KEY|def .*record_hq|/sd/|/ftp/|@app\.(get|post|delete)" /opt/replay/control.py | head -80
echo "== env key NAMES only"
for f in /opt/replay/env /etc/reocam/bunny.env /etc/replay/bunny-live.env; do echo "-- $f"; sed -E 's/=.*/=<set>/' "$f" 2>/dev/null; done
echo "== collections.json shape"; python3 -c "import json;d=json.load(open('/etc/reocam/collections.json'));print({k:type(v).__name__ for k,v in d.items()})" 2>&1
echo "== vsftpd / incoming layout"; ls -la /opt/reocam/incoming/*/ 2>&1 | head -30; grep -nE "^(xferlog|local_root|chroot|user_sub_token)" /etc/vsftpd.conf 2>/dev/null
echo "== systemd units touching FTP"; systemctl list-units --all 'replay-*' --no-pager 2>/dev/null | head -40
echo "== python + ffmpeg"; python3 --version; /usr/bin/ffmpeg -version | head -1; python3 -c "import fastapi;print('fastapi',fastapi.__version__)"
