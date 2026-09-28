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
 * Etapa 5: sincronismo de cookies (cookie sync), bounce tracking e
 *          parâmetros de rastreamento em URLs.
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
 * @property {{transitionType: string|null, qualifiers: string[]}} navigation
 * @property {boolean} userInteracted             clique/tecla no frame principal
 * @property {Array} redirectHops                 saltos de redirect HTTP (30x)
 * @property {Array} bounceChain                  páginas intermediárias (bounce)
 * @property {Map<string, Object>} idTokens       token de ID -> dono (cookie/storage)
 * @property {Map<string, Set<string>>} tokenSites token de ID -> sites que o receberam
 * @property {Map<string, Object>} cookieSync     eventos de sincronismo
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
    canvas: { fingerprints: new Map(), benignReads: 0 },
    navigation: { transitionType: null, qualifiers: [] },
    userInteracted: false,
    redirectHops: [],
    bounceChain: [],
    idTokens: new Map(),
    tokenSites: new Map(),
    cookieSync: new Map()
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
    // Nova navegação de topo: arquiva um resumo da página anterior (usado na
    // detecção de bounce tracking) e zera o relatório da aba.
    if (current) archivePage(details.tabId, current);
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

  detectCookieSync(state, details.url, reqSite);
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
 * @property {string} value         valor (usado só para detectar cookie sync;
 *                                  nunca é enviado ao popup)
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
  const value = (eq >= 0 ? nameValue.slice(eq + 1) : nameValue).trim();

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
    value,
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
    setBy: extra.setBy || null,
    value: c.value || ""
  });
  registerIdTokens(state, c.value, { kind: "cookie", name: c.name, site: siteOf(c.domain) });
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
    value: ck.value || "",
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
  // Uma página intermediária de bounce costuma gravar o cookie e redirecionar
  // em seguida; o evento pode chegar depois que a aba já mudou de página.
  attributeToRecentPages("cookie", cookieSite, c.name, c.value);
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

  // Documento de topo de uma página anterior (navegação em andamento): não é
  // desta página, mas pode ser uma intermediária de bounce recém-arquivada.
  if (sender.frameId === 0 && siteOf(msg.url) !== state.pageSite) {
    for (const kind of ["local", "session"]) {
      for (const item of msg.report[kind] || []) {
        attributeToRecentPages("storage", siteOf(msg.url), item.key, item.preview, tabId, item.writtenNow);
      }
    }
    return;
  }

  for (const kind of ["local", "session"]) {
    for (const item of msg.report[kind] || []) {
      registerIdTokens(state, item.preview, { kind: "storage", name: item.key, site: siteOf(msg.origin) });
    }
  }

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
/* Sincronismo de cookies, bounce tracking e parâmetros de URL         */
/* ------------------------------------------------------------------ */
/*
 * Três técnicas usadas para CONTORNAR o bloqueio/particionamento de cookies
 * de terceira parte (etapas 2 e 3):
 *
 * 1. Bounce tracking: um clique leva a aba, por um instante, a um site
 *    rastreador (que vira PRIMEIRA parte e pode gravar cookie/storage), e ele
 *    redireciona para o destino real. Critério, o mesmo da Bounce Tracking
 *    Protection do Firefox: a página intermediária
 *      (a) é de site diferente da página seguinte,
 *      (b) não recebeu interação do usuário (clique/tecla),
 *      (c) foi redirecionada por HTTP 30x OU ficou aberta <= 10 s antes da
 *          próxima navegação, e
 *      (d) a próxima navegação não foi digitada, favorito, recarga ou
 *          voltar/avançar.
 *    Obs.: o Firefox NÃO informa "client_redirect" quando o redirect é feito
 *    por JavaScript (location.href), por isso o critério (c) usa o tempo de
 *    permanência em vez desse campo.
 *
 * 2. Cookie sync: o ID que um site guardou (cookie ou storage) é enviado na
 *    URL de uma requisição para OUTRO site, que passa a conhecer o mesmo
 *    usuário. Detectado de duas formas:
 *      - valor de cookie/storage conhecido aparece na URL de uma requisição
 *        de 3ª parte para outro site;
 *      - o mesmo token com cara de ID aparece em URLs de >= 2 sites de 3ª
 *        parte diferentes.
 *
 * 3. Parâmetros de rastreamento: identificadores de clique/campanha anexados
 *    à URL da página (fbclid, gclid, utm_*, ...), e IDs repassados na URL
 *    após um bounce.
 */

