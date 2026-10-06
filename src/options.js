import { PROVIDERS, getSettings, saveSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);
let settings;

// The form shows one provider at a time; keys, models and endpoints are kept per provider
// so switching back and forth does not lose anything.
function stashProviderFields(id) {
  settings[`${id}Key`] = $("apiKey").value.trim();
  settings[`${id}Model`] = $("model").value.trim();
  settings[`${id}BaseUrl`] = $("baseUrl").value.trim();
}

function showProviderFields(id) {
  const info = PROVIDERS[id];
  $("apiKey").value = settings[`${id}Key`];
  $("model").value = settings[`${id}Model`];
  $("baseUrl").value = settings[`${id}BaseUrl`];
  $("model").placeholder = info.defaultModel;
  $("modelList").innerHTML = info.models.map((m) => `<option value="${m}">`).join("");
  $("baseUrl").placeholder = info.defaultBaseUrl;
  $("openrouterOptions").hidden = id !== "openrouter";
  if (id === "openrouter") {
    $("apiKey").placeholder = "sk-or-...";
    $("keyHint").innerHTML = `Az OpenRouter-kulcsot az <a href="${info.keyUrl}" target="_blank">openrouter.ai</a> oldalon hozhatod létre. Egy kulccsal az OpenAI, Claude, Gemini, Llama és sok más modell is elérhető.`;
    $("baseUrlHint").textContent = "Üresen a hivatalos OpenRouter címet használja. A modellnevek szolgáltató/modell alakúak, a teljes lista: openrouter.ai/models.";
  } else if (id === "openai") {
    $("apiKey").placeholder = "sk-...";
    $("keyHint").innerHTML = `Az OpenAI-kulcsot a <a href="${info.keyUrl}" target="_blank">platform.openai.com</a> oldalon hozhatod létre. Saját endpointnál az ott kapott kulcsot add meg; helyi szervernél (pl. Ollama) üresen is hagyhatod.`;
    $("baseUrlHint").textContent = "Üresen az OpenAI-t használja. Más OpenAI-kompatibilis szolgáltatónál add meg a címét, pl. https://openrouter.ai/api/v1 vagy http://localhost:11434/v1 (Ollama).";
  } else {
    $("apiKey").placeholder = "sk-ant-...";
    $("keyHint").innerHTML = `Az Anthropic-kulcsot a <a href="${info.keyUrl}" target="_blank">console.anthropic.com</a> oldalon hozhatod létre.`;
    $("baseUrlHint").textContent = "Üresen a hivatalos Anthropic API-t használja. Akkor add meg, ha proxyn vagy saját átjárón keresztül éred el a Claude-ot.";
  }
  $("keyHint").insertAdjacentText("beforeend", " A kulcs csak ezen a gépen tárolódik, és csak a megadott API felé megy ki.");
}

async function load() {
  settings = await getSettings();
  $("provider").innerHTML = Object.entries(PROVIDERS)
    .map(([id, p]) => `<option value="${id}">${p.label}</option>`)
    .join("");
  $("provider").value = settings.provider;
  showProviderFields(settings.provider);
  $("openrouterCheapest").checked = settings.openrouterCheapest;
  $("interests").value = settings.interests;
  $("sites").value = settings.sites;
  $("autoSummary").checked = settings.autoSummary;
  $("headlineBadges").checked = settings.headlineBadges;
}

// A custom endpoint is outside the extension's built-in host permissions, so ask Chrome
// for access to it. This must run inside the click handler.
async function requestEndpointAccess(baseUrl) {
  if (!baseUrl) return true;
  let origin;
  try {
    const url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
    origin = `${url.protocol}//${url.hostname}/*`;
  } catch {
    $("status").textContent = "Az endpoint címe érvénytelen (http:// vagy https:// kezdetű legyen).";
    return false;
  }
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) $("status").textContent = "Engedély nélkül a bővítmény nem éri el az endpointot.";
  return granted;
}

async function save() {
  const provider = $("provider").value;
  stashProviderFields(provider);
  if (!(await requestEndpointAccess(settings[`${provider}BaseUrl`]))) return;
  await saveSettings({
    provider,
    anthropicKey: settings.anthropicKey,
    anthropicModel: settings.anthropicModel,
    anthropicBaseUrl: settings.anthropicBaseUrl,
    openaiKey: settings.openaiKey,
    openaiModel: settings.openaiModel,
    openaiBaseUrl: settings.openaiBaseUrl,
    openrouterKey: settings.openrouterKey,
    openrouterModel: settings.openrouterModel,
    openrouterBaseUrl: settings.openrouterBaseUrl,
    openrouterCheapest: $("openrouterCheapest").checked,
    interests: $("interests").value,
    sites: $("sites").value,
    autoSummary: $("autoSummary").checked,
    headlineBadges: $("headlineBadges").checked,
  });
  $("status").textContent = "Elmentve.";
  setTimeout(() => ($("status").textContent = ""), 2000);
}

$("provider").addEventListener("change", (event) => {
  stashProviderFields(settings.provider);
  settings.provider = event.target.value;
  showProviderFields(settings.provider);
});
$("save").addEventListener("click", save);
load();
