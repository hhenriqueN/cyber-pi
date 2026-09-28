/*
 * hook.js — SIMULAÇÃO didática do comportamento de um hook de sequestro de
 * navegador (inspirado no BeEF). Não coleta nem envia dados reais: apenas
 * reproduz os INDICADORES técnicos que o Privacy Guard deve detectar.
 *
 * O endereço do "servidor do atacante" (C2) é derivado da própria URL deste
 * script, então o teste funciona em qualquer porta.
 */
(function () {
  const selfSrc = (document.currentScript && document.currentScript.src) || (location.origin + "/testes/hijack/hook.js");
  const C2 = selfSrc.replace(/hook\.js.*$/, "");     // ex.: http://127.0.0.1:8080/testes/hijack/
  const WS = C2.replace(/^http/, "ws");              // ex.: ws://127.0.0.1:8080/testes/hijack/
  const session = Math.random().toString(36).slice(2, 12);
  const log = (msg) => {
    const el = document.getElementById("log");
    if (el) el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  };

  // 1. Sobrescreve APIs nativas (intercepta tráfego, teclado e injeção de código)
  const origFetch = window.fetch;
  window.fetch = function (...args) { log("fetch interceptado: " + args[0]); return origFetch.apply(this, args); };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    log("XHR interceptado: " + url);
    return origOpen.call(this, method, url, ...rest);
  };

  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (/^key/.test(type)) log("listener de teclado registrado");
    return origAdd.call(this, type, fn, opts);
  };

  document.write = function () { log("document.write desviado"); };

  // 2. Esconde as substituições: toString passa a dizer "[native code]"
  const hidden = new Set([window.fetch, XMLHttpRequest.prototype.open, EventTarget.prototype.addEventListener]);
  const origToString = Function.prototype.toString;
  Function.prototype.toString = function () {
    if (hidden.has(this)) return `function ${this.name}() { [native code] }`;
    return origToString.call(this);
  };
  log("APIs sobrescritas: fetch, XMLHttpRequest.open, addEventListener, document.write, Function.toString");

  // 3. Canal persistente por WebSocket (o servidor de teste não aceita a
  //    conexão; o que importa é a TENTATIVA de abrir o canal com terceiro)
  try {
    const ws = new WebSocket(WS + "ws?session=" + session);
    ws.onerror = () => log("WebSocket recusado pelo servidor de teste (esperado)");
  } catch (e) { log("WebSocket: " + e.message); }

  // 4. Polling de comandos a cada 1 s (como o BeEF): "há ordens para mim?"
  let n = 0;
  setInterval(() => {
    n++;
    origFetch(C2 + "comandos.json?session=" + session + "&n=" + n, { cache: "no-store" })
      .then(() => {}, () => {});
    if (n % 5 === 0) log(`polling: ${n} consultas ao servidor do atacante`);
  }, 1000);
})();
