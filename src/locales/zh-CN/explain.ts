import type en from "../en/explain";
import type { Translation } from "../types";

export default {
  sent: "已发送 {{size}}k 个字符的上下文。",
  answeredBy: "由 {{model}} 回答。",
  declined: "Claude 拒绝回答这个问题。",
  noSecrets: "kubedeck 从不将 Secret 发送给 Claude。",
  explain: "使用 Claude 解释",
  thinking: "思考中…",
  again: "重新解释",
  sendsPod: "将此 Pod 的清单（已移除 Secret 值）、事件和最近日志发送到 Anthropic API。",
  sendsObject: "将此对象的清单（已移除 Secret 值）和事件发送到 Anthropic API。",
  production: "这是生产集群。",
  removeKey: "移除密钥",
  intro: "Claude 会读取 kubectl describe 和日志中能看到的信息，并给出可能的原因和修复建议。",
  key: {
    title: "连接 Claude",
    hint: "粘贴 Anthropic API 密钥。它保存在系统钥匙串中，绝不写入文件，且仅在你点击“解释”时使用。你也可以设置 <code>ANTHROPIC_API_KEY</code>。",
    save: "保存密钥",
  },
} satisfies Translation<typeof en>;
