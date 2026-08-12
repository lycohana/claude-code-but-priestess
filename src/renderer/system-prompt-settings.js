// System prompt settings — the persona core is fully editable here. The
// built-in original always lives in persona.js; "restore default" clears the
// override so it comes back. Everything round-trips to settings.json locally.

const enabledEl = document.getElementById("enabled");
const promptEl = document.getElementById("prompt");
const saveBtn = document.getElementById("saveBtn");
const cancelBtn = document.getElementById("cancelBtn");
const resetBtn = document.getElementById("resetBtn");
const statusEl = document.getElementById("status");

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = kind || "";
}

// Load: the window shows the override when set, otherwise the built-in core.
window.systemPromptApi
  .get()
  .then((cfg) => {
    const hasOverride = Boolean(cfg.override && cfg.override.trim());
    enabledEl.checked = hasOverride;
    promptEl.value = hasOverride ? cfg.override : cfg.defaultPrompt || "";
  })
  .catch(() => setStatus("读取配置失败", "err"));

resetBtn.addEventListener("click", async () => {
  resetBtn.disabled = true;
  try {
    const cfg = await window.systemPromptApi.get();
    promptEl.value = cfg.defaultPrompt || "";
    enabledEl.checked = false;
    setStatus("已恢复内置默认（保存后生效）", "ok");
  } catch (error) {
    setStatus(`恢复失败：${error?.message || error}`, "err");
  } finally {
    resetBtn.disabled = false;
  }
});

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  try {
    await window.systemPromptApi.set({
      enabled: enabledEl.checked,
      prompt: promptEl.value,
    });
    setStatus("已保存", "ok");
    setTimeout(() => window.systemPromptApi.close(), 350);
  } catch (error) {
    setStatus(`保存失败：${error?.message || error}`, "err");
    saveBtn.disabled = false;
  }
});

cancelBtn.addEventListener("click", () => window.systemPromptApi.close());