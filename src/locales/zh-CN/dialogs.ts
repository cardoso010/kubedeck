import type en from "../en/dialogs";
import type { Translation } from "../types";

export default {
  typeToConfirm: {
    type: "输入",
    toConfirm: "以确认",
    copyName: "复制名称",
    label: "输入 {{name}} 以确认",
  },
  diff: {
    sides: "左侧：集群中的版本 · 右侧：将要保存的内容",
  },
  create: {
    title: "从 YAML 创建",
    namespace: "未指定命名空间的对象使用",
    placeholder: "# 粘贴一个或多个对象，用 --- 分隔\n",
    valid: "校验通过，将创建",
    created: "已创建",
    readOnly: "只读模式：可以校验，但不能创建。",
    validate: "校验（dry run）",
    validateFirst: "请先校验",
    create: "创建",
  },
} satisfies Translation<typeof en>;
