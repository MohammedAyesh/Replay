# B10 — Live and VAR

Written 2026-09-05. The whole path from a camera's FTP push to a scrubbable
review window, and the two places it silently looks fine when it is not.

---

## 1. The path

```
camera ──FTP──▶ vps1 /opt/reocam/incoming/<cam>/upload/
                     │
                     ├─▶ ftp_live.py <cam>       ──▶ /opt/replay/ftplive/<cam>/hls/   H.264 transcode
                     └─▶ ftp_live_copy.py <cam>  ──▶ /opt/replay/ftplive/<cam>/hevc/  stream copy, ~1/40 the CPU
                                                       │
                        livehttp.py  :8088 ◀───────────┘   CORS *, max-age=1 playlists, immutable segments
                                     │
                  Bunny pull zone livejordangalaxy.b-cdn.net
                                     │
                          the viewer's browser, directly
```

**The app is not in the byte path.** It hands out a CDN URL and gets out of the
way. Verified against the running system on 2026-09-05: the edge returns the
origin's `access-control-allow-origin: *` on the playlist, on an `OPTIONS`
preflight, and on a segment, with `cdn-cache: REVALIDATED`.

Services, all on vps1, all `Restart=always`:

| unit | what it is |
|---|---|
| `replay-ftplive-copy@cam1` / `@cam2` | the stream-copy rendition, `FTPLIVE_WINDOW=900` |
| `replay-livehttp` | static server on :8088 |
| `vsftpd` | receives the camera pushes |

`ftp_live.py` (the transcode) is not a systemd unit — check how it is started
before assuming it restarts on its own.

---

## 2. Configuration

| variable | default | what it does |
|---|---|---|
| `LIVE_CDN_BASE` | `https://livejordangalaxy.b-cdn.net` | where viewers fetch |
| `LIVE_ORIGIN_BASE` | `http://169.58.73.17:8088` | freshness reads only |
| `LIVE_CAMERAS` | `camera1:cam1,camera2:cam2` | API name → directory |

The defaults are the live values, so **nothing needs setting to ship this**.

Freshness is read from the origin, never the edge: a `max-age=1` playlist read
through a CDN can be a second stale, which is irrelevant for playback and
misleading in a health check.

---

## 3. A 200 is not evidence of a live stream

**This is the failure mode to know.** When no camera is pushing, the origin
keeps serving the last playlist it wrote. The fetch succeeds. The player
attaches. The viewer watches a spinner over a frame that is days old.

cam1's playlist was frozen at `2026-09-01 11:11` and served 200s for four days.
Nothing in the app said so.

`GET /api/live/:camera/source` now answers both halves:

```json
{
  "url": "https://livejordangalaxy.b-cdn.net/cam1/hls/live.m3u8",
  "proxyUrl": "/api/live/camera1/index.m3u8?variant=hls",
  "status": { "live": false, "reason": "stale", "behindSeconds": 371520,
              "dvrSeconds": 1800, "segmentCount": 450 },
  "message": "No live feed — the last frame arrived 4 d ago."
}
```

| `reason` | means |
|---|---|
| `live` | frames arriving within three target durations |
| `stale` | the playlist is real but old — no camera is pushing |
| `empty` | the playlist has no segments yet |
| `ended` | `#EXT-X-ENDLIST`; the stream finished |
| `no-timestamps` | no `PROGRAM-DATE-TIME`; **treated as live**, because refusing to play a stream that is fine is the worse error |
| `unreachable` | the origin did not answer. **Not the same as "not live"** — the CDN may still be serving cached segments |

The URL is returned even when the stream is stale, so a feed that recovers is
picked up by the next poll rather than needing a reload. Polling is 60 s when
live, 15 s when not: somebody is standing at a pitch waiting for it to come
back.

> **The live edge is the LAST program-date-time plus what follows it**, not the
> first plus everything. These playlists re-stamp every few segments precisely
> to correct the drift the first one accumulates, and anchoring on the first
> reintroduces it.

---

## 4. VAR

Admin → **VAR**. Reviews the rolling DVR window the VPS keeps.

- **Scrub bar** across the whole window, seeking as it drags — finding a moment
  is a visual search, and a handle moving over a frozen frame is not one.
- ±30 s, ±10 s, frame step (1/20 s — the cameras run 20 fps), speed 0.25/0.5/1×.
- Keyboard: `J`/`L` ±10 s, `←`/`→` frame, `Space` play-pause.
- Wall-clock position from `PROGRAM-DATE-TIME`, and how far behind live.
- **Go live** returns to the edge.

**The window is whatever the VPS is keeping**, reported by the server — not the
300 s that used to be hardcoded here while the origin held 900 for the stream
copy and about 1800 for the transcode. Two thirds of the reviewable footage was
unreachable.

### Renditions

Both cameras carry two:

| variant | what | when |
|---|---|---|
| `hls` | H.264 transcode | the default; plays everywhere |
| `hevc` | stream copy, ~1/40 the CPU | comparison on a running match |

Add `?variant=hevc` to `/source`. The `hevc` rendition is fragmented MP4, so the
proxy's manifest rewriter has to accept `.m4s` and `.mp4`, not only `.ts` —
before it did, every hevc segment stayed a bare relative name and 404'd against
the app's own origin.

---

## 5. When there is no picture

Work down this list; each step rules out the one above.

1. **Is a camera pushing?**
   ```bash
   ls /opt/reocam/incoming/cam1/upload/ | wc -l
   ```
   Zero and no recent playlist writes means the camera is not sending. That is a
   field problem — see B1 — not a live-path problem.

2. **Is the origin writing?**
   ```bash
   ls -la /opt/replay/ftplive/cam1/hls/live.m3u8
   systemctl is-active replay-ftplive-copy@cam1 replay-livehttp
   ```

3. **Does the origin answer?**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8088/cam1/hls/live.m3u8
   ```

4. **Does the edge answer, with CORS?**
   ```bash
   curl -s -D- -o /dev/null -H "Origin: https://replayjo.com" \
     https://livejordangalaxy.b-cdn.net/cam1/hls/live.m3u8 |
     grep -iE '^HTTP/|access-control|cdn-cache'
   ```
   Expect `200`, `access-control-allow-origin: *`, and a `cdn-cache` line. **If
   the CORS header is missing here but present at the origin, the pull zone is
   stripping it** and the browser will fail with an opaque network error while
   curl looks perfect.

5. **What does the app think?**
   ```bash
   curl -s https://replayjo.com/api/live/camera1/status | jq
   ```

If 1–4 pass and 5 says `stale`, the clocks disagree — the playlist is stamped
UTC and the check compares against the server's now.

---

## 6. What is not built

- **No clipping from VAR.** Marking a moment and sending it to the render queue
  is the obvious next step and is not there.
- **No multi-camera sync.** Cameras are reviewed one at a time; there is no
  "same timestamp on cam2".
- **`ftp_live.py` is not a systemd unit.** The stream-copy path restarts itself;
  the transcode path's supervision was not established.
- **Live has never been watched end to end through the CDN by a browser.** Every
  layer is verified with curl and the app is tested against a stand-in origin,
  but no camera has pushed since 2026-09-01, so the last mile is unproven.
