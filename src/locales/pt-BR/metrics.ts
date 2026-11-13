import type en from "../en/metrics";
import type { Translation } from "../types";

export default {
  chart: {
    noSamples: "Ainda sem amostras",
    label: "Gráfico de série temporal",
  },
  pod: {
    request: "request",
    limit: "limit",
    req: "req {{value}}",
    lim: "lim {{value}}",
    ofRequest: "do request",
    ofLimit: "do limit",
    noRequestOrLimit: "sem request nem limit",
    noMetricsServer: "O metrics-server não está disponível, então o uso atual é desconhecido.",
    devices: "Dispositivos",
    claimNotCreated: "claim ainda não criado",
    notAllocated: "ainda não alocado",
    lookingForPrometheus: "Procurando o Prometheus…",
    historyFrom: "Histórico de <code>{{target}}</code>",
    live: "Ao vivo desde que esta aba abriu, a cada 10s. Histórico, rede e throttling precisam do Prometheus no cluster.",
    cores: "cores",
    memory: "Memória",
    workingSet: "working set",
    network: "Rede",
    networkHint: "pod, por segundo",
    throttling: "Throttling de CPU",
    throttlingHint: "fração dos períodos limitada pelo limit de CPU",
    sidecar: "sidecar",
    restarts: "Restarts",
    lastTermination: "Último término",
  },
} satisfies Translation<typeof en>;
