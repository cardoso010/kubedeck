# kubedeck

Cliente desktop de Kubernetes, no estilo do Lens: **Tauri 2 + Rust** (`kube-rs`) no backend e **React + TypeScript** na interface.

## O que o MVP faz

- Lê o `~/.kube/config` (ou `$KUBECONFIG`) e conecta em qualquer contexto, incluindo EKS/GKE via exec plugin. O app herda o `PATH` do shell de login, então `aws`/`gcloud` são encontrados mesmo quando ele é aberto pelo Finder.
- Lista em tempo real (*watch*) Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs, Services, Ingresses, ConfigMaps, Secrets, Events, Nodes e Namespaces, com filtro e tabela virtualizada.
- Painel de detalhes:
  - **YAML** no Monaco, salvo com `replace`. O `resourceVersion` impede sobrescrever mudanças feitas por outra pessoa.
  - **Logs** em streaming com follow e filtro.
  - **Terminal** (exec com TTY e resize) no container escolhido.
  - **Delete**.
- **Proteção de produção:** contextos com `prd`/`prod`/`production` no nome mostram uma faixa vermelha. Salvar ou apagar nesses contextos exige digitar o nome do recurso.

## Rodar

```bash
npm install
npm run tauri dev        # app nativo com hot reload
npm run tauri build      # gera src-tauri/target/release/bundle/macos/kubedeck.app (~11 MB)
```

`npm run dev` num navegador comum abre só a interface, com dados de exemplo (`src/dev-mock.ts`).

## Testing

O teste de ponta a ponta do backend roda contra um cluster **descartável**. Ele edita um ConfigMap e apaga um pod, então nunca aponte para um cluster compartilhado.

```bash
kind create cluster --name kubedeck-test --kubeconfig .kind-kubeconfig
export KUBECONFIG=$PWD/.kind-kubeconfig
kubectl create ns demo
kubectl -n demo create deployment web --image=nginx:1.27-alpine --replicas=3
kubectl -n demo expose deployment web --port=80
kubectl -n demo create configmap app-config --from-literal=LOG_LEVEL=debug --from-literal=FEATURE_X=true
kubectl -n demo run ticker --image=busybox:1.36 -- sh -c 'i=0; while true; do i=$((i+1)); echo "tick $i"; sleep 1; done'
kubectl -n demo run broken --image=busybox:1.36 -- sh -c 'echo boom; exit 1'
cd src-tauri && KUBEDECK_E2E_CONTEXT=kind-kubedeck-test cargo test -- --ignored
```

## Arquitetura

```
src-tauri/src/
  cluster.rs    contextos do kubeconfig, conexão, namespaces
  kinds.rs      tipos suportados e resumo de cada objeto em linha de tabela
  resources.rs  watch genérico (DynamicObject), get/replace YAML, delete
  streams.rs    logs e exec interativo
  state.rs      cliente atual e streams ativos (watch/logs/exec por id)
src/
  api.ts        wrappers tipados dos comandos Rust
  App.tsx       layout, seleção de cluster/namespace/tipo, estado do watch
  components/   ResourceTable, DetailsPanel, YamlEditor, LogsView, TerminalView
```

Os eventos de watch, logs e terminal vão do Rust para a interface por `tauri::ipc::Channel`. Cada stream tem um id e é encerrado com `stop_stream`, que a interface chama ao trocar de tela.

## Próximos passos

- Port-forward
- Helm (releases e charts), chamando o binário `helm` como sidecar
- CRDs via discovery da API, em vez da lista fixa em `kinds.rs`
- Métricas (metrics-server/Prometheus) nos pods e nodes
- Várias abas ou janelas e hotbar de clusters
