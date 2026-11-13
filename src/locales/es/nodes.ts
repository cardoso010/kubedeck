import type en from "../en/nodes";
import type { Translation } from "../types";

export default {
  cordoned: "En cordon: no se programan pods nuevos aquí.",
  schedulable: "Programable",
  cordon: "Cordon",
  uncordon: "Uncordon",
  cordonTitle: "¿Hacer cordon de {{name}}?",
  cordonMessage: "No se programarán pods nuevos en este node de {{cluster}}. Los pods que ya están en él siguen funcionando.",
  drain: "Drain",
  drainEllipsis: "Drain…",
  drainTitle: "¿Hacer drain de {{name}}?",
  drainMessage: "Se hace cordon del node y luego se desaloja cada pod de abajo en {{cluster}}. Se respetan los PodDisruptionBudgets, así que algunos desalojos pueden rechazarse.",
  drainResult: "Drain de {{name}}",
  evicted: "Desalojados",
  willBeEvicted: "Se desalojarán",
  notEvicted: "No desalojados",
  leftAlone: "Sin cambios",
  memory: "Memoria",
  workingSet: "working set",
  last6h: "últimas 6 h · {{source}}",
  allocatable: "asignable",
  allocatableValue: "asignable {{value}}",
  requested: "solicitado {{value}} ({{pct}}%)",
  used: "en uso {{value}} ({{pct}}%)",
  conditions: "Condiciones",
  taints: "Taints",
} satisfies Translation<typeof en>;
