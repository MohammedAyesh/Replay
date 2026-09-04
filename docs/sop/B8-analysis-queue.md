# B8 — The analysis queue, end to end

Written 2026-09-04. This is the path from "a match was recorded" to "a player
can claim themselves in it", with a button at one end instead of a person.

**Read [B6 — GPU workstation](B6-gpu-workstation.md) first.** Everything about
the machine that does the work — the 6 GPU-hours per football hour, the sleep
suppression, the PowerShell traps — lives there and is not repeated here.

---

## 1. What this replaces

Until now, analysing a match meant a person doing all of this by hand:

```
ssh vps1 → find the Bunny title of the hour
powershell analyze.ps1 -Title cam1_2026-09-01_20:00     # ~6 hours
scp the zip off the PC
admin console → Recordings → upload the bundle → type videoStartSeconds
```

Nothing about that sequence was visible to anyone who was not the person doing
it, and nothing about it survived that person being asleep. There was no record
that a match was queued, no way to tell a running job from a forgotten one, and
a bundle uploaded with the wrong `videoStartSeconds` looked exactly like broken
tracking.

The queue keeps every one of those steps — including `analyze.ps1` itself,
unchanged — and puts a row in the database in front of them.

---

## 2. The shape, and why it is inverted

The app server cannot reach the workstation. It is a desktop behind a home
connection with no inbound route, and adding one is a bad trade for something
this occasional. So the relationship runs the other way:

```
admin console          app server (Replit)            workstation (ayeshpc)
     │                        │                              │
     │  queue a job ─────────▶│                              │
     │                        │◀──── "anything for me?" ─────│  every 60 s
     │                        │───── job #12 ───────────────▶│
     │                        │◀──── stage, progress ────────│  every 30 s
     │                        │◀──── bundle (multipart) ─────│
     │                        │◀──── complete ───────────────│
     │◀── queue + progress ───│                              │
```

Consequences worth knowing:

- **The workstation authenticates with a shared key, not a session.** There is
  no browser and no human at that end. The key is `ANALYSIS_WORKER_KEY`.
- **A queued job with the PC switched off is normal.** The console says so in
  words. It is not a stuck queue.
- **Killing the worker window loses nothing.** The heartbeat stops, the server
  returns the job to the queue after 15 minutes, and the next run resumes inside
  `.\match` if it is the same recording.

---

## 3. Setup, once

### 3.1 On the app (Replit)

Two things, both one-off.

```bash
# Shell tab. Creates analysis_jobs and analysis_workers.
pnpm --filter @workspace/db run push
```

Then add the secret. Generate it anywhere:

```bash
openssl rand -hex 32
```

Add it as `ANALYSIS_WORKER_KEY` in Replit's Secrets, in **both** the workspace
and the published deployment. Without it every worker call answers `503` with
`This deployment has no ANALYSIS_WORKER_KEY set` — deliberately distinguished
from a wrong key, because a worker retrying a `401` forever is harder to
diagnose than one being told the server has no key.

**Verify before going further.** From anywhere:

```bash
curl -s -X POST https://<the app>/api/worker/analysis/ping \
  -H "x-worker-key: $ANALYSIS_WORKER_KEY" \
  -H "content-type: application/json" \
  -d '{"workerId":"preflight"}'
```

Expected: `{"ok":true,"queued":0}`. A `401` means the key does not match; a
`503` means it is not set on the instance you hit — check the deployment, not
just the workspace.

### 3.2 On the workstation

`analysis-worker.ps1` lives in `C:\Users\Public\replay-ops` beside `agent4.ps1`.
It is a **separate** process from the job agent and does not use `inbox\`.

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\Public\replay-ops\analysis-worker.ps1 `
  -ApiBase https://<the app> -WorkerKey <ANALYSIS_WORKER_KEY>
