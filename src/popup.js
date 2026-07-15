const {
  PROVIDERS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  normalizeModelConfig,
  inferModelConfigProvider,
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
  modelConfiguredBadge: document.getElementById("modelConfiguredBadge"),
  toggleModelPicker: document.getElementById("toggleModelPicker"),
  modelPicker: document.getElementById("modelPicker"),
  customModelEntry: document.getElementById("customModelEntry"),
  customModelName: document.getElementById("customModelName"),
  customModelConfiguredBadge: document.getElementById("customModelConfiguredBadge"),
  applyCustomModel: document.getElementById("applyCustomModel"),
  addModelConfig: document.getElementById("addModelConfig"),
  modelConfigList: document.getElementById("modelConfigList"),
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

const assistantSelects = [];
const REQUIRED_CONTENT_SCRIPT_VERSION = "2026-07-15-auto-task-routing-v2";
let assistantSelectListenersInstalled = false;
let settingsCache = { ...DEFAULT_SETTINGS };
let persistedSettings = { ...DEFAULT_SETTINGS };
let activeProvider = DEFAULT_SETTINGS.provider;
let busy = false;
let pageTranslationState = { hasTranslation: false, view: "original" };
let editingModelConfigId = "";
let modelEditorDirty = false;
let startupValidationPromise = Promise.resolve();
const modelValidationTasks = new Map();
const MODEL_VALIDATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const globalSettings = normalizeSettings(stored);
  settingsCache = globalSettings;
  activeProvider = settingsCache.provider;
  await chrome.storage.local.set(globalSettings);
  persistedSettings = snapshotSettings(globalSettings);
  editingModelConfigId = globalSettings.activeModelConfigId || "";

  setFormValues(settingsCache);
  initAssistantSelects();

  controls.provider.addEventListener("change", () => void handleProviderChange());
  controls.toggleApiKey.addEventListener("click", toggleApiKeyVisibility);
  controls.toggleModelPicker.addEventListener("click", toggleModelPicker);
  controls.modelPicker.addEventListener("click", handleModelPickerClick);
  controls.modelPicker.addEventListener("keydown", handleModelPickerKeydown);
  controls.model.addEventListener("input", handleModelInput);
  controls.endpoint.addEventListener("input", handleModelEditorInput);
  controls.apiKey.addEventListener("input", handleModelEditorInput);
  controls.customModelName.addEventListener("input", syncCustomModelAction);
  controls.customModelName.addEventListener("keydown", handleCustomModelKeydown);
  controls.applyCustomModel.addEventListener("click", applyCustomModel);
  controls.addModelConfig.addEventListener("click", startNewModelConfig);
  controls.modelConfigList.addEventListener("click", (event) => void handleModelConfigListClick(event));
  installModelAccordionBehavior();
  controls.saveSettings.addEventListener("click", () => void handleSaveSettingsClick());
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
    controls[key].addEventListener("change", () => {
      void saveSettings({ saveModel: false, validate: false, silent: true })
        .catch((error) => setStatus(error.message || String(error), "error"));
    });
  }

  document.addEventListener("mousedown", (event) => {
    if (!event.target.closest(".model-field")) {
      closeModelPicker();
    }
  });

  await refreshPageTranslationState();
  startupValidationPromise = validateModelConfigsNeedingCheck();
  void startupValidationPromise;
}

function toggleModelPicker() {
  if (controls.toggleModelPicker.disabled) {
    return;
  }

  const shouldOpen = controls.modelPicker.hidden;
  controls.modelPicker.hidden = !shouldOpen;
  controls.toggleModelPicker.setAttribute("aria-expanded", String(shouldOpen));

  if (shouldOpen) {
    collapseAllModelGroups();
    syncModelPickerSelection();
    syncCustomModelEntry();
    syncConfiguredModelIndicators();
    controls.modelPicker.querySelector("summary")?.focus();
  }
}

function closeModelPicker() {
  controls.modelPicker.hidden = true;
  controls.toggleModelPicker.setAttribute("aria-expanded", "false");
}

function handleModelPickerClick(event) {
  const option = event.target.closest(".model-option");
  if (!option) {
    return;
  }

  controls.model.value = option.dataset.model || "";
  markModelEditorDirty();
  syncModelPickerSelection();
  applyEndpointForModelOption(option);
  syncConfiguredModelIndicators();
  controls.model.dispatchEvent(new Event("change", { bubbles: true }));
  closeModelPicker();
  controls.model.focus();
}

function handleModelInput() {
  markModelEditorDirty();
  const model = controls.model.value.trim();
  syncModelPickerSelection();

  if (!model) {
    clearEndpointForCustomModel();
    syncConfiguredModelIndicators();
    return;
  }

  const option = findModelOption(model);
  if (option) {
    applyEndpointForModelOption(option);
    syncConfiguredModelIndicators();
    return;
  }

  clearEndpointForCustomModel();
  syncConfiguredModelIndicators();
}

