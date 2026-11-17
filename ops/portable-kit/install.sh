#!/bin/bash
# Portable camera kits on vps1. CHANGES vps1: run only with Mohammed's go-ahead.
#   1. kit_api.py next to control.py, mounted with two lines, replay-control restarted
#   2. kit_autocal_worker.py into /opt/replay/autocal/bin, cron */10
#   3. /etc/replay/kits.json created empty if missing (kit camera addresses go there)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
cd /opt/replay
cp -a control.py "control.py.bak-$STAMP"
install -m 0644 "$HERE/kit_api.py" /opt/replay/kit_api.py
if ! grep -q "from kit_api import router" control.py; then
  python3 - <<'PY'
p = "/opt/replay/control.py"
s = open(p).read()
anchor = "app.include_router(gapstore_router)\n"
assert anchor in s, "anchor missing"
s = s.replace(anchor, anchor + "\n# Portable camera kits: status, snapshot, WiFi -- see kit_api.py. Added 2026-11-17.\nfrom kit_api import router as kit_router\napp.include_router(kit_router)\n", 1)
open(p, "w").write(s)
PY
fi
/opt/replay/venv/bin/python -c "import ast,sys; ast.parse(open('/opt/replay/control.py').read())"
install -m 0755 "$HERE/kit_autocal_worker.py" /opt/replay/autocal/bin/kit_autocal_worker.py
[ -f /etc/replay/kits.json ] || echo '{}' > /etc/replay/kits.json
( crontab -l 2>/dev/null | grep -v kit_autocal_worker.py; echo "*/10 * * * *  /opt/replay/autocal/bin/kit_autocal_worker.py >> /var/log/replay-kit-autocal.log 2>&1" ) | crontab -
systemctl restart replay-control
sleep 3
systemctl is-active replay-control
KEY=$(grep '^CONTROL_KEY=' /opt/replay/env | cut -d= -f2-)
curl -s -o /dev/null -w "kit status cam1: %{http_code}\n" -H @<(printf "x-api-key: %s" "$KEY") http://127.0.0.1:8080/kit/cam1/status
curl -s -o /dev/null -w "live status cam1: %{http_code}\n" -H @<(printf "x-api-key: %s" "$KEY") http://127.0.0.1:8080/live/status/cam1
echo "backup: /opt/replay/control.py.bak-$STAMP"
