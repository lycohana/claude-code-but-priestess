// ============================================================
//  Voice UI (popover) — status line + mic button. NO capture here:
//  the microphone lives in the dedicated hidden window (mic.js),
//  which keeps capturing even while the popover is collapsed.
// ============================================================
(function () {
  "use strict";

  const voiceApi = window.voiceApi;
  const petApi = window.petApi;
  const micBtn = document.getElementById("micBtn");
  const voiceStatus = document.getElementById("voiceStatus");
  if (!voiceApi || !micBtn) return;

  let currentState = "off";
  let voiceEnabled = false;
  let ttsEnabled = false;
  // 暂时禁用语音：右键切换。只是不再接收新的语音输入（图标变红），
  // 不关闭语音引擎（模型加载慢，避免反复下载/初始化）。
  let voiceMuted = false;

  function showStatus(text) {
    if (!voiceStatus) return;
    if (text) {
      voiceStatus.textContent = text;
      voiceStatus.hidden = false;
    } else {
      voiceStatus.textContent = "";
      voiceStatus.hidden = true;
    }
  }

  function renderMuteState() {
    micBtn.classList.toggle("muted", voiceMuted);
    micBtn.title = voiceMuted
      ? "语音已暂时禁用（右键恢复）"
      : voiceEnabled
        ? "点击说话 · 右键暂时禁用语音"
        : "语音对话（需先开启）· 右键暂时禁用";
    if (voiceMuted) {
      micBtn.classList.remove("listening", "thinking", "active", "mic-live");
      showStatus("语音已暂时禁用（右键恢复）");
    }
  }

  function renderState(payload) {
    currentState = payload.state;
    const transcript = payload.transcript || "";
    micBtn.classList.remove("listening", "thinking", "active", "mic-live");
    if (voiceMuted) {
      renderMuteState();
      return;
    }

    switch (payload.state) {
      case "preparing":
        showStatus(
          "正在准备语音… " +
            (typeof payload.progress === "number"
              ? payload.progress + "%"
              : "（首次需下载本地模型，请稍候）")
        );
        micBtn.classList.add("mic-live");
        break;
      case "idle":
        showStatus(
          voiceEnabled
            ? ttsEnabled
              ? "喊「普瑞赛斯」，或点击麦克风说话"
              : "喊「普瑞赛斯」，或点击麦克风说话（语音回复需先开启「语音合成」）"
            : ""
        );
        if (voiceEnabled) micBtn.classList.add("mic-live");
        break;
      case "listening":
        showStatus("聆听中… " + (transcript || ""));
        micBtn.classList.add("listening");
        break;
      case "thinking":
        showStatus("正在识别…");
        micBtn.classList.add("thinking");
        break;
      case "active":
        showStatus("她正在回复…");
        micBtn.classList.add("active");
        break;
      case "off":
      default:
        showStatus(payload.error ? "语音出错：" + payload.error : "");
        break;
    }
  }

  voiceApi.onState(renderState);

  // Barge-in: main tells us her speech was cut off — stop local TTS playback.
  voiceApi.onStop(() => {
    if (typeof window.__prtsStopTts === "function") window.__prtsStopTts();
  });

  // ---- button ------------------------------------------------------------
  // Left click: start listening (or enable voice first). Ignored while muted.
  micBtn.addEventListener("click", async () => {
    if (voiceMuted) {
      showStatus("语音已暂时禁用，右键恢复");
      return;
    }
    if (!voiceEnabled) {
      // One click turns voice on (mirrors the tray toggle): main persists the
      // setting, broadcasts settings:state back, and creates the hidden mic
      // window. A second click starts listening.
      showStatus("正在开启语音…");
      try {
        await voiceApi.setEnabled(true);
      } catch (_) {
        /* ignore */
      }
      return;
    }
    if (currentState === "listening") {
      voiceApi.cancel();
    } else {
      voiceApi.pushToTalk();
    }
  });

  // Right click: toggle 暂时禁用语音 (mute) — red icon. Does not shut down the
  // engine, just stops accepting new voice input; right-click again to resume.
  // While muted, her TTS playback is also stopped (full mute).
  micBtn.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    voiceMuted = !voiceMuted;
    if (voiceMuted) {
      if (typeof window.__prtsStopTts === "function") window.__prtsStopTts();
      voiceApi.cancel();
    }
    renderMuteState();
    if (!voiceMuted && currentState === "idle" && voiceEnabled) {
      // restore the normal idle hint
      renderState({ state: "idle" });
    }
  });

  // ---- lifecycle: follow the tray "voice" toggle --------------------------
  function applySettings(s) {
    voiceEnabled = s?.voiceEnabled === true;
    ttsEnabled = s?.minimaxTtsEnabled === true;
    if (voiceMuted) {
      micBtn.classList.toggle("mic-live", false);
    } else {
      micBtn.classList.toggle("mic-live", voiceEnabled);
    }
    if (!voiceEnabled) {
      micBtn.classList.remove("listening", "active");
      if (currentState === "idle") showStatus("");
    } else if (currentState === "idle" && !voiceMuted) {
      // refresh the idle hint now that we know the TTS status
      renderState({ state: "idle" });
    }
    renderMuteState();
  }

  petApi?.getSettings?.().then(applySettings);
  petApi?.onSettings?.(applySettings);

  voiceApi.getState?.().then((st) => {
    if (st) renderState({ state: st.state, enabled: st.enabled });
  });
})();
