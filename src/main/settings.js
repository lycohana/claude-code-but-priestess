const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { isClaudeReasoningEffort } = require("./claude-capabilities");
const { isReasoningEffort } = require("./codex-model-catalog");

const DEFAULTS = Object.freeze({
  chatProvider: process.platform === "win32" ? "codex" : "claude",
  // Optional model override per backend, passed to the CLI as `--model`. Empty
  // string = let the CLI / account pick its default.
  claudeModel: "",
  codexModel: "",
  // Optional per-turn reasoning overrides. Empty keeps each CLI's own
  // config/default; non-empty values are passed to the selected local CLI.
  claudeReasoningEffort: "",
  codexReasoningEffort: "",
  // Built-in "Priestess" backend — she speaks to an OpenAI-compatible server
  // directly (no local CLI needed). Defaults to a local LiteLLM proxy. The
  // API key and URL live ONLY in this local settings.json (userData); they
  // are never sent anywhere except the server the Doctor configures.
  priestessEnabled: false,
  priestessBaseUrl: "http://127.0.0.1:4000",
  priestessApiKey: "",
  priestessModel: "",
  chatCwd: "",
  // Appearance: "system" follows the OS light/dark setting; "light"/"dark"
  // force a fixed appearance. Drives nativeTheme.themeSource, which in turn
  // flips the renderer's prefers-color-scheme palette and (on macOS) the
  // popover vibrancy material.
  theme: "system",
  // Menu language: "system" follows the OS preferred language, "zh" forces
  // Simplified Chinese, and "en" forces English.
  menuLanguage: "system",
  // Her outfit: "formal" (正装 — the classic coat, assets/character root) or
  // "casual" (休闲 — the white butterfly dress, assets/character/casual).
  // Both sets share the same nine expression frames.
  outfit: "formal",
  agentMode: false,
  // Vibe coding: companion | advisor | agent. "companion" = chat only,
  // "advisor" = read-only tools (Read,Grep,Glob,LS), "agent" = full agent.
  // Migrated from the old `agentMode` boolean on first read.
  vibeCodingMode: "companion",
  // Vibe coding: proactive diagnostic checks (she notices lint errors).
  vibeCodingDiagnostics: false,
  // Minutes between diagnostic proactive checks (min 1).
  diagnosticCheckCooldownMin: 5,
  // Vibe coding: proactive activity narration (save, git, build).
  vibeCodingActivityNarration: false,
  // Minutes between activity-based proactive checks (min 1).
  activityCheckCooldownMin: 3,
  // When she commits on the Doctor's behalf, sign the commit with an honest
  // Co-Authored-By trailer (普瑞赛斯 <prts.priestess@outlook.com>) so she shows
  // up as a real contributor — the same idea as Claude Code's trailer. On by
  // default, documented in the README, toggleable from the tray menu.
  coauthorCommits: true,
  // Lets Priestess trigger curated local actions (play music, web search, open
  // a URL/app) via hidden [[skill:…]] directives. Closed whitelist + sanitized
  // args, so it's safe without agent mode. PRTS-internal only.
  skillsEnabled: true,
  // Update channel: "stable" (default) only ever offers full releases.
  // "prerelease" is a developer/tester flag — there is deliberately no menu
  // option for it; flip it by hand in settings.json (tray → 打开数据目录) to
  // receive prerelease builds for testing before they are promoted.
  updateChannel: "stable",
  autoScreenshot: true,
  // 老婆模式 (waifu mode) — she periodically looks at the screen on her own
  // and quietly takes care of the Doctor: gentle check-ins, jealousy when he
  // is fawning over someone who isn't her, sharp warnings on NSFW, and a
  // local-only observation journal (memory/OBSERVATIONS.jsonl). Off by
  // default; the tray toggle shows a consent dialog because every check is a
  // paid model call and needs screen access. Interval/cooldown are minutes;
  // quiet hours are local "HH:MM" and may wrap past midnight; the daily cap
  // counts checks. The tuning knobs have no menu UI — edit them here by hand
  // (tray → 打开数据目录), like updateChannel.
  waifuMode: false,
  proactiveIntervalMin: 20,
  proactiveCooldownMin: 10,
  proactiveDailyCap: 20,
  proactiveQuietStart: "00:30",
  proactiveQuietEnd: "08:30",
  // Timestamp of the last automatic memory-curation pass (see proactive.js).
  memoryCuratedAt: 0,
  desktopPet: true,
  // Continuous pet scale (1.0 = 150×180, the former "medium"). Scroll over
  // the pet to fine-tune; the tray menu offers preset stops.
  desktopPetScale: 1.0,
  desktopPetPosition: null,
  popoverSize: { width: 380, height: 560 },
  // Header badges in the popover title bar (version / backend / vibe-coding
  // mode). Toggleable from the tray menu; off hides all three.
  showHeaderBadges: true,
  // Reply length she aims for: "short" (chat-like, one or two lines),
  // "medium" (complete but concise, default), "long" (detailed and thorough).
  // Injected into the persona prompt each turn.
  replyLength: "medium",
  // Freeform persona supplement written by the Doctor in-app. Appended after
  // the base persona as 【博士的补充校准】. Max ~1500 chars; empty = inactive.
  personaNotes: "",
  // Full replacement for the base persona core (identity/voice/boundaries).
  // Empty = the built-in original (persona.js basePersonaCore()); non-empty =
  // this text REPLACES the base core while all dynamic blocks (mood tags,
  // memory, skills, tool voice) still auto-inject. Written by the system
  // prompt settings window; "restore default" clears it back to empty.
  systemPromptOverride: "",
  // MiniMax TTS (Text-to-Speech) — streams Agent replies through the MiniMax
  // T2A WebSocket API (wss://api.minimaxi.com/ws/v1/t2a_v2) so she can speak
  // aloud. API key, voice, and model are configured in the tray-menu settings
  // window; the key stays in local settings.json only.
  minimaxTtsEnabled: false,
  minimaxTtsApiKey: "",
  minimaxTtsVoiceId: "moss_audio_ce44fc67-7ce3-11f0-8de5-96e35d26fb85",
  minimaxTtsModel: "speech-2.8-hd",
  minimaxTtsSpeed: 1.0,
  minimaxTtsVol: 1.0,
  minimaxTtsPitch: 0,
  minimaxTtsFormat: "mp3",
  minimaxTtsSampleRate: 32000,
  // When to synthesize Agent replies:
  //   "firstSentence" — speak the first sentence eagerly, the rest as one
  //                     clip at turn-idle (balanced: quick start, gap-free tail)
  //   "whole"         — synthesize the entire reply as one clip at turn-idle
  //                     (slowest start, most consistent emotion/continuity)
  //   "perSentence"   — synthesize each sentence as it streams in (lowest
  //                     latency, but sentence-edge pauses)
  minimaxTtsStrategy: "firstSentence",
  // Custom pronunciation rules for MiniMax TTS, as [{text, pronunciation}]
  // pairs — "原文/替换内容". Each pair becomes a `pronunciation_dict.tone`
  // entry ("text/(chu3)(li3)" etc). Empty = no custom rules.
  minimaxTtsPronunciationDict: []
});

