import type en from "../en/explain";
import type { Translation } from "../types";

export default {
  sent: "Enviados {{size}}k caracteres de contexto.",
  answeredBy: "Resposta de {{model}}.",
  declined: "O Claude preferiu não responder esta.",
  noSecrets: "O kubedeck nunca envia Secrets para o Claude.",
  explain: "Explicar com o Claude",
  thinking: "Pensando…",
  again: "Explicar de novo",
  sendsPod: "Envia o manifesto deste pod (sem os valores de secrets), os eventos e os logs recentes para a API da Anthropic.",
  sendsObject: "Envia o manifesto deste objeto (sem os valores de secrets) e os eventos para a API da Anthropic.",
  production: "Este é um cluster de produção.",
  removeKey: "Remover chave",
  intro: "O Claude lê o que o kubectl describe e os logs mostrariam a você, e sugere a causa provável e uma correção.",
  key: {
    title: "Conectar o Claude",
    hint: "Cole uma chave de API da Anthropic. Ela fica guardada no keychain do sistema, nunca em arquivo, e só é usada quando você clica em Explicar. Você também pode definir <code>ANTHROPIC_API_KEY</code>.",
    save: "Salvar chave",
  },
} satisfies Translation<typeof en>;
