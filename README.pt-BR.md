# Agente de Carreira

[![Build & publish](https://github.com/mkilikrates/career-agent/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/mkilikrates/career-agent/actions/workflows/docker-publish.yml)
[![Versão mais recente](https://img.shields.io/github/v/release/mkilikrates/career-agent)](https://github.com/mkilikrates/career-agent/releases/latest)
[![Licença: MIT](https://img.shields.io/github/license/mkilikrates/career-agent)](./LICENSE)
[![Imagem do contêiner](https://ghcr-badge.egpl.dev/mkilikrates/career-agent/latest_tag?trim=major&label=ghcr.io)](https://github.com/mkilikrates/career-agent/pkgs/container/career-agent)

> Leia isto em: [English](./README.md) · **Português (Brasil)**

Um **web app de navegador local-first** que constrói um perfil profissional baseado em evidências, treina respostas de entrevista no formato STAR e gera materiais de candidatura compatíveis com ATS (Markdown, PDF, DOCX).

A promessa central é a **confiança**: seus arquivos nunca saem do seu dispositivo, e toda afirmação em toda saída gerada é rastreável até uma citação de origem ou uma confirmação explícita feita por você (a **Regra de Não Fabricação** — No-Fabrication Rule). O único tráfego de rede são chamadas iniciadas por você, no modelo **Traga Sua Própria Chave (BYOK — Bring-Your-Own-Key)**, ao provedor de LLM / transcrição de voz que você escolher — e apenas uma carga mínima, com PII redigida, é enviada. Com um provedor de modelo local selecionado, o app fica **totalmente offline**.

**Não existe servidor de backend.** Toda a análise, mapeamento de competências, diagramação e persistência rodam no seu dispositivo em TypeScript + WebAssembly.

---

## Documentação

A documentação é dividida por quem você é. Comece por aqui:

### 📘 Eu só quero usar — [Guia do Usuário](./docs/pt-BR/user-guide.md)
Um passo a passo não técnico: instale o Docker Desktop (Windows ou macOS), rode o Agente de Carreira na sua própria máquina e conecte-o a um provedor de IA na nuvem (com sua própria chave) ou a um modelo totalmente local — sem necessidade de domínio do terminal.

### 🛠️ Quero entender ou contribuir com o código — Documentação para Desenvolvedores
- [Arquitetura e modelo de confiança](./docs/pt-BR/developer/architecture.md) — como funciona, o Portão de Saída (Egress Gate), o pipeline de seis fases e a Regra de Não Fabricação.
- [Estrutura do projeto](./docs/pt-BR/developer/project-structure.md) — a organização `@core` / `@adapters` / `@ui` e os módulos e arquivos principais.
- [Build e testes](./docs/pt-BR/developer/building-and-testing.md) — compilar a partir do código-fonte, os scripts npm e as suítes de teste de unidade / propriedade / Não Fabricação.
- [Modos de Execução e implantação](./docs/pt-BR/developer/run-modes-and-deployment.md) — as três formas de rodar (código-fonte, contêiner único, stack local completa), além de rede e CORS.
- [Como contribuir](./CONTRIBUTING.md) · [Política de segurança](./SECURITY.md)

---

## Em resumo

- **Local-first, sem backend** — um pacote estático que roda inteiramente no seu navegador.
- **Traga Sua Própria Chave** — funciona com OpenAI ou Anthropic usando a *sua* chave, ou com um servidor de modelo local sem chave (Ollama, LocalAI, LM Studio, llama.cpp, vLLM).
- **Confiança por construção** — um único Portão de Saída (Egress Gate) é o único caminho até qualquer provedor; ele rotula a chamada, faz a triagem de PII/segredos e envia apenas uma carga minimizada e redigida. Nada é jamais fabricado nas suas saídas sem uma origem rastreável.
- **Você é dono dos seus dados** — o Repositório de Memória é Markdown legível por humanos, gravado em uma pasta local (desktop Chromium) ou exportável como um `.zip` (outros navegadores).
- **Saídas compatíveis com ATS** — Markdown, PDF de coluna única com texto selecionável (diagramado localmente via Typst/WebAssembly) e DOCX estruturado.

## Licença

Licenciado sob a **MIT License** — veja [`LICENSE`](./LICENSE). Você pode usar, modificar e distribuir este software (inclusive comercialmente); a única condição é que o aviso de copyright e de permissão sejam mantidos. Copyright (c) 2026 mkilikrates (https://kilikrates.io/).
