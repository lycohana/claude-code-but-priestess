// ============================================================
//  Voice models — resolve, download, and verify the local
//  sherpa-onnx artifacts (KWS wake-word spotter, silero VAD,
//  streaming ASR) that the voice feature needs.
//
//  Models live under userData/voice-models and are downloaded
//  on first use (GitHub releases), then cached. Nothing here is
//  committed to the repo or shipped in the installer.
// ============================================================
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, net } = require("electron");

// Relative archive member paths we actually need. For the paraformer tarball
// (which ships a ~950MB fp32 encoder alongside the int8 one) this keeps the
// on-disk footprint at the int8 size instead of unpacking the whole thing.
const MODELS = {
  // KWS wake-word spotter (sherpa-onnx WASM, keeps listening for 普瑞赛斯/prts).
  // Small enough to stay bundled; it's the ONLY sherpa artifact we still use.
  kws: {
    // Bilingual (Chinese pinyin + English ARPAbet) wake-word spotter — one tiny
    // model spots both 普瑞赛斯 and prts/priestess. The decoder ships fp32-only,
    // so we mix int8 encoder/joiner with the fp32 decoder.
    // (33MB, GitHub only — no ModelScope mirror for this variant yet.)
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2",
    archive: "kws.tar.bz2",
    outDir: "kws",
    root: "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20",
    members: [
      "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
      "decoder-epoch-13-avg-2-chunk-16-left-64.onnx",
      "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
      "tokens.txt",
      "en.phone"
    ],
    files: [
      "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
      "decoder-epoch-13-avg-2-chunk-16-left-64.onnx",
      "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
      "tokens.txt",
      "en.phone"
    ]
  },
  // FunASR ASR — Alibaba's official Paraformer via the llama.cpp GGUF runtime.
  // A single self-contained binary + one GGUF file; no Python, no GPU.
  funasrBinary: {
    url: "https://github.com/modelscope/FunASR/releases/download/runtime-llamacpp-v0.1.9/funasr-llamacpp-windows-x64.zip",
    archive: "funasr-bin.zip",
    outDir: "funasr",
    root: "",
    // The relevant exe inside the zip (others are for embd/encoder/CLI tools).
    zipMember: "llama-funasr-paraformer.exe",
    files: ["llama-funasr-paraformer.exe"]
  },
  funasrParaformer: {
    url: "https://hf-mirror.com/FunAudioLLM/Paraformer-GGUF/resolve/main/paraformer-q8.gguf",
    modelscopeUrl: "https://www.modelscope.cn/api/v1/models/FunAudioLLM/Paraformer-GGUF/repo?Revision=master&FilePath=paraformer-q8.gguf",
    archive: null,
    outDir: "funasr",
    root: "",
    files: ["paraformer-q8.gguf"]
  },
  funasrVad: {
    url: "https://hf-mirror.com/FunAudioLLM/fsmn-vad-GGUF/resolve/main/fsmn-vad.gguf",
    modelscopeUrl: "https://www.modelscope.cn/api/v1/models/FunAudioLLM/fsmn-vad-GGUF/repo?Revision=master&FilePath=fsmn-vad.gguf",
    archive: null,
    outDir: "funasr",
    root: "",
    files: ["fsmn-vad.gguf"]
  }
};

function modelRoot() {
  return path.join(app.getPath("userData"), "voice-models");
}

// Absolute dir that holds a model's files (or the file itself, for vad).
function modelDir(key) {
  const spec = MODELS[key];
  if (!spec) return null;
  return path.join(modelRoot(), spec.outDir, spec.root || "");
}

function requiredFiles(key) {
  const spec = MODELS[key];
  if (!spec) return [];
  const base = modelDir(key);
  return spec.files.map((f) => path.join(base, f));
}

function isReady(key) {
  return requiredFiles(key).every((f) => fs.existsSync(f));
}

function archivePath(key) {
  return path.join(modelRoot(), MODELS[key].archive);
}

// ---- Download: mirror-first, with fallback --------------------------------
//
// GitHub hosts these files but is slow in China (~130KB/s). ModelScope (Alibaba)
// mirrors them (~1.7MB/s+). We try each URL in order until one succeeds, so a
// mirror outage degrades gracefully back to the slower source.

