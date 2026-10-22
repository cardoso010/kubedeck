# kubedeck

Cliente desktop de Kubernetes, no estilo do Lens: **Tauri 2 + Rust** (`kube-rs`) no backend e **React + TypeScript** na interface.

## Instalar

O repositório é privado, então a instalação usa o GitHub CLI logado com uma conta que tenha acesso a ele.

macOS e Linux:

```bash
gh api repos/cardoso010/kubedeck/contents/scripts/install.sh -H "Accept: application/vnd.github.raw" | bash
```

Windows (PowerShell):

```powershell
gh api repos/cardoso010/kubedeck/contents/scripts/install.ps1 -H "Accept: application/vnd.github.raw" | powershell -NoProfile -Command -
```

No Mac, o script baixa a build da arquitetura certa (Apple Silicon ou Intel) e instala em `/Applications`. No Linux, instala o AppImage em `~/.local/bin` com um atalho no menu de aplicativos (AppImages precisam do FUSE 2, `libfuse2`). No Windows, roda o instalador em modo silencioso. As releases também trazem `.dmg` e `.deb` para instalação manual. Depois disso, o próprio app avisa quando existe uma versão nova e se atualiza com um clique (**Install and restart**, no rodapé da barra lateral). As atualizações são assinadas, e o app recusa pacotes sem uma assinatura válida.

Para receber atualizações, o app precisa de um token do GitHub. Ele usa `GITHUB_TOKEN`/`GH_TOKEN` ou, se elas não existirem, o `gh auth token`. Assim, só quem tem acesso ao repositório recebe atualizações, e nenhum token vai embutido no app.

O app ainda não é assinado com Developer ID nem notarizado. O script de instalação evita o bloqueio do Gatekeeper. Se alguém instalar pelo `.dmg` da release, vai precisar liberar o app uma vez em **Ajustes do Sistema → Privacidade e Segurança**.

## O que faz

- **Visual próprio, com temas.** *Terminal* (padrão: quase preto, fonte mono, acento verde-limão), *Grafite* (cinza-azulado, cantos arredondados, acento violeta) e *Claro*. O editor de YAML e o terminal seguem o tema, e a escolha vale para todas as janelas (ícone de paleta no trilho, ou ⌘K → "Theme").
- **Layout enxuto.** Um trilho fino à esquerda com as seções (Workloads, Network, Config, Cluster, Custom resources, Helm, Port forwards) e os clusters fixados; uma barra em trilha `cluster / namespaces / tipo`; abas com os tipos da seção; detalhes numa gaveta à direita.
- **Paleta de comandos (⌘K / Ctrl+K)** com busca aproximada: pula para qualquer tipo (inclusive CRDs) ou recurso da tabela, troca de cluster ou abre um numa janela nova, escolhe namespaces, troca o tema e roda ações como instalar um chart.
- Lê o `~/.kube/config` (ou `$KUBECONFIG`) e conecta em qualquer contexto, incluindo EKS/GKE via exec plugin. O app herda o `PATH` do shell de login, então `aws`/`gcloud` são encontrados mesmo quando ele é aberto pelo Finder.
- **Várias janelas**: cada janela é independente (cluster, watches, terminais e port forwards próprios), então dá para ver dois clusters lado a lado. Os clusters fixados (ícone de alfinete no seletor de cluster) ficam no trilho: clique troca o cluster da janela, ⌘/Ctrl-clique (ou botão direito) abre numa janela nova, ⌘/Ctrl+1…9 alterna entre eles e ⌘/Ctrl+N abre uma janela vazia. Clusters de produção ficam com anel vermelho.
- **Vários namespaces de uma vez**: o seletor de namespace aceita múltipla escolha (clique no nome seleciona só ele; o checkbox soma à seleção), lembrada por cluster. Pods, métricas e releases Helm seguem a seleção, e a coluna Namespace aparece quando há mais de um.
- Lista em tempo real (*watch*) Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs, Services, Ingresses, ConfigMaps, Secrets, Events, Nodes e Namespaces, com filtro e tabela virtualizada.
- **Custom Resources:** ao conectar, o app lê os CRDs do cluster e os mostra na barra lateral, agrupados por API group e com busca. As colunas são as mesmas do `kubectl get` (`additionalPrinterColumns`).
- **Métricas:** colunas de CPU e memória em Pods e Nodes, com a porcentagem do *allocatable* nos nodes, quando o cluster tem metrics-server. Sem ele, as colunas simplesmente não aparecem.
- Painel de detalhes:
  - **YAML** no Monaco, salvo com `replace`. O `resourceVersion` impede sobrescrever mudanças feitas por outra pessoa.
  - **Logs** em streaming com follow e filtro.
  - **Terminal** (exec com TTY e resize) no container escolhido.
  - **Delete**.
  - **Port forward** de pods e services. Cada porta TCP vira um botão. O service escolhe um pod pronto a cada conexão, então continua funcionando quando os pods são trocados. A tela **Port Forwards** lista os túneis ativos, com o número de conexões e o último erro.
- **Helm Releases:** lista os releases e mostra valores, manifest, notas e histórico, com **rollback** para uma revisão anterior e **uninstall**. **Install chart** busca nos repositórios configurados (os mesmos do `helm repo list`, que podem ser gerenciados ali), escolhe a versão e abre os valores padrão do chart para editar; a aba **Upgrade** de cada release parte dos valores atuais. As duas têm *dry run* (renderiza e valida no servidor sem mudar nada) e a confirmação de produção. O app traz o próprio Helm (3.22.1) embutido como sidecar, então funciona sem nada instalado na máquina. Ele usa sempre o mesmo kubeconfig e contexto do app. Para usar outro binário, defina `KUBEDECK_HELM` com o caminho dele.
- **Proteção de produção:** contextos com `prd`/`prod`/`production` no nome mostram uma faixa vermelha. Salvar, apagar, instalar, fazer upgrade, rollback ou uninstall nesses contextos exige digitar o nome do recurso.

