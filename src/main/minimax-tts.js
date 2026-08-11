// ============================================================
//  MiniMax TTS — HTTP T2A V2 (non-streaming).
//  POST https://api.minimaxi.com/v1/t2a_v2  with stream:false
//  returns ONE JSON response whose data.audio holds the complete,
//  hex-encoded audio for the whole text. One request = one
//  continuous utterance — no per-chunk gaps, no stutter.
//
//  This mirrors the proven Python reference: non-streaming, full
//  audio, then play. The text is synthesized as a single piece, so
//  playback is gap-free regardless of length.
// ============================================================

const https = require("node:https");
const settings = require("./settings");

const HTTP_URL = "https://api.minimaxi.com/v1/t2a_v2";

// ---- config helpers ---------------------------------------------------

function apiKey() {
  return String(settings.get("minimaxTtsApiKey") || "").trim();
}

function enabled() {
  return settings.get("minimaxTtsEnabled") === true && apiKey().length > 0;
}

function voiceSetting() {
  return {
    voice_id: String(
      settings.get("minimaxTtsVoiceId") ||
        "moss_audio_ce44fc67-7ce3-11f0-8de5-96e35d26fb85"
    ),
    speed: Number(settings.get("minimaxTtsSpeed")) || 1.0,
    vol: Number(settings.get("minimaxTtsVol")) || 1.0,
    pitch: Math.round(Number(settings.get("minimaxTtsPitch")) || 0),
  };
}

function audioSetting() {
  const fmt = String(settings.get("minimaxTtsFormat") || "mp3");
  const sr = Number(settings.get("minimaxTtsSampleRate")) || (fmt === "pcm" ? 24000 : 32000);
  const setting = {
    format: fmt,
    sample_rate: sr,
    channel: 1,
  };
  if (fmt === "mp3") setting.bitrate = 128000;
  return setting;
}

function model() {
  return String(settings.get("minimaxTtsModel") || "speech-2.8-hd");
}

// ---- HTTP request ------------------------------------------------------

/**
 * Synthesize `text` via the HTTP T2A V2 endpoint (non-streaming).
 *
 * `callbacks` is { onAudio(buf, isFinal), onDone(), onError(err) }.
 * `buf` is a Buffer of the complete decoded audio (hex → Buffer);
 * `isFinal` is true on the single delivery. The renderer plays the
 * whole buffer at once — smooth, no chunk edges.
 *
 * Returns a handle with a cancel() method (call to abort). The
 * startTask/sendText/finishTask names are kept for main.js symmetry.
 */
function startTask(callbacks) {
  if (!enabled()) {
    callbacks?.onError?.(new Error("MiniMax TTS is not enabled or missing API key"));
    return null;
  }

  const onAudio = callbacks?.onAudio;
  const onDone = callbacks?.onDone;
  const onError = callbacks?.onError;

  let cancelled = false;
  let finished = false;

  const handle = {
    _req: null,
    _fired: false,

    cancel() {
      cancelled = true;
      if (this._req) {
        try { this._req.destroy(); } catch (_) { /* ignore */ }
        this._req = null;
      }
    },

    // Fire the actual HTTP request with the full text. Called once, when
    // sendText is invoked (main.js passes the whole reply at turn-idle).
    sendText(text) {
      const trimmed = String(text || "").trim();
      if (!trimmed || handle._fired) return;
      handle._fired = true;

      // MiniMax rejects text longer than 10000 chars; guard against it so a
      // very long reply still speaks (truncated) instead of erroring out.
      const safe = trimmed.length > 9000 ? trimmed.slice(0, 9000) : trimmed;

      const body = JSON.stringify({
        model: model(),
        text: safe,
        stream: false,
        voice_setting: voiceSetting(),
        audio_setting: audioSetting(),
        subtitle_enable: false,
      });

      const req = https.request(
        HTTP_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey()}`,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          handle._req = req;
          let raw = "";
          res.on("data", (chunk) => { raw += chunk.toString("utf8"); });
          res.on("end", () => {
            if (cancelled) return;
            if (res.statusCode !== 200) {
              const msg = `MiniMax TTS HTTP ${res.statusCode}: ${raw.slice(0, 300)}`;
              console.warn("minimax-tts:", msg);
              if (!finished) { finished = true; onError?.(new Error(msg)); }
              return;
            }
            let data;
            try { data = JSON.parse(raw); }
            catch (err) {
              if (!finished) {
                finished = true;
                onError?.(new Error(`MiniMax TTS: bad JSON (${err.message})`));
              }
              return;
            }
            const status = data.base_resp?.status_code;
            if (status != null && status !== 0) {
              const errMsg = data.base_resp?.status_msg || `MiniMax TTS error (code ${status})`;
              console.warn("minimax-tts:", errMsg);
              if (!finished) { finished = true; onError?.(new Error(errMsg)); }
              return;
            }
            const audioHex = data.data?.audio;
            if (audioHex) {
              const buf = Buffer.from(String(audioHex), "hex");
              if (buf.length) onAudio?.(buf, true);
            }
            if (!finished) { finished = true; onDone?.(); }
          });
        }
      );
      req.on("error", (err) => {
        if (cancelled || finished) return;
        finished = true;
        onError?.(err);
      });
      req.write(body);
      req.end();
      handle._req = req;
    },

    // Non-streaming has no finish step — the single request carries all
    // text. Kept for API symmetry with the old WebSocket version.
    finishTask() {},
  };

  currentHandle = handle;
  return handle;
}

// Module-level handle so the module-level sendText/finishTask/close can
// delegate to the live request. Only one task is active at a time.
let currentHandle = null;

function sendText(handle, text) {
  if (handle && typeof handle.sendText === "function") handle.sendText(text);
}

function finishTask(handle) {
  if (handle && typeof handle.finishTask === "function") handle.finishTask();
}

function close() {
  if (currentHandle) {
    currentHandle.cancel();
    currentHandle = null;
  }
}

module.exports = {
  startTask,
  sendText,
  finishTask,
  close,
  enabled,
};