#!/usr/bin/env python3
"""
detbench.py - time a detector variant and prove it did not move the detections.

WHY THIS EXISTS

Every throughput idea on the table -- batching, FP16, TensorRT, NVDEC decode,
lower-resolution masks, lower detection fps -- changes float arithmetic
somewhere. Normally that does not matter. It matters here because this
pipeline's behaviour lives at thresholds: conf 0.25, conf_low 0.1, nms_iou 0.7,
dedup_iou 0.8, dedup_iomin 0.85, APP_GATE 0.7. Perturb a logit in the fourth
decimal and a detection near 0.25 flips in or out, and you have quietly changed
the input relink4 was tuned on.

The project's own record says these interact non-obviously: the tile-aware merge
made the tracker WORSE under link2 and BETTER under relink2 (08-30 §1). Same
change, opposite sign, depending on what was downstream. So a speed number on
its own is not evidence of anything, and "it looks the same" is how you ship a
regression you find three changes later.

WHAT IT MEASURES

  A. wall time, per variant, warm and cold
  B. detection-level agreement against a frozen reference -- greedy IoU
     matching per frame, so misses and extras are counted separately rather
     than cancelling in a net count
  C. THRESHOLD CROSSINGS: matched boxes whose confidence moved across 0.25 or
     0.1 between reference and variant. This is the specific failure mode
     above, named and counted.

Downstream track comparison is deliberately NOT done here -- run relink4 on
each variant's detections and use merge_audit.py, which is the non-circular
instrument (score2.py cannot return a difference between two veto-on configs;
see o34-graded-and-the-metric-is-circular-2026-09-06 §2).

USAGE

  detbench.py compare --ref out/s2_clean.json --var out/s2_fp16.json
  detbench.py run --config variants.json          # times each, then compares
  detbench.py selftest                            # proves the comparison works
"""
import argparse
import json
import os
import subprocess
import sys
import time
from collections import defaultdict

import numpy as np

IOU_MATCH = 0.5
# The two that decide whether a detection exists at all.
CONF_THRESHOLDS = (0.25, 0.1)


# ---------------------------------------------------------------- loading

def _rows_from_obj(obj):
    """
    Normalise whatever shape the detector wrote into (frame, x, y, w, h, conf).

    Deliberately permissive: this project has detections in at least a clean
    json, a .npy and a bundle zip, written by different scripts at different
    times. A loader that only accepts one shape gets edited under time pressure
    and then silently accepts the wrong column order.
    """
    if isinstance(obj, dict):
        for key in ("detections", "dets", "boxes", "frames"):
            if key in obj:
                obj = obj[key]
                break
    if isinstance(obj, dict):
        # {frame: [box, ...]}
        rows = []
        for frame, boxes in obj.items():
            for b in boxes:
                rows.append(_row(b, default_frame=int(frame)))
        return rows
    if isinstance(obj, list):
        return [_row(b) for b in obj]
    raise ValueError(f"unrecognised detection container: {type(obj)}")


def _row(b, default_frame=None):
    if isinstance(b, dict):
        frame = b.get("frame", b.get("f", default_frame))
        if frame is None:
            raise ValueError("detection has no frame and none was implied")
        conf = b.get("conf", b.get("score", b.get("c", 1.0)))
        if "w" in b and "h" in b:
            return (int(frame), float(b["x"]), float(b["y"]),
                    float(b["w"]), float(b["h"]), float(conf))
        if "x2" in b:
            return (int(frame), float(b["x1"]), float(b["y1"]),
                    float(b["x2"]) - float(b["x1"]),
                    float(b["y2"]) - float(b["y1"]), float(conf))
        raise ValueError(f"detection has neither w/h nor x2/y2: {sorted(b)}")
    seq = list(b)
    if default_frame is not None and len(seq) in (4, 5):
        x, y, w, h = seq[:4]
        conf = seq[4] if len(seq) == 5 else 1.0
        return (int(default_frame), float(x), float(y), float(w), float(h), float(conf))
    frame, x, y, w, h = seq[:5]
    conf = seq[5] if len(seq) > 5 else 1.0
    return (int(frame), float(x), float(y), float(w), float(h), float(conf))


