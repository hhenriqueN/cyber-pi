# Privacy Guard

Extensão para Firefox que detecta e apresenta rastreamento e ameaças no cliente web.
Desenvolvida para a Avaliação Intermediária de Cibersegurança (Insper).

## Funcionalidades

| Funcionalidade | Status |
|---|---|
| Conexões a domínios de terceira parte (eTLD+1) | ✅ |
| Cookies: 1ª/3ª parte, sessão/persistente | ✅ |
| Armazenamento HTML5 (localStorage, sessionStorage, IndexedDB) | ✅ |
| Cookie sync / bounce tracking | ✅ |
| Canvas fingerprint | ✅ |
| Indicadores de hijacking/hook (WebSocket, polling, sobrescrita de globais) | ⏳ |
| Pontuação de privacidade | ⏳ |
| Lista de bloqueio personalizada | ⏳ |

## Como instalar (about:debugging)

1. Abra o Firefox e acesse `about:debugging#/runtime/this-firefox`.
2. Clique em **Carregar extensão temporária…**.
3. Selecione o arquivo `manifest.json` na raiz deste repositório.
4. O ícone do Privacy Guard aparece na barra de ferramentas. Se não aparecer, clique no ícone de extensões (peça de quebra-cabeça) e fixe-o.
5. Abra ou **recarregue** a página a ser analisada e clique no ícone.

> A extensão temporária é removida ao fechar o Firefox. Após editar o código, use o botão **Recarregar** em `about:debugging`.

Para ver erros e logs do background: em `about:debugging`, clique em **Inspecionar** na extensão.

## Ambiente de teste

Para que o próprio Firefox não bloqueie rastreadores antes de a extensão observá-los:

- `Configurações → Privacidade e Segurança → Proteção aprimorada contra rastreamento → Personalizado`
  - **Conteúdo com rastreamento**: desligado;
  - **Criptomineradores**: desligado;
  - **Rastreadores de identidade digital (fingerprinters) conhecidos**: desligado;
  - **Suspeitos de ser rastreadores de identidade digital**: desligado;
  - **Cookies**: ligado em "Isolar cookies entre sites" (Total Cookie Protection, padrão do Firefox).
    Mantido de propósito, porque é o comportamento real do navegador; os efeitos do particionamento
    são discutidos nas divergências do relatório.
- Testes feitos em janela normal (não privativa).
- uBlock Origin instalado, mas **desativado** durante as medições do plugin (ativado apenas na etapa de comparação).

## Metodologia de classificação

