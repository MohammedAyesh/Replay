# detbench — detector speed harness

Tools for making the analysis pipeline faster **without** quietly changing what
it detects. Live here so every machine can `git pull` them; they are not part of
the app build.

Run them on the **GPU workstation**, with the detector's own interpreter:

    C:\Users\Public\replay-ops\venv\Scripts\python.exe <tool>.py

Not `py`, and not bare `python` — those are the system 3.11 with no torch, and
`batchprobe.py` will exit 2 rather than print numbers that mean nothing.

## The tools

| file | what it is |
|---|---|
| `batchprobe.py` | Ten-minute go/no-go: is inference per-call-overhead-bound (batching is the whole game) or compute-bound (batching buys nothing)? |
| `fastdet.py` | The restructuring itself: batched tiling across frames + background decode. Same pixels, same tile geometry, same post-processing. |
| `detbench.py` | Times a variant AND proves it did not move the detections. `selftest` / `exact` / `compare` / `run --config`. |
| `stagetimer.py` | Nesting-correct stage/frame timers for finding where the 2 s/frame actually goes. |
| `test_fastdet.py`, `test_decode.py` | Self-contained; generate their own fixtures. No GPU needed. |

## Order

1. `python detbench.py selftest` — proves the comparison reports what was injected. If this does not print `ALL PASS`, nothing below means anything.
2. `python test_fastdet.py` and `python test_decode.py` — no GPU needed. `test_decode.py` needs `ffmpeg` on PATH.
3. `python batchprobe.py --weights <seg weights> --video <chunk>.mp4 --frames 60 --tile-w 1536 --stride 1280 --imgsz 1280` — the decision. `--fake` runs the harness with no model or GPU.
4. Freeze the current detector's output as a reference, run the variant, then `detbench.py exact` (batching) or `compare` (FP16/TRT).

## Reading the result

- **`cross` is the gate, not `boxes Δ%`.** The selftest shifts every box 500 px — a completely different detection set — and `box_delta_pct` still comes back `0.00`, because misses and extras cancel. Threshold crossings at conf 0.25 / 0.1 are the real failure mode: this pipeline's behaviour lives at thresholds.
- **`CLEAN` is not "shippable".** It means the detection set is intact. Run relink4 on each CLEAN variant and grade with `merge_audit.py` — `score2.py` cannot tell two veto-on configs apart.
- **A variant that changes detection fps prints `NOT COMPARABLE`, deliberately.** Every tracker gate is frame-derived, so the tuning does not carry.

## Known before you start

Decode overlap has a ceiling of roughly **2%** on this workload: B6 records decode at 1.1 min against 56 GPU-min per 10 minutes of football. The batching half of `fastdet.py` is the part worth chasing.
