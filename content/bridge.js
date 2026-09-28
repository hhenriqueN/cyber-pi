/*
 * Privacy Guard — ponte entre o mundo da página e o background (mundo isolado)
 *
 * content/page-hooks.js (mundo da página) não tem acesso às APIs da extensão;
 * ele dispara CustomEvents no document. Este content script (mundo isolado)
 * escuta esses eventos e os repassa ao background com browser.runtime.
 *
 * Os eventos de armazenamento (storage.*, idb.*) são tratados por
 * content/storage.js; aqui passam os demais (canvas.*).
 */

"use strict";

(() => {
  const EVENT_NAME = "__privacy_guard_event__";
  const FORWARDED = /^canvas\./;

  document.addEventListener(EVENT_NAME, (ev) => {
    let data;
    try {
      data = JSON.parse(ev.detail);
    } catch (e) {
      return;
    }
    if (!data || typeof data.type !== "string" || !FORWARDED.test(data.type)) return;

    browser.runtime.sendMessage({
      type: "pageEvent",
      origin: location.origin,
      url: location.href,
      event: data
    }).catch(() => {}); // background indisponível (extensão recarregada)
  });
})();