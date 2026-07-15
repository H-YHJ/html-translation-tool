importScripts("shared.js");

const {
  DEFAULT_SETTINGS,
  getProviderHeaders,
  getProviderLabel,
  getTranslationStyleInstruction,
  normalizeSettings,
  resolveEffectiveSettings
} = globalThis.ContextTranslatorShared;

const CACHE_STORAGE_KEY = "contextTranslatorCache";
const OPENROUTER_MODELS_KEY = "contextTranslatorOpenRouterModels";
const MAX_CACHE_ENTRIES = 600;
const API_TIMEOUT_MS = 45_000;
const MODEL_VALIDATION_TIMEOUT_MS = 20_000;
const API_MAX_RETRIES = 2;
const MENU_TRANSLATE_SELECTION = "context-translator-translate-selection";

const inFlightRequests = new Map();
let modelValidationQueue = Promise.resolve();

class BatchShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = "BatchShapeError";
  }
}

class ModelValidationError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ModelValidationError";
    this.status = status;
  }
}

chrome.runtime.onInstalled.addListener(installContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_TRANSLATE_SELECTION || !tab?.id) {
    return;
  }

  const text = String(info.selectionText || "").trim();
  if (!text) {
    return;
  }

  sendMessageToTab(tab.id, {
    type: "TRANSLATE_GIVEN_TEXT",
    text
  }).catch((error) => console.warn("Context menu translation failed:", error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

function installContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_TRANSLATE_SELECTION,
      title: "用上下文翻译助手翻译",
      contexts: ["selection"]
    });
  });
}

async function sendMessageToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["vendor/Readability-readerable.js", "vendor/Readability.js", "src/contentScript.js"]
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    throw new Error("未知请求。");
  }

  if (message.type === "TRANSLATE_BATCH") {
    return translateBatch(message.payload);
  }

  if (message.type === "TRANSLATE_SELECTION") {
    return translateSelection(message.payload);
  }

  if (message.type === "EXTRACT_PAGE_GLOSSARY") {
    return extractPageGlossary(message.payload);
  }

  if (message.type === "GET_CACHE_STATS") {
    return getCacheStats();
  }

  if (message.type === "CLEAR_TRANSLATION_CACHE") {
    return clearTranslationCache(message.payload);
  }

  if (message.type === "REFRESH_OPENROUTER_MODELS") {
    return refreshOpenRouterModels(message.payload);
  }

  if (message.type === "VALIDATE_MODEL_CONFIG") {
    return enqueueModelConfigValidation(message.payload);
  }

  throw new Error(`不支持的请求：${message.type}`);
}

function enqueueModelConfigValidation(payload) {
  const task = modelValidationQueue.then(() => validateModelConfig(payload));
  modelValidationQueue = task.catch(() => undefined);
  return task;
}

async function getSettings(payload = {}) {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return resolveEffectiveSettings(normalizeSettings(stored), payload);
}

function getResolvedModelMeta(settings, source = {}) {
  return {
    provider: source.provider || settings.resolvedProvider || settings.provider,
    model: source.model || settings.model || "",
    modelConfigId: settings.modelConfigId || source.modelConfigId || ""
  };
}

async function translateBatch(payload) {
  const settings = await getSettings(payload);
  ensureReady(settings);

  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    return { translations: [], ...getResolvedModelMeta(settings) };
  }

  const cacheEnabled = payload?.enableCache !== false && settings.enableCache !== false;
  const cache = cacheEnabled ? await getTranslationCache() : {};
  const cachedTranslations = new Map();
  const missingItems = [];

  for (const item of items) {
    const cacheKey = cacheEnabled ? await buildCacheKey("page", settings, payload, item) : "";
    const cached = cacheKey ? cache[cacheKey] : null;

    if (cached?.translation) {
      cached.lastUsedAt = Date.now();
      cachedTranslations.set(String(item.id), cached.translation);
    } else {
      missingItems.push({ ...item, cacheKey });
    }
  }

  let fetchedTranslations = [];
  let fallbackItems = 0;

  if (missingItems.length) {
    const result = isMachineTranslationProvider(settings)
      ? await translateBatchWithMachineTranslation(settings, payload, missingItems)
      : await translateBatchWithFallback(settings, payload, missingItems);
    fetchedTranslations = result.translations;
    fallbackItems = result.fallbackItems;

    if (cacheEnabled) {
      for (const item of missingItems) {
        const translation = fetchedTranslations.find((translationItem) => String(translationItem.id) === String(item.id));
        if (item.cacheKey && translation?.translation) {
          cache[item.cacheKey] = createCacheEntry(translation.translation, settings, {
            pageContext: payload?.pageContext,
            uncertainty: translation.uncertainty || ""
          });
        }
      }
    }
  }

  if (cacheEnabled) {
    await setTranslationCache(cache);
  }

  const fetchedById = new Map(fetchedTranslations.map((item) => [String(item.id), item.translation]));
  const translations = items.map((item) => ({
    id: item.id,
    translation: cachedTranslations.get(String(item.id)) || fetchedById.get(String(item.id)) || item.text
  }));

  return {
    translations,
    ...getResolvedModelMeta(settings),
    cached: cachedTranslations.size,
    fallbackItems
  };
}

