import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  countPhysicalLinesSaved,
  lexComments,
  readBaseline,
  repoRoot,
  runCli,
  scanRepository,
  scanSource,
  type ScanReport,
} from "../../../scripts/comment-lint.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gond-comment-lint-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFixture(root: string, relPath: string, content: string): Promise<void> {
  const fullPath = join(root, relPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function execCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { code, stdout, stderr };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("language-aware parsing", () => {
  test("TypeScript and TSX ignore strings, regexes, template bodies, and JSX text while capturing JSX comments", () => {
    const source = [
      "#!/usr/bin/env bun",
      "const url = 'https://example.com // not a comment';",
      "const re = /\\/\\/ not a comment \\/* also not *\\//g;",
      "const tpl = `hello ${1 /* inside template expr */ + 2} // literal`;",
      "export function App() {",
      "  return (",
      "    <div>",
      "      https://example.com // jsx text not comment",
      "      /* jsx text not comment */",
      "      {/* single jsx comment */}",
      "      {/*",
      "        multi jsx comment",
      "      */}",
      "      {url /* inline jsx expr */}",
      "    </div>",
      "  );",
      "}",
    ].join("\n");

    const result = scanSource("App.tsx", source, "tsx");
    expect(result.exemptComments.map((c) => c.prefix)).toEqual(["#!"]);
    expect(result.nonExemptComments.map((c) => c.normalizedText)).toEqual([
      "inside template expr",
      "single jsx comment",
      "\nmulti jsx comment\n",
      "inline jsx expr",
    ]);
    expect(result.nonExemptComments[1].kind).toBe("jsx");
    expect(result.nonExemptComments[1].physicalLinesSaved).toBe(1);
    expect(result.nonExemptComments[2].kind).toBe("jsx");
    expect(result.nonExemptComments[2].physicalLinesSaved).toBe(3);
    expect(result.nonExemptComments[3].physicalLinesSaved).toBe(0);
  });

  test("JavaScript distinguishes regex literals from division and comments", () => {
    const source = [
      "function check(a, b, c) {",
      "  const q = a / b / c; // division trailing",
      "  return /https:\\/\\/example\\.com\\/\\*x\\*\\//.test(String(q));",
      "}",
    ].join("\n");

    const result = scanSource("check.mjs", source, "js");
    expect(result.nonExemptComments.map((c) => c.normalizedText)).toEqual(["division trailing"]);
    expect(result.nonExemptComments[0].inline).toBe(true);
    expect(result.nonExemptComments[0].physicalLinesSaved).toBe(0);
  });

  test("Swift handles nested block comments, multiline strings, extended delimiters, interpolation, and MARK", () => {
    const source = [
      "// MARK: Section",
      "// Real note after mark",
      "let a = \"https://example.com // not a comment\"",
      "let b = \"\"\"",
      "  /* not a comment */",
      "  \\(1 /* inside interp */)",
      "\"\"\"",
      "let c = #\"still // not \\\"# closed yet?\"#",
      "let d = #\"extended \\#(2 /* interp in extended */) // not\"#",
      "let e = #\"\"\"",
      "  // multiline extended",
      "\"\"\"#",
      "let rx = #/https://example.com/path/#",
      "/* outer /* nested */ still outer */",
    ].join("\n");

    const result = scanSource("Demo.swift", source, "swift");
    expect(result.exemptComments.map((c) => c.normalizedText)).toEqual(["MARK: Section"]);
    expect(result.nonExemptComments.map((c) => c.normalizedText)).toEqual([
      "Real note after mark",
      "inside interp",
      "interp in extended",
      "outer /* nested */ still outer",
    ]);
  });

  test("Kotlin handles nested block comments, raw strings, templates, char literals, and backtick identifiers", () => {
    const source = [
      "fun `test // backtick name`() {",
      "  val raw = \"\"\"",
      "    // inside raw string",
      "    ${1 /* template expr */}",
      "  \"\"\"\"",
      "  val ch = '/'",
      "  val esc = '\\''",
      "  /* outer /* nested */ end */",
      "  // real line comment",
      "}",
    ].join("\n");

    const result = scanSource("Demo.kt", source, "kotlin");
    expect(result.nonExemptComments.map((c) => c.normalizedText)).toEqual([
      "template expr",
      "outer /* nested */ end",
      "real line comment",
    ]);
  });

  test("Rust handles nested block comments, raw strings, lifetimes, and char literals", () => {
    const source = [
      "pub fn borrow<'a>(s: &'static str) -> &'a str {",
      "    let raw1 = r\"// not a comment\";",
      "    let raw2 = r#\"/* not */ // \"still raw\"\"#;",
      "    let bytes = br#\"// not byte raw\"#;",
      "    let cstr = cr#\"/* not c raw */\"#;",
      "    let quote_char = '\"'; // after quote char",
      "    let esc_char = '\\'';",
      "    /* outer /* nested */ done */",
      "    s",
      "}",
    ].join("\n");

    const result = scanSource("lib.rs", source, "rust");
    expect(result.nonExemptComments.map((c) => c.normalizedText)).toEqual([
      "after quote char",
      "outer /* nested */ done",
    ]);
  });

  test("CSS ignores unquoted url(...) and quoted strings while capturing block comments", () => {
    const source = [
      ".icon {",
      "  background: url(https://example.com/a/*not*/b.png);",
      "  content: \"/* also not */\";",
      "  font-family: '/* single not */';",
      "  /* real css comment */",
      "}",
    ].join("\n");

    const result = scanSource("styles.css", source, "css");
    expect(result.nonExemptComments.map((c) => c.normalizedText)).toEqual(["real css comment"]);
    expect(result.nonExemptComments[0].startLine).toBe(5);
  });

  test("HTML parses HTML comments, embedded CSS, and embedded JS scripts while skipping JSON scripts and attributes", () => {
    const source = [
      "<!doctype html>",
      "<html>",
      "  <head>",
      "    <style>",
      "      /* style note */",
      "      body { background: url(https://example.com/a.png); }",
      "    </style>",
      "  </head>",
      "  <body data-x=\"<!-- not a comment -->\">",
      "    <!-- real html comment -->",
      "    <script type=\"application/json\">",
      "      {\"url\": \"// not js\"}",
      "    </script>",
      "    <script>",
      "      const u = \"https://example.com\"; // real js comment",
      "    </script>",
      "  </body>",
      "</html>",
    ].join("\n");

    const result = scanSource("index.html", source, "html");
    expect(result.nonExemptComments.map((c) => ({
      line: c.startLine,
      lang: c.language,
      text: c.normalizedText,
    }))).toEqual([
      { line: 5, lang: "css", text: "style note" },
      { line: 10, lang: "html", text: "real html comment" },
      { line: 15, lang: "js", text: "real js comment" },
    ]);
  });

  test("XML ignores CDATA, processing instructions, and attribute values while parsing XML comments", () => {
    const source = [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!-- real xml comment -->",
      "<root attr=\"<!-- ignored in attr -->\">",
      "  <![CDATA[<!-- ignored in cdata -->]]>",
      "</root>",
    ].join("\n");

    const result = scanSource("config.xml", source, "xml");
    expect(result.nonExemptComments.map((c) => c.normalizedText)).toEqual(["real xml comment"]);
    expect(result.nonExemptComments[0].startLine).toBe(2);
  });

  test("Shell handles shebang, parameter expansion, quotes, escapes, here-strings, and heredocs", () => {
    const source = [
      "#!/bin/bash",
      "# top note",
      "count=$#",
      "len=${#count}",
      "trimmed=\"${count#:}\"",
      "single='# not a comment'",
      "double=\"# also not\"",
      "escaped=\\#literal",
      "word=foo#bar",
      "grep -q x <<<\"# here-string not heredoc\" # trailing comment",
      "cat <<'EOF' # comment on heredoc line",
      "# inside single-quoted heredoc",
      "EOF",
      "cat <<-END",
      "\t# inside tab-stripped heredoc",
      "\tEND",
      "echo ok; # after semicolon",
    ].join("\n");

    const result = scanSource("run.sh", source, "shell");
    expect(result.exemptComments.map((c) => c.prefix)).toEqual(["#!"]);
    expect(result.nonExemptComments.map((c) => ({
      line: c.startLine,
      text: c.normalizedText,
    }))).toEqual([
      { line: 2, text: "top note" },
      { line: 10, text: "trailing comment" },
      { line: 11, text: "comment on heredoc line" },
      { line: 17, text: "after semicolon" },
    ]);
  });

  test("YAML ignores quoted hashes and non-run block scalars while lexing run block scalars as shell", () => {
    const source = [
      "name: Bot's Build",
      "env:",
      "  COLOR: \"#189c47\"",
      "  SINGLE: '#ffffff'",
      "  URL: https://example.com#anchor",
      "  description: |",
      "    # Markdown heading inside YAML string",
      "    Not a comment",
      "jobs:",
      "  build:",
      "    steps:",
      "      # yaml step comment",
      "      - run: |",
      "          version=\"${TAG#v}\"",
      "          # shell comment line 1",
      "          # shell comment line 2",
      "          cat <<EOF",
      "          # inside heredoc in run",
      "          EOF",
      "          echo \"# quoted in run\"",
    ].join("\n");

    const result = scanSource(".github/workflows/ci.yml", source, "yaml");
    expect(result.nonExemptComments.map((c) => ({
      startLine: c.startLine,
      endLine: c.endLine,
      lang: c.language,
      text: c.normalizedText,
      lines: c.physicalLinesSaved,
    }))).toEqual([
      { startLine: 12, endLine: 12, lang: "yaml", text: "yaml step comment", lines: 1 },
      {
        startLine: 15,
        endLine: 16,
        lang: "shell",
        text: "shell comment line 1\nshell comment line 2",
        lines: 2,
      },
    ]);
  });

  test("TOML ignores hashes inside basic, literal, and multiline strings", () => {
    const source = [
      "# toml header",
      "a = \"# not\"",
      "b = '# not'",
      "c = \"\"\"",
      "# multiline basic",
      "\"\"\"",
      "d = '''",
      "# multiline literal",
      "'''",
      "e = 1 # trailing toml",
    ].join("\n");

    const result = scanSource("Cargo.toml", source, "toml");
    expect(result.nonExemptComments.map((c) => c.normalizedText)).toEqual([
      "toml header",
      "trailing toml",
    ]);
  });

  test("JSONC parses line and block comments outside strings", () => {
    const source = [
      "{",
      "  // jsonc line",
      "  \"url\": \"https://example.com /* not */\",",
      "  /* jsonc block */",
      "  \"ok\": true",
      "}",
    ].join("\n");

    const result = scanSource("wrangler.jsonc", source, "jsonc");
    expect(result.nonExemptComments.map((c) => c.normalizedText)).toEqual([
      "jsonc line",
      "jsonc block",
    ]);
  });

  test("Dockerfile separates parser directives, full-line comments, inline hashes, and heredocs", () => {
    const source = [
      "# syntax=docker/dockerfile:1",
      "# real docker comment",
      "FROM alpine:3.20",
      "RUN sed -i 's#foo#bar#' /etc/hosts \\",
      "  # continuation comment",
      "  && echo ok",
      "COPY <<EOF /tmp/cfg",
      "# file inside copy heredoc",
      "EOF",
    ].join("\n");

    const result = scanSource("Dockerfile", source, "dockerfile");
    expect(result.exemptComments.map((c) => ({ exempt: c.exempt, text: c.normalizedText }))).toEqual([
      { exempt: "directive", text: "syntax=docker/dockerfile:1" },
    ]);
    expect(result.nonExemptComments.map((c) => ({ line: c.startLine, text: c.normalizedText }))).toEqual([
      { line: 2, text: "real docker comment" },
      { line: 5, text: "continuation comment" },
    ]);
  });

  test("ProGuard and properties parse full-line comments and skip continuation lines", () => {
    const proguard = [
      "# keep bridge",
      "-keep class Foo { *; }",
    ].join("\n");
    const props = [
      "# hash comment",
      "! bang comment",
      "key = value \\",
      "  # still part of key value \\",
      "  ! also part of key value",
      "# real comment after continuation",
    ].join("\n");

    expect(scanSource("proguard-rules.pro", proguard, "proguard").nonExemptComments.map((c) => c.normalizedText))
      .toEqual(["keep bridge"]);
    expect(scanSource("gradle.properties", props, "properties").nonExemptComments.map((c) => c.normalizedText))
      .toEqual(["hash comment", "bang comment", "real comment after continuation"]);
  });
});

describe("exemptions, grouping, and generated exclusions", () => {
  test("classifies licenses, directives, and api-doc comments without swallowing adjacent non-exempt comments", () => {
    const tsSource = [
      "// Copyright 2026 Example Inc.",
      "// Licensed under the MIT License.",
      "// See LICENSE for details.",
      "",
      "// eslint-disable-next-line no-console",
      "// explains why console is used",
      "console.log(1);",
      "// @ts-expect-error testing invalid arg",
      "// adjacent explanation",
      "const x = 1;",
      "// global state is NOT an eslint block directive",
      "/* global MY_GLOBAL */",
      "/* #__PURE__ */",
      "/** @openapi */",
      "const mentionCopyrightLater = 1;",
      "// copyright mention after code is not a license header",
    ].join("\n");

    const result = scanSource("sample.ts", tsSource, "ts");
    expect(result.exemptComments.map((c) => ({ reason: c.exempt, line: c.startLine }))).toEqual([
      { reason: "license", line: 1 },
      { reason: "directive", line: 5 },
      { reason: "directive", line: 8 },
      { reason: "directive", line: 12 },
      { reason: "directive", line: 13 },
      { reason: "api-doc", line: 14 },
    ]);
    expect(result.nonExemptComments.map((c) => ({ line: c.startLine, text: c.normalizedText }))).toEqual([
      { line: 6, text: "explains why console is used" },
      { line: 9, text: "adjacent explanation" },
      { line: 11, text: "global state is NOT an eslint block directive" },
      { line: 16, text: "copyright mention after code is not a license header" },
    ]);
  });

  test("SPDX comment does not swallow an immediately following non-license comment", () => {
    const source = [
      "// SPDX-License-Identifier: MIT",
      "// Starts the worker loop",
      "export const start = () => {};",
    ].join("\n");

    const result = scanSource("worker.ts", source, "ts");
    expect(result.exemptComments.map((c) => c.exempt)).toEqual(["license"]);
    expect(result.nonExemptComments.map((c) => c.normalizedText)).toEqual(["Starts the worker loop"]);
  });

  test("top-of-file Open Font License header is classified as exempt license", () => {
    const source = [
      "/* Kept in step with tokens. */",
      "",
      "/* Inter, as the web app uses (SIL Open Font License, see fonts/OFL.txt). */",
      "@font-face { font-family: Inter; }",
      "/* Mentions Open Font License after code. */",
    ].join("\n");

    const result = scanSource("connect.css", source, "css");
    expect(result.exemptComments.map((c) => ({ exempt: c.exempt, line: c.startLine }))).toEqual([
      { exempt: "license", line: 3 },
    ]);
    expect(result.nonExemptComments.map((c) => c.startLine)).toEqual([1, 5]);
  });

  test("Rust doc comments are exempt only in crates or files enforcing missing_docs", async () => {
    const dir = await makeTempDir();
    await writeFixture(
      dir,
      "strict-crate/Cargo.toml",
      "[package]\nname = \"strict\"\nversion = \"0.1.0\"\n",
    );
    await writeFixture(
      dir,
      "strict-crate/src/lib.rs",
      "#![deny(missing_docs)]\nmod child;\n/// Root doc\npub fn root() {}\n",
    );
    await writeFixture(
      dir,
      "strict-crate/src/child.rs",
      "/// Child doc\npub fn child() {}\n// Regular comment\n",
    );
    await writeFixture(
      dir,
      "normal-crate/Cargo.toml",
      "[package]\nname = \"normal\"\nversion = \"0.1.0\"\n",
    );
    await writeFixture(
      dir,
      "normal-crate/src/lib.rs",
      "// #![deny(missing_docs)]\n/// Not required doc\npub fn helper() {}\n",
    );

    const { results } = await scanRepository(dir);
    const byFile = new Map(results.map((r) => [r.file, r]));

    expect(byFile.get("strict-crate/src/lib.rs")!.exemptComments.map((c) => c.exempt)).toEqual(["api-doc"]);
    expect(byFile.get("strict-crate/src/lib.rs")!.nonExemptComments).toHaveLength(0);
    expect(byFile.get("strict-crate/src/child.rs")!.exemptComments.map((c) => c.exempt)).toEqual(["api-doc"]);
    expect(byFile.get("strict-crate/src/child.rs")!.nonExemptComments.map((c) => c.normalizedText)).toEqual([
      "Regular comment",
    ]);
    expect(byFile.get("normal-crate/src/lib.rs")!.exemptComments).toHaveLength(0);
    expect(byFile.get("normal-crate/src/lib.rs")!.nonExemptComments).toHaveLength(2);
  });

  test("excludes generated files by header comment and excluded paths, but ignores @generated in code strings", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, "gen.ts", "// @generated by tool\n// extra comment\nexport const a = 1;\n");
    await writeFixture(dir, "real.ts", "export const marker = '@generated';\n// real comment\n");
    await writeFixture(dir, "apps/desktop/src-tauri/icons/icon.xml", "<!-- icon comment -->\n<root/>\n");
    await writeFixture(dir, ".agents/skills/demo/agent.yml", "# skill comment\nname: demo\n");
    await writeFixture(dir, "apps/web/next-env.d.ts", "/// <reference types=\"next\" />\n// comment\n");
    await writeFixture(dir, "node_modules/pkg/index.js", "// vendored\n");

    const { results, report } = await scanRepository(dir);
    expect(results.map((r) => r.file)).toEqual(["real.ts"]);
    expect(report.filesSkippedGenerated).toEqual(["gen.ts"]);
    expect(report.nonExemptCount).toBe(1);
  });

  test("groups consecutive standalone line comments only when indent and prefix match", () => {
    const source = [
      "  // group A line 1",
      "  // group A line 2",
      "    // deeper indent",
      "  /// triple slash",
      "  // separate after triple",
      "",
      "  // after blank line",
      "const x = 1; // inline 1",
      "// standalone right below inline",
    ].join("\n");

    const result = scanSource("grouping.ts", source, "ts");
    expect(result.nonExemptComments.map((c) => ({
      lines: [c.startLine, c.endLine],
      text: c.normalizedText,
    }))).toEqual([
      { lines: [1, 2], text: "group A line 1\ngroup A line 2" },
      { lines: [3, 3], text: "deeper indent" },
      { lines: [4, 4], text: "triple slash" },
      { lines: [5, 5], text: "separate after triple" },
      { lines: [7, 7], text: "after blank line" },
      { lines: [8, 8], text: "inline 1" },
      { lines: [9, 9], text: "standalone right below inline" },
    ]);
  });
});

