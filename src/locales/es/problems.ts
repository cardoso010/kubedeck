import type en from "../en/problems";
import type { Translation } from "../types";

export default {
  title: "Problemas",
  loading: "cargando…",
  filter: "Filtrar…",
  clear: "No se ve nada mal en los namespaces seleccionados.",
  checked: "Revisado: crash loops, OOM kills, descarga de imágenes, pods pendientes y no listos, workloads, jobs, volume claims y nodos.",
  critical: "Críticos",
  warnings: "Advertencias",
} satisfies Translation<typeof en>;
