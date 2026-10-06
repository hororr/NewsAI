import { Readability, isProbablyReaderable } from "@mozilla/readability";
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
let articleStarted = false;

function send(message) {
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
  if (!isProbablyReaderable(document)) return null;
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
  articleStarted = true;
  const root = ensurePanel();
  const body = root.querySelector(".body");
  body.innerHTML = `<div class="muted">Összefoglaló készül…</div>`;
  const response = await send({ type: "summarize", url: canonicalUrl(location.href), title: article.title, text: article.text });
  if (!panelHost) return;
  if (response?.ok) renderSummary(root, response.data);
  else body.innerHTML = `<div class="error">${escapeHtml(response?.error || "Ismeretlen hiba")}</div>
    <p><a data-act="options">Beállítások megnyitása</a></p>`;
}

// ---------- Headline badges on front pages ----------

const BADGE_CSS = `
  .newsai-badge { display: inline-block !important; min-width: 1.6em; margin-right: .4em; padding: 0 .35em; border-radius: 4px;
    font: 700 12px/1.6 system-ui, sans-serif !important; color: #fff !important; text-align: center; vertical-align: middle;
    text-decoration: none !important; letter-spacing: 0; }
  .newsai-pending { background: #8c959f; opacity: .5; }
  .newsai-low { background: #8c959f; }
  .newsai-mid { background: #bf8700; }
  .newsai-high { background: #1a7f37; }
`;

const seenLinks = new Map(); // url -> [anchor elements]
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
    if (a.dataset.newsai) continue;
    const url = canonicalUrl(a.href);
    if (!url || url === here) continue;
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || baseDomain(u.hostname) !== domain) continue;
    // Article URLs are long and usually carry a slug or an id.
    if (u.pathname.length < 15 || !/[-_]|\d{4,}/.test(u.pathname)) continue;
    const title = (a.innerText || "").replace(/\s+/g, " ").trim();
    if (title.length < 25 || title.length > 220) continue;
    const rect = a.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    found.push({ a, url, title });
  }
  return found;
}

function badgeClass(score) {
  return score >= 7 ? "newsai-high" : score >= 4 ? "newsai-mid" : "newsai-low";
}

async function scanHeadlines() {
  const fresh = [];
  for (const { a, url, title } of candidateLinks()) {
    a.dataset.newsai = "1";
    const badge = document.createElement("span");
    badge.className = "newsai-badge newsai-pending";
    badge.textContent = "…";
    a.prepend(badge);
    if (!seenLinks.has(url)) {
      seenLinks.set(url, []);
      fresh.push({ url, title });
    }
    seenLinks.get(url).push(badge);
  }
  if (fresh.length === 0) return;
  const response = await send({ type: "scoreHeadlines", items: fresh.slice(0, 120) });
  for (const { url } of fresh) {
    const result = response?.ok ? response.data[url] : null;
    for (const badge of seenLinks.get(url) || []) {
      if (result) {
        badge.className = `newsai-badge ${badgeClass(result.score)}`;
        badge.textContent = result.score;
        badge.title = `NewsAI: ${result.score}/10 – ${result.reason}`;
      } else {
        badge.remove();
      }
    }
    if (!result) seenLinks.delete(url);
  }
  if (response && !response.ok) console.warn("NewsAI:", response.error);
}

function startHeadlineBadges() {
  const style = document.createElement("style");
  style.textContent = BADGE_CSS;
  document.head.appendChild(style);
  scanHeadlines();
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanHeadlines, 1500);
  }).observe(document.body, { childList: true, subtree: true });
}

// ---------- Entry points ----------

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "summarizeNow") return;
  const article = extractArticle();
  if (article && article.text.length > 200) summarizeArticle(article);
  else {
    const root = ensurePanel();
    root.querySelector(".body").innerHTML = `<div class="muted">Ezen az oldalon nem találtam cikkszöveget.</div>`;
  }
});

(async function init() {
  const settings = await getSettings();
  if (!matchesSite(location.hostname, settings)) return;
  // Front and section pages have short paths; article pages carry a slug or an id.
  const path = location.pathname;
  const articlePath = path.length >= 15 && /[-_]|\d{4,}/.test(path);
  const article = articlePath ? looksLikeArticle() : null;
  if (article) {
    if (settings.autoSummary && !articleStarted) summarizeArticle(article);
  } else if (settings.headlineBadges) {
    startHeadlineBadges();
  }
})();
