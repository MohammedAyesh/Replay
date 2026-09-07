"""
Prove the restructuring changes nothing.

The claim fastdet makes is narrow and testable: same pixels to the model, same
boxes out, only the scheduling differs. So the tests compare it against the
naive one-tile-at-a-time path with a deterministic fake model, and require
EXACT equality -- not approximate, because there is no arithmetic here to drift.
"""
import numpy as np
from fastdet import tile_offsets, run

W, H = 3840, 1080
TILE, STRIDE = 1536, 1280

fails = []
def check(label, ok, detail=""):
    print(f"  {'ok ' if ok else 'FAIL'} {label}{(' — ' + detail) if detail else ''}")
    if not ok: fails.append(label)


print("tile geometry")
offs = tile_offsets(W, TILE, STRIDE)
check("covers the full width", offs[0] == 0 and offs[-1] + TILE == W, f"{offs}")
check("every tile the same size", all(0 <= o <= W - TILE for o in offs))
check("no gap between tiles", all(offs[i+1] <= offs[i] + TILE for i in range(len(offs)-1)))
check("narrow frame -> one tile", tile_offsets(1000, TILE, STRIDE) == [0])
check("exact fit -> no extra tile", tile_offsets(TILE, TILE, STRIDE) == [0])


print("\na deterministic fake model: one box per tile, at a position derived from pixels")
def fake_infer(batch):
    # Position depends on the tile's own content, so a mis-cut tile or a
    # mis-ordered batch produces a different answer and the test catches it.
    res = []
    for t in batch:
        seed = int(t[0, 0, 0]) + int(t[0, 1, 0]) * 256
        res.append([(seed % 100, seed % 50, 20.0, 40.0, 0.5 + (seed % 10) / 100)])
    return res

def make_frames(n):
    frames = []
    for i in range(n):
        img = np.zeros((H, W, 3), np.uint8)
        # unique per (frame, x) so every tile is distinguishable
        for x in range(W):
            img[0, x, 0] = (i * 7 + x) % 256
            img[0, x, 1] = (x // 97) % 256
        frames.append((i, img))
    return frames

frames = make_frames(9)

def naive(frames):
    """One tile at a time — the thing we are claiming to be equivalent to."""
    out = []
    for idx, img in frames:
        for x0 in tile_offsets(W, TILE, STRIDE):
            for (x, y, w, h, c) in fake_infer([img[:, x0:x0+TILE]])[0]:
                out.append((idx, x + x0, y, w, h, c))
    return out

ref = naive(frames)
print(f"  reference: {len(ref)} detections over {len(frames)} frames")

for bs in (1, 2, 3, 4, 8, 16, 64, 1000):
    got = run(None, fake_infer, W, H, TILE, STRIDE, batch_size=bs, frames=iter(make_frames(9)))
    check(f"batch_size={bs} identical to naive", got == ref,
          "" if got == ref else f"{len(got)} vs {len(ref)}")

print("\nordering and completeness")
seen = []
run(None, fake_infer, W, H, TILE, STRIDE, batch_size=8,
    frames=iter(make_frames(9)), on_frame=seen.append)
check("every frame visited exactly once, in order", seen == list(range(9)), f"{seen}")
check("detections carry the right frame indices",
      sorted({d[0] for d in ref}) == list(range(9)))

print("\ncoordinate mapping is exact")
# A model that reports a box at tile-local x=0 must come back at the tile's
# own offset -- this is the transform that silently ruins everything if wrong.
def corner_infer(batch):
    return [[(0.0, 0.0, 10.0, 10.0, 0.9)] for _ in batch]
got = run(None, corner_infer, W, H, TILE, STRIDE, batch_size=5, frames=iter(make_frames(2)))
xs = sorted({d[1] for d in got})
check("tile-local x=0 maps to each tile offset", xs == [float(o) for o in tile_offsets(W, TILE, STRIDE)], f"{xs}")

print("\nit refuses a model that returns the wrong number of results")
def bad_infer(batch):
    return [[(1.0, 1.0, 2.0, 2.0, 0.5)]] * (len(batch) - 1)
try:
    run(None, bad_infer, W, H, TILE, STRIDE, batch_size=4, frames=iter(make_frames(2)))
    check("raises on length mismatch", False, "it silently accepted a short result list")
except RuntimeError as exc:
    check("raises on length mismatch", "must return one list per tile" in str(exc))

print("\nempty input")
check("no frames -> no detections",
      run(None, fake_infer, W, H, TILE, STRIDE, frames=iter([])) == [])

print("\n" + ("ALL PASS" if not fails else f"FAILURES: {fails}"))
raise SystemExit(1 if fails else 0)