async function translateSelection(payload) {
  const settings = await getSettings(payload);
  ensureReady(settings);

  const text = String(payload?.text || "").trim();
  if (!text) {
    throw new Error("没有可翻译的选中文本。");
  }

  const cacheEnabled = payload?.enableCache !== false && settings.enableCache !== false;
  const cacheKey = cacheEnabled ? await buildCacheKey("selection", settings, payload, { text }) : "";

  if (cacheEnabled && cacheKey) {
    const cache = await getTranslationCache();
    const cached = cache[cacheKey];
    if (cached?.translation) {
      cached.lastUsedAt = Date.now();
      await setTranslationCache(cache);
      return {
        translation: cached.translation,
        notes: cached.notes || "",
        ...getResolvedModelMeta(settings, cached),
        cached: 1
      };
    }
  }

  let translation = "";
  let notes = "";

  if (isMachineTranslationProvider(settings)) {
    const translations = await translateTextsWithMachineTranslation(settings, payload, [{ id: "selection", text }]);
    translation = String(translations[0]?.translation || "").trim();
  } else {
    const content = await callChatCompletion(settings, buildSelectionMessages(settings, payload));
    const parsed = parseJsonFromModel(content);
    translation = String(parsed.translation || parsed.text || "").trim();
    notes = String(parsed.notes || parsed.explanation || "").trim();
  }

  if (!translation) {
    throw new BatchShapeError("模型没有返回有效译文。");
  }

  const response = {
    translation,
    notes,
    ...getResolvedModelMeta(settings)
  };

  if (cacheEnabled && cacheKey) {
    const cache = await getTranslationCache();
    cache[cacheKey] = createCacheEntry(response.translation, settings, {
      notes: response.notes,
      pageContext: payload?.pageContext
    });
    await setTranslationCache(cache);
  }

  return response;
}

async function extractPageGlossary(payload = {}) {
  const settings = await getSettings(payload);
  ensureReady(settings);

  if (isMachineTranslationProvider(settings)) {
    return {
      ...getResolvedModelMeta(settings),
      summary: "",
      domain: "",
      terms: [],
      uncertainties: []
    };
  }

  const pageContext = payload?.pageContext || {};
  const existingGlossary = payload?.glossary || settings.glossary || "";
  const content = await callChatCompletion(settings, buildGlossaryMessages(settings, {
    ...payload,
    pageContext,
    glossary: existingGlossary
  }));
  const parsed = parseJsonFromModel(content);
  const terms = normalizeGlossaryTerms(parsed?.terms);

  return {
    ...getResolvedModelMeta(settings),
    summary: String(parsed.summary || "").trim(),
    domain: String(parsed.domain || "").trim(),
    terms,
    uncertainties: normalizeUncertainties(parsed?.uncertainties)
  };
}

async function getCacheStats() {
  const cache = await getTranslationCache();
  const entries = Object.entries(cache);
  const sites = new Map();
  let bytes = 0;

  for (const [, entry] of entries) {
    bytes += approximateBytes(entry);
    const site = entry?.site || "未知站点";
    const current = sites.get(site) || { site, count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += approximateBytes(entry);
    sites.set(site, current);
  }

  return {
    count: entries.length,
    bytes,
    sites: Array.from(sites.values()).sort((a, b) => b.count - a.count)
  };
}

async function clearTranslationCache(payload = {}) {
  if (payload.site) {
    const cache = await getTranslationCache();
    const next = Object.fromEntries(
      Object.entries(cache).filter(([, entry]) => entry?.site !== payload.site)
    );
    await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: next });
    return getCacheStats();
  }

  await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: {} });
  return getCacheStats();
}

