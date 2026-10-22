// Desktop notifications for new crashes in the window's selected namespaces, opt-in per
// cluster. Fed by the Problems polling, so no extra cluster load.
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { Problem } from "./api";

const key = (context: string) => `kubedeck.notify.${context}`;

export function notifyEnabled(context: string): boolean {
  try {
    return localStorage.getItem(key(context)) === "1";
  } catch {
    return false;
  }
}

/** Turns notifications on or off for `context`; asks the OS for permission when turning on. */
export async function setNotifyEnabled(context: string, on: boolean): Promise<boolean> {
  if (on) {
    try {
      if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return false;
    } catch {
      return false;
    }
  }
  try {
    localStorage.setItem(key(context), on ? "1" : "0");
  } catch {
    // Not remembered.
  }
  return true;
}

/** Problems worth interrupting for: pods crashing or killed for memory. */
const NOTIFY_REASONS = /CrashLoopBackOff|OOMKilled|Error|ImagePullBackOff|ErrImagePull|CreateContainerConfigError/;
export const problemKey = (p: Problem) => `${p.kindKey}/${p.namespace}/${p.name}/${p.reason}`;

export function notifyNew(cluster: string, fresh: Problem[]) {
  const worth = fresh.filter((p) => p.severity === "critical" && NOTIFY_REASONS.test(p.reason));
  if (worth.length === 0) return;
  const body =
    worth.length <= 3
      ? worth.map((p) => `${p.namespace ? `${p.namespace}/` : ""}${p.name}: ${p.reason}`).join("\n")
      : `${worth.length} pods: ${[...new Set(worth.map((p) => p.reason))].join(", ")}`;
  try {
    sendNotification({ title: `kubedeck · ${cluster}`, body });
  } catch {
    // Notifications unavailable (e.g. outside the app).
  }
}
