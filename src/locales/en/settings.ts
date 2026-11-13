export default {
  title: "Settings",
  close: "Close",
  language: {
    title: "Language",
    system: "System ({{language}})",
    note: "Messages from the cluster, helm and the system stay in English.",
  },
  theme: { title: "Theme" },
  cluster: {
    title: "This cluster",
    none: "Connect to a cluster to change its settings.",
    readOnly: "Open read-only",
    readOnlyHint: "Every change is refused until you unlock the window.",
    notify: "Crash notifications",
    notifyHint: "A desktop notification when a pod crashes in the selected namespaces.",
    notifyDenied: "Notifications are not allowed for kubedeck in the system settings.",
  },
  claude: {
    title: "Explain with Claude",
    environment: "Using ANTHROPIC_API_KEY from the environment.",
    keychain: "An API key is saved in the system keychain.",
    none: "No API key yet. Explain asks for one the first time you use it.",
    remove: "Remove key",
  },
};
