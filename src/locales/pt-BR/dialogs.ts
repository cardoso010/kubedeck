import type en from "../en/dialogs";
import type { Translation } from "../types";

export default {
  typeToConfirm: {
    type: "Digite",
    toConfirm: "para confirmar",
    copyName: "Copiar o nome",
    label: "Digite {{name}} para confirmar",
  },
  diff: {
    sides: "esquerda: no cluster · direita: o que será salvo",
  },
  create: {
    title: "Criar a partir de YAML",
    namespace: "Namespace para objetos sem um",
    placeholder: "# Cole um ou mais objetos, separados por ---\n",
    valid: "Válido, criaria",
    created: "Criado",
    readOnly: "Modo somente leitura: você pode validar, mas não criar.",
    validate: "Validar (dry run)",
    validateFirst: "Valide primeiro",
    create: "Criar",
  },
} satisfies Translation<typeof en>;
