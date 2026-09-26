/*
 * Privacy Guard — background script
 *
 * É o único contexto da extensão que enxerga TODAS as requisições de rede
 * (API webRequest). Mantém um estado por aba com o que foi observado desde
 * o último carregamento de página (main_frame).
 *
 * Etapa 1: detecção de conexões a domínios de terceira parte.
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
 */

function newTabState(pageUrl) {
  return {
    pageUrl,
    pageSite: siteOf(pageUrl),
    startedAt: Date.now(),
    requests: { total: 0, firstParty: 0, thirdParty: 0 },
    thirdParties: new Map()
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

  // Nova navegação de topo: zera o relatório da aba.
  if (details.type === "main_frame") {
    tabs.set(details.tabId, newTabState(details.url));
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

  return {
    pageUrl: state.pageUrl,
    pageSite: state.pageSite,
    startedAt: state.startedAt,
    requests: { ...state.requests },
    thirdParties
  };
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "getTabReport") {
    return Promise.resolve(buildReport(msg.tabId));
  }
  return undefined;
});
