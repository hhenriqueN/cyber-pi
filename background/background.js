/*
 * Privacy Guard — background script
 *
 * É o único contexto da extensão que enxerga TODAS as requisições de rede
 * (API webRequest). Mantém um estado por aba com o que foi observado desde
 * o último carregamento de página (main_frame).
 *
 * Etapa 1: detecção de conexões a domínios de terceira parte.
 * Etapa 2: cookies injetados no carregamento (1ª/3ª parte, sessão/persistente).
 * Etapa 3: armazenamento HTML5 (localStorage, sessionStorage, IndexedDB),
 *          recebido do content script content/storage.js de cada frame.
 * Etapa 4: canvas fingerprint, recebido de content/page-hooks.js via
 *          content/bridge.js.
 *
 * Regra de primeira x terceira parte:
 *   compara o domínio registrável (eTLD+1, via Public Suffix List / tldts)
 *   da requisição com o eTLD+1 da página no topo da aba.
 *   Ex.: img.globo.com e g1.globo.com  -> mesmo site (globo.com)
 *        a.exemplo.com.br e b.outro.com.br -> sites diferentes (com.br é sufixo público)
 */

"use strict";

/** @type {Map<number, TabState>} estado por aba (tabId -> estado) */
const tabs = new Map();

/* ------------------------------------------------------------------ */
/* Utilitários de domínio                                              */
/* ------------------------------------------------------------------ */

/**
 * Retorna o "site" (eTLD+1) de uma URL ou hostname.
 * Para IPs, localhost e hosts sem sufixo público, retorna o próprio hostname.
 */
function siteOf(urlOrHost) {
  if (!urlOrHost) return null;
  let host = urlOrHost;
  try {
    if (urlOrHost.includes("://")) host = new URL(urlOrHost).hostname;
  } catch (e) {
    return null;
  }
  const domain = tldts.getDomain(host);
  return domain || host || null;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return null;
  }
}

function isWebUrl(url) {
  return typeof url === "string" && /^(https?|wss?):\/\//i.test(url);
}

/* ------------------------------------------------------------------ */
/* Estado por aba                                                      */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} ThirdPartyEntry
 * @property {string} site          eTLD+1 do terceiro
 * @property {Set<string>} hosts    hostnames completos vistos
 * @property {Set<string>} types    tipos de recurso (script, image, xmlhttprequest...)
 * @property {number} count         nº de requisições
 * @property {string} firstUrl      primeira URL observada (evidência)
 */

/**
 * @typedef {Object} TabState
 * @property {string} pageUrl
 * @property {string} pageSite
 * @property {number} startedAt
 * @property {{total:number, firstParty:number, thirdParty:number}} requests
 * @property {Map<string, ThirdPartyEntry>} thirdParties
 * @property {Map<string, CookieEntry>} cookies   chave: nome|domínio|path
 * @property {string|null} mainRequestId          requestId da navegação de topo
 * @property {Map<string, StorageEntry>} storage  chave: origem do frame
 * @property {{fingerprints: Map<string, Object>, benignReads: number}} canvas
 */

function newTabState(pageUrl, mainRequestId = null) {
  return {
    pageUrl,
    pageSite: siteOf(pageUrl),
    startedAt: Date.now(),
    mainRequestId,
    requests: { total: 0, firstParty: 0, thirdParty: 0 },
    thirdParties: new Map(),
    cookies: new Map(),
    storage: new Map(),
    canvas: { fingerprints: new Map(), benignReads: 0 }
  };
}

/**
 * Descobre a URL do documento de topo a partir dos detalhes da requisição.
 * Em Firefox, frameAncestors lista os frames pais; o último é o topo.
 */
function topLevelUrlFrom(details) {
  if (details.frameAncestors && details.frameAncestors.length > 0) {
    return details.frameAncestors[details.frameAncestors.length - 1].url;
  }
  return details.documentUrl || details.originUrl || null;
}

