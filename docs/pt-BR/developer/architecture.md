# Arquitetura e Modelo de Confiança

> Leia isto em: [English](../../en/developer/architecture.md) · **Português** · [← Voltar ao README](../../../README.pt-BR.md) · Documentação para desenvolvedores: **Arquitetura** · [Estrutura do projeto](./project-structure.md) · [Build e testes](./building-and-testing.md) · [Modos de Execução e implantação](./run-modes-and-deployment.md)

Este documento explica *como o Agente de Carreira funciona* e os invariantes que toda a base de código foi construída para sustentar. Se você for ler apenas um documento de desenvolvedor antes de contribuir, leia este.

## O que é

O Agente de Carreira é um **web app de navegador local-first** (TypeScript + WebAssembly, pacote estático React + Vite, **sem backend**). Ele transforma os documentos de carreira de um usuário em um perfil baseado em evidências, treina respostas de entrevista no formato STAR e gera saídas compatíveis com ATS (Markdown, PDF via Typst para WebAssembly, DOCX estruturado) — inteiramente no dispositivo do usuário.

## Os invariantes inegociáveis

Tudo o mais decorre destes. As contribuições devem preservar todos eles.

1. **Sem backend.** Toda a análise, mapeamento de competências, diagramação e persistência rodam no navegador. Nenhum servidor recebe ou armazena dados do usuário.
2. **Ponto único de estrangulamento de saída.** Nenhum componente de domínio chama um cliente de provedor diretamente. Toda requisição de saída a um provedor passa pelo único **Portão de Saída** (Egress Gate), que aplica triagem prévia de PII, rotulagem da operação e minimização da carga antes que qualquer coisa saia do dispositivo.
3. **Regra de Não Fabricação (No-Fabrication Rule).** Toda afirmação factual na saída gerada deve resolver para um registro de proveniência — uma linha de documento de origem, uma confirmação explícita do usuário ou uma resposta de entrevista confirmada. Nada é inventado; um cargo, por si só, nunca implica uma competência.
4. **A proveniência é obrigatória.** Todo fato carrega uma citação desde o momento da extração. A saída só pode emitir fatos que carreguem proveniência.
5. **O Repositório de Memória permanece no dispositivo.** Ele é Markdown legível por humanos, de propriedade do navegador; nunca é gravado ou recebido por um servidor, contêiner ou volume montado no host em nenhum Modo de Execução.
6. **O Markdown é o banco de dados.** O Repositório de Memória *é* o estado canônico; os objetos em memória são uma projeção hidratada que deve fazer ida e volta sem perdas.
7. **A IA é opcional e determinística primeiro.** Toda operação assistível por IA tem um caminho completo somente-script que não faz nenhuma chamada a provedor. A IA apenas *complementa* uma linha de base determinística, e o usuário deve confirmar qualquer saída de IA antes que ela entre na base de conhecimento.

## Forma de alto nível

```
┌──────────────────────────────────────────────────────────────┐
│ @ui  — React + Vite static SPA (the shell)                     │
│   PhaseWizard · per-phase screens · privacy/network labels     │
└───────────────┬────────────────────────────────────────────────┘
                │  drives
┌───────────────▼────────────────────────────────────────────────┐
│ @core — framework-agnostic domain logic                         │
│   Orchestrator (XState) · Ingestion · Skill Mapper · Role       │
│   Matcher · Interview Coach · Output Engine · Provenance ·      │
│   State-Healing/ID Registry · Egress Gate                       │
└───────────────┬────────────────────────────────────────────────┘
                │  only via interfaces
┌───────────────▼────────────────────────────────────────────────┐
│ @adapters — swappable boundaries                                │
│   Storage (FS Access / OPFS+IDB) · Provider_Manager (OpenAI,    │
│   Anthropic, keyless Local) · PII_Scanner · Web Crypto vault    │
└─────────────────────────────────────────────────────────────────┘
   WebAssembly: Typst typesetter (bundled, no CDN) · pdf.js worker
```

