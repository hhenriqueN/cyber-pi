# Relatório — Privacy Guard

**Avaliação Intermediária de Cibersegurança — Insper**
Extensão para Firefox para detecção e bloqueio de rastreamento no cliente web.

- **Aluno:** _[seu nome]_
- **Repositório:** _[link do GitHub]_
- **Data:** _[data de entrega]_

> Cobre os entregáveis 2 (DuckDuckGo Privacy Test Pages), 3 (análise de 3 sites reais) e 4 (pontuação
> de privacidade). Os arquivos HAR e os prints do plugin em execução estão em [`evidencias/`](../evidencias/).

---

## 1. Visão geral da ferramenta

O Privacy Guard é uma WebExtension (Manifest V2) para Firefox que, a cada carregamento de página,
observa sete classes de comportamento ligadas a rastreamento e à segurança do cliente, apresenta um
relatório por aba, atribui uma pontuação de privacidade e permite bloqueio personalizado.

### 1.1 Arquitetura

| Componente | Arquivo | Papel |
|---|---|---|
| **Background** | `background/background.js` | Único contexto que enxerga todas as requisições de rede (`webRequest`) e todos os cookies (`cookies`). Mantém o estado por aba, calcula a nota e aplica o bloqueio. |
| **Script no mundo da página** | `content/page-hooks.js` | Roda no contexto JS da página (`"world":"MAIN"`), em `document_start`. Intercepta APIs nativas de canvas, storage e as APIs críticas de hijacking. |
| **Content scripts (mundo isolado)** | `content/storage.js`, `content/bridge.js` | Leem o armazenamento HTML5 e repassam ao background os eventos do mundo da página. |
| **Popup** | `popup/` | Interface do relatório por página, com a nota e a lista de bloqueio. |

A biblioteca **tldts** (com a Public Suffix List) calcula o domínio registrável (eTLD+1), base de toda
a distinção entre primeira e terceira parte.

### 1.2 Ambiente de teste

Medições em Firefox _[preencher versão]_, com a Proteção Aprimorada contra Rastreamento em modo
**Personalizado**, com **rastreadores, criptomineradores e fingerprinters desligados**, para que o
navegador não bloqueasse as requisições antes de a extensão observá-las. O isolamento de cookies entre
sites (Total Cookie Protection) foi **mantido**, de propósito, por ser o comportamento real do Firefox —
e seus efeitos aparecem nas divergências. O uBlock Origin ficou **desativado** durante a medição do
plugin e do HAR, e foi ativado apenas na etapa de comparação. Janela normal (não privativa).

### 1.3 Correção ao enunciado

O enunciado afirma que a extensão "utiliza o mesmo PID do browser, tendo acesso irrestrito ao sistema".
Isso descreve os **plug-ins antigos** (NPAPI/ActiveX). As WebExtensions modernas, como esta, rodam em
processo separado, com sandbox e **permissões declaradas** no `manifest.json` — sem acesso ao sistema
além do que a rede e o DOM oferecem.

---

## 2. Metodologia de detecção (resumo)

Descrição técnica completa no [`README.md`](../README.md).

| Categoria | Como é detectada | Base |
|---|---|---|
| Conexões de 3ª parte | eTLD+1 da requisição ≠ eTLD+1 da página | Public Suffix List |
| Cookies (1ª/3ª, sessão/persistente) | `Set-Cookie` (HTTP) + `cookies.onChanged` (JS) | RFC 6265 |
| Storage HTML5 | snapshot + hooks de `setItem`/`indexedDB.open` em todos os frames | — |
| Canvas fingerprint | hooks de `toDataURL`/`getImageData` + heurística de 5 critérios | Englehardt & Narayanan (2016) |
| Cookie sync / bounce | ID conhecido reaparece em URL de outro site; redirect sem interação | Bounce Tracking Protection (Firefox) |
| Hijacking / hook | APIs nativas sobrescritas; WebSocket/polling para 3ª parte | modelo do BeEF |
| Pontuação | 100 − descontos por categoria, com pesos e limites | seção 5 |

---

## 3. Entregável 2 — DuckDuckGo Privacy Test Pages

Cada teste traz: o resultado **esperado** (o que a própria página reporta, medindo o comportamento do
*navegador*) × o **resultado do plugin** (o que a nossa ferramenta, como *detector*, observou) × a
**explicação da divergência**. Prints em [`evidencias/ddg/`](../evidencias/ddg/).

