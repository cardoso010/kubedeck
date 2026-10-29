// Sidebar rail sections. Built-in kinds are grouped by purpose; every CRD lives under
// "custom"; problems, rightsizing, Helm and port forwards are views of their own.
import { IconAdjustmentsHorizontal, IconAlertTriangle, IconDatabase, IconGauge, IconBox, IconNetwork, IconPackage, IconPlugConnected, IconPuzzle, IconServer2, type Icon } from "@tabler/icons-react";
import type { KindInfo } from "./api";

export type SectionId = "problems" | "rightsizing" | "workloads" | "storage" | "network" | "config" | "cluster" | "custom" | "helm" | "forwards";

export interface Section {
  id: SectionId;
  label: string;
  icon: Icon;
  /** Built-in kind keys, in tab order. */
  kinds?: string[];
}

export const SECTIONS: Section[] = [
  { id: "problems", label: "Problems", icon: IconAlertTriangle },
  { id: "workloads", label: "Workloads", icon: IconBox, kinds: ["pods", "deployments", "statefulsets", "daemonsets", "jobs", "cronjobs"] },
  { id: "network", label: "Network", icon: IconNetwork, kinds: ["services", "ingresses"] },
  { id: "config", label: "Config", icon: IconAdjustmentsHorizontal, kinds: ["configmaps", "secrets"] },
  { id: "storage", label: "Storage", icon: IconDatabase, kinds: ["persistentvolumeclaims", "persistentvolumes", "storageclasses"] },
  { id: "cluster", label: "Cluster", icon: IconServer2, kinds: ["nodes", "namespaces", "events"] },
  { id: "custom", label: "Custom resources", icon: IconPuzzle },
  { id: "rightsizing", label: "Rightsizing", icon: IconGauge },
  { id: "helm", label: "Helm", icon: IconPackage },
  { id: "forwards", label: "Port forwards", icon: IconPlugConnected },
];

/** View keys that are not Kubernetes kinds. */
export const HELM = "helm";
export const FORWARDS = "port-forwards";
export const PROBLEMS = "problems";
export const RIGHTSIZING = "rightsizing";

export function sectionOf(viewKey: string, kinds: KindInfo[]): SectionId {
  if (viewKey === PROBLEMS) return "problems";
  if (viewKey === RIGHTSIZING) return "rightsizing";
  if (viewKey === HELM) return "helm";
  if (viewKey === FORWARDS) return "forwards";
  const builtin = SECTIONS.find((s) => s.kinds?.includes(viewKey));
  if (builtin) return builtin.id;
  return kinds.find((k) => k.key === viewKey)?.group ? "custom" : "workloads";
}