def load(path, npy_cols="frame,x,y,w,h,conf"):
    if path.endswith(".npy"):
        arr = np.load(path, allow_pickle=False)
        cols = npy_cols.split(",")
        idx = {name: i for i, name in enumerate(cols)}
        missing = [c for c in ("frame", "x", "y", "w", "h") if c not in idx]
        if missing:
            raise ValueError(f"--npy-cols is missing {missing}")
        conf = arr[:, idx["conf"]] if "conf" in idx else np.ones(len(arr))
        return [(int(arr[i, idx["frame"]]), float(arr[i, idx["x"]]),
                 float(arr[i, idx["y"]]), float(arr[i, idx["w"]]),
                 float(arr[i, idx["h"]]), float(conf[i])) for i in range(len(arr))]
    with open(path) as fh:
        return _rows_from_obj(json.load(fh))


def by_frame(rows, min_conf=0.0):
    out = defaultdict(list)
    for r in rows:
        if r[5] >= min_conf:
            out[r[0]].append(r)
    return out


# ---------------------------------------------------------------- exact

def fingerprint(rows, quantise=None):
    """
    A hash of the detection set, for proving a change altered nothing at all.

    THE POINT. The optimisations split into two classes and they deserve
    different gates:

      class 1  removing overhead -- model reload per frame, redundant decode,
               per-frame JSON, full-res mask upsampling that is thrown away.
               These do not touch arithmetic. The output should be IDENTICAL,
               and "identical" is provable rather than argued.

      class 2  batching, FP16, TensorRT. These change float results. There is
               no bit-identical claim available, so they go through the
               statistical comparison and then a sheet.

    Most of the 20x gap between 2 s/frame and the ~90 ms the model actually
    costs is class 1. Take that first: it is the biggest win AND the only one
    where "quality is not affected" is a proof rather than a tolerance.

    quantise rounds coordinates to a given number of decimals before hashing.
    Leave it None for a true bit-for-bit check; set it to 6 only if a variant
    legitimately reorders float text (a different json writer), never to paper
    over arithmetic that moved.
    """
    import hashlib
    h = hashlib.sha256()
    key = []
    for (f, x, y, w, hh, c) in rows:
        if quantise is not None:
            x, y, w, hh, c = (round(v, quantise) for v in (x, y, w, hh, c))
        key.append((f, x, y, w, hh, c))
    # Sorted, so a variant that emits the same detections in a different order
    # still counts as identical. Order is not a quality property.
    for row in sorted(key):
        h.update(repr(row).encode())
    return h.hexdigest(), len(key)


def exact_compare(ref_rows, var_rows, quantise=None):
    rh, rn = fingerprint(ref_rows, quantise)
    vh, vn = fingerprint(var_rows, quantise)
    same = rh == vh
    out = {"identical": same, "ref_hash": rh[:16], "var_hash": vh[:16],
           "ref_boxes": rn, "var_boxes": vn}
    if not same:
        # Say HOW it differs, because "not identical" on its own sends people
        # hunting for arithmetic when they actually dropped a box.
        rs, vs = set(), set()
        for rows, acc in ((ref_rows, rs), (var_rows, vs)):
            for (f, x, y, w, hh, c) in rows:
                if quantise is not None:
                    x, y, w, hh, c = (round(v, quantise) for v in (x, y, w, hh, c))
                acc.add((f, x, y, w, hh, c))
        out["only_in_ref"] = len(rs - vs)
        out["only_in_var"] = len(vs - rs)
        out["shared"] = len(rs & vs)
    return out


# ---------------------------------------------------------------- geometry

def iou_matrix(a, b):
    """Pairwise IoU. a, b are (n,4) and (m,4) in x,y,w,h."""
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)))
    ax1, ay1 = a[:, 0:1], a[:, 1:2]
    ax2, ay2 = ax1 + a[:, 2:3], ay1 + a[:, 3:4]
    bx1, by1 = b[:, 0], b[:, 1]
    bx2, by2 = bx1 + b[:, 2], by1 + b[:, 3]
    ix = np.clip(np.minimum(ax2, bx2) - np.maximum(ax1, bx1), 0, None)
    iy = np.clip(np.minimum(ay2, by2) - np.maximum(ay1, by1), 0, None)
    inter = ix * iy
    union = (a[:, 2:3] * a[:, 3:4]) + (b[:, 2] * b[:, 3]) - inter
    return inter / np.maximum(union, 1e-9)


