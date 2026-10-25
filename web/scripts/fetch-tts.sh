#!/usr/bin/env bash
# Restores the on-box voice binary and models. They are ~175 MB together, so
# they stay out of git (the small lexicon/tokens/fst/t2s files ARE committed).
#
# Run once before the first Android build:
#   web/scripts/fetch-tts.sh
#
# What it puts where:
#   android/app/libs/sherpa-onnx-2.0.0.aar      the inference runtime (all ABIs)
#   android/app/src/main/assets/tts/yue/model.onnx   Cantonese VITS, 22.05 kHz
#   android/app/src/main/assets/tts/cmn/model.onnx   Mandarin VITS, 22.05 kHz
#
# Both are Apache-2.0 / CC-licensed open models published by k2-fsa. Synthesis
# runs entirely on the handset; no text is ever sent to a cloud voice.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
android="$here/../android"
libs="$android/app/libs"
assets="$android/app/src/main/assets/tts"
tmp="${TMPDIR:-/tmp}/aura-tts"

mkdir -p "$libs" "$assets/yue" "$assets/cmn" "$tmp"

fetch() { # url dest
  if [ -s "$2" ]; then
    echo "have  $2"
  else
    echo "fetch $1"
    curl -fL --retry 3 -o "$2.part" "$1"
    mv "$2.part" "$2"
  fi
}

fetch "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.0/sherpa-onnx-2.0.0.aar" \
      "$libs/sherpa-onnx-2.0.0.aar"

# --- Cantonese (the primary voice for HK/Macau) ----------------------------
yue_tar="$tmp/vits-cantonese.tar.bz2"
fetch "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-cantonese-hf-xiaomaiiwn.tar.bz2" \
      "$yue_tar"
if [ ! -s "$assets/yue/model.onnx" ]; then
  tar -xjf "$yue_tar" -C "$tmp"
  cp "$tmp/vits-cantonese-hf-xiaomaiiwn/vits-cantonese-hf-xiaomaiiwn.onnx" "$assets/yue/model.onnx"
fi

# --- Mandarin --------------------------------------------------------------
cmn_tar="$tmp/vits-xiao-ya.tar.bz2"
fetch "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-xiao_ya-medium-int8.tar.bz2" \
      "$cmn_tar"
if [ ! -s "$assets/cmn/model.onnx" ]; then
  tar -xjf "$cmn_tar" -C "$tmp"
  cp "$tmp/vits-piper-zh_CN-xiao_ya-medium-int8/zh_CN-xiao_ya-medium.onnx" "$assets/cmn/model.onnx"
fi

echo
echo "voice assets ready:"
du -h "$libs/sherpa-onnx-2.0.0.aar" "$assets/yue/model.onnx" "$assets/cmn/model.onnx"
