(function initContextTranslatorShared(global) {
  const PROVIDERS = {
    auto: {
      label: "Auto",
      endpoint: "",
      model: "",
      apiKeyRequired: false
    },
    deepseek: {
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKeyRequired: true
    },
    aliyun: {
      label: "阿里云百炼",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: "qwen3.6-plus",
      apiKeyRequired: true
    },
    openai: {
      label: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4.1-mini",
      apiKeyRequired: true
    },
    openrouter: {
      label: "OpenRouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "openai/gpt-4o-mini",
      modelsEndpoint: "https://openrouter.ai/api/v1/models",
      apiKeyRequired: true,
      headers: {
        "HTTP-Referer": "https://github.com/context-translator/local-extension",
        "X-Title": "Context Translator"
      }
    },
    chrome: {
      label: "Chrome 内置翻译",
      endpoint: "",
      model: "",
      apiType: "browser-translation",
      apiKeyRequired: false
    },
    libretranslate: {
      label: "LibreTranslate 本地",
      endpoint: "http://127.0.0.1:5000/translate",
      model: "",
      apiType: "machine-translation",
      apiKeyRequired: false
    },
    custom: {
      label: "自定义兼容接口",
      endpoint: "",
      model: "",
      apiKeyRequired: true
    }
  };

  const SELECTABLE_PROVIDERS = new Set(["auto", "custom"]);
  const SETTINGS_SCHEMA_VERSION = 3;
  const MODEL_CONFIG_STATUSES = new Set(["untested", "validating", "valid", "invalid"]);

  const DEFAULT_SETTINGS = {
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    provider: "custom",
    apiKey: "",
    apiKeys: {
      deepseek: "",
      aliyun: "",
      openai: "",
      openrouter: "",
      libretranslate: "",
      custom: ""
    },
    endpoint: "",
    model: "",
    modelConfigs: [],
    activeModelConfigId: "",
    targetLanguage: "简体中文",
    glossary: "",
    temperature: 0.1,
    speedMode: "accurate",
    translationStyle: "general",
    enableCache: true,
    showSelectionButton: true,
    enableGlossaryExtraction: true,
    enablePageSummary: true
  };

  const TRANSLATION_STYLES = {
    general: {
      label: "通用自然",
      instruction: "Use clear, natural language suitable for general web reading."
    },
    technical: {
      label: "技术文档",
      instruction: "Use precise technical terminology, keep API names, code identifiers, product names, and version strings stable."
    },
    business: {
      label: "正式商务",
      instruction: "Use polished, professional business language while keeping the meaning exact."
    },
    casual: {
      label: "自然口语",
      instruction: "Use fluent everyday wording, avoid stiff literal translation, and keep the tone easy to read."
    },
    academic: {
      label: "学术论文",
      instruction: "Use formal academic wording, preserve concepts and citations, and avoid casual phrasing."
    },
    product: {
      label: "产品介绍",
      instruction: "Use concise product copy, preserve feature names and brand terms, and make benefits readable."
    }
  };

  const SPEED_MODES = {
    fast: {
      label: "极速"
    },
    accurate: {
      label: "精准"
    }
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

  function normalizeSettings(stored = {}) {
    const storedSchemaVersion = Number(stored.settingsSchemaVersion || 0);
    const shouldResetInheritedModel = storedSchemaVersion < 1;
    const shouldResetUnpairedEndpoint = storedSchemaVersion < 1
      || (storedSchemaVersion < 2 && !String(stored.model || "").trim());
    const storedProvider = PROVIDERS[stored.provider] ? stored.provider : DEFAULT_SETTINGS.provider;
    const isLegacyProvider = !SELECTABLE_PROVIDERS.has(storedProvider);
    const provider = isLegacyProvider ? "custom" : storedProvider;
    const sourcePreset = PROVIDERS[storedProvider] || PROVIDERS.custom;
    const preset = isLegacyProvider ? sourcePreset : PROVIDERS[provider] || PROVIDERS.custom;
    const apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...(stored.apiKeys || {}) };

    if (stored.apiKey && storedProvider !== "auto" && !apiKeys[storedProvider]) {
      apiKeys[storedProvider] = stored.apiKey;
    }

    if (isLegacyProvider) {
      apiKeys.custom = apiKeys[storedProvider] || stored.apiKey || apiKeys.custom || "";
    }

    const endpoint = provider === "auto"
      ? stored.endpoint || DEFAULT_SETTINGS.endpoint
      : stored.endpoint || preset.endpoint || DEFAULT_SETTINGS.endpoint;
    const defaultModel = Object.prototype.hasOwnProperty.call(preset, "model")
      ? preset.model
      : DEFAULT_SETTINGS.model;
    const storedModel = provider === "auto"
      ? stored.model || DEFAULT_SETTINGS.model
      : isLegacyProvider
        ? stored.model || defaultModel
        : stored.model ?? defaultModel;
    const legacyEndpoint = shouldResetUnpairedEndpoint ? "" : String(endpoint || "").trim();
    const legacyModel = shouldResetInheritedModel
      ? ""
      : migrateModel(isLegacyProvider ? storedProvider : provider, storedModel);
    const hasStoredModelConfigs = Array.isArray(stored.modelConfigs);
    const modelConfigs = normalizeModelConfigs(hasStoredModelConfigs ? stored.modelConfigs : []);

    if (!hasStoredModelConfigs && storedSchemaVersion < SETTINGS_SCHEMA_VERSION) {
      modelConfigs.push(...buildLegacyModelConfigs({
        storedProvider,
        apiKeys,
        endpoint: legacyEndpoint,
        model: legacyModel
      }));
    }

    const dedupedModelConfigs = dedupeModelConfigs(modelConfigs);
    const requestedActiveId = String(stored.activeModelConfigId || "").trim();
    const requestedActive = dedupedModelConfigs.find((config) => config.id === requestedActiveId);
    const legacyActive = dedupedModelConfigs.find((config) => (
      config.provider === storedProvider
      || (config.model === legacyModel && config.endpoint === legacyEndpoint)
    ));
    const activeConfig = requestedActive || legacyActive || dedupedModelConfigs[0] || null;
    const activeModelConfigId = activeConfig?.id || "";

    if (activeConfig) {
      apiKeys.custom = activeConfig.apiKey;
    }

    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      apiKeys,
      provider,
      apiKey: provider === "auto" ? "" : activeConfig?.apiKey || apiKeys[provider] || "",
      endpoint: activeConfig?.endpoint || legacyEndpoint,
      model: activeConfig?.model || legacyModel,
      modelConfigs: dedupedModelConfigs,
      activeModelConfigId,
      settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
      targetLanguage: migrateLanguage(stored.targetLanguage || DEFAULT_SETTINGS.targetLanguage),
      speedMode: normalizeSpeedMode(stored.speedMode),
      translationStyle: normalizeTranslationStyle(stored.translationStyle),
      enableCache: stored.enableCache !== false,
      showSelectionButton: stored.showSelectionButton !== false,
      enableGlossaryExtraction: stored.enableGlossaryExtraction !== false,
      enablePageSummary: stored.enablePageSummary !== false
    };
  }

  function normalizeModelConfigs(configs) {
    if (!Array.isArray(configs)) {
      return [];
    }

    return configs
      .map((config, index) => normalizeModelConfig(config, index))
      .filter(isModelConfigComplete);
  }

  function normalizeModelConfig(config = {}, index = 0) {
    const model = String(config.model || "").trim();
    const endpoint = String(config.endpoint || "").trim();
    const apiKey = String(config.apiKey || "").trim();
    const id = String(config.id || `model-config-${index + 1}`).trim();
    const validationStatus = MODEL_CONFIG_STATUSES.has(config.validationStatus)
      ? config.validationStatus
      : "untested";

    return {
      id,
      model,
      endpoint,
      apiKey,
      provider: inferModelConfigProvider({ ...config, model, endpoint }),
      enabled: config.enabled !== false,
      validationStatus,
      validationMessage: String(config.validationMessage || "").trim().slice(0, 300),
      validatedAt: numberOrZero(config.validatedAt),
      createdAt: numberOrZero(config.createdAt),
      updatedAt: numberOrZero(config.updatedAt)
    };
  }

  function isModelConfigComplete(config) {
    return Boolean(config?.id && config.model && config.endpoint && config.apiKey);
  }

  function dedupeModelConfigs(configs) {
    const seenIds = new Set();
    const seenFingerprints = new Set();
    const result = [];

    for (const config of normalizeModelConfigs(configs)) {
      const fingerprint = `${config.model}\n${config.endpoint}\n${config.apiKey}`;
      if (seenIds.has(config.id) || seenFingerprints.has(fingerprint)) {
        continue;
      }
      seenIds.add(config.id);
      seenFingerprints.add(fingerprint);
      result.push(config);
    }

    return result;
  }

  function buildLegacyModelConfigs({ storedProvider, apiKeys, endpoint, model }) {
    const configs = [];
    const now = Date.now();

    for (const provider of ["deepseek", "aliyun", "openai", "openrouter"]) {
      const apiKey = String(apiKeys[provider] || "").trim();
      if (!apiKey) {
        continue;
      }

      configs.push(normalizeModelConfig({
        id: `legacy-${provider}`,
        provider,
        apiKey,
        endpoint: PROVIDERS[provider].endpoint,
        model: storedProvider === provider && model ? model : PROVIDERS[provider].model,
        validationStatus: "untested",
        createdAt: now,
        updatedAt: now
      }));
    }

    const customApiKey = String(apiKeys.custom || "").trim();
    if (customApiKey && endpoint && model) {
      configs.push(normalizeModelConfig({
        id: "legacy-custom",
        apiKey: customApiKey,
        endpoint,
        model,
        validationStatus: "untested",
        createdAt: now,
        updatedAt: now
      }));
    }

    return dedupeModelConfigs(configs);
  }

  function inferModelConfigProvider(config = {}) {
    const endpoint = String(config.endpoint || "").toLowerCase();
    const model = String(config.model || "").toLowerCase();
    const explicitProvider = String(config.provider || "").toLowerCase();

    if (["deepseek", "aliyun", "openai", "openrouter"].includes(explicitProvider)) {
      return explicitProvider;
    }
    if (endpoint.includes("api.deepseek.com") || model.startsWith("deepseek")) return "deepseek";
    if (endpoint.includes("dashscope.aliyuncs.com") || /^(qwen|glm|kimi|minimax)/i.test(model)) return "aliyun";
    if (endpoint.includes("api.openai.com") || /^(gpt|o[134]-)/i.test(model)) return "openai";
    if (endpoint.includes("openrouter.ai")) return "openrouter";
    return "custom";
  }

  function getActiveModelConfig(settings) {
    const configs = normalizeModelConfigs(settings?.modelConfigs);
    return configs.find((config) => config.id === settings?.activeModelConfigId) || configs[0] || null;
  }

  function normalizeTranslationStyle(style) {
    return TRANSLATION_STYLES[style] ? style : "general";
  }

  function normalizeSpeedMode(mode) {
    return mode === "fast" ? "fast" : "accurate";
  }

  function migrateModel(provider, model) {
    const value = String(model || "").trim();
    return LEGACY_MODEL_MIGRATIONS[provider]?.[value] || value;
  }

  function migrateLanguage(language) {
    const value = String(language || "").trim();
    return LANGUAGE_MIGRATIONS[value] || value;
  }

  function resolveEffectiveSettings(settings, payload = {}) {
    const normalized = normalizeSettings(settings);

    if (normalized.provider !== "auto") {
      const activeConfig = getActiveModelConfig(normalized);
      const preset = PROVIDERS[normalized.provider] || PROVIDERS.custom;
      return {
        ...normalized,
        resolvedProvider: activeConfig?.provider || normalized.provider,
        modelConfigId: activeConfig?.id || "",
        modelConfigValidationStatus: activeConfig?.validationStatus || "untested",
        modelConfigValidationMessage: activeConfig?.validationMessage || "",
        apiKey: activeConfig?.apiKey || normalized.apiKeys?.[normalized.provider] || normalized.apiKey || "",
        endpoint: activeConfig?.endpoint || normalized.endpoint || preset.endpoint,
        model: activeConfig?.model || migrateModel(normalized.provider, normalized.model || preset.model)
      };
    }

    const candidates = buildAutoCandidates(normalized);
    if (!candidates.length) {
      throw new Error("Auto 没有找到验证成功的模型配置，请先新增模型并完成 API Key 核验。");
    }

    const preferredModelConfigId = String(payload?.preferredModelConfigId || "").trim();
    const preferred = candidates.find((candidate) => candidate.id === preferredModelConfigId);
    const selected = preferred || selectAutoCandidate(candidates, normalized, payload);
    return {
      ...normalized,
      provider: "auto",
      resolvedProvider: selected.provider,
      modelConfigId: selected.id,
      autoRouteSource: preferred ? "task-lock" : "task-profile",
      modelConfigValidationStatus: selected.validationStatus,
      modelConfigValidationMessage: selected.validationMessage,
      apiKey: selected.apiKey,
      endpoint: selected.endpoint,
      model: selected.model
    };
  }

  function buildAutoCandidates(settings) {
    return normalizeModelConfigs(settings.modelConfigs)
      .filter((config) => config.enabled && config.validationStatus === "valid")
      .map((config) => ({ ...config }));
  }

  function selectAutoCandidate(candidates, settings, payload) {
    const totalChars = getPayloadCharacterCount(payload);
    const pageContext = payload?.pageContext || {};
    const pageProfile = normalizePageProfile(payload?.pageProfile || pageContext.pageProfile || {});
    const taskType = String(payload?.taskType || pageProfile.task || (Array.isArray(payload?.items) ? "page" : "selection"));
    const headingCount = Array.isArray(pageContext.headings) ? pageContext.headings.length : 0;
    const hasGlossary = Boolean(String(payload?.glossary || settings.glossary || "").trim());
    const speedMode = normalizeSpeedMode(payload?.speedMode || settings.speedMode);
    const targetLanguage = String(payload?.targetLanguage || settings.targetLanguage || "");
    const contextText = getAutoContextText(payload);
    const isTechnicalTask = pageProfile.technicalScore >= 5 || pageProfile.pageType === "technical" || /\b(api|sdk|cli|json|xml|html|css|react|vue|typescript|javascript|python|github|npm|bug|stack|trace|release|changelog)\b|接口|代码|函数|参数|报错|文档|开发|模型|仓库/i.test(contextText);
    const isArticleTask = pageProfile.pageType === "article" || pageProfile.pageType === "academic" || (pageProfile.isReaderable && pageProfile.articleCharCount >= 1200);
    const isProductTask = pageProfile.pageType === "product";
    const isUiDenseTask = pageProfile.pageType === "app" || pageProfile.linkDensity >= 0.42;
    const isLargeContextTask = totalChars > 4200 || headingCount > 18 || hasGlossary || pageProfile.complexity === "large" || pageProfile.articleCharCount > 5200;
    const isSelectionTask = taskType === "selection";
    const isGlossaryTask = taskType === "glossary";
    const isShortSelection = isSelectionTask && totalChars < 900;
    const targetIsChinese = /中文|Chinese/i.test(targetLanguage);
    const targetIsEnglish = /英语|English/i.test(targetLanguage);
    const dominantSourceIsEnglish = pageProfile.dominantScript === "latin" && pageProfile.latinRatio >= 0.58;
    const dominantSourceIsCjk = pageProfile.dominantScript === "cjk" && pageProfile.cjkRatio >= 0.48;

    const scored = candidates.map((candidate) => ({
      ...candidate,
      score: getProviderBaseScore(candidate.provider)
    }));

    for (const candidate of scored) {
      const modelName = String(candidate.model || "").toLowerCase();
      const isFastModel = /(flash|mini|turbo|lite|nano|instant|haiku|small)/.test(modelName);
      const isAccuracyModel = /(max|pro|plus|gpt-5|reason|thinking|r1|o[134]|opus|sonnet|large)/.test(modelName);
      const isCodeModel = /(coder|code|devstral|deepseek)/.test(modelName);
      const isLongContextModel = /(long|128k|200k|1m|max|plus|pro|large)/.test(modelName);
      const isMultilingualModel = /(qwen|glm|kimi|translate|translation|multilingual)/.test(modelName);
      if (speedMode === "fast" && candidate.provider === "deepseek") candidate.score += 5;
      if (speedMode === "fast" && candidate.provider === "aliyun") candidate.score += 4;
      if (speedMode === "fast" && candidate.provider === "openai") candidate.score -= 1;
      if (speedMode === "accurate" && candidate.provider === "openai") candidate.score += 4;
      if (speedMode === "accurate" && candidate.provider === "deepseek") candidate.score += 3;
      if (isTechnicalTask && candidate.provider === "deepseek") candidate.score += 7;
      if (isTechnicalTask && candidate.provider === "openai") candidate.score += 2;
      if (isTechnicalTask && candidate.provider === "openrouter") candidate.score += 2;
      if (isArticleTask && speedMode === "accurate" && candidate.provider === "openai") candidate.score += 5;
      if (isArticleTask && speedMode === "accurate" && candidate.provider === "openrouter") candidate.score += 3;
      if (isArticleTask && targetIsChinese && candidate.provider === "aliyun") candidate.score += 3;
      if (isProductTask && candidate.provider === "aliyun") candidate.score += 4;
      if (isProductTask && candidate.provider === "openai") candidate.score += 2;
      if (isUiDenseTask && candidate.provider === "deepseek") candidate.score += 3;
      if (isUiDenseTask && candidate.provider === "aliyun") candidate.score += 2;
      if (isUiDenseTask && candidate.provider === "openai") candidate.score -= 1;
      if (targetIsChinese && candidate.provider === "aliyun") candidate.score += 5;
      if (targetIsChinese && candidate.provider === "deepseek") candidate.score += 3;
      if (targetIsEnglish && candidate.provider === "openai") candidate.score += 5;
      if (targetIsEnglish && candidate.provider === "openrouter") candidate.score += 4;
      if (targetIsEnglish && candidate.provider === "deepseek") candidate.score += 2;
      if (isLargeContextTask && candidate.provider === "aliyun") candidate.score += 4;
      if (isLargeContextTask && candidate.provider === "deepseek") candidate.score += 2;
      if (isLargeContextTask && candidate.provider === "openrouter") candidate.score += 2;
      if (dominantSourceIsEnglish && targetIsChinese && candidate.provider === "aliyun") candidate.score += 2;
      if (dominantSourceIsEnglish && targetIsChinese && candidate.provider === "deepseek") candidate.score += 1;
      if (dominantSourceIsCjk && targetIsEnglish && candidate.provider === "openai") candidate.score += 2;
      if (isShortSelection && candidate.provider === "deepseek") candidate.score += 3;
      if (speedMode === "fast" && isFastModel) candidate.score += 6;
      if (speedMode === "fast" && isAccuracyModel) candidate.score -= 2;
      if (speedMode === "accurate" && isAccuracyModel) candidate.score += 5;
      if (isTechnicalTask && isCodeModel) candidate.score += 6;
      if (isLargeContextTask && isLongContextModel) candidate.score += 4;
      if (isShortSelection && isFastModel) candidate.score += 4;
      if (isGlossaryTask && isAccuracyModel) candidate.score += 3;
      if (targetIsChinese && isMultilingualModel) candidate.score += 2;
    }

    scored.sort((a, b) => b.score - a.score || getProviderBaseScore(b.provider) - getProviderBaseScore(a.provider));
    return scored[0];
  }

  function getPayloadCharacterCount(payload) {
    if (Array.isArray(payload?.items)) {
      return payload.items.reduce((sum, item) => sum + String(item?.text || "").length, 0);
    }

    return String(payload?.text || "").length;
  }

  function getAutoContextText(payload) {
    const pageContext = payload?.pageContext || {};
    const headings = Array.isArray(pageContext.headings) ? pageContext.headings.join(" ") : "";
    const bodySample = Array.isArray(payload?.items)
      ? payload.items.slice(0, 12).map((item) => item?.text || "").join(" ")
      : payload?.text || "";

    return [
      pageContext.title,
      pageContext.metaDescription,
      pageContext.openGraphTitle,
      pageContext.openGraphDescription,
      pageContext.pageTextSample,
      headings,
      bodySample
    ].filter(Boolean).join(" ");
  }

  function normalizePageProfile(profile = {}) {
    return {
      task: String(profile.task || ""),
      pageType: String(profile.pageType || ""),
      complexity: String(profile.complexity || ""),
      isReaderable: profile.isReaderable === true,
      articleCharCount: numberOrZero(profile.articleCharCount),
      totalTextChars: numberOrZero(profile.totalTextChars),
      technicalScore: numberOrZero(profile.technicalScore),
      linkDensity: numberOrZero(profile.linkDensity),
      codeDensity: numberOrZero(profile.codeDensity),
      dominantScript: String(profile.dominantScript || ""),
      cjkRatio: numberOrZero(profile.cjkRatio),
      latinRatio: numberOrZero(profile.latinRatio)
    };
  }

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function getProviderBaseScore(provider) {
    return {
      deepseek: 8,
      aliyun: 7,
      openai: 6,
      openrouter: 6,
      libretranslate: 5,
      custom: 4
    }[provider] || 0;
  }

  function getProviderLabel(provider) {
    return PROVIDERS[provider]?.label || provider || "";
  }

  function getProviderHeaders(provider) {
    return PROVIDERS[provider]?.headers || {};
  }

  function getTranslationStyleInstruction(style) {
    return TRANSLATION_STYLES[normalizeTranslationStyle(style)].instruction;
  }

  global.ContextTranslatorShared = {
    PROVIDERS,
    DEFAULT_SETTINGS,
    TRANSLATION_STYLES,
    SPEED_MODES,
    normalizeSettings,
    normalizeModelConfig,
    normalizeModelConfigs,
    normalizeTranslationStyle,
    normalizeSpeedMode,
    resolveEffectiveSettings,
    getActiveModelConfig,
    inferModelConfigProvider,
    getProviderLabel,
    getProviderHeaders,
    getTranslationStyleInstruction,
    migrateLanguage,
    migrateModel
  };
})(globalThis);
