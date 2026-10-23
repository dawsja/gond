import { describe, expect, test } from "bun:test";
import type { Blockquote, Code, Link, List, Table } from "mdast";
import { badgeOf, calloutOf, choicesOf, meterOf, parseInline, parseMarkdown, plainText, safeHref, sourceOf } from "../lib/markdown";

const types = (nodes: { type: string }[]) => nodes.map((n) => n.type);

describe("markdown", () => {
  test("a lone ~ is text, so a pasted shell prompt isn't struck through; ~~two~~ still is", () => {
    const pasted = parseMarkdown("root@golem:~# curl -fsSL https://example.com/install.sh | sh\nInstalled /usr/local/bin/tadpole\nroot@golem:~#");
    expect(JSON.stringify(pasted)).not.toContain('"delete"');
    expect(types(parseInline("this is ~~gone~~ now"))).toEqual(["text", "delete", "text"]);
  });
  test("inline code, bold and links", () => {
    expect(types(parseInline("run `ls` **now** [docs](https://example.com)"))).toEqual(["text", "inlineCode", "text", "strong", "text", "link"]);
  });
  test("a bare URL is a link, without the sentence's punctuation", () => {
    const inlines = parseInline("sign in here: https://example.com/a?b=1.");
    expect(types(inlines)).toEqual(["text", "link", "text"]);
    const link = inlines[1] as Link;
    expect(link.url).toBe("https://example.com/a?b=1");
    expect(plainText(link)).toBe("https://example.com/a?b=1");
    expect(inlines.at(-1)).toMatchObject({ type: "text", value: "." });
  });
  test("a bare URL keeps the brackets it opened and drops the ones it didn't", () => {
    expect((parseInline("(https://example.com/a)")[1] as Link).url).toBe("https://example.com/a");
    expect((parseInline("https://en.wikipedia.org/wiki/Foo_(bar)")[0] as Link).url).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
  });
  test("a URL inside a Markdown link stays one link", () => {
    const inlines = parseInline("[docs](https://example.com/a) and https://example.com/b");
    expect(types(inlines)).toEqual(["link", "text", "link"]);
    expect(plainText(inlines[0]!)).toBe("docs");
  });
  test("an autolink in angle brackets is a link", () => {
    const [link] = parseInline("<https://x.com>");
    expect(link).toMatchObject({ type: "link", url: "https://x.com" });
  });
  test("a pipe table becomes a table, aligned, and a short row keeps its cells", () => {
    const { children } = parseMarkdown("| Account | Value |\n|---|--:|\n| Roth IRA | $0.00 |\n| Agentic |");
    expect(types(children)).toEqual(["table"]);
    const table = children[0] as Table;
    expect(table.align).toEqual([null, "right"]);
    expect(table.children).toHaveLength(3);
    expect(table.children[0]?.children).toHaveLength(2);
    expect(table.children[2]?.children).toHaveLength(1);
  });
  test("a table ends at a blank line and the text after it is its own block", () => {
    expect(types(parseMarkdown("| A |\n|---|\n| 1 |\n\nAfter the table.").children)).toEqual(["table", "paragraph"]);
  });
  test("strikethrough", () => {
    expect(types(parseInline("~~gone~~ now"))).toEqual(["delete", "text"]);
  });
  test("blocks", () => {
    expect(types(parseMarkdown("# Title\n\n- one\n- two\n\n```sh\nls\n```").children)).toEqual(["heading", "list", "code"]);
  });
  test("headings go down to six", () => {
    const { children } = parseMarkdown("#### four\n##### five\n###### six");
    expect(children.map((n) => (n as { depth: number }).depth)).toEqual([4, 5, 6]);
  });
  test("backslash escapes show the character, not the markup", () => {
    expect(plainText(parseInline("2 \\* 3 = 6 and \\_x\\_"))).toBe("2 * 3 = 6 and _x_");
  });
  test("an image is its link, and <br> is a line break", () => {
    const inlines = parseInline("![chart](https://example.com/c.png)<br>next");
    expect(inlines[0]).toMatchObject({ type: "image", url: "https://example.com/c.png", alt: "chart" });
    expect(inlines[1]).toMatchObject({ type: "html", value: "<br>" });
    expect(plainText(inlines)).toBe("chart\nnext");
  });
  test("a hard break is a break", () => {
    expect(types(parseInline("a\\\nb"))).toEqual(["text", "break", "text"]);
    expect(types(parseInline("a  \nb"))).toEqual(["text", "break", "text"]);
  });
  test("nested lists keep their depth however far they are indented, and numbers where they start", () => {
    const [list] = parseMarkdown("3. three\n    - four spaces\n        - eight\n4. four").children as List[];
    expect(list).toMatchObject({ type: "list", ordered: true, start: 3 });
    expect(list!.children).toHaveLength(2);
    const nested = list!.children[0]!.children[1] as List;
    expect(nested).toMatchObject({ type: "list", ordered: false });
    expect(nested.children[0]!.children[1]).toMatchObject({ type: "list" });
  });
  test("task list items", () => {
    const [list] = parseMarkdown("- [x] done\n- [ ] to do").children as List[];
    expect(list!.children.map((i) => i.checked)).toEqual([true, false]);
    expect(plainText(list!.children[0]!)).toBe("done");
  });
  test("an indented paragraph after a blank line stays in its list item", () => {
    const { children } = parseMarkdown("1. First\n\n   More on the first.\n2. Second");
    expect(types(children)).toEqual(["list"]);
    const list = children[0] as List;
    expect(list.children).toHaveLength(2);
    expect(types(list.children[0]!.children)).toEqual(["paragraph", "paragraph"]);
  });
  test("a quote holds Markdown of its own, and a GitHub callout is marked", () => {
    const [quote] = parseMarkdown("> [!WARNING]\n> Careful:\n> - one\n> - two").children as Blockquote[];
    const callout = calloutOf(quote!);
    expect(callout?.kind).toBe("warning");
    expect(types(callout!.children)).toEqual(["paragraph", "list"]);
    expect(plainText(callout!.children[0]!)).toBe("Careful:");
    expect(calloutOf(parseMarkdown("> just a quote").children[0] as Blockquote)).toBeNull();
  });
  test("a fence keeps its language and a list's indent comes off its lines", () => {
    const { children } = parseMarkdown("- step\n  ```Bash\n\n  ls -la\n    nested\n\n  ```");
    const code = (children[0] as List).children[0]!.children[1] as Code;
    expect(code.lang).toBe("Bash");
    expect(code.value.replace(/^\n+|\n+$/g, "")).toBe("ls -la\n  nested");
  });
  test("an underlined line is a heading", () => {
    expect(parseMarkdown("Summary\n=======").children[0]).toMatchObject({ type: "heading", depth: 1 });
  });
  test("raw HTML is text, never markup", () => {
    const { children } = parseMarkdown("<script>alert(1)</script>");
    expect(types(children)).toEqual(["html"]);
    expect(plainText(children)).toBe("<script>alert(1)</script>");
    const inlines = parseInline("x <script>alert(1)</script>");
    expect(types(inlines)).toEqual(["text", "html", "text", "html"]);
    expect(plainText(inlines)).toBe("x <script>alert(1)</script>");
  });
  test("only web and mail links get an href", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref((parseInline("[x](javascript:alert(1))")[0] as Link).url)).toBeNull();
  });
  test("footnotes stay literal", () => {
    const source = "foot[^1]\n\n[^1]: note";
    const { children } = parseMarkdown(source);
    expect(types(children)).toEqual(["paragraph", "footnoteDefinition"]);
    expect(sourceOf(children[1]!, source)).toBe("[^1]: note");
    expect(plainText(children, source)).toBe("foot[^1]\n[^1]: note");
  });
});

