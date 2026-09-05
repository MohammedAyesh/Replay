# Replay — Standard Operating Procedures

Written 2026-09-04. Every SOP here is meant to be executable by someone who has
not seen this system before: exact commands, the output you should get back,
what failure looks like, and what to do about it.

## The documents

| | | |
|---|---|---|
| **B1** | [Field deployment](B1-field-deployment.md) | Router build, camera commissioning, recording-schedule verification, the 8K trap, the go-live checklist |
| **B2** | [Camera operations](B2-camera-operations.md) | SD pull via `reolink-cli`, session pool, the in-progress file, the 4989 encrypted API, cam1 WiFi diagnosis |
| **B3** | [VPS operations](B3-vps-operations.md) | Service map, archive pipeline, disk deadlock, the FFmpeg version split, the three-clock problem, dead units |
| **B4** | [Bunny operations](B4-bunny-operations.md) | Configuration reference, cost model, status codes, retention, the Storage escape hatch |
| **B5** | [Web app operations](B5-web-app-operations.md) | Working model, prompt conventions, verification discipline, codegen, database, the clip model |
| **B6** | [GPU workstation](B6-gpu-workstation.md) | The job agent, sleep suppression, the workstation/VPS division of labour |
| **B7** | [Incident runbooks](B7-incident-runbooks.md) | Seven one-page runbooks: symptom → first diagnostic → resolution → prevention |
| **B8** | [Analysis queue](B8-analysis-queue.md) | The button-to-claimable path: queueing a match, the workstation worker, job states, failure modes, the API |
| **B9** | [Branding and settings](B9-branding-and-settings.md) | Where to set what: the three settings layers, the overlay and end card, the resolution order, and which toggles still do nothing |

Supporting documents produced alongside these:

| | |
|---|---|
| [A0 — Infrastructure inventory](A0-inventory-2026-09-04.md) | What is actually running, measured. **Read this before trusting the project description.** |
| [A2 — Encoding ladder decision](A2-ladder-decision.md) | The three options for the Bunny ladder, with measured bitrates and costs |
| [A4/A6 — Queue and share cards](A4-A6-queue-and-share-cards.md) | The render queue, the rolling download allowance, poster frames and the share card — with the two measurements that changed the code |
| [A10 — Settings engine](A10-settings-engine.md) | Per-field / per-user / per-academy / per-time configuration, the precedence choice and what it costs |
| [A9 — Payments in Jordan](A9-payments-jordan.md) | Apple Pay / IAP / gateway comparison for Replay Pro |
| [Incident 2026-09-04](INCIDENT-2026-09-04-cam1-8k-reaper.md) | cam1 in 8K, footage reaped behind the geometry guard — found by the new alerting on its first run |
| [`replay-alert.sh`](replay-alert.sh) | The alerting. Installed on vps1, cron `*/10` |

## Read this first

**The project description is stale in several important places.** The A0
inventory records what is actually true as of 2026-09-04, verified against the
live system rather than the notes. The four that will bite you soonest:

1. **The live path is up, not down.** `replay-ftplive-copy@cam1`,
   `replay-ftplive-copy@cam2` and `replay-livehttp` are all running, and a
   dedicated Bunny pull zone `livejordangalaxy` fronts `169.58.73.17:8088`.
2. **The Bunny encoding ladder is `1080p,2160p`, not `480p,2160p`** — and on
   videos encoded since 2026-08-22 only the `1080p` rung is produced, at
   3840×1080. There is no 480p rung at all.
3. **`PENDING_MAX_AGE` already exists** in `process.sh` (6 h default). The
   remaining gap is orphaned objects on Bunny's side, not the local timeout.
4. **Camera addresses are `192.168.66.x`**, not the `192.168.18.x` in the
   project description. That subnet is dead.

## Conventions used throughout

- Commands are shown with the machine they run on named above them. Getting this
  wrong is the single most common way to waste an hour here.
- `$` prompts are omitted so blocks can be pasted directly.
- Expected output is shown after each command that has a meaningful result. If
  what you see differs, stop and read the failure section rather than pressing on.
- **Three clocks are live at once**: cameras on Amman (UTC+3), vps1 on
  Europe/Berlin (CEST, +2), Bunny state buckets on UTC. Every SOP that touches a
  timestamp says which one it means. Always call `date -u` explicitly.

## Rules that apply to everything

These are not style preferences. Each one is here because it broke something.

1. **Never `sed`-patch a multi-line script on the VPS.** Edit locally, `scp` the
   whole known-good file.
2. **Never edit a running bash script in place, and `mv` is not enough** — a
   running bash process holds the inode. Kill and relaunch. (2026-08-02: a
   watcher was retargeted twice and still fired the original window.)
3. **Filenames contain spaces.** Always `while IFS= read -r`, never
   `for f in $(ls …)`. cam1's clips are named `Jordan Galaxy 1_00_<ts>.mp4`.
4. **`ssh` inside a `bash -s` heredoc needs `-n`**, or it eats the rest of the
   script. Same for any command inside a `while read` loop.
5. **`ffmpeg` reads stdin** — always `-nostdin` in scripts. But `-nostdin` is
   **not** an ffprobe option and ffprobe errors out on it.
6. **Never `--data-binary "@file"` to Bunny** — it buffers the whole file in RAM
   and OOMs on multi-GB hours. Use streamed `curl -T`.
7. **`setsid`, not `nohup … &`**, for anything backgrounded over SSH — dropbear
   kills backgrounded jobs on session close.
8. **Verify, don't report.** A claim of completion needs raw terminal output, a
   real diff, or a probe result behind it. This project has been burned
   repeatedly by summaries that turned out not to match the machine.

## The gap that was standing until today

**For most of this system's life there was no alerting of any kind.** Five
separate multi-day outages were discovered by a human happening to look:

- 2026-08-03 → 08-05, cam2 apparently offline two days (it had moved IP)
- 2026-08-08 → 08-10, disk deadlock, two days of archiving stopped
- 2026-08-10 → 08-16, archive published nothing for a week
- 2026-08-18, cameras moved to the venue router, third silent multi-day outage
- 2026-08-24 → 08-26, all three cameras silent

A missed match hour cannot be re-recorded.

**As of 2026-09-04 this gap is closed.** `replay-alert.sh` is installed on vps1
and runs every 10 minutes; it alerts on state change, repeats every 6 hours while
a problem is open, and sends a daily heartbeat so that a dead alerter is itself
visible. **On its first run it found a live outage that had been going for four
days** — see the incident record above.

Configure the delivery channel in `/etc/replay/alert.env`.
