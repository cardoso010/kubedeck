import type en from "../en/rail";
import type { Translation } from "../types";

export default {
  switchTo: "Mudar para {{cluster}}",
  newWindow: "Nova janela",
  settings: "Configurações",
  updates: "Atualizações",
  about: "Sobre o kubedeck",
  cluster: {
    openInWindow: "Abrir em nova janela",
    moveUp: "Mover para cima",
    unpin: "Desafixar",
  },
  aboutPopover: {
    tagline: "Um cliente Kubernetes rápido e nativo. Código aberto, Apache-2.0.",
    share: "Compartilhar",
    copyLink: "Copiar link",
    copyInstall: "Copiar comando de instalação",
    installHint: "uma linha, para macOS, Linux ou Windows",
    links: "Links",
    website: "Site",
    whatsNew: "Novidades",
    reportBug: "Reportar um bug",
  },
  update: {
    updateTo: "Atualizar para {{version}}",
    checking: "Procurando atualizações…",
    available: "A versão {{version}} está disponível.",
    installing: "Instalando…",
    install: "Instalar e reiniciar",
    upToDate: "Você está na versão mais recente.",
    failed: "Falha ao procurar atualizações: {{message}}",
  },
} satisfies Translation<typeof en>;