describe("physical line savings calculation", () => {
  test("computes exact physical lines saved for standalone, multiline, JSX, inline, and shared-line comments", () => {
    const source = [
      "// single standalone",
      "const top = 0;",
      "// grouped 1",
      "// grouped 2",
      "/*",
      "block 1",
      "",
      "block 2",
      "*/",
      "const a = 1; // inline saves zero",
      "  /* first */   /* second */  ",
      "const el = (",
      "  <div>",
      "    {/* jsx single */}",
      "    {/*",
      "      jsx multi",
      "    */}",
      "    <span>{/* inline jsx */}</span>",
      "  </div>",
      ");",
    ].join("\n");

    const result = scanSource("lines.tsx", source, "tsx");
    const byLine = new Map(result.nonExemptComments.map((c) => [`${c.startLine}-${c.endLine}`, c]));

    expect(byLine.get("1-1")!.physicalLinesSaved).toBe(1);
    expect(byLine.get("3-4")!.physicalLinesSaved).toBe(2);
    expect(byLine.get("5-9")!.physicalLinesSaved).toBe(5);
    expect(byLine.get("10-10")!.physicalLinesSaved).toBe(0);
    expect(byLine.get("14-14")!.physicalLinesSaved).toBe(1);
    expect(byLine.get("15-17")!.physicalLinesSaved).toBe(3);
    expect(byLine.get("18-18")!.physicalLinesSaved).toBe(0);

    const sharedLineComments = result.nonExemptComments.filter((c) => c.startLine === 11);
    expect(sharedLineComments).toHaveLength(2);
    expect(sharedLineComments[0].physicalLinesSaved).toBe(0);
    expect(sharedLineComments[1].physicalLinesSaved).toBe(0);
    expect(countPhysicalLinesSaved(source, sharedLineComments)).toBe(1);

    expect(result.estimatedLinesSaved).toBe(1 + 2 + 5 + 0 + 1 + 1 + 3 + 0);
  });
});

