"""Decode correctness, then whether overlapping it with 'inference' pays."""
import os, subprocess, time, numpy as np
from fastdet import decode_frames, run

VIDEO = "tiny.mp4"
if not os.path.exists(VIDEO):
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi",
                    "-i", "testsrc2=size=960x270:rate=20:duration=6",
                    "-pix_fmt", "yuv420p", "-c:v", "libx264",
                    "-preset", "ultrafast", VIDEO, "-y"], check=True)
    print(f"(generated {VIDEO})")

W, H, N = 960, 270, 120          # 6s at 20fps
fails = []
def check(label, ok, detail=""):
    print(f"  {'ok ' if ok else 'FAIL'} {label}{(' — ' + detail) if detail else ''}")
    if not ok: fails.append(label)

print("decode correctness")
got = list(decode_frames(VIDEO, W, H))
check("frame count", len(got) == N, f"{len(got)} (want {N})")
check("indices in order", [i for i, _ in got] == list(range(len(got))))
check("shape and dtype", got[0][1].shape == (H, W, 3) and got[0][1].dtype == np.uint8,
      str(got[0][1].shape))
check("frames are not all identical", not np.array_equal(got[0][1], got[60][1]))
check("content is real, not zeros", got[0][1].mean() > 1.0, f"mean {got[0][1].mean():.1f}")

print("\nbounded queue does not lose or reorder under a slow consumer")
slow = []
for i, img in decode_frames(VIDEO, W, H, queue_size=4):
    if i % 30 == 0:
        time.sleep(0.02)           # stall the consumer, force the queue to fill
    slow.append(i)
check("still every frame, in order", slow == list(range(N)), f"{len(slow)} frames")

print("\ndoes overlapping decode with inference actually pay?")
# A fake model with a fixed cost per batch. Serial = decode all, then infer.
# Overlapped = fastdet's streaming path. Same total work either way.
PER_TILE_MS = 4.0

def infer(batch):
    time.sleep(PER_TILE_MS / 1000.0 * len(batch))
    return [[(1.0, 1.0, 10.0, 20.0, 0.9)] for _ in batch]

t0 = time.perf_counter()
frames = list(decode_frames(VIDEO, W, H))       # decode fully first
decode_only = time.perf_counter() - t0
t1 = time.perf_counter()
serial = run(None, infer, W, H, tile_w=640, stride=480, batch_size=8, frames=iter(frames))
serial_total = time.perf_counter() - t0
infer_only = time.perf_counter() - t1

t2 = time.perf_counter()
overlapped = run(VIDEO, infer, W, H, tile_w=640, stride=480, batch_size=8)
overlapped_total = time.perf_counter() - t2

check("same detections either way", serial == overlapped,
      f"{len(serial)} vs {len(overlapped)}")
print(f"\n    decode alone      {decode_only*1000:7.0f} ms")
print(f"    inference alone   {infer_only*1000:7.0f} ms")
print(f"    serial (sum)      {serial_total*1000:7.0f} ms")
print(f"    overlapped        {overlapped_total*1000:7.0f} ms")
saved = serial_total - overlapped_total
print(f"    saved             {saved*1000:7.0f} ms  ({100*saved/serial_total:.0f}%)"
      f"  -> {serial_total/overlapped_total:.2f}x")
print(f"\n    The ceiling is min(decode, infer) / total = "
      f"{100*min(decode_only, infer_only)/serial_total:.0f}%. Overlap can never")
print("    beat that, and it approaches it when the two are balanced.")

print("\n" + ("ALL PASS" if not fails else f"FAILURES: {fails}"))
raise SystemExit(1 if fails else 0)