function mirrorUrls(spec) {
  const urls = [];
  // modelscopeUrl is a COMPLETE, ready-to-download URL (fast, Alibaba mirror).
  if (spec.modelscopeUrl) urls.push(spec.modelscopeUrl);
  // url is the canonical (slower) GitHub/HF source, used as fallback.
  if (spec.url) urls.push(spec.url);
  // Dedupe, keep the mirror first.
  return Array.from(new Set(urls.filter(Boolean)));
}

// Streaming download via Electron net.fetch, trying each candidate URL in turn.
async function downloadAny(urls, dest, onProgress) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  let lastError = null;
  for (const url of urls) {
    try {
      await downloadUrl(url, dest, onProgress);
      return;
    } catch (error) {
      lastError = error;
      console.warn("voice-models: download failed, trying next mirror:", url, error.message);
    }
  }
  throw lastError || new Error("download failed (no URLs)");
}

async function downloadUrl(url, dest, onProgress) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length") || 0);
  const reader = res.body.getReader();
  const tmp = dest + ".tmp";
  const out = fs.createWriteStream(tmp);
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      const ok = out.write(Buffer.from(value));
      if (!ok) await new Promise((resolve) => out.once("drain", resolve));
      if (typeof onProgress === "function") onProgress(received, total);
    }
  } finally {
    out.end();
  }
  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });
  fs.renameSync(tmp, dest);
}

// Extract one member from a .zip (for the funasr binary) using PowerShell's
// Expand-Archive, which is always present on Windows.
function extractZipMember(archive, destDir, member) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    // Expand the whole zip then move the one file — Expand-Archive can't do a
    // single-member extract, and the zip is tiny (4.5MB).
    const tmpDir = destDir + ".tmp-extract";
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const child = spawn("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -Path '${archive}' -DestinationPath '${tmpDir}' -Force`
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Expand-Archive exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      // Move the member (flatten) then clean the temp dir.
      try {
        const found = findFile(tmpDir, member);
        if (!found) {
          reject(new Error(`zip member "${member}" not found`));
          return;
        }
        fs.copyFileSync(found, path.join(destDir, member));
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, name);
      if (nested) return nested;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

// Extract only the members we need from a .tar.bz2 using the OS `tar`
// (bsdtar ships with Windows 10+ and is always present on macOS/Linux).
function extractTarBz2(archive, destDir, root, members) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const args = ["-xf", archive, "-C", destDir];
    for (const m of members) args.push(`${root}/${m}`);
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

// Ensure a model is present, downloading + extracting on first use.
// Returns { ready: true } once done, or throws on failure.
async function ensureModel(key, onProgress) {
  if (isReady(key)) return { ready: true };
  const spec = MODELS[key];

  // Plain file (GGUF models, vad) — download directly, mirror-first.
  if (!spec.archive && !spec.zipMember) {
    const dest = path.join(modelRoot(), spec.outDir, spec.root, spec.files[0]);
    await downloadAny(mirrorUrls(spec), dest, onProgress);
    return { ready: true };
  }

  // Zip with a single member (funasr binary).
  if (spec.zipMember) {
    const archive = path.join(modelRoot(), spec.outDir, "funasr-bin.zip");
    if (!fs.existsSync(archive) || fs.statSync(archive).size < 1024) {
      await downloadAny([spec.url], archive, onProgress);
    }
    const destDir = path.join(modelRoot(), spec.outDir, spec.root);
    try {
      fs.rmSync(path.join(destDir, spec.zipMember), { force: true });
    } catch { /* ignore */ }
    await extractZipMember(archive, destDir, spec.zipMember);
    try { fs.unlinkSync(archive); } catch { /* ignore */ }
    if (!isReady(key)) throw new Error(`model "${key}" extraction incomplete`);
    return { ready: true };
  }

  // tar.bz2 (the KWS model).
  const archive = archivePath(key);
  if (!fs.existsSync(archive) || fs.statSync(archive).size < 1024) {
    await downloadAny(mirrorUrls(spec), archive, onProgress);
  }
  try {
    fs.rmSync(modelDir(key), { recursive: true, force: true });
  } catch { /* ignore */ }
  await extractTarBz2(archive, path.join(modelRoot(), spec.outDir), spec.root, spec.members);
  if (!isReady(key)) {
    throw new Error(`model "${key}" extraction incomplete`);
  }
  try { fs.unlinkSync(archive); } catch { /* ignore */ }
  return { ready: true };
}

module.exports = {
  MODELS,
  modelRoot,
  modelDir,
  isReady,
  ensureModel
};
