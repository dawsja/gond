import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// next/font/google downloads the fonts during `next build`, so a flaky fonts.gstatic.com fails the
// image build. The fonts are committed in app/fonts and loaded with next/font/local instead.
const root = join(import.meta.dir, "..");
const self = join("test", "fonts.test.ts");
const sources = [...new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cjs,css,html,json}").scanSync({ cwd: root, dot: true })].filter(
  (path) => !/(^|\/)(node_modules|\.next|out)\//.test(path) && path !== self,
);

test("nothing in the web app fetches fonts from Google", () => {
  const offenders = sources.filter((path) => /next\/font\/google|fonts\.(googleapis|gstatic)\.com/.test(readFileSync(join(root, path), "utf8")));
  expect(offenders).toEqual([]);
});

test("every self-hosted font is committed with its licence", () => {
  const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
  const files = [...layout.matchAll(/src:\s*"\.\/(fonts\/[^"]+\.woff2)"/g)].map(([, path]) => path);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) expect(existsSync(join(root, "app", file))).toBe(true);
  const dir = readdirSync(join(root, "app/fonts"));
  const licences = dir.filter((name) => name.endsWith("OFL.txt"));
  expect(licences.length).toBe(dir.filter((name) => name.endsWith(".woff2")).length);
  for (const licence of licences) expect(readFileSync(join(root, "app/fonts", licence), "utf8")).toContain("SIL Open Font License, Version 1.1");
});
