#!/bin/bash
# Install Method B (backup clip exporter) on vps1. Idempotent. 2026-09-29.
# Expects the payload next to it:  clip_export_api.py  clip_export/{render.py,cleanup.sh,canary.sh}
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
TS=$(date +%Y%m%d-%H%M%S)

install -d -m 755 /opt/replay/clip_export /opt/replay/exports /opt/replay/exports/work /opt/replay/jobs/clipexport
install -m 755 "$SRC/clip_export/render.py"  /opt/replay/clip_export/render.py
install -m 755 "$SRC/clip_export/cleanup.sh" /opt/replay/clip_export/cleanup.sh
install -m 755 "$SRC/clip_export/canary.sh"  /opt/replay/clip_export/canary.sh
install -m 644 "$SRC/clip_export_api.py"     /opt/replay/clip_export_api.py

# Syntax and imports under the interpreter that will run them.
/opt/replay/venv/bin/python -m py_compile /opt/replay/clip_export/render.py /opt/replay/clip_export_api.py
/opt/replay/venv/bin/python -c "import numpy, cv2, fastapi; print('deps ok', numpy.__version__, cv2.__version__)"

# Wire the router into the control API: two lines after the VAR router, once.
if ! grep -q "clip_export_api" /opt/replay/control.py; then
  cp -p /opt/replay/control.py "/opt/replay/control.py.bak-$TS-clipexport"
  /opt/replay/venv/bin/python - <<'EOF'
p = "/opt/replay/control.py"
s = open(p).read()
anchor = "app.include_router(var_router)\n"
assert s.count(anchor) == 1, "anchor not found exactly once"
s = s.replace(anchor, anchor + "\n# Backup clip exporter (Method B) -- see clip_export_api.py. Added 2026-09-29.\n"
              "from clip_export_api import router as clip_export_router\n"
              "app.include_router(clip_export_router)\n")
open(p, "w").write(s)
EOF
  /opt/replay/venv/bin/python -m py_compile /opt/replay/control.py
fi

# Cron: nightly retention, daily canary (08:10 Amman = 05:10 UTC; the box is Berlin time, so use CRON_TZ).
CRON=/etc/cron.d/replay-clipexport
cat > "$CRON" <<'EOF'
CRON_TZ=UTC
20 3 * * * root /opt/replay/clip_export/cleanup.sh >> /var/log/replay-clipexport.log 2>&1
10 5 * * * root /opt/replay/clip_export/canary.sh >> /var/log/replay-clipexport.log 2>&1
EOF
chmod 644 "$CRON"

# Restart the control API (KillMode=process: running renders and live jobs are untouched).
systemctl restart replay-control
for i in $(seq 1 20); do
  sleep 1
  curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/docs | grep -q 200 && break
done
KEY=$(grep '^CONTROL_KEY=' /opt/replay/env | tail -1 | cut -d= -f2-)
echo "health: $(curl -s -m 10 -H "X-Api-Key: $KEY" http://127.0.0.1:8080/export/health)"
echo "live status still answers: $(curl -s -m 10 -o /dev/null -w '%{http_code}' -H "X-Api-Key: $KEY" http://127.0.0.1:8080/live/status/cam1)"
