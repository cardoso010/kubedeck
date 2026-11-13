import type en from "../en/rail";
import type { Translation } from "../types";

export default {
  switchTo: "Cambiar a {{cluster}}",
  newWindow: "Ventana nueva",
  settings: "Configuración",
  updates: "Actualizaciones",
  about: "Acerca de kubedeck",
  cluster: {
    openInWindow: "Abrir en una ventana nueva",
    moveUp: "Subir",
    unpin: "Desanclar",
  },
  aboutPopover: {
    tagline: "Un cliente de Kubernetes rápido y nativo. Código abierto, Apache-2.0.",
    share: "Compartir",
    copyLink: "Copiar enlace",
    copyInstall: "Copiar comando de instalación",
    installHint: "una línea, para macOS, Linux o Windows",
    links: "Enlaces",
    website: "Sitio web",
    whatsNew: "Novedades",
    reportBug: "Reportar un error",
  },
  update: {
    updateTo: "Actualizar a {{version}}",
    checking: "Buscando actualizaciones…",
    available: "La versión {{version}} está disponible.",
    installing: "Instalando…",
    install: "Instalar y reiniciar",
    upToDate: "Tienes la última versión.",
    failed: "Falló la búsqueda de actualizaciones: {{message}}",
  },
} satisfies Translation<typeof en>;
