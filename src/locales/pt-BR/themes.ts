import type en from "../en/themes";
import type { Translation } from "../types";

export default {
  terminal: { label: "Terminal", description: "Quase preto, monoespaçado, destaque verde-limão" },
  graphite: { label: "Grafite", description: "Cinza-azulado suave, arredondado, destaque violeta" },
  light: { label: "Claro", description: "Tema claro e nítido, destaque azul" },
} satisfies Translation<typeof en>;
