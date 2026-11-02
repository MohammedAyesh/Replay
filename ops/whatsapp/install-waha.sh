#!/usr/bin/env bash
# Install / update WAHA (WhatsApp HTTP API) on vps1 for academy WhatsApp messaging.
#
# Idempotent: safe to re-run. Linked WhatsApp sessions live in /opt/waha/sessions
# and survive a re-run (the container is recreated, the volume is not).
#
#   - Container  replay-waha  (devlikeapro/waha:gows — Go engine, no browser)
#   - Port       3000/tcp, every request needs X-Api-Key
#   - API key    the replay-control key; WAHA stores only its SHA-512, so the app
#                needs no new secret (it already holds CONTABO_CONTROL_KEY)
#   - Cron       every minute POST https://replayjo.com/api/whatsapp/tick, which
#                queues due reminders and sends what is waiting (the API runs on
#                autoscale and has no timer of its own)
#
# Run from a machine with SSH to vps1:
#   ssh root@vps1 "tr -d '\r' | bash -s" < install-waha.sh
set -uo pipefail

IMAGE="${WAHA_IMAGE:-devlikeapro/waha:gows}"
NAME="replay-waha"
PORT="${WAHA_PORT:-3000}"
TICK_URL="${WHATSAPP_TICK_URL:-https://replayjo.com/api/whatsapp/tick}"
ENV_FILE=/etc/replay/waha.env
HEADERS_FILE=/etc/replay/whatsapp-tick.headers
TICK_SCRIPT=/opt/replay/whatsapp_tick.sh
TICK_LOG=/var/log/replay-whatsapp-tick.log
STAMP="$(date -u +%Y%m%d-%H%M%S)"

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   OK   %s\n' "$*"; }
warn() { printf '   WARN %s\n' "$*"; }
die()  { printf '   FAIL %s\n' "$*"; printf '\nRESULT: FAILED\n'; exit 1; }

say "Host"
[ "$(id -u)" = 0 ] || die "run as root"
echo "   $(hostname) · $(. /etc/os-release; echo "$PRETTY_NAME") · $(uname -m) · UTC $(date -u +%FT%TZ)"
[ "$(uname -m)" = x86_64 ] || die "the GOWS image is x86-only"
df -h / | tail -1 | awk '{print "   disk: " $4 " free of " $2}'
free -m | awk '/Mem:/ {print "   memory: " $7 " MB available of " $2}'

# ─── 1. The control key ──────────────────────────────────────────────────────
say "Finding the replay-control API key (tested against 127.0.0.1:8080)"
PROBE_PATH=""
for path in /recordings /record-hq /live/status/camera1; do
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "x-api-key: wrong-$RANDOM" "http://127.0.0.1:8080$path")"
  if [ "$code" = 401 ] || [ "$code" = 403 ]; then PROBE_PATH="$path"; break; fi
done
[ -n "$PROBE_PATH" ] || die "replay-control on :8080 did not refuse a wrong key on any known path (is it running?)"
echo "   probing with GET $PROBE_PATH (a wrong key is refused)"
probe() { curl -s -o /dev/null -m 8 -w '%{http_code}' -H "x-api-key: $1" "http://127.0.0.1:8080$PROBE_PATH"; }

CANDIDATES="$(mktemp)"; chmod 600 "$CANDIDATES"
PID="$(systemctl show -p MainPID --value replay-control 2>/dev/null || echo 0)"
if [ -n "$PID" ] && [ "$PID" != 0 ] && [ -r "/proc/$PID/environ" ]; then
  tr '\0' '\n' < "/proc/$PID/environ" >> "$CANDIDATES"
