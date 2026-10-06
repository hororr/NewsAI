import { Readability } from "@mozilla/readability";
import { getSettings, matchesSite } from "./settings.js";

const MIN_ARTICLE_CHARS = 1200;
const VERDICTS = {
  read: { label: "Érdemes elolvasni", color: "#1a7f37" },
  skim: { label: "Az összefoglaló elég", color: "#9a6700" },
  skip: { label: "Kihagyható", color: "#cf222e" },
};
const SCORE_LABELS = {
  interest: "Érdekesség",
  relevance: "Relevancia neked",
  novelty: "Újdonság",
  clickbait: "Kattintásvadászat",
};

let panelHost = null;

const RELOAD_HINT = "A bővítmény frissült. Töltsd újra az oldalt (F5).";

// After the extension is reloaded or updated, scripts left in already open tabs lose
// their connection to it and every chrome.* call throws.
function contextAlive() {
  return Boolean(globalThis.chrome?.runtime?.id);
}

function send(message) {
  if (!contextAlive()) return Promise.resolve({ ok: false, error: RELOAD_HINT });
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response);
    });
  });
}

function extractArticle() {
  const parsed = new Readability(document.cloneNode(true)).parse();
  if (!parsed?.textContent) return null;
  const text = parsed.textContent.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: parsed.title || document.title, text };
}

function looksLikeArticle() {
  const article = extractArticle();
  return article && article.text.length >= MIN_ARTICLE_CHARS ? article : null;
}

// ---------- Article summary panel ----------

const PANEL_CSS = `
  :host { all: initial; }
  .panel { position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 380px; max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px); overflow: auto; background: #fff; color: #1f2328; border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0,0,0,.25); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #d0d7de; position: sticky; top: 0; background: #fff; }
  .head b { flex: 1; font-size: 13px; letter-spacing: .02em; }
  button { all: unset; cursor: pointer; padding: 2px 8px; border-radius: 6px; color: #57606a; font-size: 13px; }
  button:hover { background: #f3f4f6; }
  .body { padding: 12px 14px 14px; }
  .collapsed .body { display: none; }
  .verdict { display: inline-block; color: #fff; font-weight: 600; padding: 3px 10px; border-radius: 999px; font-size: 13px; }
  .reason { margin: 6px 0 10px; color: #57606a; }
  .scores { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin-bottom: 12px; font-size: 13px; }
  .bar { display: inline-block; width: 70px; height: 6px; background: #eaeef2; border-radius: 3px; margin-right: 6px; vertical-align: middle; overflow: hidden; }
  .bar i { display: block; height: 100%; background: #0969da; }
  ul { margin: 0; padding-left: 18px; }
  li { margin-bottom: 4px; }
  .tags { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px; }
  .tags span { background: #eef2ff; color: #3730a3; padding: 1px 8px; border-radius: 999px; font-size: 12px; }
  .muted { color: #57606a; }
  .error { color: #cf222e; }
  a { color: #0969da; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    .panel, .head { background: #161b22; color: #e6edf3; }
    .head { border-color: #30363d; }
    button:hover { background: #21262d; }
    .reason, .muted, button { color: #8b949e; }
    .bar { background: #30363d; }
    .tags span { background: #1e2a4a; color: #a5b4fc; }
  }
`;

