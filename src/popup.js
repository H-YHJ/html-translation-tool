const DEFAULT_SETTINGS = {
  apiKey: "",
  endpoint: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4.1-mini",
  targetLanguage: "中文（简体）",
  glossary: ""
};

const controls = {
  apiKey: document.getElementById("apiKey"),
  endpoint: document.getElementById("endpoint"),
  model: document.getElementById("model"),
  targetLanguage: document.getElementById("targetLanguage"),
  glossary: document.getElementById("glossary"),
  status: document.getElementById("status"),
  saveSettings: document.getElementById("saveSettings"),
  translatePage: document.getElementById("translatePage"),
  translateSelection: document.getElementById("translateSelection"),
  restorePage: document.getElementById("restorePage")
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  setFormValues({ ...DEFAULT_SETTINGS, ...settings });

  controls.saveSettings.addEventListener("click", saveSettings);
  controls.translatePage.addEventListener("click", () => runTabAction("TRANSLATE_PAGE"));
  controls.translateSelection.addEventListener("click", () => runTabAction("TRANSLATE_SELECTION"));
  controls.restorePage.addEventListener("click", () => runTabAction("RESTORE_PAGE", false));

  for (const key of ["targetLanguage", "glossary"]) {
    controls[key].addEventListener("change", saveSettings);
  }
}

function setFormValues(settings) {
  controls.apiKey.value = settings.apiKey || "";
  controls.endpoint.value = settings.endpoint || DEFAULT_SETTINGS.endpoint;
  controls.model.value = settings.model || DEFAULT_SETTINGS.model;
  controls.targetLanguage.value = settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;
  controls.glossary.value = settings.glossary || "";
}

function getFormValues() {
  return {
    apiKey: controls.apiKey.value.trim(),
    endpoint: controls.endpoint.value.trim() || DEFAULT_SETTINGS.endpoint,
    model: controls.model.value.trim() || DEFAULT_SETTINGS.model,
    targetLanguage: controls.targetLanguage.value,
    glossary: controls.glossary.value.trim()
  };
}

async function saveSettings() {
  await chrome.storage.local.set(getFormValues());
  setStatus("设置已保存。", "success");
}

async function runTabAction(type, shouldSave = true) {
  setBusy(true);

  try {
    if (shouldSave) {
      await saveSettings();
    }

    const response = await sendToActiveTab({
      type,
      options: getFormValues()
    });

    if (!response?.ok) {
      throw new Error(response?.error || "当前页面无法执行此操作。");
    }

    setStatus(statusFor(type, response), "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("找不到当前标签页。");
  }

  await ensureContentScript(tab.id);

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    throw new Error("这个页面不支持内容脚本，请换一个普通网页再试。");
  }
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "PING_CONTEXT_TRANSLATOR"
    });

    if (response?.ok || response?.ready) {
      return;
    }
  } catch (error) {
    // Existing tabs opened before the extension was loaded need manual injection.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/contentScript.js"]
    });
  } catch (error) {
    throw new Error("无法在这个页面运行翻译脚本，请打开普通 http/https 网页后重试。");
  }
}

function statusFor(type, response) {
  if (type === "TRANSLATE_PAGE") {
    return `已翻译 ${response.translated || 0} 段文本。`;
  }

  if (type === "TRANSLATE_SELECTION") {
    return "已翻译选中文本。";
  }

  return "已恢复原文。";
}

function setBusy(isBusy) {
  controls.saveSettings.disabled = isBusy;
  controls.translatePage.disabled = isBusy;
  controls.translateSelection.disabled = isBusy;
  controls.restorePage.disabled = isBusy;
}

function setStatus(message, tone = "") {
  controls.status.textContent = message;
  controls.status.dataset.tone = tone;
}
