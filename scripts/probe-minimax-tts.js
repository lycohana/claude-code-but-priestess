// Standalone MiniMax TTS probe (HTTP T2A V2, streaming) — no Electron.
// Run:  MINIMAX_API_KEY=yourkey node scripts/probe-minimax-tts.js
//
// Fires one POST /v1/t2a_v2 with stream:true and prints each audio chunk's
// byte size, the gap between chunks, total bytes, and writes the assembled
// audio to probe-tts-output.mp3 for a manual listen.
// Paste the console output back so latency/chunk strategy can be tuned.

const https = require("node:https");
const fs = require("node:fs");

const API_KEY = process.env.MINIMAX_API_KEY || "";
if (!API_KEY) {
  console.error("Set MINIMAX_API_KEY env var first.");
  process.exit(1);
}

const MODEL = process.env.MINIMAX_TTS_MODEL || "speech-2.8-hd";
const VOICE_ID =
  process.env.MINIMAX_TTS_VOICE ||
  "moss_audio_ce44fc67-7ce3-11f0-8de5-96e35d26fb85";
const FORMAT = process.env.MINIMAX_TTS_FORMAT || "mp3";
const SAMPLE_RATE = Number(process.env.MINIMAX_TTS_SR || 32000);

const TEXT =
  "博士，普瑞赛斯语音合成已经就绪。这是一段用来测试流式延迟和音频连续性的较长文本，" +
  "整段一起合成，听听有没有断裂或卡顿。";

const body = JSON.stringify({
  model: MODEL,
  text: TEXT,
  stream: true,
  voice_setting: { voice_id: VOICE_ID, speed: 1.0, vol: 1.0, pitch: 0 },
  audio_setting: {
    format: FORMAT,
    sample_rate: SAMPLE_RATE,
    bitrate: FORMAT === "mp3" ? 128000 : undefined,
    channel: 1,
    force_cbr: FORMAT === "mp3",
  },
  subtitle_enable: false,
});

const startAt = Date.now();
let chunkCount = 0;
let totalBytes = 0;
let lastAt = 0;
const parts = [];
let buf = "";

const req = https.request(
  "https://api.minimaxi.com/v1/t2a_v2",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
  },
  (res) => {
    console.log(`[response] HTTP ${res.statusCode}`);
    if (res.statusCode !== 200) {
      let b = "";
      res.on("data", (c) => (b += c.toString()));
      res.on("end", () => console.error("[error body]", b.slice(0, 500)));
      return;
    }
    res.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        handle(raw);
      }
    });
    res.on("end", () => {
      if (buf.trim()) handle(buf);
      const totalMs = Date.now() - startAt;
      console.log(`[done] ${chunkCount} chunks, ${totalBytes} bytes, ${totalMs}ms total`);
      if (parts.length) {
        fs.writeFileSync("probe-tts-output." + (FORMAT === "pcm" ? "pcm" : FORMAT === "wav" ? "wav" : "mp3"), Buffer.concat(parts));
        console.log("[done] wrote probe-tts-output file — play it to check continuity");
      }
    });
  }
);

function handle(raw) {
  const lines = raw.split("\n");
  let data = "";
  for (const line of lines) {
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
    else if (line.startsWith("data")) data += line.slice(4).trimStart();
  }
  let msg;
  try { msg = JSON.parse(data.trim()); }
  catch {
    try { msg = JSON.parse(raw.trim()); }
    catch { return; }
  }
  if (msg.base_resp && msg.base_resp.status_code !== 0) {
    console.error("[error]", msg.base_resp.status_code, msg.base_resp.status_msg);
    return;
  }
  if (msg.data && msg.data.audio) {
    const b = Buffer.from(String(msg.data.audio), "hex");
    chunkCount += 1;
    totalBytes += b.length;
    parts.push(b);
    const now = Date.now();
    const gap = lastAt ? now - lastAt : now - startAt;
    lastAt = now;
    console.log(
      `[audio] #${chunkCount} bytes=${b.length} status=${msg.data.status} ` +
      `gap=${gap}ms${msg.extra_info ? " extra=" + JSON.stringify({ len: msg.extra_info.audio_length }) : ""}`
    );
  }
}

req.on("error", (err) => console.error("[req error]", err.message));
req.write(body);
req.end();
console.log("[request] streaming HTTP T2A…", { model: MODEL, voice: VOICE_ID, format: FORMAT });