def match_frame(ref, var, thr=IOU_MATCH):
    """
    Greedy highest-IoU-first matching within one frame.

    Greedy rather than Hungarian on purpose: it is what a human would call
    "the same box", it is stable under tiny perturbations, and an optimal
    assignment can pair two boxes that a person would never call the same
    detection just to raise a total.
    """
    A = np.array([[r[1], r[2], r[3], r[4]] for r in ref], dtype=float).reshape(-1, 4)
    B = np.array([[r[1], r[2], r[3], r[4]] for r in var], dtype=float).reshape(-1, 4)
    M = iou_matrix(A, B)
    pairs, used_r, used_v = [], set(), set()
    if M.size:
        order = np.dstack(np.unravel_index(np.argsort(-M, axis=None), M.shape))[0]
        for i, j in order:
            i, j = int(i), int(j)
            if M[i, j] < thr:
                break
            if i in used_r or j in used_v:
                continue
            used_r.add(i)
            used_v.add(j)
            pairs.append((i, j, float(M[i, j])))
    misses = [i for i in range(len(ref)) if i not in used_r]
    extras = [j for j in range(len(var)) if j not in used_v]
    return pairs, misses, extras


# ---------------------------------------------------------------- compare

def compare(ref_rows, var_rows, thr=IOU_MATCH, min_conf=0.0,
            ref_cls=None, var_cls=None):
    """
    ref_cls / var_cls: optional per-detection kit class, index-aligned to the
    detection rows.

    THIS IS NOT OPTIONAL FOR TWO OF THE VARIANTS. A box-level comparison is
    blind to exactly the thing NVDEC decode and reduced-resolution masks
    change: person_seg's Lab triple and the mask fill. Those feed mkkit's
    three-class reader, which is what KIT_VETO=1 forbids assignments on. So a
    variant can be 100% box-identical and still have moved the veto's input,
    and nothing above would say a word. Pass the class arrays for any variant
    that touches decode, colour or masks.
    """
    ref_f, var_f = by_frame(ref_rows, min_conf), by_frame(var_rows, min_conf)
    frames = sorted(set(ref_f) | set(var_f))

    matched = misses = extras = 0
    ious, dconf = [], []
    crossings = {t: 0 for t in CONF_THRESHOLDS}
    worst_frames = []
    cls_checked = cls_changed = 0

    ref_index = {id(r): i for i, r in enumerate(ref_rows)}
    var_index = {id(r): i for i, r in enumerate(var_rows)}

    for f in frames:
        r, v = ref_f.get(f, []), var_f.get(f, [])
        pairs, m, e = match_frame(r, v, thr)
        matched += len(pairs)
        misses += len(m)
        extras += len(e)
        for i, j, iou in pairs:
            ious.append(iou)
            cr, cv = r[i][5], v[j][5]
            dconf.append(cv - cr)
            for t in CONF_THRESHOLDS:
                if (cr >= t) != (cv >= t):
                    crossings[t] += 1
            if ref_cls is not None and var_cls is not None:
                gi, gj = ref_index.get(id(r[i])), var_index.get(id(v[j]))
                if gi is not None and gj is not None and gi < len(ref_cls) and gj < len(var_cls):
                    cls_checked += 1
                    if ref_cls[gi] != var_cls[gj]:
                        cls_changed += 1
        if m or e:
            worst_frames.append((len(m) + len(e), f, len(m), len(e)))

    worst_frames.sort(reverse=True)
    n_ref = sum(len(v) for v in ref_f.values())
    n_var = sum(len(v) for v in var_f.values())

    return {
        "ref_boxes": n_ref,
        "var_boxes": n_var,
        "box_delta_pct": 100.0 * (n_var - n_ref) / max(n_ref, 1),
        "matched": matched,
        "recall_pct": 100.0 * matched / max(n_ref, 1),
        "misses": misses,
        "extras": extras,
        "mean_iou": float(np.mean(ious)) if ious else 0.0,
        "p05_iou": float(np.percentile(ious, 5)) if ious else 0.0,
        "mean_dconf": float(np.mean(dconf)) if dconf else 0.0,
        "max_abs_dconf": float(np.max(np.abs(dconf))) if dconf else 0.0,
        "threshold_crossings": {str(t): crossings[t] for t in CONF_THRESHOLDS},
        "frames_compared": len(frames),
        "worst_frames": worst_frames[:5],
        "kit_class_checked": cls_checked,
        "kit_class_changed": cls_changed,
        "kit_class_changed_pct": (100.0 * cls_changed / cls_checked) if cls_checked else None,
    }


