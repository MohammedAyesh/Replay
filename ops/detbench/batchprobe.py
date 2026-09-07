#!/usr/bin/env python3
"""
batchprobe.py - settle "is batching worth it here" in ten minutes.

THE QUESTION

If inference is ~90 ms of a 2,000 ms/frame budget, batching amortises per-call
overhead and saves maybe 45 ms -- 2 %, not worth a day's work. If instead most
of that 2,000 ms IS per-call overhead (ultralytics result construction, mask
decoding, the .cpu() move -- none of it cheap, all of it once per call), then
batching is the whole game.

Both stories predict the same 2,000 ms. This tells them apart by timing the
identical work two ways on the same tiles.

RUN

    python3 batchprobe.py --weights yolo11s-seg.pt --video chunk.mp4 \
        --frames 60 --tile-w 1536 --stride 1280 --imgsz 1280 --conf 0.25

Add --fake to check the harness itself with no GPU and no model.

WHAT IT DOES NOT DO

It does not check correctness -- that is `detbench.py exact`. It measures time
only, on a sample, so it tells you whether to bother, not whether to ship.
"""
import argparse
import statistics
import sys
import time

import numpy as np


def tile_offsets(width, tile_w, stride):
    if tile_w >= width:
        return [0]
    offs = list(range(0, width - tile_w + 1, stride))
    if offs[-1] != width - tile_w:
        offs.append(width - tile_w)
    return offs


def grab_frames(video, n, width, height, ffmpeg="ffmpeg"):
    import subprocess
    fb = width * height * 3
    p = subprocess.Popen(
        [ffmpeg, "-v", "error", "-i", video, "-frames:v", str(n),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE, bufsize=fb * 2)
    out = []
    while len(out) < n:
        buf = p.stdout.read(fb)
        if len(buf) < fb:
            break
        out.append(np.frombuffer(buf, np.uint8).reshape(height, width, 3))
    p.stdout.close(); p.wait()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="yolo11s-seg.pt")
    ap.add_argument("--video")
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--width", type=int, default=3840)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--tile-w", type=int, default=1536)
    ap.add_argument("--stride", type=int, default=1280)
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--batches", default="1,2,4,8,16,24")
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--allow-cpu", action="store_true",
                    help="run even without CUDA (timings will not transfer)")
    ap.add_argument("--fake", action="store_true",
                    help="no model; verifies the harness only")
    a = ap.parse_args()

    offs = tile_offsets(a.width, a.tile_w, a.stride)
    tiles_per_frame = len(offs)
    print(f"{tiles_per_frame} tiles/frame at offsets {offs}")

    if a.fake:
        PER_TILE, PER_CALL = 0.004, 0.020   # the "overhead dominates" story
        def predict(batch):
            time.sleep(PER_CALL + PER_TILE * len(batch))
            return [None] * len(batch)
        frames = [np.zeros((a.height, a.width, 3), np.uint8) for _ in range(a.frames)]
        print(f"FAKE model: {PER_CALL*1000:.0f} ms/call + {PER_TILE*1000:.0f} ms/tile")
    else:
        # A CPU-only torch makes every number below meaningless, and it is an
        # easy mistake on Windows: `py` picks the system interpreter, not the
        # venv the detector actually runs in. Say so loudly rather than let a
        # wrong conclusion get written down.
        try:
            import torch
            cuda = torch.cuda.is_available()
            dev = torch.cuda.get_device_name(0) if cuda else "CPU"
            print(f"torch {torch.__version__}  cuda={cuda}  device={dev}")
            if not cuda:
                print("\n  !! torch cannot see a GPU. Batching behaviour on CPU is")
                print("     nothing like on CUDA, so these timings would not")
                print("     transfer. Run this with the SAME interpreter/venv the")
                print("     detector uses. Pass --allow-cpu to override.\n")
                if not a.allow_cpu:
                    sys.exit(2)
        except ImportError:
            print("torch not importable — wrong interpreter or venv?")
            if not a.allow_cpu:
                sys.exit(2)

        from ultralytics import YOLO
        model = YOLO(a.weights)
        def predict(batch):
            return model(batch, imgsz=a.imgsz, conf=a.conf, verbose=False)
        if not a.video:
            sys.exit("--video is required unless --fake")
        frames = grab_frames(a.video, a.frames, a.width, a.height)
        print(f"{len(frames)} frames from {a.video}")

    if not frames:
        sys.exit("no frames decoded — check --width/--height match the video")

    # Cut every tile once, up front. Tiling cost is identical either way, and
    # including it would dilute exactly the difference being measured.
    tiles = [f[:, x:x + a.tile_w] for f in frames for x in offs]
    print(f"{len(tiles)} tiles total\n")

    for _ in range(a.warmup):
        predict(tiles[:1])

    results = []
    for bs in [int(x) for x in a.batches.split(",")]:
        per_call = []
        t0 = time.perf_counter()
        for i in range(0, len(tiles), bs):
            c0 = time.perf_counter()
            predict(tiles[i:i + bs])
            per_call.append(time.perf_counter() - c0)
        total = time.perf_counter() - t0
        ms_frame = 1000 * total / len(frames)
        results.append((bs, total, ms_frame, len(per_call),
                        1000 * statistics.median(per_call)))

    base = results[0][1]
    print(f"{'batch':>6}{'total s':>10}{'ms/frame':>11}{'calls':>8}"
          f"{'ms/call':>10}{'speedup':>10}")
    print("-" * 55)
    for bs, total, ms_frame, calls, ms_call in results:
        print(f"{bs:>6}{total:>10.2f}{ms_frame:>11.1f}{calls:>8}"
              f"{ms_call:>10.1f}{base/total:>9.2f}x")

    best = min(results, key=lambda r: r[1])
    gain = base / best[1]
    print(f"\nbest batch size: {best[0]}  ({gain:.2f}x over one-at-a-time)")

    # The decision, stated so it does not have to be re-derived later.
    print("\nVERDICT")
    if gain < 1.15:
        print("  Batching is NOT the win here. Per-call overhead is small, so the")
        print("  2 s/frame is elsewhere — mask post-processing, decode, or writing.")
        print("  Run stagetimer.py / py-spy and go after whatever dominates.")
    elif gain < 1.6:
        print(f"  Batching is worth ~{100*(1-1/gain):.0f}% of INFERENCE time, which is")
        print("  only worth having once inference is a large share of the budget.")
        print("  Check stagetimer first: if infer < 20% of the frame, this is < 10%.")
    else:
        print(f"  Batching is a real win: {gain:.2f}x on inference. Per-call overhead")
        print("  dominates, which is exactly what fastdet.py restructures.")
        print(f"  Wire it in at batch_size={best[0]} and gate with `detbench.py exact`.")
    print("\nEither way this measured TIME only. Prove equivalence with")
    print("  python3 detbench.py exact --ref <before>.json --var <after>.json")


if __name__ == "__main__":
    main()
