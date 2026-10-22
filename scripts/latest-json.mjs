#!/usr/bin/env node
// Prints the updater manifest (latest.json) for a release. Used by the Release workflow
// after the bundles are uploaded; needs the GitHub CLI with access to the repository.
//
//   node scripts/latest-json.mjs <tag> > latest.json
//
// The repository is private, so download URLs are GitHub API asset URLs: the app sends
// its GitHub token with `Accept: application/octet-stream` (see src-tauri/src/updater.rs).
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

// Updater target keys for each architecture suffix used in asset names.
const ARCHES = { aarch64: "darwin-aarch64", x86_64: "darwin-x86_64" };
const platforms = {};
for (const [arch, target] of Object.entries(ARCHES)) {
  const bundle = release.assets.find((a) => a.name.endsWith(`_${arch}.app.tar.gz`));
  const sig = release.assets.find((a) => a.name.endsWith(`_${arch}.app.tar.gz.sig`));
  if (!bundle || !sig) {
    console.error(`latest-json: missing ${arch} bundle or signature in ${tag}`);
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