function ensurePanel() {
  if (panelHost) return panelHost.shadowRoot;
  panelHost = document.createElement("newsai-panel");
  const root = panelHost.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${PANEL_CSS}</style>
    <div class="panel">
      <div class="head"><b>NewsAI összefoglaló</b>
        <button data-act="toggle" title="Összecsuk / kinyit">–</button>
        <button data-act="close" title="Bezár">✕</button></div>
      <div class="body"></div>
    </div>`;
  root.addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "close") {
      panelHost.remove();
      panelHost = null;
    } else if (act === "toggle") {
      const panel = root.querySelector(".panel");
      panel.classList.toggle("collapsed");
      event.target.textContent = panel.classList.contains("collapsed") ? "+" : "–";
    } else if (act === "options") {
      send({ type: "openOptions" });
    }
  });
  document.documentElement.appendChild(panelHost);
  return root;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderSummary(root, data) {
  const verdict = VERDICTS[data.verdict] || VERDICTS.skim;
  const scores = Object.entries(SCORE_LABELS)
    .map(([key, label]) => {
      const v = data.scores[key];
      return `<span>${label}</span><span><span class="bar"><i style="width:${v * 10}%"></i></span>${v}/10</span>`;
    })
    .join("");
  root.querySelector(".body").innerHTML = `
    <span class="verdict" style="background:${verdict.color}">${verdict.label}</span>
    <div class="reason">${escapeHtml(data.verdict_reason)}</div>
    <div class="scores">${scores}</div>
    <ul>${data.summary.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
    <div class="tags">${data.tags.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>`;
}

async function summarizeArticle(article) {
  const root = ensurePanel();
  const body = root.querySelector(".body");
  body.innerHTML = `<div class="muted">Összefoglaló készül…</div>`;
  const url = canonicalUrl(location.href);
  const response = await send({ type: "summarize", url, title: article.title, text: article.text });
  if (!panelHost || canonicalUrl(location.href) !== url) return;
  if (response?.ok) renderSummary(root, response.data);
  else body.innerHTML = `<div class="error">${escapeHtml(response?.error || "Ismeretlen hiba")}</div>
    <p><a data-act="options">Beállítások megnyitása</a></p>`;
}

// ---------- Headline badges on front pages ----------

const BADGE_CSS = `
  .newsai-badge { display: inline-block !important; min-width: 1.6em; margin-right: .4em; padding: 0 .35em; border-radius: 4px;
    font: 700 12px/1.6 system-ui, sans-serif !important; color: #fff !important; text-align: center; vertical-align: middle;
    text-decoration: none !important; letter-spacing: 0; height: auto !important; flex: none !important;
    align-self: flex-start !important; box-sizing: content-box; }
  .newsai-pending { background: #8c959f; opacity: .5; }
  .newsai-low { background: #8c959f; }
  .newsai-mid { background: #bf8700; }
  .newsai-high { background: #1a7f37; }
`;

// url -> "pending" | "failed" | { score, reason }. Kept outside the page's DOM because
// sites like Telex re-render their headlines and wipe anything inserted into them.
const headlineScores = new Map();
const badgeOf = new WeakMap(); // anchor -> its badge element
let scanTimer = null;

function canonicalUrl(href) {
  try {
    const u = new URL(href, location.href);
    u.hash = "";
    u.search = "";
    return u.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function baseDomain(host) {
  return host.replace(/^www\./, "").split(".").slice(-2).join(".");
}

function candidateLinks() {
  const here = canonicalUrl(location.href);
  const domain = baseDomain(location.hostname);
  const found = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const url = canonicalUrl(a.href);
    if (!url || url === here) continue;
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || baseDomain(u.hostname) !== domain) continue;
    // Article URLs are long and usually carry a slug or an id.
    if (u.pathname.length < 15 || !/[-_]|\d{4,}/.test(u.pathname)) continue;
    const title = linkTitle(a);
    if (!title) continue;
    const rect = a.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    found.push({ a, url, title, strong: looksLikeHeadline(a) });
  }
  // When an article has a headline-looking link (heading or bold), skip its plain links
  // such as the lead paragraph; sites with only plain links keep them all.
  const hasStrong = new Set(found.filter((f) => f.strong).map((f) => f.url));
  return found.filter((f) => f.strong || !hasStrong.has(f.url));
}

// Cards often link the image, the headline and the lead paragraph separately to the
// same article. Headlines sit in a heading or are set in bold, leads are not.
function headlineTextElement(a) {
  return [a, ...a.querySelectorAll("*")].find(
    (el) => !el.classList.contains("newsai-badge") && el.childElementCount === 0 && el.textContent.trim().length >= 25,
  );
}

function looksLikeHeadline(a) {
  if (a.querySelector("h1, h2, h3, h4, h5, h6") || a.closest("h1, h2, h3, h4, h5, h6")) return true;
  const textEl = headlineTextElement(a) || a;
  return parseInt(getComputedStyle(textEl).fontWeight, 10) >= 600;
}

// Where the badge goes: right in front of the headline text, not above a whole card.
function badgeTarget(a) {
  const heading = a.querySelector("h1, h2, h3, h4, h5, h6");
  if (heading) return heading;
  const textEl = headlineTextElement(a);
  return textEl && textEl !== a ? textEl : a;
}

// Card-style links often wrap the headline together with a lead paragraph; prefer the
// heading inside, then the first line of text.
function linkTitle(a) {
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const fits = (t) => t.length >= 25 && t.length <= 220;
  const heading = clean(a.querySelector("h1, h2, h3, h4, h5, [class*='title'], [class*='Title']")?.innerText);
  if (fits(heading)) return heading;
  const text = clean(a.innerText);
  if (fits(text)) return text;
  const firstLine = (a.innerText || "").split("\n").map(clean).find((line) => line.length >= 25);
  if (firstLine && fits(firstLine)) return firstLine;
  const label = clean(a.getAttribute("aria-label") || a.getAttribute("title"));
  return fits(label) ? label : null;
}

function badgeClass(score) {
  return score >= 7 ? "newsai-high" : score >= 4 ? "newsai-mid" : "newsai-low";
}

function renderBadge(badge, state) {
  if (state === "pending") {
    badge.className = "newsai-badge newsai-pending";
    badge.textContent = "…";
    badge.title = "NewsAI: pontozás folyamatban";
  } else {
    badge.className = `newsai-badge ${badgeClass(state.score)}`;
    badge.textContent = state.score;
    badge.title = `NewsAI: ${state.score}/10 – ${state.reason}`;
  }
}

// Make sure every scored (or in-progress) headline shows its badge, putting it back
// wherever the page has removed it.
function placeBadge(a, url) {
  const state = headlineScores.get(url);
  if (!state || state === "failed") return;
  let badge = badgeOf.get(a);
  if (!badge || !badge.isConnected || !a.contains(badge)) {
    badge = document.createElement("span");
    badge.dataset.newsaiUrl = url;
    badgeOf.set(a, badge);
    badgeTarget(a).prepend(badge);
  }
  renderBadge(badge, state);
}

function refreshBadges(urls) {
  for (const badge of document.querySelectorAll(".newsai-badge[data-newsai-url]")) {
    const url = badge.dataset.newsaiUrl;
    if (!urls.has(url)) continue;
    const state = headlineScores.get(url);
    if (state && state !== "failed" && state !== "pending") renderBadge(badge, state);
    else if (state === "failed") badge.remove();
  }
}

async function scanHeadlines(manual = false) {
  const fresh = [];
  const links = candidateLinks();
  for (const { a, url, title } of links) {
    if (!headlineScores.has(url)) {
      headlineScores.set(url, "pending");
      fresh.push({ url, title });
    }
    placeBadge(a, url);
  }
  if (fresh.length === 0) {
    if (links.length === 0 && manual) showStatus("NewsAI: ezen az oldalon nem találtam cikkcímeket.", "info");
    return;
  }
  // Send small batches a few at a time, so badges fill in as answers arrive instead
  // of waiting for the slowest one.
  const batches = [];
  for (let i = 0; i < fresh.length; i += 15) batches.push(fresh.slice(i, i + 15));
  let scored = 0;
  let failed = 0;
  let lastError = null;
  showStatus(`NewsAI: ${fresh.length} cím pontozása…`, "busy");
  const runBatch = async (batch) => {
    const response = await send({ type: "scoreHeadlines", items: batch });
    for (const { url } of batch) {
      const result = response?.ok ? response.data.results[url] : null;
      headlineScores.set(url, result || "failed");
      if (result) scored++;
      else failed++;
    }
    if (!response?.ok) lastError = response?.error;
    else if (response.data.error) lastError = response.data.error;
    refreshBadges(new Set(batch.map((f) => f.url)));
    if (failed + scored < fresh.length) showStatus(`NewsAI: ${scored}/${fresh.length} cím pontozva…`, "busy");
  };
  const queue = [...batches];
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) await runBatch(queue.shift());
  }));
  // Failed headlines get another chance on a scan a minute later, not straight away.
  const failedUrls = fresh.map((f) => f.url).filter((url) => headlineScores.get(url) === "failed");
  if (failedUrls.length) {
    setTimeout(() => failedUrls.forEach((url) => headlineScores.get(url) === "failed" && headlineScores.delete(url)), 60000);
  }
  if (scored === 0) showStatus(`NewsAI hiba: ${lastError || "ismeretlen hiba"}`, "error");
  else if (failed) showStatus(`NewsAI: ${scored} cím pontozva, ${failed} nem sikerült${lastError ? ` (${lastError})` : ""}`, "info");
  else showStatus(`NewsAI: ${scored} cím pontozva.`, "ok");
}

let headlineObserver = null;

function startHeadlineBadges(manual = false) {
  if (!document.getElementById("newsai-badge-css")) {
    const style = document.createElement("style");
    style.id = "newsai-badge-css";
    style.textContent = BADGE_CSS;
    document.head.appendChild(style);
  }
  scanHeadlines(manual);
  if (headlineObserver) return;
  headlineObserver = new MutationObserver(() => {
    if (!contextAlive()) return stopHeadlineBadges();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scanHeadlines(), 300);
  });
  headlineObserver.observe(document.body, { childList: true, subtree: true });
}

function stopHeadlineBadges() {
  headlineObserver?.disconnect();
  headlineObserver = null;
  clearTimeout(scanTimer);
}

// ---------- Status toast ----------

let statusHost = null;
let statusTimer = null;

function showStatus(text, kind) {
  if (!statusHost) {
    statusHost = document.createElement("newsai-status");
    statusHost.attachShadow({ mode: "open" }).innerHTML = `<style>
      :host { all: initial; }
      div { position: fixed; bottom: 16px; right: 16px; z-index: 2147483647; max-width: 360px; padding: 8px 12px; border-radius: 8px;
        font: 13px/1.4 system-ui, sans-serif; color: #fff; background: #24292f; box-shadow: 0 4px 16px rgba(0,0,0,.25); cursor: pointer; }
      div.error { background: #cf222e; }
      div.ok { background: #1a7f37; }
    </style><div title="Kattints a bezáráshoz"></div>`;
    statusHost.shadowRoot.querySelector("div").addEventListener("click", () => {
      statusHost.remove();
      statusHost = null;
    });
    document.documentElement.appendChild(statusHost);
  }
  const box = statusHost.shadowRoot.querySelector("div");
  box.className = kind;
  box.textContent = text;
  clearTimeout(statusTimer);
  // Errors stay until clicked; everything else fades on its own.
  if (kind !== "error" && kind !== "busy") {
    statusTimer = setTimeout(() => {
      statusHost?.remove();
      statusHost = null;
    }, 4000);
  }
}

// ---------- Entry points ----------

function isArticlePath(path) {
  // Front and section pages have short paths; article pages carry a slug or an id.
  return path.length >= 15 && /[-_]|\d{4,}/.test(path);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sites built as single-page apps (such as Telex) render the article after load and
// switch pages without reloading, so look for the text a few times.
async function waitForArticle(url) {
  for (let i = 0; i < 6; i++) {
    if (location.href !== url) return null;
    const article = looksLikeArticle();
    if (article) return article;
    await sleep(1000);
  }
  return null;
}

async function route() {
  const settings = await getSettings();
  if (!matchesSite(location.hostname, settings)) return;
  const url = location.href;
  const article = isArticlePath(location.pathname) ? await waitForArticle(url) : null;
  if (location.href !== url) return;
  if (article) {
    stopHeadlineBadges();
    if (settings.autoSummary) summarizeArticle(article);
  } else if (settings.headlineBadges) {
    startHeadlineBadges();
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "summarizeNow") return;
  const article = extractArticle();
  if (isArticlePath(location.pathname) && article && article.text.length > 200) {
    summarizeArticle(article);
  } else {
    startHeadlineBadges(true);
  }
});

async function safeRoute() {
  try {
    await route();
  } catch (error) {
    if (!contextAlive()) return;
    showStatus(`NewsAI hiba: ${error?.message || error}`, "error");
  }
}

let lastUrl = location.href;
const urlWatcher = setInterval(() => {
  if (!contextAlive()) {
    clearInterval(urlWatcher);
    stopHeadlineBadges();
    return;
  }
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  panelHost?.remove();
  panelHost = null;
  safeRoute();
}, 1000);

safeRoute();
