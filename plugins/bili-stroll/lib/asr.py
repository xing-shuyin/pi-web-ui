#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr.py —— 把一条 B站 视频（或本地音视频文件）转成文字。
给"这个视频没有字幕、但又值得判断"的情况用。

用法（在插件的 ASR 环境里跑）：
    .venv-asr/Scripts/python.exe asr.py BV1xxxxxxxxx          # Windows
    .venv-asr/bin/python       asr.py https://www.bilibili.com/video/BV1xx
    .venv-asr/Scripts/python.exe asr.py D:\\some\\clip.mp4 -o out.txt
    …还可以加 --model small / --model medium 换模型（默认 small）
"""
import argparse
import os
import re
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

_HOME = os.path.dirname(os.path.abspath(__file__))
_TMP = os.path.join(_HOME, 'tmp', 'asr')
try:
    os.makedirs(_TMP, exist_ok=True)
    tempfile.tempdir = _TMP
except Exception:
    pass

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HOME', os.path.join(os.path.dirname(os.path.abspath(__file__)), '.hf-cache'))
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')


def to_url(target: str) -> str:
    t = target.strip()
    if t.upper().startswith('BV') and len(t) <= 20:
        return 'https://www.bilibili.com/video/' + t
    return t


def fetch_audio(url: str, tmp: str, tag: str) -> str:
    """用 yt-dlp 把音频拉下来"""
    from yt_dlp import YoutubeDL
    opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(tmp, tag + '.%(ext)s'),
        'paths': {'home': tmp, 'temp': tmp},
        'cachedir': False,
        'nopart': True,
        'noprogress': True,
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'http_headers': {
            'Referer': 'https://www.bilibili.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        return ydl.prepare_filename(info)


def main() -> int:
    ap = argparse.ArgumentParser(description='把一条视频转成文字（默认中文）')
    ap.add_argument('target', help='BV 号 / B站链接 / 本地音视频文件')
    ap.add_argument('-o', '--out', help='写到这个文件（不给就打到标准输出）')
    ap.add_argument('--model', default=os.environ.get('BILI_DUTY_ASR_MODEL', 'small'),
                    help='Whisper 模型大小：tiny / base / small / medium（默认 small）')
    ap.add_argument('--lang', default='zh', help='语言（默认 zh；不给就自动判断请传 auto）')
    args = ap.parse_args()

    src = args.target
    tmp = _TMP
    tag = os.path.basename(src).rsplit('.', 1)[0] or 'clip'
    tag = re.sub(r'[^0-9A-Za-z_-]', '_', tag)[:40] or 'clip'
    try:
        if src.lower().startswith('http') or src.upper().startswith('BV'):
            print('[asr] 先下音频…', file=sys.stderr)
            src = fetch_audio(to_url(src), tmp, tag)
        if not os.path.exists(src):
            print('[asr] 找不到文件：' + src, file=sys.stderr)
            return 2

        from faster_whisper import WhisperModel
        print('[asr] 加载模型 %s（第一次会自动下模型，之后就是本地读）…' % args.model, file=sys.stderr)
        model = WhisperModel(args.model, device='cpu', compute_type='int8')
        print('[asr] 开始转写…', file=sys.stderr)
        segments, _info = model.transcribe(
            src,
            language=None if args.lang == 'auto' else args.lang,
            vad_filter=True,
        )
        text = ''.join(seg.text for seg in segments).strip()
    finally:
        try:
            import glob
            for f in glob.glob(os.path.join(tmp, tag + '.*')):
                try:
                    os.remove(f)
                except Exception:
                    pass
        except Exception:
            pass

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(text)
        print('[asr] 已写入：' + args.out, file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
