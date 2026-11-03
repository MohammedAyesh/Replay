#!/usr/bin/env python3
"""Add the CC0 tracks listed in cc0-tracks.json to Replay's bundled music library.

For each entry: fetch the source file (or the member of a pack zip) into a
cache folder, keep at most --max-seconds (with a fade-out), normalise to
-14 LUFS, and write artifacts/api-server/assets/creative/music/cc0/<slug>.m4a.
Then merge the entries into library.json (keys "cc0/<slug>"), leaving every
other entry as it is. The API seeds new keys on boot.

  python3 scripts/creative-music/import_cc0.py            # all tracks
  python3 scripts/creative-music/import_cc0.py --only warped

Only add tracks whose source page lists CC0 as the only licence.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(REPO, "artifacts", "api-server", "assets", "creative", "music")
MANIFEST = os.path.join(HERE, "cc0-tracks.json")


def fetch(url: str, cache: str) -> str:
    name = urllib.parse.unquote(url.rsplit("/", 1)[-1])
    dest = os.path.join(cache, name)
    if not os.path.exists(dest):
        print(f"download {url}", file=sys.stderr)
        tmp = dest + ".part"
        with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        os.replace(tmp, dest)
    return dest


def source_file(t: dict, cache: str, work: str) -> str:
    if "file" in t:
        return fetch(t["file"], cache)
    z = fetch(t["zip"], cache)
    with zipfile.ZipFile(z) as zf:
        member = t["member"]
        if ".." in member or member.startswith("/"):
            raise ValueError(f"bad zip member {member!r}")
        out = os.path.join(work, "src" + os.path.splitext(member)[1])
        with zf.open(member) as src, open(out, "wb") as dst:
            dst.write(src.read())
    return out


def duration(path: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True, timeout=30).stdout
    return float(out.strip())


def encode(src: str, out: str, max_s: float, target: float = -14.0, tp: float = -1.5) -> float:
    d = duration(src)
    keep = min(d, max_s)
    shape = f"atrim=0:{keep:.3f},afade=t=in:d=0.05"
    if d > max_s:
        shape += f",afade=t=out:st={keep - 3:.3f}:d=3"
    probe = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-i", src, "-af", f"{shape},loudnorm=I={target}:TP={tp}:LRA=11:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    ).stderr
    s = json.loads(probe[probe.rindex("{"):probe.rindex("}") + 1])
    af = (f"{shape},loudnorm=I={target}:TP={tp}:LRA=11:measured_I={s['input_i']}:measured_TP={s['input_tp']}"
          f":measured_LRA={s['input_lra']}:measured_thresh={s['input_thresh']}:offset={s['target_offset']}:linear=true,aresample=44100")
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-af", af,
         "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "44100", "-movflags", "+faststart", "-map_metadata", "-1", out],
        check=True,
    )
    return keep


def license_text(t: dict) -> str:
    return f"CC0 1.0 (public domain) — {t['artist']} via OpenGameArt: {t['page']}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="one slug")
    ap.add_argument("--cache", default=os.path.expanduser("~/.cache/replay-cc0-music"))
    ap.add_argument("--max-seconds", type=float, default=90.0)
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(os.path.join(OUT_DIR, "cc0"), exist_ok=True)
    tracks = json.load(open(MANIFEST))["tracks"]
    for t in tracks:
        if args.only and t["slug"] != args.only:
            continue
        with tempfile.TemporaryDirectory() as work:
            src = source_file(t, args.cache, work)
            out = os.path.join(OUT_DIR, "cc0", f"{t['slug']}.m4a")
            kept = encode(src, out, args.max_seconds)
        print(f"cc0/{t['slug']}: {kept:.1f}s -> {os.path.relpath(out, REPO)}", file=sys.stderr)

    lib_path = os.path.join(OUT_DIR, "library.json")
    lib = json.load(open(lib_path))
    others = [e for e in lib.get("tracks", []) if not e["key"].startswith("cc0/")]
    cc0 = []
    for t in tracks:
        if not os.path.exists(os.path.join(OUT_DIR, "cc0", f"{t['slug']}.m4a")):
            continue
        e = {"key": f"cc0/{t['slug']}", "title": t["title"], "artist": t["artist"], "mood": t["mood"], "license": license_text(t)}
        if t.get("bpm"):
            e["bpm"] = t["bpm"]
        cc0.append(e)
    lib["tracks"] = others + cc0
    with open(lib_path, "w") as f:
        json.dump(lib, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
