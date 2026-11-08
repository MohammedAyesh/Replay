"""Fetch and validate camera-original 4K fMP4 HLS byte ranges for Method B."""
import concurrent.futures
import json
import math
import os
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

VIDEO_GUID_RE = re.compile(
    r"^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$"
)
RANGE_RE = re.compile(r"^\s*(\d+)(?:@(\d+))?\s*$")
ATTR_RE = re.compile(r'(?:^|,)([^=,]+)=(?:"([^"]*)"|\'([^\']*)\'|([^,]*))')
CONTENT_RANGE_RE = re.compile(r"^bytes\s+(\d+)-(\d+)/(?:\d+|\*)$", re.IGNORECASE)

SOURCE_WAIT_SEC = 45 * 60
SOURCE_POLL_SEC = 30
SOURCE_REFERER = "https://iframe.mediadelivery.net/"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"


class SourceNotReady(Exception):
    """The camera-original 4K playlist was not published before the deadline."""


class InvalidCameraSource(Exception):
    """The published source cannot safely be used as a 32:9 camera original."""


def normalize_video_guid(value):
    value = (value or "").strip()
    if not VIDEO_GUID_RE.fullmatch(value):
        raise InvalidCameraSource("bad camera video id %r" % value)
    compact = value.replace("-", "").lower()
    return "%s-%s-%s-%s-%s" % (
        compact[:8], compact[8:12], compact[12:16], compact[16:20], compact[20:]
    )


def playlist_duration(body):
    if not body.lstrip().startswith("#EXTM3U"):
        raise InvalidCameraSource("camera source is not an HLS playlist")
    durations = []
    for line in body.splitlines():
        if line.startswith("#EXTINF:"):
            try:
                duration = float(line[len("#EXTINF:"):].split(",", 1)[0])
            except ValueError:
                raise InvalidCameraSource("invalid HLS segment duration")
            if not math.isfinite(duration) or duration <= 0:
                raise InvalidCameraSource("invalid HLS segment duration")
            durations.append(duration)
    if not durations:
        raise InvalidCameraSource("camera HLS playlist has no timed media segments")
    return sum(durations)


def _byte_range(value, implicit_offset, label):
    match = RANGE_RE.fullmatch(value or "")
    if not match:
        raise InvalidCameraSource("invalid %s byte range: %s" % (label, value))
    length = int(match.group(1))
    start = int(match.group(2)) if match.group(2) is not None else implicit_offset
    if length <= 0 or start is None or start < 0:
        raise InvalidCameraSource("missing or invalid %s byte range offset" % label)
    return {"start": start, "end": start + length - 1, "length": length}


def _attributes(value):
    return {
        match.group(1).strip(): next((item for item in match.groups()[1:] if item is not None), "").strip()
        for match in ATTR_RE.finditer(value)
    }


def parse_range_plan(body, playlist_url, start_sec, end_sec, preroll=4.0, postroll=1.0):
    if not math.isfinite(start_sec) or not math.isfinite(end_sec) or start_sec < 0 or end_sec <= start_sec:
        raise InvalidCameraSource("invalid camera source-time window")
    if not body.lstrip().startswith("#EXTM3U"):
        raise InvalidCameraSource("camera source is not an HLS playlist")

    base = urllib.parse.urlparse(playlist_url)
    if base.scheme not in ("https", "http"):
        raise InvalidCameraSource("unsupported camera playlist scheme")

    def media_url(uri):
        resolved = urllib.parse.urljoin(playlist_url, uri)
        parsed = urllib.parse.urlparse(resolved)
        if parsed.scheme not in ("https", "http") or parsed.netloc != base.netloc:
            raise InvalidCameraSource("camera HLS playlist references media on a different origin")
        return resolved

    init = None
    segments = []
    previous_end = {}
    elapsed = 0.0
    duration = None
    range_spec = None
    for raw in body.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-MAP:"):
            attrs = _attributes(line[len("#EXT-X-MAP:"):])
            if not attrs.get("URI") or not attrs.get("BYTERANGE"):
                raise InvalidCameraSource("camera fMP4 playlist is missing its init byte range")
            uri = media_url(attrs["URI"])
            parsed = _byte_range(attrs["BYTERANGE"], 0, "init")
            current = dict(parsed, url=uri)
            if init and init != current:
                raise InvalidCameraSource("camera playlist changes its init byte range")
            init = current
            continue
        if line.startswith("#EXTINF:"):
            try:
                parsed_duration = float(line[len("#EXTINF:"):].split(",", 1)[0])
            except ValueError:
                parsed_duration = 0
            duration = parsed_duration if math.isfinite(parsed_duration) and parsed_duration > 0 else None
            continue
        if line.startswith("#EXT-X-BYTERANGE:"):
            range_spec = line[len("#EXT-X-BYTERANGE:"):]
            continue
        if line.startswith("#"):
            continue
        if duration is None or range_spec is None:
            continue

        uri = media_url(line)
        parsed = _byte_range(range_spec, previous_end.get(uri), "segment")
        previous_end[uri] = parsed["end"] + 1
        segments.append(dict(parsed, url=uri, startTime=elapsed, endTime=elapsed + duration))
        elapsed += duration
        duration = None
        range_spec = None

    if not init:
        raise InvalidCameraSource("camera fMP4 playlist has no init byte range")
    if not segments:
        raise InvalidCameraSource("camera fMP4 playlist has no byte-range segments")

    requested_start = max(0.0, start_sec - max(0.0, preroll))
    requested_end = end_sec + max(0.0, postroll)
    selected = [
        segment for segment in segments
        if segment["endTime"] >= requested_start and segment["startTime"] <= requested_end
    ]
    if not selected:
        raise InvalidCameraSource("camera playlist has no segments in the requested time window")
    return {
        "init": init,
        "segments": selected,
        "selectedStartTime": selected[0]["startTime"],
        "requestedStart": requested_start,
        "requestedEnd": requested_end,
    }