/** Parâmetros de rastreamento conhecidos, por categoria. */
const TRACKING_PARAMS = {
  click: [
    "fbclid", "gclid", "gclsrc", "dclid", "wbraid", "gbraid", "msclkid", "yclid",
    "twclid", "ttclid", "li_fat_id", "igshid", "igsh", "epik", "rb_clickid",
    "srsltid", "irclickid", "s_kwcid", "ef_id", "mc_cid"
  ],
  email: [
    "mc_eid", "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsctatracking",
    "mkt_tok", "vero_id", "vero_conv", "oly_enc_id", "oly_anon_id",
    "ck_subscriber_id", "ml_subscriber", "ml_subscriber_hash", "ss_email_id", "wickedid"
  ],
  campaign: [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
    "fb_source", "fb_ref", "fb_action_ids", "fb_action_types", "_openstat",
    "soc_src", "soc_trk", "s_cid", "cmpid"
  ]
};
const TRACKING_PARAM_CATEGORY = new Map(
  Object.entries(TRACKING_PARAMS).flatMap(([cat, list]) => list.map((p) => [p, cat]))
);
const TRACKING_CATEGORY_LABEL = {
  click: "ID de clique (identifica o clique/usuário)",
  email: "rastreamento de e-mail",
  campaign: "campanha (atribuição, não identifica o usuário)"
};

/** Nome de parâmetro que sugere identificador de usuário. */
const ID_PARAM_NAME = /(uid|uuid|guid|user_?id|visitor|client_?id|device_?id|partner_?id|sync|^id$|_id$|^cid$|^sid$)/i;

/*
 * IDs de CONFIGURAÇÃO são iguais para todos os visitantes (conta/tag do site,
 * versão do script) e não identificam o usuário: ex. o GA4 envia
 * tid=G-XXXXXXX (conta do site) junto com cid=... (ID do visitante).
 */
const CONFIG_ID_PATTERN = /^(G|UA|GTM|AW|DC|GT|MC|AP)-[A-Z0-9-]{4,}$/i;
const CONFIG_PARAM_NAMES = new Set([
  // conta/tag/versão do site
  "tid", "gtm", "gtag_id", "measurement_id", "property_id", "account_id",
  "container_id", "tag_id", "pixel_id", "v", "ver", "version", "build", "tag_exp", "exp",
  // contexto da página (endereço, referrer, título, idioma, tela): vaza a
  // navegação, mas não identifica o usuário
  "dl", "dr", "dt", "dh", "dp", "ul", "sr", "vp", "sd", "de", "url", "ref", "referrer",
  "page", "location", "href", "host", "hostname", "domain", "origin", "lang", "language", "tz"
]);

/** Valores que não são IDs de usuário mesmo tendo "cara" de ID. */
function isNonIdentifier(v) {
  if (/^\d{2,5}x\d{2,5}$/i.test(v)) return true; // resolução de tela
  if (v.includes("~")) return true;               // listas (ex.: experimentos)
  const parsed = tldts.parse(v);
  return !!(parsed.isIcann && parsed.domain);     // nome de domínio (ex.: g1.globo.com)
}

const BOUNCE_MAX_DWELL_MS = 10000;
const NAV_HISTORY_MAX = 10;
const MAX_TOKENS = 5000;

/** tabId -> resumos das últimas páginas de topo visitadas na aba. */
const navHistory = new Map();

