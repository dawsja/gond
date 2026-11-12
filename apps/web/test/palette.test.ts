import { ACCENTS, DEFAULT_ACCENT } from "@gond/shared";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, over } from "../lib/theme/contrast";
import { THEME_BACKGROUNDS, THEMES } from "../lib/theme/theme";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const css = read("app/globals.css");

type Tokens = Record<string, string>;

/** Every `--name: value;` of each innermost rule, by selector, in source order. */
function rules(source: string): Map<string, Tokens> {
  const found = new Map<string, Tokens>();
  const plain = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector, body] of plain.matchAll(/([^{}\n][^{}]*?)\s*\{([^{}]*)\}/g)) {
    const tokens = found.get(selector.trim()) ?? {};
    for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens[name] = value.trim();
    found.set(selector.trim(), tokens);
  }
  return found;
}

const blocks = rules(css);

function block(selector: string): Tokens {
  const tokens = blocks.get(selector);
  if (!tokens) throw new Error(`globals.css has no ${selector} block`);
  return tokens;
}

/** A token's colour with every var() followed, lower-case six-digit hex. */
function colour(tokens: Tokens, name: string): string {
  let value = tokens[name];
  for (let hops = 0; value?.startsWith("var(--"); hops++) {
    if (hops > 10) throw new Error(`--${name} loops`);
    value = tokens[value.slice(6, -1)];
  }
  if (!value || !/^#[\da-f]{6}$/i.test(value)) throw new Error(`--${name} is not a hex colour: ${tokens[name]}`);
  return value.toLowerCase();
}

const light = block(":root");
const themes = {
  light,
  dark: { ...light, ...block(".dark") },
};
type ThemeName = keyof typeof themes;

const accentSelector = (theme: ThemeName, accent: string) => `${theme === "dark" ? ":root.dark" : ":root:not(.dark)"}[data-accent="${accent}"]`;
const withAccent = (theme: ThemeName, accent: string) => ({ ...themes[theme], ...block(accentSelector(theme, accent)) });

/** The wash a destructive button, badge or bubble sits on (`bg-destructive/10`, `dark:bg-destructive/20`). */
const DESTRUCTIVE_WASH: Record<ThemeName, number> = { light: 0.1, dark: 0.2 };
/** The focus outline and ring everywhere but a bubble: `outline-ring/50`, `ring-ring/50`. */
const RING_ALPHA = 0.5;

function ratios(fg: string, surfaces: Record<string, string>) {
  return Object.fromEntries(Object.entries(surfaces).map(([name, bg]) => [name, Number(contrast(fg, bg).toFixed(2))]));
}

function atLeast(min: number, measured: Record<string, number>) {
  const failing = Object.fromEntries(Object.entries(measured).filter(([, ratio]) => ratio < min));
  expect(failing).toEqual({});
}

for (const theme of ["light", "dark"] as const) {
  describe(`${theme} palette`, () => {
    const t = themes[theme];
    const c = (name: string) => colour(t, name);
    const page = c("background");

    test("body text clears 4.5:1 on the page, cards, popovers and the sidebar", () => {
      atLeast(4.5, ratios(c("foreground"), { page, card: c("card"), popover: c("popover"), sidebar: c("sidebar"), selectedRow: c("sidebar-accent") }));
      atLeast(4.5, ratios(c("sidebar-foreground"), { sidebar: c("sidebar"), selectedRow: c("sidebar-accent") }));
    });

    test("muted and faint text clear 4.5:1 on the page, cards, the muted fill and the sidebar", () => {
      const surfaces = { page, card: c("card"), muted: c("muted"), sidebar: c("sidebar"), bubbleBot: c("bubble-bot") };
      atLeast(4.5, ratios(c("muted-foreground"), surfaces));
      atLeast(4.5, ratios(c("ash"), surfaces));
    });

    test("the focus ring clears 3:1 on the page, cards and the sidebar", () => {
      const ring = c("ring");
      const surfaces = { page, card: c("card"), sidebar: c("sidebar"), muted: c("muted") };
      atLeast(3, Object.fromEntries(Object.entries(surfaces).map(([name, bg]) => [name, Number(contrast(over(ring, RING_ALPHA, bg), bg).toFixed(2))])));
    });

    test("destructive text clears 4.5:1 on the page, cards and its own wash", () => {
      const red = c("destructive");
      const surfaces = { page, card: c("card"), muted: c("muted") };
      atLeast(4.5, ratios(red, surfaces));
      atLeast(4.5, Object.fromEntries(Object.entries(surfaces).map(([name, bg]) => [`wash on ${name}`, Number(contrast(red, over(red, DESTRUCTIVE_WASH[theme], bg)).toFixed(2))])));
    });

    test("the browser bar and first paint use the page colour", () => {
      expect<string>(THEME_BACKGROUNDS[theme]).toBe(page);
    });

    test("with no accent set yet, the page draws the default accent", () => {
      const fallback = block(accentSelector(theme, DEFAULT_ACCENT));
      for (const name of Object.keys(fallback)) expect([name, colour(t, name)]).toEqual([name, colour(fallback, name)]);
    });

    for (const accent of ACCENTS) {
      test(`${accent}: white on solid and ink on wash clear 4.6:1, the edge 3:1 on the page`, () => {
        const a = withAccent(theme, accent);
        const ac = (name: string) => colour(a, name);
        atLeast(4.6, { whiteOnSolid: Number(contrast("#ffffff", ac("tint-solid")).toFixed(2)) });
        atLeast(4.6, { inkOnWash: Number(contrast(ac("tint-ink"), ac("tint-wash")).toFixed(2)) });
        atLeast(4.5, ratios(ac("tint-ink"), { page, card: c("card") }));
        atLeast(3, ratios(ac("tint-edge"), { page }));
        atLeast(4.5, ratios(ac("bubble-you-foreground"), { bubbleYou: ac("bubble-you") }));
        // A bubble's ring is solid and drawn at its edge, against the bubble itself.
        atLeast(3, ratios(ac("ring"), { bubbleYou: ac("bubble-you"), page }));
      });
    }
  });
}

// A ring at half strength sits under 3:1 against a coloured bubble (about 2:1 on the blue one), so a
// bubble's rings are solid: the focus ring of a bubble that is a button or link, and the ring on a
// message a search or a quote jumped to.
test("a bubble's rings are drawn solid", () => {
  const bubble = read("components/ui/bubble.tsx");
  expect(bubble).toContain("focus-visible:ring-ring");
  expect(bubble).not.toMatch(/focus-visible:ring-ring\//);
  expect(read("components/conversation.tsx")).toMatch(/^const RINGED = "ring-2 ring-ring";$/m);
});

test("the Gond theme is gone", () => {
  expect(THEMES as readonly string[]).not.toContain("gond");
  expect(css).not.toMatch(/data-theme=["']?gond/);
  expect(read("components/appearance-card.tsx")).not.toMatch(/\bgond:\s*\{/);
});

test("the manifest's colours are the light page's", () => {
  const manifest = read("app/manifest.ts");
  expect(manifest).toContain(`background_color: "${THEME_BACKGROUNDS.light}"`);
  expect(manifest).toContain(`theme_color: "${THEME_BACKGROUNDS.light}"`);
});

/** Each app's Connect screen keeps its own copy of the page's colours (CLAUDE.md, "The apps around the web app"). */
test("the native shells' copies of the page colours match the web's", () => {
  const app = (path: string) => readFileSync(join(root, "..", path), "utf8").toLowerCase();
  const l = (name: string) => colour(themes.light, name);
  const d = (name: string) => colour(themes.dark, name);
  const android = app("android/app/src/main/res/values/colors.xml");
  const androidNight = app("android/app/src/main/res/values-night/colors.xml");
  for (const [xml, c] of [[android, l], [androidNight, d]] as const) {
    for (const [res, token] of [["background", "background"], ["foreground", "foreground"], ["card", "card"], ["muted_foreground", "muted-foreground"], ["destructive", "destructive"], ["input", "input"]]) {
      expect([res, xml.match(new RegExp(`name="${res}">(#[\\da-f]{6})<`))?.[1]]).toEqual([res, c(token)]);
    }
  }
  const connect = app("desktop/src/connect.css");
  const [connectLight, connectDark] = connect.split("prefers-color-scheme: dark");
  for (const [text, c] of [[connectLight, l], [connectDark, d]] as const) {
    for (const token of ["background", "foreground", "card", "muted-foreground", "destructive", "input"]) {
      expect([token, text.match(new RegExp(`--${token}: (#[\\da-f]{6});`))?.[1]]).toEqual([token, c(token)]);
    }
  }
  const swift = app("ios/Gond/Theme.swift");
  for (const [name, token] of [["foreground", "foreground"], ["muted", "muted-foreground"], ["destructive", "destructive"]]) {
    const [, lightHex, darkHex] = swift.match(new RegExp(`let ${name} = dynamic\\(light: 0x([\\da-f]{6}), dark: 0x([\\da-f]{6})\\)`)) ?? [];
    expect([name, `#${lightHex}`, `#${darkHex}`]).toEqual([name, l(token), d(token)]);
  }
  const colorset = app("ios/Gond/Assets.xcassets/Background.colorset/Contents.json");
  const hexes = [...colorset.matchAll(/"red" : "0x(..)", "green" : "0x(..)", "blue" : "0x(..)"/g)].map(([, r, g, b]) => `#${r}${g}${b}`);
  expect(hexes).toEqual([l("background"), d("background")]);
  const window = app("desktop/src-tauri/src/lib.rs");
  const rgb = (name: string) => window.match(new RegExp(`const ${name}: color = color\\(0x(..), 0x(..), 0x(..), 0xff\\)`))?.slice(1).join("");
  expect([`#${rgb("light")}`, `#${rgb("dark")}`]).toEqual([l("background"), d("background")]);
});