> **[Nota D] — observação metodológica válida para toda a tabela.** As páginas do DuckDuckGo medem o que
> o *navegador* faz (por exemplo, se ele *bloqueou* um rastreador). O Privacy Guard é um *detector*: por
> padrão **observa e classifica**, não bloqueia (o bloqueio é opcional). Assim, quando a página "espera"
> uma proteção do navegador e o plugin "relata" a presença do rastreamento, **não há erro** — são papéis
> diferentes. Isso é dito uma vez aqui e referenciado como **[Nota D]**.

### 3.1 Tracker Reporting

| Teste | Esperado | Plugin | Divergência | Print |
|---|---|---|---|---|
| 1 major via script | 1 tracker (doubleclick.net) via script | `doubleclick.net`, tipo `script`, nota A(98) | Nenhuma | `01-tracker-script.png` |
| 1 major via img | 1 tracker (facebook.com) via img | `facebook.com`, tipo `image` | Nenhuma | `03-img.png` |
| 1 major via fetch | 1 tracker (facebook.com) via fetch | `facebook.com`, tipo `xmlhttprequest`, + cookie `fr` (3ª parte, persistente) | Nenhuma | `06-fetch.png` |

As variantes **surrogate**, **document fragment** e **[Delay 5s]** produziram a **mesma detecção** dos
testes acima (mesmo domínio e tipo), por isso um print representa cada tipo de recurso (prints extras em
`evidencias/ddg/extras/`). O plugin identifica o domínio exato e o tipo de recurso, confirmado no
código-fonte das páginas de teste.

### 3.2 Storage Blocking e Storage Partitioning

| Teste | Esperado | Plugin | Divergência | Print |
|---|---|---|---|---|
| Storage blocking | dados gravados (proteção off) | 4 origens: `privacy-test-pages.site` (1ª) + `broken`/`good`/`ad` third-party (3ª, **particionado**), com `localStorage`/`sessionStorage`/`IndexedDB` marcados "novo" | O plugin evidencia o **particionamento** do Firefox, que a página não mostra. [Nota D] | `09-storage-blocking.png` |
| Storage partitioning | iframe de 3ª parte NÃO lê o mesmo valor entre sites (todos "pass") | 1 origem (`first-party.site`); o iframe de 3ª parte não aparece com dado | Coerente: por estar particionado, o iframe **não encontrou** valor cross-site para ler — a ausência do dado **é** o particionamento. | `10-storage-partitioning.png` |

No IndexedDB do iframe `ad-company.site`, o plugin marca **0** corretamente (o script `DB` da página não
carregou nesse iframe). `WebSQL - openDatabase is not defined` não é falha do plugin: o Firefox nunca
implementou WebSQL.

