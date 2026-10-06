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
    label: "OpenAI vagy OpenAI-kompatibilis (OpenRouter, Ollama, LM Studio…)",
    defaultModel: "gpt-5-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: ["gpt-5-mini", "gpt-5-nano", "gpt-5", "gpt-4.1-mini"],
    keyUrl: "https://platform.openai.com/api-keys",
  },
};

export const DEFAULTS = {
  provider: "anthropic",
  anthropicModel: PROVIDERS.anthropic.defaultModel,
  anthropicBaseUrl: "",
  openaiModel: PROVIDERS.openai.defaultModel,
  openaiBaseUrl: "",
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

const KEY_FIELDS = ["anthropicKey", "openaiKey"];

export async function getSettings() {
  const synced = await chrome.storage.sync.get({ ...DEFAULTS, model: null });
  const local = await chrome.storage.local.get([...KEY_FIELDS, "apiKey"]);
  const settings = { ...DEFAULTS, ...synced };
  // Settings saved by version 0.1 used a single model and apiKey for Claude.
  if (synced.model && settings.anthropicModel === DEFAULTS.anthropicModel) settings.anthropicModel = synced.model;
  delete settings.model;
  settings.anthropicKey = local.anthropicKey ?? local.apiKey ?? "";
  settings.openaiKey = local.openaiKey ?? "";
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
  const id = settings.provider in PROVIDERS ? settings.provider : "anthropic";
  return {
    id,
    model: settings[`${id}Model`].trim() || PROVIDERS[id].defaultModel,
    baseUrl: settings[`${id}BaseUrl`].trim().replace(/\/+$/, ""),
    apiKey: settings[`${id}Key`].trim(),
  };
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
