# Modos de Execução e Implantação

> Leia isto em: [English](../../en/developer/run-modes-and-deployment.md) · **Português** · [← Voltar ao README](../../../README.pt-BR.md) · Documentação para desenvolvedores: [Arquitetura](./architecture.md) · [Estrutura do projeto](./project-structure.md) · [Build e testes](./building-and-testing.md) · **Modos de Execução e implantação**

O Agente de Carreira roda o mesmo app de navegador de três formas. Em **todos** os modos, ele é um pacote estático rodando no navegador — **não há backend de aplicação**, e o Repositório de Memória sempre permanece no navegador. A camada de empacotamento só muda *como os assets estáticos são servidos*; ela nunca introduz um backend de dados ou de aplicação, e a fronteira de saída (Portão de Saída único, mesmos destinos permitidos) é idêntica nas três.

> Esta é a referência voltada ao operador. Para a versão amigável, clique a clique (instalar o Docker Desktop, etc.), aponte os usuários não técnicos para o [Guia do Usuário](../user-guide.md).

## 1. Build local a partir do código-fonte

Rode a partir do código-fonte com o toolchain do Node (veja [Build e testes](./building-and-testing.md)):

```bash
npm install
npm run dev        # Vite dev server, e.g. http://localhost:5173

# or build and serve the static bundle:
npm run build      # outputs the self-contained dist/
npm run preview    # serve dist/ to verify
```

A origem servida é o que o Vite imprimir (comumente `http://localhost:5173`). Adequado para desenvolvimento e para hospedar `dist/` em qualquer host estático.

## 2. Contêiner único estático com Docker

Um contêiner único e mínimo que serve o pacote estático. O `Dockerfile` raiz é multi-estágio: um estágio Node roda `npm ci` + `npm run build`, e então o estágio de runtime é o `nginxinc/nginx-unprivileged` servindo **apenas** o `dist/` compilado na porta **8080** como um usuário **não-root** (UID 101). A imagem de runtime não contém código-fonte da aplicação, nem `node_modules`, nem runtime do Node — apenas o pacote estático e a configuração SPA `try_files` em `docker/nginx.conf`.

```bash
docker build -t career-agent .
docker run -p 8080:8080 career-agent
```

Abra `http://localhost:8080`. Este contêiner é **somente estático** — sem backend, sem dados, sem servidor de modelo. Para usar qualquer recurso de LLM/STT, aponte o app para um provedor BYOK na nuvem ou para o seu próprio provedor local.

### Usando a imagem publicada pré-compilada

Uma imagem multi-arquitetura (`linux/amd64` + `linux/arm64`) é publicada automaticamente no **GitHub Container Registry** pelo workflow [`docker-publish.yml`](../../../.github/workflows/docker-publish.yml), então você pode executá-la sem compilar localmente:

```bash
# build mais recente do branch padrão
docker run -p 8080:8080 ghcr.io/<owner>/<repo>:latest

# uma versão de release fixada
docker run -p 8080:8080 ghcr.io/<owner>/<repo>:1.2.3
```

Substitua `<owner>/<repo>` pelo caminho real do repositório. Tags disponíveis:

| Tag | Publicada quando | Usar para |
|---|---|---|
| `latest` | todo push para `main` | o build mais recente (contínuo) |
| `sha-<commit>` | todo push para `main` | fixar um commit exato |
| `X.Y.Z`, `X.Y`, `X` | ao enviar uma tag git `vX.Y.Z` | releases fixos e imutáveis |

### Fluxo de release (criando uma nova versão)

O CI publica uma imagem nova a **cada push para `main`** (como `latest`) e uma imagem versionada em uma **tag git semver**. Para criar um release:

1. Atualize o spec, os prompts e a documentação (todos os idiomas) conforme o [`AGENTS.md`](../../../AGENTS.md), e incremente a `version` no `package.json` (e o `CHANGELOG.md`, se existir).
2. Faça o commit, depois crie e envie uma tag: `git tag v1.2.3 && git push origin v1.2.3`.
3. O workflow roda typecheck + testes, depois compila e envia as tags de imagem `1.2.3` / `1.2` / `1`. Os testes barram a publicação — uma suíte com falha bloqueia a imagem.
4. Em uma tag de versão, o workflow também **cria um GitHub Release** para `vX.Y.Z` com notas geradas automaticamente (a partir de PRs/commits mesclados) mais o comando `docker run` para baixar aquela versão.