function syncCustomModelEntry() {
  const model = controls.model.value.trim();
  controls.customModelName.value = model && !findModelOption(model) ? model : "";
  syncCustomModelAction();
}

function syncCustomModelAction() {
  controls.applyCustomModel.disabled = !controls.customModelName.value.trim();
}

function handleCustomModelKeydown(event) {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  applyCustomModel();
}

function applyCustomModel() {
  const model = controls.customModelName.value.trim();
  if (!model) {
    controls.customModelName.focus();
    return;
  }

  controls.model.value = model;
  markModelEditorDirty();
  clearEndpointForCustomModel();
  syncModelPickerSelection();
  syncConfiguredModelIndicators();
  controls.model.dispatchEvent(new Event("change", { bubbles: true }));
  closeModelPicker();
  controls.endpoint.focus();
}

function handleModelEditorInput() {
  markModelEditorDirty();
  syncConfiguredModelIndicators();
}

function markModelEditorDirty() {
  modelEditorDirty = true;
}

function clearEndpointForCustomModel() {
  if (!controls.endpoint.value) {
    return;
  }

  controls.endpoint.value = "";
  controls.endpoint.dispatchEvent(new Event("change", { bubbles: true }));
}

function findModelOption(model) {
  return Array.from(controls.modelPicker.querySelectorAll(".model-option"))
    .find((option) => option.dataset.model === model);
}

function applyEndpointForModelOption(option) {
  const endpoint = getEndpointForModelOption(option);
  controls.endpoint.value = endpoint;
  controls.endpoint.dispatchEvent(new Event("change", { bubbles: true }));
}

function getEndpointForModelOption(option) {
  return option?.closest(".model-group")?.dataset.endpoint || "";
}

function handleModelPickerKeydown(event) {
  if (event.key !== "Escape") {
    return;
  }

  event.preventDefault();
  closeModelPicker();
  controls.toggleModelPicker.focus();
}

function installModelAccordionBehavior() {
  const groups = Array.from(controls.modelPicker.querySelectorAll(".model-group"));

  for (const group of groups) {
    group.addEventListener("toggle", () => {
      if (!group.open) {
        return;
      }

      for (const otherGroup of groups) {
        if (otherGroup !== group) {
          otherGroup.open = false;
        }
      }
    });
  }
}

function collapseAllModelGroups() {
  for (const group of controls.modelPicker.querySelectorAll(".model-group")) {
    group.open = false;
  }
}

function syncModelPickerSelection() {
  const selectedModel = controls.model.value.trim();

  for (const option of controls.modelPicker.querySelectorAll(".model-option")) {
    option.setAttribute("aria-pressed", String(option.dataset.model === selectedModel));
  }
}

function snapshotSettings(settings = {}) {
  return {
    ...settings,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(settings.apiKeys || {}) },
    modelConfigs: Array.isArray(settings.modelConfigs)
      ? settings.modelConfigs.map((config) => ({ ...config }))
      : []
  };
}

function getModelEditorDraft() {
  return {
    model: controls.model.value.trim(),
    endpoint: controls.endpoint.value.trim(),
    apiKey: controls.apiKey.value.trim()
  };
}

function syncConfiguredModelIndicators() {
  const configs = Array.isArray(persistedSettings.modelConfigs) ? persistedSettings.modelConfigs : [];
  const draft = getModelEditorDraft();
  const editingConfig = configs.find((config) => config.id === editingModelConfigId);
  const currentMatchesSaved = Boolean(editingConfig
    && controls.provider.value === "custom"
    && editingConfig.apiKey === draft.apiKey
    && editingConfig.model === draft.model
    && editingConfig.endpoint === draft.endpoint);

  updateConfiguredBadge(
    controls.modelConfiguredBadge,
    currentMatchesSaved ? editingConfig.validationStatus : "",
    currentMatchesSaved ? editingConfig.validationMessage : ""
  );

  for (const option of controls.modelPicker.querySelectorAll(".model-option")) {
    const matchingConfigs = configs.filter((config) => config.model === option.dataset.model);
    const status = aggregateValidationStatus(matchingConfigs);
    const optionName = option.querySelector("span")?.textContent?.trim() || option.dataset.model || "模型";
    option.dataset.validationStatus = status;
    option.setAttribute("aria-label", status ? `${optionName}，${getValidationStatusLabel(status)}` : optionName);
  }

  for (const group of controls.modelPicker.querySelectorAll(".model-group")) {
    const matchingConfigs = configs.filter((config) => {
      const option = findModelOption(config.model);
      return Boolean(option && group.contains(option));
    });
    const status = aggregateValidationStatus(matchingConfigs);
    const summary = group.querySelector("summary");
    const groupName = summary?.textContent?.trim() || "模型分组";
    group.dataset.validationStatus = status;
    summary?.setAttribute("aria-label", status ? `${groupName}，${getValidationStatusLabel(status)}` : groupName);
  }

  const customConfigs = configs.filter((config) => !findModelOption(config.model));
  const customStatus = aggregateValidationStatus(customConfigs);
  controls.customModelEntry.dataset.validationStatus = customStatus;
  updateConfiguredBadge(
    controls.customModelConfiguredBadge,
    customStatus,
    customConfigs.map((config) => config.model).join("、")
  );
}

