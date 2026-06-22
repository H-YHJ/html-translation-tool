const {
  PROVIDERS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  getProviderLabel
} = globalThis.ContextTranslatorShared;

const controls = {
  provider: document.getElementById("provider"),
  apiKey: document.getElementById("apiKey"),
  apiKeyLabel: document.getElementById("apiKeyLabel"),
  toggleApiKey: document.getElementById("toggleApiKey"),
  endpoint: document.getElementById("endpoint"),
  model: document.getElementById("model"),
  modelLabel: document.getElementById("modelLabel"),
  refreshOpenRouterModels: document.getElementById("refreshOpenRouterModels"),
  openRouterModels: document.getElementById("openRouterModels"),
  targetLanguage: document.getElementById("targetLanguage"),
  glossary: document.getElementById("glossary"),
  speedMode: document.getElementById("speedMode"),
  translationStyle: document.getElementById("translationStyle"),
  enableCache: document.getElementById("enableCache"),
  showSelectionButton: document.getElementById("showSelectionButton"),
  enableGlossaryExtraction: document.getElementById("enableGlossaryExtraction"),
  enablePageSummary: document.getElementById("enablePageSummary"),
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
  const globalSettings = normalizeSettings(stored);
  settingsCache = globalSettings;
  activeProvider = settingsCache.provider;
  await chrome.storage.local.set(globalSettings);

  setFormValues(settingsCache);
  await loadCachedOpenRouterModels();

  controls.provider.addEventListener("change", handleProviderChange);
  controls.toggleApiKey.addEventListener("click", toggleApiKeyVisibility);
  controls.refreshOpenRouterModels.addEventListener("click", refreshOpenRouterModels);
  controls.saveSettings.addEventListener("click", saveSettings);
  controls.translatePage.addEventListener("click", () => runTabAction("TRANSLATE_PAGE"));
  controls.translateSelection.addEventListener("click", () => runTabAction("TRANSLATE_SELECTION"));
  controls.restorePage.addEventListener("click", () => runTabAction("RESTORE_PAGE", false));

  for (const key of [
    "targetLanguage",
    "glossary",
    "speedMode",
    "translationStyle",
    "enableCache",
    "showSelectionButton",
    "enableGlossaryExtraction",
    "enablePageSummary"
  ]) {
    controls[key].addEventListener("change", saveSettings);
  }
}

function setFormValues(settings) {
  const provider = settings.provider || DEFAULT_SETTINGS.provider;

  controls.provider.value = provider;
  controls.targetLanguage.value = settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;
  controls.glossary.value = settings.glossary || "";
  controls.speedMode.value = settings.speedMode || DEFAULT_SETTINGS.speedMode;
  controls.translationStyle.value = settings.translationStyle || DEFAULT_SETTINGS.translationStyle;
  controls.enableCache.checked = settings.enableCache !== false;
  controls.showSelectionButton.checked = settings.showSelectionButton !== false;
  controls.enableGlossaryExtraction.checked = settings.enableGlossaryExtraction !== false;
  controls.enablePageSummary.checked = settings.enablePageSummary !== false;
  applyProviderPresentation(provider, settings);
}

function getFormValues() {
  const provider = controls.provider.value;
  const preset = PROVIDERS[provider] || PROVIDERS.auto;
  const apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...(settingsCache.apiKeys || {}) };

  if (provider !== "auto") {
    apiKeys[provider] = controls.apiKey.value.trim();
  }

  return normalizeSettings({
    ...settingsCache,
    provider,
    apiKey: provider === "auto" ? "" : apiKeys[provider],
    apiKeys,
    endpoint: provider === "auto" ? settingsCache.endpoint : controls.endpoint.value.trim() || preset.endpoint,
    model: provider === "auto" ? settingsCache.model : controls.model.value.trim() || preset.model,
    targetLanguage: controls.targetLanguage.value,
    glossary: controls.glossary.value.trim(),
    speedMode: controls.speedMode.value,
    translationStyle: controls.translationStyle.value,
    enableCache: controls.enableCache.checked,
    showSelectionButton: controls.showSelectionButton.checked,
    enableGlossaryExtraction: controls.enableGlossaryExtraction.checked,
    enablePageSummary: controls.enablePageSummary.checked
  });
}

function handleProviderChange() {
  const nextProvider = controls.provider.value;
  const apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...(settingsCache.apiKeys || {}) };

  if (activeProvider !== "auto") {
    apiKeys[activeProvider] = controls.apiKey.value.trim();
  }

  const preset = PROVIDERS[nextProvider] || PROVIDERS.auto;
  const shouldUsePreset = nextProvider !== "auto" && nextProvider !== "custom";

  settingsCache = normalizeSettings({
    ...settingsCache,
    apiKeys,
    provider: nextProvider,
    apiKey: nextProvider === "auto" ? "" : apiKeys[nextProvider] || "",
    endpoint: shouldUsePreset ? preset.endpoint : settingsCache.endpoint,
    model: shouldUsePreset ? preset.model : settingsCache.model,
    targetLanguage: controls.targetLanguage.value,
    glossary: controls.glossary.value.trim(),
    speedMode: controls.speedMode.value,
    translationStyle: controls.translationStyle.value,
    enableCache: controls.enableCache.checked,
    showSelectionButton: controls.showSelectionButton.checked,
    enableGlossaryExtraction: controls.enableGlossaryExtraction.checked,
    enablePageSummary: controls.enablePageSummary.checked
  });

  activeProvider = nextProvider;
  applyProviderPresentation(nextProvider, settingsCache);
  setStatus(nextProvider === "auto" ? "已启用 Auto，将按任务选择已连接模型。" : `已切换到 ${getProviderLabel(nextProvider)}。`, "success");
}

