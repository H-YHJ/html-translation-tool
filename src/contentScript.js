(() => {
  if (window.__contextTranslatorLoaded) {
    return;
  }

  window.__contextTranslatorLoaded = true;

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

  const MAX_TEXT_NODES = 450;
  const MAX_CHARS_PER_NODE = 1200;
  const MAX_BATCH_CHARS = 6000;
  const MAX_BATCH_ITEMS = 32;

  const state = {
    translatedNodes: [],
    translatedNodeSet: new WeakSet(),
    toast: null,
    panel: null
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => {
        showToast(error.message || String(error), "error");
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  });

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
    restorePage();
    showToast("正在读取页面结构...", "busy");

    const pageContext = collectPageContext();
    const textItems = collectTextItems();

    if (!textItems.length) {
      showToast("这个页面没有找到适合翻译的正文。", "error");
      return { translated: 0 };
    }

    let completed = 0;
    const batches = createBatches(textItems);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      showToast(`正在翻译 ${batchIndex + 1}/${batches.length}...`, "busy");

      const result = await chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        payload: {
          pageContext,
          items: batch.map(({ node, ...item }) => item),
          targetLanguage: options.targetLanguage,
          glossary: options.glossary
        }
      });

      if (!result?.ok) {
        throw new Error(result?.error || "翻译失败。");
      }

      applyTranslations(batch, result.translations || []);
      completed += batch.length;
    }

    showToast(`已翻译 ${completed} 段文本。`, "success");
    return { translated: completed };
  }

  async function translateSelection(options) {
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : "";

    if (!text) {
      throw new Error("请先在页面中选中一段文字。");
    }

    showToast("正在翻译选中文本...", "busy");

    const result = await chrome.runtime.sendMessage({
      type: "TRANSLATE_SELECTION",
      payload: {
        pageContext: collectPageContext(),
        text,
        targetLanguage: options.targetLanguage,
        glossary: options.glossary
      }
    });

    if (!result?.ok) {
      throw new Error(result?.error || "翻译失败。");
    }

    showSelectionPanel(text, result.translation, result.notes);
    showToast("选中文本已翻译。", "success");
    return { translated: true };
  }

  function restorePage() {
    for (const record of state.translatedNodes) {
      if (record.node && record.node.isConnected) {
        record.node.nodeValue = record.original;
      }
    }

    state.translatedNodes = [];
    state.translatedNodeSet = new WeakSet();
    hideSelectionPanel();
    showToast("已恢复原文。", "success");
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
        .slice(0, 60)
    };
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

    const raw = node.nodeValue || "";
    const text = normalizeText(raw);

    if (text.length < 2 || !/[\p{L}\p{N}]/u.test(text)) {
      return false;
    }

    if (parent.isContentEditable) {
      return false;
    }

    const style = window.getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = parent.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return false;
    }

    return true;
  }

  function createBatches(items) {
    const batches = [];
    let current = [];
    let currentChars = 0;

    for (const item of items) {
      const nextChars = currentChars + item.text.length;
      const shouldFlush =
        current.length >= MAX_BATCH_ITEMS || (current.length > 0 && nextChars > MAX_BATCH_CHARS);

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

  function applyTranslations(batch, translations) {
    const byId = new Map(translations.map((item) => [String(item.id), item.translation]));

    for (const item of batch) {
      const translation = byId.get(String(item.id));
      if (!translation || !item.node?.isConnected) {
        continue;
      }

      if (!state.translatedNodeSet.has(item.node)) {
        state.translatedNodes.push({
          node: item.node,
          original: item.node.nodeValue
        });
        state.translatedNodeSet.add(item.node);
      }

      item.node.nodeValue = preserveOuterWhitespace(item.node.nodeValue || "", translation);
    }
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

  function showToast(message, tone = "busy") {
    ensureToast();
    state.toast.textContent = message;
    state.toast.dataset.tone = tone;
    state.toast.hidden = false;

    if (tone !== "busy") {
      window.clearTimeout(state.toastTimer);
      state.toastTimer = window.setTimeout(() => {
        if (state.toast) {
          state.toast.hidden = true;
        }
      }, 2800);
    }
  }

  function ensureToast() {
    if (state.toast) {
      return;
    }

    const style = document.createElement("style");
    style.textContent = `
      .context-translator-toast,
      .context-translator-panel {
        all: initial;
        box-sizing: border-box;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .context-translator-toast {
        position: fixed;
        z-index: 2147483647;
        right: 18px;
        bottom: 18px;
        max-width: min(360px, calc(100vw - 36px));
        padding: 10px 12px;
        border: 1px solid #d7d7d2;
        border-radius: 8px;
        background: #fcfcfa;
        color: #1f2428;
        box-shadow: 0 10px 28px rgba(31, 36, 40, 0.16);
        font-size: 13px;
        line-height: 1.45;
      }

      .context-translator-toast[data-tone="busy"] {
        border-color: #9fb7c9;
      }

      .context-translator-toast[data-tone="success"] {
        border-color: #88b69b;
      }

      .context-translator-toast[data-tone="error"] {
        border-color: #d88f7f;
      }

      .context-translator-panel {
        position: fixed;
        z-index: 2147483647;
        right: 18px;
        top: 18px;
        width: min(420px, calc(100vw - 36px));
        max-height: calc(100vh - 36px);
        overflow: auto;
        padding: 14px;
        border: 1px solid #d7d7d2;
        border-radius: 8px;
        background: #fcfcfa;
        color: #1f2428;
        box-shadow: 0 16px 42px rgba(31, 36, 40, 0.18);
        font-size: 13px;
        line-height: 1.55;
      }

      .context-translator-panel strong {
        display: block;
        margin: 0 0 6px;
        font: 600 12px/1.2 Inter, ui-sans-serif, system-ui, sans-serif;
        color: #5c646b;
      }

      .context-translator-panel p {
        margin: 0 0 12px;
        white-space: pre-wrap;
        font: 13px/1.55 Inter, ui-sans-serif, system-ui, sans-serif;
        color: #1f2428;
      }

      .context-translator-panel button {
        all: initial;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 30px;
        padding: 0 10px;
        border: 1px solid #1f2428;
        border-radius: 8px;
        background: #1f2428;
        color: #ffffff;
        cursor: pointer;
        font: 600 12px/1 Inter, ui-sans-serif, system-ui, sans-serif;
      }
    `;

    const toast = document.createElement("div");
    toast.className = "context-translator-toast";
    toast.hidden = true;
    toast.dataset.contextTranslatorIgnore = "true";

    document.documentElement.append(style, toast);
    state.toast = toast;
  }

  function showSelectionPanel(original, translation, notes) {
    hideSelectionPanel();
    ensureToast();

    const panel = document.createElement("div");
    panel.className = "context-translator-panel";
    panel.dataset.contextTranslatorIgnore = "true";
    panel.innerHTML = `
      <strong>译文</strong>
      <p></p>
      <strong>原文</strong>
      <p></p>
      ${notes ? "<strong>备注</strong><p></p>" : ""}
      <button type="button">关闭</button>
    `;

    const paragraphs = panel.querySelectorAll("p");
    paragraphs[0].textContent = translation;
    paragraphs[1].textContent = original;
    if (notes && paragraphs[2]) {
      paragraphs[2].textContent = notes;
    }

    panel.querySelector("button").addEventListener("click", hideSelectionPanel);
    document.documentElement.append(panel);
    state.panel = panel;
  }

  function hideSelectionPanel() {
    if (state.panel) {
      state.panel.remove();
      state.panel = null;
    }
  }
})();