> **Visibilidade do pacote:** publicada a partir de um repositório **público**, a imagem herda a visibilidade do repositório e é **pública** — pode ser baixada anonimamente (`docker pull` sem login). Para confirmar, faça logout (`docker logout ghcr.io`) e baixe. Se em algum momento o pacote estiver privado, altere em **Package settings → Change visibility → Public** na página do pacote. O workflow precisa da permissão `packages: write`, concedida diretamente no workflow.

### Mantendo o armazenamento do registro sob controle

O armazenamento do ghcr conta na cota da sua conta, e uma tag `sha-<commit>` a cada push para `main` (além dos manifestos multi-arquitetura) se acumula com o tempo. O workflow [`cleanup-packages.yml`](../../../.github/workflows/cleanup-packages.yml) roda **semanalmente** (e sob demanda via *Run workflow*) para recuperar espaço:

- **Imagens sem tag (untagged)** com mais de uma semana são excluídas automaticamente usando o token embutido. Isso nunca remove uma tag `latest`, `sha-*` ou de release (`X.Y.Z`), e os filhos multi-arquitetura das tags mantidas são protegidos automaticamente.
- **Opcional — limitar as tags `sha-`:** adicione um Personal Access Token clássico com o escopo `packages:delete` como um segredo de repositório chamado `GHCR_CLEANUP_TOKEN`. Quando presente, o workflow também poda tags `sha-*` antigas (mantendo as 10 mais recentes), sem tocar em `latest` nem em qualquer tag de release. Sem o segredo, esta etapa é ignorada.

Execute-o manualmente primeiro com **dry run** ativado para pré-visualizar o que seria excluído. Versões excluídas têm uma janela de restauração de 30 dias no GitHub.

## 3. Stack local completa com Docker Compose

O `docker-compose.yml` raiz sobe o app ao lado de servidores de modelo totalmente locais e sem chave:

```bash
docker compose up                 # starts web + ollama (chat)
docker compose --profile stt up   # additionally starts the LocalAI/whisper STT service
```

| Serviço | Iniciado | O navegador o acessa em | Finalidade |
|---|---|---|---|
| `web` | sempre | `http://localhost:8080` | o app estático (compilado a partir do `Dockerfile`) |
| `ollama` | sempre | `http://localhost:11434` | servidor de **chat** compatível com OpenAI, sem chave |
| `ollama-pull` | sempre (roda uma vez, depois sai) | — | baixa o modelo de chat para o Ollama, depois para |
| `localai` | apenas com `--profile stt` | `http://localhost:8081` | servidor de **fala para texto** (Whisper) compatível com OpenAI |
| `localai-pull` | apenas com `--profile stt` (roda uma vez, depois sai) | — | baixa o modelo de STT Whisper, depois para |

Configure o **provedor Local** no app com as URLs base de localhost publicadas no host — chat `http://localhost:11434`, STT `http://localhost:8081`.

### Baixando / trocando modelos

A imagem `ollama` **não embarca modelos**, então o serviço de vida curta `ollama-pull` espera o servidor ficar saudável, baixa o modelo de chat e sai. O download cai no volume `ollama_models`, então acontece apenas uma vez. O padrão é **`llama3`** (correspondendo ao modelo de chat padrão do provedor Local do app). Para sobrescrevê-lo:

```bash
OLLAMA_MODEL=llama3.2:3b docker compose up
```

…ou edite a linha `${OLLAMA_MODEL:-llama3}` no `docker-compose.yml`. O que você baixar **deve coincidir** com o nome do modelo de chat que você insere na configuração do provedor Local do app. Acompanhe o progresso com `docker compose logs -f ollama-pull`.

