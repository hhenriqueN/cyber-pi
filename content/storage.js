/*
 * Privacy Guard — content script de armazenamento HTML5 (mundo isolado)
 *
 * Roda em TODOS os frames (inclusive iframes de terceira parte) em
 * document_start, ou seja, antes de qualquer script da página.
 *
 * Detecta, para a origem do frame:
 *   - localStorage   (persistente, por origem)
 *   - sessionStorage (até fechar a aba, por aba + origem)
 *   - IndexedDB      (banco estruturado persistente, por origem)
 *
 * Duas fontes combinadas:
 *   1. Snapshot: o estado de local/sessionStorage é lido ANTES dos scripts da
 *      página (linha de base) e relido periodicamente; chaves novas ou com
 *      valor alterado foram gravadas neste carregamento. Pega qualquer forma
 *      de escrita, inclusive `localStorage.x = ...`.
 *   2. Eventos de content/page-hooks.js (mundo da página), que intercepta
 *      Storage.prototype.setItem e IDBFactory.prototype.open. Registra
 *      regravações com o mesmo valor e a abertura de bancos IndexedDB.
 *
 * Envio imediato: iframes de rastreamento costumam gravar e ser removidos em
 * seguida (é o que faz a página Storage blocking do DuckDuckGo). Por isso,
 * a cada gravação o relatório é enviado ainda na mesma tarefa (microtask),
 * antes que o frame possa ser destruído.
 */

"use strict";

(() => {
  const EVENT_NAME = "__privacy_guard_event__";
  const POLL_MS = 2000;
  const PREVIEW_CHARS = 60;

  if (location.origin === "null") return; // frame sandbox/opaco: sem armazenamento próprio

  /** Lê um Storage com segurança (pode lançar SecurityError). */
  function readStorage(kind) {
    const out = new Map();
    try {
      const st = kind === "local" ? window.localStorage : window.sessionStorage;
      if (!st) return out;
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        out.set(k, st.getItem(k) ?? "");
      }
    } catch (e) {
      // armazenamento indisponível neste frame
    }
    return out;
  }

  const baseline = { local: readStorage("local"), session: readStorage("session") };
  const written = { local: new Set(), session: new Set() };
  const idbOpened = new Set();
  let idbExisting = [];
  let lastSent = "";

  function describe(kind) {
    const now = readStorage(kind);
    const items = [];
    for (const [key, value] of now) {
      const changed = !baseline[kind].has(key) || baseline[kind].get(key) !== value;
      items.push({
        key,
        size: key.length + value.length,
        preview: value.length > PREVIEW_CHARS ? value.slice(0, PREVIEW_CHARS) + "…" : value,
        writtenNow: changed || written[kind].has(key)
      });
    }
    items.sort((a, b) => (b.writtenNow - a.writtenNow) || a.key.localeCompare(b.key));
    return items;
  }

  /** Monta e envia o relatório de forma SÍNCRONA (sem await antes do envio). */
  function sendNow() {
    const idbNames = [...new Set([...idbExisting, ...idbOpened])].sort();
    const report = {
      local: describe("local"),
      session: describe("session"),
      idb: idbNames.map((name) => ({ name, openedNow: idbOpened.has(name) }))
    };

    const empty = !report.local.length && !report.session.length && !report.idb.length;
    const serialized = JSON.stringify(report);
    if (serialized === lastSent || (empty && lastSent === "")) return;
    lastSent = serialized;

    browser.runtime.sendMessage({
      type: "storageReport",
      origin: location.origin,
      url: location.href,
      report
    }).catch(() => {}); // background indisponível (extensão recarregada)
  }

  /** Atualiza a lista de bancos IndexedDB existentes (assíncrono) e reenvia. */
  async function refreshIdbAndSend() {
    try {
      if (window.indexedDB && window.indexedDB.databases) {
        const dbs = await window.indexedDB.databases();
        idbExisting = Array.from(dbs, (d) => String(d.name));
      }
    } catch (e) {
      // databases() pode falhar em frames sem acesso a armazenamento
    }
    sendNow();
  }

  /* Eventos vindos do mundo da página (content/page-hooks.js) */
  let batched = false;
  document.addEventListener(EVENT_NAME, (ev) => {
    let data;
    try {
      data = JSON.parse(ev.detail);
    } catch (e) {
      return;
    }
    if (data.type === "storage.set" && (data.kind === "local" || data.kind === "session")) {
      written[data.kind].add(data.key);
    } else if (data.type === "idb.open") {
      idbOpened.add(data.name);
    } else {
      return;
    }
    // Agrupa gravações da mesma tarefa, mas envia antes da próxima tarefa.
    if (!batched) {
      batched = true;
      queueMicrotask(() => {
        batched = false;
        sendNow();
      });
    }
  });

  document.addEventListener("DOMContentLoaded", refreshIdbAndSend);
  window.addEventListener("load", refreshIdbAndSend);
  window.addEventListener("pagehide", sendNow);
  setInterval(refreshIdbAndSend, POLL_MS);
})();