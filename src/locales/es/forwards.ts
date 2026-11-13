import type en from "../en/forwards";
import type { Translation } from "../types";

export default {
  buttons: { label: "Port forward:" },
  view: {
    title: "Port forwards",
    resource: "Recurso",
    remote: "Remoto",
    local: "Local",
    connections: "Conexiones",
    lastError: "Último error",
    starHint: "Marcar: se vuelve a abrir cada vez que se abre este clúster",
    unstarHint: "Dejar de reabrirlo al conectar",
    removeStar: "Quitar la marca",
    stop: "Detener",
    start: "Iniciar",
    empty: "No hay port forwards activos. Abre un pod o service y haz clic en uno de sus puertos.",
    starredStopped: "Marcados, sin ejecutar",
  },
} satisfies Translation<typeof en>;
