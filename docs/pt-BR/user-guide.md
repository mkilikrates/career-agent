# Agente de Carreira — Guia do Usuário

> Leia isto em: [English](../../en/user-guide.md) · **Português** · [← Voltar ao README](../../README.pt-BR.md)

Este guia é para **qualquer pessoa que só quer usar o Agente de Carreira** no próprio computador — sem necessidade de experiência em programação. Vamos passo a passo.

Ao final, você terá o Agente de Carreira rodando no seu navegador, conectado a um **serviço de IA na nuvem** (usando a chave da sua própria conta) ou a um **modelo de IA totalmente local** que roda na sua própria máquina, de modo que nada saia do seu dispositivo.

---

## O que é o Agente de Carreira?

O Agente de Carreira ajuda você a:
- transformar seus currículos, certificados e exportação do LinkedIn em um perfil organizado e baseado em evidências,
- praticar respostas de entrevista usando o método **STAR** (Situação, Tarefa, Ação, Resultado),
- gerar um currículo personalizado nos formatos Markdown, PDF e Word.

**Seus arquivos permanecem no seu computador.** O Agente de Carreira nunca envia seus documentos para um servidor. A única coisa que ele chega a enviar é um pequeno trecho de texto, limpo e tratado, para o serviço de IA que *você* escolher — e somente quando você pedir. Se você usar um modelo de IA local, **nada sai do seu computador**.

---

## Antes de começar: o que você vai precisar

1. **Um computador com Windows ou macOS.**
2. **Um navegador moderno.** Para a melhor experiência (salvar seus dados diretamente em uma pasta do seu computador), use o **Google Chrome** ou o **Microsoft Edge** em um desktop. Safari e Firefox também funcionam, mas você salvará e carregará seus dados usando um arquivo `.zip` baixável.
3. **Um dos seguintes para os recursos de IA:**
   - uma **conta de IA na nuvem** (OpenAI ou Anthropic) onde você possa criar uma chave de API — isso normalmente tem custo por uso, cobrado pelo provedor; **ou**
   - poder computacional suficiente para rodar um **modelo de IA local** (sem conta, sem custo por uso, totalmente privado — mas precisa de uma máquina razoavelmente capaz, idealmente 16 GB de RAM ou mais).

> Você pode instalar e explorar o Agente de Carreira primeiro e decidir a parte da IA depois.

---

## Passo 1 — Instale o Docker Desktop

Vamos rodar o Agente de Carreira usando o **Docker**, uma ferramenta gratuita que empacota o app para que ele "simplesmente rode" da mesma forma em qualquer computador. O **Docker Desktop** é a versão amigável em app, com janela e botões.

### No Windows

1. Acesse o site do Docker: <https://www.docker.com/products/docker-desktop/>.
2. Clique em **Download for Windows**.
3. Abra o instalador baixado (`Docker Desktop Installer.exe`) e siga as instruções. Aceite as opções padrão. Se ele perguntar sobre o **WSL 2**, permita — é obrigatório.
4. Quando terminar, **reinicie o computador** se for solicitado.
5. Abra o **Docker Desktop** pelo menu Iniciar. A primeira inicialização pode levar um minuto. Aceite o contrato de serviço. Você **não** precisa criar uma conta no Docker para usá-lo.
6. Você saberá que está pronto quando o ícone da baleia do Docker na sua barra de tarefas (canto inferior direito) estiver estável (sem animação).

> **Se o Docker Desktop disser que a virtualização está desativada:** pode ser necessário ativá-la nas configurações de BIOS/UEFI do seu computador (geralmente chamada de "Virtualization Technology", "VT-x" ou "SVM"). Pesquise o modelo do seu PC + "enable virtualization" para os passos exatos, ou peça ajuda a quem administra o seu computador.

### No macOS

1. Acesse <https://www.docker.com/products/docker-desktop/>.
2. Clique em **Download for Mac**. Escolha o chip correto:
   - **Apple silicon** (M1/M2/M3/M4) — a maioria dos Macs de 2020 em diante.
   - **Chip Intel** — Macs mais antigos.
   - Não tem certeza? Clique no menu Apple  → **Sobre Este Mac** e veja a linha "Chip" ou "Processador".
