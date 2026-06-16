const DEFAULT_SETTINGS = {
  apiKey: "",
  endpoint: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4.1-mini",
  targetLanguage: "中文（简体）",
  glossary: "",
  temperature: 0.1
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

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

  throw new Error(`不支持的请求：${message.type}`);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function translateBatch(payload) {
  const settings = await getSettings();
  ensureReady(settings);

  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    return { translations: [] };
  }

  const content = await callChatCompletion(settings, buildBatchMessages(settings, payload));
  const parsed = parseJsonFromModel(content);
  const translations = normalizeBatchTranslations(parsed, items);
  return { translations };
}

async function translateSelection(payload) {
  const settings = await getSettings();
  ensureReady(settings);

  const text = String(payload?.text || "").trim();
  if (!text) {
    throw new Error("没有可翻译的选中文本。");
  }

  const content = await callChatCompletion(settings, buildSelectionMessages(settings, payload));
  const parsed = parseJsonFromModel(content);
  const translation = String(parsed.translation || parsed.text || "").trim();

  if (!translation) {
    throw new Error("模型没有返回有效译文。");
  }

  return {
    translation,
    notes: String(parsed.notes || "").trim()
  };
}

function ensureReady(settings) {
  if (!settings.apiKey || !settings.apiKey.trim()) {
    throw new Error("请先在弹窗里填写 API Key。");
  }

  if (!settings.endpoint || !settings.endpoint.trim()) {
    throw new Error("请先设置 Chat Completions API 地址。");
  }
}

async function callChatCompletion(settings, messages) {
  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey.trim()}`
    },
    body: JSON.stringify({
      model: settings.model.trim() || DEFAULT_SETTINGS.model,
      temperature: Number(settings.temperature) || DEFAULT_SETTINGS.temperature,
      messages
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败 ${response.status}: ${trimForMessage(errorText)}`);
  }

  const data = await response.json();
  const content =
    data?.choices?.[0]?.message?.content ||
    data?.output_text ||
    flattenResponsesOutput(data?.output);

  if (!content) {
    throw new Error("API 没有返回可读取的文本。");
  }

  return content;
}

function buildBatchMessages(settings, payload) {
  const targetLanguage = payload?.targetLanguage || settings.targetLanguage;
  const pageContext = payload?.pageContext || {};
  const glossary = payload?.glossary || settings.glossary || "";
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
        "Use page title, headings, metadata, and nearby section labels to resolve ambiguous terms.",
        "Preserve product names, proper nouns, numbers, URLs, code-like tokens, and UI placeholders unless translation is clearly required.",
        "Keep each translation concise enough to fit back into the original web page.",
        "Return only valid JSON with this exact shape: {\"items\":[{\"id\":\"same id\",\"translation\":\"translated text\"}]}."
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

function buildSelectionMessages(settings, payload) {
  const targetLanguage = payload?.targetLanguage || settings.targetLanguage;
  const pageContext = payload?.pageContext || {};
  const glossary = payload?.glossary || settings.glossary || "";

  return [
    {
      role: "system",
      content: [
        "You are a senior web translation editor.",
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

function parseJsonFromModel(content) {
  const text = String(content).trim();

  try {
    return JSON.parse(text);
  } catch (error) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("模型返回的不是 JSON。");
    }

    return JSON.parse(match[0]);
  }
}

function normalizeBatchTranslations(parsed, requestedItems) {
  const rawItems = Array.isArray(parsed?.items)
    ? parsed.items
    : Array.isArray(parsed?.translations)
      ? parsed.translations
      : [];

  const byId = new Map();
  for (const item of rawItems) {
    if (!item || item.id == null) {
      continue;
    }

    byId.set(String(item.id), String(item.translation || item.text || "").trim());
  }

  return requestedItems.map((item) => ({
    id: item.id,
    translation: byId.get(String(item.id)) || item.text
  }));
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