```

Leave the window open. It suppresses sleep the same way `agent4.ps1` does, and
that suppression lasts only while the window is open.

It refuses to start if `curl.exe`, `analyze.ps1`, `chunk.ps1` or
`make_hourbundle.py` is missing, rather than discovering it six hours in. That
is the agent3 lesson applied: a startup check that would have caught the fault
in ten seconds instead of five hours.

Expected first lines:

```
[20:15:02] sleep suppressed while this window is open
[20:15:02] worker 'AYESHPC' -> https://<the app>
[20:15:02] stop with Ctrl+C, or drop a file called worker-stop.flag in C:\Users\Public\replay-ops
```

Within a minute the console's Analysis tab should show the workstation as
**online**, with `last seen` counting in seconds.

### 3.3 Running both agents at once is fine

`agent4.ps1` and `analysis-worker.ps1` are independent and can share the
machine, but **they will both want the GPU**. If a long `analyze.ps1` is
running under the worker, do not queue GPU work into `inbox\` as well — B6's
"never run two agents" rule is about one GPU, and it applies across the two
runners just as much as within one.

---

## 4. The A–Z, as an operator does it

**Admin console → Analysis.**

1. **Pick the recordings, in playing order.** One for an ordinary hour; several
   when the match was recorded as separate hours. The order matters and is kept
   exactly as chosen — the list shows it numbered, with ↑/↓ to reorder.
   The **first** recording is where the bundle attaches and is labelled so.
2. **Type when the match starts**, as `m:ss`, `h:mm:ss`, or a plain number of
   seconds. This is the offset into the *first* recording, and it is the number
   that becomes `videoStartSeconds` on the bundle. Getting it wrong does not
   fail loudly: it draws every tracking box against footage from another part of
   the match, and looks like the tracking is broken rather than the number.
   Recordings after the first start at 0 — play is already underway.
3. **Queue analysis.** The reply says whether the workstation is listening.
4. Watch the row. Positions, stage and progress update every 15 seconds; a
   six-hour job means the tab can be closed and reopened freely.
5. When it reaches **succeeded**, the recording has a bundle with real segments
   behind it and the claim entry point appears for players.

Nothing else is needed. No ssh, no scp, no manual upload, no typing
`videoStartSeconds` a second time.

### How long it takes

**About six GPU-hours per football hour** (B6 §6: 56 minutes of GPU per ten
minutes of football, six chunks run sequentially). A two-hour match selected as
two recordings is therefore roughly **twelve hours**, plus the fetch. Queue it
overnight.

---

## 5. What each state means

| state | what is true | what to do |
|---|---|---|
| **queued** | The row exists. Position is shown. | Nothing, if the workstation is online. If it is offline, switch the PC on and start the worker. |
| **claimed** | A worker has taken it, `analyze.ps1` is starting. | Nothing. |
| **running** | Progress and stage are live, heartbeat within 30 s. | Nothing. Stage names the recording and the pipeline step. |
| **succeeded** | At least one bundle landed and its segments are stored. | Nothing — the match is claimable. |
| **failed** | The worker reported an error, or went silent past the attempt limit. | Read the error on the row. **Queue again** re-runs it. |
| **cancelled** | An operator stopped it. | The worker is told to stop at its next heartbeat, within 30 s. |

Two behaviours that look like bugs and are not:

- **A failure does not fail the job the first time.** Under three attempts it
  goes back to the queue with the error text kept on the row, so a dropped
  download or a busy GPU is retried without anyone noticing. The row shows the
  message in amber while queued, red once it has genuinely failed.
- **A job cannot be completed with no bundle.** The API refuses it. Success with
  nothing to claim is the exact failure this queue exists to make visible: six
  GPU-hours, a green tick, and nothing for anyone to claim.

---

## 6. When it goes wrong

### The workstation shows offline and jobs sit queued

Normal if the PC is off. If it is on:

1. Is the worker window open? It is a separate process from `agent4.ps1` —
   `agent4` running does not mean the analysis worker is.
2. Restart it. It is stateless; a job it was holding comes back to it.
3. Check it can reach the app at all:
   ```powershell
   curl.exe -sS -X POST -H "x-worker-key: <key>" -H "content-type: application/json" `
     -d '{\"workerId\":\"probe\"}' https://<the app>/api/worker/analysis/ping
   ```

### A job goes back to the queue with "the workstation stopped reporting"

The PC slept, rebooted, or the window was closed. This is the designed
behaviour, not a fault — see B6 §2 on sleep suppression, which is the usual
cause. Work already done inside `.\match` is not lost: the next run resumes
from the last completed stage.

After three of these the job fails rather than looping forever, because a job
that kills the worker on load — a corrupt source, an out-of-memory model —
would otherwise be handed back to the machine every time it came up.

### "analyze.ps1 exited N"

The error text on the row carries the last 20 lines of its stderr. The usual
causes, in order of likelihood:

- `fetch_hour.sh` could not find the title on Bunny. Check the recording's title
  matches a Bunny Stream video: the worker builds it as
  `<court>_<date>_<timeSlot>`, e.g. `cam1_2026-09-01_20:00`, which is exactly
  what the recordings importer parsed the row out of. A recording created by
  hand may not have one.
