// Sidebar rail sections. Built-in kinds are grouped by purpose; every CRD lives under
// "custom"; Helm and port forwards are views of their own.
import { IconAdjustmentsHorizontal, IconBox, IconNetwork, IconPackage, IconPlugConnected, IconPuzzle, IconServer2, type Icon } from "@tabler/icons-react";
import type { KindInfo } from "./api";

export type SectionId = "workloads" | "network" | "config" | "cluster" | "custom" | "helm" | "forwards";

export interface Section {
  id: SectionId;
  label: string;
  icon: Icon;
  /** Built-in kind keys, in tab order. */
  kinds?: string[];
}

export const SECTIONS: Section[] = [
  { id: "workloads", label: "Workloads", icon: IconBox, kinds: ["pods", "deployments", "statefulsets", "daemonsets", "jobs", "cronjobs"] },
  { id: "network", label: "Network", icon: IconNetwork, kinds: ["services", "ingresses"] },
  { id: "config", label: "Config", icon: IconAdjustmentsHorizontal, kinds: ["configmaps", "secrets", "persistentvolumeclaims"] },
  { id: "cluster", label: "Cluster", icon: IconServer2, kinds: ["nodes", "namespaces", "events"] },
  { id: "custom", label: "Custom resources", icon: IconPuzzle },
  { id: "helm", label: "Helm", icon: IconPackage },
  { id: "forwards", label: "Port forwards", icon: IconPlugConnected },
];

/** View keys that are not Kubernetes kinds. */
export const HELM = "helm";
export const FORWARDS = "port-forwards";

export function sectionOf(viewKey: string, kinds: KindInfo[]): SectionId {
  if (viewKey === HELM) return "helm";
  if (viewKey === FORWARDS) return "forwards";
  const builtin = SECTIONS.find((s) => s.kinds?.includes(viewKey));
  if (builtin) return builtin.id;
  return kinds.find((k) => k.key === viewKey)?.group ? "custom" : "workloads";
}
