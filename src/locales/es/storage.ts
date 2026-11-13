import type en from "../en/storage";
import type { Translation } from "../types";

export default {
  expandRequested: "Se solicitaron {{size}}. El driver amplía el volumen; algunos solo terminan cuando el pod se reinicia.",
  classRequested: "Se solicitó {{className}}. El driver cambia el volumen en el mismo lugar; puede tardar unos minutos.",
  noUsage: "No se informa el uso de este volumen. Solo los tipos de volumen que se miden a sí mismos (drivers CSI como EBS, volúmenes locales) lo informan, a través de Prometheus o del kubelet.",
  space: "Espacio",
  spaceDetail: "{{used}} usados · {{free}} libres · {{capacity}} de capacidad",
  inodes: "Inodos",
  inodesDetail: "{{used}} de {{total}} archivos",
  from: "desde {{source}}",
  used: "Usado",
  history: "historial de Prometheus",
  noHistory: "Prometheus no tiene historial de este volumen.",
  capacity: "capacidad",
  expandTitle: "Ampliar",
  requests: "Solicita {{size}}",
  newSize: "nuevo tamaño, p. ej. 20Gi",
  readOnly: "Modo de solo lectura",
  expand: "Ampliar",
  notExpandable: "{{storageClass}} no permite ampliar.",
  noStorageClass: "Sin StorageClass: no se puede ampliar.",
  classTitle: "Clase de atributos",
  noClass: "ninguna",
  changeTo: "cambiar a…",
  change: "Cambiar",
  confirmClass: {
    title: "¿Mover {{name}} a {{className}}?",
    message: "El driver CSI cambia el rendimiento del volumen (IOPS, throughput) en el mismo lugar en {{cluster}}. Algunos proveedores limitan cada cuánto puede cambiar un volumen.",
    confirm: "Cambiar clase",
  },
  confirmExpand: {
    title: "¿Ampliar {{name}} a {{size}}?",
    message: "Los volúmenes solo pueden crecer: esto no se puede deshacer en {{cluster}}.",
  },
} satisfies Translation<typeof en>;
