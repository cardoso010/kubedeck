import type en from "../en/settings";
import type { Translation } from "../types";

export default {
  title: "Configurações",
  close: "Fechar",
  language: {
    title: "Idioma",
    system: "Sistema ({{language}})",
    note: "Mensagens do cluster, do helm e do sistema continuam em inglês.",
  },
  theme: { title: "Tema" },
  cluster: {
    title: "Este cluster",
    none: "Conecte a um cluster para mudar as configurações dele.",
    readOnly: "Abrir em modo somente leitura",
    readOnlyHint: "Toda alteração é recusada até você desbloquear a janela.",
    notify: "Notificações de falha",
    notifyHint: "Uma notificação no desktop quando um pod falha nos namespaces selecionados.",
    notifyDenied: "As notificações do kubedeck não estão permitidas nas configurações do sistema.",
  },
  claude: {
    title: "Explicar com o Claude",
    environment: "Usando ANTHROPIC_API_KEY do ambiente.",
    keychain: "Há uma chave de API salva no keychain do sistema.",
    none: "Nenhuma chave de API ainda. O Explicar pede uma na primeira vez que você usar.",
    remove: "Remover chave",
  },
} satisfies Translation<typeof en>;
