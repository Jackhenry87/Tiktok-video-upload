#!/usr/bin/env python3
"""Local neural TTS via Kokoro-82M ONNX (community export).

Usage: python3 scripts/tts_kokoro.py <out.wav> [voice] [speed]
Text is read from stdin. Voice defaults to am_michael (natural US male).

Runs inference directly (this export's signature differs from the
kokoro-onnx wrapper): input_ids int64 [1,seq], style float [1,256]
selected by token count, speed float [1]. Long texts are synthesized
sentence-by-sentence and concatenated with short pauses.
"""
import re
import sys

import numpy as np
import onnxruntime as ort
import soundfile as sf
from kokoro_onnx.tokenizer import Tokenizer

MODEL = "assets/voices/kokoro-v1.0.onnx"
VOICES = "assets/voices/voices-v1.0.bin"
SAMPLE_RATE = 24000
MAX_TOKENS = 480
PAUSE_SEC = 0.18


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.replace("\n", " ").strip())
    return [p.strip() for p in parts if p.strip()]


def main() -> int:
    out_path = sys.argv[1]
    voice = sys.argv[2] if len(sys.argv) > 2 else "am_michael"
    speed = float(sys.argv[3]) if len(sys.argv) > 3 else 1.05
    text = sys.stdin.read().strip()
    if not text:
        print("no input text", file=sys.stderr)
        return 1

    tokenizer = Tokenizer()
    session = ort.InferenceSession(MODEL)
    voices = np.load(VOICES)
    if voice not in voices:
        print(f"unknown voice {voice}; available: {list(voices.keys())}", file=sys.stderr)
        return 1
    style_table = voices[voice]  # (510, 1, 256), row indexed by token count

    chunks: list[np.ndarray] = []
    pause = np.zeros(int(SAMPLE_RATE * PAUSE_SEC), dtype=np.float32)

    # Group sentences so each inference stays under the token limit.
    group: list[int] = []

    def flush(tokens: list[int]) -> None:
        if not tokens:
            return
        ids = np.array([[0, *tokens, 0]], dtype=np.int64)
        style = style_table[min(len(tokens), len(style_table) - 1)].astype(np.float32)
        (waveform,) = session.run(
            None,
            {"input_ids": ids, "style": style, "speed": np.array([speed], dtype=np.float32)},
        )
        chunks.append(np.asarray(waveform, dtype=np.float32).squeeze())
        chunks.append(pause)

    for sentence in split_sentences(text):
        tokens = tokenizer.tokenize(tokenizer.phonemize(sentence, lang="en-us"))
        if not tokens:
            continue
        if group and len(group) + len(tokens) + 1 > MAX_TOKENS:
            flush(group)
            group = []
        if len(tokens) > MAX_TOKENS:
            flush(tokens[:MAX_TOKENS])
            continue
        group.extend(tokens + [16])  # 16 = space token between sentences
    flush(group)

    if not chunks:
        print("nothing synthesized", file=sys.stderr)
        return 1
    audio = np.concatenate(chunks)
    sf.write(out_path, audio, SAMPLE_RATE)
    print(f"wrote {out_path} ({len(audio) / SAMPLE_RATE:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
