import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import * as z from "zod/v4";

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

function parseJsonText(text, schema) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  let value;
  try {
    value = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
  } catch {
    throw new Error("A modell nem érvényes JSON-t adott vissza. Próbálj másik modellt.");
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("A modell válasza nem a várt formátumú. Próbálj másik modellt.");
  return result.data;
}

// Reasoning models (gpt-5 family, o-series) reject temperature and max_tokens and take
// max_completion_tokens instead, which also has to cover their hidden reasoning tokens.
function isReasoningModel(model) {
  return /^(gpt-5|o\d)/.test(model.toLowerCase().replace(/^.*\//, ""));
}

function tokenParams(model, maxTokens) {
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
    if (!(error instanceof OpenAI.BadRequestError || error instanceof OpenAI.UnprocessableEntityError)) throw error;
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
