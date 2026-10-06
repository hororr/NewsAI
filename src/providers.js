import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import * as z from "zod/v4";
import { isFreeModel } from "./settings.js";

// Both providers take the same request: a system prompt, one user message and a zod
// schema for the JSON answer. Each returns the parsed object or throws.

async function callAnthropic(provider, { system, user, schema, maxTokens }) {
  if (!provider.apiKey) throw new Error("Nincs megadva Anthropic API-kulcs. Add meg a bővítmény beállításaiban.");
  const client = new Anthropic({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl || undefined,
    dangerouslyAllowBrowser: true,
  });
  // Haiku 4.5 does not take the effort parameter; on the larger models low effort
  // keeps summaries fast and cheap.
  const effort = provider.model.startsWith("claude-haiku") ? {} : { effort: "low" };
  const response = await client.messages.parse({
    model: provider.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(schema), ...effort },
  });
  if (response.stop_reason === "refusal") throw new Error("A modell ezt a tartalmat nem dolgozta fel.");
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new Error("A válasz hiányos lett, próbáld újra.");
  }
  return response.parsed_output;
}

function strictJsonSchema(schema) {
  const json = z.toJSONSchema(schema);
  delete json.$schema;
  // Integer bounds are not accepted by every OpenAI-compatible server; ranges are in the prompt.
  const strip = (node) => {
    if (!node || typeof node !== "object") return;
    delete node.minimum;
    delete node.maximum;
    Object.values(node).forEach(strip);
  };
  strip(json);
  return json;
}

// Coerce "7" to 7 and the like; some free models quote their numbers.
function coerceNumbers(value) {
  if (Array.isArray(value)) return value.map(coerceNumbers);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, coerceNumbers(v)]));
  }
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return value;
}

// Every balanced {...} block in the text, longest first.
function jsonCandidates(text) {
  const found = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        found.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return found.sort((x, y) => y.length - x.length);
}

// Models in JSON mode (especially free ones) wrap the answer in reasoning, prose or
// code fences; dig the object out and validate it.
function parseJsonText(text, schema) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  let sawJson = false;
  for (const candidate of jsonCandidates(cleaned)) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    sawJson = true;
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    const coerced = schema.safeParse(coerceNumbers(value));
    if (coerced.success) return coerced.data;
  }
  throw new Error(
    sawJson
      ? "A modell válasza nem a várt formátumú. Próbálj másik modellt."
      : "A modell nem érvényes JSON-t adott vissza. Próbálj másik modellt.",
  );
}

// Reasoning models (gpt-5 family, o-series) reject temperature and max_tokens and take
// max_completion_tokens instead, which also has to cover their hidden reasoning tokens.
function isReasoningModel(model) {
  return /^(gpt-5|o\d)/.test(model.toLowerCase().replace(/^.*\//, ""));
}

function tokenParams(model, maxTokens) {
  // The free router may pick a reasoning model; a token cap would cut it off, and
  // free requests cost nothing, so leave the limits to the model.
  if (isFreeModel(model)) return {};
  return isReasoningModel(model)
    ? { max_completion_tokens: Math.max(maxTokens * 4, 8000) }
    : { temperature: 0.3, max_tokens: maxTokens };
}

async function callOpenAI(provider, { system, user, schema, maxTokens }) {
  const openrouter = provider.id === "openrouter";
  const custom = Boolean(provider.baseUrl) && !openrouter;
  if (!provider.apiKey && !custom) {
    throw new Error(`Nincs megadva ${openrouter ? "OpenRouter" : "OpenAI"} API-kulcs. Add meg a bővítmény beállításaiban.`);
  }
  const client = new OpenAI({
    // Local servers such as Ollama need no key, but the SDK requires a value.
    apiKey: provider.apiKey || "nincs-kulcs",
    baseURL: provider.baseUrl || undefined,
    dangerouslyAllowBrowser: true,
    // OpenRouter shows the app name in its usage dashboard.
    defaultHeaders: openrouter ? { "X-Title": "NewsAI" } : undefined,
  });
  const jsonSchema = strictJsonSchema(schema);
  // OpenRouter: among the providers serving the chosen model, use the cheapest
  // (the same as the model's ":floor" variant).
  const routing = provider.cheapest ? { provider: { sort: "price" } } : {};
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  // The free router picks a different model each time, so a malformed answer is
  // worth another try.
  const attempts = openrouter && isFreeModel(provider.model) ? 3 : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestJson(client, provider, { system, schema, messages, maxTokens, jsonSchema, routing });
    } catch (error) {
      if (attempt >= attempts || error instanceof OpenAI.APIError) throw error;
    }
  }
}

async function requestJson(client, provider, { system, schema, messages, maxTokens, jsonSchema, routing }) {
  const user = messages[1].content;
  let completion;
  try {
    completion = await client.chat.completions.create({
      model: provider.model,
      messages,
      ...tokenParams(provider.model, maxTokens),
      ...routing,
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: jsonSchema } },
    });
  } catch (error) {
    // Many OpenAI-compatible servers only know the older JSON mode; retry with the
    // schema spelled out in the prompt instead.
    // OpenRouter answers 404 when no model behind the request supports json_schema.
    const unsupported =
      error instanceof OpenAI.BadRequestError ||
      error instanceof OpenAI.UnprocessableEntityError ||
      (provider.id === "openrouter" && error instanceof OpenAI.NotFoundError);
    if (!unsupported) throw error;
    completion = await client.chat.completions.create({
      model: provider.model,
      messages: [
        { role: "system", content: `${system}\n\nVálaszolj kizárólag egy JSON objektummal, ami megfelel ennek a sémának:\n${JSON.stringify(jsonSchema)}` },
        { role: "user", content: user },
      ],
      ...tokenParams(provider.model, maxTokens),
      ...routing,
      response_format: { type: "json_object" },
    });
  }

  const choice = completion.choices?.[0];
  if (choice?.message?.refusal) throw new Error("A modell ezt a tartalmat nem dolgozta fel.");
  if (choice?.finish_reason === "length") throw new Error("A válasz hiányos lett, próbáld újra.");
  if (!choice?.message?.content) throw new Error("A modell üres választ adott.");
  return parseJsonText(choice.message.content, schema);
}

export async function callModel(provider, request) {
  return provider.id === "anthropic" ? callAnthropic(provider, request) : callOpenAI(provider, request);
}

export function friendlyError(error) {
  for (const SDK of [Anthropic, OpenAI]) {
    if (error instanceof SDK.AuthenticationError) return "Érvénytelen API-kulcs. Ellenőrizd a beállításokban.";
    if (error instanceof SDK.PermissionDeniedError) return "Az API-kulcs nem jogosult erre a modellre.";
    if (error instanceof SDK.NotFoundError) return `Nem található: ellenőrizd a modell nevét és az endpointot. (${error.message})`;
    if (error instanceof SDK.RateLimitError) return "Túl sok kérés vagy elfogyott a keret, várj egy kicsit és próbáld újra.";
    if (error instanceof SDK.BadRequestError) return `Hibás kérés: ${error.message}`;
    if (error instanceof SDK.APIConnectionError) return "Nem sikerült elérni az API-t. Ellenőrizd az endpoint címét és a hálózatot.";
    if (error instanceof SDK.APIError) return `API-hiba (${error.status}): ${error.message}`;
  }
  return error?.message || String(error);
}