function updateConfiguredBadge(badge, status, title = "") {
  const normalizedStatus = status || "";
  badge.hidden = !normalizedStatus;
  badge.dataset.status = normalizedStatus;
  badge.textContent = normalizedStatus ? getValidationStatusLabel(normalizedStatus) : "";
  badge.title = title || badge.textContent;
  badge.setAttribute("aria-label", badge.textContent || "模型配置状态");
}

function aggregateValidationStatus(configs) {
  if (!configs.length) {
    return "";
  }

  const statuses = new Set(configs.map((config) => config.validationStatus || "untested"));
  if (statuses.has("validating")) return "validating";
  if (statuses.has("valid") && statuses.has("invalid")) return "mixed";
  if (statuses.has("valid")) return "valid";
  if (statuses.has("invalid")) return "invalid";
  return "untested";
}

function getValidationStatusLabel(status) {
  return {
    valid: "配置成功",
    invalid: "配置失败",
    validating: "验证中",
    mixed: "部分失败",
    untested: "待核验"
  }[status] || "待核验";
}

function renderModelConfigList() {
  const configs = Array.isArray(persistedSettings.modelConfigs) ? persistedSettings.modelConfigs : [];
  controls.modelConfigList.replaceChildren();

  if (!configs.length) {
    const empty = document.createElement("div");
    empty.className = "model-config-empty";
    empty.textContent = "暂无模型配置，请点击右上角新增";
    controls.modelConfigList.append(empty);
    return;
  }

  for (const config of configs) {
    const row = document.createElement("div");
    row.className = "model-config-row";
    row.dataset.configId = config.id;
    row.dataset.active = String(config.id === persistedSettings.activeModelConfigId);

    const select = document.createElement("button");
    select.type = "button";
    select.className = "model-config-select";
    select.dataset.action = "select";
    select.dataset.configId = config.id;
    select.disabled = busy;
    select.setAttribute("role", "radio");
    select.setAttribute("aria-checked", String(config.id === persistedSettings.activeModelConfigId));
    select.setAttribute("aria-label", `${config.model}，${getValidationStatusLabel(config.validationStatus)}`);

    const radio = document.createElement("span");
    radio.className = "model-config-radio";
    radio.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "model-config-copy";
    const name = document.createElement("strong");
    name.textContent = config.model;
    const meta = document.createElement("small");
    meta.textContent = `${getProviderLabel(config.provider)} · ${getModelConfigHost(config.endpoint)}`;
    copy.append(name, meta);

    const badge = document.createElement("span");
    badge.className = "model-validation-badge";
    badge.dataset.status = config.validationStatus || "untested";
    badge.textContent = getValidationStatusLabel(config.validationStatus);
    badge.title = config.validationMessage || badge.textContent;
    select.append(radio, copy, badge);

    const validateButton = createModelConfigActionButton({
      action: "validate",
      configId: config.id,
      label: `核验 ${config.model}`,
      icon: "refresh"
    });
    validateButton.disabled = busy || config.validationStatus === "validating";

    const deleteButton = createModelConfigActionButton({
      action: "delete",
      configId: config.id,
      label: `删除 ${config.model}`,
      icon: "trash"
    });
    deleteButton.disabled = busy;

    row.append(select, validateButton, deleteButton);
    controls.modelConfigList.append(row);
  }
}

function createModelConfigActionButton({ action, configId, label, icon }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "model-config-action";
  button.dataset.action = action;
  button.dataset.configId = configId;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = icon === "trash"
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4"></path><path d="M4 4v5h5"></path><path d="M4 13a8 8 0 0 0 14.9 4"></path><path d="M20 20v-5h-5"></path></svg>';
  return button;
}

function getModelConfigHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch (error) {
    return "自定义接口";
  }
}

