import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { getSettings } from "./settings.js";

const ArticleSchema = z.object({
  summary: z.array(z.string()),
  scores: z.object({
    interest: z.number().int(),
    relevance: z.number().int(),
    novelty: z.number().int(),
    clickbait: z.number().int(),
  }),
  verdict: z.enum(["read", "skim", "skip"]),
  verdict_reason: z.string(),
  tags: z.array(z.string()),
});

const HeadlinesSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      score: z.number().int(),
      reason: z.string(),
    }),
  ),
});

// Articles longer than this are cut; news articles are almost always far shorter.
const MAX_ARTICLE_CHARS = 40000;
const CACHE_LIMIT = 3000;

function interestsBlock(settings) {
  const interests = settings.interests.trim();
  return interests
    ? `Az olvasó érdeklődési körei és szempontjai:\n${interests}`
    : "Az olvasó nem adott meg érdeklődési köröket; a relevanciát az általános közérdeklődés alapján becsüld.";
}

function clamp(n) {
  return Math.min(10, Math.max(1, Math.round(n)));
}

function requestOptions(model) {
  // Haiku 4.5 does not take the effort parameter; on the larger models low effort
  // keeps summaries fast and cheap.
  return model.startsWith("claude-haiku") ? {} : { effort: "low" };
}

async function callClaude(settings, { system, user, schema, maxTokens }) {
  if (!settings.apiKey) {
    throw new Error("Nincs megadva Anthropic API-kulcs. Add meg a bővítmény beállításaiban.");
  }
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const response = await client.messages.parse({
    model: settings.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(schema), ...requestOptions(settings.model) },
  });
  if (response.stop_reason === "refusal") {
    throw new Error("A modell ezt a tartalmat nem dolgozta fel.");
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new Error("A válasz hiányos lett, próbáld újra.");
  }
  return response.parsed_output;
}

async function summarizeArticle({ url, title, text }) {
  const settings = await getSettings();
  const cacheKey = `article:${settings.model}:${url}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const body = text.length > MAX_ARTICLE_CHARS ? text.slice(0, MAX_ARTICLE_CHARS) + "\n[…a cikk folytatódik]" : text;
  const system = [
    "Hírcikkeket foglalsz össze egy elfoglalt olvasónak, hogy olvasás előtt eldönthesse, megéri-e elolvasni.",
    "Mindig magyarul válaszolj, akkor is, ha a cikk más nyelvű.",
    "summary: 5-10 rövid, tényszerű mondat a cikk lényegéről, a legfontosabb információval kezdve. Ne ismételd a címet, ne értékelj, csak azt írd le, ami a cikkben van.",
    "scores (mind 1-10 egész szám): interest = mennyire érdekes és fontos általában; relevance = mennyire illik az olvasó érdeklődéséhez; novelty = mennyi valódi új információt tartalmaz; clickbait = mennyire ígér többet a cím, mint amit a cikk ad (10 = teljesen kattintásvadász).",
    "verdict: read = érdemes végigolvasni, skim = az összefoglaló nagyjából elég, skip = nem éri meg. verdict_reason: egy rövid mondat indoklás.",
    "tags: 1-4 rövid magyar témacímke.",
    interestsBlock(settings),
  ].join("\n\n");

  const result = await callClaude(settings, {
    system,
    user: `Cím: ${title}\nURL: ${url}\n\nA cikk szövege:\n${body}`,
    schema: ArticleSchema,
    maxTokens: 2000,
  });
  for (const key of Object.keys(result.scores)) result.scores[key] = clamp(result.scores[key]);
  await cacheSet(cacheKey, result);
  return result;
}

async function scoreHeadlines({ items }) {
  const settings = await getSettings();
  const results = {};
  const missing = [];
  for (const item of items) {
    const cached = await cacheGet(`headline:${settings.model}:${item.url}`);
    if (cached) results[item.url] = cached;
    else missing.push(item);
  }
  if (missing.length === 0) return results;

  const system = [
    "Egy hírportál címlapjának címeit pontozod egy elfoglalt olvasónak, hogy lássa, melyik cikket érdemes megnyitni.",
    "Minden címhez adj egy 1-10 közötti egész pontszámot (score): mennyire érdekes, fontos és releváns az olvasónak. Vond le a pontból, ha a cím kattintásvadásznak tűnik.",
    "reason: legfeljebb 12 szavas magyar indoklás.",
    "Minden kapott id-hez pontosan egy elemet adj vissza.",
    interestsBlock(settings),
  ].join("\n\n");

  // Keep requests small enough to answer quickly and fully.
  for (let i = 0; i < missing.length; i += 40) {
    const chunk = missing.slice(i, i + 40);
    const list = chunk.map((item, idx) => `${idx}: ${item.title}`).join("\n");
    const output = await callClaude(settings, {
      system,
      user: `Címek:\n${list}`,
      schema: HeadlinesSchema,
      maxTokens: 4000,
    });
    for (const entry of output.items) {
      const item = chunk[entry.id];
      if (!item) continue;
      const value = { score: clamp(entry.score), reason: entry.reason };
      results[item.url] = value;
      await cacheSet(`headline:${settings.model}:${item.url}`, value);
    }
  }
  return results;
}

async function cacheGet(key) {
  const { [key]: entry } = await chrome.storage.local.get(key);
  return entry?.value ?? null;
}

async function cacheSet(key, value) {
  await chrome.storage.local.set({ [key]: { value, at: Date.now() } });
  if (Math.random() < 0.05) await pruneCache();
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith("article:") || k.startsWith("headline:"));
  if (entries.length <= CACHE_LIMIT) return;
  entries.sort((a, b) => a[1].at - b[1].at);
  await chrome.storage.local.remove(entries.slice(0, entries.length - CACHE_LIMIT).map(([k]) => k));
}

function friendlyError(error) {
  if (error instanceof Anthropic.AuthenticationError) return "Érvénytelen API-kulcs. Ellenőrizd a beállításokban.";
  if (error instanceof Anthropic.PermissionDeniedError) return "Az API-kulcs nem jogosult erre a modellre.";
  if (error instanceof Anthropic.RateLimitError) return "Túl sok kérés, várj egy kicsit és próbáld újra.";
  if (error instanceof Anthropic.BadRequestError) return `Hibás kérés: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return "Nem sikerült elérni a Claude API-t (hálózati hiba).";
  if (error instanceof Anthropic.APIError) return `API-hiba (${error.status}): ${error.message}`;
  return error?.message || String(error);
}

const handlers = {
  summarize: summarizeArticle,
  scoreHeadlines,
  openOptions: async () => chrome.runtime.openOptionsPage(),
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) chrome.tabs.sendMessage(tab.id, { type: "summarizeNow" }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});