**Divergência documentada e resolvida durante o desenvolvimento.** A 1ª versão do detector de storage,
via `wrappedJSObject`+`exportFunction`, **quebrava o IndexedDB dos iframes** ("Permission denied to
access property length"). A correção — mover os hooks para um script com `"world":"MAIN"` — fez a página
passar de "2 failed" para "1 failed". É um exemplo concreto de detector que interferia na página, e da
correção. (Ver seção 6.)

### 3.3 Fingerprinting

| Teste | Esperado | Plugin | Divergência | Print |
|---|---|---|---|---|
| Fingerprinting test page | coleta N datapoints | **Canvas fingerprint DETECTADO**: `helpers/tests.js` via `toDataURL` (3×) e `getImageData` (1×), texto "Cwm fjordbank glyphs vext quiz", canvas 2000×200, **5 critérios ✔** | Nenhuma | `11-fingerprinting.png` |
| Canvas verification | verifica renderização | **DETECTADO (1)** no bloco "fp example performance" + **20 leituras** classificadas como uso comum | O plugin distingue o fingerprint dos 20 testes de ruído aleatório da mesma página. | `12-canvas-verification.png` |

Os "fail" em vermelho na `canvas.html` **não são do plugin**: indicam que o Firefox não está
randomizando o canvas, porque desligamos a proteção de fingerprinting no ambiente de teste (§1.2).

### 3.4 Bounce Tracking

| Teste | Esperado | Plugin | Divergência | Print |
|---|---|---|---|---|
| Go to first-party / privacy-test / publisher | ID gerado no `bad.third-party.site` repassado ao destino | **DETECTADO** (`bad.third-party.site`), redirect por JS, ~170 ms sem interação, `bounceUIDlocalStorage`/`bounceUIDcookie=13` casados com o storage do rastreador | Nenhuma | `13-bounce-privacy-test.png` |
| **Go to good.third-party.site** | ID repassado | **NÃO detectado** | **Divergência esperada:** `bad.third-party.site` e `good.third-party.site` têm o **mesmo eTLD+1** (`third-party.site`, pois `.site` é sufixo público). Para o navegador — e para a Bounce Tracking Protection do Firefox — não houve troca de site, logo não é bounce. | `16-bounce-good-thirdparty-NAO-detectado.png` |

Os três destinos detectados mostram o **mesmo ID `13`** do `bad.third-party.site` sendo repassado a
sites diferentes (prints dos outros dois destinos em `extras/`).

### 3.5 Query Parameters

| Link | Esperado (rewrite) | Plugin | Print |
|---|---|---|---|
| `utm_source=…&q=…` | `q=other` | detecta `utm_source` (**campanha**); ignora `q` | `17-qp-utm-source-q.png` |
| `fbclid=…&fb_source=…&u=…` | `u=14` | `fbclid` (**clique**, identifica o usuário) e `fb_source` (campanha); ignora `u` | `19-qp-fbclid.png` |
| `q=…&id=…` (controle) | sem rewrite | **0 parâmetros de rastreamento** | `20-qp-controle-q-id.png` |

O plugin **detecta** o parâmetro; a página **remove** — papéis diferentes [Nota D]. A distinção entre
`fbclid` (ID de clique) e `utm_*` (campanha) fica visível no print.

### 3.6 Tracker Blocking (bloqueio personalizado)

Esta página **espera bloqueio**. O plugin bloqueia via lista personalizada, então é feito em 2 passadas.

| Passada | Configuração | Plugin | Print |
|---|---|---|---|
| Antes | lista vazia | todos os recursos carregam (verde); detecta `third-party.site` como 3ª parte | `24-tracker-blocking-antes.png` |
| Depois | `bad.third-party.site` na lista | **22 requisições canceladas** (vermelho); "Bloqueado nesta aba"; a nota melhora | `25-tracker-blocking-depois.png` |

Duas observações honestas: (a) o contador agrupa por eTLD+1 ("third-party.site (22)"), embora o usuário
tenha bloqueado o subdomínio; (b) o `serviceworker-fetch` permaneceu verde — Service Workers servem de um
cache próprio e escapam do `webRequest`, limitação conhecida do bloqueio por essa API.

### 3.7 js-leaks e Hijacking

| Teste | Esperado | Plugin | Print |
|---|---|---|---|
| js-leaks (comparar `window` com Firefox 92) | lista propriedades adicionadas/alteradas | a página revela em **Properties Changed**: `indexedDB.open`, `localStorage.setItem`, `sessionStorage.setItem` **changed value** — ou seja, os **hooks do próprio plugin** | `21-js-leaks.png` |
| Teste controlado local (positivo) | — | **7 indicadores**: 5 APIs sobrescritas (`fetch`, `XMLHttpRequest.open`, `addEventListener`, `document.write`, `Function.toString` com ocultação `[native code]`), 1 WebSocket 3ª parte, 1 polling ~1 s | `22-hijack-positivo.png` |
| Teste controlado local (controle negativo) | — | **nenhum indicador** (uso legítimo de canvas/storage/fetch/eventos) | `23-hijack-controle.png` |

O js-leaks prova, com evidência independente, que qualquer detector baseado em **hooks é observável** —
limitação inerente e assumida (§6). O par positivo/controle prova que a heurística distingue **sequestro**
de **uso comum**. O cenário controlado está em [`testes/hijack/`](../testes/hijack/).

---

## 4. Entregável 3 — Análise de 3 sites reais

Três sites de intensidade de rastreamento contrastante: **globo.com** (notícias, intenso),
**mercadolivre.com.br** (e-commerce, ads/retargeting) e **gov.br** (governo, controle "limpo").
Para cada um: arquivo HAR, detecção do plugin, Blacklight e uBlock Origin, com reconciliação.
Arquivos em `evidencias/sites/<site>/`.

**Panorama comparativo (uma visão):**

| Métrica | globo.com | mercadolivre.com.br | gov.br |
|---|---|---|---|
| **Nota do plugin** | **E (6/100)** | **D (27/100)** | **B (64/100)** |
| Domínios de 3ª parte (plugin) | 59 | 7 | 9 |
| Domínios de 3ª parte (HAR, 1 carga) | 34 | _(HAR parcial)_ | 8 |
| **Ad trackers (Blacklight)** | **27** | **11** | **1** |
| Cookies de 3ª parte (plugin) | 37 (35 persist.) | 3 (3 persist.) | 1 (1 persist.) |
| Cookies de 3ª parte (Blacklight) | 14 | 16 | **0** |
| Canvas fingerprint | não | não | não |
| Cookie sync / bounce | sync (Google, g.globo, LiveIntent) | bounce + sync (Google) | não |
| Hijacking/hook | 13 | 5 | 1 |
| Bloqueios do uBO | 53 (13%) | 24 (6%) | 5 (5%) |

O contraste esperado se confirma nas três ferramentas: globo ≫ mercadolivre ≫ gov.br. A seguir, cada
site em detalhe, com as divergências apontando para requisições do HAR.

### 4.1 globo.com — rastreamento intenso

Prints: `globo-plugin-1..4`, `globo-blacklight.png`, `globo-ublock.png`. HAR: `globo.har`.

**Detecção do plugin:** nota **E (6/100)**. Terceiros dominantes (do HAR, 1 carga): `glbimg.com` (96 req,
CDN da Globo), `g.globo` (28, APIs da Globo), depois a cadeia de publicidade — `google`,
`googlesyndication`, `doubleverify`, `doubleclick`, `rubiconproject`, `criteo`, `adnxs`, `pubmatic`,
`smartadserver`, `scorecardresearch`, `permutive`, `liadm` (LiveIntent) e `clarity.ms` (session recording
da Microsoft). Cookies: 58 injetados, **37 de 3ª parte, 35 persistentes** (via HAR: `uuid2@adnxs.com`,
`vs@smartadserver.com`, `UID@scorecardresearch.com`, `4560_*@newsroom.bi`).

**Cookie sync (plugin):** `cid` (Google Analytics) enviado a domínios do Google; `glb_uid` e `hsid`
(cookies de 1ª parte da Globo) enviados a `g.globo` (outro eTLD+1); `_lc2_fpi` (localStorage) enviado a
`liadm.com`. **O caso do LiveIntent é o mais relevante:** um rastreador de 3ª parte grava o ID no
**storage de 1ª parte** (onde o bloqueio de cookies de 3ª parte não alcança) e depois o lê e envia ao
próprio domínio — o contorno do Total Cookie Protection acontecendo em um site real.

**Hijacking (13 indicadores):** não é ataque — são scripts legítimos sobrescrevendo APIs globais:
`window.open` (iframe de `s0.2mdn.net`, do DoubleClick, com `appendExitClickParams` para rastrear o
clique no anúncio) e `window.fetch`/`setTimeout`/`setInterval`/`XMLHttpRequest.open` (scripts do próprio
g1, para monitoramento de erros e performance — `browserapierrors`). O detector está correto: as APIs
foram mesmo sobrescritas; a intenção aqui é comercial/operacional, não maliciosa. **Isso é a limitação
honesta da heurística: ela detecta a sobrescrita, não a intenção** (§6).

**Comparação com o Blacklight** (27 ad trackers, 14 cookies de 3ª parte):

| Item | Blacklight | Plugin | Concordam? | Explicação |
|---|---|---|---|---|
| Nº de trackers/terceiros | 27 (ad trackers) | 59 (plugin) / 34 (HAR) | Direção sim, número não | Três números diferentes, todos corretos para sua captura — ver **[Divergência A]** abaixo. |
| Canvas fingerprinting | não aponta | não detectado | Sim | — |
| Session recording | aponta (ex.: Clarity) | aparece como 3ª parte (`clarity.ms`) | Parcial | O plugin não tem a categoria "session recording"; o domínio aparece como terceiro. |
| Google/Facebook presentes | sim | sim (`google.com`, `doubleclick`, `facebook.net`) | Sim | — |

**[Divergência A] — por que 27 × 34 × 59.** (1) O Blacklight agrupa domínios por **entidade** (todos os
`google.com`/`doubleclick.net`/`googletagmanager.com` = "Google"; `glbimg.com`/`g.globo` = "Globo"),
enquanto o plugin conta por **eTLD+1**, elevando o número. (2) O g1 usa **RTB (leilão de anúncios em
tempo real)**: cada carregamento puxa parceiros diferentes, então o HAR (34, uma carga) < plugin (59,
acumulado em recargas). (3) O Blacklight roda **Chrome headless nos EUA**, sem interagir com o banner
LGPD; o plugin roda no **Firefox com particionamento**, e observou os IDs sendo enviados **antes** de o
banner de consentimento ser aceito.

**Reconciliação com o uBlock Origin** (53 bloqueios, 8 de 25 domínios): o uBO bloqueou os rastreadores
de publicidade conhecidos (`doubleclick`, `adnami.io`, `ads-twitter`, `clarity.ms`, `criteo`,
`facebook.net`, `google-analytics`, `googlesyndication`) via EasyList/EasyPrivacy. Os domínios que o uBO
**não** bloqueia e o plugin lista (`glbimg.com`, `g.globo`) são **CDN e API da própria Globo** — não são
rastreadores, e o uBO os deixa passar por serem essenciais ao site. O plugin, por usar eTLD+1 puro, os
conta como 3ª parte. **É a mesma diferença "entidade × eTLD+1" da [Divergência A].**

### 4.2 mercadolivre.com.br — e-commerce e retargeting

Prints: `mercadolivre-plugin-1..4`, `mercadolivre-blacklight.png`, `mercadolivre-ublock.png`.
HAR: `mercadolivre.har` — **atenção: captura parcial** (a aba Rede foi aberta após parte do carregamento;
14 requisições no arquivo contra 233 que o plugin observou via `webRequest`). Os **prints do popup são
completos** e são a fonte primária desta seção; o HAR confirma os domínios que capturou.

**Detecção do plugin:** nota **D (27/100)**. 7 domínios de 3ª parte, **230 requisições de 3ª parte**
(a maioria para `mlstatic.com`, o CDN do próprio ML). Terceiros: `mlstatic.com`, `mercadolibre.com`,
`mercadoclics.com` (rede de anúncios do próprio ML), `meli.com`, `google.com`, `hotjar.com`. Cookies: 8
injetados, **3 de 3ª parte persistentes** — `NID@google.com`, `_d2id@mercadoclics.com`, `_d2id@meli.com`;
entre os de 1ª parte, `_hjSession`/`_hjSessionUser` do **Hotjar** (session recording/heatmap).

**Bounce tracking DETECTADO** (`mercadolivre.com`, redirect HTTP 301 → `mercadolivre.com`): durante a
navegação houve um salto pelo domínio **`mercadolivre.com`** (o `.com` "apex"), que 301-redireciona para
o site `.com.br`. Como `mercadolivre.com` e `mercadolivre.com.br` são **eTLD+1 diferentes**, o detector
marcou bounce. **É um provável falso positivo instrutivo:** um redirect legítimo de consolidação de
domínios da mesma empresa tem a mesma forma técnica de um bounce tracking. Reforça a limitação "entidade
× eTLD+1" e a dificuldade de inferir **intenção**.

**Cookie sync DETECTADO** (`mercadolivre.com.br → google.com`, cookie `g_state`, parâmetro `bs`): é o
fluxo do **Google Sign-In / One Tap** (`accounts.google.com/gsi`), que troca um identificador de estado
com o Google. Detecção correta de um envio de ID de 1ª parte para um terceiro.

**Hijacking (5 indicadores, todos 1ª parte):** `Function.toString`, `window.fetch`,
`window.XMLHttpRequest`, `XMLHttpRequest.open`, `XMLHttpRequest.send`. O prefixo `wm_` no código das
substitutas indica uma **biblioteca de observabilidade/RUM** do próprio ML (medição de requisições e
performance). Legítimo, mesma discussão do g1.

**Comparação com o Blacklight** (11 ad trackers, 16 cookies de 3ª parte) **e uBO** (24 bloqueios, 8 de
10 domínios): as três concordam na direção — rastreamento **médio**, focado em **retargeting de
publicidade** (a própria rede `mercadoclics`, o Google, o Criteo). O Blacklight aponta **mais cookies de
3ª parte (16)** que o plugin (3): o Blacklight não interage com o banner de consentimento e roda no
Chrome sem particionamento, então grava cookies de 3ª parte que, no Firefox particionado do plugin, ou
não são gravados ou são contados de forma diferente. **[Divergência B: Chrome sem particionamento ×
Firefox com Total Cookie Protection.]**

### 4.3 gov.br — controle "site limpo"

Prints: `govbr-plugin-1..3`, `govbr-blacklight.png`, `govbr-ublock.png`. HAR: `govbr.har`.

**Detecção do plugin:** nota **B (64/100)**. 8 domínios de 3ª parte no HAR, e a maioria é
**infraestrutura ou governo**, não rastreamento: `cloudflare.com` e `jsdelivr.net` (CDNs), `ebc.com.br`
(Empresa Brasil de Comunicação, estatal), `sistema.gov.br` e `vlibras.gov.br` (serviços do próprio
governo), `go-mpulse.net` (monitoramento de performance da Akamai). **O único rastreamento real é o
Google** (`googletagmanager.com` + `analytics.google.com`, com o cookie `_ga_X0DQ0CT40G` de 3ª parte via
`ebc.com.br`). Storage: 6 itens de `localStorage`, todos de 1ª parte. Sem canvas, sem bounce, sem cookie
sync. 1 indicador de hijacking: `HTMLFormElement.submit` sobrescrito por um iframe de
`agenciagov.ebc.com.br` (provável tratamento de formulário de busca).

**Comparação com Blacklight** (1 ad tracker, **0 cookies de 3ª parte**) **e uBO** (5 bloqueios): as duas
concordam que o gov.br é **limpo** — o Blacklight vê 1 tracker (o Google) e nenhum cookie de 3ª parte.
**O controle negativo funcionou: a ferramenta não inventou rastreamento onde não há.**

**[Divergência C — a mais importante do gov.br]:** o plugin dá **B (64)**, não **A**, enquanto o
Blacklight diz "limpo". Motivo: a nota desconta **−2 por domínio de 3ª parte** e o gov.br tem 8-9 deles,
mas **quase todos são CDN/infra/governo, não rastreadores**. O Blacklight, por focar em **ad trackers** e
agrupar por entidade, ignora CDNs. **Ou seja: a nossa nota é mais dura que a realidade porque conta
infraestrutura como "terceiro".** É uma limitação consciente da metodologia (§6) e um ótimo exemplo de
por que a comparação com uma ferramenta madura é necessária.

---

## 5. Entregável 4 — Pontuação de privacidade

### 5.1 Metodologia (critérios, pesos, justificativa)

Não existe fórmula "correta"; vale uma metodologia **explícita e justificada**. A nota parte de **100** e
desconta por categoria, com peso proporcional à **gravidade** e um **limite por categoria** (nenhuma
zera a nota sozinha). Princípio dos pesos: **quanto menos o usuário consegue se defender, maior o peso**
(um cookie de sessão ele apaga fechando o navegador; um canvas fingerprint, não).

| Categoria | Desconto/ocorrência | Limite | Justificativa |
|---|---|---|---|
| Domínios de terceira parte | −2 | −20 | mais entidades recebendo dados |
| Cookies persistentes de 3ª parte | −3 | −20 | rastreiam entre sites e sobrevivem à sessão |
| Origens de 3ª parte usando storage | −4 | −12 | *supercookie*: sobrevive à limpeza de cookies |
| Scripts de canvas fingerprint | −15 | −30 | não pode ser apagado pelo usuário |
| Cookie sync / bounce tracking | −10 | −20 | contorna o bloqueio de cookies de 3ª parte |
| Indicadores de hijacking/hook | −15 | −30 | indício de comprometimento ativo da página |

**Faixas:** A 80–100 · B 60–79 · C 40–59 · D 20–39 · E 0–19.

### 5.2 Notas dos 3 sites × Blacklight

| Site | Nota do plugin | Principais descontos | Verdito do Blacklight | Concordam? |
|---|---|---|---|---|
| globo.com | **E (6)** | terceiros (−20), cookies persist. 3ª (−20), storage 3ª, sync, hijacking (−30) | 27 trackers, 14 cookies — "acima da média" | **Sim** (ambos: rastreamento pesado) |
| mercadolivre.com.br | **D (27)** | terceiros, cookies 3ª, bounce+sync, hijacking | 11 trackers, 16 cookies — "acima da média" | **Sim** (médio) |
| gov.br | **B (64)** | 8-9 terceiros (infra), 1 cookie 3ª, 1 hijacking | 1 tracker, 0 cookies — "limpo" | **Parcial** — ver [Divergência C] |

**Comparação crítica (onde concordam, onde divergem, por quê):**

- **Concordam:** a **ordenação** dos três sites é idêntica nas duas ferramentas (globo ≫ mercadolivre ≫
  gov.br). Ambas classificam o g1 como rastreamento pesado e o gov.br como limpo.
- **Divergem:** (1) na **contagem** de terceiros/trackers — [Divergência A]: eTLD+1 (plugin) × entidade
  (Blacklight), RTB variando entre cargas, e o plugin contando CDNs/infra; (2) na **nota do gov.br**
  ([Divergência C]) — o plugin é mais duro por descontar por domínio de 3ª parte, inclusive
  infraestrutura; (3) nos **cookies de 3ª parte** ([Divergência B]) — Chrome sem particionamento
  (Blacklight) × Firefox com Total Cookie Protection (plugin).
- **Por quê:** fontes de detecção diferentes (heurística × listas de bloqueio + agrupamento por
  entidade), navegadores diferentes (Firefox com particionamento × Chrome sem), e contexto diferente
  (Brasil com banner LGPD × EUA sem interagir com o banner).

---

## 6. Limitações conhecidas e honestidade metodológica

- **Entidade × eTLD+1:** o plugin conta domínios do mesmo dono como terceiros distintos
  (`glbimg.com`/`g.globo`, `google.com`/`doubleclick.net`) e conta **CDNs/infra** (Cloudflare, jsdelivr)
  como 3ª parte. Isso eleva a contagem e endurece a nota, principalmente em sites limpos (gov.br). O
  Blacklight usa uma lista de entidades; o plugin não.
- **Intenção × sobrescrita:** o detector de hijacking acusa **qualquer** sobrescrita de API global —
  inclusive as legítimas (rastreamento de clique em anúncio no g1, RUM no ML). Ele detecta o **mecanismo**,
  não a **intenção**.
- **Bounce e redirects legítimos:** um redirect entre domínios da mesma empresa
  (`mercadolivre.com` → `.com.br`) tem a forma técnica de um bounce e pode gerar falso positivo.
- **Pegada observável:** por usar hooks, a extensão é detectável (evidenciado pela própria página
  `js-leaks`). É o preço de qualquer detector baseado em interceptação.
- **Web Workers e iframes por índice** (`window[0]`) não passam pelos hooks do mundo da página.
- **Service Workers** escapam do bloqueio por `webRequest` (visto no Tracker Blocking).
- **A heurística é um compromisso:** durante o desenvolvimento, regras amplas demais geraram falsos
  positivos (o parâmetro `dl=g1.globo.com`, que é o endereço da página; o `tid=G-…`, que é a conta do
  Google Analytics do site). Cada filtro adicionado tem justificativa vinda de tráfego real, não de uma
  regra teórica "perfeita".

---

## 7. Conclusão

O Privacy Guard detecta as sete classes de rastreamento e ameaça propostas, com detecção validada nas
páginas do DuckDuckGo e em três sites reais de intensidade contrastante. A comparação com o Blacklight e
o uBlock Origin **concorda na ordenação e na direção**, e as divergências numéricas têm **causas
técnicas identificadas** (agrupamento por entidade, RTB, Chrome × Firefox, contexto de consentimento).
Mais importante para uma ferramenta de segurança: as limitações são **conhecidas e documentadas** — a
distinção entre CDN e rastreador, entre sobrescrita e intenção, e entre redirect legítimo e bounce são os
próximos passos naturais de evolução.

---

## Apêndice — Como reproduzir

1. Carregar a extensão em `about:debugging` → "Carregar extensão temporária" → `manifest.json`.
2. Configurar a Proteção contra Rastreamento como em §1.2; manter a lista de bloqueio vazia nas medições.
3. Por página/site: recarregar (**⌘⇧R**), abrir o popup, tirar o print, exportar o HAR (aba Rede →
   "Persistir logs" e "Desativar cache" on → recarregar → esperar o load → "Salvar tudo como HAR").
4. Blacklight: colar a URL em themarkup.org/blacklight.
5. uBlock Origin: ativar, abrir o painel/Logger, recarregar, anotar bloqueios e domínios.

_Conversão para PDF: abrir este arquivo em um visualizador de Markdown e imprimir como PDF, ou
`pandoc RELATORIO.md -o RELATORIO.pdf`._
