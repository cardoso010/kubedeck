// Regenerates every app icon from src-tauri/icons/source/kubedeck.svg.
//
//   npm run icons
//
// `tauri icon` needs a raster source, so the SVG is rendered at 1024px by the locally
// installed Google Chrome (playwright-core, as for the screenshots). Android and iOS
// icons are dropped: kubedeck only ships desktop bundles.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const icons = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
const svg = readFileSync(join(icons, "source", "kubedeck.svg"), "utf8").replace("<svg ", '<svg width="1024" height="1024" ');
const work = mkdtempSync(join(tmpdir(), "kubedeck-icon-"));
const png = join(work, "kubedeck.png");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<body style="margin:0">${svg}</body>`);
await page.screenshot({ path: png, omitBackground: true });
await browser.close();

execFileSync("npx", ["tauri", "icon", png, "-o", icons], { stdio: "inherit" });
for (const extra of ["android", "ios", "64x64.png"]) rmSync(join(icons, extra), { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
