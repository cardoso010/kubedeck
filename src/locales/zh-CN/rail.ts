import type en from "../en/rail";
import type { Translation } from "../types";

export default {
  switchTo: "切换到 {{cluster}}",
  newWindow: "新建窗口",
  settings: "设置",
  updates: "更新",
  about: "关于 kubedeck",
  cluster: {
    openInWindow: "在新窗口中打开",
    moveUp: "上移",
    unpin: "取消固定",
  },
  aboutPopover: {
    tagline: "快速的原生 Kubernetes 客户端。开源，Apache-2.0 许可。",
    share: "分享",
    copyLink: "复制链接",
    copyInstall: "复制安装命令",
    installHint: "一行命令，适用于 macOS、Linux 或 Windows",
    links: "链接",
    website: "网站",
    whatsNew: "新功能",
    reportBug: "报告问题",
  },
  update: {
    updateTo: "更新到 {{version}}",
    checking: "正在检查更新…",
    available: "版本 {{version}} 已可用。",
    installing: "正在安装…",
    install: "安装并重启",
    upToDate: "已是最新版本。",
    failed: "检查更新失败：{{message}}",
  },
} satisfies Translation<typeof en>;