**Primeira × terceira parte:** uma requisição é de terceira parte quando o seu domínio registrável
(eTLD+1, calculado pela [Public Suffix List](https://publicsuffix.org/) via biblioteca
[tldts](https://github.com/remusao/tldts)) difere do eTLD+1 da página de topo da aba.
Exemplo: `img.globo.com` e `g1.globo.com` são o mesmo site (`globo.com`); `a.exemplo.com.br` e
`b.outro.com.br` não são, pois `com.br` é um sufixo público.

**Cookies injetados no carregamento:** todo cookie gravado entre o início da navegação de topo
(incluindo saltos de redirecionamento) e o momento da consulta. Dois caminhos são capturados:

- **HTTP**: cabeçalho `Set-Cookie` em qualquer resposta da aba (`webRequest.onHeadersReceived`);
- **JavaScript**: `document.cookie` (`cookies.onChanged`). Como esse evento não informa a aba, o cookie
  é atribuído às abas cuja página é do mesmo site que o cookie ou cujo site é o topo da partição
  do cookie (`partitionKey.topLevelSite`, Total Cookie Protection).

Cada cookie (nome + domínio + path) é contado uma vez. Comandos de remoção (`Max-Age<=0` ou `Expires`
no passado) não contam como injeção.

- **1ª × 3ª parte**: eTLD+1 do domínio do cookie comparado ao eTLD+1 da página final.
- **Sessão × persistente**: sem `Expires`/`Max-Age` é de sessão; com data de expiração é persistente
  (`Max-Age` tem precedência sobre `Expires`, RFC 6265 §5.3).

**Armazenamento HTML5:** o content script `content/storage.js` roda em **todos os frames**
(inclusive iframes de terceira parte) em `document_start`, antes dos scripts da página, e reporta
ao background o que existe na origem do frame:

| Mecanismo | Vida útil | Escopo | Como é detectado |
|---|---|---|---|
| `localStorage` | persistente | por origem | snapshot + interceptação de `Storage.prototype.setItem` |
| `sessionStorage` | até fechar a aba | por aba + origem | idem |
| `IndexedDB` | persistente | por origem | `indexedDB.databases()` + interceptação de `IDBFactory.prototype.open` |

- **Snapshot:** o estado lido antes dos scripts da página é a linha de base; chaves novas ou com valor
  alterado nas releituras (a cada 2 s) foram **gravadas neste carregamento**. Pega qualquer forma de
  escrita, inclusive `localStorage.x = ...`.
- **Interceptação:** o content script roda num mundo isolado e não vê as chamadas da página; por isso
  `content/page-hooks.js` é declarado com `"world": "MAIN"` (Firefox 128+) e roda no próprio contexto
  da página, antes dos scripts dela. Ele substitui `setItem` e `indexedDB.open` por versões que chamam
  a original (mesmo retorno e mesmas exceções) e avisam o content script por um `CustomEvent`.
  Isso registra regravações com o mesmo valor e a abertura de bancos IndexedDB.
- **Envio imediato:** iframes de rastreamento costumam gravar e ser removidos logo depois (é o que faz
  a página *Storage blocking* do DuckDuckGo). Por isso, cada gravação é reportada na mesma tarefa
  (microtask), antes que o frame possa ser destruído.
- **Limitação:** por rodar no mundo da página, um script malicioso poderia detectar ou forjar os eventos
  dos hooks; o snapshot (lido pelo mundo isolado) não é afetado.
- **1ª × 3ª parte:** eTLD+1 da origem do frame comparado ao da página. No Firefox, o armazenamento de
  iframes de 3ª parte é **particionado** pelo site de topo (State Partitioning).

**Canvas fingerprint:** `content/page-hooks.js` (mundo da página) intercepta `fillText`, `strokeText`,
`save`, `restore`, `drawImage`, `getImageData`, `toDataURL`, `toBlob` e, para `OffscreenCanvas`,
`convertToBlob` e `transferToImageBitmap`. A cada extração de imagem, aplica a heurística de
Englehardt & Narayanan (2016, *Online Tracking: A 1-million-site Measurement and Analysis*, ACM CCS, §6.1).
A leitura é classificada como fingerprint quando **todos** os critérios são atendidos:

| Critério | Condição | Por quê |
|---|---|---|
| C1 | canvas com largura e altura ≥ 16 px | canvas minúsculos não geram entropia suficiente |
| C2 | texto escrito com ≥ 2 cores **ou** ≥ 10 caracteres distintos | a renderização de fontes/antialiasing é a principal fonte de variação entre máquinas |
| C3 | nenhum `save`/`restore`/`addEventListener` no canvas | indicam uso interativo legítimo (editor, jogo, gráfico) |
| C4 | extração via `toDataURL`/`toBlob`/`convertToBlob` ou `getImageData` com área ≥ 16×16 | é a leitura dos pixels que gera o identificador |
| C5 | formato sem perda (não `image/jpeg`/`image/webp`) | compressão com perda destrói as diferenças sutis |

Quando o desenho é copiado entre canvases (`drawImage`, inclusive de `OffscreenCanvas` via `ImageBitmap`),
as informações de texto da origem são herdadas pelo destino, para que a leitura final seja avaliada
corretamente. O script responsável é identificado pela pilha de chamadas (`Error().stack`) e classificado
como 1ª ou 3ª parte. Leituras que não atendem aos critérios são apenas contadas (uso provavelmente legítimo).
A heurística cobre canvas 2D; leituras de canvas WebGL não são classificadas.


**Iframes "limpos":** cada iframe tem os seus próprios protótipos (`HTMLCanvasElement.prototype` etc.).
Scripts de fingerprint podem criar um iframe `about:blank` e usar as funções dele, que o navegador não
chegou a instrumentar. O BrowserLeaks faz exatamente isso
(`document.querySelector("#canvas-iframe").contentDocument.createElement("canvas")`). Por isso, os getters
`contentWindow` e `contentDocument` de `iframe`, `frame` e `object` também são interceptados: antes de
devolver a janela do iframe à página, os hooks são instalados nela.

**Limitações conhecidas:** código executado em **Web Workers** (inclusive `OffscreenCanvas` num worker) e
acesso a iframes por índice (`window[0]`, `window.frames[0]`) não passam pelos hooks.

## Estrutura

```
manifest.json        declaração da extensão (Manifest V2)
background/          estado por aba, captura de requisições (webRequest)
content/             content scripts e scripts injetados na página
popup/               interface do relatório
lib/                 bibliotecas de terceiros (tldts + Public Suffix List)
icons/               ícone
evidencias/          HAR e prints usados no relatório
```