async function handleModelConfigListClick(event) {
  const button = event.target.closest("button[data-config-id]");
  if (!button) {
    return;
  }

  const configId = button.dataset.configId;
  try {
    if (button.dataset.action === "select") {
      await selectModelConfig(configId);
      return;
    }
    if (button.dataset.action === "validate") {
      await validateModelConfigById(configId);
      return;
    }
    if (button.dataset.action === "delete") {
      await deleteModelConfig(configId);
    }
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

function startNewModelConfig() {
  if (!confirmDiscardModelDraft()) {
    return;
  }

  editingModelConfigId = "";
  controls.model.value = "";
  controls.endpoint.value = "";
  controls.apiKey.value = "";
  modelEditorDirty = false;
  setApiKeyVisibility(false);
  closeModelPicker();
  syncModelPickerSelection();
  syncCustomModelEntry();
  renderModelConfigList();
  syncConfiguredModelIndicators();
  setStatus("请填写一套新的模型、接口地址和 API 密钥。", "");
  controls.model.focus();
}

function confirmDiscardModelDraft() {
  return !modelEditorDirty || window.confirm("当前模型配置尚未保存，确定放弃这些修改吗？");
}

async function selectModelConfig(configId) {
  const config = settingsCache.modelConfigs.find((item) => item.id === configId);
  if (!config || (configId === editingModelConfigId && !modelEditorDirty)) {
    return;
  }
  if (!confirmDiscardModelDraft()) {
    return;
  }

  const nextSettings = normalizeSettings({
    ...settingsCache,
    activeModelConfigId: configId,
    modelConfigs: settingsCache.modelConfigs
  });
  await persistSettingsState(nextSettings);
  loadModelConfigIntoEditor(config);
  renderModelConfigList();
  syncConfiguredModelIndicators();
  setStatus(`已切换到 ${config.model}。`, "success");
}

async function deleteModelConfig(configId) {
  const config = settingsCache.modelConfigs.find((item) => item.id === configId);
  if (!config || !window.confirm(`确定删除模型配置“${config.model}”吗？`)) {
    return;
  }

  const modelConfigs = settingsCache.modelConfigs.filter((item) => item.id !== configId);
  const activeModelConfigId = settingsCache.activeModelConfigId === configId
    ? modelConfigs[0]?.id || ""
    : settingsCache.activeModelConfigId;
  const nextSettings = normalizeSettings({
    ...settingsCache,
    modelConfigs,
    activeModelConfigId
  });
  const deletedEditor = editingModelConfigId === configId;

  await persistSettingsState(nextSettings);
  if (deletedEditor) {
    loadModelConfigIntoEditor(getActiveModelConfigFromSettings(nextSettings));
  }
  renderModelConfigList();
  syncConfiguredModelIndicators();
  setStatus(`已删除 ${config.model}。`, "success");
}

function loadModelConfigIntoEditor(config) {
  editingModelConfigId = config?.id || "";
  controls.model.value = config?.model || "";
  controls.endpoint.value = config?.endpoint || "";
  controls.apiKey.value = config?.apiKey || "";
  modelEditorDirty = false;
  setApiKeyVisibility(false);
  syncModelPickerSelection();
  syncCustomModelEntry();
}

function getActiveModelConfigFromSettings(settings) {
  const configs = Array.isArray(settings?.modelConfigs) ? settings.modelConfigs : [];
  return configs.find((config) => config.id === settings.activeModelConfigId) || configs[0] || null;
}

function initAssistantSelects() {
  const selects = Array.from(document.querySelectorAll(".ui-select select"));

  for (const select of selects) {
    const shell = select.closest(".ui-select");
    if (!shell || shell.dataset.assistantSelect === "true") {
      continue;
    }

    shell.dataset.assistantSelect = "true";
    select.dataset.assistantNativeSelect = "true";
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");

    const label = document.querySelector(`label[for="${select.id}"]`);
    const labelText = label?.textContent?.trim() || "选择";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "assistant-select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", `${select.id}-assistant-listbox`);
    trigger.setAttribute("aria-label", labelText);

    const value = document.createElement("span");
    value.className = "assistant-select-value";

    const chevron = document.createElement("span");
    chevron.className = "assistant-select-chevron";
    chevron.setAttribute("aria-hidden", "true");

    const content = document.createElement("div");
    content.className = "assistant-select-content";
    content.id = `${select.id}-assistant-listbox`;
    content.setAttribute("role", "listbox");
    content.setAttribute("aria-label", labelText);
    content.hidden = true;

    trigger.append(value, chevron);
    shell.append(trigger, content);

    const instance = { select, shell, trigger, value, content };
    assistantSelects.push(instance);
    renderAssistantSelectOptions(instance);
    syncAssistantSelect(instance);

    trigger.addEventListener("click", () => {
      if (trigger.disabled) {
        return;
      }

      if (content.hidden) {
        openAssistantSelect(instance, false);
      } else {
        closeAssistantSelect(instance);
      }
    });

    trigger.addEventListener("keydown", (event) => handleAssistantSelectTriggerKeydown(event, instance));
    content.addEventListener("keydown", (event) => handleAssistantSelectListKeydown(event, instance));
    select.addEventListener("change", () => syncAssistantSelect(instance));
    label?.addEventListener("click", (event) => {
      event.preventDefault();
      trigger.focus();
    });
  }

  if (!assistantSelectListenersInstalled) {
    assistantSelectListenersInstalled = true;
    document.addEventListener("mousedown", (event) => {
      if (!assistantSelects.some((instance) => instance.shell.contains(event.target))) {
        closeAllAssistantSelects();
      }
    });
    window.addEventListener("blur", closeAllAssistantSelects);
  }
}

function renderAssistantSelectOptions(instance) {
  instance.content.innerHTML = "";

  for (const child of Array.from(instance.select.children)) {
    if (child.tagName === "OPTGROUP") {
      const label = document.createElement("div");
      label.className = "assistant-select-group-label";
      label.textContent = child.label;
      instance.content.append(label);

      for (const option of Array.from(child.children)) {
        instance.content.append(createAssistantSelectOption(instance, option));
      }
      continue;
    }

    if (child.tagName === "OPTION") {
      instance.content.append(createAssistantSelectOption(instance, child));
    }
  }
}

function createAssistantSelectOption(instance, option) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "assistant-select-option";
  item.setAttribute("role", "option");
  item.dataset.value = option.value;
  item.disabled = option.disabled || option.parentElement?.disabled === true;
  item.textContent = option.textContent;
  item.addEventListener("click", () => selectAssistantOption(instance, option.value));
  return item;
}

