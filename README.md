# Privacy Guard

Extensão para Firefox que detecta e apresenta rastreamento e ameaças no cliente web.
Desenvolvida para a Avaliação Intermediária de Cibersegurança (Insper).

## Funcionalidades

| Funcionalidade | Status |
|---|---|
| Conexões a domínios de terceira parte (eTLD+1) | ✅ |
| Cookies: 1ª/3ª parte, sessão/persistente | ⏳ |
| Armazenamento HTML5 (localStorage, sessionStorage, IndexedDB) | ⏳ |
| Cookie sync / bounce tracking | ⏳ |
| Canvas fingerprint | ⏳ |
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
