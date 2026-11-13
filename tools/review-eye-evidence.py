# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["mediapipe==0.10.32", "av==16.1.0"]
# ///
"""Rescan every unresolved interval with both eye shapes and blink scores."""

from concurrent.futures import ProcessPoolExecutor, as_completed
import hashlib
import json
from math import hypot
from pathlib import Path
import sys
import tempfile


EYES = ((33, 160, 158, 133, 153, 144), (362, 385, 387, 263, 373, 380))


def eye_shapes(points, width, height):
    def distance(a, b):
        return hypot((a.x - b.x) * width, (a.y - b.y) * height)

    values = []
    for eye in EYES:
        a, b, c, d, e, f = (points[i] for i in eye)
        span = distance(a, d)
        if span < 10 or not all(0 <= p.x <= 1 and 0 <= p.y <= 1 for p in (a,b,c,d,e,f)):
            return None
        values.append(round((distance(b, f) + distance(c, e)) / (2 * span), 4))
    return values


def scan(job, model, out):
    import av
    import mediapipe as mp

    file = Path(job["file"])
    stat = file.stat()
    signature = hashlib.sha256(json.dumps([job,stat.st_size,stat.st_mtime_ns]).encode() + Path(__file__).read_bytes()).hexdigest()
    target = out / f'{job["subject"]}-{signature[:16]}.json'
    if target.is_file():
        return target

    options = mp.tasks.vision.FaceLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        min_face_detection_confidence=.5,
        output_face_blendshapes=True,
    )
    evidence = []
    with av.open(str(file)) as container, mp.tasks.vision.FaceLandmarker.create_from_options(options) as detector:
        stream = container.streams.video[0]
        stream.codec_context.thread_count = 2
        start = (stream.start_time or 0) * stream.time_base
        last = -1
        for lo, hi in job["ranges"]:
            container.seek(int(start / stream.time_base + max(0, lo - 230) / 1000 / stream.time_base), stream=stream)
            for frame in container.decode(stream):
                if frame.pts is None:
                    continue
                ms = round((frame.pts * frame.time_base - start) * 1000)
                if ms < lo - 230 or ms <= last:
                    continue
                if ms > hi:
                    break
                last = ms
                scale = min(1, 768 / max(frame.width, frame.height))
                width, height = round(frame.width * scale), round(frame.height * scale)
                rgb = frame.reformat(width=width,height=height,format="rgb24").to_ndarray()
                result = detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB,data=rgb),ms)
                if ms < lo:
                    continue
                points = result.face_landmarks[0] if result.face_landmarks else None
                eyes = eye_shapes(points,width,height) if points else None
                scores = {item.category_name:item.score for item in result.face_blendshapes[0]} if result.face_blendshapes else {}
                values = [round(scores[k],4) for k in ("eyeBlinkLeft","eyeBlinkRight")] if "eyeBlinkLeft" in scores and "eyeBlinkRight" in scores else None
                evidence.append([ms,*(eyes or [None,None]),*(values or [None,None])])

    with tempfile.NamedTemporaryFile(mode="w",dir=out,delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump({"subject":job["subject"],"frames":evidence},stream,separators=(",",":"))
            stream.flush()
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return target


def main():
    jobs, model, out = (Path(p) for p in sys.argv[1:4])
    out.mkdir(mode=0o700,parents=True,exist_ok=True)
    sources = json.loads(jobs.read_text())
    with ProcessPoolExecutor(max_workers=int(sys.argv[4])) as pool:
        futures = {pool.submit(scan,job,model,out):job["subject"] for job in sources}
        for future in as_completed(futures):
            try:
                print(json.dumps({"subject":futures[future],"file":str(future.result())}),flush=True)
            except Exception as error:
                print(json.dumps({"subject":futures[future],"error":str(error)}),flush=True)


if __name__ == "__main__":
    main()
