import type en from "../en/nodes";
import type { Translation } from "../types";

export default {
  cordoned: "Em cordon: nenhum pod novo é agendado aqui.",
  schedulable: "Agendável",
  cordon: "Cordon",
  uncordon: "Uncordon",
  cordonTitle: "Fazer cordon de {{name}}?",
  cordonMessage: "Nenhum pod novo será agendado neste node de {{cluster}}. Os pods que já estão nele continuam rodando.",
  drain: "Drain",
  drainEllipsis: "Drain…",
  drainTitle: "Fazer drain de {{name}}?",
  drainMessage: "O node recebe cordon e depois cada pod abaixo é removido (evicted) em {{cluster}}. Os PodDisruptionBudgets são respeitados, então algumas remoções podem ser recusadas.",
  drainResult: "Drain de {{name}}",
  evicted: "Removidos",
  willBeEvicted: "Serão removidos",
  notEvicted: "Não removidos",
  leftAlone: "Mantidos",
  memory: "Memória",
  workingSet: "working set",
  last6h: "últimas 6h · {{source}}",
  allocatable: "alocável",
  allocatableValue: "alocável {{value}}",
  requested: "requisitado {{value}} ({{pct}}%)",
  used: "em uso {{value}} ({{pct}}%)",
  conditions: "Condições",
  taints: "Taints",
} satisfies Translation<typeof en>;
