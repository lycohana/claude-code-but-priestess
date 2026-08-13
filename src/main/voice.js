// ============================================================
//  Voice session — the state machine that ties the mic, the
//  sherpa-onnx KWS wake-word spotter, FunASR (llama.cpp GGUF)
//  transcription, the existing chat engine, and MiniMax TTS.
//
//  States: off → preparing → idle → listening → active
//    idle      KWS listens for "普瑞赛斯" (or a mic button press).
//    listening accumulates the utterance into a PCM buffer; silence
//              ends it, then FunASR transcribes the WHOLE buffer.
//    active    a turn is running / she is speaking; energy-based VAD
//              arms barge-in — if the Doctor talks, she stops and listens.
//
//  Audio arrives as Int16 16kHz mono chunks over IPC.
// ============================================================
"use strict";

const chat = require("./chat");
const settings = require("./settings");
const voiceModels = require("./voice-models");
const voiceEngine = require("./voice-engine");
const funasr = require("./funasr");

const SAMPLE_RATE = 16000;
const END_OF_SPEECH_SILENCE_MS = 2500; // silence that ends an utterance (more forgiving)
const MIN_UTTERANCE_MS = 300;          // ignore tiny blips
const MAX_UTTERANCE_MS = 30 * 1000;    // hard cap on one spoken command
const WARMUP_GRACE_MS = 500;           // after wake/PTT, ignore audio this long so the
                                       // wake word's own trailing audio can't "re-wake"
const BARGE_IN_TAIL_MS = 15 * 1000;
const BARGE_IN_GRACE_MS = 700;
const VAD_ENERGY_THRESHOLD = 0.01;     // RMS threshold to count a chunk as speech

let enabled = false;
let state = "off";

let wakeSpotter = null;

// utterance buffer (only filled while listening)
let utteranceChunks = []; // Float32Array per chunk
let utteranceSamples = 0;
let lastSpeechAt = 0;
let utteranceStartedAt = 0;
let activeSinceAt = 0;
let listeningSinceAt = 0; // when we entered listening (for the warmup grace)

let chatUnsub = null;
let activeTailTimer = null;
let warmupTimer = null;

let onState = null;
let onBargeIn = null;

function setState(next, extra = {}) {
  state = next;
  if (typeof onState === "function") {
    try {
      onState({ state: next, ...extra });
    } catch (error) {
      console.warn("voice: onState threw", error);
    }
  }
}

function toFloat32(int16) {
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i += 1) f32[i] = int16[i] / 32768.0;
  return f32;
}

// Energy (RMS) of a chunk — a cheap, dependency-free voice-activity signal.
function rms(f32) {
  if (!f32.length) return 0;
  let sum = 0;
  for (let i = 0; i < f32.length; i += 1) sum += f32[i] * f32[i];
  return Math.sqrt(sum / f32.length);
}

function wakeEnabled() {
  return settings.get("voiceWakeEnabled") !== false;
}

function bargeInEnabled() {
  return settings.get("voiceBargeIn") !== false;
}

function clearActiveTail() {
  if (activeTailTimer) {
    clearTimeout(activeTailTimer);
    activeTailTimer = null;
  }
}

function scheduleActiveTail() {
  clearActiveTail();
  activeTailTimer = setTimeout(() => {
    activeTailTimer = null;
    if (state === "active") setState("idle");
  }, BARGE_IN_TAIL_MS);
}

function sendToChat(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    setState(enabled ? "idle" : "off");
    return;
  }
  clearActiveTail();
  chat.send(trimmed, []);
  activeSinceAt = Date.now();
  setState("active");
}

function startListening() {
  if (!enabled) {
    setState("off");
    return;
  }
  utteranceChunks = [];
  utteranceSamples = 0;
  lastSpeechAt = 0;
  utteranceStartedAt = 0; // reset — will be set on first real speech
  listeningSinceAt = Date.now();
  setState("listening", { transcript: "" });
}

function handleWake(keyword) {
  if (!enabled || state === "listening") return;
  console.log("voice: wake word detected:", keyword || "(unknown)");
  // Drop the wake word's own trailing audio: briefly ignore incoming chunks
  // so "普瑞赛斯" itself never lands in the utterance, and so its echo can't
  // re-trigger anything.
  startListening();
}

