import { DEFAULTS, MODELS, getSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);

async function load() {
  const settings = await getSettings();
  $("model").innerHTML = MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
  $("apiKey").value = settings.apiKey;
  $("model").value = settings.model;
  $("interests").value = settings.interests;
  $("sites").value = settings.sites;
  $("autoSummary").checked = settings.autoSummary;
  $("headlineBadges").checked = settings.headlineBadges;
}

async function save() {
  await chrome.storage.local.set({ apiKey: $("apiKey").value.trim() });
  await chrome.storage.sync.set({
    model: $("model").value || DEFAULTS.model,
    interests: $("interests").value,
    sites: $("sites").value,
    autoSummary: $("autoSummary").checked,
    headlineBadges: $("headlineBadges").checked,
  });
  $("status").textContent = "Elmentve.";
  setTimeout(() => ($("status").textContent = ""), 2000);
}

$("save").addEventListener("click", save);
load();
