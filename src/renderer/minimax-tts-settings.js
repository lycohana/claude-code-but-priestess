// Settings page for MiniMax TTS.  Everything here is local: the config
// round-trips to settings.json via IPC and nowhere else.

const enabledEl = document.getElementById("enabled");
const apiKeyEl = document.getElementById("apiKey");
const voiceIdEl = document.getElementById("voiceId");
const modelEl = document.getElementById("model");
const speedEl = document.getElementById("speed");
const speedVal = document.getElementById("speedVal");
const volEl = document.getElementById("vol");
const volVal = document.getElementById("volVal");
const pitchEl = document.getElementById("pitch");
const pitchVal = document.getElementById("pitchVal");
const formatEl = document.getElementById("format");
const sampleRateEl = document.getElementById("sampleRate");
const saveBtn = document.getElementById("saveBtn");
const cancelBtn = document.getElementById("cancelBtn");
const toggleKeyBtn = document.getElementById("toggleKey");
const testBtn = document.getElementById("testBtn");
const statusEl = document.getElementById("status");

// --- Pronunciation dictionary editor ----------------------------------
// Each rule is { text, pronunciation }. Rendered as a list of rows with a
// delete button; the two inputs above the list add a new rule.
const pronListEl = document.getElementById("pronList");
const pronTextEl = document.getElementById("pronText");
const pronSpeakEl = document.getElementById("pronSpeak");
const pronAddBtn = document.getElementById("pronAddBtn");
let pronRules = [];

function renderPronList() {
  pronListEl.replaceChildren(
    ...pronRules.map((rule, index) => {
      const row = document.createElement("div");
      row.className = "pron-item";

      const from = document.createElement("code");
      from.className = "pron-from";
      from.textContent = rule.text;

      const arrow = document.createElement("span");
      arrow.textContent = "→";
      arrow.style.color = "var(--fg-dim)";

      const to = document.createElement("code");
      to.className = "pron-to";
      to.textContent = rule.pronunciation || "（原样）";

      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "删除";
      del.addEventListener("click", () => {
        pronRules.splice(index, 1);
        renderPronList();
      });

      row.append(from, arrow, to, del);
      return row;
    })
  );
}

function addPronRule() {
  const text = pronTextEl.value.trim();
  const pronunciation = pronSpeakEl.value.trim();
  if (!text) {
    pronTextEl.focus();
    return;
  }
  pronRules.push({ text, pronunciation });
  pronTextEl.value = "";
  pronSpeakEl.value = "";
  renderPronList();
  pronTextEl.focus();
}

pronAddBtn.addEventListener("click", addPronRule);
pronSpeakEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addPronRule();
  }
});

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = kind || "";
}

// --- Test-button audio playback ----------------------------------------
// Non-streaming: the main process delivers one COMPLETE audio buffer
// (isFinal). Play it as a single blob; no queue needed.
const testAudioEl = new Audio();

let testPcmCtx = null;
function testPcmContext(sampleRate) {
  if (!testPcmCtx || testPcmCtx.sampleRate !== sampleRate) {
    try { testPcmCtx = new AudioContext({ sampleRate }); }
    catch { testPcmCtx = null; }
  }
  return testPcmCtx;
}

window.minimaxTtsApi?.onAudio?.((payload) => {
  if (!payload || !payload.buffer) return;
  const fmt = payload.format || "mp3";
  const bytes = Uint8Array.from(atob(payload.buffer), (c) => c.charCodeAt(0));

  if (fmt === "pcm") {
    // Raw PCM — play through an AudioContext (no container header).
    const ctx = testPcmContext(Number(payload.sampleRate) || 32000);
    if (!ctx) return;
    const sampleCount = bytes.length >> 1;
    if (sampleCount === 0) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      float32[i] = view.getInt16(i * 2, true) / 32768;
    }
    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    buffer.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
    return;
  }

  const mime =
    fmt === "wav" ? "audio/wav" :
    fmt === "flac" ? "audio/flac" :
    fmt === "opus" ? "audio/ogg" : "audio/mpeg";
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  try { testAudioEl.pause(); } catch (_) { /* ignore */ }
  if (testAudioEl.dataset.url) URL.revokeObjectURL(testAudioEl.dataset.url);
  testAudioEl.dataset.url = url;
  testAudioEl.src = url;
  testAudioEl
    .play()
    .catch((err) => setStatus(`播放失败：${err?.message || err}`, "err"));
});

