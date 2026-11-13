import type en from "../en/settings";
import type { Translation } from "../types";

export default {
  title: "Configuración",
  close: "Cerrar",
  language: {
    title: "Idioma",
    system: "Sistema ({{language}})",
    note: "Los mensajes del clúster, de helm y del sistema se mantienen en inglés.",
  },
  theme: { title: "Tema" },
  cluster: {
    title: "Este clúster",
    none: "Conéctate a un clúster para cambiar su configuración.",
    readOnly: "Abrir en modo de solo lectura",
    readOnlyHint: "Se rechaza todo cambio hasta que desbloquees la ventana.",
    notify: "Notificaciones de fallos",
    notifyHint: "Una notificación de escritorio cuando un pod falla en los namespaces seleccionados.",
    notifyDenied: "Las notificaciones de kubedeck no están permitidas en la configuración del sistema.",
  },
  claude: {
    title: "Explicar con Claude",
    environment: "Usando ANTHROPIC_API_KEY del entorno.",
    keychain: "Hay una clave de API guardada en el llavero del sistema.",
    none: "Aún no hay clave de API. Explicar la pide la primera vez que lo uses.",
    remove: "Eliminar clave",
  },
} satisfies Translation<typeof en>;