## Desenvolver

```bash
npm install
npm run tauri dev        # app nativo com hot reload
npm run tauri build      # gera src-tauri/target/release/bundle/macos/kubedeck.app
npm run dev              # só a interface, num navegador, com dados de exemplo (src/dev-mock.ts)
```

Antes do `dev` e do `build`, `npm run binaries` baixa o Helm para `src-tauri/binaries/` (fora do git) e confere o SHA-256 fixado em `scripts/fetch-helm.mjs`. Para usar o `cargo` direto (`cargo check`, `cargo test`), rode `npm run binaries` uma vez antes. Para atualizar o Helm, troque a versão e os hashes nesse script, copiando-os das notas do release no GitHub.

As convenções do código e os cuidados para trabalhar no projeto (inclusive com o Claude Code) estão em [CLAUDE.md](CLAUDE.md).

## Testing

Os testes de ponta a ponta rodam contra um cluster **kind descartável**. Eles editam um ConfigMap, apagam um pod e fazem rollback e uninstall de releases Helm, então nunca aponte para um cluster compartilhado. O script cria o cluster com todos os fixtures (workloads em dois namespaces, release Helm, CRD de exemplo e metrics-server) num kubeconfig separado, `.kind-kubeconfig`, sem tocar no `~/.kube/config`:

```bash
npm run binaries
e2e/setup.sh                    # cria ou completa o cluster; e2e/setup.sh --delete remove
cd src-tauri
KUBECONFIG=$PWD/../.kind-kubeconfig KUBEDECK_E2E_CONTEXT=kind-kubedeck-test \
  KUBEDECK_HELM=$PWD/binaries/helm-$(rustc -vV | sed -n 's/host: //p') \
  cargo test -- --include-ignored
```

O CI (`.github/workflows/ci.yml`) roda typecheck, clippy, testes unitários e essa mesma suíte de ponta a ponta num kind dentro do runner, a cada push e pull request.

## Release

```bash
npm run release -- 0.3.0 --push
```

O script confere se a árvore está limpa e na `main`. Depois atualiza a versão em `package.json`, `tauri.conf.json`, `Cargo.toml` e `Cargo.lock`, faz o commit, cria a tag `v0.3.0` e dá push. A tag dispara o workflow **Release**, que:

1. cria uma release em rascunho com as notas geradas a partir dos commits;
2. compila o app para macOS (Apple Silicon e Intel, com `.dmg`), Linux (AppImage e `.deb`) e Windows (instalador NSIS), cada um com o pacote de atualização assinado;
3. gera o `latest.json` que o atualizador lê (`scripts/latest-json.mjs`) e publica a release.

Os apps instalados encontram a versão nova na próxima verificação, que acontece na abertura e depois a cada 6 horas.

Para conferir o empacotamento sem publicar nada, rode o workflow à mão (**Actions → Release → Run workflow**): ele só compila as quatro plataformas e guarda os arquivos como artefatos da execução por 7 dias.

A assinatura das atualizações usa uma chave guardada nos segredos do repositório (`TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Uma cópia está em `~/.tauri/kubedeck.key`, e a senha no Keychain (`kubedeck-updater-key-password`). Sem essa chave não dá para publicar atualizações que os apps instalados aceitem.

## Arquitetura

```
src-tauri/src/
  cluster.rs      contextos do kubeconfig, conexão (inclui a leitura dos CRDs), namespaces
  kinds.rs        tipos nativos e de CRDs, resumo de cada objeto em linha de tabela, JSONPath
  resources.rs    watch genérico (DynamicObject), get/replace YAML, delete
  streams.rs      logs e exec interativo
  portforward.rs  port forward de pods e services (um stream por conexão TCP)
  helm.rs         releases via o Helm embutido
  helm_charts.rs  repositórios, busca de charts, install e upgrade
  metrics.rs      CPU e memória via metrics-server
  updater.rs      atualização automática a partir das releases privadas do GitHub
  windows.rs      janelas novas
  state.rs        uma sessão por janela: conexão e streams ativos (watch/logs/exec/port forward por id)
src/
  api.ts          wrappers tipados dos comandos Rust
  App.tsx         layout, seleção de cluster/namespace/tipo, estado do watch
  App.css         tokens dos temas ([data-theme]) e todo o estilo
  theme.ts        temas, cores do editor e do terminal
  sections.ts     seções do trilho
  components/     trilho, barra superior, abas, paleta ⌘K, tabela, gaveta de detalhes, Helm, port forwards
scripts/          fetch-helm, release, latest-json, install (sh e ps1)
e2e/              cluster kind e fixtures dos testes de ponta a ponta
```

Os eventos de watch, logs e terminal vão do Rust para a interface por `tauri::ipc::Channel`. Cada stream tem um id e é encerrado com `stop_stream`, que a interface chama ao trocar de tela.

## Próximos passos

- Assinatura com Developer ID e notarização da Apple, para instalar pelo `.dmg` sem aviso do Gatekeeper
- Diff entre a revisão atual e o *dry run* no upgrade de charts
- Abas dentro da janela (por exemplo, vários terminais e logs ao mesmo tempo)
- Builds Linux arm64 e Windows arm64