**A separação entre núcleo e shell** é o princípio estrutural: toda a lógica de domínio vive em módulos `@core/*` agnósticos a framework, que nunca importam React, o DOM ou uma implementação de adaptador — apenas interfaces. O shell de UI (`@ui`) e as fronteiras de armazenamento/rede/criptografia (`@adapters`) são finos e substituíveis. Isso mantém o núcleo agnóstico quanto ao empacotamento (navegador hoje, um wrapper Tauri possível depois, sem reescrita).

## O Portão de Saída (o coração do modelo de confiança)

O Portão de Saída (Egress Gate, `@core/egress`) é o **ponto único de estrangulamento** pelo qual flui toda requisição de saída a um provedor — incluindo requisições a um provedor local. Nenhum componente de domínio tem permissão de importar um cliente de provedor diretamente; somente a raiz de composição (`@ui/runtime.ts`) constrói os adaptadores de provedor e o portão.

Para uma requisição de **texto de chat/LLM** de saída, o portão executa esta sequência, nesta ordem, antes que qualquer coisa saia do dispositivo:

1. **Rotular** a operação de rede (para que a UI possa exibi-la *antes* da chamada rodar). Um provedor na nuvem com chave é marcado como *chamada de rede de terceiros*; um provedor local sem chave é marcado como *chamada local no dispositivo, sem saída a terceiros*.
2. **Pré-visualização da Carga (Payload Preview)** *(somente terceiros)* — apresenta o texto exato de saída para o usuário revisar, editar livremente ou cancelar. O cancelamento falha de forma fechada (nada é transmitido). Pulada para provedores locais, conteúdo de ingestão e áudio.
3. **Triagem prévia de PII** sobre o texto aprovado pelo usuário, via `PII_Scanner` (regex + correspondência leve em JS para SSN, NINO, números de cartão de crédito, chaves/tokens de API).
4. **Redigir e prosseguir** — se valores de alto risco forem detectados, notificar o usuário sobre as *categorias* (nunca os valores secretos) e oferecer redigir e continuar; recusar falha de forma fechada.
5. **Construir a Carga Redigida minimizada** e anexar a flag `noTraining` derivada do consentimento.
6. **Repassar ao Provider_Manager**, que transmite apenas para o provedor escolhido pelo usuário e descriptografa a chave desse provedor no momento exato (just-in-time).

O portão **falha de forma fechada**: se a triagem não puder ser concluída ou um colaborador estiver ausente, ele lança um erro e não transmite nada. Ele **não tem referência ao Storage_Adapter**, então fisicamente não pode transmitir arquivos do Repositório de Memória.

Dois controles relacionados e mais granulares ficam ao lado dele:
- **Controle de envio granular na ingestão** — antes que qualquer *conteúdo de arquivo* seja enviado durante a ingestão, o usuário toma uma decisão por arquivo: enviar o arquivo inteiro, ou permitir/redigir cada detecção sensível individual. O portão se recusa a construir uma carga até que essa decisão seja confirmada. Destinos na nuvem definem cada detecção como redigida por padrão; um destino local sem chave pode enviar o arquivo inteiro (nada sai do dispositivo).
- **Roteamento por capacidade** — o provedor de chat/LLM e o provedor de fala para texto são escolhidos de forma independente; cada capacidade roteia pelo portão até o seu próprio provedor escolhido.

## O pipeline de seis fases

Um pipeline com estado, **retomável por sessão**, modelado como um statechart do XState. O usuário pode parar em qualquer ponto (inclusive no meio de uma pergunta) e retomar exatamente ali; cada fase lê e grava no Repositório de Memória após cada etapa confirmada.

```
Ingest → Skill Map → Role Discovery → Interview Coaching → Output Generation → Memory & Maintenance
```

