# Checklist de coleta — CONCLUÍDO

Toda a coleta foi realizada. Este arquivo fica como registro do procedimento.

# Checklist de coleta de evidências

Marque conforme for capturando. Todos os prints devem mostrar a **barra de endereços** (URL legível) e o
**popup aberto**. No Mac: **⌘⇧4** e depois **espaço** captura só a janela do Firefox. Lembre: recarregar
a extensão apaga os dados das abas — **recarregou a extensão → recarregue a página**.

## Entregável 2 — DuckDuckGo (pasta `evidencias/ddg/`)

Base: `https://privacy-test-pages.site/`

### Tracker Reporting (seção do menu)
- [ ] `01-tracker-script.png` — 1 major tracker loaded via script
- [ ] `02-surrogate.png` — 1 major tracker with surrogate
- [ ] `03-img.png` — 1 major tracker loaded via img
- [ ] `04-fragment.png` — Image loaded via document fragment
- [ ] `05-fragment-delay.png` — variante [Delay 5s] (espere 6 s, clique no ↻ do popup)
- [ ] `06-fetch.png` — 1 major tracker loaded via fetch
- [ ] `07-fetch-delay.png` — variante [Delay 5s]

### Storage (Privacy Protections)
- [ ] `08-storage-blocking.png` — `/privacy-protections/storage-blocking/` → "Store data", esperar 3 s
- [ ] `09-storage-blocking-iframes.png` — rolar o popup até ver os 4 origins (particionado)
- [ ] `10-storage-partitioning.png` — `/privacy-protections/storage-partitioning/`

### Fingerprinting
- [ ] `11-fingerprinting.png` — `/privacy-protections/fingerprinting/` → "Start the test"
- [ ] `12-canvas-verification.png` — `/privacy-protections/fingerprinting/canvas.html`

### Bounce e Query Parameters
- [ ] `13-bounce-1.png` — `/privacy-protections/bounce-tracking/` → clicar "Go to privacy-test-pages.site"
- [ ] `14-bounce-2.png` — repetir o mesmo clique (2ª visita)
- [ ] `15-bounce-goodtp.png` — clicar "Go to good.third-party.site" (não detecta — divergência esperada)
- [ ] `16-qp-1.png` a `16-qp-4.png` — `/privacy-protections/query-parameters/`, os 4 links

### Tracker Blocking (duas passadas)
- [ ] `17-tracker-blocking-antes.png` — `/privacy-protections/request-blocking/` com lista vazia
- [ ] `18-tracker-blocking-depois.png` — adicionar os trackers à lista, recarregar

### js-leaks e hijacking
- [ ] `19-js-leaks.png` — `/security/js-leaks.html` → "Check"
- [ ] `20-hijack-positivo.png` — `http://localhost:8080/testes/hijack/` (servidor local)
- [ ] `21-hijack-controle.png` — `http://localhost:8080/testes/hijack/controle.html`

## Entregável 3 — 3 sites reais

Para **cada** site (`globo`, `mercadolivre`, `govbr`), na pasta `evidencias/sites/<site>/`:

- [ ] **HAR**: DevTools (**⌘⌥E**) → aba Rede → ligar "Persistir logs" e "Desativar cache" →
      recarregar → botão direito na lista → "Salvar tudo como HAR" → `<site>.har`
- [ ] **Plugin**: print do popup completo (role para capturar todas as seções) → `<site>-plugin.png`
- [ ] **Blacklight**: colar a URL em `themarkup.org/blacklight` → print → `<site>-blacklight.png`
- [ ] **uBlock Origin**: ativar o uBO, abrir o Logger (ícone de lista), recarregar o site, print do
      Logger com os bloqueios → `<site>-ublock.png`

Sites:
- [ ] `globo` — https://g1.globo.com/
- [ ] `mercadolivre` — https://www.mercadolivre.com.br/
- [ ] `govbr` — https://www.gov.br/

## Depois de coletar

Preencha os `_[...]_` do `RELATORIO.md` (números, notas, explicações de divergência apontando para
requisições do HAR). Toda divergência sem referência ao HAR ou à página de teste **não pontua**.
