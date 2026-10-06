// Shared defaults and storage helpers. The API key lives in chrome.storage.local
// (never synced); everything else in chrome.storage.sync.

export const MODELS = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (gyors, legolcsóbb)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (jobb minőség)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (legjobb, legdrágább)" },
];

export const DEFAULTS = {
  model: "claude-haiku-4-5",
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

export async function getSettings() {
  const synced = await chrome.storage.sync.get(DEFAULTS);
  const { apiKey = "" } = await chrome.storage.local.get("apiKey");
  return { ...DEFAULTS, ...synced, apiKey };
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