Os modelos de fala para texto funcionam da mesma forma sob `--profile stt`: o `localai-pull` instala o modelo Whisper em `localai_models` antes que o servidor de STT inicie. Padrão **`whisper-1`**; sobrescreva com `LOCALAI_STT_MODEL` ou editando o `docker-compose.yml`.

### Dimensionamento de modelos locais

Pegadas de memória aproximadas para modelos de chat Ollama comuns em **Q4_K_M** (a quantização padrão do Ollama). "Memória mínima para rodar" é o tamanho do arquivo do modelo mais ~1–1.5 GB de sobrecarga (cache KV em um contexto curto de ~2K); contextos mais longos somam mais (cerca de +0.5 GB por 2K tokens para um modelo de 7–8B, mais para modelos maiores). Os modelos rodam mais rápido **inteiramente na VRAM da GPU ou na memória unificada do Apple Silicon**; se transbordarem para a RAM do sistema (inferência por CPU), espere que ainda funcionem, mas gerem várias vezes mais devagar.

| Modelo (tag `ollama`) | Parâmetros | Tamanho Q4_K_M | Memória mínima para rodar | Roda confortavelmente em | Notas para o Agente de Carreira |
|---|---|---|---|---|---|
| `llama3.2:1b` | 1.2B | ~0.8 GB | ~2 GB | quase qualquer coisa | Mais rápido/leve; qualidade mais baixa. Bom para testar o caminho local. |
| `llama3.2:3b` | 3.2B | ~1.9 GB | ~3 GB | 8 GB de RAM, sem GPU | Utilizável em máquinas modestas somente-CPU. |
| `gemma3:4b` | 3.9B | ~2.5 GB | ~3.5 GB | 8 GB de RAM / GPU de 4 GB | Forte para o seu tamanho. |
| `phi4-mini` | 3.8B | ~2.3 GB | ~3.5 GB | 8 GB de RAM / GPU de 4 GB | Melhor raciocinador minúsculo; bom em tarefas estruturadas. |
| `qwen2.5:7b` | 7.6B | ~4.4 GB | ~5.5 GB | GPU de 8 GB / 16 GB de RAM | Forte em seguir instruções. |
| `llama3` (8B) | 8.0B | ~4.9 GB | ~6 GB | GPU de 8 GB / 16 GB de RAM | **Padrão do app.** Melhor ponto de partida geral. |
| `qwen3:8b` | 8.2B | ~5.0 GB | ~6.5 GB | GPU de 8 GB / 16 GB de RAM | Mais novo; híbrido think/no-think, chamada de ferramentas nativa. |
| `gemma3:12b` | 12.2B | ~7.3 GB | ~8.5 GB | GPU de 12 GB | Excelente em seguir instruções para o seu tamanho. |
| `qwen2.5:14b` | 14.8B | ~8.7 GB | ~10 GB | GPU de 12–16 GB | Grande salto de qualidade sobre 7–8B. |
| `phi4` | 14.0B | ~8.2 GB | ~9.5 GB | GPU de 12 GB | Forte em raciocínio/análise. |
| `gemma3:27b` | 27.2B | ~15.9 GB | ~17 GB | GPU de 24 GB (16 GB no limite) / Apple Silicon de 32 GB | Qualidade próxima a 70B. |
| `qwen2.5:32b` | 32.5B | ~18.8 GB | ~20 GB | GPU de 24 GB | Ponto ideal para uma única GPU de consumo de alto nível. |
| `llama3.3:70b` | 70.6B | ~40 GB | ~42 GB | 48 GB+ unificada / duas GPUs de 24 GB | Qualidade local de primeira linha; ~12 tok/s em um M4 Max. Não cabe em uma única GPU de 24 GB. |

#### DeepSeek-R1 (modelos de raciocínio)

Os modelos da DeepSeek que rodam localmente no Ollama são os **distilados R1**, destilados em arquiteturas Qwen/Llama — então a pegada de memória de cada um **equivale ao seu modelo base** na tabela acima:

