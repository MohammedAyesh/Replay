#!/usr/bin/env bash
# Serve fields' own domains (Field console → Website & domain) from vps1.
#
# A field points its domain's A record (and www) at vps1 (169.58.73.17). Caddy:
#   - gets a Let's Encrypt certificate the first time the domain is visited (on-demand TLS),
#     but only after asking the app GET https://replayjo.com/api/venue-site/domain-allowed?domain=…
#     which says yes only for a domain a field has saved in its console;
#   - proxies every request to replayjo.com. The web app sees a hostname that isn't Replay's
#     and shows that field's booking website (artifacts/soccerwatch/src/lib/venue-host.ts).
#
# Idempotent: re-running changes nothing once it's in place. The existing Caddyfile (Qudra on
# :443) is backed up, extended with an import, validated, and restored if validation fails.
#
# Run from a machine with SSH to vps1:
#   ssh root@vps1 "tr -d '\r' | bash -s" < install-caddy-sites.sh
# or drop it in the replay-ops inbox for vps1-agent.ps1.
set -uo pipefail

APP="${REPLAY_APP_HOST:-replayjo.com}"
ASK_URL="https://${APP}/api/venue-site/domain-allowed"
CADDYFILE=/etc/caddy/Caddyfile
SITES=/etc/caddy/replay-venue-sites.caddy
STAMP="$(date -u +%Y%m%d-%H%M%S)"

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   OK   %s\n' "$*"; }
warn() { printf '   WARN %s\n' "$*"; }
die()  { printf '   FAIL %s\n' "$*"; printf '\nRESULT: FAILED\n'; exit 1; }

say "Host"
[ "$(id -u)" = 0 ] || die "run as root"
echo "   $(hostname) · UTC $(date -u +%FT%TZ)"

say "Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  warn "caddy not installed; installing from the official repository"
  apt-get update -qq && apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null || die "apt prerequisites"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null || die "caddy install"
fi
caddy version | sed 's/^/   /'
[ -f "$CADDYFILE" ] || { echo "{" > "$CADDYFILE"; echo "}" >> "$CADDYFILE"; warn "created an empty $CADDYFILE"; }

say "Is the app answering Caddy's question?"
code=$(curl -s -o /dev/null -w '%{http_code}' "${ASK_URL}?domain=not-a-field.invalid" || true)
if [ "$code" = 404 ]; then ok "ask endpoint answers 404 for an unknown domain"
else warn "ask endpoint answered ${code:-nothing} (expected 404). Publish the app first; continuing."; fi

say "Back up"
cp -a "$CADDYFILE" "${CADDYFILE}.bak-${STAMP}" && ok "${CADDYFILE}.bak-${STAMP}"

say "Site block for fields' domains"
cat > "$SITES" <<EOF
# Fields' own domains → replayjo.com (written by install-caddy-sites.sh ${STAMP}).
https:// {
	tls {
		on_demand
	}
	encode zstd gzip
	reverse_proxy https://${APP} {
		header_up Host ${APP}
		header_up X-Forwarded-Host {host}
		header_up X-Venue-Host {host}
		transport http {
			tls_server_name ${APP}
		}
	}
}

http:// {
	redir https://{host}{uri} permanent
}
EOF
ok "$SITES"

say "Global on_demand_tls"
if grep -q "on_demand_tls" "$CADDYFILE"; then
  ok "already present (check its ask URL is ${ASK_URL})"
  grep -n -A3 "on_demand_tls" "$CADDYFILE" | sed 's/^/   /'
else
  first=$(grep -v -E '^\s*(#|$)' "$CADDYFILE" | head -1 | tr -d '[:space:]')
  tmp=$(mktemp)
  if [ "$first" = "{" ]; then
    # Insert into the existing global options block, right after its opening brace.
    awk -v ask="$ASK_URL" 'BEGIN{done=0} { print } !done && $0 ~ /^[[:space:]]*\{[[:space:]]*$/ { print "\ton_demand_tls {"; print "\t\task " ask; print "\t}"; done=1 }' "$CADDYFILE" > "$tmp"
  else
    { printf '{\n\ton_demand_tls {\n\t\task %s\n\t}\n}\n\n' "$ASK_URL"; cat "$CADDYFILE"; } > "$tmp"
  fi
  cat "$tmp" > "$CADDYFILE" && rm -f "$tmp"
  ok "added on_demand_tls { ask ${ASK_URL} }"
fi

say "Import"
if grep -q "import ${SITES}" "$CADDYFILE"; then ok "already imported"
else printf '\nimport %s\n' "$SITES" >> "$CADDYFILE"; ok "import added at the end"; fi

say "Validate"
if caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
  ok "valid"
else
  sed 's/^/   /' /tmp/caddy-validate.log | tail -20
  cp -a "${CADDYFILE}.bak-${STAMP}" "$CADDYFILE"
  die "invalid config; restored the backup"
fi

say "Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ok "80 and 443 open"
else ok "ufw not active"; fi

say "Reload"
systemctl reload caddy || systemctl restart caddy || die "caddy reload"
sleep 2
systemctl is-active --quiet caddy && ok "caddy active" || die "caddy not active"

say "Qudra and other sites still answer"
for host in $(grep -oE '^[a-z0-9.-]+\.[a-z]{2,}' "$CADDYFILE" | sort -u); do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${host}/" || true)
  echo "   ${host}: ${c:-no answer}"
done

printf '\nRESULT: OK\n'
echo "Next: a field saves its domain in Field console → Website & domain, points A records for"
echo "@ and www at this server, and opens https://<domain>. The first visit issues the certificate."
