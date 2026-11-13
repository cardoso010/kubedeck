import type en from "../en/metrics";
import type { Translation } from "../types";

export default {
  chart: {
    noSamples: "暂无样本",
    label: "时间序列图",
  },
  pod: {
    request: "request",
    limit: "limit",
    req: "req {{value}}",
    lim: "lim {{value}}",
    ofRequest: "占 request",
    ofLimit: "占 limit",
    noRequestOrLimit: "未设置 request 或 limit",
    noMetricsServer: "metrics-server 不可用，因此无法获取当前用量。",
    devices: "设备",
    claimNotCreated: "claim 尚未创建",
    notAllocated: "尚未分配",
    lookingForPrometheus: "正在查找 Prometheus…",
    historyFrom: "历史数据来自 <code>{{target}}</code>",
    live: "自此标签页打开起实时采集，每 10 秒一次。历史、网络和限流数据需要集群中有 Prometheus。",
    cores: "核",
    memory: "内存",
    workingSet: "working set",
    network: "网络",
    networkHint: "Pod，每秒",
    throttling: "CPU 限流",
    throttlingHint: "受 CPU limit 限流的周期占比",
    sidecar: "sidecar",
    restarts: "重启次数",
    lastTermination: "上次终止",
  },
} satisfies Translation<typeof en>;
