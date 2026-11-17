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
