"""CosyVoice2-0.5B 情绪语音合成服务。

只做一件事：接收 {text, instruct, speed}，返回一段 16bit PCM 的 WAV。
模型与源码路径由环境变量给出，运行时产物全部落在 .scratch/emotional-voice/。
"""

import io
import os
import sys
import threading
import time
import wave

import numpy as np
import torch
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

ROOT = os.environ.get("CV_ROOT", "")
MODEL_DIR = os.environ.get("CV_MODEL_DIR", "")
PROMPT_WAV = os.environ.get("CV_PROMPT_WAV", "")
PORT = int(os.environ.get("TTS_PORT", "50051"))

if not all([ROOT, MODEL_DIR, PROMPT_WAV]):
    raise SystemExit("需要设置 CV_ROOT / CV_MODEL_DIR / CV_PROMPT_WAV 环境变量")

# CosyVoice 的 model.py 通过 `from matcha...` 导入，Matcha-TTS 是仓库子模块。
# openai-whisper 只被当作纯 Python 库用（log_mel_spectrogram / Tokenizer），
# 直接解包源码，避开 Windows 上会卡死的 sdist 构建。
for extra in [
    os.environ.get("CV_WHISPER_SRC", ""),
    os.environ.get("CV_ANTLR_SRC", ""),
]:
    if extra:
        sys.path.insert(0, extra)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "third_party", "Matcha-TTS"))

from cosyvoice.cli.cosyvoice import AutoModel  # noqa: E402

# 8GB 显卡上给 TTS 划硬上限：宁可报 OOM，也不要让 CUDA 把显存溢到内存拖死整机。
GPU_FRACTION = float(os.environ.get("CV_GPU_FRACTION", "0.45"))
if torch.cuda.is_available():
    torch.cuda.set_per_process_memory_fraction(GPU_FRACTION, device=0)

print("正在加载 CosyVoice2 模型（首次加载约需 20~60 秒）...", flush=True)
USE_FP16 = torch.cuda.is_available()
MODEL = AutoModel(
    model_dir=MODEL_DIR,
    load_jit=False,
    load_trt=False,
    fp16=USE_FP16,
)
# 注意：inference_instruct2 内部会对 prompt_wav 再做 load_wav，必须传路径而不是张量。
# GPU 推理不是线程安全的，串行化，避免并发请求串音。
LOCK = threading.Lock()
print(
    f"CosyVoice2 就绪：sample_rate={MODEL.sample_rate}, fp16={USE_FP16}",
    flush=True,
)

app = FastAPI()


class TtsRequest(BaseModel):
    text: str
    instruct: str = "用自然的语气说话。<|endofprompt|>"
    speed: float = 1.0


@app.get("/health")
def health():
    return {
        "ok": True,
        "sample_rate": MODEL.sample_rate,
        "cuda": torch.cuda.is_available(),
    }


@app.post("/tts")
def synthesize(req: TtsRequest):
    text = req.text.strip()
    if not text:
        return JSONResponse({"error": "text 不能为空"}, status_code=400)

    chunks = []
    input_text = text
    for attempt in range(3):
        try:
            with LOCK:
                chunks = list(
                    MODEL.inference_instruct2(
                        input_text,
                        req.instruct,
                        PROMPT_WAV,
                        stream=False,
                        speed=req.speed,
                        # 关掉内部分句：短句会被切成 2 个 token，声码器卷积直接报错。
                        text_frontend=False,
                    )
                )
            break
        except torch.cuda.OutOfMemoryError:
            # 同一张卡还跑着浏览器/桌面合成时偶尔会差几百 MB，清缓存后重试一次。
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            if attempt >= 1:
                raise
            time.sleep(1)
        except RuntimeError as error:
            # CosyVoice2 在极短文本上会把声码器切成 2 帧，卷积核 3 直接报错；补两个字重试。
            if "Kernel size" not in str(error) or attempt >= 2:
                raise
            input_text = input_text.rstrip("。！？，, ") + "嗯。"
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        finally:
            # PyTorch 的 caching allocator 会一直占着显存不放，8GB 卡上必须主动还回去。
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    if not chunks:
        return JSONResponse({"error": "模型没有产出音频"}, status_code=500)

    speech = torch.cat([item["tts_speech"] for item in chunks], dim=-1)
    pcm = (
        np.clip(speech.squeeze(0).float().cpu().numpy(), -1.0, 1.0) * 32767
    ).astype(np.int16)

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(MODEL.sample_rate)
        wav.writeframes(pcm.tobytes())

    return Response(content=buffer.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
