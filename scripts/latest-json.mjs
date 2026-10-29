#!/usr/bin/env node
// Prints the updater manifest (latest.json) for a release. Used by the Release workflow
// after the bundles are uploaded; needs the GitHub CLI with access to the repository.
//
//   node scripts/latest-json.mjs <tag> > latest.json
//
// Download URLs are GitHub API asset URLs, fetched with `Accept: application/octet-stream`
// (see src-tauri/src/updater.rs). Unlike browser_download_url they also work from a private
// repository or fork when the app has a GitHub token, and installed copies rely on them.
import { execFileSync } from "node:child_process";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: latest-json.mjs <tag>");
  process.exit(1);
}
const repo = process.env.GITHUB_REPOSITORY ?? "cardoso010/kubedeck";
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Drafts are not served by /releases/tags/<tag>, so look the release up in the list.
const releases = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repo}/releases`)).flat();
const release = releases.find((r) => r.tag_name === tag);
if (!release) {
  console.error(`latest-json: no release for ${tag} in ${repo}`);
  process.exit(1);
}

// Updater target -> the asset (and its .sig) the Release workflow uploads for it.
const BUNDLES = {
  "darwin-aarch64": "_aarch64.app.tar.gz",
  "darwin-x86_64": "_x86_64.app.tar.gz",
  "linux-x86_64": "_linux_x86_64.AppImage",
  "windows-x86_64": "_windows_x86_64-setup.exe",
};
const platforms = {};
for (const [target, suffix] of Object.entries(BUNDLES)) {
  const bundle = release.assets.find((a) => a.name.endsWith(suffix));
  const sig = release.assets.find((a) => a.name.endsWith(`${suffix}.sig`));
  if (!bundle || !sig) {
    console.error(`latest-json: missing ${target} bundle or signature (*${suffix}) in ${tag}`);
    process.exit(1);
  }
  const signature = gh("api", "-H", "Accept: application/octet-stream", sig.url).trim();
  platforms[target] = { signature, url: bundle.url };
}

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: release.body ?? "",
  pub_date: new Date().toISOString(),
  platforms,
};
process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
