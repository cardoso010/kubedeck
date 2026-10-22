// Captures the README screenshots from the browser-only UI (sample data from src/dev-mock.ts).
//
//   npm run dev            # in another terminal
//   npm run screenshots    # writes docs/screenshots/*.png
//
// Drives the locally installed Google Chrome through playwright-core (no browser download).
import { chromium } from "playwright-core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
const URL = "http://localhost:1420";
const CONTEXT = "kind-kubedeck-test";
const PROD = "arn:aws:eks:us-east-1:000000000000:cluster/shop-prd";

const browser = await chromium.launch({ channel: "chrome", headless: true });

async function scene(name, { theme, namespaces = ["demo", "demo2"], connect = true }, act) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await context.addInitScript(
    ([theme, ns, ctx, prod]) => {
      localStorage.setItem("kubedeck.theme", theme);
      localStorage.setItem("kubedeck.hotbar", JSON.stringify([ctx, prod]));
      localStorage.setItem(`kubedeck.namespaces.${ctx}`, JSON.stringify(ns));
    },
    [theme, namespaces, CONTEXT, PROD],
  );
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForSelector(".welcome-item");
  if (connect) {
    await page.locator(".welcome-item", { hasText: CONTEXT }).click();
    await page.waitForSelector(".table-row");
  }
  await act(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`captured ${name}`);
  await context.close();
}

await scene("welcome", { theme: "terminal", connect: false }, async () => {});

await scene("pods-logs", { theme: "terminal" }, async (page) => {
  await page.locator(".table-row", { hasText: "ticker" }).click();
  await page.waitForTimeout(3500); // let a few log lines stream in
});

await scene("command-palette", { theme: "terminal" }, async (page) => {
  // Headless Chrome keeps Cmd/Ctrl+K for itself; open the palette with its button.
  await page.locator(".search-trigger").click();
  await page.waitForSelector(".palette-input");
  await page.keyboard.type("de");
});

await scene("helm-graphite", { theme: "graphite" }, async (page) => {
  await page.getByRole("button", { name: "Helm", exact: true }).click();
  await page.locator(".table-row", { hasText: "hello" }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
});

await scene("yaml-light", { theme: "light", namespaces: ["demo"] }, async (page) => {
  await page.locator(".table-row", { hasText: "web-7c6cdd646-2zjfg" }).click();
  await page.getByRole("button", { name: "YAML", exact: true }).click();
  await page.waitForSelector(".monaco-editor .view-lines");
  await page.waitForTimeout(800);
});

await browser.close();
