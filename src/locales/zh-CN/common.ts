import type en from "../en/common";
import type { Translation } from "../types";

export default {
  cancel: "取消",
  close: "关闭",
  copy: "复制",
  copied: "已复制",
  save: "保存",
  apply: "应用",
  delete: "删除",
  edit: "编辑",
  retry: "重试",
  refresh: "刷新",
  loading: "加载中…",
  search: "搜索",
  all: "全部",
  none: "无",
  name: "名称",
  namespace: "命名空间",
  status: "状态",
  age: "存在时间",
} satisfies Translation<typeof en>;
