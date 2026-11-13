import type en from "../en/themes";
import type { Translation } from "../types";

export default {
  terminal: { label: "Terminal", description: "Casi negro, monoespaciado, acento lima" },
  graphite: { label: "Grafito", description: "Gris azulado suave, redondeado, acento violeta" },
  light: { label: "Claro", description: "Tema claro y nítido, acento azul" },
} satisfies Translation<typeof en>;
