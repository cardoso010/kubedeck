import type en from "../en/dialogs";
import type { Translation } from "../types";

export default {
  typeToConfirm: {
    type: "Escribe",
    toConfirm: "para confirmar",
    copyName: "Copiar el nombre",
    label: "Escribe {{name}} para confirmar",
  },
  diff: {
    sides: "izquierda: en el clúster · derecha: lo que se guardará",
  },
  create: {
    title: "Crear desde YAML",
    namespace: "Namespace para los objetos que no tengan uno",
    placeholder: "# Pega uno o más objetos, separados por ---\n",
    valid: "Válido, se crearía",
    created: "Creado",
    readOnly: "Modo de solo lectura: puedes validar, pero no crear.",
    validate: "Validar (dry run)",
    validateFirst: "Valida primero",
    create: "Crear",
  },
} satisfies Translation<typeof en>;