fi
for f in $(systemctl show -p EnvironmentFiles --value replay-control 2>/dev/null | tr ' ' '\n' | grep '^/' ) /opt/replay/env /etc/replay/*.env; do
  [ -r "$f" ] && grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$f" >> "$CANDIDATES"
done
CONTROL_KEY=""; KEY_NAME=""
while IFS= read -r line; do
  name="${line%%=*}"; value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  echo "$name" | grep -Eqi 'KEY|TOKEN|SECRET' || continue
  [ "${#value}" -ge 8 ] || continue
  if [ "$(probe "$value")" = 200 ]; then CONTROL_KEY="$value"; KEY_NAME="$name"; break; fi
done < "$CANDIDATES"
rm -f "$CANDIDATES"
[ -n "$CONTROL_KEY" ] || die "no environment value of replay-control opens GET $PROBE_PATH; cannot derive the WAHA key"
ok "the key is \$$KEY_NAME (sha256 prefix $(printf %s "$CONTROL_KEY" | sha256sum | cut -c1-8))"
KEY_SHA512="$(printf %s "$CONTROL_KEY" | sha512sum | cut -d' ' -f1)"

# ─── 2. Docker ───────────────────────────────────────────────────────────────
say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "   installing docker.io from Ubuntu"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io >/dev/null || die "apt-get install docker.io failed"
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die "docker is installed but not running"
ok "$(docker --version)"

OWNER="$(ss -ltnpH "sport = :$PORT" 2>/dev/null | head -1)"
if [ -n "$OWNER" ] && ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "   $OWNER"
  die "port $PORT is already used by something other than $NAME"
fi

# ─── 3. Config ───────────────────────────────────────────────────────────────
say "Config ($ENV_FILE)"
mkdir -p /etc/replay /opt/waha/sessions /opt/waha/media
DASH_PASS=""
[ -f "$ENV_FILE" ] && DASH_PASS="$(grep '^WAHA_DASHBOARD_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)" && cp -a "$ENV_FILE" "$ENV_FILE.bak-$STAMP"
[ -n "$DASH_PASS" ] || DASH_PASS="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
umask 077
cat > "$ENV_FILE" <<EOF
# WAHA for Replay academies. Written by install-waha.sh $STAMP.
# API key = sha512 of replay-control's \$$KEY_NAME; clients send the plain key as X-Api-Key.
WAHA_API_KEY=sha512:$KEY_SHA512
WHATSAPP_DEFAULT_ENGINE=GOWS
WAHA_DASHBOARD_ENABLED=true
WAHA_DASHBOARD_USERNAME=replay
WAHA_DASHBOARD_PASSWORD=$DASH_PASS
WHATSAPP_SWAGGER_ENABLED=false
WAHA_RESTART_ALL_SESSIONS=True
WHATSAPP_RESTART_ALL_SESSIONS=True
WAHA_AUTO_START_DELAY_SECONDS=2
WAHA_PRINT_QR=False
WAHA_LOG_LEVEL=info
WHATSAPP_FILES_LIFETIME=180
TZ=Asia/Amman
EOF
chmod 600 "$ENV_FILE"
umask 022
ok "written (dashboard user 'replay', password in the file)"

# ─── 4. Container ────────────────────────────────────────────────────────────
say "Container $NAME from $IMAGE"
docker pull -q "$IMAGE" >/dev/null || die "docker pull $IMAGE failed"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  -p "$PORT:3000" \
  --env-file "$ENV_FILE" \
  -v /opt/waha/sessions:/app/.sessions \
  -v /opt/waha/media:/tmp/whatsapp-files \
  --memory 1536m --cpus 1.5 \
  --log-opt max-size=20m --log-opt max-file=3 \
  "$IMAGE" >/dev/null || die "docker run failed"

VERSION=""
for _ in $(seq 1 45); do
  VERSION="$(curl -s -m 3 -H "X-Api-Key: $CONTROL_KEY" "http://127.0.0.1:$PORT/api/server/version" || true)"
  echo "$VERSION" | grep -q '"version"' && break
  sleep 2
done
echo "$VERSION" | grep -q '"version"' || { docker logs --tail 40 "$NAME" 2>&1 | sed 's/^/   | /'; die "WAHA did not answer on :$PORT"; }
ok "WAHA up: $VERSION"
NOKEY="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/api/sessions")"
[ "$NOKEY" = 401 ] && ok "a request without the key is refused (401)" || warn "a request without the key got HTTP $NOKEY (expected 401)"
SESSIONS="$(curl -s -m 5 -H "X-Api-Key: $CONTROL_KEY" "http://127.0.0.1:$PORT/api/sessions?all=true")"
echo "   sessions: $SESSIONS"

# ─── 5. Firewall ─────────────────────────────────────────────────────────────
say "Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'Status: active'; then
  ufw allow "$PORT/tcp" >/dev/null && ok "ufw: $PORT/tcp allowed"
else
  ok "ufw not active"
fi
echo "   (Docker publishes the port through its own iptables rules either way.)"

# ─── 6. Tick ─────────────────────────────────────────────────────────────────
say "Every-minute tick → $TICK_URL"
umask 077
printf 'x-api-key: %s\n' "$CONTROL_KEY" > "$HEADERS_FILE"
umask 022
chmod 600 "$HEADERS_FILE"
mkdir -p /opt/replay
cat > "$TICK_SCRIPT.new" <<EOF
#!/usr/bin/env bash
# POSTs the WhatsApp tick to the app every minute (cron). Logs only failures and
# minutes where something was sent or queued. Key sits in a 600 header file, never in argv.
exec 9>/run/lock/whatsapp-tick.lock
flock -n 9 || exit 0
URL="\${WHATSAPP_TICK_URL:-$TICK_URL}"
OUT="\$(curl -sS -m 58 -X POST -H @$HEADERS_FILE -w '\n%{http_code}' "\$URL" 2>&1)"
CODE="\${OUT##*\$'\n'}"
BODY="\${OUT%\$'\n'*}"
if [ "\$CODE" != 200 ] || echo "\$BODY" | grep -Eq '"(sent|failed|reminders|fees|subscriptions)":[1-9]'; then
  echo "\$(date -u +%FT%TZ) \$CODE \$(echo "\$BODY" | head -c 600)" >> $TICK_LOG
fi
EOF
chmod 755 "$TICK_SCRIPT.new" && mv "$TICK_SCRIPT.new" "$TICK_SCRIPT"
echo '* * * * * root /opt/replay/whatsapp_tick.sh' > /etc/cron.d/replay-whatsapp-tick
chmod 644 /etc/cron.d/replay-whatsapp-tick
cat > /etc/logrotate.d/replay-whatsapp <<EOF
$TICK_LOG {
  weekly
  rotate 4
  compress
  missingok
  notifempty
  size 5M
}
EOF
ok "cron installed"
FIRST="$(curl -sS -m 58 -X POST -H @"$HEADERS_FILE" -w ' HTTP %{http_code}' "$TICK_URL" 2>&1 | tail -c 400)"
echo "   first tick: $FIRST"
case "$FIRST" in
  *"HTTP 200"*) ok "the app accepted the tick";;
  *"HTTP 404"*) warn "the app has no /api/whatsapp/tick yet: publish the app, then this starts working by itself";;
  *"HTTP 401"*) warn "the app rejected the key: its CONTABO_CONTROL_KEY differs from \$$KEY_NAME";;
  *) warn "unexpected tick answer";;
esac

say "Summary"
docker ps --filter "name=$NAME" --format '   {{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}'
echo "   WAHA API:   http://169.58.73.17:$PORT  (X-Api-Key = replay-control key)"
echo "   Dashboard:  http://169.58.73.17:$PORT/dashboard  (user replay, password in $ENV_FILE)"
echo "   Sessions:   /opt/waha/sessions   Tick log: $TICK_LOG"
printf '\nRESULT: OK\n'
