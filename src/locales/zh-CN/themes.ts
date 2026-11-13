import type en from "../en/themes";
import type { Translation } from "../types";

export default {
  terminal: { label: "终端", description: "近黑色，等宽字体，青柠色强调" },
  graphite: { label: "石墨", description: "柔和蓝灰，圆角，紫色强调" },
  light: { label: "浅色", description: "清爽浅色主题，蓝色强调" },
} satisfies Translation<typeof en>;
