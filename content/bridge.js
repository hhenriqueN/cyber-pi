/*
 * Privacy Guard — ponte entre o mundo da página e o background (mundo isolado)
 *
 * content/page-hooks.js (mundo da página) não tem acesso às APIs da extensão;
 * ele dispara CustomEvents no document. Este content script (mundo isolado)
 * escuta esses eventos e os repassa ao background com browser.runtime.
 *
 * Os eventos de armazenamento (storage.*, idb.*) são tratados por
 * content/storage.js; aqui passam os demais (canvas.*, hook.*).
 *
 * Também avisa o background da primeira interação real do usuário (clique ou
 * tecla) no frame principal: uma página com interação não é tratada como
 * intermediária de bounce tracking.
 */

"use strict";

(() => {
  const EVENT_NAME = "__privacy_guard_event__";
    const FORWARDED = /^(canvas|hook)\./;

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

  if (window === window.top) {
    const onInteraction = (ev) => {
      if (!ev.isTrusted) return; // ignora eventos sintéticos disparados por script
      window.removeEventListener("pointerdown", onInteraction, true);
      window.removeEventListener("keydown", onInteraction, true);
      browser.runtime.sendMessage({ type: "userInteraction", url: location.href }).catch(() => {});
    };
    window.addEventListener("pointerdown", onInteraction, true);
    window.addEventListener("keydown", onInteraction, true);
  }
})();