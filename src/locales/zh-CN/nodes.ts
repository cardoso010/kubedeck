import type en from "../en/nodes";
import type { Translation } from "../types";

export default {
  cordoned: "已 cordon：不会再调度新的 Pod 到此节点。",
  schedulable: "可调度",
  cordon: "Cordon",
  uncordon: "Uncordon",
  cordonTitle: "对 {{name}} 执行 cordon？",
  cordonMessage: "{{cluster}} 的此节点将不再调度新的 Pod，已在其上的 Pod 继续运行。",
  drain: "Drain",
  drainEllipsis: "Drain…",
  drainTitle: "对 {{name}} 执行 drain？",
  drainMessage: "先对节点执行 cordon，然后在 {{cluster}} 上驱逐下列每个 Pod。会遵守 PodDisruptionBudget，因此部分驱逐可能被拒绝。",
  drainResult: "{{name}} 的 drain 结果",
  evicted: "已驱逐",
  willBeEvicted: "将被驱逐",
  notEvicted: "未驱逐",
  leftAlone: "保持不变",
  memory: "内存",
  workingSet: "working set",
  last6h: "最近 6 小时 · {{source}}",
  allocatable: "可分配",
  allocatableValue: "可分配 {{value}}",
  requested: "已请求 {{value}}（{{pct}}%）",
  used: "已使用 {{value}}（{{pct}}%）",
  conditions: "状况",
  taints: "Taints",
} satisfies Translation<typeof en>;
