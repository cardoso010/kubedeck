import type en from "../en/storage";
import type { Translation } from "../types";

export default {
  expandRequested: "Pedido de {{size}} enviado. O driver aumenta o volume; alguns só terminam depois que o pod reinicia.",
  classRequested: "Pedido de {{className}} enviado. O driver muda o volume no lugar; pode levar alguns minutos.",
  noUsage: "Nenhum uso informado para este volume. Só tipos de volume que se medem (drivers CSI como EBS, volumes locais) informam o uso, via Prometheus ou kubelet.",
  space: "Espaço",
  spaceDetail: "{{used}} usados · {{free}} livres · {{capacity}} de capacidade",
  inodes: "Inodes",
  inodesDetail: "{{used}} de {{total}} arquivos",
  from: "via {{source}}",
  used: "Usado",
  history: "histórico do Prometheus",
  noHistory: "O Prometheus não tem histórico deste volume.",
  capacity: "capacidade",
  expandTitle: "Expandir",
  requests: "Solicita {{size}}",
  newSize: "novo tamanho, ex.: 20Gi",
  readOnly: "Modo somente leitura",
  expand: "Expandir",
  notExpandable: "{{storageClass}} não permite expansão.",
  noStorageClass: "Sem StorageClass: não pode ser expandido.",
  classTitle: "Classe de atributos",
  noClass: "nenhuma",
  changeTo: "mudar para…",
  change: "Mudar",
  confirmClass: {
    title: "Mover {{name}} para {{className}}?",
    message: "O driver CSI muda o desempenho do volume (IOPS, throughput) no lugar em {{cluster}}. Alguns provedores limitam com que frequência um volume pode mudar.",
    confirm: "Mudar classe",
  },
  confirmExpand: {
    title: "Expandir {{name}} para {{size}}?",
    message: "Volumes só podem crescer: isso não pode ser desfeito em {{cluster}}.",
  },
} satisfies Translation<typeof en>;
