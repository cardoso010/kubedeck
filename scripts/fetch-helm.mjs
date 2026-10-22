#!/usr/bin/env node
// Downloads the Helm CLI that kubedeck bundles as a Tauri sidecar and places it at
// src-tauri/binaries/helm-<target-triple>[.exe], the name Tauri's externalBin expects.
//
//   node scripts/fetch-helm.mjs [target-triple]
//
// The target defaults to TAURI_ENV_TARGET_TRIPLE (set by the Tauri CLI) or the Rust host.
// Archives are checked against the SHA-256 sums pinned below, taken from the official
// release notes, so a tampered download fails the build.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "3.22.1";

// Rust target triple -> Helm platform and archive checksum (https://github.com/helm/helm/releases/tag/v3.22.1)
const PLATFORMS = {
  "aarch64-apple-darwin": ["darwin-arm64", "e73da8a0b0d5193774fdff17ce6319c7436bb22ee229b45fd64f3c40368c753a"],
  "x86_64-apple-darwin": ["darwin-amd64", "cf850a81b908f8eef0331e6b18776da2767bcac639ca84472311dad20008495c"],
  "x86_64-unknown-linux-gnu": ["linux-amd64", "896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea"],
  "aarch64-unknown-linux-gnu": ["linux-arm64", "4c29e286b279d170fa048ddfc3e4e83dcd069ca9c52102766ba672d7149e694d"],
  "x86_64-pc-windows-msvc": ["windows-amd64", "32ce9f4509b81782c9740898c43946e1f97c4d93ec5d10222c9b6eeec21ea043"],
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target =
  process.argv[2] ??
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))[1];

const platform = PLATFORMS[target];
if (!platform) {
  console.error(`fetch-helm: no Helm build configured for ${target}. Add it to PLATFORMS in scripts/fetch-helm.mjs.`);
  process.exit(1);
}
const [helmPlatform, sha256] = platform;
const windows = helmPlatform.startsWith("windows");
const outDir = join(root, "src-tauri", "binaries");
const out = join(outDir, `helm-${target}${windows ? ".exe" : ""}`);
const marker = `${out}.version`;

// Already in place: skip the download (this runs before every dev and build).
if (existsSync(out) && existsSync(marker) && readFileSync(marker, "utf8").trim() === `${VERSION} ${sha256}`) {
  process.exit(0);
}

const archive = `helm-v${VERSION}-${helmPlatform}.${windows ? "zip" : "tar.gz"}`;
const url = `https://get.helm.sh/${archive}`;
console.log(`fetch-helm: downloading ${url}`);
const response = await fetch(url);
if (!response.ok) {
  console.error(`fetch-helm: download failed with HTTP ${response.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
const actual = createHash("sha256").update(bytes).digest("hex");
if (actual !== sha256) {
  console.error(`fetch-helm: checksum mismatch for ${archive}\n  expected ${sha256}\n  got      ${actual}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "kubedeck-helm-"));
try {
  const archivePath = join(work, archive);
  writeFileSync(archivePath, bytes);
  // bsdtar (macOS, Windows 10+) and GNU tar both read .tar.gz; bsdtar also reads .zip.
  execFileSync("tar", ["-xf", archivePath, "-C", work]);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(work, helmPlatform, windows ? "helm.exe" : "helm"), out);
  chmodSync(out, 0o755);
  writeFileSync(marker, `${VERSION} ${sha256}\n`);
  console.log(`fetch-helm: Helm ${VERSION} ready at ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
