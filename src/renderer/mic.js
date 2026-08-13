// ============================================================
//  Mic capture (hidden window) — the single microphone source.
//
//  Runs in a dedicated hidden BrowserWindow with
//  `backgroundThrottling: false`, so it keeps capturing audio even
//  when the popover is collapsed. It enumerates the Doctor's input
//  devices, reports them to main for the tray "麦克风" menu, and
//  switches devices on demand (`voice:device`). Every 16kHz mono
//  chunk is sent to main over IPC, where sherpa-onnx runs.
// ============================================================
(function () {
  "use strict";

  const voiceApi = window.voiceApi;
  if (!voiceApi) return;

  const SAMPLE_RATE = 16000;
  let audioCtx = null;
  let mediaStream = null;
  let processorNode = null;
  let sourceNode = null;

  function reportError(message) {
    try {
      voiceApi.reportMicError(message);
    } catch {
      /* ignore */
    }
  }

  function resampleTo16k(input, fromRate) {
    if (!fromRate || Math.abs(fromRate - SAMPLE_RATE) < 1) return input;
    const ratio = SAMPLE_RATE / fromRate;
    const outLen = Math.round(input.length * ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i += 1) {
      const src = i / ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = src - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  function floatToInt16(f32) {
    const int16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i += 1) {
      let s = f32[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
  }

  function stopCapture() {
    if (processorNode) {
      try { processorNode.disconnect(); } catch (_) { /* ignore */ }
      try { processorNode.port.close(); } catch (_) { /* ignore */ }
      processorNode = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (_) { /* ignore */ }
      sourceNode = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  }

  function audioConstraints(deviceId) {
    return {
      audio: {
        // autoGainControl OFF — AGC flattens the short-word loudness contour
        // that KWS needs to spot 普瑞赛斯, so it hurts wake detection.
        // noiseSuppression + echoCancellation stay ON — FunASR transcription
        // needs a clean signal, and its own echo (TTS) must not be re-fed.
        autoGainControl: false,
        noiseSuppression: true,
        echoCancellation: true,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {})
      }
    };
  }

  async function startCapture(deviceId) {
    stopCapture();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      reportError("此环境不支持麦克风");
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia(audioConstraints(deviceId));
    } catch (error) {
      if (deviceId) {
        // Selected device is gone — fall back to the OS default.
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia(audioConstraints(""));
        } catch (error2) {
          console.warn("mic: access denied", error2);
          reportError("麦克风被拒绝或不可用");
          return;
        }
      } else {
        console.warn("mic: access denied", error);
        reportError("麦克风被拒绝或不可用");
        return;
      }
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });

    // AudioWorklet capture — replaces ScriptProcessorNode (deprecated, and a
    // known native-crash source in hidden background windows + Windows tray).
    await audioCtx.audioWorklet.addModule("mic-processor.js");
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    processorNode = new AudioWorkletNode(audioCtx, "mic-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1
    });
    processorNode.port.onmessage = (event) => {
      const samples = event.data?.samples;
      if (!samples || samples.length === 0) return;
      const f32 = resampleTo16k(samples, audioCtx.sampleRate);
      voiceApi.sendAudio(floatToInt16(f32));
    };
    // Route the stream through the worklet (a muted output keeps it alive
    // without echoing the microphone back through the speakers).
    sourceNode.connect(processorNode);
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    processorNode.connect(mute);
    mute.connect(audioCtx.destination);

    enumerateAndReport();
  }

  async function enumerateAndReport() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter((d) => d.kind === "audioinput")
        .map((d, i) => {
          // Ensure deviceId is a non-empty string and label is always a plain
          // non-empty string — a bad/empty value into the tray menu can crash
          // the native menu on Windows.
          const id = typeof d.deviceId === "string" && d.deviceId ? d.deviceId : "";
          const label =
            typeof d.label === "string" && d.label.trim()
              ? d.label.trim().slice(0, 80)
              : `麦克风 ${i + 1}`;
          return { deviceId: id, label };
        })
        // Filter out the "default"/"communications" alias entries — they're
        // just the OS-default microphone under a synthetic id, already covered
        // by the tray menu's "默认麦克风" item. Keep every REAL device.
        .filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
      voiceApi.reportDevices(inputs);
    } catch {
      /* ignore */
    }
  }

  // Main sends the selected deviceId ("" = default) on load and on change.
  voiceApi.onDevice?.((payload) => {
    startCapture(payload?.deviceId || "");
  });

  // Keep the tray menu in sync when devices are plugged/unplugged.
  navigator.mediaDevices?.addEventListener?.("devicechange", enumerateAndReport);

  window.addEventListener("beforeunload", stopCapture);

  // Report what's available immediately (labels may be generic until capture
  // actually starts); startCapture() re-reports once a device is live.
  enumerateAndReport();
})();