def _fetch_playlist(url, timeout=15):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.getcode() != 200:
                raise RuntimeError("camera 4K playlist returned HTTP %s" % response.getcode())
            return response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        if error.code in (404, 410):
            return None
        if error.code >= 500 or error.code == 429:
            return None
        raise InvalidCameraSource("camera 4K playlist returned HTTP %s" % error.code)


def wait_for_playlist(video_id, storage_cdn_base, log, wait_sec=SOURCE_WAIT_SEC,
                      poll_sec=SOURCE_POLL_SEC, clock=time.monotonic, sleep=time.sleep):
    guid = normalize_video_guid(video_id)
    base = (storage_cdn_base or "").strip().rstrip("/")
    if not base.startswith(("https://", "http://")):
        raise InvalidCameraSource("BUNNY_STORAGE_CDN_URL is not configured")
    playlist_url = "%s/vod/%s/4k.m3u8" % (base, guid)
    started = clock()
    deadline = started + max(0, wait_sec)
    last_error = None
    while clock() < deadline:
        try:
            playlist = _fetch_playlist(playlist_url)
            if playlist:
                duration = playlist_duration(playlist)
                parse_range_plan(playlist, playlist_url, 0, min(duration, 1), preroll=0, postroll=0)
                return guid, playlist_url, playlist, duration
        except (InvalidCameraSource, OSError, TimeoutError, urllib.error.URLError) as error:
            last_error = error
            if isinstance(error, InvalidCameraSource) and "HTTP " in str(error) and "returned HTTP" in str(error):
                raise
        remaining = deadline - clock()
        if remaining <= 0:
            break
        elapsed = max(0, int(clock() - started))
        log("waiting for camera 4K source (video=%s elapsed=%ds): %s" % (
            guid, elapsed, str(last_error or "playlist not published")[-240:]
        ))
        sleep(min(max(1, poll_sec), remaining))
    raise SourceNotReady("camera 4K original was not published within %d seconds" % max(0, int(clock() - started)))


def _fetch_range(item, opener=urllib.request.urlopen):
    request = urllib.request.Request(
        item["url"],
        headers={
            "User-Agent": USER_AGENT,
            "Referer": SOURCE_REFERER,
            "Range": "bytes=%d-%d" % (item["start"], item["end"]),
        },
    )
    with opener(request, timeout=30) as response:
        status = response.getcode()
        if status != 206:
            raise RuntimeError("camera byte-range request returned HTTP %s" % status)
        content_range = response.headers.get("Content-Range")
        if content_range:
            match = CONTENT_RANGE_RE.fullmatch(content_range.strip())
            if not match or int(match.group(1)) != item["start"] or int(match.group(2)) != item["end"]:
                raise RuntimeError("unexpected camera Content-Range: %s" % content_range)
        data = response.read()
        if len(data) != item["length"]:
            raise RuntimeError("camera range returned %d bytes; expected %d" % (len(data), item["length"]))
        return data


def buffer_source(playlist_url, playlist, start_sec, end_sec, work_dir, ffprobe,
                  opener=urllib.request.urlopen, log=lambda _message: None):
    plan = parse_range_plan(playlist, playlist_url, start_sec, end_sec)
    ranges = [plan["init"]] + plan["segments"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(_fetch_range, item, opener) for item in ranges]
        blocks = [future.result() for future in futures]

    os.makedirs(work_dir, exist_ok=True)
    fd, source_path = tempfile.mkstemp(prefix="camera-4k-", suffix=".mp4", dir=work_dir)
    try:
        with os.fdopen(fd, "wb") as output:
            for block in blocks:
                output.write(block)
        probe = subprocess_probe(ffprobe, source_path)
        dims = probe["dimensions"]
        if dims["width"] < 3840 or dims["width"] * 9 != dims["height"] * 32:
            raise InvalidCameraSource(
                "camera original decodes as %dx%d; expected 32:9 at least 3840 pixels wide" %
                (dims["width"], dims["height"])
            )
        offset = probe["startTime"] - plan["selectedStartTime"]
        if not math.isfinite(offset) or abs(offset) > 2:
            raise InvalidCameraSource("unexpected camera HLS timestamp offset %.3fs" % offset)
        log("4K source buffered: %dx%d %d segments from %.3f s (offset %.3f s)" % (
            dims["width"], dims["height"], len(plan["segments"]), plan["selectedStartTime"], offset
        ))
        return source_path, dims, offset, plan["selectedStartTime"]
    except Exception:
        try:
            os.unlink(source_path)
        except OSError:
            pass
        raise


def subprocess_probe(ffprobe, source_path):
    import subprocess

    dims_result = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "json", source_path],
        capture_output=True, text=True, timeout=90,
    )
    if dims_result.returncode != 0:
        raise InvalidCameraSource("could not probe camera 4K dimensions: %s" % dims_result.stderr.strip()[-300:])
    try:
        streams = json.loads(dims_result.stdout).get("streams", [])
        width, height = int(streams[0]["width"]), int(streams[0]["height"])
    except (ValueError, KeyError, IndexError, TypeError):
        raise InvalidCameraSource("could not read camera 4K dimensions")

    time_result = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", source_path],
        capture_output=True, text=True, timeout=90,
    )
    try:
        start_time = float(time_result.stdout.strip().splitlines()[0])
    except (ValueError, IndexError):
        raise InvalidCameraSource("could not read camera 4K start timestamp")
    if not math.isfinite(start_time):
        raise InvalidCameraSource("camera 4K start timestamp is not finite")
    return {"dimensions": {"width": width, "height": height}, "startTime": start_time}