function getOrCreateState(details) {
  let state = tabs.get(details.tabId);
  if (!state) {
    // Aba que já estava aberta quando a extensão foi carregada.
    const top = topLevelUrlFrom(details);
    if (!isWebUrl(top)) return null;
    state = newTabState(top);
    tabs.set(details.tabId, state);
  }
  return state;
}

/* ------------------------------------------------------------------ */
/* Captura de requisições                                              */
/* ------------------------------------------------------------------ */

function onBeforeRequest(details) {
  // tabId -1 = requisições internas do navegador / service workers sem aba.
  if (details.tabId < 0 || !isWebUrl(details.url)) return;

  if (details.type === "main_frame") {
    const current = tabs.get(details.tabId);
    // Redirecionamento da navegação de topo (mesmo requestId): mantém o que já
    // foi observado — cookies gravados no salto intermediário continuam na conta.
    if (current && current.mainRequestId === details.requestId) {
      current.pageUrl = details.url;
      current.pageSite = siteOf(details.url);
      return;
    }
    // Nova navegação de topo: zera o relatório da aba.
    tabs.set(details.tabId, newTabState(details.url, details.requestId));
    updateBadge(details.tabId);
    return;
  }

  const state = getOrCreateState(details);
  if (!state) return;

  const reqSite = siteOf(details.url);
  state.requests.total++;

  if (!reqSite || reqSite === state.pageSite) {
    state.requests.firstParty++;
    return;
  }

  state.requests.thirdParty++;
  let entry = state.thirdParties.get(reqSite);
  if (!entry) {
    entry = {
      site: reqSite,
      hosts: new Set(),
      types: new Set(),
      count: 0,
      firstUrl: details.url
    };
    state.thirdParties.set(reqSite, entry);
    updateBadge(details.tabId);
  }
  entry.count++;
  entry.hosts.add(hostnameOf(details.url));
  entry.types.add(details.type);
}

browser.webRequest.onBeforeRequest.addListener(
  onBeforeRequest,
  { urls: ["<all_urls>"] }
);

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */
/*
 * Um cookie pode ser injetado por dois caminhos:
 *   1. HTTP  — cabeçalho Set-Cookie na resposta de qualquer requisição
 *              (capturado em webRequest.onHeadersReceived, que informa a aba);
 *   2. JS    — document.cookie = "..." executado pela página ou por um iframe
 *              (capturado em cookies.onChanged, que NÃO informa a aba).
 *
 * Classificação:
 *   - 1ª x 3ª parte: eTLD+1 do domínio do cookie comparado ao eTLD+1 da página;
 *   - sessão x persistente: sem Expires/Max-Age => sessão (morre ao fechar o
 *     navegador); com data de expiração => persistente.
 *
 * Um mesmo cookie (nome + domínio + path) é contado uma única vez por
 * carregamento de página; regravações não inflam a contagem.
 */

/**
 * @typedef {Object} CookieEntry
 * @property {string} name
 * @property {string} domain        sem ponto inicial
 * @property {string} path
 * @property {string} site        eTLD+1 do domínio do cookie
 * @property {boolean} persistent
 * @property {number|null} expires  timestamp (ms) ou null se sessão
 * @property {"http"|"js"} source
 * @property {boolean} partitioned  cookie particionado (Total Cookie Protection)
 * @property {string|null} setBy    URL da resposta que enviou o Set-Cookie
 */

function cookieKey(name, domain, path) {
  return `${name}|${domain}|${path}`;
}

/** default-path da RFC 6265 §5.1.4: diretório do path da URL da requisição. */
function defaultCookiePath(url) {
  let p;
  try {
    p = new URL(url).pathname;
  } catch (e) {
    return "/";
  }
  if (!p || p[0] !== "/") return "/";
  const last = p.lastIndexOf("/");
  return last <= 0 ? "/" : p.slice(0, last);
}

/**
 * Interpreta uma linha de Set-Cookie.
 * Retorna null para linhas inválidas e para comandos de REMOÇÃO
 * (Max-Age <= 0 ou Expires no passado), que não injetam cookie.
 */
