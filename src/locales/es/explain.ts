import type en from "../en/explain";
import type { Translation } from "../types";

export default {
  sent: "Se enviaron {{size}}k caracteres de contexto.",
  answeredBy: "Respuesta de {{model}}.",
  declined: "Claude prefirió no responder esta.",
  noSecrets: "kubedeck nunca envía Secrets a Claude.",
  explain: "Explicar con Claude",
  thinking: "Pensando…",
  again: "Explicar de nuevo",
  sendsPod: "Envía el manifiesto de este pod (sin los valores de secrets), los eventos y los logs recientes a la API de Anthropic.",
  sendsObject: "Envía el manifiesto de este objeto (sin los valores de secrets) y los eventos a la API de Anthropic.",
  production: "Este es un clúster de producción.",
  removeKey: "Eliminar clave",
  intro: "Claude lee lo que te mostrarían kubectl describe y los logs, y sugiere la causa probable y una solución.",
  key: {
    title: "Conectar Claude",
    hint: "Pega una clave de API de Anthropic. Se guarda en el llavero del sistema, nunca en un archivo, y solo se usa cuando haces clic en Explicar. También puedes definir <code>ANTHROPIC_API_KEY</code>.",
    save: "Guardar clave",
  },
} satisfies Translation<typeof en>;
