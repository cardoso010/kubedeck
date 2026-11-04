/** Where the project lives, for the About popover and the command palette. */
export const REPO_URL = "https://github.com/cardoso010/kubedeck";
export const SITE_URL = "https://cardoso010.github.io/kubedeck/";

const windows = /Windows/i.test(navigator.userAgent);

export const INSTALL_COMMAND = windows
  ? "irm https://raw.githubusercontent.com/cardoso010/kubedeck/main/scripts/install.ps1 | iex"
  : "curl -fsSL https://raw.githubusercontent.com/cardoso010/kubedeck/main/scripts/install.sh | bash";

/**
 * A new issue from the bug template with the version and OS filled in. Nothing about the
 * cluster goes in: the reporter decides what to share. The webview can't tell Apple Silicon
 * from Intel, so macOS is left for them to pick.
 */
export function bugReportUrl(version: string): string {
  const params = new URLSearchParams({ template: "bug_report.yml" });
  if (version) params.set("version", version);
  if (windows) params.set("os", "Windows");
  else if (/Linux/i.test(navigator.userAgent)) params.set("os", "Linux");
  return `${REPO_URL}/issues/new?${params}`;
}
