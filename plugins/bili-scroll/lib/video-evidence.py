"""Bounded first-part media evidence. Input/output JSON; secrets only via stdin.

Dependencies: yt-dlp, av, faster-whisper; optional rapidocr-onnxruntime and
Pillow (JPEG vision frames). The existing asr.py runs in this same process.
"""
import base64
import contextlib
import http.cookiejar
import io
import json
import math
import os
from pathlib import Path
import runpy
import shutil
import sys
import time

MAX_BYTES = 96 * 1024 * 1024
MAX_DURATION = 20 * 60


def main(options):
    import yt_dlp
    import av

    started = time.monotonic()
    root = Path(options["workDir"]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    os.chdir(root)
    limits = []

    def progress(status):
        if time.monotonic() - started > 120:
            raise RuntimeError("download_timeout")
        if status.get("downloaded_bytes", 0) > MAX_BYTES:
            raise RuntimeError("download_size_limit")

    config = {
        "quiet": True, "no_warnings": True, "noplaylist": True,
        "socket_timeout": 15, "retries": 1, "fragment_retries": 1,
        "extractor_retries": 1, "concurrent_fragment_downloads": 1,
        "max_filesize": MAX_BYTES, "cachedir": False,
        "format": "bestvideo[height<=360]/best[height<=360]/worstvideo/worst",
        "outtmpl": str(root / "frames.%(ext)s"), "progress_hooks": [progress],
        "overwrites": True, "postprocessors": [],
    }
    with yt_dlp.YoutubeDL(config) as downloader:
        for pair in options.get("cookie", "").split(";"):
            name, sep, value = pair.strip().partition("=")
            if sep and name:
                downloader.cookiejar.set_cookie(http.cookiejar.Cookie(
                    0, name, value, None, False, ".bilibili.com", True, True,
                    "/", True, True, None, True, None, None, {}, False))
        url = "https://www.bilibili.com/video/" + options["bvid"] + "/?p=1"
        info = downloader.extract_info(url, download=False)
        if info.get("entries"):
            info = next(iter(info["entries"]))
        duration = float(info.get("duration") or 0)
        if not math.isfinite(duration) or duration <= 0 or duration > MAX_DURATION:
            return {"limitations": ["Media duration unknown or exceeds 20 minute processing limit."]}
        if (info.get("filesize") or info.get("filesize_approx") or 0) > MAX_BYTES:
            return {"limitations": ["Media exceeds 96 MiB processing limit."]}
        downloader.process_info(info)
        video_path = Path(downloader.prepare_filename(info))
        if not video_path.is_file():
            return {"limitations": ["Video download unavailable."]}
        result = {"durationSeconds": duration, "frames": [], "limitations": limits}
        ocr = None
        try:
            from rapidocr_onnxruntime import RapidOCR
            ocr = RapidOCR()
        except Exception:
            limits.append("Frame OCR unavailable; install rapidocr-onnxruntime.")
        samples = max(1, min(12, int(options.get("frameSamples", 8))))
        with av.open(str(video_path)) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            for index in range(samples):
                target = duration * (index + 0.5) / samples
                try:
                    container.seek(int(target / float(stream.time_base)), stream=stream)
                    frame = None
                    for candidate in container.decode(stream):
                        if time.monotonic() - started > 150:
                            raise TimeoutError()
                        if candidate.time is not None and candidate.time >= target:
                            frame = candidate
                            break
                    if frame is None:
                        continue
                    frame = frame.reformat(width=min(frame.width, 640), height=max(2, int(frame.height * min(frame.width, 640) / frame.width)))
                    entry = {"seconds": round(float(frame.time if frame.time is not None else target), 2), "text": ""}
                    if ocr:
                        lines, _ = ocr(frame.to_ndarray(format="bgr24"))
                        entry["text"] = "\n".join(str(line[1]) for line in (lines or []) if float(line[2]) >= 0.5)[:1200]
                    if options.get("includeImages") and index < 8:
                        try:
                            buffer = io.BytesIO()
                            frame.to_image().save(buffer, format="JPEG", quality=60)
                            data = buffer.getvalue()
                            if len(data) <= 100_000:
                                entry["image"] = base64.b64encode(data).decode("ascii")
                        except Exception:
                            limits.append("JPEG frame encoding unavailable; install Pillow.")
                    result["frames"].append(entry)
                except Exception:
                    limits.append("One sampled frame could not be decoded.")
        if options.get("transcribe"):
            try:
                downloader.params.update({"format": "bestaudio/worst", "outtmpl": str(root / "speech.%(ext)s")})
                audio = downloader.extract_info(url, download=True)
                if audio.get("entries"):
                    audio = next(iter(audio["entries"]))
                audio_path = Path(downloader.prepare_filename(audio))
                if not audio_path.is_file() or audio_path.stat().st_size > MAX_BYTES:
                    raise RuntimeError("audio_unavailable")
                local_script = root / "asr.py"
                shutil.copyfile(options["asrScript"], local_script)
                cache = Path(options["cacheDir"]).resolve()
                cache.mkdir(parents=True, exist_ok=True)
                os.environ["HF_HOME"] = str(cache)
                os.environ["HF_HUB_CACHE"] = str(cache / "hub")
                output = io.StringIO()
                old_argv = sys.argv
                sys.argv = [options["asrScript"], str(audio_path), "--model", str(options.get("model") or "small")]
                try:
                    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                        namespace = runpy.run_path(str(local_script), run_name="video_evidence_asr")
                        asr_main = namespace["main"]
                        asr_main.__globals__["_TMP"] = str(root)
                        import tempfile
                        tempfile.tempdir = str(root)
                        if asr_main() != 0:
                            raise RuntimeError("asr_failed")
                finally:
                    sys.argv = old_argv
                transcript = output.getvalue().strip()
                if transcript:
                    result["transcript"] = transcript[:40_000]
                else:
                    limits.append("Audio transcription returned no usable speech.")
            except Exception:
                limits.append("Audio transcription unavailable.")
        return result


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.read(64 * 1024))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            response = main(request)
        print(json.dumps(response, ensure_ascii=False))
    except Exception:
        print(json.dumps({"limitations": ["Media extraction failed; verify yt-dlp, av and authenticated access."]}))