async function refreshOpenRouterModels(payload = {}) {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const settings = normalizeSettings(stored);
  const apiKey = String(payload.apiKey || settings.apiKeys?.openrouter || "").trim();
  const headers = {
    "Content-Type": "application/json",
    ...getProviderHeaders("openrouter")
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetchWithTimeout("https://openrouter.ai/api/v1/models", {
      method: "GET",
      headers
    }, API_TIMEOUT_MS);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter 模型列表请求失败 ${response.status}: ${trimForMessage(errorText)}`);
    }

    const data = await response.json();
    const models = normalizeOpenRouterModels(data);
    const cachedAt = Date.now();
    await chrome.storage.local.set({
      [OPENROUTER_MODELS_KEY]: {
        models,
        cachedAt
      }
    });

    return { models, cachedAt, fromCache: false };
  } catch (error) {
    const cached = await chrome.storage.local.get({ [OPENROUTER_MODELS_KEY]: { models: [], cachedAt: 0 } });
    const fallback = cached[OPENROUTER_MODELS_KEY];
    if (fallback.models?.length) {
      return { ...fallback, fromCache: true, warning: error.message || String(error) };
    }

    throw error;
  }
}

async function validateModelConfig(payload = {}) {
  const configId = String(payload.configId || "").trim();
  if (!configId) {
    throw new Error("缺少要核验的模型配置。");
  }

  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const settings = normalizeSettings(stored);
  const config = settings.modelConfigs.find((item) => item.id === configId);
  if (!config) {
    throw new Error("找不到要核验的模型配置。");
  }

  await persistModelValidation(config, {
    validationStatus: "validating",
    validationMessage: "正在核验 API Key 与模型...",
    validatedAt: 0
  });

  let result;
  try {
    result = await probeModelConfig(config);
  } catch (error) {
    result = {
      validationStatus: "invalid",
      validationMessage: formatModelValidationError(error, config.apiKey),
      validatedAt: Date.now()
    };
  }

  const persisted = await persistModelValidation(config, result);
  if (persisted.stale) {
    return {
      configId,
      validationStatus: "untested",
      validationMessage: "配置已发生变化，请重新核验。",
      validatedAt: 0,
      stale: true
    };
  }

  return {
    configId,
    validationStatus: result.validationStatus,
    validationMessage: result.validationMessage,
    validatedAt: result.validatedAt
  };
}

async function persistModelValidation(expectedConfig, patch) {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const settings = normalizeSettings(stored);
  const index = settings.modelConfigs.findIndex((item) => item.id === expectedConfig.id);
  const current = settings.modelConfigs[index];

  if (index < 0 || !sameModelConfigCredentials(current, expectedConfig)) {
    return { stale: true };
  }

  const modelConfigs = settings.modelConfigs.map((config, configIndex) => (
    configIndex === index ? { ...config, ...patch } : config
  ));
  await chrome.storage.local.set({ modelConfigs });
  return { stale: false };
}

function sameModelConfigCredentials(left, right) {
  return Boolean(left && right
    && left.id === right.id
    && left.model === right.model
    && left.endpoint === right.endpoint
    && left.apiKey === right.apiKey);
}

async function probeModelConfig(config) {
  const endpoint = parseValidationEndpoint(config.endpoint);
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    ...getProviderHeaders(config.provider)
  };
  return probeChatCompletion(config, endpoint, headers);
}

async function probeChatCompletion(config, endpoint, authHeaders) {
  const requestBody = {
    model: config.model,
    messages: [{ role: "user", content: "Reply only with OK." }],
    temperature: 0,
    max_tokens: 1,
    stream: false
  };
  let response = await sendModelValidationRequest(endpoint, authHeaders, requestBody);

  if (!response.ok && response.status === 400 && /max_tokens|temperature/i.test(response.text)) {
    response = await sendModelValidationRequest(endpoint, authHeaders, {
      model: config.model,
      messages: requestBody.messages,
      stream: false
    });
  }

  if (!response.ok) {
    throw createModelValidationHttpError(response.status, response.text);
  }

  return {
    validationStatus: "valid",
    validationMessage: "配置成功，API Key 与模型兼容。",
    validatedAt: Date.now()
  };
}

async function sendModelValidationRequest(endpoint, authHeaders, body) {
  const response = await fetchWithTimeout(endpoint.href, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders
    },
    body: JSON.stringify(body)
  }, MODEL_VALIDATION_TIMEOUT_MS);

  return {
    ok: response.ok,
    status: response.status,
    text: await response.text()
  };
}

function parseValidationEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint || "").trim());
  } catch (error) {
    throw new ModelValidationError("接口地址格式不正确。");
  }

  if (!/^https?:$/.test(url.protocol)) {
    throw new ModelValidationError("接口地址只支持 HTTP 或 HTTPS。");
  }

  return url;
}

function createModelValidationHttpError(status, responseText) {
  const apiMessage = extractApiErrorMessage(responseText);
  const message = {
    400: apiMessage ? `请求不兼容：${apiMessage}` : "请求格式与该模型不兼容。",
    401: "API Key 无效或已过期。",
    403: "API Key 没有访问该模型的权限。",
    404: "接口地址或模型名称不存在。",
    408: "核验请求超时。",
    429: "请求频率受限、额度不足或账户不可用。"
  }[status] || (apiMessage ? `接口返回错误：${apiMessage}` : `接口核验失败（HTTP ${status || "未知"}）。`);

  return new ModelValidationError(message, status);
}

function extractApiErrorMessage(responseText) {
  try {
    const data = JSON.parse(String(responseText || ""));
    return trimForMessage(data?.error?.message || data?.message || data?.error || "");
  } catch (error) {
    return trimForMessage(responseText);
  }
}

function formatModelValidationError(error, apiKey = "") {
  if (error?.name === "AbortError" || Number(error?.status) === 408) {
    return "配置失败：核验请求超时。";
  }
  if (error instanceof TypeError) {
    return "配置失败：无法连接接口，请检查地址、网络或跨域权限。";
  }

  const message = String(error?.message || error || "核验失败。").trim();
  return redactValidationSecret(`配置失败：${message}`, apiKey).slice(0, 300);
}

function redactValidationSecret(message, apiKey) {
  const secret = String(apiKey || "").trim();
  return secret ? String(message).split(secret).join("[API Key 已隐藏]") : String(message);
}

async function translateBatchWithMachineTranslation(settings, payload, items) {
  const translations = await translateTextsWithMachineTranslation(settings, payload, items);
  return {
    translations,
    fallbackItems: 0
  };
}

async function translateTextsWithMachineTranslation(settings, payload, items) {
  const chunks = createMachineTranslationChunks(settings, items);
  const translations = [];

  for (const chunk of chunks) {
    const texts = chunk.map((item) => item.text);
    const translatedTexts = await callMachineTranslationProvider(settings, payload, texts);

    for (let index = 0; index < chunk.length; index += 1) {
      translations.push({
        id: chunk[index].id,
        translation: translatedTexts[index] || chunk[index].text
      });
    }
  }

  return translations;
}

function createMachineTranslationChunks(settings, items) {
  const provider = getResolvedProvider(settings);
  const maxItems = provider === "libretranslate" ? 80 : 90;
  const maxChars = provider === "libretranslate" ? 24_000 : 45_000;
  const maxBytes = provider === "libretranslate" ? 60_000 : 95_000;
  const chunks = [];
  let current = [];
  let currentChars = 0;
  let currentBytes = 0;

  for (const item of items) {
    const text = String(item.text || "");
    const itemBytes = approximateBytes(text);
    const shouldFlush =
      current.length > 0 &&
      (current.length >= maxItems || currentChars + text.length > maxChars || currentBytes + itemBytes > maxBytes);

    if (shouldFlush) {
      chunks.push(current);
      current = [];
      currentChars = 0;
      currentBytes = 0;
    }

    current.push(item);
    currentChars += text.length;
    currentBytes += itemBytes;
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

async function callMachineTranslationProvider(settings, payload, texts) {
  const provider = getResolvedProvider(settings);

  if (provider === "libretranslate") {
    return callLibreTranslate(settings, payload, texts);
  }

  throw new Error(`不支持的专用翻译服务：${provider}`);
}

async function callLibreTranslate(settings, payload, texts) {
  const targetLanguage = getMachineTranslationTargetLanguage(settings, payload, "libretranslate");
  const body = {
    q: texts,
    source: "auto",
    target: targetLanguage,
    format: "text"
  };
  const apiKey = String(settings.apiKey || "").trim();

  if (apiKey) {
    body.api_key = apiKey;
  }

  const response = await fetchWithTimeout(settings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }, API_TIMEOUT_MS);

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`LibreTranslate 请求失败 ${response.status}: ${trimForMessage(errorText)}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const translatedText = data?.translatedText;

  if (Array.isArray(translatedText)) {
    return texts.map((text, index) => String(translatedText[index] || text));
  }

  if (typeof translatedText === "string") {
    return [translatedText];
  }

  throw new BatchShapeError("LibreTranslate 返回格式不正确。");
}

function getMachineTranslationTargetLanguage(settings, payload, provider) {
  const targetLanguage = String(payload?.targetLanguage || settings.targetLanguage || "").trim();
  const maps = {
    libretranslate: {
      "简体中文": "zh",
      "繁体中文": "zh",
      "英语": "en",
      "日语": "ja",
      "韩语": "ko",
      "德语": "de",
      "法语": "fr",
      "西班牙语": "es"
    }
  };

  if (maps[provider]?.[targetLanguage]) {
    return maps[provider][targetLanguage];
  }

  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(targetLanguage)) {
    return targetLanguage;
  }

  throw new Error(`${getProviderLabel(provider)} 暂不支持目标语言：${targetLanguage}`);
}

