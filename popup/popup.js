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

async function render() {
  const tabId = await getActiveTabId();
  const report = tabId === null
    ? null
    : await browser.runtime.sendMessage({ type: "getTabReport", tabId });

  $("no-data").hidden = !!report;
  if (!report) {
    $("page-site").textContent = "—";
    renderThirdParties([]);
    return;
  }

  $("page-site").textContent = report.pageSite;
  $("page-site").title = report.pageUrl;
  $("n-third-domains").textContent = report.thirdParties.length;
  $("n-third-req").textContent = report.requests.thirdParty;
  $("n-total-req").textContent = report.requests.total;
  renderThirdParties(report.thirdParties);
}

$("refresh").addEventListener("click", render);
render();
