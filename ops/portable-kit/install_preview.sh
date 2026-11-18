#!/bin/bash
# Kit live preview on vps1. CHANGES vps1 (approved by Mohammed 2026-11-18):
#   kit_api.py (preview routes) + kit_preview.py into /opt/replay, the replay-kitpreview@ unit,
#   then replay-control restarted. Needs the Docker image quantumentangledandy/neolink:latest.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
docker image inspect quantumentangledandy/neolink:latest >/dev/null
cp -a /opt/replay/kit_api.py "/opt/replay/kit_api.py.bak-$STAMP"
install -m 0644 "$HERE/kit_api.py" /opt/replay/kit_api.py
install -m 0755 "$HERE/kit_preview.py" /opt/replay/kit_preview.py
install -m 0644 "$HERE/replay-kitpreview@.service" /etc/systemd/system/replay-kitpreview@.service
install -d -m 0700 /var/lib/replay-kitpreview
/opt/replay/venv/bin/python -c "import ast; ast.parse(open('/opt/replay/kit_api.py').read()); ast.parse(open('/opt/replay/kit_preview.py').read())"
systemctl daemon-reload
systemctl restart replay-control
sleep 3
systemctl is-active replay-control
echo "backup: /opt/replay/kit_api.py.bak-$STAMP"
