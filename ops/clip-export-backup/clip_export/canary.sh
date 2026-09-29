#!/bin/bash
# Daily check that the backup clip exporter (Method B) still works end to end,
# and a report of how often the app's own exporter (Method A) needed it.
#
#  1. Renders a fixed 6-second window of the newest ready Bunny Stream video
#     through the real control API path (POST /export/clip -> poll -> GET file).
#  2. Counts clips the app handed to vps1 in the last 24 h. Any hand-over means
#     Method A failed for a real user — the user still got the clip, but
#     Method A needs looking at.
# Alerts go to the same ntfy topic as replay-alert.sh. Added 2026-09-29.
set -u
. /etc/replay/alert.env 2>/dev/null || true
ENVF=/opt/replay/env
get() { grep "^$1=" "$ENVF" | tail -1 | cut -d= -f2- | tr -d '"'"'"; }
KEY=$(get CONTROL_KEY); LIB=$(get BUNNY_STREAM_LIB); SKEY=$(get BUNNY_STREAM_KEY)
STATE=/opt/replay/clip_export/canary.json
notify() {
  echo "$(date -u +%FT%TZ) $1"
  [ -n "${ALERT_NTFY_TOPIC:-}" ] && curl -s -m 20 -H "Title: Replay clip export" -d "$1" "https://ntfy.sh/$ALERT_NTFY_TOPIC" >/dev/null
}

GUID=$(curl -s -m 30 -H "AccessKey: $SKEY" "https://video.bunnycdn.com/library/$LIB/videos?page=1&itemsPerPage=20&orderBy=date" \
  | /opt/replay/venv/bin/python -c 'import json,sys; v=[x for x in json.load(sys.stdin).get("items",[]) if x.get("status")==4 and x.get("length",0)>60]; print(v[0]["guid"] if v else "")')
if [ -z "$GUID" ]; then notify "Canary could not find a ready recording to test with"; exit 1; fi

BODY=$(printf '{"clipId":0,"videoId":"%s","startTime":0.5,"endTime":0.5,"cropPath":[{"t":0,"x":0.25,"y":0,"w":0.5,"h":1},{"t":1,"x":0.3,"y":0,"w":0.5,"h":1}],"aspectRatio":"16:9","title":"canary","retry":true}' "$GUID")
# 6 s window: endTime is set from the video length below.
LEN=$(curl -s -m 30 -H "AccessKey: $SKEY" "https://video.bunnycdn.com/library/$LIB/videos/$GUID" | /opt/replay/venv/bin/python -c 'import json,sys; print(json.load(sys.stdin).get("length",0))')
END=$(/opt/replay/venv/bin/python -c "print(round(0.5 + 6.0/max(1,$LEN), 8))")
BODY=${BODY/\"endTime\":0.5/\"endTime\":$END}
# Fresh job every day: drop yesterday's canary output first.
OLD=$(ls /opt/replay/jobs/clipexport/c0-*.json 2>/dev/null)
for f in $OLD; do j=$(basename "$f" .json); curl -s -m 20 -X DELETE -H "X-Api-Key: $KEY" "http://127.0.0.1:8080/export/clip/$j" >/dev/null; done

JOB=$(curl -s -m 30 -X POST -H "X-Api-Key: $KEY" -H "Content-Type: application/json" -d "$BODY" http://127.0.0.1:8080/export/clip \
  | /opt/replay/venv/bin/python -c 'import json,sys; print(json.load(sys.stdin).get("job",""))')
[ -z "$JOB" ] && { notify "Backup exporter REFUSED the canary job — Method B is down"; exit 1; }
STATUS=""
for i in $(seq 1 120); do
  sleep 10
  STATUS=$(curl -s -m 20 -H "X-Api-Key: $KEY" "http://127.0.0.1:8080/export/clip/$JOB" | /opt/replay/venv/bin/python -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status"), d.get("error") or "")')
  case "$STATUS" in ready*|failed*) break;; esac
done
BYTES=$(curl -s -m 60 -H "X-Api-Key: $KEY" -o /tmp/canary.mp4 -w '%{http_code} %{size_download}' "http://127.0.0.1:8080/export/clip/$JOB/file")
DUR=$(timeout 20 ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/canary.mp4 2>/dev/null)
rm -f /tmp/canary.mp4

HANDOVERS=$(find /opt/replay/jobs/clipexport -name 'c[1-9]*.json' -newermt '-24 hours' 2>/dev/null | wc -l)
printf '{"at":"%s","video":"%s","job":"%s","status":"%s","download":"%s","duration":"%s","handovers24h":%s}\n' \
  "$(date -u +%FT%TZ)" "$GUID" "$JOB" "$STATUS" "$BYTES" "$DUR" "$HANDOVERS" > "$STATE"

case "$STATUS" in
  ready*) ok=1 ;;
  *) ok=0 ;;
esac
if [ "$ok" = 1 ] && [ "${BYTES%% *}" = 200 ] && [ -n "$DUR" ]; then
  echo "$(date -u +%FT%TZ) canary ok: $JOB $BYTES ${DUR}s"
else
  notify "Backup clip exporter canary FAILED: status=$STATUS download=$BYTES duration=$DUR"
fi
if [ "$HANDOVERS" -gt 0 ]; then
  notify "$HANDOVERS clip export(s) in the last 24 h fell back to vps1 — users got their clips, but the app's own exporter (Method A) is failing. Check the API log for 'Primary export failed'."
fi
