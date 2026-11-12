import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { applyTheme, isTheme, readStoredTheme, resolveTheme, THEME_BACKGROUNDS, THEME_INIT_SCRIPT, THEMES, type Theme } from "../lib/theme/theme";

function browser(stored: string | null, deviceDark: boolean) {
  const attributes = new Map<string, string>();
  const classes = new Set<string>();
  const meta = { setAttribute: (key: string, value: string) => attributes.set(`meta:${key}`, value) };
  const root = {
    classList: { toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name) },
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    style: { fontSize: "" },
  };
  const saved = new Map<string, string>(stored === null ? [] : [["gond-theme", stored]]);
  const localStorage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
  };
  const matchMedia = () => ({ matches: deviceDark });
  const document = { documentElement: root, querySelectorAll: () => [meta] };
  return { attributes, classes, saved, globals: { document, localStorage, matchMedia, window: { localStorage, matchMedia } } };
}

function withBrowser<T>(globals: ReturnType<typeof browser>["globals"], run: () => T): T {
  const keys = ["window", "document"] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  try {
    keys.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, value: globals[key] }));
    return run();
  } finally {
    keys.forEach((key, i) => {
      const descriptor = previous[i];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

test("the retired Gond theme opens dark on any device and is saved as Dark", () => {
  expect(THEMES).toEqual(["system", "light", "dark"]);
  expect(isTheme("gond")).toBe(false);
  expect(isTheme("unknown")).toBe(false);
  for (const device of [false, true]) {
    const firstPaint = browser("gond", device);
    runInNewContext(THEME_INIT_SCRIPT, firstPaint.globals);
    expect(firstPaint.classes.has("dark")).toBe(true);
    expect(firstPaint.attributes.get("data-theme")).toBe("dark");
    expect(firstPaint.attributes.get("meta:content")).toBe(THEME_BACKGROUNDS.dark);
    expect(firstPaint.saved.get("gond-theme")).toBe("dark");

    const runtime = browser("gond", device);
    withBrowser(runtime.globals, () => {
      expect(readStoredTheme()).toBe("dark");
      expect(resolveTheme("system")).toBe(device ? "dark" : "light");
    });
    expect(runtime.saved.get("gond-theme")).toBe("dark");
  }
});

test("a retired theme still opens dark when storage can't be written", () => {
  const mock = browser("gond", false);
  mock.globals.localStorage.setItem = () => { throw new Error("Storage full"); };
  runInNewContext(THEME_INIT_SCRIPT, mock.globals);
  expect(mock.classes.has("dark")).toBe(true);
  expect(mock.attributes.get("data-theme")).toBe("dark");
  withBrowser(mock.globals, () => expect(readStoredTheme()).toBe("dark"));
});

test("initial paint agrees with runtime across saved themes and device schemes", () => {
  for (const theme of ["system", "light", "dark"] satisfies Theme[]) {
    for (const device of [false, true]) {
      const firstPaint = browser(theme, device);
      runInNewContext(THEME_INIT_SCRIPT, firstPaint.globals);
      const runtime = browser(theme, device);
      withBrowser(runtime.globals, () => applyTheme(resolveTheme(theme), theme));
      expect([...firstPaint.classes]).toEqual([...runtime.classes]);
      expect([...firstPaint.attributes]).toEqual([...runtime.attributes]);
    }
  }
});

test("switching themes restores the correct browser bar color", () => {
  const mock = browser("dark", false);
  withBrowser(mock.globals, () => {
    applyTheme(resolveTheme("dark"), "dark");
    expect(mock.attributes.get("data-theme")).toBe("dark");
    expect(mock.attributes.get("meta:content")).toBe("#0c0c0c");
    applyTheme(resolveTheme("light"), "light");
    expect(mock.classes.has("dark")).toBe(false);
    expect(mock.attributes.get("meta:content")).toBe("#f6f7f9");
  });
});

test("invalid or unavailable storage falls back to the device scheme", () => {
  for (const stored of [null, "invalid"]) {
    const mock = browser(stored, true);
    runInNewContext(THEME_INIT_SCRIPT, mock.globals);
    expect(mock.attributes.get("data-theme")).toBe("system");
    expect(mock.classes.has("dark")).toBe(true);
    withBrowser(mock.globals, () => expect(readStoredTheme()).toBe("system"));
  }
  const blocked = browser(null, true);
  blocked.globals.localStorage.getItem = () => { throw new Error("Storage blocked"); };
  runInNewContext(THEME_INIT_SCRIPT, blocked.globals);
  expect(blocked.classes.has("dark")).toBe(true);
  expect(blocked.attributes.get("data-theme")).toBe("system");
  withBrowser(blocked.globals, () => expect(readStoredTheme()).toBe("system"));
});