let cache = { ...DEFAULTS };
let filePath = null;
const subscribers = new Set();

function init() {
  filePath = path.join(app.getPath("userData"), "settings.json");
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      // Migration: 主动关心 + 观察日志 merged into 老婆模式 (waifu mode).
      if (parsed.waifuMode === undefined &&
          (parsed.proactiveEnabled === true || parsed.observationJournal === true)) {
        parsed.waifuMode = true;
      }
      delete parsed.proactiveEnabled;
      delete parsed.observationJournal;
      // Migration: fixed small/medium/large pet sizes → continuous scale.
      if (parsed.desktopPetScale === undefined && parsed.desktopPetSize) {
        parsed.desktopPetScale =
          parsed.desktopPetSize === "small" ? 0.8 : parsed.desktopPetSize === "large" ? 1.2 : 1.0;
      }
      delete parsed.desktopPetSize;
      // Migration: old boolean agentMode → string vibeCodingMode
      if (parsed.agentMode === true && parsed.vibeCodingMode === undefined) {
        parsed.vibeCodingMode = "agent";
      }
      delete parsed.agentMode;
      cache = { ...DEFAULTS, ...parsed };
      // Don't persist the stale agentMode default — it's now a derived field.
      delete cache.agentMode;
    }
  } catch (error) {
    console.warn("settings: failed to load, using defaults", error);
    cache = { ...DEFAULTS };
  }
}

function getAll() {
  return { ...cache };
}

function get(key) {
  return cache[key];
}

const VALIDATORS = {
  vibeCodingMode: (v) => ["companion", "advisor", "agent"].includes(v),
  chatProvider: (v) => ["claude", "codex", "priestess"].includes(v),
  claudeReasoningEffort: isClaudeReasoningEffort,
  codexReasoningEffort: isReasoningEffort,
  theme: (v) => ["system", "light", "dark"].includes(v),
  menuLanguage: (v) => ["system", "zh", "en"].includes(v),
  outfit: (v) => ["formal", "casual"].includes(v),
  updateChannel: (v) => ["stable", "prerelease"].includes(v),
  minimaxTtsStrategy: (v) => ["firstSentence", "whole", "perSentence"].includes(v),
  replyLength: (v) => ["short", "medium", "long"].includes(v),
  desktopPetSize: () => false // deprecated, reject
};

function set(patch) {
  const sanitized = {};
  for (const [key, value] of Object.entries(patch)) {
    // Reject unknown keys
    if (!(key in DEFAULTS)) {
      console.warn("settings: rejected unknown key", key);
      continue;
    }
    // Reject deprecated keys
    if (key === "agentMode") {
      console.warn("settings: agentMode is deprecated, use vibeCodingMode instead");
      continue;
    }
    // Validate enum keys
    const validator = VALIDATORS[key];
    if (validator && !validator(value)) {
      console.warn("settings: rejected invalid value for", key, value);
      continue;
    }
    sanitized[key] = value;
  }
  if (Object.keys(sanitized).length === 0) return;
  cache = { ...cache, ...sanitized };
  persist();
  for (const sub of subscribers) {
    try {
      sub(cache, sanitized);
    } catch (error) {
      console.warn("settings subscriber threw", error);
    }
  }
}

function persist() {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf8");
  } catch (error) {
    console.warn("settings: failed to persist", error);
  }
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

module.exports = { init, getAll, get, set, subscribe, DEFAULTS };
