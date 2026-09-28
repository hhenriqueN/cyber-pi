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
 * Iframes "limpos": cada iframe tem o seu próprio conjunto de protótipos
 * (HTMLCanvasElement.prototype etc.). Um script pode criar um iframe
 * about:blank e usar as funções DELE, que o navegador não chegou a
 * instrumentar — técnica usada por scripts de fingerprint (ex.: BrowserLeaks:
 * `iframe.contentDocument.createElement("canvas")`). Por isso, todos os hooks
 * são instalados por installHooks(win), e os getters contentWindow /
 * contentDocument de iframes, frames e objects são interceptados: antes de
 * devolver a janela do iframe à página, os hooks são instalados nela.
 *
 * Limitações documentadas no README: código em Web Workers e acesso a
 * iframes por índice (window[0], window.frames[0]) não passam pelos hooks;
 * e, por rodar no mundo da página, um script malicioso poderia detectar ou
 * forjar os eventos dos hooks.
 */

(() => {
  "use strict";

  const EVENT_NAME = "__privacy_guard_event__";
  const HOOKED = Symbol.for("privacy-guard.hooked"); // marca por janela (evita hooks duplicados)

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

  /** Substitui o getter proto[name], preservando o descritor original. */
  function hookGetter(proto, name, makeGetter) {
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || typeof desc.get !== "function") return;
      Object.defineProperty(proto, name, { ...desc, get: makeGetter(desc.get) });
    } catch (e) {
      // propriedade ausente
    }
  }

  /* ================= Estado compartilhado do canvas ================= */
  /*
   * Heurística de Englehardt & Narayanan (2016), "Online Tracking: A
   * 1-million-site Measurement and Analysis" (ACM CCS), seção 6.1.
   * Uma leitura de canvas é classificada como fingerprint quando TODOS:
   *   C1. o canvas tem largura E altura >= 16 px;
   *   C2. foi escrito texto com >= 2 cores OU >= 10 caracteres distintos;
   *   C3. o script NÃO chamou save/restore nem addEventListener no canvas
   *       (indícios de uso interativo/legítimo, ex.: editor de desenho);
   *   C4. a imagem foi extraída por toDataURL/toBlob/convertToBlob ou por
   *       getImageData cobrindo área >= 16x16;
   *   C5. a extração NÃO usa formato com perda (image/jpeg, image/webp).
   *
   * Para seguir o desenho quando ele é copiado de um canvas para outro
   * (drawImage, inclusive a partir de OffscreenCanvas/ImageBitmap), as
   * informações de texto da origem são herdadas pelo destino.
   */

  const canvasInfo = new WeakMap(); // canvas | OffscreenCanvas | ImageBitmap -> info
  const MAX_BENIGN_EVENTS = 20;
  let benignEvents = 0;
  const reportedFingerprints = new WeakMap(); // canvas -> Set(metodo)

  function infoOf(target, create = true) {
    let info = canvasInfo.get(target);
    if (!info && create) {
      info = { chars: new Set(), colors: new Set(), textSample: "", interactive: false };
      canvasInfo.set(target, info);
    }
    return info;
  }

  function mergeInfo(dst, src) {
    for (const c of src.chars) dst.chars.add(c);
    for (const c of src.colors) dst.colors.add(c);
    if (!dst.textSample) dst.textSample = src.textSample;
    dst.interactive = dst.interactive || src.interactive;
  }

  /** URL do script que chamou a API (primeiro frame da pilha fora da extensão). */
  function callerScript() {
    const stack = String(new Error().stack || "").split("\n");
    for (const line of stack) {
      if (!line || line.includes("moz-extension://")) continue;
      const m = line.match(/((?:https?|blob):[^\s()]+?):\d+:\d+\)?\s*$/);
      if (m) return m[1];
    }
    return location.href; // script inline da própria página
  }

  function onExtraction(canvas, method, extra) {
    const info = infoOf(canvas, false) || { chars: new Set(), colors: new Set(), textSample: "", interactive: false };
    const width = canvas.width | 0;
    const height = canvas.height | 0;

    const criteria = {
      c1_size: width >= 16 && height >= 16,
      c2_text: info.colors.size >= 2 || info.chars.size >= 10,
      c3_not_interactive: !info.interactive,
      c4_extraction: extra.area === undefined || extra.area >= 256,
      c5_lossless: !/jpe?g|webp/i.test(extra.type || "")
    };
    const isFingerprint = Object.values(criteria).every(Boolean);

    if (isFingerprint) {
      let methods = reportedFingerprints.get(canvas);
      if (!methods) reportedFingerprints.set(canvas, (methods = new Set()));
      if (methods.has(method)) return; // mesma leitura repetida
      methods.add(method);
    } else {
      if (benignEvents >= MAX_BENIGN_EVENTS) return; // evita inundar em jogos/animações
      benignEvents++;
    }

    emit(isFingerprint ? "canvas.fingerprint" : "canvas.read", {
      method,
      width,
      height,
      distinctChars: info.chars.size,
      colors: info.colors.size,
      textSample: info.textSample,
      criteria,
      viaIframe: !!extra.viaIframe,
      script: callerScript()
    });
  }

  /* ================= Instalação dos hooks numa janela ================= */

  function installHooks(win) {
    try {
      if (!win || win[HOOKED]) return; // lança SecurityError se o iframe for de outra origem
      Object.defineProperty(win, HOOKED, { value: true });
    } catch (e) {
      return; // iframe de outra origem: o navegador já injeta o script nele
    }
    const isChild = win !== window;

    /* ---------------- Armazenamento HTML5 ---------------- */

    function storageKind(obj) {
      try {
        if (obj === win.localStorage) return "local";
        if (obj === win.sessionStorage) return "session";
      } catch (e) {
        // acesso ao storage negado (frame sandbox)
      }
      return null;
    }

    if (win.Storage) {
      hookMethod(win.Storage.prototype, "setItem", (original) => ({
        setItem(key, value) {
          const result = original.call(this, key, value); // exceções propagam normalmente
          emit("storage.set", { kind: storageKind(this), key: String(key) });
          return result;
        }
      }).setItem);
    }

    if (win.IDBFactory) {
      hookMethod(win.IDBFactory.prototype, "open", (original) => ({
        open(...args) {
          const request = original.apply(this, args);
          emit("idb.open", { name: String(args[0]) });
          return request;
        }
      }).open);
    }

    /* ---------------- Canvas ---------------- */

    function hookText(proto, name, styleProp) {
      hookMethod(proto, name, (original) => ({
        [name](text, ...rest) {
          const result = original.call(this, text, ...rest);
          try {
            const info = infoOf(this.canvas);
            const str = String(text);
            for (const ch of str) info.chars.add(ch);
            info.colors.add(String(this[styleProp]));
            if (!info.textSample) info.textSample = str.slice(0, 60);
          } catch (e) { /* ignore */ }
          return result;
        }
      })[name]);
    }

    function hookInteractive(proto, name) {
      hookMethod(proto, name, (original) => ({
        [name](...args) {
          try { infoOf(this.canvas).interactive = true; } catch (e) { /* ignore */ }
          return original.apply(this, args);
        }
      })[name]);
    }

    function hookContext(proto) {
      if (!proto) return;
      hookText(proto, "fillText", "fillStyle");
      hookText(proto, "strokeText", "strokeStyle");
      hookInteractive(proto, "save");
      hookInteractive(proto, "restore");

      hookMethod(proto, "getImageData", (original) => ({
        getImageData(sx, sy, sw, sh, ...rest) {
          const result = original.call(this, sx, sy, sw, sh, ...rest);
          try {
            onExtraction(this.canvas, "getImageData", { area: Math.abs(sw * sh), viaIframe: isChild });
          } catch (e) { /* ignore */ }
          return result;
        }
      }).getImageData);

      hookMethod(proto, "drawImage", (original) => ({
        drawImage(source, ...rest) {
          const result = original.call(this, source, ...rest);
          try {
            const src = canvasInfo.get(source);
            if (src) mergeInfo(infoOf(this.canvas), src);
          } catch (e) { /* ignore */ }
          return result;
        }
      }).drawImage);
    }

    if (win.CanvasRenderingContext2D) hookContext(win.CanvasRenderingContext2D.prototype);
    if (win.OffscreenCanvasRenderingContext2D) hookContext(win.OffscreenCanvasRenderingContext2D.prototype);

    if (win.HTMLCanvasElement) {
      const cproto = win.HTMLCanvasElement.prototype;
      hookMethod(cproto, "toDataURL", (original) => ({
        toDataURL(...args) {
          const result = original.apply(this, args); // SecurityError (canvas contaminado) propaga
          try { onExtraction(this, "toDataURL", { type: args[0], viaIframe: isChild }); } catch (e) { /* ignore */ }
          return result;
        }
      }).toDataURL);
      hookMethod(cproto, "toBlob", (original) => ({
        toBlob(...args) {
          const result = original.apply(this, args);
          try { onExtraction(this, "toBlob", { type: args[1], viaIframe: isChild }); } catch (e) { /* ignore */ }
          return result;
        }
      }).toBlob);

      // C3: addEventListener no próprio canvas indica uso interativo.
      // Definido em HTMLCanvasElement.prototype (sombreando EventTarget), para
      // não afetar nenhum outro elemento da página.
      try {
        const baseAdd = win.EventTarget.prototype.addEventListener;
        Object.defineProperty(cproto, "addEventListener", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: ({
            addEventListener(...args) {
              try { infoOf(this).interactive = true; } catch (e) { /* ignore */ }
              return baseAdd.apply(this, args);
            }
          }).addEventListener
        });
      } catch (e) { /* ignore */ }
    }

    if (win.OffscreenCanvas) {
      const oproto = win.OffscreenCanvas.prototype;
      hookMethod(oproto, "convertToBlob", (original) => ({
        convertToBlob(options, ...rest) {
          const result = original.call(this, options, ...rest);
          try {
            onExtraction(this, "convertToBlob", { type: options && options.type, viaIframe: isChild });
          } catch (e) { /* ignore */ }
          return result;
        }
      }).convertToBlob);
      hookMethod(oproto, "transferToImageBitmap", (original) => ({
        transferToImageBitmap(...args) {
          const bitmap = original.apply(this, args);
          try {
            const src = canvasInfo.get(this);
            if (src) mergeInfo(infoOf(bitmap), src);
          } catch (e) { /* ignore */ }
          return bitmap;
        }
      }).transferToImageBitmap);
    }

    /* ---------------- Iframes "limpos" ---------------- */
    // Antes de entregar a janela/documento de um iframe à página, instala os
    // hooks nele (vale também para iframes dentro de iframes).
    const frameCtors = [win.HTMLIFrameElement, win.HTMLFrameElement, win.HTMLObjectElement];
    for (const Ctor of frameCtors) {
      if (!Ctor) continue;
      hookGetter(Ctor.prototype, "contentWindow", (originalGet) => Object.getOwnPropertyDescriptor({
        get contentWindow() {
          const w = originalGet.call(this);
          installHooks(w);
          return w;
        }
      }, "contentWindow").get);
      hookGetter(Ctor.prototype, "contentDocument", (originalGet) => Object.getOwnPropertyDescriptor({
        get contentDocument() {
          const d = originalGet.call(this);
          try { if (d) installHooks(d.defaultView); } catch (e) { /* ignore */ }
          return d;
        }
      }, "contentDocument").get);
    }
  }

  installHooks(window);
})();