| Modelo (tag `ollama`) | Destilado de | Tamanho Q4_K_M | Memória mínima para rodar |
|---|---|---|---|
| `deepseek-r1:1.5b` | Qwen 2.5 1.5B | ~1.0 GB | ~2 GB |
| `deepseek-r1:7b` | Qwen 2.5 7B | ~4.4 GB | ~5.5 GB |
| `deepseek-r1:8b` | Llama 3.1 8B | ~4.9 GB | ~6 GB |
| `deepseek-r1:14b` | Qwen 2.5 14B | ~8.7 GB | ~10 GB |
| `deepseek-r1:32b` | Qwen 2.5 32B | ~18.8 GB | ~20 GB |
| `deepseek-r1:70b` | Llama 3.3 70B | ~40 GB | ~42 GB |

**Duas coisas para saber antes de escolher o R1 para o Agente de Carreira:**

- **Ele roda totalmente localmente.** Baixado pelo Ollama, os pesos executam na sua máquina; nada é enviado aos servidores da DeepSeek. (O Agente de Carreira não conecta a API de *nuvem* da DeepSeek — os provedores de nuvem com chave são apenas OpenAI e Anthropic.)
- **Ele é um modelo de raciocínio, e isso conflita com nossos passos de saída estrita.** O R1 emite uma cadeia de pensamento (frequentemente envolvida em `<think>…</think>`) mais tokens extras de "pensamento" antes da sua resposta. Vários fluxos do Agente de Carreira analisam **respostas exatas e estruturadas** — o laço adaptativo de treino STAR (`SITUATION/TASK/ACTION/RESULT: covered|missing`, `ENOUGH: yes|no`, `FOLLOWUP: …`), perguntas marcadas por competência (`<competency> :: <question>`) e a análise de nomes de competência. Um preâmbulo de raciocínio verboso pode ser mal interpretado (por exemplo, texto de raciocínio captado como "competências", ou uma linha de acompanhamento perdida). Mitigações: use um build recente do Ollama que remova ou separe os tokens de pensamento, e reserve mais tokens de saída. Para os passos estruturados de treino/descoberta, um modelo **instruct** simples (`llama3`, `qwen2.5`) é o padrão mais seguro; o R1 é melhor tratado como experimental aqui.

Fala para texto (LocalAI / Whisper, apenas sob `--profile stt`):

| Modelo (`LOCALAI_STT_MODEL`) | Tamanho aprox. | Notas |
|---|---|---|
| `whisper-base` | ~150 MB | Rápido, baixa memória; adequado para inglês claro. |
| `whisper-small` | ~500 MB | Melhor precisão, ainda leve. |
| `whisper-medium` | ~1.5 GB | Forte precisão multilíngue. |
| `whisper-large` | ~3 GB | Melhor precisão; mais memória/tempo. |

