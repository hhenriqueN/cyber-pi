/*
 * Privacy Guard — script no MUNDO DA PÁGINA ("world": "MAIN")
 *
 * Content scripts normais rodam num mundo isolado e não enxergam as chamadas
 * que os scripts da página fazem. Este arquivo roda no mesmo contexto
 * JavaScript da página, em document_start (antes de qualquer script dela),
 * e substitui APIs nativas por versões que:
 *   1. chamam a função original com os mesmos argumentos (a página não é
 *      alterada: mesmo retorno, mesmas exceções);
 *   2. avisam o content script isolado por um evento do DOM.
 *
 * A comunicação usa CustomEvent com `detail` em JSON (string), que atravessa
 * a fronteira entre os mundos sem problemas de permissão.
 *
 * Observação: por rodar no mundo da página, um script malicioso poderia
 * detectar ou forjar esses eventos. É uma limitação conhecida de qualquer
 * detector baseado em hooks e está documentada no README.
 */

(() => {
  "use strict";

  const EVENT_NAME = "__privacy_guard_event__";

  function emit(type, data) {
    try {
      document.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: JSON.stringify({ type, ...data })
      }));
    } catch (e) {
      // nunca interferir na página
    }
  }

  /** Substitui proto[name] por wrapper, preservando o descritor original. */
  function hookMethod(proto, name, makeWrapper) {
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || typeof desc.value !== "function") return;
      const original = desc.value;
      const wrapper = makeWrapper(original);
      Object.defineProperty(proto, name, { ...desc, value: wrapper });
    } catch (e) {
      // API ausente neste frame
    }
  }

  /* ---------------- Armazenamento HTML5 ---------------- */

  function storageKind(obj) {
    try {
      if (obj === window.localStorage) return "local";
      if (obj === window.sessionStorage) return "session";
    } catch (e) {
      // acesso ao storage negado (frame sandbox)
    }
    return null;
  }

  if (typeof Storage !== "undefined") {
    hookMethod(Storage.prototype, "setItem", (original) => ({
      setItem(key, value) {
        const result = original.call(this, key, value); // exceções propagam normalmente
        emit("storage.set", { kind: storageKind(this), key: String(key) });
        return result;
      }
    }).setItem);
  }

  if (typeof IDBFactory !== "undefined") {
    hookMethod(IDBFactory.prototype, "open", (original) => ({
      open(...args) {
        const request = original.apply(this, args);
        emit("idb.open", { name: String(args[0]) });
        return request;
      }
    }).open);
  }
})();