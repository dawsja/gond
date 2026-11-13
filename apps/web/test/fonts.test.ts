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
const files = readdirSync(join(root, "app/fonts"));
const faces = readFileSync(join(root, "app/fonts.ts"), "utf8")
  .split("localFont(")
  .slice(1)
  .map((call) => ({ call, src: /src: "\.\/(fonts\/[^"]+\.woff2)"/.exec(call)?.[1] }));

test("nothing in the web app fetches fonts from Google", () => {
  const offenders = sources.filter((path) => /next\/font\/google|fonts\.(googleapis|gstatic)\.com/.test(readFileSync(join(root, path), "utf8")));
  expect(offenders).toEqual([]);
});

test("every committed font is loaded, and only from its own unicode-range", () => {
  expect(faces.map((face) => face.src).sort()).toEqual(files.filter((name) => name.endsWith(".woff2")).map((name) => `fonts/${name}`).sort());
  for (const face of faces) {
    expect(existsSync(join(root, "app", face.src ?? ""))).toBe(true);
    expect(face.call).toContain('prop: "unicode-range"');
  }
  // A latin page downloads only the two preloaded latin files.
  expect(faces.filter((face) => !face.call.includes("preload: false")).map((face) => face.src)).toEqual(["fonts/inter-latin-wght.woff2", "fonts/jetbrains-mono-latin-wght.woff2"]);
});

test("every committed font sits next to its family's licence", () => {
  const letters = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "");
  const licences = files.filter((name) => name.endsWith("-OFL.txt"));
  for (const licence of licences) expect(readFileSync(join(root, "app/fonts", licence), "utf8")).toContain("SIL Open Font License, Version 1.1");
  for (const font of files.filter((name) => name.endsWith(".woff2"))) {
    expect(licences.filter((licence) => letters(font).startsWith(letters(licence.replace("-OFL.txt", ""))))).toHaveLength(1);
  }
});

test("a glyph no face has falls to a generic family, never the browser's serif", () => {
  const theme = readFileSync(join(root, "app/globals.css"), "utf8");
  for (const [name, generic] of [["sans", "sans-serif"], ["heading", "sans-serif"], ["mono", "monospace"]]) {
    expect(new RegExp(`--font-${name}:[^;]*,\\s*${generic};`).test(theme)).toBe(true);
  }
});