function syncAssistantSelect(instance) {
  const selectedOption = instance.select.selectedOptions?.[0] || instance.select.options[instance.select.selectedIndex];
  const selectedValue = selectedOption?.value || "";

  instance.value.textContent = selectedOption?.textContent || "";
  instance.trigger.disabled = instance.select.disabled;
  instance.trigger.title = selectedOption?.textContent || "";

  for (const item of getAssistantSelectOptions(instance)) {
    const isSelected = item.dataset.value === selectedValue;
    item.setAttribute("aria-selected", String(isSelected));
    item.tabIndex = isSelected ? 0 : -1;
  }
}

function selectAssistantOption(instance, value) {
  const option = Array.from(instance.select.options).find((item) => item.value === value);
  if (!option || option.disabled) {
    return;
  }

  const previousValue = instance.select.value;
  instance.select.value = value;
  syncAssistantSelect(instance);
  closeAssistantSelect(instance);
  instance.trigger.focus();

  if (previousValue !== value) {
    instance.select.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function openAssistantSelect(instance, focusSelected) {
  closeAllAssistantSelects(instance);
  renderAssistantSelectOptions(instance);
  syncAssistantSelect(instance);
  instance.content.hidden = false;
  instance.trigger.setAttribute("aria-expanded", "true");
  instance.shell.dataset.state = "open";

  if (focusSelected) {
    focusAssistantSelectOption(getSelectedAssistantOption(instance) || getAssistantSelectOptions(instance)[0]);
  }
}

function closeAssistantSelect(instance) {
  instance.content.hidden = true;
  instance.trigger.setAttribute("aria-expanded", "false");
  instance.shell.dataset.state = "closed";
}

function closeAllAssistantSelects(exceptInstance = null) {
  for (const instance of assistantSelects) {
    if (instance !== exceptInstance) {
      closeAssistantSelect(instance);
    }
  }
}

function handleAssistantSelectTriggerKeydown(event, instance) {
  if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
    event.preventDefault();
    openAssistantSelect(instance, true);
  }
}

function handleAssistantSelectListKeydown(event, instance) {
  const options = getAssistantSelectOptions(instance).filter((item) => !item.disabled);
  const currentIndex = Math.max(0, options.indexOf(document.activeElement));

  if (event.key === "Escape") {
    event.preventDefault();
    closeAssistantSelect(instance);
    instance.trigger.focus();
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (document.activeElement?.classList.contains("assistant-select-option")) {
      selectAssistantOption(instance, document.activeElement.dataset.value);
    }
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const nextIndex = getAssistantSelectNextIndex(event.key, currentIndex, options.length);
    focusAssistantSelectOption(options[nextIndex]);
  }
}

function getAssistantSelectNextIndex(key, currentIndex, optionCount) {
  if (key === "Home") {
    return 0;
  }

  if (key === "End") {
    return Math.max(0, optionCount - 1);
  }

  if (key === "ArrowUp") {
    return Math.max(0, currentIndex - 1);
  }

  return Math.min(Math.max(0, optionCount - 1), currentIndex + 1);
}

function getAssistantSelectOptions(instance) {
  return Array.from(instance.content.querySelectorAll(".assistant-select-option"));
}

function getSelectedAssistantOption(instance) {
  return getAssistantSelectOptions(instance).find((item) => item.getAttribute("aria-selected") === "true");
}

function focusAssistantSelectOption(option) {
  if (option) {
    option.focus();
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

  return normalizeSettings({
    ...settingsCache,
    provider,
    modelConfigs: settingsCache.modelConfigs,
    activeModelConfigId: settingsCache.activeModelConfigId,
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

async function handleProviderChange() {
  const nextProvider = controls.provider.value;
  const previousProvider = activeProvider;
  if (previousProvider === "custom" && nextProvider !== "custom" && !confirmDiscardModelDraft()) {
    controls.provider.value = previousProvider;
    const instance = assistantSelects.find((item) => item.select === controls.provider);
    if (instance) {
      syncAssistantSelect(instance);
    }
    return;
  }

  try {
    const nextSettings = normalizeSettings({
      ...getFormValues(),
      provider: nextProvider
    });
    await persistSettingsState(nextSettings);
    applyProviderPresentation(nextProvider, nextSettings);
    setStatus(
      nextProvider === "auto"
        ? "已启用 Auto，将从配置成功的模型中自动选择。"
        : "已切换到自定义兼容接口。",
      "success"
    );
  } catch (error) {
    controls.provider.value = previousProvider;
    const instance = assistantSelects.find((item) => item.select === controls.provider);
    if (instance) {
      syncAssistantSelect(instance);
    }
    setStatus(error.message || String(error), "error");
  }
}

function applyProviderPresentation(provider, settings) {
  const isAuto = provider === "auto";
  document.body.dataset.provider = provider;

  controls.apiKeyLabel.textContent = isAuto ? "已连接密钥" : "自定义兼容接口 API 密钥";
  controls.apiKey.disabled = isAuto;
  controls.apiKey.placeholder = isAuto ? "使用配置成功的兼容接口" : "sk-...";
  controls.toggleApiKey.disabled = isAuto;

  controls.model.disabled = isAuto;
  controls.toggleModelPicker.disabled = isAuto;
  controls.endpoint.disabled = isAuto;
  controls.addModelConfig.disabled = isAuto;
  controls.modelLabel.textContent = "模型";
  controls.model.placeholder = isAuto ? "" : "请配置模型";
  controls.endpoint.placeholder = isAuto ? "" : "请输入接口地址";

  if (isAuto) {
    controls.model.value = "自动选择";
    controls.endpoint.value = "自动选择";
    controls.apiKey.value = "";
    modelEditorDirty = false;
    closeModelPicker();
  } else {
    loadModelConfigIntoEditor(getActiveModelConfigFromSettings(settings));
  }

  setApiKeyVisibility(false);
  renderModelConfigList();
  syncConfiguredModelIndicators();
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

async function persistSettingsState(nextSettings) {
  const normalized = normalizeSettings(nextSettings);
  await chrome.storage.local.set(normalized);
  settingsCache = normalized;
  persistedSettings = snapshotSettings(normalized);
  activeProvider = normalized.provider;
  return normalized;
}

function upsertModelConfigFromEditor(baseSettings) {
  const draft = getModelEditorDraft();
  const draftValues = [draft.model, draft.endpoint, draft.apiKey];
  if (draftValues.every((value) => !value)) {
    throw new Error("请先配置模型、接口地址和 API 密钥。");
  }
  if (draftValues.some((value) => !value)) {
    throw new Error("请完整填写模型、接口地址和 API 密钥。");
  }

  const configs = baseSettings.modelConfigs.map((config) => ({ ...config }));
  const existingIndex = configs.findIndex((config) => config.id === editingModelConfigId);
  const existing = existingIndex >= 0 ? configs[existingIndex] : null;
  const duplicate = configs.find((config) => (
    config.id !== existing?.id && sameModelConfigCredentials(config, draft)
  ));

  if (existing && duplicate) {
    throw new Error("相同的模型、接口地址和 API 密钥已经存在。");
  }

  if (!existing && duplicate) {
    return {
      settings: normalizeSettings({
        ...baseSettings,
        modelConfigs: configs,
        activeModelConfigId: duplicate.id
      }),
      configId: duplicate.id,
      shouldValidate: needsValidationOnSave(duplicate)
    };
  }

  const now = Date.now();
  const credentialsChanged = !existing || !sameModelConfigCredentials(existing, draft);
  const config = normalizeModelConfig({
    ...existing,
    id: existing?.id || createModelConfigId(configs),
    ...draft,
    provider: inferModelConfigProvider(draft),
    enabled: true,
    validationStatus: credentialsChanged ? "untested" : existing.validationStatus,
    validationMessage: credentialsChanged ? "" : existing.validationMessage,
    validatedAt: credentialsChanged ? 0 : existing.validatedAt,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  });

  if (existingIndex >= 0) {
    configs[existingIndex] = config;
  } else {
    configs.push(config);
  }

  return {
    settings: normalizeSettings({
      ...baseSettings,
      modelConfigs: configs,
      activeModelConfigId: config.id
    }),
    configId: config.id,
    shouldValidate: credentialsChanged || needsValidationOnSave(config)
  };
}

function sameModelConfigCredentials(config, draft) {
  return Boolean(config
    && config.model === draft.model
    && config.endpoint === draft.endpoint
    && config.apiKey === draft.apiKey);
}

function createModelConfigId(configs) {
  let id;
  do {
    id = globalThis.crypto?.randomUUID?.()
      || `model-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  } while (configs.some((config) => config.id === id));
  return id;
}

function isModelValidationStale(config) {
  return !config.validatedAt || Date.now() - config.validatedAt > MODEL_VALIDATION_MAX_AGE_MS;
}

function needsValidationOnSave(config) {
  return config.validationStatus !== "valid" || isModelValidationStale(config);
}

function needsStartupValidation(config) {
  if (config.validationStatus === "untested" || config.validationStatus === "validating") {
    return true;
  }
  return config.validationStatus === "valid" && isModelValidationStale(config);
}

async function handleSaveSettingsClick() {
  setBusy(true);
  try {
    await saveSettings({ saveModel: true, validate: true });
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function saveSettings({ saveModel = true, validate = true, silent = false } = {}) {
  let nextSettings = getFormValues();
  let configId = "";
  let shouldValidate = false;

  if (saveModel && nextSettings.provider === "custom") {
    const upserted = upsertModelConfigFromEditor(nextSettings);
    nextSettings = upserted.settings;
    configId = upserted.configId;
    shouldValidate = upserted.shouldValidate;
  }

  await persistSettingsState(nextSettings);

  if (configId) {
    editingModelConfigId = configId;
    loadModelConfigIntoEditor(settingsCache.modelConfigs.find((config) => config.id === configId));
  }

  renderModelConfigList();
  syncConfiguredModelIndicators();

  let validationResult = null;
  if (validate && configId && shouldValidate) {
    validationResult = await validateModelConfigById(configId, { silent });
  } else if (!silent) {
    setStatus("设置已保存。", "success");
  }

  return { settings: settingsCache, validationResult };
}

function patchModelConfigValidation(settings, configId, patch) {
  if (!settings.modelConfigs.some((config) => config.id === configId)) {
    return settings;
  }

  return normalizeSettings({
    ...settings,
    modelConfigs: settings.modelConfigs.map((config) => (
      config.id === configId ? { ...config, ...patch } : config
    ))
  });
}

async function validateModelConfigById(configId, { silent = false, retryStale = true } = {}) {
  let task = modelValidationTasks.get(configId);
  if (!task) {
    task = (async () => {
      try {
        return await performModelConfigValidation(configId);
      } finally {
        modelValidationTasks.delete(configId);
      }
    })();
    modelValidationTasks.set(configId, task);
  }

  try {
    const result = await task;
    if (result.stale && retryStale && settingsCache.modelConfigs.some((config) => config.id === configId)) {
      return validateModelConfigById(configId, { silent, retryStale: false });
    }
    if (!silent) {
      setStatus(
        result.validationMessage || getValidationStatusLabel(result.validationStatus),
        result.validationStatus === "valid" ? "success" : "error"
      );
    }
    return result;
  } catch (error) {
    if (!silent) {
      setStatus(error.message || String(error), "error");
    }
    throw error;
  }
}

async function performModelConfigValidation(configId) {
  const config = settingsCache.modelConfigs.find((item) => item.id === configId);
  if (!config) {
    throw new Error("找不到要核验的模型配置。");
  }

  const previousValidation = {
    validationStatus: config.validationStatus,
    validationMessage: config.validationMessage,
    validatedAt: config.validatedAt
  };
  const validatingPatch = {
    validationStatus: "validating",
    validationMessage: "正在核验 API Key 与模型...",
    validatedAt: 0
  };
  settingsCache = patchModelConfigValidation(settingsCache, configId, validatingPatch);
  persistedSettings = snapshotSettings(patchModelConfigValidation(persistedSettings, configId, validatingPatch));
  renderModelConfigList();
  syncConfiguredModelIndicators();

  try {
    const response = await sendRuntimeMessage({
      type: "VALIDATE_MODEL_CONFIG",
      payload: { configId }
    });
    const currentConfig = settingsCache.modelConfigs.find((item) => item.id === configId);
    const stale = response.stale === true || !sameModelConfigCredentials(currentConfig, config);
    const result = stale
      ? {
          configId,
          validationStatus: "untested",
          validationMessage: "配置已发生变化，正在重新核验。",
          validatedAt: 0,
          stale: true
        }
      : {
          configId,
          validationStatus: response.validationStatus || "invalid",
          validationMessage: response.validationMessage || "配置失败：接口未返回核验结果。",
          validatedAt: Number(response.validatedAt || 0),
          stale: false
        };
    settingsCache = patchModelConfigValidation(settingsCache, configId, result);
    persistedSettings = snapshotSettings(patchModelConfigValidation(persistedSettings, configId, result));
    if (!stale) {
      await persistModelValidationResult(config, result);
    }
    renderModelConfigList();
    syncConfiguredModelIndicators();
    return result;
  } catch (error) {
    settingsCache = patchModelConfigValidation(settingsCache, configId, previousValidation);
    persistedSettings = snapshotSettings(patchModelConfigValidation(persistedSettings, configId, previousValidation));
    renderModelConfigList();
    syncConfiguredModelIndicators();
    throw error;
  }
}

async function persistModelValidationResult(expectedConfig, result) {
  const stored = await chrome.storage.local.get(["modelConfigs"]);
  const modelConfigs = Array.isArray(stored.modelConfigs) ? stored.modelConfigs : [];
  const current = modelConfigs.find((config) => config.id === expectedConfig.id);
  if (!sameModelConfigCredentials(current, expectedConfig)) {
    return;
  }

  await chrome.storage.local.set({
    modelConfigs: modelConfigs.map((config) => (
      config.id === expectedConfig.id
        ? {
            ...config,
            validationStatus: result.validationStatus,
            validationMessage: result.validationMessage,
            validatedAt: result.validatedAt
          }
        : config
    ))
  });
}

async function validateModelConfigsNeedingCheck() {
  const configIds = settingsCache.modelConfigs
    .filter(needsStartupValidation)
    .map((config) => config.id);

  for (const configId of configIds) {
    const current = settingsCache.modelConfigs.find((config) => config.id === configId);
    if (!current || !needsStartupValidation(current)) {
      continue;
    }
    try {
      await validateModelConfigById(configId, { silent: true });
    } catch (error) {
      // A manual retry remains available beside every saved configuration.
    }
  }
}

function ensureSelectedModelIsReady(settings) {
  if (settings.provider === "auto") {
    if (settings.speedMode === "fast") {
      return;
    }
    if (!settings.modelConfigs.some((config) => config.enabled && config.validationStatus === "valid")) {
      throw new Error("Auto 没有可用模型，请先完成至少一套模型配置并核验成功。");
    }
    return;
  }

  const config = getActiveModelConfigFromSettings(settings);
  if (!config) {
    throw new Error("请先配置模型、接口地址和 API 密钥。");
  }
  if (config.validationStatus !== "valid") {
    throw new Error(config.validationMessage || "当前模型尚未核验成功，请重新保存或点击核验按钮。");
  }
}

async function runTabAction(type, shouldSave = true) {
  setBusy(true);

  try {
    if (shouldSave) {
      const hasReadyAutoModel = settingsCache.modelConfigs.some((config) => (
        config.enabled && config.validationStatus === "valid"
      ));
      const accurateAuto = controls.provider.value === "auto" && controls.speedMode.value === "accurate";
      if (accurateAuto && !hasReadyAutoModel && modelValidationTasks.size) {
        setStatus("正在核验已保存的模型配置...", "");
        await startupValidationPromise;
      }
      await saveSettings({
        saveModel: controls.provider.value === "custom",
        validate: true,
        silent: true
      });
    }

    if (type === "TRANSLATE_PAGE" || type === "TRANSLATE_SELECTION") {
      ensureSelectedModelIsReady(settingsCache);
    }

    const response = await sendToActiveTab({
      type,
      options: getFormValues()
    });

    if (!response?.ok) {
      throw new Error(response?.error || "当前页面无法执行此操作。");
    }

    if (type === "TRANSLATE_PAGE" || type === "RESTORE_PAGE") {
      syncPageTranslationControl(response);
    }

    setStatus(statusFor(type, response), "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function refreshPageTranslationState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      syncPageTranslationControl();
      return;
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_PAGE_TRANSLATION_STATE"
    });

    syncPageTranslationControl(response?.ok ? response : null);
  } catch (error) {
    syncPageTranslationControl();
  }
}

function syncPageTranslationControl(nextState = null) {
  const hasTranslation = nextState?.hasTranslation === true;
  const view = hasTranslation && nextState?.view === "translated" ? "translated" : "original";
  const action = hasTranslation && view === "original" ? "show-translation" : "show-original";
  const label = !hasTranslation
    ? "暂无可切换的译文"
    : action === "show-translation" ? "恢复译文" : "恢复原文";

  pageTranslationState = { hasTranslation, view };
  controls.restorePage.dataset.action = action;
  controls.restorePage.dataset.available = String(hasTranslation);
  controls.restorePage.title = label;
  controls.restorePage.setAttribute("aria-label", label);
  controls.restorePage.disabled = busy || !hasTranslation;
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

      if ((response?.ok || response?.ready) && response.version === REQUIRED_CONTENT_SCRIPT_VERSION) {
        return;
      }
    } catch (error) {
      // Existing tabs opened before the extension was loaded need manual injection.
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["vendor/Readability-readerable.js", "vendor/Readability.js", "src/contentScript.js"]
    });
  } catch (error) {
    throw new Error("无法在这个页面运行翻译脚本，请打开普通 http/https 网页后重试。");
  }
}

function statusFor(type, response) {
  const providerSuffix = formatProviderSuffix(response.provider, response.model);
  const cacheSuffix = formatCacheSuffix(response);

  if (type === "TRANSLATE_PAGE") {
    return `已翻译 ${response.translated || 0} 段文本${providerSuffix}${cacheSuffix}。`;
  }

  if (type === "TRANSLATE_SELECTION") {
    return `已翻译选中文本${providerSuffix}${cacheSuffix}。`;
  }

  if (!response.hasTranslation) {
    return "当前页面还没有可切换的译文。";
  }

  return response.view === "translated" ? "已恢复译文。" : "已恢复原文。";
}

function formatProviderSuffix(provider, model = "") {
  const label = getProviderLabel(provider);
  const route = [label, String(model || "").trim()].filter(Boolean).join(" · ");
  return route ? `，使用 ${route}` : "";
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
  busy = isBusy;
  controls.saveSettings.disabled = isBusy;
  controls.translatePage.disabled = isBusy;
  controls.translateSelection.disabled = isBusy;
  controls.addModelConfig.disabled = isBusy || controls.provider.value === "auto";
  controls.restorePage.disabled = isBusy || !pageTranslationState.hasTranslation;
  renderModelConfigList();
}

function setStatus(message, tone = "") {
  controls.status.textContent = message;
  controls.status.dataset.tone = tone;
}
