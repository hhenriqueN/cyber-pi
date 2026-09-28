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

const EMPTY_STORAGE = {
  summary: { origins: 0, thirdPartyOrigins: 0, local: 0, localWritten: 0, session: 0, sessionWritten: 0, idb: 0, idbOpened: 0 },
  list: []
};

function storageDetails(title, rows) {
  const det = el("details");
  det.append(el("summary", null, title));
  const ul = el("ul", "items");
  for (const r of rows) {
    const li = el("li");
    const k = el("span", "k mono", r.key);
    if (r.written) k.append(" ", el("span", "tag written", "novo"));
    li.append(k, el("span", "v mono", r.value));
    ul.append(li);
  }
  det.append(ul);
  return det;
}

function renderStorage(storage) {
  const s = storage.summary;
  $("n-storage-origins").textContent = s.origins;
  $("n-storage-third").textContent = s.thirdPartyOrigins;
  $("s-local").textContent = s.local;
  $("s-local-w").textContent = s.localWritten;
  $("s-session").textContent = s.session;
  $("s-session-w").textContent = s.sessionWritten;
  $("s-idb").textContent = s.idb;
  $("s-idb-w").textContent = s.idbOpened;

  const ul = $("storage-list");
  ul.replaceChildren();
  $("storage-empty").hidden = storage.list.length > 0;

  for (const e of storage.list) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", "origin mono", e.origin));
    const tags = el("span", "tags");
    tags.append(el("span", `tag ${e.party}`, e.party === "first" ? "1ª parte" : "3ª parte"));
    if (e.party === "third") tags.append(el("span", "tag session", "particionado"));
    row.append(tags);
    li.append(row);

    li.append(el("div", "detail",
      `localStorage: ${e.local.length} · sessionStorage: ${e.session.length} · IndexedDB: ${e.idb.length}` +
      (e.isTopFrame ? " · frame principal" : " · iframe")));

    const toRows = (items) => items.map((i) => ({
      key: i.key, value: `${i.preview} (${i.size} B)`, written: i.writtenNow
    }));
    if (e.local.length) li.append(storageDetails(`localStorage (${e.local.length})`, toRows(e.local)));
    if (e.session.length) li.append(storageDetails(`sessionStorage (${e.session.length})`, toRows(e.session)));
    if (e.idb.length) {
      li.append(storageDetails(`IndexedDB (${e.idb.length})`, e.idb.map((d) => ({
        key: d.name, value: d.openedNow ? "aberto neste carregamento" : "existente", written: d.openedNow
      }))));
    }
    ul.append(li);
  }
}

const EMPTY_CANVAS = { fingerprints: [], benignReads: 0 };

const CRITERIA_LABELS = {
  c1_size: "C1 tamanho ≥16×16",
  c2_text: "C2 texto (≥2 cores ou ≥10 caracteres)",
  c3_not_interactive: "C3 sem save/restore/eventos",
  c4_extraction: "C4 extração da imagem",
  c5_lossless: "C5 formato sem perda"
};

function renderCanvas(canvas) {
  const n = canvas.fingerprints.length;
  const status = $("canvas-status");
  status.textContent = n > 0 ? `DETECTADO (${n})` : "não detectado";
  status.className = n > 0 ? "detected" : "";
  $("canvas-benign").textContent = canvas.benignReads;

  const ul = $("canvas-list");
  ul.replaceChildren();
  for (const f of canvas.fingerprints) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", "script mono", f.script));
    const tags = el("span", "tags");
    tags.append(el("span", `tag ${f.party}`, f.party === "first" ? "1ª parte" : "3ª parte"));
    row.append(tags);
    li.append(row);

    li.append(el("div", "detail",
      `${f.method}() · canvas ${f.width}×${f.height} · ${f.distinctChars} caracteres distintos · ` +
      `${f.colors} cor(es) · ${f.count} leitura(s)`));
    if (f.textSample) li.append(el("div", "detail mono", `texto: "${f.textSample}"`));
    const met = Object.entries(f.criteria || {})
      .map(([k, v]) => `${v ? "✔" : "✘"} ${CRITERIA_LABELS[k] || k}`)
      .join(" · ");
    li.append(el("div", "detail", met));
    ul.append(li);
  }
}

const EMPTY_TRACKING = {
  bounce: { detected: false, trackers: [], hops: [], passedIds: [] },
  trackingParams: [],
  cookieSync: []
};

const SYNC_KIND_LABEL = {
  "first-to-third": "ID de 1ª parte enviado a terceiro",
  "third-to-third": "ID de terceiro enviado a outro terceiro",
  "shared-id": "mesmo ID enviado a vários terceiros"
};