// Flatten the accumulated chunks into one Float32Array.
function flattenUtterance() {
  const out = new Float32Array(utteranceSamples);
  let offset = 0;
  for (const chunk of utteranceChunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  utteranceChunks = [];
  utteranceSamples = 0;
  return out;
}

async function finalizeUtterance() {
  if (utteranceSamples === 0) {
    setState(enabled ? "idle" : "off");
    return;
  }
  const pcm = flattenUtterance();
  const durationSec = pcm.length / SAMPLE_RATE;
  console.log(`voice: finalizing utterance, ${durationSec.toFixed(2)}s of audio`);
  setState("thinking", { transcript: "" });
  try {
    const text = await funasr.transcribe(pcm);
    sendToChat(text);
  } catch (error) {
    console.warn("voice: funasr transcription failed", error);
    setState("idle", { error: String(error?.message || error) });
  }
}

function feedListening(f32) {
  const now = Date.now();

  // Warmup grace: ignore the wake word's trailing audio (and any echo) for the
  // first WARMUP_GRACE_MS after entering listening. Only START recording once
  // we actually hear voice.
  if (now - listeningSinceAt < WARMUP_GRACE_MS) {
    return;
  }

  const energy = rms(f32);
  if (energy >= VAD_ENERGY_THRESHOLD) {
    lastSpeechAt = now;
    if (utteranceStartedAt === 0) {
      utteranceStartedAt = now; // first real speech starts the utterance clock
    }
  }

  // Only accumulate once the user has actually started speaking (avoid storing
  // the leading silence, which wastes time and confuses Paraformer).
  if (utteranceStartedAt === 0) {
    // Not speaking yet — ignore completely.
    return;
  }

  utteranceChunks.push(f32);
  utteranceSamples += f32.length;

  const speakingMs = now - utteranceStartedAt;
  const silenceMs = lastSpeechAt > 0 ? now - lastSpeechAt : 0;

  if (silenceMs > END_OF_SPEECH_SILENCE_MS && speakingMs > MIN_UTTERANCE_MS) {
    void finalizeUtterance();
    return;
  }
  if (speakingMs > MAX_UTTERANCE_MS) {
    void finalizeUtterance();
  }
}

function handleAudio(int16) {
  if (!enabled || state === "off" || state === "preparing") return;
  if (!int16 || int16.length === 0) return;

  const f32 = toFloat32(int16);

  if (state === "idle") {
    if (wakeSpotter && wakeEnabled()) wakeSpotter.acceptWaveform(f32);
    return;
  }

  if (state === "listening") {
    feedListening(f32);
    return;
  }

  if (state === "active") {
    if (!bargeInEnabled()) return;
    if (Date.now() - activeSinceAt < BARGE_IN_GRACE_MS) return;
    if (rms(f32) >= VAD_ENERGY_THRESHOLD) {
      if (typeof onBargeIn === "function") {
        try { onBargeIn(); } catch { /* ignore */ }
      }
      startListening();
      feedListening(f32);
    }
  }
}

function pushToTalk() {
  if (!enabled) return;
  if (state === "active" && typeof onBargeIn === "function") {
    try { onBargeIn(); } catch { /* ignore */ }
  }
  startListening();
}

function cancelListening() {
  if (state !== "listening") return;
  utteranceChunks = [];
  utteranceSamples = 0;
  setState(enabled ? "idle" : "off");
}

function disposeEngines() {
  clearActiveTail();
  if (wakeSpotter) {
    wakeSpotter.free();
    wakeSpotter = null;
  }
}

async function enable() {
  if (enabled) return;
  enabled = true;
  setState("preparing");

  // Download order: KWS (small) then FunASR binary + models.
  const progress = { kws: 0, bin: 0, asr: 0, vad: 0 };
  const onProgressFor = (key) => (received, total) => {
    progress[key] = total > 0 ? received / total : 0;
    const avg = (progress.kws + progress.bin + progress.asr + progress.vad) / 4;
    setState("preparing", { progress: Math.round(avg * 100) });
  };

  try {
    await voiceModels.ensureModel("kws", onProgressFor("kws"));
    await voiceModels.ensureModel("funasrBinary", onProgressFor("bin"));
    await voiceModels.ensureModel("funasrParaformer", onProgressFor("asr"));
    await voiceModels.ensureModel("funasrVad", onProgressFor("vad"));
  } catch (error) {
    console.warn("voice: model setup failed", error);
    enabled = false;
    setState("off", { error: String(error?.message || error) });
    return;
  }

  try {
    const kwsDir = voiceModels.modelDir("kws");
    wakeSpotter = voiceEngine.createWakeSpotter({
      modelDir: kwsDir,
      keywords: voiceEngine.buildKeywords(settings.get("voiceWakeWords"), kwsDir),
      threshold: Number(settings.get("voiceKwsThreshold")) || 0.08,
      onWake: handleWake
    });
  } catch (error) {
    console.warn("voice: engine init failed", error);
    disposeEngines();
    enabled = false;
    setState("off", { error: String(error?.message || error) });
    return;
  }

  setState("idle");
}

function disable() {
  if (!enabled && state === "off") return;
  enabled = false;
  disposeEngines();
  setState("off");
}

function reportError(message) {
  enabled = false;
  disposeEngines();
  setState("off", { error: String(message || "麦克风不可用") });
}

function setEnabled(next) {
  if (next) {
    void enable();
  } else {
    disable();
  }
}

function isEnabled() {
  return enabled;
}

function getState() {
  return state;
}

function init(callbacks = {}) {
  onState = callbacks.onState || null;
  onBargeIn = callbacks.onBargeIn || null;

  if (!chatUnsub) {
    chatUnsub = chat.subscribe((event) => {
      if (event.kind !== "status") return;
      if (event.status === "running") {
        clearActiveTail();
        if (state === "idle") setState("active");
      } else if (event.status === "idle") {
        if (state === "active") scheduleActiveTail();
      }
    });
  }
}

function dispose() {
  disable();
  if (chatUnsub) {
    chatUnsub();
    chatUnsub = null;
  }
  onState = null;
  onBargeIn = null;
}

module.exports = {
  init,
  setEnabled,
  isEnabled,
  getState,
  handleAudio,
  pushToTalk,
  cancelListening,
  reportError,
  dispose
};