def verdict(c, tol_pct=0.5):
    """
    A variant is only 'clean' if it is clean on the axis that actually
    propagates. Net box count is the misleading one -- misses and extras
    cancel in it -- so it is deliberately not the gate.
    """
    reasons = []
    if c["recall_pct"] < 100.0 - tol_pct:
        reasons.append(f"recall {c['recall_pct']:.2f}% (lost {c['misses']} ref boxes)")
    if 100.0 * c["extras"] / max(c["ref_boxes"], 1) > tol_pct:
        reasons.append(f"{c['extras']} new boxes")
    total_cross = sum(c["threshold_crossings"].values())
    if 100.0 * total_cross / max(c["matched"], 1) > tol_pct:
        reasons.append(f"{total_cross} confidence-threshold crossings")
    # A kit-class flip is worse than a box flip: KIT_VETO forbids assignments
    # across classes, so a changed class changes what the linker is ALLOWED to
    # do, not merely what it sees.
    if c.get("kit_class_changed_pct") is not None and c["kit_class_changed_pct"] > tol_pct:
        reasons.append(f"{c['kit_class_changed']} kit-class flips "
                       f"({c['kit_class_changed_pct']:.2f}% of matched)")
    return ("CLEAN", []) if not reasons else ("DRIFTED", reasons)


# ---------------------------------------------------------------- runner

def time_cmd(cmd, repeats=1):
    times = []
    for _ in range(max(1, repeats)):
        t0 = time.perf_counter()
        proc = subprocess.run(cmd, shell=True)
        times.append(time.perf_counter() - t0)
        if proc.returncode != 0:
            raise SystemExit(f"variant command failed ({proc.returncode}): {cmd}")
    return {"wall_s": min(times), "runs": len(times), "all_s": times}


def run_config(path):
    cfg = json.load(open(path))
    ref_path = cfg["reference"]["detections"]
    fps_ref = cfg["reference"].get("fps")
    results = []

    for v in cfg["variants"]:
        name = v["name"]
        print(f"\n=== {name} ===", flush=True)
        timing = {"wall_s": None}
        if v.get("cmd"):
            timing = time_cmd(v["cmd"], v.get("repeats", 1))
            print(f"  wall {timing['wall_s']:.1f}s")

        entry = {"name": name, **timing, "detections": v["detections"]}

        # fps guard. Every tracker parameter is expressed in frames or in
        # metres-per-second derived from frames: CONFIRM=3 is 150ms at 20fps
        # and 600ms at 5. A variant that changes the rate invalidates the
        # tuning AND makes 3 of every 4 emitted box-frames invented, against a
        # pipeline whose coast_fraction is deliberately 0%. Refuse to imply
        # otherwise by printing a comparison.
        if fps_ref and v.get("fps") and abs(v["fps"] - fps_ref) > 1e-6:
            entry["verdict"] = "NOT COMPARABLE"
            entry["reasons"] = [
                f"fps {v['fps']} != reference {fps_ref}: every tracker gate is "
                "frame-derived, so the tuning does not carry. Re-tune and "
                "re-grade a sheet before believing any downstream number."
            ]
            results.append(entry)
            continue

        if v["detections"] != ref_path:
            c = compare(load(ref_path, cfg.get("npy_cols", "frame,x,y,w,h,conf")),
                        load(v["detections"], cfg.get("npy_cols", "frame,x,y,w,h,conf")),
                        cfg.get("iou", IOU_MATCH), cfg.get("min_conf", 0.0))
            v_, reasons = verdict(c, cfg.get("tolerance_pct", 0.5))
            entry.update({"compare": c, "verdict": v_, "reasons": reasons})
        else:
            entry.update({"verdict": "REFERENCE", "reasons": []})
        results.append(entry)

    report(results)
    out = cfg.get("out", "detbench_results.json")
    json.dump(results, open(out, "w"), indent=2)
    print(f"\nwritten: {out}")
    return results


