// ============================================================
//  FunASR GGUF bridge — runs Alibaba's official Paraformer ASR
//  via the llama.cpp single-binary runtime (no Python, no GPU).
//
//  The binary is `llama-funasr-paraformer.exe`; it reads a wav
//  file, runs Paraformer (+ optional FSMN-VAD), and prints the
//  transcription to stdout. We spawn it per utterance, feed it a
//  WAV we write from the captured PCM, and read the result line.
// ============================================================
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const voiceModels = require("./voice-models");

// Transcribe a mono float32 PCM buffer (16kHz) to text.
// Returns a Promise<string>. Throws on binary/model errors.
function transcribe(pcmFloat32, { sampleRate = 16000 } = {}) {
  return new Promise((resolve, reject) => {
    const binary = funasrBinaryPath();
    const model = path.join(voiceModels.modelDir("funasrParaformer"), "paraformer-q8.gguf");
    if (!fs.existsSync(binary)) return reject(new Error("FunASR binary not found"));
    if (!fs.existsSync(model)) return reject(new Error("paraformer-q8.gguf not found"));

    const wav = writeWavTemp(pcmFloat32, sampleRate);
    // NOTE: no --vad flag — voice.js already segments the utterance with its
    // own energy-based VAD, and feeding a short utterance through FSMN-VAD too
    // often yields "0 vad segments" (double-gating). Hand the whole utterance
    // straight to Paraformer.
    const args = ["-m", model, "-a", wav];

    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });

    child.on("error", (error) => {
      cleanup(wav);
      reject(error);
    });
    child.on("close", (code) => {
      cleanup(wav);
      // The binary prints diagnostics to stderr; the transcription is on stdout.
      const text = stdout.split("\n").map((l) => l.trim()).filter(Boolean).join("");
      if (code === 0 && text) {
        resolve(text);
      } else {
        reject(new Error(`FunASR exited ${code}: ${(stderr || stdout).slice(0, 300)}`));
      }
    });
  });
}

function funasrBinaryPath() {
  return path.join(voiceModels.modelDir("funasrBinary"), "llama-funasr-paraformer.exe");
}

// Write PCM float32 to a temp 16-bit mono WAV, return its path.
function writeWavTemp(pcmFloat32, sampleRate) {
  const samples = pcmFloat32.length;
  const buf = Buffer.alloc(44 + samples * 2);
  // RIFF header
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);          // fmt chunk size
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // mono
  buf.writeUInt32LE(sampleRate, 24);  // sample rate
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    let s = pcmFloat32[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
  }
  const file = path.join(os.tmpdir(), `prts-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  fs.writeFileSync(file, buf);
  return file;
}

function cleanup(file) {
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

module.exports = { transcribe, funasrBinaryPath };