async function translateBatchWithFallback(settings, payload, items) {
  let lastError = null;
  const speedMode = getSpeedMode(settings, payload);
  const maxBatchRetries = speedMode === "fast" ? 0 : 2;

  for (let attempt = 0; attempt <= maxBatchRetries; attempt += 1) {
    try {
      const content = await callChatCompletion(settings, buildBatchMessages(settings, { ...payload, items }));
      const parsed = parseJsonFromModel(content);
      return {
        translations: normalizeBatchTranslationsStrict(parsed, items),
        fallbackItems: 0
      };
    } catch (error) {
      lastError = error;
      if (!(error instanceof BatchShapeError)) {
        throw error;
      }
    }
  }

  if (speedMode === "fast") {
    throw lastError;
  }

  const translations = [];
  for (const item of items) {
    translations.push(await translateSingleItemAfterBatchMismatch(settings, payload, item));
  }

  return {
    translations,
    fallbackItems: items.length,
    fallbackReason: lastError?.message || ""
  };
}

function getSpeedMode(settings, payload = {}) {
  const mode = payload?.speedMode || settings.speedMode || DEFAULT_SETTINGS.speedMode;
  return mode === "fast" ? "fast" : "accurate";
}

async function translateSingleItemAfterBatchMismatch(settings, payload, item) {
  try {
    const content = await callChatCompletion(settings, buildSingleItemMessages(settings, payload, item));
    const parsed = parseJsonFromModel(content);
    const translation = String(parsed.translation || parsed.text || "").trim();
    if (!translation) {
      throw new BatchShapeError("单条补译没有返回有效译文。");
    }

    return {
      id: item.id,
      translation,
      uncertainty: String(parsed.uncertainty || "").trim()
    };
  } catch (error) {
    if (error instanceof BatchShapeError || error instanceof SyntaxError) {
      return {
        id: item.id,
        translation: item.text
      };
    }

    throw error;
  }
}