- **Ingestão** — aceita PDF / Markdown / texto puro / DOCX / ZIP de exportação do LinkedIn; extrai registros estruturados com **confiança** (Alta/Média/Baixa) e **proveniência**; detecta lacunas de emprego e conflitos entre múltiplos documentos; oferece uma **Pré-visualização de Conversão** somente leitura do texto decodificado por documento.
- **Mapa de Competências** — normalização de competências conservadora e reversível, com uma proteção "confusables" que nunca mescla; um grafo bidirecional competência↔realização com IDs estáveis (`SKILL-…`, `BULLET-NN`, `STAR-NN`).
- **Descoberta de Funções** — funções sugeridas, pontuadas com correspondência ontológica (por exemplo, PostgreSQL satisfaz um requisito de SQL) usando uma taxonomia extensível.
- **Treinamento para Entrevista** — geração de perguntas STAR; um laço de resposta guiado com Encerramento Parcial (Soft-Close); respostas em texto, áudio enviado ou gravado no navegador (transcritas pelo portão); um firewall de conteúdo/entrega para que sotaque/disfluência nunca afetem a qualidade avaliada.
- **Geração de Saída** — um único `CvModel` renderizado em Markdown (primário), PDF de texto selecionável compatível com ATS (Typst/Wasm, empacotado localmente) e DOCX estruturado, com fidelidade entre formatos e versionamento imutável.
- **Memória e Manutenção** — exportar/importar e exclusão completa do Repositório de Memória.

## IA opcional, determinística primeiro

Quatro componentes oferecem ajuda opcional de IA — Skill Mapper (descoberta de competências), Role Matcher (recomendações de funções), Interview Coach (perguntas STAR, resumos educativos, o laço adaptativo de treino) e Output Engine (personalização do currículo). Eles compartilham **um** contrato de adesão opcional primeiro:

- **`script-only`** → um resultado determinístico completo com **zero** chamadas a provedor. Sempre disponível e é o caminho padrão que preserva a confiança.
- **`ai-assisted` / `ai-only`** → a linha de base determinística mais complementos derivados do provedor, roteados pelo Portão de Saída; a saída de IA é apresentada como *sugestões* que o usuário deve confirmar. Em caso de falha do provedor, o orquestrador recua para a linha de base com um erro não bloqueante.

O modo escolhido é uma única preferência válida para todo o pipeline, apresentada logo no início, na Ingestão, e persistida no Repositório de Memória (`config/assist_preference.md`).

## Provedores

- **Nuvem com chave (BYOK):** OpenAI (chat completions + Whisper STT, incl. traduzir-para-inglês) e Anthropic (messages). As chaves são validadas com uma sondagem barata `GET /models`, criptografadas em repouso (AES-GCM via Web Crypto), descriptografadas no momento exato, transmitidas apenas ao provedor a que pertencem, e nunca gravadas no Repositório de Memória. O app **não** embarca nenhuma chave compartilhada.
- **Local sem chave:** um cliente genérico compatível com OpenAI (cabeçalho de auth omitido) apontando para um servidor na própria máquina do usuário — Ollama (padrão `http://localhost:11434/v1`), LocalAI, LM Studio, llama.cpp, vLLM. A URL base e os nomes de modelo vivem no armazenamento local do navegador (nunca no Repositório de Memória). Quando todo provedor selecionado é local, o app fica totalmente offline.

## Harness de Não Fabricação

O esqueleto executável da Regra de Não Fabricação: uma suíte de CI sobre uma biblioteca de fixtures (incluindo perfis esparsos e adversariais) que extrai toda afirmação factual da saída gerada, resolve cada uma contra o índice de proveniência e quebra o build em qualquer afirmação não resolvida ou competência/ferramenta inventada. Novos caminhos de saída devem ser cobertos por ela.

## Princípios de transparência

O Agente de Carreira é construído em torno da transparência total das decisões automatizadas. Nada que o sistema faz com seus dados é oculto — cada requisição de saída e cada transformação de pós-processamento é exibida na UI para que você possa inspecionar, verificar e substituir.

### Transparência de Saída (Egress Transparency)

Toda requisição de saída pelo Portão de Saída é totalmente transparente para o usuário:

- **Registro de saída (Egress logging).** Todo prompt enviado e resposta recebida — independentemente do tipo de provedor (nuvem ou local) — é persistido em `log/egress_log.md` no Repositório de Memória. Cada `EgressLogEntry` contém:
  - Timestamp (ISO 8601)
  - Destino do provedor (ex.: `openai`, `anthropic`, `local`)
  - Tipo de operação (ex.: `chat`, `stt`, `skill-discovery`, `role-discovery`, `star-questions`, `coaching-loop`, `cv-tailoring`)
  - Texto completo do prompt enviado
  - Texto completo da resposta recebida

  As entradas são armazenadas em formato Markdown legível por máquina (uma seção por entrada). Para cargas muito grandes (>10KB), a exibição na UI trunca, mas o log persistido sempre contém o texto completo. O log é visualizável na tela da fase Memória e Manutenção como uma visualização cronológica somente leitura.

