const { contextBridge, ipcRenderer, webUtils } = require("electron");
const { pathToFileURL } = require("node:url");

function onChannel(channel) {
  return (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  };
}

contextBridge.exposeInMainWorld("petApi", {
  isWindows: process.platform === 'win32',
  isMac: process.platform === 'darwin',
  hidePopover: () => ipcRenderer.invoke("popover:hide"),
  getPopoverBounds: (options) => ipcRenderer.invoke("popover:get-bounds", options),
  resizePopoverDrag: (payload) => ipcRenderer.invoke("popover:resize-drag", payload),
  movePopover: (point) => ipcRenderer.invoke("popover:move", point),
  endMovePopover: () => ipcRenderer.invoke("popover:move-end"),
  notePopoverActivity: () => ipcRenderer.invoke("popover:activity"),
  openChatFromDesktopPet: () => ipcRenderer.invoke("desktop-pet:open-chat"),
  moveDesktopPet: (point) => ipcRenderer.invoke("desktop-pet:move", point),
  scaleDesktopPet: (factor) => ipcRenderer.invoke("desktop-pet:scale", factor),
  pickChatCwd: () => ipcRenderer.invoke("settings:pick-cwd"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  onOpened: onChannel("popover:opened"),
  onSettings: onChannel("settings:state"),
  getCatMode: () => ipcRenderer.invoke("desktop-pet:cat-mode-get"),
  onCatMode: onChannel("desktop-pet:cat-mode"),
  onShown: onChannel("desktop-pet:shown")
});

contextBridge.exposeInMainWorld("previewApi", {
  open: (payload) => ipcRenderer.invoke("popover:preview-open", payload),
  close: () => ipcRenderer.invoke("popover:preview-close"),
  openInBrowser: (payload) => ipcRenderer.invoke("html:open-in-browser", payload)
});

contextBridge.exposeInMainWorld("priestessApi", {
  getConfig: () => ipcRenderer.invoke("priestess:get-config"),
  setConfig: (cfg) => ipcRenderer.invoke("priestess:set-config", cfg),
  testConnection: (cfg) => ipcRenderer.invoke("priestess:test-connection", cfg),
  closeSettings: () => ipcRenderer.invoke("priestess:close-settings")
});

contextBridge.exposeInMainWorld("personaNotesApi", {
  get: () => ipcRenderer.invoke("persona-notes:get"),
  set: (notes) => ipcRenderer.invoke("persona-notes:set", notes),
  close: () => ipcRenderer.invoke("persona-notes:close")
});

contextBridge.exposeInMainWorld("systemPromptApi", {
  get: () => ipcRenderer.invoke("system-prompt:get"),
  set: (cfg) => ipcRenderer.invoke("system-prompt:set", cfg),
  close: () => ipcRenderer.invoke("system-prompt:close")
});

contextBridge.exposeInMainWorld("creditsApi", {
  get: () => ipcRenderer.invoke("credits:get"),
  openLink: (url) => ipcRenderer.invoke("credits:open-link", url),
  close: () => ipcRenderer.invoke("credits:close")
});

contextBridge.exposeInMainWorld("minimaxTtsApi", {
  getConfig: () => ipcRenderer.invoke("minimax-tts:get-config"),
  setConfig: (cfg) => ipcRenderer.invoke("minimax-tts:set-config", cfg),
  closeSettings: () => ipcRenderer.invoke("minimax-tts:close-settings"),
  test: (payload) => ipcRenderer.invoke("minimax-tts:test", payload),
  replay: (text) => ipcRenderer.invoke("minimax-tts:replay", text),
  onAudio: onChannel("minimax-tts:audio"),
});

contextBridge.exposeInMainWorld("updateApi", {
  getState: () => ipcRenderer.invoke("update:get-state"),
  onProgress: onChannel("update:progress")
});

contextBridge.exposeInMainWorld("chatApi", {
  send: (text, attachments) => ipcRenderer.invoke("chat:send", { text, attachments }),
  pickFiles: () => ipcRenderer.invoke("chat:pick-files"),
  // Electron ≥32 removed File.path; resolve a dropped File's real path here.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  // file:// URL for showing a local attachment thumbnail in the user's bubble.
  fileUrl: (p) => {
    try {
      return pathToFileURL(p).href;
    } catch {
      return "";
    }
  },
  // Open a non-image attachment with the OS default app (Quick Look / Preview).
  openAttachment: (p) => ipcRenderer.invoke("chat:open-attachment", p),
  // Local image as a data: URI (webSecurity blocks cross-dir file:// images).
  attachmentDataUri: (p) => ipcRenderer.invoke("chat:attachment-data-uri", p),
  cancel: () => ipcRenderer.invoke("chat:cancel"),
  clear: () => ipcRenderer.invoke("chat:clear"),
  getHistory: () => ipcRenderer.invoke("chat:get-history"),
  onChunk: onChannel("chat:chunk"),
  onStatus: onChannel("chat:status"),
  onHistory: onChannel("chat:history"),
  onTool: onChannel("chat:tool"),
  onMood: onChannel("chat:mood"),
  onProactive: onChannel("chat:proactive"),
  onQueue: onChannel("chat:queue")
});

contextBridge.exposeInMainWorld("voiceApi", {
  // Fire-and-forget: high-frequency PCM chunks (Int16, 16kHz mono).
  sendAudio: (int16) => ipcRenderer.send("voice:audio", int16),
  pushToTalk: () => ipcRenderer.invoke("voice:push-to-talk"),
  cancel: () => ipcRenderer.invoke("voice:cancel"),
  getState: () => ipcRenderer.invoke("voice:get-state"),
  setEnabled: (enabled) => ipcRenderer.invoke("voice:set-enabled", enabled),
  // Mic-capture errors from the hidden window (permission denied, no device).
  reportMicError: (message) => ipcRenderer.send("voice:mic-error", message),
  // Enumerated audio-input devices, reported by the hidden mic window.
  reportDevices: (devices) => ipcRenderer.send("voice:devices", devices),
  // Main → mic window: switch to this deviceId ("" = OS default).
  onDevice: onChannel("voice:device"),
  onState: onChannel("voice:state"),
  onStop: onChannel("minimax-tts:stop")
});
