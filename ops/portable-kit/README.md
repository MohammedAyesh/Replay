# Portable kits on vps1

Three pieces, installed together by `install.sh` (it changes vps1: run only with Mohammed's go-ahead):

- `kit_api.py`: mounted into `control.py`. `GET /kit/<cam>/status`, `GET /kit/<cam>/snapshot`
  (the Check the view picture), `POST /kit/<cam>/wifi` (Reolink SetWifi, read-modify-write).
  Kit camera addresses come from `/etc/replay/kits.json`; cam1–cam3 keep 192.168.66.x.
- `kit_autocal_worker.py`: cron `*/10`. Asks the app for set-ups whose footage and analysis are
  in (`/api/worker/kit-setups/pending`), runs `autocal_session.py` with the mast height that was
  typed at set-up (and never the saved pitch size, so the app's 3% check means something), and
  posts the result back. Uses `REPLAY_API_BASE` and `ANALYSIS_WORKER_KEY` from
  `/etc/replay/gpu-worker.env`.
- `/etc/replay/kits.json`: created empty.

Until this is installed the app still works: the preview says it isn't switched on, the online
check says it can't check from here, and set-ups wait in "Measuring".

A kit's recordings are always queued for analysis (lib/liveAnalysis.ts, `isKitField`), whatever
"Analyse bookings during the match" says: autocal needs the player boxes, and the stats are the point.

## Low-quality live preview (2026-11-18)

`kit_preview.py` + `replay-kitpreview@.service` + preview routes in `kit_api.py`; install with `install_preview.sh`.
The app's "Watch live (low quality)" buttons (view check, recording screen, console camera cards) call
`POST /api/kits/:kitId/preview` → vps1 `POST /kit/<cam>/preview`, then play `/api/kits/:kitId/preview/index.m3u8`.

- vps1 connects straight to the camera when TCP 9000 answers over WireGuard ("direct"), else through Reolink's
  P2P relay by UID ("cloud", ~0.3–0.5 Mbps: the 1536×432 H.264 sub stream only). `"via": "cloud"` in kits.json forces cloud.
- UID: `kits.json` `{"cam4": {"uid": "..."}}`, else read from the camera's `GetP2p` once and cached in
  `/var/lib/replay-kitpreview/uids.json`. A kit that has never been on our network needs its UID typed into kits.json.
- neolink runs from the Docker image `quantumentangledandy/neolink:latest` (bundles GStreamer) as uid 65534 on
  RTSP 127.0.0.1:186NN; ffmpeg copies the sub stream to HLS in `/run/replay-kitpreview/<cam>/hls`.
- Stops 60 s after the last request, at 30 min, or when the stream drops. Log: `/var/log/replay-kitpreview.log`.
- Measured on cam1: direct ready in ~30 s; cloud ready in 33 s, 72 s of video per 60 s watched, 0.28 Mbps.

## Connecting a new camera from the app (2026-11-18)

Owners and managers: Console → Cameras → Add camera. They first set the camera up in the Reolink app
(password, WiFi), then type a name, the camera's Reolink ID (UID) and its password. The app gives it the next
free `cameraN` (10 and up; 1–9 stay Replay's own) and calls vps1 `POST /kit/cameraN/register`, which writes
`kits.json` `{uid, user, via: "cloud", passFile}` and the password to `/etc/replay/kitpass/camN.json` (0600). The
password is never stored in the app's database. The dialog then opens the live preview as the check; "ID & password"
on the camera card re-registers. Replay's own cameras (cam1–cam3) can't be registered over. A refused password stops
the preview at once (Reolink locks logins after repeated failures). Cloud-only cameras have no snapshot, WiFi change
or SD pull: status reports `reason: "cloud"`.

## Full quality for connected cameras: router or FTP (2026-11-18)

On each connected camera's card (camera10+), owners and managers get **Full quality → Set up**:

- **Connect a router** (`kitnet.py`, `POST|DELETE /kit/camN/router`): a WireGuard peer per kit. Kit n gets tunnel
  10.99.0.(128+n) and LAN 10.199.n.0/24; the user uploads the one-time .conf in their GL.iNet router, turns on
  "Allow remote access to LAN" and sets the router's LAN address to 10.199.n.1. `replay-kitnet.timer` (2 min) re-adds
  peers after a wg0 restart, finds the camera behind the router (UID over HTTP, else the only host on TCP 9000), adds
  the reolink-cli alias `camN` and sets kits.json `pull: "cli"`: bookings then pull the card like cam1.
  Security: private key never stored on vps1; client routes only 10.99.0.1; chain REPLAY-KITNET (top of INPUT) lets a
  kit only answer connections vps1 opened; REPLAY-KITNET-FWD keeps kits off each other and Jordan Galaxy. Peers live in
  /etc/replay/kitnet/, never wg0.conf.
- **Send clips by FTP** (`kitftp.py`, `POST|DELETE /kit/camN/ftp`): user `reoftp_camN`, 24-char password shown once,
  `/etc/vsftpd_user_conf/reoftp_camN` forces TLS for logins and data, live-hold marker keeps clips out of the public
  hourly archive. Bookings (`pull: "ftp"`) run `ftp_window_job.py`, which reserves the window's clips, hard-links them and
  hands over to `sdpull_cli_job.py` with `SDPULL_FILES` (files mode skips the camera search; trim/assemble/8K/upload
  unchanged). Storage cap per camera: 8 GB / 24 h (`KITFTP_MAX_GB`, `KITFTP_MAX_HOURS`); under 12 GB free disk the
  oldest unreserved kit clips go first.
- Install: `install_fullquality.sh` (checks control.py / sdpull_cli_job.py are the expected versions first; vsftpd
  config rolls back by itself if vsftpd won't start). `control.py.vps1` / `sdpull_cli_job.py.vps1` are the edited copies.
- `GET /kit/camN/link`: what the app shows (router connected / camera found / last FTP clip).
