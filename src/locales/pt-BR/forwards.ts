import type en from "../en/forwards";
import type { Translation } from "../types";

export default {
  buttons: { label: "Port forward:" },
  view: {
    title: "Port forwards",
    resource: "Recurso",
    remote: "Remota",
    local: "Local",
    connections: "Conexões",
    lastError: "Último erro",
    starHint: "Favoritar: reabre sempre que este cluster for aberto",
    unstarHint: "Parar de reabrir ao conectar",
    removeStar: "Remover dos favoritos",
    stop: "Parar",
    start: "Iniciar",
    empty: "Nenhum port forward ativo. Abra um pod ou service e clique em uma das portas.",
    starredStopped: "Favoritos parados",
  },
} satisfies Translation<typeof en>;
