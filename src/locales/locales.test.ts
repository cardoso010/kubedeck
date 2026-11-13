import { describe, expect, it } from "vitest";
import en from "./en";
import es from "./es";
import ptBR from "./pt-BR";
import zhCN from "./zh-CN";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === "string") out.set(prefix + k, v);
    else for (const [kk, vv] of flatten(v, `${prefix}${k}.`)) out.set(kk, vv);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}|<(\d+)>/g)].map((m) => m[1] ?? `<${m[2]}>`).sort();

// tsc already checks that every language has the same keys; this checks what types cannot:
// a translation that drops or renames a {{variable}} or a <0> tag renders it wrong.
describe.each([
  ["pt-BR", ptBR],
  ["es", es],
  ["zh-CN", zhCN],
])("%s", (_, translation) => {
  const english = flatten(en as Tree);
  const other = flatten(translation as Tree);

  it("has every English string, translated", () => {
    expect([...other.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, text] of other) expect(text.trim(), key).not.toBe("");
  });

  it("keeps the placeholders and tags of each string", () => {
    for (const [key, text] of english) expect(placeholders(other.get(key) ?? ""), key).toEqual(placeholders(text));
  });
});
