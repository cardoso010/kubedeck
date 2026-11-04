const REPO = "cardoso010/kubedeck";
const COMMANDS = {
  unix: `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash`,
  windows: `irm https://raw.githubusercontent.com/${REPO}/main/scripts/install.ps1 | iex`,
};

const isWindows = /Windows/i.test(navigator.userAgent);

function selectTab(os) {
  document.getElementById("command").textContent = COMMANDS[os];
  for (const tab of document.querySelectorAll(".tabs button")) tab.setAttribute("aria-selected", String(tab.dataset.os === os));
}
for (const tab of document.querySelectorAll(".tabs button")) tab.addEventListener("click", () => selectTab(tab.dataset.os));
if (isWindows) selectTab("windows");

function copy(button, text) {
  navigator.clipboard.writeText(text).then(() => {
    const label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = label), 1500);
  });
}
for (const button of document.querySelectorAll("[data-copy]")) button.addEventListener("click", () => copy(button, document.getElementById(button.dataset.copy).textContent));
for (const button of document.querySelectorAll("[data-copy-text]")) button.addEventListener("click", () => copy(button, button.dataset.copyText));

// Direct download links for the latest release, matching the asset names the release workflow uploads.
const ASSETS = [
  ["macOS Apple Silicon", "_aarch64.dmg"],
  ["macOS Intel", "_x86_64.dmg"],
  ["Linux AppImage", "_linux_x86_64.AppImage"],
  ["Linux .deb", "_linux_x86_64.deb"],
  ["Windows", "_windows_x86_64-setup.exe"],
];

fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((release) => {
    const links = ASSETS.map(([label, suffix]) => [label, release.assets.find((a) => a.name.endsWith(suffix))])
      .filter(([, asset]) => asset)
      .map(([label, asset]) => `<a href="${asset.browser_download_url}">${label}</a>`);
    if (links.length === 0) return;
    const downloads = document.getElementById("downloads");
    downloads.innerHTML = `${release.tag_name}: ${links.join("")}`;
  })
  .catch(() => {});

fetch(`https://api.github.com/repos/${REPO}`)
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((repo) => {
    const stars = document.getElementById("stars");
    stars.textContent = `★ ${repo.stargazers_count}`;
    stars.hidden = false;
  })
  .catch(() => {});