function ensureReady(settings) {
  if (!isApiKeyOptionalProvider(settings) && (!settings.apiKey || !settings.apiKey.trim())) {
    throw new Error(`请先填写 ${settings.resolvedProvider || settings.provider} 的 API 密钥。`);
  }

  if (!settings.endpoint || !settings.endpoint.trim()) {
    throw new Error("请先设置接口地址。");
  }

  if (isMachineTranslationProvider(settings)) {
    return;
  }

  if (!settings.model || !settings.model.trim()) {
    throw new Error("请先设置模型名称。");
  }
}

function getResolvedProvider(settings) {
  return settings.resolvedProvider || settings.provider;
}

function isMachineTranslationProvider(settingsOrProvider) {
  const provider = typeof settingsOrProvider === "string"
    ? settingsOrProvider
    : getResolvedProvider(settingsOrProvider || {});

  return provider === "libretranslate";
}

function isApiKeyOptionalProvider(settingsOrProvider) {
  const provider = typeof settingsOrProvider === "string"
    ? settingsOrProvider
    : getResolvedProvider(settingsOrProvider || {});

  return provider === "libretranslate";
}

async function callChatCompletion(settings, messages) {
  const requestKey = await sha256(JSON.stringify({
    endpoint: settings.endpoint,
    model: settings.model,
    temperature: settings.temperature,
    messages
  }));

  if (inFlightRequests.has(requestKey)) {
    return inFlightRequests.get(requestKey);
  }

  const promise = callChatCompletionWithRetry(settings, messages);
  inFlightRequests.set(requestKey, promise);

  try {
    return await promise;
  } finally {
    inFlightRequests.delete(requestKey);
  }
}

async function callChatCompletionWithRetry(settings, messages) {
  let lastError = null;

  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt += 1) {
    try {
      return await callChatCompletionOnce(settings, messages);
    } catch (error) {
      lastError = error;
      if (!isRetryableApiError(error) || attempt >= API_MAX_RETRIES) {
        throw error;
      }

      await sleep(800 * 2 ** attempt);
    }
  }

  throw lastError;
}

