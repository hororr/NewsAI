// Shared defaults and storage helpers. API keys live in chrome.storage.local
// (never synced); everything else in chrome.storage.sync.

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    defaultModel: "claude-haiku-4-5",
    defaultBaseUrl: "https://api.anthropic.com",
    models: ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5"],
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    label: "OpenAI vagy OpenAI-kompatibilis (Ollama, LM Studio…)",
    defaultModel: "gpt-4.1",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: [
      "gpt-4.1", "gpt-4.1-2025-04-14",
      "gpt-4.1-mini", "gpt-4.1-mini-2025-04-14",
      "gpt-4.1-nano", "gpt-4.1-nano-2025-04-14",
      "gpt-4o", "gpt-4o-2024-08-06",
      "gpt-4o-mini", "gpt-4o-mini-2024-07-18",
      "gpt-5", "gpt-5-2025-08-07",
      "gpt-5-mini", "gpt-5-mini-2025-08-07",
      "gpt-5-nano", "gpt-5-nano-2025-08-07",
      "gpt-5.1", "gpt-5.1-2025-11-13",
      "gpt-5.2", "gpt-5.2-2025-12-11",
      "gpt-5.6-luna", "gpt-5.6-luna-2026-07-09",
      "o3", "o3-2025-04-16",
      "o3-mini", "o3-mini-2025-01-31",
      "o4-mini", "o4-mini-2025-04-16",
    ],
    keyUrl: "https://platform.openai.com/api-keys",
  },
  openrouter: {
    label: "OpenRouter (ingyenes modellek is, egy kulccsal)",
    defaultModel: "openrouter/free",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    models: [
      "openrouter/free",
      "openrouter/auto",
      "openai/gpt-4.1", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano",
      "openai/gpt-4o", "openai/gpt-4o-mini",
      "openai/gpt-5", "openai/gpt-5-mini", "openai/gpt-5-nano",
      "openai/gpt-5.1", "openai/gpt-5.2",
      "openai/o3", "openai/o3-mini", "openai/o4-mini",
      "anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5",
      "google/gemini-2.5-flash", "google/gemini-2.5-pro",
      "meta-llama/llama-3.3-70b-instruct",
    ],
    keyUrl: "https://openrouter.ai/settings/keys",
  },
};

export const DEFAULTS = {
  provider: "openrouter",
  anthropicModel: PROVIDERS.anthropic.defaultModel,
  anthropicBaseUrl: "",
  openaiModel: PROVIDERS.openai.defaultModel,
  openaiBaseUrl: "",
  openrouterModel: PROVIDERS.openrouter.defaultModel,
  openrouterBaseUrl: "",
  openrouterCheapest: true,
  interests: "",
  sites: [
    "index.hu",
    "telex.hu",
    "444.hu",
    "hvg.hu",
    "24.hu",
    "portfolio.hu",
    "origo.hu",
    "magyarnemzet.hu",
    "nepszava.hu",
  ].join("\n"),
  autoSummary: true,
  headlineBadges: true,
};

const KEY_FIELDS = ["anthropicKey", "openaiKey", "openrouterKey"];

export async function getSettings() {
  const synced = await chrome.storage.sync.get({ ...DEFAULTS, provider: null, model: null });
  const local = await chrome.storage.local.get([...KEY_FIELDS, "apiKey"]);
  const settings = { ...DEFAULTS, ...synced };
  // Settings saved by version 0.1 used a single model and apiKey for Claude.
  if (synced.model && settings.anthropicModel === DEFAULTS.anthropicModel) settings.anthropicModel = synced.model;
  delete settings.model;
  settings.anthropicKey = local.anthropicKey ?? local.apiKey ?? "";
  settings.openaiKey = local.openaiKey ?? "";
  settings.openrouterKey = local.openrouterKey ?? "";
  // Before OpenRouter became the default, a missing provider meant Claude.
  if (!synced.provider) settings.provider = settings.anthropicKey && !settings.openrouterKey ? "anthropic" : DEFAULTS.provider;
  return settings;
}

export async function saveSettings(values) {
  const local = {};
  const synced = {};
  for (const [key, value] of Object.entries(values)) {
    if (KEY_FIELDS.includes(key)) local[key] = value;
    else synced[key] = value;
  }
  await chrome.storage.local.set(local);
  await chrome.storage.local.remove("apiKey");
  await chrome.storage.sync.set(synced);
  await chrome.storage.sync.remove("model");
}

// The provider-specific view of the settings: which endpoint, key and model to call.
export function activeProvider(settings) {
  const id = settings.provider in PROVIDERS ? settings.provider : DEFAULTS.provider;
  return {
    id,
    model: settings[`${id}Model`].trim() || PROVIDERS[id].defaultModel,
    baseUrl: (settings[`${id}BaseUrl`].trim() || (id === "openrouter" ? PROVIDERS.openrouter.defaultBaseUrl : "")).replace(/\/+$/, ""),
    apiKey: settings[`${id}Key`].trim(),
    // Free models cost nothing, so price sorting would only narrow the choice.
    cheapest: id === "openrouter" && settings.openrouterCheapest && !isFreeModel(settings.openrouterModel),
  };
}

export function isFreeModel(model) {
  const m = (model || PROVIDERS.openrouter.defaultModel).trim();
  return m === "openrouter/free" || m.endsWith(":free");
}

export function siteList(settings) {
  return settings.sites
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}

export function matchesSite(hostname, settings) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return siteList(settings).some((site) => host === site || host.endsWith("." + site));
}
