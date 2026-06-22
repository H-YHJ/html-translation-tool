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
      label: "自定义接口",
      endpoint: "",
      model: "",
      apiKeyRequired: true
    }
  };

  const DEFAULT_SETTINGS = {
    provider: "auto",
    apiKey: "",
    apiKeys: {
      deepseek: "",
      aliyun: "",
      openai: "",
      openrouter: "",
      libretranslate: "",
      custom: ""
    },
    endpoint: PROVIDERS.deepseek.endpoint,
    model: PROVIDERS.deepseek.model,
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
    const provider = PROVIDERS[stored.provider] ? stored.provider : DEFAULT_SETTINGS.provider;
    const preset = PROVIDERS[provider] || PROVIDERS.auto;
    const apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...(stored.apiKeys || {}) };

    if (stored.apiKey && provider !== "auto" && !apiKeys[provider]) {
      apiKeys[provider] = stored.apiKey;
    }

    const endpoint = provider === "auto"
      ? stored.endpoint || DEFAULT_SETTINGS.endpoint
      : stored.endpoint || preset.endpoint || DEFAULT_SETTINGS.endpoint;
    const defaultModel = Object.prototype.hasOwnProperty.call(preset, "model")
      ? preset.model
      : DEFAULT_SETTINGS.model;
    const storedModel = provider === "auto"
      ? stored.model || DEFAULT_SETTINGS.model
      : stored.model ?? defaultModel;

    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      apiKeys,
      provider,
      apiKey: provider === "auto" ? "" : apiKeys[provider] || "",
      endpoint,
      model: migrateModel(provider, storedModel),
      targetLanguage: migrateLanguage(stored.targetLanguage || DEFAULT_SETTINGS.targetLanguage),
      speedMode: normalizeSpeedMode(stored.speedMode),
      translationStyle: normalizeTranslationStyle(stored.translationStyle),
      enableCache: stored.enableCache !== false,
      showSelectionButton: stored.showSelectionButton !== false,
      enableGlossaryExtraction: stored.enableGlossaryExtraction !== false,
      enablePageSummary: stored.enablePageSummary !== false
    };
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
      const preset = PROVIDERS[normalized.provider] || PROVIDERS.deepseek;
      return {
        ...normalized,
        resolvedProvider: normalized.provider,
        apiKey: normalized.apiKeys?.[normalized.provider] || normalized.apiKey || "",
        endpoint: normalized.endpoint || preset.endpoint,
        model: migrateModel(normalized.provider, normalized.model || preset.model)
      };
    }

    const candidates = buildAutoCandidates(normalized);
    if (!candidates.length) {
      throw new Error("Auto 没有找到已保存的 API 密钥，请先为 DeepSeek、阿里云百炼、OpenAI 或 OpenRouter 保存密钥，或改用 Chrome 内置翻译/LibreTranslate 本地。");
    }

    const selected = selectAutoCandidate(candidates, normalized, payload);
    return {
      ...normalized,
      provider: "auto",
      resolvedProvider: selected.provider,
      apiKey: selected.apiKey,
      endpoint: selected.endpoint,
      model: selected.model
    };
  }

  function buildAutoCandidates(settings) {
    const apiKeys = settings.apiKeys || {};
    const candidates = [];

    for (const provider of ["deepseek", "aliyun", "openai", "openrouter"]) {
      const apiKey = String(apiKeys[provider] || "").trim();
      if (!apiKey) {
        continue;
      }

      candidates.push({
        provider,
        apiKey,
        endpoint: PROVIDERS[provider].endpoint,
        model: PROVIDERS[provider].model
      });
    }

    const customApiKey = String(apiKeys.custom || "").trim();
    if (customApiKey && settings.endpoint && settings.model) {
      candidates.push({
        provider: "custom",
        apiKey: customApiKey,
        endpoint: settings.endpoint,
        model: settings.model
      });
    }

    return candidates;
  }

  function selectAutoCandidate(candidates, settings, payload) {
    const totalChars = getPayloadCharacterCount(payload);
    const pageContext = payload?.pageContext || {};
    const headingCount = Array.isArray(pageContext.headings) ? pageContext.headings.length : 0;
    const hasGlossary = Boolean(String(payload?.glossary || settings.glossary || "").trim());
    const speedMode = normalizeSpeedMode(payload?.speedMode || settings.speedMode);
    const targetLanguage = String(payload?.targetLanguage || settings.targetLanguage || "");
    const contextText = getAutoContextText(payload);
    const isTechnicalTask = /\b(api|sdk|cli|json|xml|html|css|react|vue|typescript|javascript|python|github|npm|bug|stack|trace|release|changelog)\b|接口|代码|函数|参数|报错|文档|开发|模型|仓库/i.test(contextText);
    const isLargeContextTask = totalChars > 4200 || headingCount > 18 || hasGlossary;
    const isShortSelection = !Array.isArray(payload?.items) && totalChars < 900;
    const targetIsChinese = /中文|Chinese/i.test(targetLanguage);
    const targetIsEnglish = /英语|English/i.test(targetLanguage);

    const scored = candidates.map((candidate) => ({
      ...candidate,
      score: getProviderBaseScore(candidate.provider)
    }));

    for (const candidate of scored) {
      if (speedMode === "fast" && candidate.provider === "deepseek") candidate.score += 5;
      if (speedMode === "fast" && candidate.provider === "aliyun") candidate.score += 4;
      if (speedMode === "fast" && candidate.provider === "openai") candidate.score -= 1;
      if (speedMode === "accurate" && candidate.provider === "openai") candidate.score += 4;
      if (speedMode === "accurate" && candidate.provider === "deepseek") candidate.score += 3;
      if (isTechnicalTask && candidate.provider === "deepseek") candidate.score += 6;
      if (isTechnicalTask && candidate.provider === "openai") candidate.score += 2;
      if (isTechnicalTask && candidate.provider === "openrouter") candidate.score += 2;
      if (targetIsChinese && candidate.provider === "aliyun") candidate.score += 5;
      if (targetIsChinese && candidate.provider === "deepseek") candidate.score += 3;
      if (targetIsEnglish && candidate.provider === "openai") candidate.score += 5;
      if (targetIsEnglish && candidate.provider === "openrouter") candidate.score += 4;
      if (targetIsEnglish && candidate.provider === "deepseek") candidate.score += 2;
      if (isLargeContextTask && candidate.provider === "aliyun") candidate.score += 4;
      if (isLargeContextTask && candidate.provider === "deepseek") candidate.score += 2;
      if (isShortSelection && candidate.provider === "deepseek") candidate.score += 3;
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
    normalizeTranslationStyle,
    normalizeSpeedMode,
    resolveEffectiveSettings,
    getProviderLabel,
    getProviderHeaders,
    getTranslationStyleInstruction,
    migrateLanguage,
    migrateModel
  };
})(globalThis);