async function callChatCompletionOnce(settings, messages) {
  const body = {
    model: settings.model.trim(),
    temperature: Number(settings.temperature) || DEFAULT_SETTINGS.temperature,
    messages
  };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey.trim()}`,
    ...getProviderHeaders(settings.resolvedProvider || settings.provider)
  };

  const response = await fetchWithTimeout(settings.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  }, API_TIMEOUT_MS);

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`API 请求失败 ${response.status}: ${trimForMessage(errorText)}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const content =
    data?.choices?.[0]?.message?.content ||
    data?.output_text ||
    flattenResponsesOutput(data?.output);

  if (!content) {
    throw new BatchShapeError("API 没有返回可读取的文本。");
  }

  return content;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("API 请求超时。");
      timeoutError.status = 408;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildBatchMessages(settings, payload) {
  const targetLanguage = payload?.targetLanguage || settings.targetLanguage;
  const speedMode = getSpeedMode(settings, payload);
  const pageContext = compactPageContext(payload?.pageContext || {}, getContextLimits("batch", speedMode));
  const glossary = payload?.glossary || settings.glossary || "";
  const styleInstruction = getTranslationStyleInstruction(payload?.translationStyle || settings.translationStyle);
  const shouldMarkUncertainty = speedMode !== "fast";
  const items = payload.items.map((item) => ({
    id: item.id,
    text: item.text,
    tag: item.tag,
    section: item.section
  }));

  return [
    {
      role: "system",
      content: [
        "You are a senior web translation editor.",
        "Translate by meaning, not word-for-word.",
        styleInstruction,
        speedMode === "fast"
          ? "Prioritize low latency and concise translations while preserving the exact meaning."
          : "Use page title, metadata, headings, page summary, confirmed glossary, page text sample, and nearby section labels to resolve ambiguous terms.",
        "Preserve product names, proper nouns, numbers, URLs, code-like tokens, and UI placeholders unless translation is clearly required.",
        "Keep each translation concise enough to fit back into the original web page.",
        shouldMarkUncertainty
          ? "If a source phrase is genuinely ambiguous, include a short \"uncertainty\" reason for that item; otherwise omit it."
          : "Do not include explanations.",
        "Return only valid JSON with this exact shape: {\"items\":[{\"id\":\"same id\",\"translation\":\"translated text\",\"uncertainty\":\"optional short reason\"}]}."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          targetLanguage,
          glossary,
          pageContext,
          items
        },
        null,
        2
      )
    }
  ];
}

function buildSingleItemMessages(settings, payload, item) {
  const targetLanguage = payload?.targetLanguage || settings.targetLanguage;
  const speedMode = getSpeedMode(settings, payload);
  const pageContext = compactPageContext(payload?.pageContext || {}, getContextLimits("single", speedMode));
  const glossary = payload?.glossary || settings.glossary || "";
  const styleInstruction = getTranslationStyleInstruction(payload?.translationStyle || settings.translationStyle);

  return [
    {
      role: "system",
      content: [
        "You are a senior web translation editor.",
        styleInstruction,
        "Translate the provided web text using the page context and section label.",
        "If the translation is genuinely ambiguous, include \"uncertainty\" with a short reason.",
        "Return only valid JSON with this shape: {\"translation\":\"translated text\",\"uncertainty\":\"optional short reason\"}."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          targetLanguage,
          glossary,
          pageContext,
          item: {
            text: item.text,
            tag: item.tag,
            section: item.section
          }
        },
        null,
        2
      )
    }
  ];
}

function buildSelectionMessages(settings, payload) {
  const targetLanguage = payload?.targetLanguage || settings.targetLanguage;
  const speedMode = getSpeedMode(settings, payload);
  const pageContext = compactPageContext(payload?.pageContext || {}, getContextLimits("selection", speedMode));
  const glossary = payload?.glossary || settings.glossary || "";
  const styleInstruction = getTranslationStyleInstruction(payload?.translationStyle || settings.translationStyle);

  return [
    {
      role: "system",
      content: [
        "You are a senior web translation editor.",
        styleInstruction,
        "Translate the selected text using the surrounding page context.",
        "If the source contains jargon, infer the domain from the page context.",
        "Return only valid JSON with this shape: {\"translation\":\"translated text\",\"notes\":\"optional short note\"}."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          targetLanguage,
          glossary,
          pageContext,
          selectedText: payload?.text || ""
        },
        null,
        2
      )
    }
  ];
}

