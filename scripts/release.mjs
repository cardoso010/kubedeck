#!/usr/bin/env node
// Cuts a release: bumps the version everywhere it lives, commits, tags and (with --push)
// pushes the tag, which starts .github/workflows/release.yml.
//
//   npm run release -- 0.3.0           # bump, commit and tag locally
//   npm run release -- 0.3.0 --push    # ...and push main plus the tag
//   node scripts/release.mjs --check 0.3.0   # CI: fail unless every file says 0.3.0
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  "package.json": {
    read: (s) => JSON.parse(s).version,
    write: (s, v) => s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  "src-tauri/tauri.conf.json": {
    read: (s) => JSON.parse(s).version,
    write: (s, v) => s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  "src-tauri/Cargo.toml": {
    read: (s) => /^version = "([^"]+)"/m.exec(s)[1],
    write: (s, v) => s.replace(/^version = "[^"]+"/m, `version = "${v}"`),
  },
  "src-tauri/Cargo.lock": {
    read: (s) => /name = "kubedeck"\nversion = "([^"]+)"/.exec(s)[1],
    write: (s, v) => s.replace(/(name = "kubedeck"\nversion = ")[^"]+(")/, `$1${v}$2`),
  },
};

const read = (f) => readFileSync(join(root, f), "utf8");
const versions = () => Object.fromEntries(Object.entries(files).map(([f, h]) => [f, h.read(read(f))]));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const check = args.includes("--check");
const push = args.includes("--push");
const version = args.find((a) => !a.startsWith("--"))?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  fail("usage: npm run release -- <x.y.z> [--push]   |   node scripts/release.mjs --check <x.y.z>");
}

if (check) {
  const wrong = Object.entries(versions()).filter(([, v]) => v !== version);
  if (wrong.length) fail(`tag is v${version} but ${wrong.map(([f, v]) => `${f} says ${v}`).join(", ")}`);
  console.log(`release: all files are at ${version}`);
  process.exit(0);
}

const current = versions()["package.json"];
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split("-")[0].split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (!newer(version, current)) fail(`${version} is not newer than the current ${current}`);
if (git("status", "--porcelain")) fail("the working tree has uncommitted changes");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("releases are cut from main");
if (git("tag", "--list", `v${version}`)) fail(`tag v${version} already exists`);

for (const [file, h] of Object.entries(files)) writeFileSync(join(root, file), h.write(read(file), version));
git("add", ...Object.keys(files));
git("commit", "-m", `Release v${version}`);
git("tag", "-a", `v${version}`, "-m", `kubedeck v${version}`);
console.log(`release: v${version} committed and tagged`);

if (push) {
  git("push", "origin", "main", `v${version}`);
  console.log("release: pushed; the Release workflow is building it now");
} else {
  console.log(`release: run "git push origin main v${version}" to publish`);
}