- Disk. Each hour is ~4.5 GB down plus chunks.
- The GPU is busy with something queued into `agent4`'s `inbox\`.

### "the server refused the bundle"

The bundle failed validation. The message is the validator's own — most often
crossings referencing track ids that no longer exist, which is what happens when
anything keyed by track id is not regenerated after a relink (see
`pipeline-map-raw-video-to-bundle-2026-08-29.md`).

### The work directory holds the wrong hour

`analyze.ps1`, `chunk.ps1` and `make_hourbundle.py` all work inside `.\match`
and every stage skips when its output already exists. Within one recording that
is the resume behaviour that makes a reboot survivable; across two it would
silently reuse the previous hour's chunks. The worker writes
`.\match\_current.txt` with the slug it is working on and wipes the directory
when it changes. If you ever run `analyze.ps1` by hand between worker jobs,
delete that marker, or the worker will think its own last job is still there.

---

## 7. Known limits

**Identity does not carry across an hour boundary.** A match selected as two
recordings is analysed as two runs and comes back as two bundles, each claimed
separately. `make_hourbundle.py` already namespaces ids per chunk and treats
each boundary as an honest "the tracking ended here, pick yourself again"
moment; the hour boundary is the same kind of boundary, one level up. Making a
person survive it is the relink problem, and the queue is where that would be
added — the job already holds the whole ordered list, which is the part that was
missing.

**One active job per target recording.** A second is refused with a 409 naming
the first. Two runs writing bundles to the same recording race, and the loser's
six hours are thrown away silently.

**The pipeline expects hour-shaped input.** `make_hourbundle.py` hardcodes six
ten-minute chunks. A 30-minute recording will not produce a full bundle.

---

## 8. API reference

Admin routes take the normal Clerk admin session. Worker routes take
`x-worker-key` and a `workerId`.

| method | path | notes |
|---|---|---|
| `POST` | `/api/admin/analysis-jobs` | `{recordingId, sourceRecordingIds[], matchStartSeconds, params}`. 409 if one is already active for that recording. |
| `GET` | `/api/admin/analysis-jobs` | Jobs, queue positions, worker health. Sweeps stale claims first. |
| `GET` | `/api/admin/analysis-jobs/recordings` | What can be analysed. |
| `POST` | `/api/admin/analysis-jobs/:id/cancel` | Worker stops at its next heartbeat. |
| `POST` | `/api/admin/analysis-jobs/:id/retry` | Back to queued, attempts reset. |
| `POST` | `/api/worker/analysis/ping` | `{workerId, version}` → `{ok, queued}`. |
| `POST` | `/api/worker/analysis/claim` | One statement, `FOR UPDATE SKIP LOCKED`. `{job}` or `{job:null}`. |
| `POST` | `/api/worker/analysis/:id/heartbeat` | `{stage, progress}` → `{stop, reason}`. **`stop:true` means put your tools down** — cancelled, finished, or reclaimed by another machine. |
| `PUT` | `/api/worker/analysis/:id/bundle` | multipart: `bundle` (zip), `recordingId`, `videoStartSeconds`, `workerId`. Goes through the same `storeUploadBundle` as the manual admin upload. |
| `POST` | `/api/worker/analysis/:id/complete` | Refused if no bundle landed. |
| `POST` | `/api/worker/analysis/:id/fail` | `{error}`. Requeues under the attempt limit. |

Timings: heartbeat every 30 s, stale after **15 minutes**, **3 attempts**, worker
called offline after **3 minutes** without a ping. Fifteen minutes is not a guess
about network jitter — the pipeline spends nearly an hour inside a single chunk,
so a job reclaimed from a worker that is still grinding away would be run twice.

---

## 9. Where the code is

| | |
|---|---|
| `lib/db/src/schema/analysisJobs.ts` | The two tables |
| `artifacts/api-server/src/lib/analysisJobs.ts` | The rules with no database in them: transitions, reclaim, source ordering, key comparison |
| `artifacts/api-server/src/routes/analysisJobs.ts` | Admin and worker routes |
| `artifacts/soccerwatch/src/components/admin/AnalysisTab.tsx` | The tab |
| `artifacts/soccerwatch/src/lib/analysisStart.ts` | The kick-off parser |
| `ops/analysis-worker/analysis-worker.ps1` | The workstation half |
