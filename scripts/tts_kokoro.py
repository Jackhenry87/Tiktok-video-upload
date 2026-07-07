#!/usr/bin/env python3
"""Local neural TTS via kokoro-onnx.

Usage: python3 scripts/tts_kokoro.py <out.wav> [voice] [speed]
Text is read from stdin. Voice defaults to am_michael (natural US male).
"""
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

MODEL = "assets/voices/kokoro-v1.0.onnx"
VOICES = "assets/voices/voices-v1.0.bin"


def main() -> int:
    out_path = sys.argv[1]
    voice = sys.argv[2] if len(sys.argv) > 2 else "am_michael"
    speed = float(sys.argv[3]) if len(sys.argv) > 3 else 1.05
    text = sys.stdin.read().strip()
    if not text:
        print("no input text", file=sys.stderr)
        return 1
    kokoro = Kokoro(MODEL, VOICES)
    samples, sample_rate = kokoro.create(text, voice=voice, speed=speed)
    sf.write(out_path, samples, sample_rate)
    print(f"wrote {out_path} ({len(samples) / sample_rate:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