function applyProviderPresentation(provider, settings) {
  const preset = PROVIDERS[provider] || PROVIDERS.auto;
  const isAuto = provider === "auto";
  const isChrome = provider === "chrome";
  const isLibreTranslate = provider === "libretranslate";
  document.body.dataset.provider = provider;

  controls.apiKeyLabel.textContent = isAuto ? "已连接密钥" : `${preset.label} API 密钥`;
  controls.apiKey.disabled = isAuto || isChrome;
  controls.apiKey.value = isAuto || isChrome ? "" : settings.apiKeys?.[provider] || settings.apiKey || "";
  controls.apiKey.placeholder = isLibreTranslate ? "本地服务通常不用填" : isAuto ? "使用已保存的服务密钥" : "sk-...";
  controls.toggleApiKey.disabled = isAuto || isChrome;

  controls.model.disabled = isAuto || isChrome;
  controls.endpoint.disabled = isAuto || isChrome;
  controls.refreshOpenRouterModels.disabled = provider !== "openrouter";
  controls.modelLabel.textContent = isLibreTranslate ? "模型（无）" : "模型";
  controls.model.placeholder = "";
  controls.model.value = isAuto || isChrome ? "自动选择" : settings.model || preset.model;
  controls.endpoint.value = isAuto || isChrome ? "自动选择" : settings.endpoint || preset.endpoint;

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

async function refreshOpenRouterModels() {
  setBusy(true);
  try {
    const apiKey = controls.provider.value === "openrouter" ? controls.apiKey.value.trim() : "";
    const response = await sendRuntimeMessage({
      type: "REFRESH_OPENROUTER_MODELS",
      payload: { apiKey }
    });

    populateOpenRouterModels(response.models || []);
    setStatus(response.fromCache ? "OpenRouter 模型刷新失败，已使用缓存列表。" : `已刷新 ${response.models.length} 个 OpenRouter 模型。`, response.fromCache ? "error" : "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function loadCachedOpenRouterModels() {
  const stored = await chrome.storage.local.get({ contextTranslatorOpenRouterModels: { models: [] } });
  populateOpenRouterModels(stored.contextTranslatorOpenRouterModels?.models || []);
}

function populateOpenRouterModels(models) {
  controls.openRouterModels.innerHTML = "";

  for (const model of models.slice(0, 300)) {
    const option = document.createElement("option");
    option.value = model.id;
    option.label = model.name || model.id;
    controls.openRouterModels.append(option);
  }
}

function isExtensionContextError(error) {
  const message = String(error?.message || error || "");
  return /Extension context invalidated|context invalidated|Receiving end does not exist/i.test(message);
}

function createExtensionReloadError() {
  return new Error("扩展已重新加载，请刷新当前网页后再试。");
}

async function sendRuntimeMessage(message) {
  let response;

  try {
    response = await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isExtensionContextError(error)) {
      throw createExtensionReloadError();
    }

    throw error;
  }

  if (!response?.ok) {
    throw new Error(response?.error || "后台操作失败。");
  }

  return response;
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
    if (isExtensionContextError(error)) {
      await ensureContentScript(tab.id, true);
      try {
        return await chrome.tabs.sendMessage(tab.id, message);
      } catch (retryError) {
        if (isExtensionContextError(retryError)) {
          throw createExtensionReloadError();
        }
      }
    }

    throw new Error("这个页面不支持内容脚本，请换一个普通 http/https 网页再试。");
  }
}

async function ensureContentScript(tabId, force = false) {
  if (!force) {
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
  const cacheSuffix = formatCacheSuffix(response);

  if (type === "TRANSLATE_PAGE") {
    return `已翻译 ${response.translated || 0} 段文本${providerSuffix}${cacheSuffix}。`;
  }

  if (type === "TRANSLATE_SELECTION") {
    return `已翻译选中文本${providerSuffix}${cacheSuffix}。`;
  }

  return "已恢复原文。";
}

function formatProviderSuffix(provider) {
  const label = getProviderLabel(provider);
  return label ? `，使用 ${label}` : "";
}

function formatCacheSuffix(response) {
  const parts = [];
  if (response.cached) {
    parts.push(`缓存命中 ${response.cached}`);
  }
  if (response.fallbackItems) {
    parts.push(`逐条补译 ${response.fallbackItems}`);
  }
  return parts.length ? `，${parts.join("，")}` : "";
}

function setBusy(isBusy) {
  controls.saveSettings.disabled = isBusy;
  controls.translatePage.disabled = isBusy;
  controls.translateSelection.disabled = isBusy;
  controls.restorePage.disabled = isBusy;
  controls.refreshOpenRouterModels.disabled = isBusy || controls.provider.value !== "openrouter";
}

function setStatus(message, tone = "") {
  controls.status.textContent = message;
  controls.status.dataset.tone = tone;
}
