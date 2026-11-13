import type en from "../en/problems";
import type { Translation } from "../types";

export default {
  title: "Problemas",
  loading: "carregando…",
  filter: "Filtrar…",
  clear: "Nada parece errado nos namespaces selecionados.",
  checked: "Verificado: crash loops, OOM kills, pull de imagens, pods pendentes e não prontos, workloads, jobs, volume claims e nodes.",
  critical: "Críticos",
  warnings: "Avisos",
} satisfies Translation<typeof en>;
