// ============================================================
//  Voice engine — thin wrappers over sherpa-onnx (WASM, main
//  process) for the three speech primitives the voice feature
//  needs: KWS wake-word spotting, silero VAD, and streaming ASR.
//
//  sherpa-onnx is lazily required: its ~15MB WASM module and
//  model files are only touched when voice is actually used.
// ============================================================
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pinyin } = require("pinyin-pro");

let sherpa = null;
function getSherpa() {
  if (!sherpa) sherpa = require("sherpa-onnx");
  return sherpa;
}

// ---------------------------------------------------------------------------
//  Wake-word encoding — the bilingual KWS model's modelling unit is pinyin
//  (initial + final) for Chinese and ARPAbet phones for English.
//    "普瑞赛斯" → "p ǔ r uì s ài s ī @普瑞赛斯"
//    "priestess" → "P R IY1 S T AH0 S @priestess" (via en.phone lexicon)
//    "prts" → "P IY1 AA1 R T IY1 EH1 S @prts" (letter-by-letter acronym)
// ---------------------------------------------------------------------------
const PINYIN_INITIALS = [
  "zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l",
  "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"
];

// Standard CMUdict letter pronunciations, used to spell out acronyms.
const LETTER_ARPABET = {
  A: "EY1", B: "B IY1", C: "S IY1", D: "D IY1", E: "IY1",
  F: "EH1 F", G: "JH IY1", H: "EY1 CH", I: "AY1", J: "JH EY1",
  K: "K EY1", L: "EH1 L", M: "EH1 M", N: "EH1 N", O: "OW1",
  P: "P IY1", Q: "K Y UW1", R: "AA1 R", S: "EH1 S", T: "T IY1",
  U: "Y UW1", V: "V IY1", W: "D AH1 B AH0 L Y UW0", X: "EH1 K S",
  Y: "W AY1", Z: "Z IY1"
};

const CJK_RE = /[\u3400-\u9fff]/;

// English word → ARPAbet, loaded lazily from the model's en.phone lexicon.
let enPhoneLexicon = null;
let enPhoneModelDir = null;

function loadEnPhoneLexicon(modelDir) {
  if (enPhoneLexicon && enPhoneModelDir === modelDir) return enPhoneLexicon;
  const map = new Map();
  try {
    const raw = fs.readFileSync(path.join(modelDir, "en.phone"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(" ");
      if (idx <= 0) continue;
      map.set(trimmed.slice(0, idx), trimmed.slice(idx + 1).trim());
    }
  } catch {
    /* lexicon missing — acronym fallback still works */
  }
  enPhoneLexicon = map;
  enPhoneModelDir = modelDir;
  return map;
}

function splitSyllable(syllable) {
  for (const initial of PINYIN_INITIALS) {
    if (syllable.startsWith(initial)) {
      return [initial, syllable.slice(initial.length)];
    }
  }
  return ["", syllable];
}

function encodeChineseWakeWord(word) {
  const syllables = pinyin(word, { toneType: "symbol", type: "array" });
  const parts = [];
  for (const syllable of syllables) {
    const [initial, final] = splitSyllable(syllable);
    if (initial) parts.push(initial);
    if (final) parts.push(final);
  }
  return `${parts.join(" ")} @${word}`;
}

// Tone-less variant: strips the tone marks so a fast/slurred reading
// ("普瑞赛斯" said quickly) still matches. Returns null if identical.
function encodeChineseWakeWordNoTone(word) {
  const syllables = pinyin(word, { toneType: "none", type: "array" });
  const parts = [];
  for (const syllable of syllables) {
    const [initial, final] = splitSyllable(syllable);
    if (initial) parts.push(initial);
    if (final) parts.push(final);
  }
  return `${parts.join(" ")} @${word}`;
}

function encodeEnglishWakeWord(word, modelDir) {
  const lexicon = loadEnPhoneLexicon(modelDir);
  const upper = word.toUpperCase();
  if (lexicon.has(upper)) {
    return `${lexicon.get(upper)} @${word}`;
  }
  // Acronym fallback: spell it letter by letter ("prts" → P R T S).
  const letters = upper.replace(/[^A-Z]/g, "");
  if (!letters) return null;
  const parts = [];
  for (const ch of letters) {
    const phone = LETTER_ARPABET[ch];
    if (!phone) return null;
    parts.push(phone);
  }
  return `${parts.join(" ")} @${word}`;
}

function encodeWakeWord(word, modelDir) {
  return CJK_RE.test(word)
    ? encodeChineseWakeWord(word)
    : encodeEnglishWakeWord(word, modelDir);
}

// Build the KWS keyword lines. For Chinese words we emit BOTH the tone-marked
// and tone-less variants, so a slow careful reading and a fast slurred reading
// (both common for 普瑞赛斯) each get a chance to match. English words keep a
// single ARPAbet/acronym line.
function buildKeywords(words, modelDir) {
  const lines = [];
  for (const raw of (Array.isArray(words) ? words : [])) {
    const w = String(raw || "").trim();
    if (!w) continue;
    if (CJK_RE.test(w)) {
      lines.push(encodeChineseWakeWord(w));
      const noTone = encodeChineseWakeWordNoTone(w);
      if (noTone !== encodeChineseWakeWord(w)) lines.push(noTone);
    } else {
      const en = encodeEnglishWakeWord(w, modelDir);
      if (en) lines.push(en);
    }
  }
  return Array.from(new Set(lines)).join("\n");
}

// ---------------------------------------------------------------------------
//  Wake-word spotter (KWS) — always-on, ultra-light (3.3M int8). This is the
//  ONLY sherpa-onnx piece left: FunASR (llama.cpp GGUF) now handles the actual
//  transcription, and energy-based VAD lives in voice.js.
// ---------------------------------------------------------------------------
function createWakeSpotter({ modelDir, keywords, threshold = 0.25, onWake }) {
  const s = getSherpa();
  const kws = s.createKws({
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx"),
        decoder: path.join(modelDir, "decoder-epoch-13-avg-2-chunk-16-left-64.onnx"),
        joiner: path.join(modelDir, "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx")
      },
      tokens: path.join(modelDir, "tokens.txt")
    },
    // A custom wake word (普瑞赛斯) was never in the training set, so it needs a
    // generous threshold and a strong keyword-score bonus to trigger reliably.
    keywordsThreshold: threshold,
    keywordsScore: 2.0,
    numTrailingBlanks: 1,
    maxActivePaths: 4,
    keywords
  });

  const stream = kws.createStream();
  const sampleRate = kws.config.featConfig.sampleRate;

  return {
    sampleRate,
    acceptWaveform(samples) {
      stream.acceptWaveform(sampleRate, samples);
      while (kws.isReady(stream)) {
        kws.decode(stream);
        const keyword = kws.getResult(stream).keyword;
        if (keyword !== "") {
          if (typeof onWake === "function") onWake(keyword);
          kws.reset(stream);
        }
      }
    },
    free() {
      try {
        stream.free();
        kws.free();
      } catch {
        /* ignore */
      }
    }
  };
}

module.exports = {
  buildKeywords,
  encodeWakeWord,
  createWakeSpotter,
  getSherpa
};