- **Pré-visualização de prompt para todos os provedores.** Para provedores na nuvem com chave, a pré-visualização da carga (Payload Preview) mostra o texto exato de saída antes da transmissão e o usuário pode editar ou cancelar. Para provedores locais sem chave, uma pré-visualização informativa (não bloqueante) mostra o mesmo texto com um rótulo "isto permanece no seu dispositivo", para que os usuários possam sempre inspecionar o que o modelo vê, independentemente do tipo de provedor.

- **Rotulagem de operação.** Toda chamada a provedor é rotulada na UI antes de rodar — seja como "chamada de rede de terceiros" (nuvem) ou "chamada local no dispositivo" (local) — para que o usuário sempre saiba para onde seus dados estão indo.

### Transparência de Inferência (Inference Transparency)

Toda decisão automatizada de pós-processamento é exibida na UI de revisão:

- **Anotações de normalização de datas.** Quando `normalizeDate()` converte uma data em linguagem natural para formato ISO (ex.: "Março 2020" → "2020-03"), a tela de revisão do Mapa de Competências mostra o valor original ao lado do resultado normalizado em uma seção "Pós-processamento". Cada transformação também é registrada no log da sessão.

- **Anotações de divisão de competências compostas.** Quando `splitCompoundSkills()` expande uma entrada composta (ex.: "AWS SAM (Python, Lambda)" → "AWS SAM", "Python", "Lambda"), a tela de revisão exibe o que foi dividido para que o usuário possa verificar e substituir.

- **Categorias de competência editáveis.** A categoria atribuída por regex a cada competência (Técnica, Liderança, Comunicação, Domínio, Ferramentas, Competência Essencial) é exibida na revisão do Mapa de Competências com um dropdown para substituí-la. O usuário tem a palavra final sobre como suas competências são categorizadas.

- **Exibição da justificativa de mesclagem.** Quando o Mapeador de Competências normaliza dois termos (ex.: "k8s" → "Kubernetes"), a justificativa da mesclagem é exibida na UI de revisão mostrando o que foi mesclado e por quê. O usuário pode rejeitar qualquer mesclagem com um clique para desfazer.

- **Justificativa de correspondência bullet–cargo.** Na tela de Saída, cada bullet do currículo pode ser expandido para mostrar por que foi colocado sob um determinado cargo — a correspondência é baseada na sobreposição de competências entre os vínculos de evidência do bullet e as tecnologias do cargo (ex.: "Correspondido via sobreposição de competências: Kubernetes, Docker").

- **Clareza do modo AI-only.** Quando o usuário seleciona o modo Somente IA, a UI rotula claramente o que está acontecendo em cada fase: o Mapa de Competências explica que está construindo a partir de dados de carreira extraídos pela IA, a tela de Saída explica que a estrutura do currículo vem de evidências confirmadas com personalização por IA como sugestões orientativas, e a Descoberta de Funções explica que as sugestões são geradas pela IA a partir do mapa de competências confirmado.

## Camadas de armazenamento

Uma única interface `Storage_Adapter` com duas camadas detectadas por capacidade:
- **File System Access** (desktop Chromium) — lê/grava uma pasta local de Markdown realmente selecionada pelo usuário.
- **Fallback** (Safari/Firefox/mobile) — OPFS + IndexedDB com exportação/importação `.zip` de todo o repositório em um clique.

Ambas serializam para a estrutura de diretórios canônica **idêntica**, de modo que o repositório faz ida e volta de forma idêntica entre as camadas.

## Para onde ir em seguida

- [Estrutura do projeto](./project-structure.md) — os módulos e arquivos concretos por trás de cada peça acima.
- [Build e testes](./building-and-testing.md) — como os testes de propriedade e o harness de Não Fabricação impõem esses invariantes.
- [Modos de Execução e implantação](./run-modes-and-deployment.md) — como o mesmo pacote é entregue de três formas sem nunca adicionar um backend.
