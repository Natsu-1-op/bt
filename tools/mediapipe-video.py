# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["mediapipe==0.10.32", "av==16.1.0"]
# ///
"""Decode local video in presentation order and measure eyes with MediaPipe."""

import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import hashlib
import json
from math import hypot
import os
from pathlib import Path
import sys
import tempfile
from urllib.request import urlopen

MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/face_landmarker/"
             "face_landmarker/float16/1/face_landmarker.task")
MODEL_HASH = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
EYES = ((33, 160, 158, 133, 153, 144), (362, 385, 387, 263, 373, 380))


def save_json(path, data):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
        tmp = Path(output.name)
        try:
            json.dump(data, output, ensure_ascii=False, separators=(",", ":"))
            output.flush()
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)


def model_file(cache):
    path = cache / "face_landmarker.task"
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == MODEL_HASH:
        return path
    with urlopen(MODEL_URL, timeout=30) as response:
        data = response.read(8 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != MODEL_HASH:
        raise ValueError("Face Landmarker model checksum mismatch")
    path.write_bytes(data)
    return path


def eye_ratio(landmarks, width, height):
    def distance(a, b):
        return hypot((a.x - b.x) * width, (a.y - b.y) * height)

    values = []
    for indices in EYES:
        points = [landmarks[i] for i in indices]
        if not all(0 <= p.x <= 1 and 0 <= p.y <= 1 for p in points):
            return None
        a, b, c, d, e, f = points
        span = distance(a, d)
        if span < 6:
            return None
        ratio = (distance(b, f) + distance(c, e)) / (2 * span)
        if not 0 < ratio < 0.8:
            return None
        values.append(ratio)
    return round(sum(values) / 2, 5)


def scan(source, cache, model):
    source = Path(source)
    stat = source.stat()
    implementation = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    key = hashlib.sha256(repr((source, stat.st_size, stat.st_mtime_ns, implementation)).encode()).hexdigest()
    result_path = cache / f"{key}.json"
    if result_path.exists():
        return str(result_path)

    import av
    import mediapipe as mp

    vision = mp.tasks.vision
    options = vision.FaceLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model)),
        running_mode=vision.RunningMode.VIDEO,
        min_face_detection_confidence=.6,
    )
    frames = []
    with av.open(str(source)) as container, vision.FaceLandmarker.create_from_options(options) as detector:
        stream = container.streams.video[0]
        stream.codec_context.thread_count = 2
        start = (stream.start_time or 0) * stream.time_base
        previous = -1
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            ms = round((frame.pts * frame.time_base - start) * 1000)
            if ms <= previous:
                continue
            previous = ms
            # The detector resizes internally. Limit RGB conversion overhead for HD clips.
            scale = min(1, 640 / max(frame.width, frame.height))
            width, height = round(frame.width * scale), round(frame.height * scale)
            rgb = frame.reformat(width=width, height=height, format="rgb24").to_ndarray()
            result = detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ms)
            points = result.face_landmarks
            frames.append([ms, eye_ratio(points[0], width, height) if points else None])
    if not frames:
        raise ValueError("No decodable frames with timestamps")
    save_json(result_path, {"model": f"Google MediaPipe {mp.__version__} Face Landmarker", "frames": frames})
    return str(result_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jobs", type=Path)
    parser.add_argument("cache", type=Path)
    parser.add_argument("--workers", type=int, default=min(4, os.cpu_count() or 1))
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    sources = json.loads(args.jobs.read_text())["videos"]
    model = model_file(args.cache)
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(scan, path, args.cache, model): index for index, path in enumerate(sources)}
        for future in as_completed(jobs):
            index = jobs[future]
            try:
                result = {"index": index, "cache": future.result()}
            except Exception as error:
                result = {"index": index, "error": str(error)}
            print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
