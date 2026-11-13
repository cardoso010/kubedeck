import type en from "../en/settings";
import type { Translation } from "../types";

export default {
  title: "设置",
  close: "关闭",
  language: {
    title: "语言",
    system: "跟随系统（{{language}}）",
    note: "来自集群、helm 和系统的消息仍为英文。",
  },
  theme: { title: "主题" },
  cluster: {
    title: "当前集群",
    none: "连接集群后即可更改其设置。",
    readOnly: "以只读模式打开",
    readOnlyHint: "在解锁窗口之前，所有更改都会被拒绝。",
    notify: "崩溃通知",
    notifyHint: "所选命名空间中的 Pod 崩溃时发送桌面通知。",
    notifyDenied: "系统设置中未允许 kubedeck 发送通知。",
  },
  claude: {
    title: "使用 Claude 解释",
    environment: "正在使用环境变量 ANTHROPIC_API_KEY。",
    keychain: "系统钥匙串中已保存 API 密钥。",
    none: "尚未设置 API 密钥。首次使用“解释”时会提示输入。",
    remove: "移除密钥",
  },
} satisfies Translation<typeof en>;
