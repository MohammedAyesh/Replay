#!/usr/bin/env bash
# Deploy the off-schedule FTP gap store to vps1. Run as root from a copy of ops/gapstore/.
#   ./deploy.sh            install code + config, mount the API, dry-run the camera schedule
#   ./deploy.sh --enable   also switch it on: camera FTP schedule now, then cron
# Undo: rm /etc/cron.d/reocam-gapstore; python3 /opt/reocam/gapstore/gapstore.py disable cam1;
#       restore /opt/replay/control.py from its .bak-*-gapstore and restart replay-control.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/reocam/gapstore
STAMP="$(date -u +%Y%m%d-%H%M%S)"
CONTROL=/opt/replay/control.py

mkdir -p "$DEST"/{clips,jobs,state,work}
for f in gapstore.py gapstore_api.py; do
  [ -f "$DEST/$f" ] && cp -p "$DEST/$f" "$DEST/$f.bak-$STAMP"
done
install -m 0755 "$SRC/gapstore.py" "$DEST/gapstore.py"
install -m 0644 "$SRC/gapstore_api.py" "$DEST/gapstore_api.py"
[ -f /etc/reocam/gapstore.json ] || install -m 0644 "$SRC/gapstore.json.example" /etc/reocam/gapstore.json
python3 -m py_compile "$DEST/gapstore.py"
/opt/replay/venv/bin/python3 -m py_compile "$DEST/gapstore_api.py"
/opt/replay/venv/bin/python3 -c "import sys; sys.path.insert(0,'$DEST'); import gapstore_api" 

# Mount the router into the control API (once). Backup first; never sed a running script.
if ! grep -q "gapstore_router" "$CONTROL"; then
  cp -p "$CONTROL" "$CONTROL.bak-$STAMP-gapstore"
  python3 - "$CONTROL" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
anchor = "app.include_router(analysis_quote_router)\n"
block = ('\n# Off-schedule FTP gap store -- see /opt/reocam/gapstore/gapstore_api.py. Added 2026-10-30.\n'
         'import sys as _gs_sys\n'
         '_gs_sys.path.insert(0, "/opt/reocam/gapstore")\n'
         'from gapstore_api import router as gapstore_router\n'
         'app.include_router(gapstore_router)\n')
assert src.count(anchor) == 1, "anchor not found"
open(path + ".new", "w").write(src.replace(anchor, anchor + block))
PY
  /opt/replay/venv/bin/python3 -m py_compile "$CONTROL.new"
  mv "$CONTROL.new" "$CONTROL"
  RESTART=1
fi
if [ "${RESTART:-0}" = 1 ] || [ "${FORCE_RESTART:-0}" = 1 ]; then
  systemctl restart replay-control
  for i in $(seq 1 20); do
    sleep 1
    code=$(printf 'header = "x-api-key: %s"\n' "$(grep '^CONTROL_KEY=' /opt/replay/env | tail -1 | cut -d= -f2-)" \
           | curl -s -o /dev/null -w '%{http_code}' -K - http://127.0.0.1:8080/gapstore/status || true)
    [ "$code" = 200 ] && break
  done
  echo "control API /gapstore/status -> $code"
  [ "$code" = 200 ] || { echo "control API did not come back with the route; restoring"; cp -p "$CONTROL.bak-$STAMP-gapstore" "$CONTROL"; systemctl restart replay-control; exit 1; }
fi
systemctl is-active replay-control

echo "== camera schedule (dry run)"
python3 "$DEST/gapstore.py" sync-schedule --dry-run || true

if [ "${1:-}" = "--enable" ]; then
  python3 "$DEST/gapstore.py" sync-schedule
  install -m 0644 "$SRC/reocam-gapstore.cron" /etc/cron.d/reocam-gapstore
  echo "cron installed: FTP schedule sync every 5 min, ingest every minute"
fi
echo "== store"
python3 "$DEST/gapstore.py" status