3. Abra o `Docker.dmg` baixado e arraste o ícone da baleia **Docker** para a sua pasta **Aplicativos**.
4. Abra o **Docker** em Aplicativos. Aprove as solicitações de permissão que o macOS exibir. Você **não** precisa de uma conta no Docker.
5. Você saberá que está pronto quando o ícone da baleia na barra de menus superior estiver estável.

---

## Passo 2 — Baixe o Agente de Carreira

Você precisa dos arquivos do projeto no seu computador. Duas opções fáceis:

**Opção A — Baixar um ZIP (sem ferramentas extras):**
1. Abra a página do projeto no GitHub no seu navegador.
2. Clique no botão verde **Code** → **Download ZIP**.
3. Descompacte em algum lugar fácil de achar, como a sua pasta **Documentos**. Você terá uma pasta com um nome parecido com `career-agent`.

**Opção B — Se você tem o Git instalado:** clone o repositório com `git clone <repository-url>`.

---

## Passo 3 — Abra um terminal na pasta do projeto

Vamos digitar alguns comandos. Não se preocupe — é só copiar e colar.

- **Windows:** abra a pasta `career-agent` no Explorador de Arquivos. Clique na barra de endereço no topo, digite `powershell` e pressione **Enter**. Uma janela de terminal azul abre já apontada para a pasta.
- **macOS:** abra a pasta `career-agent` no Finder. Clique com o botão direito na pasta → **Novo Terminal na Pasta**. (Se não vir essa opção, abra o app **Terminal**, digite `cd ` — com um espaço — depois arraste a pasta para a janela e pressione **Enter**.)

Para confirmar que o Docker está pronto, digite isto e pressione Enter:

```bash
docker --version
```

Você deve ver um número de versão. Se receber um erro, verifique se o Docker Desktop está aberto e totalmente iniciado e tente novamente.

---

## Passo 4 — Escolha como você quer usar a IA

O Agente de Carreira precisa de um modelo de IA para recursos como sugestões de competências e treino de entrevista. Escolha o caminho que combina com você:

- **Caminho A — IA na nuvem (mais fácil de configurar):** você usa um serviço pago na nuvem (OpenAI ou Anthropic) com sua própria chave. Rápido de começar; você paga o provedor por uso; um pequeno trecho de texto redigido é enviado a eles.
- **Caminho B — IA local (mais privado):** tudo roda no seu próprio computador. Sem conta, sem custo por uso, nada sai da sua máquina. Precisa de um computador capaz e de um download inicial maior.

Você pode começar pelo Caminho A e mudar para o Caminho B depois, ou vice-versa.

---

### Caminho A — Rodar com um provedor de IA na nuvem

1. **Inicie o Agente de Carreira.** No terminal que você abriu no Passo 3, digite:

   ```bash
   docker compose up web
   ```

   Na primeira vez, o Docker baixa e compila o app — isso pode levar alguns minutos. Quando estiver pronto, você verá que ele está "ouvindo" (listening) e a janela continua rodando (isso é normal — deixe-a aberta).

2. **Abra o app.** No seu navegador, acesse:

   ```
   http://localhost:8080
   ```

3. **Obtenha uma chave de API do seu provedor:**
   - **OpenAI:** faça login em <https://platform.openai.com/api-keys>, clique em **Create new secret key** e copie-a.
   - **Anthropic:** faça login em <https://console.anthropic.com/settings/keys>, clique em **Create Key** e copie-a.
   - Mantenha essa chave privada — trate-a como uma senha. Normalmente você precisará adicionar dados de cobrança no site do provedor para a chave funcionar.

4. **Insira sua chave no Agente de Carreira.** Quando o app pedir, cole sua chave. O Agente de Carreira verifica se ela funciona e então a armazena **criptografada, apenas no seu navegador** — nunca nos seus arquivos, nunca em outro lugar. Você pode removê-la a qualquer momento.

