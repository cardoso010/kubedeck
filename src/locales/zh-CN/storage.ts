import type en from "../en/storage";
import type { Translation } from "../types";

export default {
  expandRequested: "已请求 {{size}}。驱动会扩容该卷；部分驱动需在 Pod 重启后才能完成。",
  classRequested: "已请求 {{className}}。驱动会原地修改该卷，可能需要几分钟。",
  noUsage: "该卷没有用量数据。只有能自行统计的卷类型（如 EBS 等 CSI 驱动、本地卷）会通过 Prometheus 或 kubelet 上报。",
  space: "空间",
  spaceDetail: "已用 {{used}} · 可用 {{free}} · 容量 {{capacity}}",
  inodes: "Inode",
  inodesDetail: "{{used}} / {{total}} 个文件",
  from: "来自 {{source}}",
  used: "已用",
  history: "Prometheus 历史数据",
  noHistory: "Prometheus 中没有该卷的历史数据。",
  capacity: "容量",
  expandTitle: "扩容",
  requests: "请求 {{size}}",
  newSize: "新容量，例如 20Gi",
  readOnly: "只读模式",
  expand: "扩容",
  notExpandable: "{{storageClass}} 不允许扩容。",
  noStorageClass: "没有 StorageClass：无法扩容。",
  classTitle: "属性类",
  noClass: "无",
  changeTo: "更改为…",
  change: "更改",
  confirmClass: {
    title: "将 {{name}} 改为 {{className}}？",
    message: "CSI 驱动会在 {{cluster}} 上原地修改该卷的性能（IOPS、吞吐量）。部分云厂商会限制卷的修改频率。",
    confirm: "更改类",
  },
  confirmExpand: {
    title: "将 {{name}} 扩容到 {{size}}？",
    message: "卷只能扩大：此操作在 {{cluster}} 上无法撤销。",
  },
} satisfies Translation<typeof en>;