function buildGlossaryMessages(settings, payload) {
  const pageContext = payload?.pageContext || {};
  const targetLanguage = payload?.targetLanguage || settings.targetLanguage;
  const existingGlossary = payload?.glossary || settings.glossary || "";
  const styleInstruction = getTranslationStyleInstruction(payload?.translationStyle || settings.translationStyle);
  const speedMode = getSpeedMode(settings, payload);
  const glossarySampleLimit = speedMode === "accurate" ? 4200 : 2600;

  return [
    {
      role: "system",
      content: [
        "You are a terminology editor preparing a webpage translation.",
        styleInstruction,
        "Extract only terms that are useful for consistent translation: product names, organization names, proper nouns, acronyms, technical terms, UI terms, and domain-specific phrases.",
        "Do not include common words.",
        "Suggest a concise target-language rendering only when translation is appropriate; preserve names that should stay unchanged.",
        "Also summarize the page topic in one or two sentences for translation context.",
        "Return only valid JSON with this shape: {\"summary\":\"short page summary\",\"domain\":\"domain label\",\"terms\":[{\"source\":\"term\",\"target\":\"suggested translation or same term\",\"type\":\"product|proper-noun|acronym|technical|ui|domain\",\"note\":\"short reason\"}],\"uncertainties\":[{\"source\":\"ambiguous term\",\"reason\":\"why uncertain\"}]}."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          targetLanguage,
          existingGlossary,
          pageContext: {
            url: pageContext.url,
            title: pageContext.title,
            htmlLang: pageContext.htmlLang,
            metaDescription: pageContext.metaDescription,
            openGraphTitle: pageContext.openGraphTitle,
            openGraphDescription: pageContext.openGraphDescription,
            headings: Array.isArray(pageContext.headings) ? pageContext.headings.slice(0, 60) : [],
            pageTextSample: String(pageContext.pageTextSample || "").slice(0, glossarySampleLimit)
          }
        },
        null,
        2
      )
    }
  ];
}

function getContextLimits(kind, speedMode) {
  const table = {
    fast: {
      batch: { headingLimit: 8, textLimit: 360, summaryLimit: 220, termsLimit: 10 },
      single: { headingLimit: 6, textLimit: 240, summaryLimit: 160, termsLimit: 8 },
      selection: { headingLimit: 6, textLimit: 320, summaryLimit: 200, termsLimit: 8 }
    },
    accurate: {
      batch: { headingLimit: 36, textLimit: 2200, summaryLimit: 1000, termsLimit: 40 },
      single: { headingLimit: 18, textLimit: 1400, summaryLimit: 700, termsLimit: 30 },
      selection: { headingLimit: 18, textLimit: 1400, summaryLimit: 700, termsLimit: 30 }
    }
  };

  return table[speedMode]?.[kind] || table.accurate[kind];
}

function compactPageContext(pageContext = {}, limits = {}) {
  const headingLimit = limits.headingLimit ?? 20;
  const textLimit = limits.textLimit ?? 1200;
  const summaryLimit = limits.summaryLimit ?? 600;
  const termsLimit = limits.termsLimit ?? 25;

  return {
    url: pageContext.url || "",
    title: pageContext.title || "",
    htmlLang: pageContext.htmlLang || "",
    metaDescription: String(pageContext.metaDescription || "").slice(0, 260),
    openGraphTitle: pageContext.openGraphTitle || "",
    openGraphDescription: String(pageContext.openGraphDescription || "").slice(0, 260),
    headings: Array.isArray(pageContext.headings) ? pageContext.headings.slice(0, headingLimit) : [],
    pageSummary: String(pageContext.pageSummary || "").slice(0, summaryLimit),
    glossaryTerms: Array.isArray(pageContext.glossaryTerms) ? pageContext.glossaryTerms.slice(0, termsLimit) : [],
    pageTextSample: textLimit > 0 ? String(pageContext.pageTextSample || "").slice(0, textLimit) : ""
  };
}

function parseJsonFromModel(content) {
  const text = stripJsonCodeFence(String(content || "").trim());

  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new BatchShapeError("模型返回的不是 JSON。");
    }

    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (parseError) {
      throw new BatchShapeError("模型返回的 JSON 无法解析。");
    }
  }
}

function stripJsonCodeFence(text) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeBatchTranslationsStrict(parsed, requestedItems) {
  const rawItems = Array.isArray(parsed?.items)
    ? parsed.items
    : Array.isArray(parsed?.translations)
      ? parsed.translations
      : null;

  if (!rawItems) {
    throw new BatchShapeError("模型返回 JSON 中缺少 items 数组。");
  }

  const byId = new Map();
  for (const item of rawItems) {
    if (!item || item.id == null) {
      continue;
    }

    const translation = String(item.translation || item.text || "").trim();
    if (translation) {
      byId.set(String(item.id), {
        translation,
        uncertainty: String(item.uncertainty || item.reason || "").trim()
      });
    }
  }

  const missingIds = requestedItems
    .map((item) => String(item.id))
    .filter((id) => !byId.has(id));

  if (missingIds.length) {
    throw new BatchShapeError(`模型返回缺少 ${missingIds.length} 条译文。`);
  }

  return requestedItems.map((item) => ({
    id: item.id,
    translation: byId.get(String(item.id))?.translation,
    uncertainty: byId.get(String(item.id))?.uncertainty || ""
  }));
}