5. Tudo pronto — vá para o [Passo 5: Usando o Agente de Carreira](#passo-5--usando-o-agente-de-carreira).

> Para parar o app depois: volte à janela do terminal e pressione **Ctrl + C**, ou clique no botão de parar ao lado do contêiner em execução no Docker Desktop.

---

### Caminho B — Rodar com um modelo de IA totalmente local

Isso roda a IA no seu próprio computador, de modo que **nada sai do seu dispositivo**. Ele baixa um modelo de IA na primeira vez (muitas vezes vários gigabytes), então use uma boa conexão de internet e reserve algum tempo.

1. **Inicie o Agente de Carreira junto com um modelo de chat local.** No terminal:

   ```bash
   docker compose up
   ```

   Isso inicia o app **e** um servidor de modelo local (Ollama), e baixa automaticamente o modelo de chat padrão na primeira vez. O download pode demorar — você pode acompanhar o progresso no Docker Desktop ou no terminal.

2. **(Opcional) Habilite também a transcrição de respostas faladas.** Se você quer *falar* suas respostas de entrevista e tê-las transcritas, inicie a stack com o complemento de voz:

   ```bash
   docker compose --profile stt up
   ```

   Isso inicia adicionalmente um modelo local de fala para texto.

3. **Abra o app** no seu navegador:

   ```
   http://localhost:8080
   ```

4. **Aponte o Agente de Carreira para o seu modelo local.** Na configuração de provedor do app, escolha o provedor **Local (self-hosted)** e use estas configurações:
   - **URL base do chat:** `http://localhost:11434`
   - **URL base de fala para texto** (somente se você o habilitou no passo 2): `http://localhost:8081`
   - **Nomes dos modelos:** use os padrões exibidos, a menos que você os tenha alterado.

   Clique em **Test connection**. Uma mensagem verde de "pronto" significa que está tudo certo.

5. Tudo pronto — continue para o [Passo 5: Usando o Agente de Carreira](#passo-5--usando-o-agente-de-carreira).

### Qual modelo local devo usar?

Modelos maiores são mais inteligentes, mas precisam de mais memória e rodam mais devagar. Escolha um que caiba no seu computador. A regra prática: você quer **alguns GB de memória livre além do tamanho do modelo**, e um modelo roda *muito* mais rápido se o seu computador tiver uma placa de vídeo dedicada (GPU) ou Apple Silicon (M1/M2/M3/M4) — em um notebook antigo sem GPU, fique com os modelos menores.

Para usar um modelo diferente do padrão, defina o nome dele ao iniciar a stack. Por exemplo:

```bash
OLLAMA_MODEL=llama3.2:3b docker compose up
```

| Seu computador | Tente este modelo de chat | Comando | O que esperar |
|---|---|---|---|
| Notebook antigo / de baixo desempenho, ~8 GB de RAM, sem GPU | `llama3.2:3b` (ou `gemma3:4b`) | `OLLAMA_MODEL=llama3.2:3b docker compose up` | Leve e rápido em máquinas modestas; respostas básicas, mas utilizáveis. Ótimo para experimentar. |
| Notebook/desktop comum, ~16 GB de RAM (ou GPU de 8 GB / M1–M2) | `llama3` (8B — o **padrão**) ou `qwen2.5:7b` | `docker compose up` (padrão) | Qualidade geral sólida; o ponto de partida recomendado para a maioria das pessoas. |
| PC gamer com GPU de 12–16 GB, ou Apple Silicon com 16 GB+ | `gemma3:12b` ou `qwen2.5:14b` | `OLLAMA_MODEL=qwen2.5:14b docker compose up` | Um salto perceptível de qualidade; confortável em uma boa GPU. |
| GPU de ponta de 24 GB (RTX 3090/4090) ou Apple Silicon de 32 GB | `qwen2.5:32b` ou `gemma3:27b` | `OLLAMA_MODEL=qwen2.5:32b docker compose up` | Qualidade quase de primeira linha em uma única placa forte. |
| Workstation, 48 GB+ de memória unificada ou duas GPUs de 24 GB | `llama3.3:70b` | `OLLAMA_MODEL=llama3.3:70b docker compose up` | A melhor qualidade disponível localmente; roda mais devagar, mas adequado para uso em diálogo. |

> **Opção mínima/mais rápida:** em uma máquina muito limitada, `llama3.2:1b` é o mais leve de todos (qualidade mais baixa, mas roda em quase qualquer lugar).
>
> O modelo que você escolher **deve coincidir exatamente com a tag baixada, incluindo o sufixo de versão** — digite o nome completo na configuração do provedor Local do app (por exemplo `deepseek-r1:8b`, **não** `deepseek-r1`). Se não coincidir, o app mostra um erro `model '…' not found`, porque o Ollama trata o nome sem sufixo como `:latest`, que não foi baixado. A primeira execução baixa o modelo (modelos pequenos têm ~1–2 GB; os grandes podem ter 20–40 GB), então reserve tempo e espaço em disco. Se um modelo estiver lento ou seu computador ficar sem memória, baixe para o próximo menor. Veja o [guia de modos de execução para desenvolvedores](./developer/run-modes-and-deployment.md#dimensionamento-de-modelos-locais) para os números completos de memória por modelo.

### E o DeepSeek?

Você também pode usar o DeepSeek localmente — os modelos **DeepSeek-R1** (por exemplo `deepseek-r1:8b`, que precisa de aproximadamente a mesma memória que o `llama3`). Duas coisas que vale saber:

- **Ele permanece no seu computador.** Rodá-lo pela stack local significa que o modelo executa na sua própria máquina — nada é enviado aos servidores da DeepSeek.
- **Ele "pensa em voz alta".** O DeepSeek-R1 é um modelo de *raciocínio*: ele mostra seu pensamento passo a passo antes de responder. Isso é interessante de observar, mas pode fazer com que alguns passos guiados do Agente de Carreira (como os acompanhamentos do treino STAR) se comportem de forma imprevisível, porque eles esperam respostas curtas e organizadas. Se um passo der problema, basta voltar para `llama3` ou `qwen2.5` nessas partes. Trate o DeepSeek como algo divertido para experimentar, não como o padrão confiável.

Para testá-lo: `OLLAMA_MODEL=deepseek-r1:8b docker compose up` (e defina o mesmo nome na configuração do provedor Local do app).

### Modelos de fala para texto (somente se você gravar/enviar respostas em áudio)

Se você iniciou a stack com `--profile stt`, um modelo Whisper local transcreve suas respostas faladas. O padrão é `whisper-1`. Para alterá-lo, defina `LOCALAI_STT_MODEL` ao iniciar:

```bash
LOCALAI_STT_MODEL=whisper-base docker compose --profile stt up
```

| Modelo Whisper | Download aprox. | Bom para |
|---|---|---|
| `whisper-base` | ~150 MB | Rápido, baixa memória; adequado para inglês claro. |
| `whisper-small` | ~500 MB | Melhor precisão, ainda leve. |
| `whisper-medium` | ~1.5 GB | Precisão forte, incl. outros idiomas. |
| `whisper-large` | ~3 GB | Melhor precisão; precisa de mais memória e tempo. |

Modelos de transcrição são bem menores que os de chat e rodam confortavelmente na maioria dos computadores.

---

## Passo 5 — Usando o Agente de Carreira

O Agente de Carreira conduz você por seis passos (ele salva seu progresso automaticamente, então você pode parar e voltar quando quiser):

1. **Adicione seus documentos** — envie seu currículo, certificados ou exportação do LinkedIn, ou cole texto. Tudo é lido no seu computador. Você pode **pré-visualizar o texto convertido** de cada documento para verificar se ele veio corretamente; se um arquivo parecer corrompido, remova-o e cole o texto.
2. **Mapa de Competências** — o Agente de Carreira monta uma lista das suas competências, cada uma ligada ao local onde encontrou a evidência. Você revisa e confirma.
3. **Descoberta de Funções** — receba funções sugeridas que combinam com suas competências, com as lacunas destacadas.
4. **Treinamento para Entrevista** — pratique respostas STAR. Você pode **digitar**, **enviar um arquivo de áudio** ou **gravar a si mesmo** no navegador. A IA verifica se sua resposta está completa e faz perguntas de acompanhamento — usando apenas as suas próprias palavras.
5. **Geração de Saída** — gere um currículo personalizado em Markdown, PDF e Word, além de sugestões consultivas do LinkedIn.
6. **Memória e Manutenção** — exporte ou faça backup dos seus dados.

### Uma nota sobre privacidade enquanto você usa

- Sempre que o Agente de Carreira estiver prestes a enviar algo a um provedor na nuvem, ele primeiro mostra um **rótulo** avisando.
- Você pode **pré-visualizar o texto exato** prestes a ser enviado e editar ou excluir qualquer conteúdo que não queira compartilhar antes que ele saia.
- Qualquer coisa que você marcar como **privada** nunca é enviada a um provedor na nuvem.
- Com um modelo local selecionado, o app informa que está **totalmente offline**.

### Onde seus dados são salvos

- **Chrome / Edge no desktop:** você pode escolher uma pasta real no seu computador, e o Agente de Carreira salva seu perfil ali como arquivos Markdown legíveis dos quais você é totalmente dono.
- **Outros navegadores:** seus dados ficam armazenados dentro do navegador. Use o botão **Exportar** para salvar um backup `.zip`, e **Importar** para restaurá-lo depois ou movê-lo para outro computador.

---

## Solução de problemas

**O app não abre em `http://localhost:8080`.**
Verifique se o Docker Desktop está em execução e se o comando `docker compose up` ainda está rodando no seu terminal (a janela deve permanecer aberta). Dê um minuto na primeira inicialização.

**"port is already allocated" ou "address already in use".**
Algo mais está usando a porta 8080 (ou 11434 / 8081). Feche o outro programa, ou pare quaisquer contêineres antigos do Agente de Carreira pelo painel do Docker Desktop, e tente novamente.

**O modelo local está muito lento ou fica sem memória.**
A IA local precisa de uma máquina capaz. Tente um modelo menor (veja o [guia de modos de execução](./developer/run-modes-and-deployment.md)), feche outros apps pesados, ou use o caminho do provedor na nuvem.

**"Could not reach the local server" ao testar o provedor local.**
Confirme que você iniciou a stack com `docker compose up` (não apenas `web`), que o modelo terminou de baixar, e que você usou os endereços `http://localhost:...` acima — e não outros nomes.

**Minha chave de API é rejeitada.**
Verifique se você copiou a chave inteira, se ela não foi revogada e se a cobrança está configurada no site do provedor.

**Como paro tudo?**
Pressione **Ctrl + C** no terminal, ou use os botões de parar no Docker Desktop. Seus dados salvos não são afetados.

---

## Perguntas frequentes

**Isso custa dinheiro?**
O app em si é gratuito e de código aberto (licenciado sob MIT). Se você usar um provedor na **nuvem**, esse provedor cobra pelo uso. Se você usar um modelo **local**, não há custo por uso.

**Meus dados são realmente privados?**
Seus documentos nunca saem do seu computador. Com um provedor na nuvem, apenas um pequeno trecho redigido é enviado quando você pede um recurso de IA, e você pode pré-visualizá-lo antes. Com um modelo local, nada sai do seu dispositivo.

**Preciso manter o terminal aberto?**
Sim, enquanto estiver usando o app. Fechá-lo para o app (seus dados salvos permanecem seguros). Reabra-o a qualquer momento com o mesmo comando `docker compose up`.

**Posso mover meu perfil para outro computador?**
Sim — use **Exportar** para salvar um `.zip`, copie-o para o outro lado e **Importe**-o na outra máquina (ou simplesmente aponte o Chrome/Edge para a mesma pasta sincronizada).