function parseSetCookie(line, requestUrl) {
  const parts = line.split(";");
  const nameValue = parts.shift();
  const eq = nameValue.indexOf("=");
  const name = (eq >= 0 ? nameValue.slice(0, eq) : "").trim();

  let domain = hostnameOf(requestUrl);
  let path = null;
  let expires = null;
  let maxAge = null;

  for (const attr of parts) {
    const i = attr.indexOf("=");
    const key = (i >= 0 ? attr.slice(0, i) : attr).trim().toLowerCase();
    const val = i >= 0 ? attr.slice(i + 1).trim() : "";
    if (key === "domain" && val) {
      domain = val.replace(/^\./, "").toLowerCase();
    } else if (key === "path" && val.startsWith("/")) {
      path = val;
    } else if (key === "expires") {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expires = t;
    } else if (key === "max-age" && /^-?\d+$/.test(val)) {
      maxAge = parseInt(val, 10);
    }
  }

  if (!domain) return null;

  // Max-Age tem precedência sobre Expires (RFC 6265 §5.3).
  let expiry = null;
  if (maxAge !== null) {
    if (maxAge <= 0) return null;
    expiry = Date.now() + maxAge * 1000;
  } else if (expires !== null) {
    if (expires <= Date.now()) return null;
    expiry = expires;
  }

  return {
    name,
    domain,
    path: path || defaultCookiePath(requestUrl),
    persistent: expiry !== null,
    expires: expiry
  };
}

/** Registra um cookie no estado da aba (deduplicado). */
function recordCookie(tabId, state, c, source, extra = {}) {
  const key = cookieKey(c.name, c.domain, c.path);
  const existing = state.cookies.get(key);
  if (existing) {
    // onChanged pode disparar antes de onHeadersReceived para o mesmo cookie;
    // quando o cabeçalho HTTP aparece, ele é a origem correta.
    if (source === "http" && existing.source !== "http") {
      existing.source = "http";
      existing.setBy = extra.setBy || existing.setBy;
    }
    return;
  }
  state.cookies.set(key, {
    name: c.name,
    domain: c.domain,
    path: c.path,
    site: siteOf(c.domain),
    persistent: c.persistent,
    expires: c.expires,
    source,
    partitioned: !!extra.partitioned,
    setBy: extra.setBy || null
  });
}

/* Caminho 1: Set-Cookie em respostas HTTP ---------------------------- */

function onHeadersReceived(details) {
  if (details.tabId < 0 || !isWebUrl(details.url)) return;
  const state = tabs.get(details.tabId);
  if (!state || !details.responseHeaders) return;

  for (const h of details.responseHeaders) {
    if (h.name.toLowerCase() !== "set-cookie" || !h.value) continue;
    // O Firefox junta vários Set-Cookie num único cabeçalho separado por "\n".
    for (const line of h.value.split("\n")) {
      if (!line.trim()) continue;
      const c = parseSetCookie(line, details.url);
      if (c) {
        const thirdPartyResponse = siteOf(details.url) !== state.pageSite;
        recordCookie(details.tabId, state, c, "http", {
          setBy: details.url,
          partitioned: thirdPartyResponse
        });
      }
    }
  }
}