testBtn.addEventListener("click", async () => {
  if (!apiKeyEl.value.trim()) {
    setStatus("请先填写 API Key", "err");
    return;
  }
  testBtn.disabled = true;
  setStatus("正在合成…", "busy");
  try {
    const result = await window.minimaxTtsApi.test({
      text: "博士，普瑞赛斯语音合成已就绪。",
      overrides: {
        apiKey: apiKeyEl.value,
        voiceId: voiceIdEl.value,
        model: modelEl.value,
        speed: Number(speedEl.value),
        vol: Number(volEl.value),
        pitch: Number(pitchEl.value),
        format: formatEl.value,
        sampleRate: Number(sampleRateEl.value),
        pronunciationDict: pronRules,
      },
    });
    if (result?.ok) {
      setStatus("合成成功，正在播放…", "ok");
    } else {
      setStatus(`合成失败：${result?.reason || "未知错误"}`, "err");
    }
  } catch (error) {
    setStatus(`测试出错：${error?.message || error}`, "err");
  } finally {
    testBtn.disabled = false;
  }
});

// Range sliders — show the current value.
speedEl.addEventListener("input", () => {
  speedVal.textContent = Number(speedEl.value).toFixed(1);
});
volEl.addEventListener("input", () => {
  volVal.textContent = Number(volEl.value).toFixed(1);
});
pitchEl.addEventListener("input", () => {
  pitchVal.textContent = pitchEl.value;
});

window.minimaxTtsApi
  .getConfig()
  .then((cfg) => {
    enabledEl.checked = Boolean(cfg.enabled);
    apiKeyEl.value = cfg.apiKey || "";
    voiceIdEl.value = cfg.voiceId || "";
    modelEl.value = cfg.model || "speech-2.8-hd";
    speedEl.value = Number(cfg.speed) || 1.0;
    speedVal.textContent = Number(speedEl.value).toFixed(1);
    volEl.value = Number(cfg.vol) || 1.0;
    volVal.textContent = Number(volEl.value).toFixed(1);
    pitchEl.value = Math.round(Number(cfg.pitch)) || 0;
    pitchVal.textContent = pitchEl.value;
    formatEl.value = cfg.format || "mp3";
    sampleRateEl.value = String(cfg.sampleRate) || "32000";
    pronRules = Array.isArray(cfg.pronunciationDict) ? cfg.pronunciationDict : [];
    renderPronList();
  })
  .catch(() => console.warn("minimax-tts-settings: failed to load config"));

toggleKeyBtn.addEventListener("click", () => {
  apiKeyEl.type = apiKeyEl.type === "password" ? "text" : "password";
});

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  try {
    await window.minimaxTtsApi.setConfig({
      enabled: enabledEl.checked,
      apiKey: apiKeyEl.value,
      voiceId: voiceIdEl.value,
      model: modelEl.value,
      speed: Number(speedEl.value),
      vol: Number(volEl.value),
      pitch: Number(pitchEl.value),
      format: formatEl.value,
      sampleRate: Number(sampleRateEl.value),
      pronunciationDict: pronRules,
    });
    setTimeout(() => window.minimaxTtsApi.closeSettings(), 200);
  } catch (error) {
    console.warn("minimax-tts-settings: save failed", error);
    saveBtn.disabled = false;
  }
});

cancelBtn.addEventListener("click", () => window.minimaxTtsApi.closeSettings());