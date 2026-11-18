#!/bin/bash
# Portable kits, full quality: router tunnels (kitnet.py) + encrypted FTP (kitftp.py, ftp_window_job.py).
# CHANGES vps1 (approved by Mohammed 2026-11-18). Backups: *.bak-<stamp>. Run from the folder holding the files.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
# The two core files must still be the versions these edits were made against.
[ "$(md5sum < /opt/replay/control.py | cut -c1-32)" = "b3f324b6bbdd019c6165589dc5c95311" ] || { echo "ABORT: control.py changed on vps1"; exit 1; }
[ "$(md5sum < /opt/replay/sdpull_cli_job.py | cut -c1-32)" = "37028c38a2262e8f5fb79f63af534cea" ] || { echo "ABORT: sdpull_cli_job.py changed on vps1"; exit 1; }
for f in /opt/replay/control.py /opt/replay/sdpull_cli_job.py /opt/replay/kit_api.py /etc/vsftpd.conf /etc/replay/kits.json /root/.config/reolink-cli/aliases.toml /etc/vsftpd.reocam_users; do
  cp -a "$f" "$f.bak-$STAMP"
done
for f in control.py.vps1 sdpull_cli_job.py.vps1 kit_api.py kitnet.py kitftp.py ftp_window_job.py; do
  /opt/replay/venv/bin/python -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$HERE/$f"
done
install -m 0644 "$HERE/control.py.vps1" /opt/replay/control.py
install -m 0755 "$HERE/sdpull_cli_job.py.vps1" /opt/replay/sdpull_cli_job.py
install -m 0644 "$HERE/kit_api.py" /opt/replay/kit_api.py
install -m 0755 "$HERE/kitnet.py" /opt/replay/kitnet.py
install -m 0755 "$HERE/kitftp.py" /opt/replay/kitftp.py
install -m 0755 "$HERE/ftp_window_job.py" /opt/replay/ftp_window_job.py
install -m 0644 "$HERE/replay-kitnet.service" /etc/systemd/system/replay-kitnet.service
install -m 0644 "$HERE/replay-kitnet.timer" /etc/systemd/system/replay-kitnet.timer
install -d -m 0700 /etc/replay/kitnet
install -d -m 0755 /etc/vsftpd_user_conf /opt/replay/jobs/ftpwin

# vsftpd: TLS available to everyone, required only for kit logins (per-user files). Jordan
# Galaxy's cam1/cam2 logins keep working exactly as before.
/usr/bin/python3 - <<'PY'
import re
p = "/etc/vsftpd.conf"
want = {"ssl_enable": "YES", "allow_anon_ssl": "NO", "force_local_logins_ssl": "NO",
        "force_local_data_ssl": "NO", "require_ssl_reuse": "NO", "ssl_ciphers": "HIGH",
        "user_config_dir": "/etc/vsftpd_user_conf"}
lines = open(p).read().split("\n")
seen = set()
out = []
for l in lines:
    m = re.match(r"^([a-z_]+)=", l)
    if m and m.group(1) in want:
        if m.group(1) in seen:
            continue                      # never leave a duplicate directive (vsftpd 500 OOPS)
        seen.add(m.group(1))
        out.append(f"{m.group(1)}={want[m.group(1)]}")
    else:
        out.append(l)
if out and out[-1] == "":
    out.pop()
out.append("# 2026-11-18 portable kits: TLS on, forced per kit login in /etc/vsftpd_user_conf")
for k, v in want.items():
    if k not in seen:
        out.append(f"{k}={v}")
open(p, "w").write("\n".join(out) + "\n")
PY
systemctl restart vsftpd; sleep 2
if ! systemctl is-active --quiet vsftpd || ! timeout 8 bash -c 'exec 3<>/dev/tcp/127.0.0.1/21; head -c 3 <&3' | grep -q 220; then
  echo "vsftpd did not come back: restoring its config"; cp -a /etc/vsftpd.conf.bak-$STAMP /etc/vsftpd.conf; systemctl restart vsftpd; exit 1
fi
echo "vsftpd: $(systemctl is-active vsftpd), TLS: $(timeout 8 openssl s_client -connect 127.0.0.1:21 -starttls ftp -brief </dev/null 2>&1 | grep -m1 -oE 'Protocol version: \S+')"

systemctl daemon-reload
systemctl enable --now replay-kitnet.timer
systemctl restart replay-control; sleep 3
echo "replay-control: $(systemctl is-active replay-control)"
echo "backups: *.bak-$STAMP"