browser.webRequest.onHeadersReceived.addListener(
  onHeadersReceived,
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

/* Caminho 2: document.cookie (e confirmação dos cookies HTTP) -------- */

/*
 * cookies.onChanged não diz qual aba gravou o cookie. A atribuição é feita
 * pelo site: um cookie pertence às abas cuja página é
 *   - do mesmo site que o cookie (1ª parte), ou
 *   - o site de topo da partição do cookie (partitionKey.topLevelSite), que é
 *     como o Firefox isola cookies de 3ª parte (Total Cookie Protection).
 */
browser.cookies.onChanged.addListener((change) => {
  if (change.removed) return; // remoções/expirações não são injeções
  const ck = change.cookie;
  const domain = ck.domain.replace(/^\./, "").toLowerCase();
  const cookieSite = siteOf(domain);
  const partitionSite = ck.partitionKey && ck.partitionKey.topLevelSite
    ? siteOf(ck.partitionKey.topLevelSite)
    : null;

  const c = {
    name: ck.name,
    domain,
    path: ck.path || "/",
    persistent: !ck.session,
    expires: ck.session || !ck.expirationDate ? null : Math.round(ck.expirationDate * 1000)
  };

  for (const [tabId, state] of tabs) {
    if (state.pageSite === cookieSite || (partitionSite && state.pageSite === partitionSite)) {
      recordCookie(tabId, state, c, "js", { partitioned: !!partitionSite });
    }
  }
});

/* ------------------------------------------------------------------ */
/* Armazenamento HTML5                                                 */
/* ------------------------------------------------------------------ */
/*
 * Cada frame (inclusive iframes de terceira parte) envia o que encontrou na
 * sua origem. Frames da mesma origem compartilham o armazenamento, então o
 * relatório é agrupado por origem (o último envio é o estado mais recente).
 *
 * 1ª x 3ª parte: eTLD+1 da origem do frame comparado ao eTLD+1 da página.
 * No Firefox, o armazenamento de um iframe de 3ª parte é PARTICIONADO pelo
 * site de topo (State Partitioning): o mesmo iframe em outro site enxerga
 * outro localStorage/IndexedDB.
 */

/**
 * @typedef {Object} StorageEntry
 * @property {string} origin
 * @property {string} site
 * @property {boolean} isTopFrame
 * @property {Array} local       itens de localStorage
 * @property {Array} session     itens de sessionStorage
 * @property {Array} idb         bancos IndexedDB
 */

function onStorageReport(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined || tabId < 0) return;
  const state = tabs.get(tabId);
  if (!state || !isWebUrl(msg.url)) return;

  // Documento de topo de uma página anterior (navegação em andamento): descarta.
  if (sender.frameId === 0 && siteOf(msg.url) !== state.pageSite) return;

  const prev = state.storage.get(msg.origin);
  state.storage.set(msg.origin, {
    origin: msg.origin,
    site: siteOf(msg.origin),
    isTopFrame: sender.frameId === 0 || (prev && prev.isTopFrame) || false,
    local: msg.report.local,
    session: msg.report.session,
    idb: msg.report.idb
  });
}

/* ------------------------------------------------------------------ */
/* Eventos do mundo da página (canvas)                                 */
/* ------------------------------------------------------------------ */
/*
 * canvas.fingerprint: leitura de canvas que atende a todos os critérios da
 *   heurística (ver content/page-hooks.js). Agrupada por script + método.
 * canvas.read: leitura de canvas que NÃO atende (uso provavelmente legítimo);
 *   apenas contada, para mostrar que o canvas foi usado sem fingerprint.
 */

function onPageEvent(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined || tabId < 0) return;
  const state = tabs.get(tabId);
  if (!state || !isWebUrl(msg.url)) return;
  if (sender.frameId === 0 && siteOf(msg.url) !== state.pageSite) return;

  const ev = msg.event;
  if (ev.type === "canvas.read") {
    state.canvas.benignReads++;
    return;
  }
  if (ev.type !== "canvas.fingerprint") return;

  const script = typeof ev.script === "string" ? ev.script : msg.url;
  const key = `${script}|${ev.method}`;
  const existing = state.canvas.fingerprints.get(key);
  if (existing) {
    existing.count++;
    return;
  }
  state.canvas.fingerprints.set(key, {
    script,
    scriptSite: siteOf(script),
    frameOrigin: msg.origin,
    method: ev.method,
    width: ev.width,
    height: ev.height,
    distinctChars: ev.distinctChars,
    colors: ev.colors,
    textSample: ev.textSample,
    criteria: ev.criteria,
    count: 1
  });
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida das abas                                              */
/* ------------------------------------------------------------------ */