function renderTracking(t) {
  // Bounce tracking
  const b = t.bounce;
  const bStatus = $("bounce-status");
  bStatus.textContent = b.detected ? `DETECTADO (${b.trackers.join(", ")})` : "não detectado";
  bStatus.className = b.detected ? "detected" : "";

  const bl = $("bounce-list");
  bl.replaceChildren();
  for (const h of b.hops) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", "site mono", h.host || h.site));
    const tags = el("span", "tags");
    tags.append(el("span", "tag third",
      h.via === "server" ? `redirect HTTP ${h.statusCode || ""}`.trim() : "redirect por JS"));
    row.append(tags);
    li.append(row);
    const parts = [];
    if (h.via === "client") parts.push(`permaneceu ${h.dwellMs} ms sem interação do usuário`);
    if (h.cookiesSet.length) parts.push(`gravou cookie(s): ${h.cookiesSet.join(", ")}`);
    if (h.storageSet.length) parts.push(`gravou storage: ${h.storageSet.join(", ")}`);
    if (parts.length) li.append(el("div", "detail", parts.join(" · ")));
    li.append(el("div", "detail mono", h.url));
    bl.append(li);
  }

  const pl = $("passed-ids");
  pl.replaceChildren();
  for (const p of b.passedIds) {
    const li = el("li");
    li.append(el("div", "name mono", `ID repassado na URL: ${p.name}=${p.value}`));
    li.append(el("div", "detail", p.matches
      ? `mesmo valor do ${p.matches}`
      : "nome de parâmetro de identificador, após bounce"));
    pl.append(li);
  }

  // Parâmetros de rastreamento
  $("n-params").textContent = t.trackingParams.length;
  const ql = $("param-list");
  ql.replaceChildren();
  for (const p of t.trackingParams) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", "name mono", `${p.name}=${p.value}`));
    const tags = el("span", "tags");
    tags.append(el("span", `tag ${p.category}`, p.category === "click" ? "clique" : p.category === "email" ? "e-mail" : "campanha"));
    row.append(tags);
    li.append(row);
    li.append(el("div", "detail", p.label));
    ql.append(li);
  }

  // Cookie sync
  const sStatus = $("sync-status");
  sStatus.textContent = t.cookieSync.length ? `DETECTADO (${t.cookieSync.length})` : "não detectado";
  sStatus.className = t.cookieSync.length ? "detected" : "";
  const sl = $("sync-list");
  sl.replaceChildren();
  for (const e of t.cookieSync) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", "site mono", e.fromSite ? `${e.fromSite} → ${e.toSite}` : e.toSite));
    const tags = el("span", "tags");
    tags.append(el("span", "tag third", `${e.count}×`));
    row.append(tags);
    li.append(row);
    const origin = e.kind === "shared-id" ? "" : ` · origem: ${e.source}`;
    li.append(el("div", "detail", `${SYNC_KIND_LABEL[e.kind] || e.kind}${origin} · parâmetro "${e.param}" = ${e.token}`));
    li.append(el("div", "detail mono", e.url));
    sl.append(li);
  }
}

const EMPTY_HIJACK = { globals: [], websockets: [], polling: [] };

function renderHijack(h) {
  const total = h.globals.length + h.websockets.length + h.polling.length;
  const status = $("hijack-status");
  status.textContent = total ? `${total} indicador(es)` : "nenhum indicador";
  status.className = total ? "detected" : "";

  $("n-globals").textContent = h.globals.length;
  const gl = $("globals-list");
  gl.replaceChildren();
  for (const g of h.globals) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", "api mono", g.api));
    const tags = el("span", "tags");
    tags.append(el("span", `tag ${g.party}`, g.party === "first" ? "1ª parte" : "3ª parte"));
    row.append(tags);
    li.append(row);
    li.append(el("div", "detail",
      `${g.change} ${Math.round(g.afterMs / 100) / 10} s após o início · ` +
      (g.replacementIsNative ? "substituta parece nativa (possível ocultação)" : "substituta é código JavaScript") +
      (g.topFrame ? "" : ` · no iframe ${g.frameOrigin}`)));
    li.append(el("pre", "mono", g.source));
    gl.append(li);
  }

  $("n-ws").textContent = h.websockets.length;
  const wl = $("ws-list");
  wl.replaceChildren();
  for (const w of h.websockets) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", "site mono", w.site));
    const tags = el("span", "tags");
    tags.append(el("span", "tag third", `${w.count} conexão(ões)`));
    row.append(tags);
    li.append(row);
    li.append(el("div", "detail mono", w.url));
    wl.append(li);
  }

  $("n-poll").textContent = h.polling.length;
  const pl = $("poll-list");
  pl.replaceChildren();
  for (const p of h.polling) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", "site mono", p.site));
    const tags = el("span", "tags");
    tags.append(el("span", "tag third", `a cada ~${(p.meanIntervalMs / 1000).toFixed(1)} s`));
    row.append(tags);
    li.append(row);
    li.append(el("div", "detail",
      `${p.requests} requisições · regularidade ${p.regularity}% · tipos: ${p.types.join(", ")}`));
    li.append(el("div", "detail mono", p.endpoint));
    pl.append(li);
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
    renderStorage(EMPTY_STORAGE);
    renderCanvas(EMPTY_CANVAS);
    renderTracking(EMPTY_TRACKING);
    renderHijack(EMPTY_HIJACK);
    return;
  }

  $("page-site").textContent = report.pageSite;
  $("page-site").title = report.pageUrl;
  $("n-third-domains").textContent = report.thirdParties.length;
  $("n-third-req").textContent = report.requests.thirdParty;
  $("n-total-req").textContent = report.requests.total;
  renderThirdParties(report.thirdParties);
  renderCookies(report.cookies);
  renderStorage(report.storage || EMPTY_STORAGE);
  renderCanvas(report.canvas || EMPTY_CANVAS);
  renderTracking(report.tracking || EMPTY_TRACKING);
  renderHijack(report.hijack || EMPTY_HIJACK);
}

$("refresh").addEventListener("click", render);
render();