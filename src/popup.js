const PROVIDERS = {
  auto: {
    label: "Auto",
    endpoint: "",
    model: ""
  },
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4.1-mini"
  },
  deepseek: {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-pro"
  },
  aliyun: {
    label: "阿里云百炼",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen3.6-plus"
  },
  custom: {
    label: "自定义接口",
    endpoint: "",
    model: ""
  }
};

const DEFAULT_SETTINGS = {
  provider: "auto",
  apiKey: "",
  apiKeys: {
    openai: "",
    deepseek: "",
    aliyun: "",
    custom: ""
  },
  endpoint: PROVIDERS.deepseek.endpoint,
  model: PROVIDERS.deepseek.model,
  targetLanguage: "简体中文",
  glossary: ""
};

const LEGACY_MODEL_MIGRATIONS = {
  aliyun: {
    "qwen3.7-max": "qwen3.6-plus",
    "qwen3.7max": "qwen3.6-plus"
  }
};

const LANGUAGE_MIGRATIONS = {
  "Simplified Chinese": "简体中文",
  "Traditional Chinese": "繁体中文",
  English: "英语",
  Japanese: "日语",
  Korean: "韩语",
  German: "德语",
  French: "法语",
  Spanish: "西班牙语"
};

const controls = {
  provider: document.getElementById("provider"),
  apiKey: document.getElementById("apiKey"),
  apiKeyLabel: document.getElementById("apiKeyLabel"),
  toggleApiKey: document.getElementById("toggleApiKey"),
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

let settingsCache = { ...DEFAULT_SETTINGS };
let activeProvider = DEFAULT_SETTINGS.provider;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  settingsCache = normalizeSettings(stored);
  activeProvider = settingsCache.provider;

  if (
    (stored.model && stored.model !== settingsCache.model) ||
    (stored.targetLanguage && stored.targetLanguage !== settingsCache.targetLanguage)
  ) {
    await chrome.storage.local.set(settingsCache);
  }

  setFormValues(settingsCache);

  controls.provider.addEventListener("change", handleProviderChange);
  controls.toggleApiKey.addEventListener("click", toggleApiKeyVisibility);
  controls.saveSettings.addEventListener("click", saveSettings);
  controls.translatePage.addEventListener("click", () => runTabAction("TRANSLATE_PAGE"));
  controls.translateSelection.addEventListener("click", () => runTabAction("TRANSLATE_SELECTION"));
  controls.restorePage.addEventListener("click", () => runTabAction("RESTORE_PAGE", false));

  for (const key of ["targetLanguage", "glossary"]) {
    controls[key].addEventListener("change", saveSettings);
  }
}

function normalizeSettings(stored) {
  const provider = stored.provider || DEFAULT_SETTINGS.provider;
  const preset = PROVIDERS[provider] || PROVIDERS.auto;
  const apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...(stored.apiKeys || {}) };
  const storedModel = stored.model || preset.model || DEFAULT_SETTINGS.model;
  const model = migrateModel(provider, storedModel);
  const targetLanguage = migrateLanguage(stored.targetLanguage || DEFAULT_SETTINGS.targetLanguage);

  if (stored.apiKey && provider !== "auto" && !apiKeys[provider]) {
    apiKeys[provider] = stored.apiKey;
  }

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    apiKeys,
    provider,
    apiKey: provider === "auto" ? "" : apiKeys[provider] || "",
    endpoint: stored.endpoint || preset.endpoint || DEFAULT_SETTINGS.endpoint,
    model,
    targetLanguage
  };
}

function migrateModel(provider, model) {
  const value = String(model || "").trim();
  return LEGACY_MODEL_MIGRATIONS[provider]?.[value] || value;
}

function migrateLanguage(language) {
  const value = String(language || "").trim();
  return LANGUAGE_MIGRATIONS[value] || value;
}

function setFormValues(settings) {
  const provider = settings.provider || DEFAULT_SETTINGS.provider;

  controls.provider.value = provider;
  controls.targetLanguage.value = settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;
  controls.glossary.value = settings.glossary || "";
  applyProviderPresentation(provider, settings);
}