browser.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
});

/* ------------------------------------------------------------------ */
/* Badge (contador no ícone)                                           */
/* ------------------------------------------------------------------ */

function updateBadge(tabId) {
  const state = tabs.get(tabId);
  const n = state ? state.thirdParties.size : 0;
  browser.browserAction.setBadgeText({ tabId, text: n > 0 ? String(n) : "" })
    .catch(() => {}); // aba pode ter sido fechada
  browser.browserAction.setBadgeBackgroundColor({ tabId, color: n > 10 ? "#d1242f" : "#bf8700" })
    .catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Relatório para o popup                                              */
/* ------------------------------------------------------------------ */

/** Converte o estado (com Map/Set) para um objeto serializável. */
function buildReport(tabId) {
  const state = tabs.get(tabId);
  if (!state) return null;

  const thirdParties = [...state.thirdParties.values()]
    .map((e) => ({
      site: e.site,
      hosts: [...e.hosts].sort(),
      types: [...e.types].sort(),
      count: e.count,
      firstUrl: e.firstUrl
    }))
    .sort((a, b) => b.count - a.count);

  const cookieList = [...state.cookies.values()]
    // 1ª x 3ª parte calculado contra a página FINAL (após redirecionamentos):
    // um cookie gravado por um domínio intermediário de redirect não é da página.
    .map((c) => ({ ...c, party: c.site === state.pageSite ? "first" : "third" }))
    .sort((a, b) =>
      (a.party === b.party ? 0 : a.party === "third" ? -1 : 1) ||
      a.domain.localeCompare(b.domain) ||
      a.name.localeCompare(b.name));

  const cookieSummary = {
    total: cookieList.length,
    firstParty: cookieList.filter((c) => c.party === "first").length,
    thirdParty: cookieList.filter((c) => c.party === "third").length,
    session: cookieList.filter((c) => !c.persistent).length,
    persistent: cookieList.filter((c) => c.persistent).length,
    bySource: {
      http: cookieList.filter((c) => c.source === "http").length,
      js: cookieList.filter((c) => c.source === "js").length
    }
  };

  const storageList = [...state.storage.values()]
    .map((e) => ({ ...e, party: e.site === state.pageSite ? "first" : "third" }))
    .filter((e) => e.local.length || e.session.length || e.idb.length)
    .sort((a, b) =>
      (a.party === b.party ? 0 : a.party === "first" ? -1 : 1) ||
      a.origin.localeCompare(b.origin));

  const sum = (fn) => storageList.reduce((n, e) => n + fn(e), 0);
  const storageSummary = {
    origins: storageList.length,
    thirdPartyOrigins: storageList.filter((e) => e.party === "third").length,
    local: sum((e) => e.local.length),
    localWritten: sum((e) => e.local.filter((i) => i.writtenNow).length),
    session: sum((e) => e.session.length),
    sessionWritten: sum((e) => e.session.filter((i) => i.writtenNow).length),
    idb: sum((e) => e.idb.length),
    idbOpened: sum((e) => e.idb.filter((d) => d.openedNow).length)
  };

  return {
    pageUrl: state.pageUrl,
    pageSite: state.pageSite,
    startedAt: state.startedAt,
    requests: { ...state.requests },
    thirdParties,
    cookies: { summary: cookieSummary, list: cookieList },
    storage: { summary: storageSummary, list: storageList },
    canvas: {
      fingerprints: [...state.canvas.fingerprints.values()]
        .map((f) => ({ ...f, party: f.scriptSite === state.pageSite ? "first" : "third" })),
      benignReads: state.canvas.benignReads
    }
  };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return undefined;
  if (msg.type === "getTabReport") {
    return Promise.resolve(buildReport(msg.tabId));
  }
  if (msg.type === "storageReport") {
    onStorageReport(msg, sender);
  } else if (msg.type === "pageEvent" && msg.event) {
    onPageEvent(msg, sender);
  }
  return undefined;
});