describe("baseline and ratchet end-to-end", () => {
  test("passes existing baselined comments and tolerates moving or re-indenting a comment in the same file", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, "src/a.ts", "// alpha comment\nexport const a = 1;\n");
    await writeFixture(dir, "src/b.ts", "// beta comment\nexport const b = 2;\n");

    const init = await execCli(["--root", dir, "--write-baseline"]);
    expect(init.code).toBe(0);

    const initialCheck = await execCli(["--root", dir]);
    expect(initialCheck.code).toBe(0);

    await writeFixture(
      dir,
      "src/a.ts",
      "export function wrap() {\n  if (true) {\n    // alpha comment\n    return 1;\n  }\n}\n",
    );
    const movedCheck = await execCli(["--root", dir]);
    expect(movedCheck.code).toBe(0);
  });

  test("deleting a baselined comment fails check mode, and --update shrinks the baseline by 1", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, "src/a.ts", "// keep me\nexport const a = 1;\n// delete me\nexport const b = 2;\n");

    expect((await execCli(["--root", dir, "--write-baseline"])).code).toBe(0);

    await writeFixture(dir, "src/a.ts", "// keep me\nexport const a = 1;\nexport const b = 2;\n");

    const checkAfterDelete = await execCli(["--root", dir]);
    expect(checkAfterDelete.code).toBe(1);
    expect(checkAfterDelete.stderr).toContain("stale baseline entry");

    const update = await execCli(["--root", dir, "--update"]);
    expect(update.code).toBe(0);

    const { baseline } = await readBaseline(join(dir, "scripts/comment-baseline.json"));
    expect(baseline.files["src/a.ts"]).toHaveLength(1);
    expect(baseline.files["src/a.ts"][0].preview).toBe("keep me");

    expect((await execCli(["--root", dir])).code).toBe(0);
  });

  test("swapping a baselined comment for a different comment fails check and --update in same file and across files", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, "src/a.ts", "// original A\nexport const a = 1;\n");
    await writeFixture(dir, "src/b.ts", "// original B\nexport const b = 2;\n");

    expect((await execCli(["--root", dir, "--write-baseline"])).code).toBe(0);
    const baselinePath = join(dir, "scripts/comment-baseline.json");
    const baselineBefore = await readFile(baselinePath, "utf8");

    await writeFixture(dir, "src/a.ts", "// replacement A\nexport const a = 1;\n");

    const sameFileCheck = await execCli(["--root", dir]);
    expect(sameFileCheck.code).toBe(1);
    expect(sameFileCheck.stderr).toContain("new non-exempt comment");
    expect(sameFileCheck.stderr).toContain("stale baseline entry");

    const sameFileUpdate = await execCli(["--root", dir, "--update"]);
    expect(sameFileUpdate.code).toBe(1);
    expect(sameFileUpdate.stderr).toContain("cannot be added to the baseline");
    expect(await readFile(baselinePath, "utf8")).toBe(baselineBefore);

    await writeFixture(dir, "src/a.ts", "export const a = 1;\n");
    await writeFixture(dir, "src/b.ts", "// original B\nexport const b = 2;\n// brand new in B\n");

    const crossFileCheck = await execCli(["--root", dir]);
    expect(crossFileCheck.code).toBe(1);
    expect(crossFileCheck.stderr).toContain("src/b.ts:3: new non-exempt comment");
    expect(crossFileCheck.stderr).toContain("src/a.ts: stale baseline entry");

    const crossFileUpdate = await execCli(["--root", dir, "--update"]);
    expect(crossFileUpdate.code).toBe(1);
    expect(await readFile(baselinePath, "utf8")).toBe(baselineBefore);
  });

  test("adding a duplicate copy of an existing baselined comment fails check and --update", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, "src/a.ts", "// repeated note\nexport const a = 1;\n");

    expect((await execCli(["--root", dir, "--write-baseline"])).code).toBe(0);

    await writeFixture(
      dir,
      "src/a.ts",
      "// repeated note\nexport const a = 1;\n// repeated note\nexport const b = 2;\n",
    );

    const dupCheck = await execCli(["--root", dir]);
    expect(dupCheck.code).toBe(1);
    expect(dupCheck.stderr).toContain("new non-exempt comment");

    const dupUpdate = await execCli(["--root", dir, "--update"]);
    expect(dupUpdate.code).toBe(1);
  });

  test("adding an exempt comment passes without changing the baseline", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, "src/a.ts", "// existing note\nexport const a = 1;\n");

    expect((await execCli(["--root", dir, "--write-baseline"])).code).toBe(0);
    const baselinePath = join(dir, "scripts/comment-baseline.json");
    const baselineBefore = await readFile(baselinePath, "utf8");

    await writeFixture(
      dir,
      "src/a.ts",
      "// existing note\n// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const a: any = 1;\n",
    );

    const check = await execCli(["--root", dir]);
    expect(check.code).toBe(0);
    expect(await readFile(baselinePath, "utf8")).toBe(baselineBefore);
  });

  test("report-json outputs accurate metrics and scoped path checks leave out-of-scope baseline entries untouched", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, "pkg-a/a.ts", "// comment A\nexport const a = 1;\n");
    await writeFixture(dir, "pkg-b/b.ts", "// comment B\nexport const b = 2;\n");

    expect((await execCli(["--root", dir, "--write-baseline"])).code).toBe(0);

    const reportRun = await execCli(["--root", dir, "--report-json"]);
    expect(reportRun.code).toBe(0);
    const report = JSON.parse(reportRun.stdout) as ScanReport;
    expect(report.filesScanned).toBe(2);
    expect(report.nonExemptCount).toBe(2);
    expect(report.estimatedTotalLinesSaved).toBe(2);

    await writeFixture(dir, "pkg-a/a.ts", "export const a = 1;\n");
    expect((await execCli(["--root", dir, "pkg-b"])).code).toBe(0);
    expect((await execCli(["--root", dir, "pkg-a"])).code).toBe(1);
    expect((await execCli(["--root", dir, "--update", "pkg-a"])).code).toBe(0);

    const { baseline } = await readBaseline(join(dir, "scripts/comment-baseline.json"));
    expect(baseline.files["pkg-a/a.ts"]).toBeUndefined();
    expect(baseline.files["pkg-b/b.ts"]).toHaveLength(1);
  });

  test("git discovery respects .gitignore and tolerates unstaged deleted tracked files", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, ".gitignore", "ignored.ts\n");
    await writeFixture(dir, "tracked.ts", "// tracked note\nexport const a = 1;\n");
    await writeFixture(dir, "deleted.ts", "// deleted note\nexport const d = 2;\n");
    await writeFixture(dir, "ignored.ts", "// ignored note\nexport const i = 3;\n");

    const runGit = (args: string[]) => {
      const proc = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode, args.join(" ")).toBe(0);
    };
    runGit(["init", "-q"]);
    runGit(["add", ".gitignore", "tracked.ts", "deleted.ts"]);
    await writeFixture(dir, "untracked.ts", "// untracked note\nexport const u = 4;\n");
    await rm(join(dir, "deleted.ts"));

    const { results } = await scanRepository(dir);
    expect(results.map((r) => r.file)).toEqual(["tracked.ts", "untracked.ts"]);
  });

  test("CLI entrypoint runs via bun subprocess", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, "a.ts", "// hello\nexport const x = 1;\n");

    const writeProc = Bun.spawnSync(
      ["bun", join(repoRoot, "scripts/comment-lint.ts"), "--root", dir, "--write-baseline"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(writeProc.exitCode).toBe(0);

    const checkProc = Bun.spawnSync(
      ["bun", join(repoRoot, "scripts/comment-lint.ts"), "--root", dir],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(checkProc.exitCode).toBe(0);
  });
});

describe("comment-lint own files stay clean", () => {
  test("comment-lint implementation and test files have zero non-exempt comments and zero em dashes", async () => {
    const ownedFiles = [
      "scripts/comment-lint.ts",
      "scripts/comments/types.ts",
      "scripts/comments/discover.ts",
      "scripts/comments/ts-lexer.ts",
      "scripts/comments/lexers.ts",
      "scripts/comments/exempt.ts",
      "scripts/comments/metrics.ts",
      "scripts/comments/baseline.ts",
      "packages/shared/test/comment-lint.test.ts",
    ];
    for (const relPath of ownedFiles) {
      const source = await readFile(join(repoRoot, relPath), "utf8");
      expect(source.includes("\u2014"), `${relPath} must not contain em dash`).toBe(false);
      expect(lexComments(source, "ts"), `${relPath} must not contain comments`).toHaveLength(0);
    }
  });
});
