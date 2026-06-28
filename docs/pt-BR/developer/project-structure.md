# Estrutura do Projeto

> Leia isto em: [English](../../en/developer/project-structure.md) · **Português** · [← Voltar ao README](../../../README.pt-BR.md) · Documentação para desenvolvedores: [Arquitetura](./architecture.md) · **Estrutura do projeto** · [Build e testes](./building-and-testing.md) · [Modos de Execução e implantação](./run-modes-and-deployment.md)

Este é um mapa da base de código: a organização em camadas, os módulos principais e onde encontrar as coisas. Leia primeiro a [Arquitetura](./architecture.md) para o *porquê*; este documento cobre o *onde*.

## As três camadas

O repositório impõe uma direção estrita de dependência: **`@ui` → `@core` → (apenas interfaces) → `@adapters`**.

- **`@core/*`** — lógica de domínio agnóstica a framework. Sem React, sem DOM, sem importações de cliente de provedor/armazenamento — apenas interfaces. É aqui que vive a correção.
- **`@adapters/*`** — fronteiras substituíveis que tocam o mundo externo (armazenamento, rede/provedores, criptografia, PII, análise de arquivos).
- **`@ui/*`** — o shell React. Compõe tudo na raiz `runtime.ts` e renderiza o assistente de fases.

Os testes ficam **co-localizados** com o código que cobrem, como arquivos `*.test.ts(x)`.

## Organização de nível superior

```
.
├── README.md                  # index landing page (this doc set's entry)
├── CONTRIBUTING.md            # contribution guide
├── SECURITY.md                # security & privacy policy
├── LICENSE                    # MIT
├── index.html                 # Vite entry HTML
├── package.json               # scripts + dependencies
├── Dockerfile                 # multi-stage: build → unprivileged nginx (static only)
├── docker-compose.yml         # full local stack (web + ollama + optional localai)
├── docker/nginx.conf          # SPA static-serving config
├── .tool-versions             # pinned Node version
├── locales/                   # externalised UI strings (no hardcoded text)
│   ├── en.json
│   └── pt-BR.json
├── docs/                       # documentation (this folder)
│   └── en/ …
└── src/
    ├── core/                  # @core — domain logic
    ├── adapters/              # @adapters — boundaries
    └── ui/                    # @ui — React shell
```

## `src/core` — lógica de domínio

| Módulo | O que faz |
|---|---|
| `core/types` | Tipos de domínio compartilhados e IDs com marca (`Provenance`, `Confidence`, `ExtractedItem`, `SkillMapEntry`, `Accomplishment`, `TalkingPoint`, `RolePreference`, `StarId`/`BulletId`/`SkillId`/`RoleSlug`, …). |
| `core/provenance` | O Serviço de Proveniência / Citação: anexa um rastro de origem a todo fato e resolve qualquer referência de afirmação de volta à sua origem (alimenta o inspetor de rastreamento de origem da UI e o harness de Não Fabricação). |
| `core/egress` | O **Portão de Saída único** (`egress-gate.ts`) + o **controle de envio** granular da ingestão (`send-control.ts`). O único caminho até qualquer provedor. |
| `core/ingestion` | O Ingestion_Engine e suas partes: detecção de formato (`formats.ts`), extração estruturada (`extraction.ts`), lógica de datas/lacunas (`dates.ts`, `eligibility.ts`), decodificação de DOCX (`docx.ts`), os documentos sem perdas `raw_extractions.md` e `raw_documents.md`, e `ingestion-engine.ts`. |
| `core/skills` | O Skill_Mapper: normalização conservadora + proteção contra confusables, o grafo bidirecional competência↔realização, (de)serialização do mapa de competências e o fluxo opcional de **descoberta de competências** por IA (`skill-discovery.ts`, `skill-assist.ts`). |
| `core/role-matcher` | Descoberta de funções, pontuação de correspondência ontológica (taxonomia de implementa/estende) e captura/persistência de preferências de função. |
| `core/interview` | O Interview_Coach: geração de perguntas STAR, o laço de resposta guiado com Encerramento Parcial (Soft-Close), o laço adaptativo de treino por IA, refinamento de pontos de fala, **gravação de áudio** no navegador (`recording.ts`) e tratamento de áudio enviado (`audio.ts`), e o firewall de conteúdo/entrega. |
| `core/output` | O Output_Engine: o único `CvModel`, os renderizadores Markdown/PDF/DOCX, fidelidade entre formatos, versionamento imutável + diffing, formatação de locale e o relatório consultivo do LinkedIn. |
| `core/healing` | A passagem de cura de estado + o registro de IDs estáveis: detecta IDs órfãos/duplicados na retomada e reporta em vez de lançar erro. |
| `core/registry` | O `IdRegistry` que aloca identificadores estáveis e nunca reutilizados `STAR-NN` / `BULLET-NN`. |
| `core/storage` | A `MemoryTree` canônica, o modelo de caminho canônico (`paths.ts`, `CANONICAL_FILES`) e a serialização compartilhada por ambas as camadas de armazenamento. |
| `core/orchestrator` | O statechart de seis fases do XState, a retomada de sessão e os gatilhos de reentrada (`resume.ts`). |
| `core/assist` | O contrato compartilhado de adesão-opcional-primeiro à assistência de IA (`runAssist`, `AssistMode`, `AssistChoice`) e a preferência persistida de modo de assistência (`assist-preference.ts`). |
| `core/privacy` | O modelo da declaração de privacidade, o estado de consentimento e o canal de rótulos de rede. |
| `core/no-fabrication` | O No_Fabrication_Harness e suas fixtures (o esqueleto de CI da Propriedade 1). |
| `core/locale` | Configuração do i18next, detecção/confirmação de idioma e configuração de locale. |