Dicas de dimensionamento:
- **Estime qualquer modelo:** `FP16 ≈ params(B) × 2 GB`; `Q4_K_M ≈ FP16 × ~0.3`; memória mínima ≈ tamanho Q4_K_M + ~1 GB.
- **Contextos longos custam memória.** A assistência de IA do Agente de Carreira envia corpora em pedaços; se você atingir falta de memória em um modelo que "deveria caber", reduza o contexto (`num_ctx`) ou defina `OLLAMA_KV_CACHE_TYPE=q8_0` para reduzir aproximadamente pela metade o cache KV.
- **Na dúvida, diminua.** Um modelo menor com um contexto confortável vence um maior que transborda constantemente para a CPU.
- Sempre verifique a tag exata e o tamanho atual na [biblioteca oficial do Ollama](https://ollama.com/library) antes de baixar — a lista e os tamanhos de quantização mudam com frequência.

> Os números de pegada acima são valores Q4_K_M aproximados, compilados a partir da [biblioteca do Ollama](https://ollama.com/library) e de referências públicas de hardware (por exemplo, a [tabela de RAM/VRAM do Ollama](https://localaimaster.com/blog/ollama-model-ram-vram-table) do Local AI Master, 2026); eles foram reescritos e reformatados para este guia e vão variar conforme os modelos são atualizados.

## Rede e CORS

Isto importa sempre que o navegador conversa com um servidor de modelo ou um provedor na nuvem.

### Use portas publicadas no host, não nomes de serviço do Compose

Na stack do Compose, o **navegador roda no host**, fora da rede do Compose. Ele só consegue alcançar um servidor de modelo via a **porta publicada no host** desse servidor (um endereço `localhost`). Um nome de serviço interno do Compose resolve apenas de contêiner para contêiner e é inalcançável pelo navegador — então o app **rejeita** uma URL base desse tipo, com orientação para usar um endereço publicado no host.

```
✅  http://localhost:11434   (chat)        ✅  http://localhost:8081   (STT)
❌  http://ollama:11434       (rejected)    ❌  http://localai:8080      (rejected)
```

### Origens permitidas (a origem servida deve ser permitida)

Quando o app chama um servidor de modelo local de outra origem (cross-origin), o servidor deve permitir a origem **exata** do app (esquema + host + porta). O arquivo do Compose configura isso:

- **Ollama** — `OLLAMA_ORIGINS=http://localhost:8080`
- **LocalAI** — `CORS=true`, `CORS_ALLOW_ORIGINS=http://localhost:8080`

A origem deve corresponder a onde quer que o app seja servido: `http://localhost:5173` no desenvolvimento local a partir do código-fonte, `http://localhost:8080` nos modos contêiner/Compose. Se uma requisição for rejeitada por motivos de origem, o app exibe uma dica de origens permitidas e preserva a sua configuração de provedor.

Para um provedor local **executado pelo usuário** fora do Compose (por exemplo, Ollama instalado nativamente), defina você mesmo o mesmo env antes de iniciar o servidor, por exemplo `OLLAMA_ORIGINS="http://localhost:5173" ollama serve`.

### CORS de provedor na nuvem

As chamadas a provedores são cross-origin a partir do navegador. A OpenAI permite CORS direto do navegador. **A Anthropic exige o cabeçalho `anthropic-dangerous-direct-browser-access: true`**, que o cliente HTTP de provedor define. Chamar um provedor a partir do navegador expõe a *sua própria* chave ao JS daquela página — aceitável em um app local-first BYOK, mas rode o Agente de Carreira apenas a partir de fontes em que você confia.

### Cabeçalhos de hospedagem

Nenhum cabeçalho especial é exigido para o conjunto atual de dependências. O diagramador de PDF Typst empacotado roda em thread única, então **não** é necessário `SharedArrayBuffer` / isolamento cross-origin. O `.wasm` do compilador Typst, de ~20 MB, é empacotado como um asset local e carregado de forma preguiçosa no primeiro uso — nunca de um CDN — preservando a garantia local-first.

## O Repositório de Memória é de propriedade do navegador em todos os modos

Quer você rode a partir do código-fonte, do contêiner estático ou da stack completa do Compose, os dados de carreira do usuário vivem no navegador dele — gravados pela camada File System Access (desktop Chromium) ou pela camada de Fallback (OPFS/IndexedDB + `.zip`). **Nenhum** contêiner ou servidor os armazena. Deliberadamente **não há volume do Repositório de Memória nem bind mount no host** em nenhum lugar da stack; os volumes nomeados do Compose (`ollama_models`, `localai_models`) guardam **apenas** os arquivos de modelo baixados, para que sobrevivam a reinícios.

## Navegadores recomendados

Para a experiência completa — incluindo a camada File System Access que grava em uma pasta local real, sem exportação/importação manual — use um **navegador desktop baseado em Chromium (Chrome, Edge)**. Outros navegadores desktop e todos os navegadores mobile usam a **camada de Fallback** (OPFS/IndexedDB) com exportação/importação `.zip` em um clique, para que os dados permaneçam portáteis.

## Verificação (implantação)

Estas são questões de empacotamento/configuração, verificadas por testes de smoke/integração em vez de testes de propriedade: a imagem de runtime contém apenas `dist/` (sem código-fonte/toolchain), o nginx roda como não-root em uma porta ≥ 1024, o caminho raiz retorna `index.html` sem processamento da aplicação, `docker compose up` inicia `web` + `ollama` por padrão e `localai` apenas com `--profile stt`, e os volumes declarados são apenas de modelo, sem montagem do Repositório de Memória. A fronteira de saída entre modos reutiliza a propriedade de correção de fronteira de saída existente.