def report(results):
    base = next((r for r in results if r["verdict"] == "REFERENCE"), None)
    b = base["wall_s"] if base and base.get("wall_s") else None
    print("\n" + "=" * 100)
    print(f"{'variant':<22}{'wall s':>9}{'speed':>8}{'boxes Δ%':>10}"
          f"{'recall%':>9}{'extras':>8}{'cross':>7}  verdict")
    print("-" * 100)
    for r in results:
        c = r.get("compare")
        w = f"{r['wall_s']:.1f}" if r.get("wall_s") else "-"
        sp = f"{b / r['wall_s']:.2f}x" if b and r.get("wall_s") else "-"
        if c:
            cross = sum(c["threshold_crossings"].values())
            print(f"{r['name']:<22}{w:>9}{sp:>8}{c['box_delta_pct']:>+10.2f}"
                  f"{c['recall_pct']:>9.2f}{c['extras']:>8}{cross:>7}  {r['verdict']}")
        else:
            print(f"{r['name']:<22}{w:>9}{sp:>8}{'-':>10}{'-':>9}{'-':>8}{'-':>7}  {r['verdict']}")
        for reason in r.get("reasons", []):
            print(f"{'':<22}  ! {reason}")
    print("=" * 100)
    print("CLEAN means the detection set is intact; it is NOT a claim about tracks.")
    print("Run relink4 on each CLEAN variant and grade with merge_audit.py before shipping.")


# ---------------------------------------------------------------- selftest

