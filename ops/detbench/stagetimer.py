"""
stagetimer.py - find where the 2 s/frame actually goes. Five lines to add.

The gap is the whole story: yolo11s-seg at imgsz 1280, three tiles, on a 2070
should cost roughly 90 ms/frame of inference. The pipeline spends 2,000 ms. So
about 95 % of the budget is somewhere else, and no amount of batching or FP16
touches it. Find that first -- it is both the biggest win and the only one
where "quality is not affected" is a proof rather than a tolerance, because
deleting waste does not change arithmetic.

USE

    from stagetimer import stage, frame, report
    import atexit; atexit.register(report)

    for f in frames:
        frame()                                  # count a frame
        with stage("decode"):      img = grab(f)
        with stage("tile"):        tiles = cut(img)
        with stage("infer"):       raw = model(tiles)
        with stage("mask"):        masks = post(raw)
        with stage("nms"):         dets = nms(raw)
        with stage("write"):       out.append(dets)

Nested stages are attributed to the innermost only, so "infer" inside a "loop"
stage is not double counted. Overhead is ~1 microsecond per stage: irrelevant
against anything you are hunting here.

ZERO-CODE ALTERNATIVE

    pip install py-spy
    py-spy record -o profile.svg --pid <pid> --duration 60
    py-spy dump --pid <pid>          # instant stack, often enough on its own

py-spy needs no changes and attaches to the running job. Use it first; use this
when you want per-frame milliseconds per named stage rather than a flamegraph.

WHAT THE OUTPUT MEANS

    infer  dominant                -> you are near the floor; batching/FP16/TRT
                                      is the ladder, and detbench gates it
    mask   dominant                -> full-res per-instance upsampling. Usually
                                      the single biggest and cheapest win
    decode dominant                -> serialised CPU decode. NVDEC, or overlap
                                      it with inference
    write / other dominant         -> per-frame JSON, model reload, PIL
                                      round-trips. Pure waste; deleting it is
                                      bit-identical and needs no sheet
"""
import time
from collections import OrderedDict
from contextlib import contextmanager

_totals = OrderedDict()
_counts = OrderedDict()
_frames = [0]
_depth = [0]
_stack_time = []


def frame(n=1):
    _frames[0] += n


@contextmanager
def stage(name):
    # Attribute to the innermost stage only: when a stage opens inside another,
    # the parent's own time is credited to it minus the child's, so the columns
    # sum to the wall clock instead of over-counting nested work.
    start = time.perf_counter()
    _stack_time.append(0.0)
    _depth[0] += 1
    try:
        yield
    finally:
        _depth[0] -= 1
        elapsed = time.perf_counter() - start
        child = _stack_time.pop()
        own = elapsed - child
        if _stack_time:
            _stack_time[-1] += elapsed
        _totals[name] = _totals.get(name, 0.0) + own
        _counts[name] = _counts.get(name, 0) + 1


def report(theoretical_ms_per_frame=None):
    total = sum(_totals.values())
    n = max(_frames[0], 1)
    print("\n" + "=" * 72)
    print(f"{'stage':<16}{'calls':>9}{'total s':>11}{'%':>8}{'ms/frame':>12}")
    print("-" * 72)
    for name, secs in sorted(_totals.items(), key=lambda kv: -kv[1]):
        print(f"{name:<16}{_counts[name]:>9}{secs:>11.1f}"
              f"{100 * secs / max(total, 1e-9):>7.1f}%{1000 * secs / n:>12.1f}")
    print("-" * 72)
    print(f"{'TOTAL':<16}{'':>9}{total:>11.1f}{'100.0%':>8}{1000 * total / n:>12.1f}")
    print(f"frames: {_frames[0]}")
    if theoretical_ms_per_frame:
        actual = 1000 * total / n
        print(f"\ntheoretical floor: {theoretical_ms_per_frame:.0f} ms/frame")
        print(f"actual:            {actual:.0f} ms/frame")
        print(f"overhead:          {actual - theoretical_ms_per_frame:.0f} ms/frame "
              f"({100 * (1 - theoretical_ms_per_frame / max(actual, 1e-9)):.0f}% of the budget)")
        print("\nAnything above the floor that is not 'infer' is recoverable "
              "WITHOUT changing arithmetic.\nTake it first, and prove it with "
              "`detbench.py exact`.")
    print("=" * 72)


def reset():
    _totals.clear(); _counts.clear(); _frames[0] = 0; _stack_time.clear()
