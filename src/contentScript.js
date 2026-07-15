(() => {
  const CONTENT_SCRIPT_INSTANCE = chrome.runtime?.id || "context-translator";

  if (window.__contextTranslatorLoaded === CONTENT_SCRIPT_INSTANCE) {
    return;
  }

  window.__contextTranslatorLoaded = CONTENT_SCRIPT_INSTANCE;

  const SKIP_SELECTOR = [
    "script",
    "style",
    "noscript",
    "template",
    "code",
    "pre",
    "kbd",
    "samp",
    "textarea",
    "input",
    "select",
    "option",
    "svg",
    "canvas",
    "[aria-hidden='true']",
    "[data-context-translator-ignore]"
  ].join(",");

  const DEFAULT_CONTENT_OPTIONS = {
    provider: "auto",
    targetLanguage: "简体中文",
    glossary: "",
    speedMode: "accurate",
    translationStyle: "general",
    enableCache: true,
    showSelectionButton: true,
    enableGlossaryExtraction: true,
    enablePageSummary: true
  };

  const MAX_TEXT_NODES = 450;
  const MAX_CHARS_PER_NODE = 1200;
  const MAX_BATCH_CHARS = 6000;
  const MAX_BATCH_ITEMS = 32;
  const PAGE_CONTEXT_CHAR_LIMIT = 2200;
  const SELECTION_CHAR_LIMIT = 3000;
  const READABILITY_TEXT_SAMPLE_LIMIT = 2400;
  const PROFILE_TEXT_SAMPLE_LIMIT = 6000;
  const PROFILE_KEYWORD_LIMIT = 16;
  const chromeTranslatorCache = new Map();

  const state = {
    translatedNodes: [],
    translatedNodeSet: new WeakSet(),
    translatedWrappers: [],
    selectionHighlights: [],
    toast: null,
    toastTimer: null,
    panel: null,
    selectionButton: null,
    contentOptions: { ...DEFAULT_CONTENT_OPTIONS }
  };

  cleanupStaleTranslatorUi();
  initContentOptions();
  installSelectionButtonListeners();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => {
        showToast(error.message || String(error), "error");
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  });

  function hasValidRuntimeContext() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (error) {
      return false;
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
    if (!hasValidRuntimeContext()) {
      throw createExtensionReloadError();
    }

    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (isExtensionContextError(error)) {
        hideSelectionButton();
        throw createExtensionReloadError();
      }

      throw error;
    }
  }

  function cleanupStaleTranslatorUi() {
    document
      .querySelectorAll(".context-translator-toast, .context-translator-panel, .context-translator-selection-button, .context-translator-selection-highlight")
      .forEach((element) => element.remove());
  }

  async function initContentOptions() {
    try {
      const stored = await chrome.storage.local.get(DEFAULT_CONTENT_OPTIONS);
      state.contentOptions = normalizeContentOptions(stored);

      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") {
          return;
        }

        for (const key of Object.keys(DEFAULT_CONTENT_OPTIONS)) {
          if (changes[key]) {
            state.contentOptions[key] = changes[key].newValue;
          }
        }

        state.contentOptions = normalizeContentOptions(state.contentOptions);
        if (!state.contentOptions.showSelectionButton) {
          hideSelectionButton();
        }

      });
    } catch (error) {
      state.contentOptions = { ...DEFAULT_CONTENT_OPTIONS };
    }
  }

  function normalizeContentOptions(options = {}) {
    return {
      ...DEFAULT_CONTENT_OPTIONS,
      ...options,
      speedMode: normalizeSpeedMode(options.speedMode),
      translationStyle: options.translationStyle || "general",
      enableCache: options.enableCache !== false,
      showSelectionButton: options.showSelectionButton !== false,
      enableGlossaryExtraction: options.enableGlossaryExtraction !== false,
      enablePageSummary: options.enablePageSummary !== false
    };
  }

  async function handleMessage(message) {
    if (!message || typeof message.type !== "string") {
      throw new Error("未知操作。");
    }

    if (message.type === "TRANSLATE_PAGE") {
      return translatePage(message.options || {});
    }

    if (message.type === "TRANSLATE_SELECTION") {
      return translateSelection(message.options || {});
    }

    if (message.type === "TRANSLATE_GIVEN_TEXT") {
      return translateSelection(state.contentOptions, message.text);
    }

    if (message.type === "RESTORE_PAGE") {
      restorePage();
      return { restored: true };
    }

    if (message.type === "PING_CONTEXT_TRANSLATOR") {
      return { ready: true };
    }

    throw new Error(`不支持的操作：${message.type}`);
  }

  async function translatePage(options) {
    const normalizedOptions = normalizeContentOptions({ ...state.contentOptions, ...options });
    restorePage(false);
    showToast("正在读取页面结构...", "busy", 4);

    const pageContext = collectPageContext();
    const textItems = collectTextItems();

    if (!textItems.length) {
      showToast("这个页面没有找到适合翻译的正文。", "error");
      return { translated: 0 };
    }

    const glossaryResult = await prepareGlossaryBeforeTranslation(pageContext, textItems, normalizedOptions);
    const preparedOptions = {
      ...normalizedOptions,
      glossary: mergeGlossary(normalizedOptions.glossary, glossaryResult.glossaryText)
    };
    const preparedContext = {
      ...pageContext,
      pageSummary: glossaryResult.summary || "",
      glossaryTerms: glossaryResult.terms || [],
      uncertainties: glossaryResult.uncertainties || []
    };

    let completed = 0;
    let cached = 0;
    let fallbackItems = 0;
    let failed = 0;
    let activeProvider = "";
    const batches = createBatches(textItems, normalizedOptions);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      const progress = 18 + Math.round((batchIndex / batches.length) * 82);
      showToast(`正在翻译 ${batchIndex + 1}/${batches.length}...`, "busy", progress);

      const result = await translateBatchThroughBestEngine(batch, preparedOptions, preparedContext);

      if (!result?.ok) {
        failed += batch.length;
        continue;
      }

      applyTranslations(batch, result.translations || [], preparedOptions);
      activeProvider = result.provider || activeProvider;
      cached += result.cached || 0;
      fallbackItems += result.fallbackItems || 0;
      completed += batch.length;
      showToast(`正在翻译 ${batchIndex + 1}/${batches.length}...`, "busy", 18 + Math.round(((batchIndex + 1) / batches.length) * 82));
    }

    showToast(`已翻译 ${completed} 段文本${formatProviderSuffix(activeProvider)}${formatMetricSuffix(cached, fallbackItems)}${failed ? `，${failed} 段失败` : ""}。`, "success");
    return {
      translated: completed,
      provider: activeProvider,
      cached,
      fallbackItems,
      failed
    };
  }

  async function translateSelection(options = {}, providedText = "") {
    const normalizedOptions = normalizeContentOptions({ ...state.contentOptions, ...options });
    const selection = window.getSelection();
    const text = String(providedText || (selection ? selection.toString() : "")).trim();
    const selectionRanges = captureSelectionRanges(selection);

    if (!text) {
      throw new Error("请先在页面中选中一段文字。");
    }

    hideSelectionButton();
    preserveSelectionHighlight(selectionRanges);
    showToast("正在翻译选中文本...", "busy");

    const pageContext = collectPageContext();
    const result = await translateSelectionThroughBestEngine(text, normalizedOptions, pageContext);

    if (!result?.ok) {
      throw new Error(result?.error || "翻译失败。");
    }

    showSelectionPanel(text, result.translation, result.notes);
    showToast(`选中文本已翻译${formatProviderSuffix(result.provider)}${formatMetricSuffix(result.cached || 0, 0)}。`, "success");
    return {
      translated: true,
      provider: result.provider,
      cached: result.cached || 0
    };
  }

  async function translateBatchThroughBestEngine(batch, options, pageContext) {
    if (shouldUseChromeTranslator(options)) {
      try {
        return await translateBatchWithChromeTranslator(batch, options, pageContext);
      } catch (error) {
        if (options.provider === "chrome") {
          throw error;
        }
      }
    }

    return sendRuntimeMessage({
      type: "TRANSLATE_BATCH",
      payload: {
        pageContext,
        items: batch.map(({ node, ...item }) => item),
        targetLanguage: options.targetLanguage,
        glossary: options.glossary,
        speedMode: options.speedMode,
        translationStyle: options.translationStyle,
        enableCache: options.enableCache
      }
    });
  }

  async function translateSelectionThroughBestEngine(text, options, pageContext) {
    if (shouldUseChromeTranslator(options)) {
      try {
        const translation = await translateTextWithChromeTranslator(text.slice(0, SELECTION_CHAR_LIMIT), options, pageContext);
        return {
          ok: true,
          translation,
          notes: "",
          provider: "chrome",
          cached: 0
        };
      } catch (error) {
        if (options.provider === "chrome") {
          throw error;
        }
      }
    }

    return sendRuntimeMessage({
      type: "TRANSLATE_SELECTION",
      payload: {
        pageContext,
        text: text.slice(0, SELECTION_CHAR_LIMIT),
        targetLanguage: options.targetLanguage,
        glossary: options.glossary,
        speedMode: options.speedMode,
        translationStyle: options.translationStyle,
        enableCache: options.enableCache
      }
    });
  }

  function shouldUseChromeTranslator(options) {
    return options.provider === "chrome" || (options.provider === "auto" && options.speedMode === "fast");
  }

  async function translateBatchWithChromeTranslator(batch, options, pageContext) {
    const translations = [];

    for (const item of batch) {
      translations.push({
        id: item.id,
        translation: await translateTextWithChromeTranslator(item.text, options, pageContext)
      });
    }

    return {
      ok: true,
      translations,
      provider: "chrome",
      cached: 0,
      fallbackItems: 0
    };
  }

  async function translateTextWithChromeTranslator(text, options, pageContext) {
    const targetLanguage = mapChromeLanguage(options.targetLanguage, "target");
    const sourceLanguage = inferChromeSourceLanguage(text, pageContext, targetLanguage);
    const translator = await getChromeTranslator(sourceLanguage, targetLanguage);
    return translator.translate(text);
  }

  async function getChromeTranslator(sourceLanguage, targetLanguage) {
    if (!("Translator" in self)) {
      throw new Error("当前浏览器不支持 Chrome 内置翻译。");
    }

    const cacheKey = `${sourceLanguage}->${targetLanguage}`;
    if (chromeTranslatorCache.has(cacheKey)) {
      return chromeTranslatorCache.get(cacheKey);
    }

    const availability = await Translator.availability({ sourceLanguage, targetLanguage });
    if (availability === "unavailable") {
      throw new Error(`Chrome 内置翻译不支持 ${sourceLanguage} -> ${targetLanguage}。`);
    }

    if (availability === "downloadable" || availability === "downloading") {
      showToast("正在准备 Chrome 内置翻译语言包...", "busy");
    }

    const translator = await Translator.create({
      sourceLanguage,
      targetLanguage,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          const percent = Math.round(Number(event.loaded || 0) * 100);
          if (percent > 0) {
            showToast(`正在下载 Chrome 翻译语言包 ${percent}%...`, "busy", percent);
          }
        });
      }
    });

    if (translator.ready) {
      await translator.ready;
    }

    chromeTranslatorCache.set(cacheKey, translator);
    return translator;
  }

  function inferChromeSourceLanguage(text, pageContext, targetLanguage) {
    const htmlLang = normalizeChromeLanguageCode(pageContext?.htmlLang || document.documentElement.lang || "");
    if (htmlLang && htmlLang !== targetLanguage) {
      return htmlLang;
    }

    if (/[\u3040-\u30ff]/.test(text)) {
      return "ja";
    }

    if (/[\uac00-\ud7af]/.test(text)) {
      return "ko";
    }

    if (/[\u4e00-\u9fff]/.test(text)) {
      return targetLanguage === "zh" ? "en" : "zh";
    }

    if (/[а-яё]/i.test(text)) {
      return "ru";
    }

    return targetLanguage === "en" ? "zh" : "en";
  }

  function mapChromeLanguage(language, role) {
    const mapped = {
      "简体中文": "zh",
      "繁体中文": "zh-Hant",
      "英语": "en",
      "日语": "ja",
      "韩语": "ko",
      "德语": "de",
      "法语": "fr",
      "西班牙语": "es"
    }[String(language || "").trim()];

    const normalized = mapped || normalizeChromeLanguageCode(language);
    if (normalized) {
      return normalized;
    }

    throw new Error(`Chrome 内置翻译不支持${role === "target" ? "目标" : "源"}语言：${language}`);
  }

  function normalizeChromeLanguageCode(language) {
    const value = String(language || "").trim();
    if (!value) {
      return "";
    }

    const lower = value.replace("_", "-").toLowerCase();
    if (lower === "zh-cn" || lower === "zh-hans") {
      return "zh";
    }
    if (lower === "zh-tw" || lower === "zh-hk" || lower === "zh-hant") {
      return "zh-Hant";
    }

    const base = lower.split("-")[0];
    return /^[a-z]{2,3}$/.test(base) ? base : "";
  }

  async function prepareGlossaryBeforeTranslation(pageContext, textItems, options) {
    if (!shouldPreparePageContext(pageContext, textItems, options)) {
      return { terms: [], glossaryText: "", summary: "", uncertainties: [] };
    }

    showToast("正在分析网页语境...", "busy", 12);

    const result = await sendRuntimeMessage({
      type: "EXTRACT_PAGE_GLOSSARY",
      payload: {
        pageContext,
        targetLanguage: options.targetLanguage,
        glossary: options.glossary,
        speedMode: options.speedMode,
        translationStyle: options.translationStyle
      }
    });

    if (!result?.ok) {
      return { terms: [], glossaryText: "", summary: "", uncertainties: [] };
    }

    const payload = {
      terms: options.enableGlossaryExtraction && Array.isArray(result.terms) ? result.terms : [],
      summary: options.enablePageSummary ? result.summary || "" : "",
      domain: result.domain || "",
      uncertainties: options.enableGlossaryExtraction && Array.isArray(result.uncertainties) ? result.uncertainties : []
    };

    return {
      ...payload,
      glossaryText: formatGlossaryTerms(payload.terms)
    };
  }

  function shouldPreparePageContext(pageContext, textItems, options) {
    if (isLocalTranslationProvider(options.provider)) {
      return false;
    }

    if (options.speedMode === "fast") {
      return false;
    }

    if (!options.enableGlossaryExtraction && !options.enablePageSummary) {
      return false;
    }

    const totalChars = textItems.reduce((sum, item) => sum + item.text.length, 0);
    const contextText = [
      pageContext.title,
      pageContext.metaDescription,
      pageContext.openGraphTitle,
      pageContext.openGraphDescription,
      Array.isArray(pageContext.headings) ? pageContext.headings.join(" ") : "",
      pageContext.pageTextSample
    ].filter(Boolean).join(" ");
    const looksTechnical = /\b(api|sdk|cli|json|xml|html|css|react|vue|typescript|javascript|python|github|npm|docs?|release|changelog|model|prompt)\b|接口|代码|函数|参数|报错|文档|开发|模型|术语|论文|产品/i.test(contextText);

    return totalChars >= 900 || textItems.length >= 8 || looksTechnical;
  }

  function normalizeSpeedMode(mode) {
    return mode === "fast" ? "fast" : "accurate";
  }

  function isLocalTranslationProvider(provider) {
    return provider === "chrome" || provider === "libretranslate";
  }

  function formatGlossaryTerms(terms) {
    return terms
      .filter((term) => term?.source)
      .map((term) => `${term.source}=${term.target || term.source}${term.note ? ` (${term.note})` : ""}`)
      .join("\n");
  }

  function mergeGlossary(userGlossary, extractedGlossary) {
    return [userGlossary, extractedGlossary].map((value) => String(value || "").trim()).filter(Boolean).join("\n");
  }

  function formatProviderSuffix(provider) {
    const labels = {
      deepseek: "，使用 DeepSeek",
      aliyun: "，使用阿里云百炼",
      openai: "，使用 OpenAI",
      openrouter: "，使用 OpenRouter",
      chrome: "，使用 Chrome 内置翻译",
      libretranslate: "，使用 LibreTranslate 本地",
      custom: "，使用自定义接口"
    };

    return labels[provider] || "";
  }

  function formatMetricSuffix(cached, fallbackItems) {
    const parts = [];
    if (cached) {
      parts.push(`缓存命中 ${cached}`);
    }
    if (fallbackItems) {
      parts.push(`逐条补译 ${fallbackItems}`);
    }
    return parts.length ? `，${parts.join("，")}` : "";
  }

  function restorePage(showNotice = true) {
    for (const record of state.translatedNodes) {
      if (record.node && record.node.isConnected) {
        record.node.nodeValue = record.original;
      }
    }

    for (const wrapper of state.translatedWrappers) {
      if (wrapper?.isConnected) {
        wrapper.remove();
      }
    }

    state.translatedNodes = [];
    state.translatedWrappers = [];
    state.translatedNodeSet = new WeakSet();
    hideSelectionPanel();
    clearSelectionHighlight();
    hideSelectionButton();

    if (showNotice) {
      showToast("已恢复原文。", "success");
    }
  }

  function collectPageContext() {
    return {
      url: location.href,
      title: document.title,
      htmlLang: document.documentElement.lang || "",
      metaDescription: getMeta("description"),
      openGraphTitle: getMeta("og:title"),
      openGraphDescription: getMeta("og:description"),
      headings: Array.from(document.querySelectorAll("h1, h2, h3"))
        .map((heading) => normalizeText(heading.innerText || heading.textContent || ""))
        .filter(Boolean)
        .slice(0, 60),
      pageTextSample: collectPageTextSample()
    };
  }

  function collectPageTextSample() {
    const chunks = [];
    const selectors = "article p, main p, [role='main'] p, p, li, blockquote";
    const candidates = Array.from(document.querySelectorAll(selectors));

    for (const element of candidates) {
      if (chunks.join(" ").length >= PAGE_CONTEXT_CHAR_LIMIT) {
        break;
      }

      if (!isElementReadable(element)) {
        continue;
      }

      const text = normalizeText(element.innerText || element.textContent || "");
      if (text.length < 20 || isMostlyNumbers(text)) {
        continue;
      }

      chunks.push(text);
    }

    const joined = chunks.join("\n\n").slice(0, PAGE_CONTEXT_CHAR_LIMIT);
    if (joined) {
      return joined;
    }

    return normalizeText(document.body?.innerText || document.body?.textContent || "").slice(0, PAGE_CONTEXT_CHAR_LIMIT);
  }

  function buildPageProfile(pageContext = {}, textItems = [], options = {}) {
    const task = options.task === "selection" ? "selection" : "page";
    const readability = extractReadabilitySnapshot(options);
    const translatableText = textItems.map((item) => item.text || "").join("\n").slice(0, PROFILE_TEXT_SAMPLE_LIMIT);
    const contextText = [
      pageContext.title,
      pageContext.metaDescription,
      pageContext.openGraphTitle,
      pageContext.openGraphDescription,
      Array.isArray(pageContext.headings) ? pageContext.headings.join(" ") : "",
      readability.textSample,
      pageContext.pageTextSample,
      translatableText,
      options.selectedText
    ].filter(Boolean).join("\n").slice(0, PROFILE_TEXT_SAMPLE_LIMIT);
    const totalTextChars = textItems.reduce((sum, item) => sum + String(item.text || "").length, 0);
    const domStats = collectDomProfileStats(textItems, contextText);
    const keywordHits = collectProfileKeywordHits(contextText);
    const technicalScore = scoreTechnicalProfile(keywordHits, domStats);
    const scriptProfile = getScriptProfile(contextText);
    const pageType = classifyPageType({
      task,
      pageContext,
      readability,
      domStats,
      technicalScore,
      contextText
    });
    const complexity = classifyPageComplexity({
      totalTextChars,
      articleCharCount: readability.articleCharCount,
      headingCount: domStats.headingCount,
      technicalScore
    });

    return {
      version: 1,
      task,
      urlHost: normalizeHost(pageContext.url || location.href),
      isReaderable: readability.isReaderable,
      readabilityUsed: readability.used,
      readabilitySource: readability.source,
      pageType,
      complexity,
      totalTextChars,
      translatableNodeCount: textItems.length,
      articleCharCount: readability.articleCharCount,
      headingCount: domStats.headingCount,
      paragraphCount: domStats.paragraphCount,
      listItemCount: domStats.listItemCount,
      tableCount: domStats.tableCount,
      codeBlockCount: domStats.codeBlockCount,
      formControlCount: domStats.formControlCount,
      mediaCount: domStats.mediaCount,
      linkDensity: domStats.linkDensity,
      codeDensity: domStats.codeDensity,
      technicalScore,
      keywordHits,
      dominantScript: scriptProfile.dominantScript,
      cjkRatio: scriptProfile.cjkRatio,
      latinRatio: scriptProfile.latinRatio,
      numericRatio: scriptProfile.numericRatio,
      titleLength: normalizeText(pageContext.title || "").length,
      metaDescriptionLength: normalizeText(pageContext.metaDescription || "").length,
      articleTitle: readability.title,
      articleExcerpt: readability.excerpt
    };
  }

  function extractReadabilitySnapshot(options = {}) {
    const isReaderable = options.skipReadability ? false : isProbablyReadableDocument();
    if (options.skipReadability || typeof Readability !== "function" || !isReaderable) {
      return {
        isReaderable,
        used: false,
        source: typeof Readability === "function" ? "readerable-check" : "unavailable",
        title: "",
        excerpt: "",
        articleCharCount: 0,
        textSample: ""
      };
    }

    try {
      const clone = document.cloneNode(true);
      clone
        .querySelectorAll("[data-context-translator-ignore]")
        .forEach((element) => element.remove());

      const article = new Readability(clone, {
        charThreshold: 200,
        maxElemsToParse: 7000,
        serializer(element) {
          return element?.textContent || "";
        }
      }).parse();
      const text = normalizeText(article?.textContent || article?.content || "");

      return {
        isReaderable,
        used: Boolean(article),
        source: article ? "readability" : "readerable-check",
        title: normalizeText(article?.title || "").slice(0, 160),
        excerpt: normalizeText(article?.excerpt || "").slice(0, 280),
        articleCharCount: text.length,
        textSample: text.slice(0, READABILITY_TEXT_SAMPLE_LIMIT)
      };
    } catch (error) {
      return {
        isReaderable,
        used: false,
        source: "readability-error",
        title: "",
        excerpt: "",
        articleCharCount: 0,
        textSample: ""
      };
    }
  }

  function isProbablyReadableDocument() {
    if (typeof isProbablyReaderable !== "function") {
      return Boolean(document.querySelector("article, main, [role='main']"));
    }

    try {
      return isProbablyReaderable(document, {
        minScore: 14,
        minContentLength: 120,
        visibilityChecker(node) {
          const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
          return isElementReadable(element);
        }
      });
    } catch (error) {
      return Boolean(document.querySelector("article, main, [role='main']"));
    }
  }

  function collectDomProfileStats(textItems, contextText) {
    const totalTextChars = textItems.reduce((sum, item) => sum + String(item.text || "").length, 0);
    const linkTextChars = collectVisibleTextLength("a");
    const codeTextChars = collectVisibleTextLength("pre, code, kbd, samp");
    const profileTextChars = Math.max(1, totalTextChars || normalizeText(contextText).length);

    return {
      headingCount: Array.from(document.querySelectorAll("h1, h2, h3")).filter(isElementVisibleForProfile).length,
      paragraphCount: Array.from(document.querySelectorAll("p, blockquote")).filter(isElementVisibleForProfile).length,
      listItemCount: Array.from(document.querySelectorAll("li")).filter(isElementVisibleForProfile).length,
      tableCount: Array.from(document.querySelectorAll("table")).filter(isElementVisibleForProfile).length,
      codeBlockCount: Array.from(document.querySelectorAll("pre, code")).filter(isElementVisibleForProfile).length,
      formControlCount: Array.from(document.querySelectorAll("input, textarea, select, button")).filter(isElementVisibleForProfile).length,
      mediaCount: Array.from(document.querySelectorAll("img, video, picture, figure")).filter(isElementVisibleForProfile).length,
      linkDensity: roundRatio(linkTextChars / Math.max(1, profileTextChars + linkTextChars)),
      codeDensity: roundRatio(codeTextChars / Math.max(1, profileTextChars + codeTextChars))
    };
  }

  function collectVisibleTextLength(selector) {
    return Array.from(document.querySelectorAll(selector)).reduce((sum, element) => {
      if (!isElementVisibleForProfile(element)) {
        return sum;
      }

      return sum + normalizeText(element.innerText || element.textContent || "").length;
    }, 0);
  }

  function isElementVisibleForProfile(element) {
    if (!element || element.closest("[data-context-translator-ignore], [hidden], [aria-hidden='true']")) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width !== 0 || rect.height !== 0;
  }

  function collectProfileKeywordHits(text) {
    const patterns = [
      ["api", /\bapi\b/i],
      ["sdk", /\bsdk\b/i],
      ["cli", /\bcli\b/i],
      ["json", /\bjson\b/i],
      ["html", /\bhtml\b/i],
      ["css", /\bcss\b/i],
      ["javascript", /\b(?:javascript|typescript|react|vue|node\.?js)\b/i],
      ["python", /\bpython\b/i],
      ["github", /\bgithub\b/i],
      ["release", /\b(?:release|changelog|version)\b/i],
      ["model", /\b(?:model|prompt|llm|ai)\b/i],
      ["paper", /\b(?:abstract|paper|citation|references|arxiv)\b/i],
      ["接口", /接口/],
      ["代码", /代码|函数|参数|报错|错误|调试/],
      ["文档", /文档|开发者|仓库|开源/],
      ["产品", /产品|功能|定价|客户|方案/],
      ["论文", /论文|摘要|引用|研究/]
    ];
    const hits = [];

    for (const [label, pattern] of patterns) {
      if (pattern.test(text)) {
        hits.push(label);
      }

      if (hits.length >= PROFILE_KEYWORD_LIMIT) {
        break;
      }
    }

    return hits;
  }

  function scoreTechnicalProfile(keywordHits, domStats) {
    const heavyKeywords = new Set(["api", "sdk", "cli", "json", "javascript", "python", "github", "接口", "代码", "文档"]);
    const keywordScore = keywordHits.reduce((sum, keyword) => sum + (heavyKeywords.has(keyword) ? 2 : 1), 0);
    const codeScore = Math.min(8, Math.round(domStats.codeDensity * 24) + Math.min(4, domStats.codeBlockCount));
    return Math.min(20, keywordScore + codeScore);
  }

  function getScriptProfile(text) {
    const source = String(text || "");
    const cjkCount = (source.match(/[\u3400-\u9fff]/g) || []).length;
    const latinCount = (source.match(/[a-z]/gi) || []).length;
    const numericCount = (source.match(/\d/g) || []).length;
    const total = Math.max(1, cjkCount + latinCount + numericCount);

    return {
      dominantScript: cjkCount > latinCount ? "cjk" : latinCount > 0 ? "latin" : "unknown",
      cjkRatio: roundRatio(cjkCount / total),
      latinRatio: roundRatio(latinCount / total),
      numericRatio: roundRatio(numericCount / total)
    };
  }

  function classifyPageType({ task, pageContext, readability, domStats, technicalScore, contextText }) {
    if (task === "selection") {
      return "selection";
    }

    if (technicalScore >= 7 || domStats.codeDensity >= 0.1) {
      return "technical";
    }

    if (/\b(?:abstract|citation|references|arxiv|doi)\b|论文|摘要|引用|研究/i.test(contextText)) {
      return "academic";
    }

    const title = normalizeText(pageContext.title || "");
    const meta = normalizeText(pageContext.metaDescription || "");
    const landingText = `${title} ${meta} ${contextText}`;
    if (/\b(?:pricing|features|customers|enterprise|product|solution)\b|产品|功能|定价|客户|解决方案/i.test(landingText)) {
      return "product";
    }

    if (readability.isReaderable && readability.articleCharCount >= 1200) {
      return "article";
    }

    if (domStats.formControlCount >= 6 || domStats.linkDensity >= 0.42) {
      return "app";
    }

    return domStats.paragraphCount >= 8 ? "article" : "general";
  }

  function classifyPageComplexity({ totalTextChars, articleCharCount, headingCount, technicalScore }) {
    const effectiveChars = Math.max(Number(totalTextChars || 0), Number(articleCharCount || 0));
    if (effectiveChars >= 8000 || headingCount >= 32 || technicalScore >= 12) {
      return "large";
    }

    if (effectiveChars >= 1800 || headingCount >= 10 || technicalScore >= 5) {
      return "medium";
    }

    return "small";
  }

  function normalizeHost(value) {
    try {
      return new URL(String(value || location.href)).host;
    } catch (error) {
      return "";
    }
  }

  function roundRatio(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return 0;
    }

    return Math.round(Math.max(0, Math.min(1, number)) * 1000) / 1000;
  }

  function collectTextItems() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!isTextNodeTranslatable(node)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const items = [];
    let node = walker.nextNode();

    while (node && items.length < MAX_TEXT_NODES) {
      const text = normalizeText(node.nodeValue || "").slice(0, MAX_CHARS_PER_NODE);
      const parent = node.parentElement;

      items.push({
        id: `t${items.length}`,
        text,
        tag: parent ? parent.tagName.toLowerCase() : "text",
        section: inferSectionLabel(parent),
        node
      });

      node = walker.nextNode();
    }

    return items;
  }

  function isTextNodeTranslatable(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP_SELECTOR)) {
      return false;
    }

    if (state.translatedNodeSet.has(node)) {
      return false;
    }

    const raw = node.nodeValue || "";
    const text = normalizeText(raw);

    if (text.length < 2 || !/[\p{L}\p{N}]/u.test(text)) {
      return false;
    }

    if (isMostlyNumbers(text)) {
      return false;
    }

    if (parent.closest("nav, menu") && text.length < 12) {
      return false;
    }

    if (parent.isContentEditable) {
      return false;
    }

    if (!isElementReadable(parent)) {
      return false;
    }

    return true;
  }

  function isElementReadable(element) {
    if (!element || element.closest(SKIP_SELECTOR)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width !== 0 || rect.height !== 0;
  }

  function isMostlyNumbers(text) {
    return /^[\d\s.,:;+\-/%()#[\]{}]+$/.test(text);
  }

  function createBatches(items, options = {}) {
    const limits = getBatchLimits(options.speedMode);
    const batches = [];
    let current = [];
    let currentChars = 0;

    for (const item of items) {
      const nextChars = currentChars + item.text.length;
      const shouldFlush =
        current.length >= limits.maxItems || (current.length > 0 && nextChars > limits.maxChars);

      if (shouldFlush) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }

      current.push(item);
      currentChars += item.text.length;
    }

    if (current.length) {
      batches.push(current);
    }

    return batches;
  }

  function getBatchLimits(speedMode) {
    if (speedMode === "fast") {
      return { maxItems: 48, maxChars: 9000 };
    }

    return { maxItems: 24, maxChars: 4600 };
  }

  function applyTranslations(batch, translations) {
    const byId = new Map(translations.map((item) => [String(item.id), item]));

    for (const item of batch) {
      const result = byId.get(String(item.id));
      const translation = result?.translation;
      if (!translation || !item.node?.isConnected) {
        continue;
      }

      replaceTextNode(item, translation, result.uncertainty);
    }
  }

  function replaceTextNode(item, translation, uncertainty = "") {
    if (!state.translatedNodeSet.has(item.node)) {
      state.translatedNodes.push({
        node: item.node,
        original: item.node.nodeValue
      });
      state.translatedNodeSet.add(item.node);
    }

    item.node.nodeValue = preserveOuterWhitespace(item.node.nodeValue || "", translation);
    if (uncertainty) {
      insertUncertaintyMarker(item.node, uncertainty);
    }
  }

  function insertUncertaintyMarker(node, uncertainty) {
    const parent = node.parentNode;
    if (!parent) {
      return;
    }

    const marker = document.createElement("span");
    marker.className = "context-translator-uncertainty";
    marker.dataset.contextTranslatorIgnore = "true";
    marker.title = uncertainty;
    marker.textContent = "?";
    parent.insertBefore(marker, node.nextSibling);
    state.translatedWrappers.push(marker);
  }

  function inferSectionLabel(element) {
    if (!element) {
      return "";
    }

    const headingAncestor = element.closest("section, article, main, aside, header, footer, nav");
    const heading = headingAncestor?.querySelector("h1, h2, h3, h4");
    if (heading) {
      return normalizeText(heading.innerText || heading.textContent || "").slice(0, 160);
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = document.getElementById(labelledBy);
      return normalizeText(label?.innerText || label?.textContent || "").slice(0, 160);
    }

    return "";
  }

  function getMeta(name) {
    const selector = `meta[name="${cssEscape(name)}"], meta[property="${cssEscape(name)}"]`;
    return document.querySelector(selector)?.getAttribute("content") || "";
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function preserveOuterWhitespace(original, translated) {
    const leading = original.match(/^\s*/)?.[0] || "";
    const trailing = original.match(/\s*$/)?.[0] || "";
    return `${leading}${String(translated).trim()}${trailing}`;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return CSS.escape(value);
    }

    return String(value).replace(/"/g, '\\"');
  }

  function captureSelectionRanges(selection) {
    if (!selection || !selection.rangeCount || isSelectionInsideTranslator(selection)) {
      return [];
    }

    const ranges = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      if (!range.collapsed) {
        ranges.push(range.cloneRange());
      }
    }

    return ranges;
  }

  function preserveSelectionHighlight(ranges) {
    clearSelectionHighlight();
    if (!Array.isArray(ranges) || !ranges.length) {
      return;
    }

    const root = document.documentElement;
    for (const range of ranges) {
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) {
          continue;
        }

        const highlight = document.createElement("span");
        highlight.className = "context-translator-selection-highlight";
        highlight.dataset.contextTranslatorIgnore = "true";
        highlight.setAttribute("aria-hidden", "true");
        highlight.style.left = `${rect.left + window.scrollX}px`;
        highlight.style.top = `${rect.top + window.scrollY - 1}px`;
        highlight.style.width = `${rect.width}px`;
        highlight.style.height = `${rect.height + 2}px`;
        root.append(highlight);
        state.selectionHighlights.push(highlight);
      }
    }
  }

  function clearSelectionHighlight() {
    for (const highlight of state.selectionHighlights) {
      if (highlight?.isConnected) {
        highlight.remove();
      }
    }
    state.selectionHighlights = [];
  }

  function installSelectionButtonListeners() {
    document.addEventListener("mouseup", () => {
      window.setTimeout(updateSelectionButtonFromSelection, 20);
    });
    document.addEventListener("keyup", updateSelectionButtonFromSelection);
    document.addEventListener("mousedown", (event) => {
      if (state.selectionButton && !state.selectionButton.contains(event.target)) {
        hideSelectionButton();
      }
    });
    window.addEventListener("scroll", hideSelectionButton, { passive: true });
  }

  function updateSelectionButtonFromSelection() {
    if (!state.contentOptions.showSelectionButton) {
      hideSelectionButton();
      return;
    }

    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : "";

    if (!selection || !text || text.length > SELECTION_CHAR_LIMIT || isSelectionInsideTranslator(selection)) {
      hideSelectionButton();
      return;
    }

    showSelectionButton(selection);
  }

  function isSelectionInsideTranslator(selection) {
    const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection.anchorNode?.parentElement;
    const focus = selection.focusNode?.nodeType === Node.ELEMENT_NODE
      ? selection.focusNode
      : selection.focusNode?.parentElement;

    return Boolean(
      anchor?.closest?.("[data-context-translator-ignore]") ||
      focus?.closest?.("[data-context-translator-ignore]")
    );
  }

  function showSelectionButton(selection) {
    hideSelectionButton();
    ensureToast();

    if (!selection.rangeCount) {
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-translator-selection-button";
    button.title = "翻译选中文本";
    button.setAttribute("aria-label", "翻译选中文本");
    button.dataset.contextTranslatorIgnore = "true";
    button.textContent = "译";

    const top = Math.max(8, rect.top + window.scrollY - 42);
    const left = Math.min(window.scrollX + window.innerWidth - 44, Math.max(8, rect.right + window.scrollX - 28));

    button.style.top = `${top}px`;
    button.style.left = `${left}px`;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const selectedText = window.getSelection()?.toString().trim() || "";
      if (selectedText) {
        translateSelection(state.contentOptions, selectedText).catch((error) => showToast(error.message || String(error), "error"));
      }
    });

    document.documentElement.append(button);
    state.selectionButton = button;
  }

  function hideSelectionButton() {
    if (state.selectionButton) {
      state.selectionButton.remove();
      state.selectionButton = null;
    }
  }

  function showToast(message, tone = "busy", progress = null) {
    ensureToast();
    const messageElement = state.toast.querySelector(".context-translator-toast-message");
    const progressElement = state.toast.querySelector(".context-translator-toast-progress");
    const progressBar = state.toast.querySelector(".context-translator-toast-progress-bar");

    messageElement.textContent = message;
    state.toast.dataset.tone = tone;
    state.toast.hidden = false;
    window.clearTimeout(state.toastTimer);

    if (tone === "busy") {
      const normalizedProgress = normalizeToastProgress(progress);
      progressElement.hidden = false;

      if (normalizedProgress == null) {
        state.toast.dataset.progress = "indeterminate";
        progressBar.style.removeProperty("--context-translator-progress");
      } else {
        state.toast.dataset.progress = "determinate";
        progressBar.style.setProperty("--context-translator-progress", `${normalizedProgress}%`);
      }
    } else {
      progressElement.hidden = true;
      state.toast.dataset.progress = "hidden";
      progressBar.style.removeProperty("--context-translator-progress");
    }

    if (tone !== "busy") {
      state.toastTimer = window.setTimeout(() => {
        if (state.toast) {
          state.toast.hidden = true;
        }
      }, 2800);
    }
  }

  function normalizeToastProgress(progress) {
    if (!Number.isFinite(Number(progress))) {
      return null;
    }

    return Math.max(0, Math.min(100, Math.round(Number(progress))));
  }

  function ensureToast() {
    if (state.toast) {
      return;
    }

    const style = document.createElement("style");
    style.textContent = `
      .context-translator-toast,
      .context-translator-panel,
      .context-translator-selection-button,
      .context-translator-selection-highlight,
      .context-translator-uncertainty {
        all: initial;
        box-sizing: border-box;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      }

      .context-translator-toast {
        position: fixed;
        z-index: 2147483647;
        right: 18px;
        bottom: 18px;
        display: grid;
        gap: 8px;
        min-width: 172px;
        max-width: min(360px, calc(100vw - 36px));
        padding: 11px 13px 10px;
        border: 1px solid rgba(255, 255, 255, 0.76);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.82);
        color: #111827;
        box-shadow: 0 18px 42px rgba(15, 23, 42, 0.16);
        backdrop-filter: blur(18px);
        font-size: 13px;
        line-height: 1.45;
      }

      .context-translator-toast-message {
        display: block;
        min-width: 0;
        color: inherit;
        font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      }

      .context-translator-toast-progress {
        position: relative;
        width: 100%;
        height: 4px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(37, 99, 235, 0.14);
      }

      .context-translator-toast-progress-bar {
        position: absolute;
        inset: 0 auto 0 0;
        width: var(--context-translator-progress, 34%);
        border-radius: inherit;
        background: linear-gradient(90deg, #60a5fa, #2563eb);
        box-shadow: 0 0 12px rgba(37, 99, 235, 0.34);
      }

      .context-translator-toast[data-progress="indeterminate"] .context-translator-toast-progress-bar {
        width: 42%;
        animation: context-translator-progress-slide 920ms ease-in-out infinite;
      }

      .context-translator-toast[data-progress="determinate"] .context-translator-toast-progress-bar {
        transition: width 180ms ease;
      }

      .context-translator-toast[data-tone="busy"] {
        border-color: rgba(59, 130, 246, 0.36);
      }

      .context-translator-toast[data-tone="success"] {
        border-color: rgba(16, 185, 129, 0.38);
      }

      .context-translator-toast[data-tone="error"] {
        border-color: rgba(244, 63, 94, 0.38);
      }

      .context-translator-panel {
        position: fixed;
        z-index: 2147483647;
        right: 18px;
        top: 18px;
        width: min(420px, calc(100vw - 36px));
        max-height: calc(100vh - 36px);
        overflow: auto;
        padding: 0;
        border: 1px solid rgba(255, 255, 255, 0.76);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.9);
        color: #111827;
        box-shadow: 0 22px 56px rgba(15, 23, 42, 0.18);
        backdrop-filter: blur(18px);
        font-size: 13px;
        line-height: 1.55;
      }

      .context-translator-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 11px 13px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.24);
        cursor: move;
        font: 700 13px/1.2 Inter, ui-sans-serif, system-ui, sans-serif;
        color: #111827;
      }

      .context-translator-panel-body {
        padding: 13px;
      }

      .context-translator-panel strong {
        display: block;
        margin: 0 0 6px;
        font: 600 12px/1.2 Inter, ui-sans-serif, system-ui, sans-serif;
        color: #52606f;
      }

      .context-translator-panel p {
        margin: 0 0 12px;
        white-space: pre-wrap;
        font: 13px/1.55 Inter, ui-sans-serif, system-ui, sans-serif;
        color: #111827;
      }

      .context-translator-panel button,
      .context-translator-selection-button {
        all: initial;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(37, 99, 235, 0.2);
        background: linear-gradient(135deg, #111827, #2563eb);
        color: #ffffff;
        cursor: pointer;
        font: 700 13px/1 Inter, ui-sans-serif, system-ui, sans-serif;
        box-shadow: 0 10px 22px rgba(37, 99, 235, 0.24);
      }

      .context-translator-panel button {
        width: 28px;
        height: 28px;
        border-radius: 10px;
      }

      .context-translator-selection-button {
        position: absolute;
        z-index: 2147483647;
        width: 34px;
        height: 34px;
        border-radius: 999px;
      }

      .context-translator-selection-highlight {
        position: absolute;
        z-index: 2147483600;
        display: block;
        border-radius: 3px;
        background: rgba(59, 130, 246, 0.24);
        box-shadow:
          0 0 0 1px rgba(37, 99, 235, 0.24),
          0 6px 16px rgba(37, 99, 235, 0.16);
        pointer-events: none;
      }

      .context-translator-uncertainty {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 15px;
        height: 15px;
        margin-inline-start: 4px;
        border-radius: 999px;
        background: rgba(245, 158, 11, 0.16);
        color: #92400e;
        cursor: help;
        font: 800 11px/1 Inter, ui-sans-serif, system-ui, sans-serif;
      }

      @keyframes context-translator-progress-slide {
        0% {
          transform: translateX(-115%);
        }
        55% {
          transform: translateX(95%);
        }
        100% {
          transform: translateX(245%);
        }
      }
    `;

    const toast = document.createElement("div");
    toast.className = "context-translator-toast";
    toast.hidden = true;
    toast.dataset.contextTranslatorIgnore = "true";
    toast.innerHTML = `
      <span class="context-translator-toast-message"></span>
      <span class="context-translator-toast-progress" aria-hidden="true">
        <span class="context-translator-toast-progress-bar"></span>
      </span>
    `;

    document.documentElement.append(style, toast);
    state.toast = toast;
  }

  function showSelectionPanel(original, translation, notes) {
    hideSelectionPanel(true);
    ensureToast();

    const panel = document.createElement("div");
    panel.className = "context-translator-panel";
    panel.dataset.contextTranslatorIgnore = "true";
    panel.innerHTML = `
      <div class="context-translator-panel-header">
        <span>划词翻译</span>
        <button type="button" aria-label="关闭">×</button>
      </div>
      <div class="context-translator-panel-body">
        <strong>译文</strong>
        <p></p>
        <strong>原文</strong>
        <p></p>
        ${notes ? "<strong>备注</strong><p></p>" : ""}
      </div>
    `;

    const paragraphs = panel.querySelectorAll("p");
    paragraphs[0].textContent = translation;
    paragraphs[1].textContent = original;
    if (notes && paragraphs[2]) {
      paragraphs[2].textContent = notes;
    }

    panel.querySelector(".context-translator-panel-header button").addEventListener("click", () => hideSelectionPanel());
    document.documentElement.append(panel);
    makeDraggable(panel, panel.querySelector(".context-translator-panel-header"));
    state.panel = panel;
  }

  function makeDraggable(panel, handle) {
    if (!handle) {
      return;
    }

    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target?.tagName === "BUTTON") {
        return;
      }

      const rect = panel.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = "auto";
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) {
        return;
      }

      const nextLeft = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, startLeft + event.clientX - startX));
      const nextTop = Math.max(8, Math.min(window.innerHeight - 48, startTop + event.clientY - startY));
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
    });

    handle.addEventListener("pointerup", (event) => {
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    });
  }

  function hideSelectionPanel(keepSelectionHighlight = false) {
    if (state.panel) {
      state.panel.remove();
      state.panel = null;
    }
    if (!keepSelectionHighlight) {
      clearSelectionHighlight();
    }
  }
})();