/** Entropia de Shannon (bits por caractere). */
function entropy(str) {
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / str.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Parece um identificador? (e não um timestamp, palavra ou valor comum) */
function isIdLike(v) {
  if (typeof v !== "string" || v.length < 8 || v.length > 200) return false;
  if (!/^[A-Za-z0-9._~-]+$/.test(v)) return false;
  if (!/\d/.test(v)) return false;                    // IDs quase sempre têm dígitos
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    const now = Date.now();
    // timestamps (s ou ms) de +/- 1 ano são datas/cache-busters, não IDs
    const YEAR_S = 365 * 86400;
    if (Math.abs(n - now) < YEAR_S * 1000 || Math.abs(n - now / 1000) < YEAR_S) return false;
  }
  return entropy(v) >= 2.5;
}

/** Tokens com cara de ID contidos num valor (cookie/storage). */
function idTokensOf(value) {
  const out = new Set();
  if (!value) return out;
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch (e) { /* mantém */ }
  for (const piece of decoded.split(/[^A-Za-z0-9._~-]+/)) {
    if (isIdLike(piece)) out.add(piece);
    for (const sub of piece.split(".")) if (isIdLike(sub)) out.add(sub);
  }
  return out;
}

/** Parâmetros da URL (query), incluindo URLs aninhadas em parâmetros (1 nível). */
function urlParams(url, depth = 0) {
  const out = [];
  let u;
  try { u = new URL(url); } catch (e) { return out; }
  for (const [name, value] of u.searchParams) {
    out.push({ name, value });
    if (depth === 0 && /^https?:\/\//i.test(value)) out.push(...urlParams(value, 1));
  }
  return out;
}

function registerIdTokens(state, value, owner) {
  if (!value || state.idTokens.size > MAX_TOKENS) return;
  for (const t of idTokensOf(value)) {
    if (!state.idTokens.has(t)) state.idTokens.set(t, owner);
  }
}

/** Analisa uma requisição de 3ª parte em busca de IDs de outros sites. */
function detectCookieSync(state, url, reqSite) {
  for (const { name, value } of urlParams(url)) {
    if (CONFIG_PARAM_NAMES.has(name.toLowerCase())) continue;
    // Se o valor inteiro já parece um ID, ele é o identificador; os pedaços
    // (ex.: "1063223792" de "1063223792.1790628607") só servem para casar
    // com cookies que guardam o ID num formato diferente.
    const skip = (t) => CONFIG_ID_PATTERN.test(t) || isNonIdentifier(t);
    const whole = isIdLike(value) && !skip(value) ? value : null;
    const pieces = [...idTokensOf(value)].filter((t) => t !== whole && !skip(t));

    // (a) ID que pertence a um cookie/storage de OUTRO site
    let matched = false;
    for (const token of whole ? [whole, ...pieces] : pieces) {
      const owner = state.idTokens.get(token);
      if (owner && owner.site && owner.site !== reqSite) {
        const kind = owner.site === state.pageSite ? "first-to-third" : "third-to-third";
        addSyncEvent(state, `${owner.site}>${reqSite}|${owner.kind}:${owner.name}`, {
          kind, fromSite: owner.site, toSite: reqSite, source: `${owner.kind} ${owner.name}`,
          param: name, token, url
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // (b) mesmo ID enviado a vários sites de 3ª parte
    for (const token of whole ? [whole] : pieces) {
      if (state.tokenSites.size > MAX_TOKENS) break;
      let sites = state.tokenSites.get(token);
      if (!sites) state.tokenSites.set(token, (sites = new Set()));
      sites.add(reqSite);
      if (sites.size >= 2) {
        addSyncEvent(state, `shared|${token}`, {
          kind: "shared-id", fromSite: null, toSite: [...sites].join(", "),
          source: "mesmo ID em URLs de sites diferentes", param: name, token, url
        });
      }
    }
  }
}

function addSyncEvent(state, key, ev) {
  const existing = state.cookieSync.get(key);
  if (existing) {
    existing.count++;
    existing.toSite = ev.toSite; // shared-id: lista de sites cresce
    return;
  }
  state.cookieSync.set(key, { ...ev, count: 1 });
}

/* ---------------- Histórico de navegação e bounce ---------------- */

/** Guarda o resumo de uma página de topo que está sendo deixada. */
function archivePage(tabId, state) {
  const own = [...state.cookies.values()].filter((c) => c.site === state.pageSite);
  const ownStorage = [];
  for (const e of state.storage.values()) {
    if (e.site !== state.pageSite) continue;
    for (const kind of ["local", "session"]) {
      for (const i of e[kind]) ownStorage.push({ key: i.key, value: i.preview, written: i.writtenNow });
    }
  }
  const entry = {
    url: state.pageUrl,
    site: state.pageSite,
    startedAt: state.startedAt,
    endedAt: Date.now(),
    userInteracted: state.userInteracted,
    redirectHops: state.redirectHops,
    bounceChain: state.bounceChain,
    cookiesSet: own.map((c) => ({ name: c.name, value: c.value })),
    storageSet: ownStorage // todos os itens (written = gravado nesta visita)
  };
  const hist = navHistory.get(tabId) || [];
  hist.push(entry);
  if (hist.length > NAV_HISTORY_MAX) hist.shift();
  navHistory.set(tabId, hist);
}

/**
 * Cookie/storage gravado por uma página que acabou de ser deixada (o evento
 * chegou depois da troca de página): anota no resumo arquivado.
 */
function attributeToRecentPages(kind, site, name, value, onlyTabId = null, written = true) {
  const now = Date.now();
  for (const [tabId, hist] of navHistory) {
    if (onlyTabId !== null && tabId !== onlyTabId) continue;
    const last = hist[hist.length - 1];
    if (!last || last.site !== site || now - last.endedAt > BOUNCE_MAX_DWELL_MS) continue;
    const list = kind === "cookie" ? last.cookiesSet : last.storageSet;
    const existing = list.find((x) => (x.name || x.key) === name);
    if (existing) {
      existing.written = existing.written || written;
    } else {
      list.push(kind === "cookie" ? { name, value } : { key: name, value, written });
    }
  }
}

const NON_BOUNCE_TRANSITIONS = new Set(["typed", "auto_bookmark", "reload", "keyword", "generated"]);
const NON_BOUNCE_QUALIFIERS = new Set(["forward_back", "from_address_bar"]);

/** Chamado quando a nova página de topo é confirmada (commit). */
function onTopLevelCommitted(details) {
  if (details.frameId !== 0) return;
  const state = tabs.get(details.tabId);
  if (!state) return;
  const qualifiers = details.transitionQualifiers || [];
  state.navigation = { transitionType: details.transitionType || null, qualifiers };

  const hist = navHistory.get(details.tabId) || [];
  const prev = hist[hist.length - 1];
  if (!prev || !prev.site || prev.site === state.pageSite) return;

  const dwellMs = prev.endedAt - prev.startedAt;
  const userDriven = NON_BOUNCE_TRANSITIONS.has(details.transitionType) ||
    qualifiers.some((q) => NON_BOUNCE_QUALIFIERS.has(q));
  const isBounce = !prev.userInteracted && !userDriven &&
    (qualifiers.includes("client_redirect") || dwellMs <= BOUNCE_MAX_DWELL_MS);
  if (!isBounce) return;

  // A cadeia continua se a própria página anterior veio de um bounce.
  state.bounceChain = [
    ...prev.bounceChain,
    {
      url: prev.url,
      site: prev.site,
      via: "client",
      dwellMs,
      cookiesSet: prev.cookiesSet,
      storageSet: prev.storageSet,
      serverHops: prev.redirectHops
    }
  ];
}

browser.webNavigation.onCommitted.addListener(onTopLevelCommitted);

/** Redirect HTTP (30x) da navegação de topo: registra o salto. */
browser.webRequest.onBeforeRedirect.addListener((details) => {
  if (details.tabId < 0 || details.type !== "main_frame") return;
  const state = tabs.get(details.tabId);
  if (!state || state.mainRequestId !== details.requestId) return;
  state.redirectHops.push({
    url: details.url,
    site: siteOf(details.url),
    via: "server",
    statusCode: details.statusCode,
    redirectUrl: details.redirectUrl
  });
}, { urls: ["<all_urls>"], types: ["main_frame"] });

/** Monta a seção de rastreamento via navegação/URL do relatório. */
function buildTrackingReport(state) {
  // Saltos intermediários: redirects HTTP desta navegação + bounces por JS.
  const hops = [];
  for (const b of state.bounceChain) {
    for (const h of b.serverHops || []) {
      if (h.site !== state.pageSite) hops.push({ ...h, dwellMs: 0, cookiesSet: [], storageSet: [] });
    }
    hops.push(b);
  }
  for (const h of state.redirectHops) {
    if (h.site === state.pageSite) continue;
    const cookiesSet = [...state.cookies.values()]
      .filter((c) => c.site === h.site)
      .map((c) => ({ name: c.name, value: c.value }));
    hops.push({ ...h, dwellMs: 0, cookiesSet, storageSet: [] });
  }

  // Parâmetros da URL da página final
  const params = urlParams(state.pageUrl);
  const trackingParams = params
    .filter((p) => TRACKING_PARAM_CATEGORY.has(p.name.toLowerCase()))
    .map((p) => {
      const category = TRACKING_PARAM_CATEGORY.get(p.name.toLowerCase());
      return { name: p.name, value: p.value.slice(0, 40), category, label: TRACKING_CATEGORY_LABEL[category] };
    });

  // IDs repassados na URL após um bounce: valor igual ao gravado pelo
  // intermediário (evidência forte) ou nome de parâmetro de identificador.
  const passedIds = [];
  if (hops.length > 0) {
    const stored = new Map(); // valor -> origem
    for (const h of hops) {
      const host = hostnameOf(h.url) || h.site;
      for (const c of h.cookiesSet || []) if (c.value) stored.set(c.value, `cookie ${c.name} de ${host}`);
      for (const s of h.storageSet || []) if (s.value) stored.set(s.value, `storage ${s.key} de ${host}`);
    }
    for (const p of params) {
      if (TRACKING_PARAM_CATEGORY.has(p.name.toLowerCase()) || !p.value) continue;
      const match = stored.get(p.value);
      if (match || ID_PARAM_NAME.test(p.name)) {
        passedIds.push({ name: p.name, value: p.value.slice(0, 40), matches: match || null });
      }
    }
  }

  const sync = [...state.cookieSync.values()].map((e) => ({
    kind: e.kind,
    fromSite: e.fromSite,
    toSite: e.toSite,
    source: e.source,
    param: e.param,
    token: e.token.length > 24 ? e.token.slice(0, 24) + "…" : e.token,
    url: e.url.slice(0, 160),
    count: e.count
  }));

  return {
    bounce: {
      detected: hops.length > 0,
      trackers: [...new Set(hops.map((h) => hostnameOf(h.url) || h.site))],
      hops: hops.map((h) => ({
        url: h.url.slice(0, 160),
        site: h.site,
        host: hostnameOf(h.url) || h.site,
        via: h.via,
        statusCode: h.statusCode || null,
        dwellMs: h.dwellMs,
        cookiesSet: (h.cookiesSet || []).map((c) => c.name),
        storageSet: (h.storageSet || []).filter((s) => s.written).map((s) => s.key)
      })),
      passedIds
    },
    trackingParams,
    cookieSync: sync
  };
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida das abas                                              */
/* ------------------------------------------------------------------ */

browser.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  navHistory.delete(tabId);
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
    // o valor do cookie fica só no background (detecção de cookie sync)
    .map(({ value, ...c }) => ({ ...c, party: c.site === state.pageSite ? "first" : "third" }))
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
    },
    navigation: state.navigation,
    tracking: buildTrackingReport(state)
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
  } else if (msg.type === "userInteraction") {
    // clique/tecla no frame principal: a página não é intermediária de bounce
    const tabId = sender.tab && sender.tab.id;
    const state = tabId !== undefined ? tabs.get(tabId) : null;
    if (state && sender.frameId === 0 && siteOf(msg.url) === state.pageSite) state.userInteracted = true;
  }
  return undefined;
});