def selftest():
    """
    Prove the comparison reports what was actually injected.

    A harness whose own failure mode is silence is worse than no harness: it
    would clear every variant and you would trust it.
    """
    rng = np.random.default_rng(7)
    ref = []
    for f in range(300):
        for _ in range(12):
            ref.append((f, float(rng.uniform(0, 3800)), float(rng.uniform(0, 1000)),
                        float(rng.uniform(20, 60)), float(rng.uniform(60, 160)),
                        float(rng.uniform(0.05, 0.95))))

    fails = []

    def check(label, got, want, tol=0):
        ok = abs(got - want) <= tol
        print(f"  {'ok ' if ok else 'FAIL'} {label}: got {got}, want {want}±{tol}")
        if not ok:
            fails.append(label)

    print("identical input -> no drift")
    c = compare(ref, list(ref))
    check("recall", round(c["recall_pct"], 6), 100.0)
    check("extras", c["extras"], 0)
    check("misses", c["misses"], 0)
    check("crossings", sum(c["threshold_crossings"].values()), 0)
    v, _ = verdict(c)
    check("verdict CLEAN", 1 if v == "CLEAN" else 0, 1)

    print("\ndrop 100 boxes -> exactly 100 misses")
    dropped = [r for i, r in enumerate(ref) if i % 36 != 0]
    c = compare(ref, dropped)
    check("misses", c["misses"], len(ref) - len(dropped))
    check("extras", c["extras"], 0)
    v, _ = verdict(c)
    check("verdict DRIFTED", 1 if v == "DRIFTED" else 0, 1)

    print("\nadd 50 boxes -> exactly 50 extras")
    added = list(ref) + [(f, 100.0, 100.0, 40.0, 100.0, 0.9) for f in range(50)]
    c = compare(ref, added)
    check("extras", c["extras"], 50)
    check("misses", c["misses"], 0)

    print("\njitter 1px -> still matched, mean IoU below 1")
    jit = [(f, x + 1, y, w, h, cf) for (f, x, y, w, h, cf) in ref]
    c = compare(ref, jit)
    check("recall", round(c["recall_pct"], 2), 100.0)
    print(f"  mean IoU {c['mean_iou']:.4f} (expect < 1.0)")
    if not c["mean_iou"] < 1.0:
        fails.append("jitter mean_iou")

    print("\nbig shift -> essentially nothing matches, and the net count still says zero")
    far = [(f, x + 500, y, w, h, cf) for (f, x, y, w, h, cf) in ref]
    c = compare(ref, far)
    # NOT exactly zero, and that is the harness being right rather than wrong:
    # with 12 boxes scattered over a 3840-wide frame, a shifted box occasionally
    # lands on a neighbour at IoU >= 0.5 by coincidence. An assertion of zero
    # here was the first thing this self-test caught, in itself.
    coincidence_pct = 100.0 * c["matched"] / len(ref)
    print(f"  coincidental matches: {c['matched']} ({coincidence_pct:.2f}%)")
    check("matched is negligible", 1 if coincidence_pct < 0.5 else 0, 1)
    check("misses ~ all", 1 if c["misses"] > 0.99 * len(ref) else 0, 1)
    check("extras ~ all", 1 if c["extras"] > 0.99 * len(ref) else 0, 1)
    # The headline: a net box count of exactly 0% while the detection set is
    # entirely different. This is why box_delta_pct is reported but is not the
    # gate -- misses and extras cancel in it perfectly.
    check("box_delta_pct is 0 despite total disagreement",
          round(c["box_delta_pct"], 6), 0.0)
    v, _ = verdict(c)
    check("verdict DRIFTED", 1 if v == "DRIFTED" else 0, 1)

    print("\nconfidence nudge across 0.25 -> counted as a crossing")
    # This is the FP16 failure mode in miniature.
    nudged = [(f, x, y, w, h, 0.26 if abs(cf - 0.24) < 1e-9 else cf)
              for (f, x, y, w, h, cf) in ref]
    seeded = [(f, x, y, w, h, 0.24) for (f, x, y, w, h, cf) in ref[:40]] + list(ref[40:])
    nudged = [(f, x, y, w, h, 0.26) for (f, x, y, w, h, cf) in seeded[:40]] + list(seeded[40:])
    c = compare(seeded, nudged)
    check("crossings at 0.25", c["threshold_crossings"]["0.25"], 40)
    check("recall unaffected", round(c["recall_pct"], 2), 100.0)
    v, _ = verdict(c)
    check("verdict DRIFTED on crossings alone", 1 if v == "DRIFTED" else 0, 1)

    print("\nloader accepts the shapes this project actually writes")
    shapes = {
        "list of dicts xywh": [{"frame": 1, "x": 1, "y": 2, "w": 3, "h": 4, "conf": 0.9}],
        "list of dicts xyxy": [{"frame": 1, "x1": 1, "y1": 2, "x2": 4, "y2": 6, "score": 0.9}],
        "frame keyed": {"1": [[1, 2, 3, 4, 0.9]]},
        "wrapped": {"detections": [{"frame": 1, "x": 1, "y": 2, "w": 3, "h": 4}]},
    }
    for label, obj in shapes.items():
        rows = _rows_from_obj(obj)
        ok = len(rows) == 1 and rows[0][0] == 1
        print(f"  {'ok ' if ok else 'FAIL'} {label} -> {rows}")
        if not ok:
            fails.append(label)

    print("\n" + ("ALL PASS" if not fails else f"FAILURES: {fails}"))
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("exact", help="prove a variant changed nothing at all")
    e.add_argument("--ref", required=True)
    e.add_argument("--var", required=True)
    e.add_argument("--quantise", type=int, default=None)
    e.add_argument("--npy-cols", default="frame,x,y,w,h,conf")

    c = sub.add_parser("compare")
    c.add_argument("--ref", required=True)
    c.add_argument("--var", required=True)
    c.add_argument("--iou", type=float, default=IOU_MATCH)
    c.add_argument("--min-conf", type=float, default=0.0)
    c.add_argument("--npy-cols", default="frame,x,y,w,h,conf")

    r = sub.add_parser("run")
    r.add_argument("--config", required=True)

    sub.add_parser("selftest")

    a = ap.parse_args()
    if a.cmd == "selftest":
        return selftest()
    if a.cmd == "exact":
        res = exact_compare(load(a.ref, a.npy_cols), load(a.var, a.npy_cols), a.quantise)
        print(json.dumps(res, indent=2))
        if res["identical"]:
            print("\nIDENTICAL - quality is provably unaffected. Ship it.")
            return 0
        print("\nNOT IDENTICAL - this is not a class-1 change. "
              "Either the refactor altered arithmetic, or it is really a class-2 "
              "change and belongs in `compare` plus merge_audit plus a sheet.")
        return 2
    if a.cmd == "compare":
        res = compare(load(a.ref, a.npy_cols), load(a.var, a.npy_cols), a.iou, a.min_conf)
        v, reasons = verdict(res)
        print(json.dumps(res, indent=2))
        print(f"\nverdict: {v}")
        for reason in reasons:
            print(f"  ! {reason}")
        return 0 if v == "CLEAN" else 2
    if a.cmd == "run":
        run_config(a.config)
        return 0


if __name__ == "__main__":
    sys.exit(main())
