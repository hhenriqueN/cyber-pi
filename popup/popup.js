"use strict";

/*
 * Popup: pede ao background o relatório da aba ativa e o exibe.
 * Todo texto vindo de páginas (domínios, URLs) é inserido com textContent,
 * nunca innerHTML, para que um nome de domínio malicioso não injete HTML no popup.
 */

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function getActiveTabId() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

function renderThirdParties(list) {
  const ul = $("third-list");
  ul.replaceChildren();
  $("empty").hidden = list.length > 0;

  for (const tp of list) {
    const li = el("li");

    const row = el("div", "row");
    row.append(el("span", "site mono", tp.site));
    row.append(el("span", "count", `${tp.count} req`));
    li.append(row);

    li.append(el("div", "detail mono", tp.hosts.join(", ")));
    li.append(el("div", "detail", `tipos: ${tp.types.join(", ")}`));

    ul.append(li);
  }
}

function formatExpiry(ms) {
  if (!ms) return "";
  const days = Math.round((ms - Date.now()) / 86400000);
  const date = new Date(ms).toLocaleDateString("pt-BR");
  return days >= 1 ? `expira em ${date} (~${days} dias)` : `expira em ${date}`;
}

function renderCookies(cookies) {
  const s = cookies.summary;
  const list = cookies.list;
  const count = (party, persistent) =>
    list.filter((c) => c.party === party && c.persistent === persistent).length;

  $("n-cookies").textContent = s.total;
  $("c-first-session").textContent = count("first", false);
  $("c-first-persistent").textContent = count("first", true);
  $("c-first").textContent = s.firstParty;
  $("c-third-session").textContent = count("third", false);
  $("c-third-persistent").textContent = count("third", true);
  $("c-third").textContent = s.thirdParty;
  $("c-session").textContent = s.session;
  $("c-persistent").textContent = s.persistent;
  $("c-total").textContent = s.total;
  $("c-http").textContent = s.bySource.http;
  $("c-js").textContent = s.bySource.js;

  const ul = $("cookie-list");
  ul.replaceChildren();
  $("cookies-empty").hidden = list.length > 0;

  for (const c of list) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", "name mono", c.name || "(sem nome)"));
    const tags = el("span", "tags");
    tags.append(el("span", `tag ${c.party}`, c.party === "first" ? "1ª parte" : "3ª parte"));
    tags.append(el("span", `tag ${c.persistent ? "persistent" : "session"}`,
      c.persistent ? "persistente" : "sessão"));
    row.append(tags);
    li.append(row);

    const origin = c.source === "http" ? "Set-Cookie" : "document.cookie";
    const parts = [`${c.domain}${c.path}`, origin];
    if (c.persistent) parts.push(formatExpiry(c.expires));
    li.append(el("div", "detail mono", parts.join(" · ")));
    ul.append(li);
  }
}

async function render() {
  const tabId = await getActiveTabId();
  const report = tabId === null
    ? null
    : await browser.runtime.sendMessage({ type: "getTabReport", tabId });

  $("no-data").hidden = !!report;
  if (!report) {
    $("page-site").textContent = "—";
    renderThirdParties([]);
    renderCookies({
      summary: { total: 0, firstParty: 0, thirdParty: 0, session: 0, persistent: 0, bySource: { http: 0, js: 0 } },
      list: []
    });
    return;
  }

  $("page-site").textContent = report.pageSite;
  $("page-site").title = report.pageUrl;
  $("n-third-domains").textContent = report.thirdParties.length;
  $("n-third-req").textContent = report.requests.thirdParty;
  $("n-total-req").textContent = report.requests.total;
  renderThirdParties(report.thirdParties);
  renderCookies(report.cookies);
}

$("refresh").addEventListener("click", render);
render();