## `src/adapters` — fronteiras

| Arquivo | O que faz |
|---|---|
| `provider.ts` | Interfaces de provedor (`ProviderManager`, `LlmProvider`, `SttProvider`, `RedactedPayload`, `AudioBlob`, …). |
| `provider-manager.ts` | O `DefaultProviderManager` plugável + os plugins de provedor padrão (OpenAI, Anthropic, Local sem chave). |
| `llm-http.ts` | Os clientes HTTP compatíveis com OpenAI (nuvem + local), incl. transcrição/tradução do Whisper. |
| `local-config.ts` | URL base / modelo de chat / modelo de STT / máximo de tokens de resposta editáveis para o provedor local sem chave, no armazenamento local do navegador. |
| `vault.ts` | O cofre de chaves Web Crypto (AES-GCM) para chaves BYOK criptografadas em repouso. |
| `pii.ts` | O `PII_Scanner` (regex + JS leve) e `redact()`. |
| `send-control-store.ts` | Persistência local no navegador das decisões de controle de envio por arquivo/por detecção (apenas escolhas, nunca conteúdo). |
| `storage.ts`, `storage-fs-access.ts`, `storage-fallback.ts`, `fallback-persistence.ts` | O Storage_Adapter de duas camadas (File System Access; OPFS/IndexedDB). |
| `memory-store-zip.ts` | Exportação/importação `.zip` de todo o Repositório de Memória (camada de fallback). |
| `pdf-extractor.ts` | Extração de texto com pdf.js, com sinalização de baixa confiança. |
| `linkedin-zip.ts` | Leitura de ZIP + análise de CSV da exportação do LinkedIn. |
| `typst-pdf.ts` | O compilador de PDF Typst-para-WebAssembly (wasm empacotado localmente, sem CDN). |

## `src/ui` — o shell React

| Arquivo | O que faz |
|---|---|
| `App.tsx` | A raiz do shell: localização, consentimento, seleção de provedor, o assistente de fases e os modais (redigir e prosseguir, Pré-visualização da Carga). |
| `runtime.ts` | A raiz de composição — o **único** lugar onde os adaptadores de provedor e o Portão de Saída são construídos e ligados. |
| `PhaseWizard.tsx`, `phase-wizard-controller.ts` | Navegação/persistência do assistente que dirige o orquestrador. |
| `ProviderSetup.tsx`, `ProviderSelection.tsx`, `provider-availability.ts` | Configuração de provedor BYOK / local e seleção por capacidade. |
| `IngestScreen.tsx` | Fase 1 — enviar/colar, revisar, painel de controle de envio e a **Pré-visualização de Conversão** somente leitura. |
| `SkillMapScreen.tsx`, `RoleDiscoveryScreen.tsx`, `CoachingScreen.tsx`, `OutputScreen.tsx`, `MemoryScreen.tsx` | As demais telas de fase. |
| `RecordAnswer.tsx`, `audio-recorder-port.ts` | Gravação de microfone no navegador (a costura do DOM sobre o `MediaRecorder`) e sua UI. |
| `PayloadPreviewModal.tsx` | O modal de pré-envio "revise o texto exato de saída". |
| `SendControlPanel.tsx` | A UI de controle de envio por arquivo na ingestão. |
| `AssistChoice.tsx` | O modo de IA com adesão-opcional-primeiro + a superfície de rótulos de rede/privacidade. |
| `SourceTraceInspector.tsx` | Resolve qualquer referência de afirmação até seu rastro de proveniência. |
| `PrivacyStatement.tsx` | A renderização da declaração de privacidade + consentimento + rótulos de rede. |
| `design-system/` | Tokens + componentes compartilhados (`Button`, `TextField`, `TextArea`, `PhaseChrome`, primitivos de layout, primitivos de estado) para que toda tela tenha estilo e comportamento consistentes. |

## Convenções

- **IDs com marca** (por exemplo `StarId`, `SkillId`) são tipos nominais — construa-os via os ajudantes `as*` em `core/types`, nunca por casting bruto.
- **Sem strings voltadas ao usuário fixas no código** — tudo passa por `t(...)` e vive em `locales/en.json` + `locales/pt-BR.json`.
- **Adaptadores são injetados** em `runtime.ts`; os testes injetam fakes. Os módulos do núcleo recebem colaboradores via parâmetros/DI, nunca por importações globais de uma implementação.
- **Os testes ficam ao lado do código** como `*.test.ts(x)`; os testes de propriedade são marcados com um comentário `// Feature: career-agent, Property N: …`.
