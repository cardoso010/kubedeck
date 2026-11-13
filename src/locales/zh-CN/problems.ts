import type en from "../en/problems";
import type { Translation } from "../types";

export default {
  title: "问题",
  loading: "加载中…",
  filter: "筛选…",
  clear: "所选命名空间中一切正常。",
  checked: "已检查：崩溃循环、OOM 终止、镜像拉取、挂起和未就绪的 Pod、工作负载、Job、存储卷声明和节点。",
  critical: "严重",
  warnings: "警告",
} satisfies Translation<typeof en>;