function getFormValues() {
  const provider = controls.provider.value;
  const preset = PROVIDERS[provider] || PROVIDERS.auto;
  const apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...(settingsCache.apiKeys || {}) };

  if (provider !== "auto") {
    apiKeys[provider] = controls.apiKey.value.trim();
  }

  return {
    provider,
    apiKey: provider === "auto" ? "" : apiKeys[provider],
    apiKeys,
    endpoint: provider === "auto" ? settingsCache.endpoint : controls.endpoint.value.trim() || preset.endpoint,
    model: provider === "auto" ? settingsCache.model : controls.model.value.trim() || preset.model,
    targetLanguage: controls.targetLanguage.value,
    glossary: controls.glossary.value.trim()
  };
}

function handleProviderChange() {
  const nextProvider = controls.provider.value;
  const apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...(settingsCache.apiKeys || {}) };

  if (activeProvider !== "auto") {
    apiKeys[activeProvider] = controls.apiKey.value.trim();
  }

  settingsCache = {
    ...settingsCache,
    apiKeys,
    provider: nextProvider,
    apiKey: nextProvider === "auto" ? "" : apiKeys[nextProvider] || "",
    endpoint: nextProvider === "auto" ? settingsCache.endpoint : PROVIDERS[nextProvider].endpoint || settingsCache.endpoint,
    model: nextProvider === "auto" ? settingsCache.model : PROVIDERS[nextProvider].model || settingsCache.model,
    targetLanguage: controls.targetLanguage.value,
    glossary: controls.glossary.value.trim()
  };

  activeProvider = nextProvider;
  applyProviderPresentation(nextProvider, settingsCache);
  setStatus(nextProvider === "auto" ? "已启用 Auto，将按任务选择已连接模型。" : `已切换到 ${PROVIDERS[nextProvider].label}。`, "success");
}

function applyProviderPresentation(provider, settings) {
  const preset = PROVIDERS[provider] || PROVIDERS.auto;
  const isAuto = provider === "auto";

  controls.apiKeyLabel.textContent = isAuto ? "已连接密钥" : `${preset.label} API 密钥`;
  controls.apiKey.disabled = isAuto;
  controls.apiKey.value = isAuto ? "" : settings.apiKeys?.[provider] || settings.apiKey || "";
  controls.apiKey.placeholder = isAuto ? "使用已保存的服务密钥" : "sk-...";
  controls.toggleApiKey.disabled = isAuto;

  controls.model.disabled = isAuto;
  controls.endpoint.disabled = isAuto;
  controls.model.value = isAuto ? "自动选择" : settings.model || preset.model;
  controls.endpoint.value = isAuto ? "自动选择" : settings.endpoint || preset.endpoint;

  setApiKeyVisibility(false);
}

function toggleApiKeyVisibility() {
  setApiKeyVisibility(controls.apiKey.type === "password");
}

function setApiKeyVisibility(isVisible) {
  controls.apiKey.type = isVisible ? "text" : "password";
  controls.toggleApiKey.dataset.visible = String(isVisible);
  controls.toggleApiKey.title = isVisible ? "隐藏 API 密钥" : "显示 API 密钥";
  controls.toggleApiKey.setAttribute("aria-label", isVisible ? "隐藏 API 密钥" : "显示 API 密钥");
  controls.toggleApiKey.setAttribute("aria-pressed", String(isVisible));
}

async function saveSettings() {
  settingsCache = getFormValues();
  activeProvider = settingsCache.provider;
  await chrome.storage.local.set(settingsCache);
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
    throw new Error("这个页面不支持内容脚本，请换一个普通 http/https 网页再试。");
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
  const providerSuffix = formatProviderSuffix(response.provider);

  if (type === "TRANSLATE_PAGE") {
    return `已翻译 ${response.translated || 0} 段文本${providerSuffix}。`;
  }

  if (type === "TRANSLATE_SELECTION") {
    return `已翻译选中文本${providerSuffix}。`;
  }

  return "已恢复原文。";
}

function formatProviderSuffix(provider) {
  const labels = {
    deepseek: "，使用 DeepSeek",
    aliyun: "，使用阿里云百炼",
    openai: "，使用 OpenAI",
    custom: "，使用自定义接口"
  };

  return labels[provider] || "";
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
