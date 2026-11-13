import type en from "../en/metrics";
import type { Translation } from "../types";

export default {
  chart: {
    noSamples: "Aún no hay muestras",
    label: "Gráfico de serie temporal",
  },
  pod: {
    request: "request",
    limit: "limit",
    req: "req {{value}}",
    lim: "lim {{value}}",
    ofRequest: "del request",
    ofLimit: "del limit",
    noRequestOrLimit: "sin request ni limit",
    noMetricsServer: "metrics-server no está disponible, así que se desconoce el uso actual.",
    devices: "Dispositivos",
    claimNotCreated: "claim aún no creado",
    notAllocated: "aún sin asignar",
    lookingForPrometheus: "Buscando Prometheus…",
    historyFrom: "Historial de <code>{{target}}</code>",
    live: "En vivo desde que se abrió esta pestaña, cada 10 s. El historial, la red y el throttling necesitan Prometheus en el clúster.",
    cores: "núcleos",
    memory: "Memoria",
    workingSet: "working set",
    network: "Red",
    networkHint: "pod, por segundo",
    throttling: "Throttling de CPU",
    throttlingHint: "fracción de periodos limitados por el limit de CPU",
    sidecar: "sidecar",
    restarts: "Reinicios",
    lastTermination: "Última terminación",
  },
} satisfies Translation<typeof en>;
