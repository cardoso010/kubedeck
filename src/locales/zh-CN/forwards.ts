import type en from "../en/forwards";
import type { Translation } from "../types";

export default {
  buttons: { label: "端口转发：" },
  view: {
    title: "端口转发",
    resource: "资源",
    remote: "远程",
    local: "本地",
    connections: "连接数",
    lastError: "最近错误",
    starHint: "收藏：每次打开此集群时自动重新开启",
    unstarHint: "连接时不再自动开启",
    removeStar: "取消收藏",
    stop: "停止",
    start: "开启",
    empty: "没有活动的端口转发。打开一个 Pod 或 Service，然后点击其中一个端口。",
    starredStopped: "已收藏，未运行",
  },
} satisfies Translation<typeof en>;
