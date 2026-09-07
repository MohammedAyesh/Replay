#!/usr/bin/env python3
"""
fastdet.py - overlapped decode + batched tiling. The two class-1 wins.

WHAT IT CHANGES AND WHAT IT DOES NOT

Changes: how frames get decoded, and how tiles get handed to the model.
  - decode runs in a background thread on a bounded queue, so ffmpeg and the
    GPU work at the same time instead of taking turns
  - tiles are batched ACROSS frames, so a 3-tile frame at batch=8 becomes one
    call every 8 frames instead of 3 calls every frame

Does NOT change: what the model sees per tile, the tile geometry, confidence
handling, NMS, dedup, or any post-processing. Your `infer` gets exactly the
same pixels it gets today, in the same tile crops.

That boundary is the whole point. It keeps this class-1 -- output should be
identical apart from whatever batching does to kernel selection -- so it is
gated by `detbench.py exact`, not by a tolerance and a contact sheet.

WIRING IT IN

    from fastdet import run

    def infer(batch):
        # batch: list of HxWx3 uint8 RGB tile crops, len <= batch_size
        # return: list (same length, same order) of lists of
        #         (x, y, w, h, conf) in TILE-LOCAL pixels
        results = model(batch, imgsz=1280, conf=0.25, verbose=False)
        return [[(*b.xywh_local, b.conf) for b in r.boxes] for r in results]

    dets = run("chunk.mp4", infer, width=3840, height=1080,
               tile_w=1536, stride=1280, batch_size=8)

`dets` is a list of (frame, x, y, w, h, conf) in FRAME pixels, ready for your
existing dedup. Nothing here dedups: tile-seam duplicates are yours to remove
with the settings you already tuned (dedup_mode=tile dedup_iou=0.8
dedup_iomin=0.85), and reimplementing that would silently change results.

TUNING batch_size

Bigger is not always better: VRAM is the ceiling and the gain flattens once the
GPU is saturated. Start at 8, try 16 and 24, keep the fastest that fits. Batch
size is a class-1 knob only in the sense that it does not change the pixels --
it can still perturb kernel selection, so re-run `detbench exact` at whatever
you settle on.
"""
import queue
import subprocess
import threading

import numpy as np


def tile_offsets(width, tile_w, stride):
    """
    Left edges of the tiles covering `width`.

    The last tile is pulled back flush with the right edge rather than being
    allowed to run past it, so every tile is the same size and the model never
    sees padding it was not calibrated on. That does mean the final overlap is
    usually larger than `stride`, which is correct and is why the seam dedup
    exists.
    """
    if tile_w >= width:
        return [0]
    offsets = list(range(0, width - tile_w + 1, stride))
    if offsets[-1] != width - tile_w:
        offsets.append(width - tile_w)
    return offsets


def decode_frames(path, width, height, ffmpeg="ffmpeg", queue_size=16,
                  extra_args=(), pix_fmt="rgb24"):
    """
    Yield (index, HxWx3 uint8) with decode running ahead on its own thread.

    Bounded queue on purpose: unbounded, ffmpeg races ahead and a 3840x1080
    frame is 12.4 MB, so a few hundred frames of lead is gigabytes of RAM. 16
    is enough to keep the GPU fed and costs ~200 MB.
    """
    channels = 3 if pix_fmt in ("rgb24", "bgr24") else 1
    frame_bytes = width * height * channels
    cmd = [ffmpeg, "-v", "error", *extra_args, "-i", path,
           "-f", "rawvideo", "-pix_fmt", pix_fmt, "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=frame_bytes * 2)
    q = queue.Queue(maxsize=queue_size)
    err = []

    def pump():
        idx = 0
        try:
            while True:
                buf = proc.stdout.read(frame_bytes)
                if len(buf) < frame_bytes:
                    break
                q.put((idx, np.frombuffer(buf, np.uint8).reshape(height, width, channels)))
                idx += 1
        except Exception as exc:                      # pragma: no cover
            err.append(exc)
        finally:
            q.put(None)

    t = threading.Thread(target=pump, daemon=True)
    t.start()
    try:
        while True:
            item = q.get()
            if item is None:
                break
            yield item
    finally:
        proc.stdout.close()
        proc.wait()
        t.join(timeout=5)
    if err:
        raise err[0]


def run(video, infer, width, height, tile_w=1536, stride=1280, batch_size=8,
        frames=None, on_frame=None, **decode_kw):
    """
    Decode, tile, batch, infer, map back to frame coordinates.

    `frames` may be an iterable of (index, image) instead of a video path's
    decode -- used by the tests, and by anything that already has frames.
    """
    offsets = tile_offsets(width, tile_w, stride)
    source = frames if frames is not None else decode_frames(video, width, height, **decode_kw)

    out = []
    pending_tiles = []      # images
    pending_meta = []       # (frame_index, x_offset)

    def flush():
        if not pending_tiles:
            return
        results = infer(pending_tiles)
        if len(results) != len(pending_tiles):
            raise RuntimeError(
                f"infer returned {len(results)} results for {len(pending_tiles)} tiles; "
                "it must return one list per tile, in order")
        for (frame_idx, x0), boxes in zip(pending_meta, results):
            for (x, y, w, h, conf) in boxes:
                # Tile-local -> frame. The ONLY coordinate transform here.
                out.append((frame_idx, x + x0, y, w, h, conf))
        pending_tiles.clear()
        pending_meta.clear()

    for idx, img in source:
        if on_frame:
            on_frame(idx)
        for x0 in offsets:
            pending_tiles.append(img[:, x0:x0 + tile_w])
            pending_meta.append((idx, x0))
            if len(pending_tiles) >= batch_size:
                flush()
    flush()
    return out
