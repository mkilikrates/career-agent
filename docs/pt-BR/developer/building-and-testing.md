# Build e Testes

> Leia isto em: [English](../../en/developer/building-and-testing.md) · **Português** · [← Voltar ao README](../../../README.pt-BR.md) · Documentação para desenvolvedores: [Arquitetura](./architecture.md) · [Estrutura do projeto](./project-structure.md) · **Build e testes** · [Modos de Execução e implantação](./run-modes-and-deployment.md)

Como compilar o Agente de Carreira a partir do código-fonte e rodar suas suítes de teste.

## Pré-requisitos

- **Node.js 24.16.0** (fixado em `.tool-versions`; qualquer Node 20+ recente deve funcionar para o desenvolvimento local).
- Um navegador moderno. **Navegadores desktop baseados em Chromium (Chrome, Edge)** têm a experiência completa, incluindo a camada de armazenamento File System Access; Safari / Firefox / mobile recuam para armazenamento dentro do navegador com exportação/importação `.zip`.

## Início rápido (desenvolvimento)

```bash
npm install        # install dependencies
npm run dev        # start the Vite dev server (prints a localhost URL, e.g. http://localhost:5173)
```

Abra a URL exibida no seu navegador.

## Build de produção

```bash
npm run build      # type-checks (tsc -b) then builds the static bundle to dist/
npm run preview    # serve the built dist/ locally to verify
```

O build define `base: './'`, então todo caminho de asset é **relativo** e `dist/` é um pacote estático autocontido que você pode hospedar em qualquer host estático (GitHub Pages, S3, Netlify, um servidor web simples) sob qualquer caminho, sem código no lado do servidor.

> **Por que você não pode simplesmente abrir `dist/index.html` a partir de `file://`:** navegadores modernos bloqueiam scripts de módulo ES e web workers (o app usa um worker do `pdf.js`, e o caminho de PDF do Typst carrega um asset WASM + chunk de worker) na origem `file://`. **Sirva** a pasta:
>
> ```bash
> npm run preview
> # or any static server:
> npx serve dist
> python3 -m http.server --directory dist 8080
> ```

## Scripts npm

| Script | Finalidade |
|---|---|
| `npm run dev` | Servidor de desenvolvimento Vite. |
| `npm run build` | Verificação de tipos (`tsc -b`) + build estático de produção em `dist/`. |
| `npm run preview` | Serve o `dist/` compilado localmente. |
| `npm run typecheck` | Verificação de tipos sem emitir (`tsc -b --noEmit`). |
| `npm test` | Roda a suíte Vitest completa (unidade + propriedade + smoke). |
| `npm run test:watch` | Vitest em modo watch. |
| `npm run test:no-fabrication` | Roda apenas a suíte de regressão de Não Fabricação. |

## Estratégia de testes

A suíte é **dupla**: testes baseados em exemplos para comportamentos concretos e fronteiras externas, e testes **baseados em propriedades** para invariantes universais de correção. Os testes ficam co-localizados com o código como `*.test.ts(x)`.

### Testes de exemplo / unidade / integração

Usados para casos concretos e fronteiras: fixtures de análise de ZIP/CSV do LinkedIn, fluxos de validação de chave BYOK (com um provedor mockado), roteamento por capacidade, envio/gravação de áudio → STT mockado → confirmar, o portão de controle de envio, reidratação de sessão/importação de Memória, as telas do assistente de seis fases, verificações de acessibilidade, e assim por diante. As fronteiras externas (LLM, STT, File System Access, Typst-Wasm, `MediaRecorder`) são **mockadas**.

### Testes baseados em propriedades (`fast-check`)

Cada propriedade de correção é implementada como um único teste `fast-check` + Vitest rodando um **mínimo de 100 iterações**, marcado com um comentário:

```ts
// Feature: career-agent, Property 3: <property text>
```

Os testes de propriedade carregam o ônus da cobertura ampla de entradas. Exemplos do que eles fixam:
- completude da redação + a fronteira de saída (nada transmitido exceto via o portão; nenhum valor secreto vaza);
- proteções de mesclagem conservadora e mesclagens reversíveis no Skill Mapper;
- o Repositório de Memória faz ida e volta de forma idêntica entre ambas as camadas de armazenamento;
- integridade de IDs estáveis e bidirecionalidade;
- resolução de correspondência ontológica;
- controle de elegibilidade de saída e fidelidade de saída entre formatos;
- a garantia de orquestração de IA com adesão-opcional-primeiro (somente-script faz zero chamadas a provedor; a IA apenas complementa).

Ao adicionar lógica de domínio com um espaço amplo de entradas e um invariante universal claro, prefira um teste de propriedade a um punhado de exemplos.

### O harness de Não Fabricação

`npm run test:no-fabrication` roda o esqueleto executável da Regra de Não Fabricação contra uma biblioteca de fixtures que inclui perfis deliberadamente **esparsos** e **adversariais** (por exemplo, um cargo nu sem ferramentas listadas). Ele extrai toda afirmação factual da saída gerada, resolve cada uma contra o índice de proveniência e **falha** em qualquer afirmação não resolvida ou competência/ferramenta inventada. Qualquer novo caminho que produza saída deve ser coberto aqui.

## O que a CI / um PR espera

Antes de abrir um pull request:

```bash
npm run typecheck   # must pass (exit 0)
npm test            # full suite must pass
```

Adicione ou atualize testes para a sua mudança e mantenha os [invariantes de confiança](./architecture.md#os-invariantes-inegociáveis) intactos. Veja [CONTRIBUTING.md](../../../CONTRIBUTING.md) para o fluxo completo.

## Solução de problemas do build

- **Erros do `tsc` depois de um pull:** rode `npm install` (dependências ou tipos podem ter mudado).
- **Erros de PDF/worker ao testar o pacote compilado:** garanta que você está **servindo** o `dist/` (`npm run preview`), e não abrindo-o a partir de `file://`.
- **Um teste de propriedade falha de forma intermitente:** o `fast-check` imprime o contraexemplo (a seed + a entrada reduzida). Reproduza-o com essa seed; uma propriedade instável geralmente significa que o invariante — não o teste — está errado.