async function getTranslationCache() {
  const stored = await chrome.storage.local.get({ [CACHE_STORAGE_KEY]: {} });
  return stored[CACHE_STORAGE_KEY] || {};
}

async function setTranslationCache(cache) {
  const entries = Object.entries(cache)
    .sort((a, b) => (b[1]?.lastUsedAt || b[1]?.createdAt || 0) - (a[1]?.lastUsedAt || a[1]?.createdAt || 0))
    .slice(0, MAX_CACHE_ENTRIES);

  await chrome.storage.local.set({
    [CACHE_STORAGE_KEY]: Object.fromEntries(entries)
  });
}

function createCacheEntry(translation, settings, options = {}) {
  const now = Date.now();
  const pageContext = options.pageContext || {};
  return {
    translation,
    notes: options.notes || "",
    uncertainty: options.uncertainty || "",
    provider: settings.resolvedProvider || settings.provider,
    model: settings.model,
    site: normalizeHost(pageContext.url || ""),
    url: pageContext.url || "",
    createdAt: now,
    lastUsedAt: now
  };
}

function normalizeGlossaryTerms(rawTerms) {
  if (!Array.isArray(rawTerms)) {
    return [];
  }

  const seen = new Set();
  const terms = [];

  for (const raw of rawTerms) {
    const source = String(raw?.source || raw?.term || "").trim();
    if (!source || seen.has(source.toLowerCase())) {
      continue;
    }

    seen.add(source.toLowerCase());
    terms.push({
      source,
      target: String(raw?.target || raw?.translation || source).trim(),
      type: String(raw?.type || "domain").trim(),
      note: String(raw?.note || raw?.reason || "").trim(),
      enabled: raw?.enabled !== false
    });

    if (terms.length >= 40) {
      break;
    }
  }

  return terms;
}

function normalizeUncertainties(rawItems) {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  return rawItems
    .map((item) => ({
      source: String(item?.source || item?.term || "").trim(),
      reason: String(item?.reason || item?.note || "").trim()
    }))
    .filter((item) => item.source && item.reason)
    .slice(0, 20);
}

function normalizeOpenRouterModels(data) {
  const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return rawModels
    .map((model) => ({
      id: String(model?.id || "").trim(),
      name: String(model?.name || model?.id || "").trim(),
      contextLength: Number(model?.context_length || model?.contextLength || 0) || 0,
      pricing: model?.pricing || null
    }))
    .filter((model) => model.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeHost(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  try {
    return new URL(text.includes("://") ? text : `https://${text}`).host;
  } catch (error) {
    return text.replace(/^https?:\/\//i, "").split("/")[0];
  }
}

function approximateBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value || {})).length;
}

async function buildCacheKey(kind, settings, payload, item) {
  const pageContext = payload?.pageContext || {};
  const speedMode = getSpeedMode(settings, payload);
  const cacheContext = compactPageContext(pageContext, {
    headingLimit: 8,
    textLimit: 0,
    summaryLimit: 360,
    termsLimit: 20
  });
  const basis = {
    version: 4,
    kind,
    provider: settings.resolvedProvider || settings.provider,
    model: settings.model,
    targetLanguage: payload?.targetLanguage || settings.targetLanguage,
    glossary: payload?.glossary || settings.glossary || "",
    speedMode,
    translationStyle: payload?.translationStyle || settings.translationStyle || "",
    source: {
      text: item.text,
      tag: item.tag || "",
      section: item.section || ""
    },
    context: {
      host: normalizeHost(pageContext.url || ""),
      title: cacheContext.title,
      metaDescription: cacheContext.metaDescription,
      headings: cacheContext.headings,
      pageSummary: cacheContext.pageSummary,
      glossaryTerms: cacheContext.glossaryTerms
    }
  };

  return sha256(JSON.stringify(basis));
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isRetryableApiError(error) {
  const status = Number(error?.status || 0);
  return status === 408 || status === 429 || status >= 500 || error instanceof TypeError;
}

function flattenResponsesOutput(output) {
  if (!Array.isArray(output)) {
    return "";
  }

  return output
    .flatMap((part) => (Array.isArray(part?.content) ? part.content : []))
    .map((content) => content?.text || "")
    .filter(Boolean)
    .join("\n");
}

function trimForMessage(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