describe("chat blocks", () => {
  test("a badge is its label and tone, neutral by default", () => {
    const [warn, , plain] = parseInline(":badge[Needs attention]{tone=warn} :badge[Plain]");
    expect(badgeOf(warn!)).toMatchObject({ tone: "warn" });
    expect(plainText(badgeOf(warn!)!.label)).toBe("Needs attention");
    expect(badgeOf(plain!)).toMatchObject({ tone: "neutral" });
  });
  test("a badge with no label or an unknown tone falls back", () => {
    expect(badgeOf(parseInline(":badge[]{tone=ok}")[0]!)).toBeNull();
    expect(badgeOf(parseInline(":badge[ ]")[0]!)).toBeNull();
    expect(badgeOf(parseInline(":badge[x]{tone=purple}")[0]!)).toBeNull();
  });
  test("other directives keep their source, so a colon in prose survives", () => {
    const source = "Note:this stays. :smile: and :::";
    const inlines = parseInline(source);
    expect(types(inlines)).toEqual(["text", "textDirective", "text"]);
    expect(badgeOf(inlines[1]!)).toBeNull();
    expect(sourceOf(inlines[1]!, source)).toBe(":this");
    expect(plainText(inlines, source)).toBe(source);
  });
  test("a meter is a value against a capacity, with its words", () => {
    const [node] = parseMarkdown('::meter{value=6 label="Root filesystem (`/`)" text="6% used" left="6.1 GB used" right="107 GB available" tone=ok}').children;
    const meter = meterOf(node!);
    expect(meter).toMatchObject({ value: 6, max: 100, percent: 6, text: "6% used", left: "6.1 GB used", right: "107 GB available", tone: "ok" });
    expect(types(meter!.label)).toEqual(["text", "inlineCode", "text"]);
    expect(plainText(meter!.label)).toBe("Root filesystem (/)");
  });
  test("a meter defaults its max, its text and its tone, and clamps", () => {
    expect(meterOf(parseMarkdown("::meter{value=3 max=8}").children[0]!)).toMatchObject({ max: 8, percent: 37.5, text: "38%", tone: "neutral", left: null, right: null });
    expect(meterOf(parseMarkdown("::meter{value=250}").children[0]!)?.percent).toBe(100);
    expect(meterOf(parseMarkdown("::meter{value=-4}").children[0]!)?.percent).toBe(0);
  });
  test("a meter without a number, or a container, is malformed and keeps its source", () => {
    expect(meterOf(parseMarkdown('::meter{label="x"}').children[0]!)).toBeNull();
    expect(meterOf(parseMarkdown("::meter{value=lots}").children[0]!)).toBeNull();
    expect(meterOf(parseMarkdown("::meter{value=1 max=0}").children[0]!)).toBeNull();
    expect(meterOf(parseMarkdown("::gauge{value=1}").children[0]!)).toBeNull();
    const source = ":::warning\nhi\n:::";
    const [container] = parseMarkdown(source).children;
    expect(container?.type).toBe("containerDirective");
    expect(sourceOf(container!, source)).toBe(source);
  });
  test("plain text reduces a badge to its label and a meter to label and text", () => {
    const source = 'Status: :badge[Healthy]{tone=ok} today.\n\n::meter{value=6 label="Root" text="6% used"}';
    expect(plainText(parseMarkdown(source).children, source)).toBe("Status: Healthy today.\nRoot: 6% used");
  });
  test("choices are two to six short options, and anything else stays as written", () => {
    const first = (source: string) => choicesOf(parseMarkdown(source).children[0]!);
    expect(first("::choices[Pickup | Delivery]")).toEqual(["Pickup", "Delivery"]);
    expect(first("::choices[Yes|No|Yes]")).toEqual(["Yes", "No"]);
    expect(first("::choices[Only one]")).toBeNull();
    expect(first("::choices[a|b|c|d|e|f|g]")).toBeNull();
    expect(first("::meter{value=3}")).toBeNull();
    expect(plainText(parseMarkdown("::choices[Pickup | Delivery]"))).toBe("Pickup or Delivery?");
  });
});

test("choices written at the end of the question's line still become pills, and code keeps them as typed", () => {
  const [question, choices] = parseMarkdown("1 TB or 2 TB for the rig? ::choices[1 TB | 2 TB | Not sure]").children;
  expect(question!.type).toBe("paragraph");
  expect(choicesOf(choices!)).toEqual(["1 TB", "2 TB", "Not sure"]);
  const code = parseMarkdown("```\nask ::choices[A | B]\n```").children;
  expect(code.map((n) => n.type)).toEqual(["code"]);
  expect((code[0] as Code).value).toBe("ask ::choices[A | B]");
  expect(choicesOf(parseMarkdown("Pick one\n::choices[A | B]").children.at(-1)!)).toEqual(["A", "B"]);
});
