"use client";

import { ChevronLeft, ChevronRight, CircleAlert, Info, Lightbulb, OctagonAlert, Square, SquareCheck, TriangleAlert, WrapText } from "lucide-react";
import type { AlignType, Blockquote, Code, List, ListItem, Nodes, Table } from "mdast";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Choices, Meter, StatusBadge } from "@/components/chat-blocks";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { badgeOf, calloutOf, choicesOf, definitionsOf, isLineBreak, meterOf, parseMarkdown, plainText, prepareMarkdown, safeHref, sourceOf, type CalloutKind, type Definitions } from "@/lib/markdown";
import { cn } from "@/lib/utils";

type Doc = { source: string; definitions: Definitions };

function Walk({ nodes, doc, depth = 0 }: { nodes: Nodes[]; doc: Doc; depth?: number }) {
  return nodes.map((node, i) => <NodeView key={i} node={node} doc={doc} depth={depth} />);
}

const ALIGN: Record<NonNullable<AlignType>, string> = { left: "text-left", center: "text-center", right: "text-right" };

const HEADING: Record<number, string> = {
  1: "text-[1.2em] leading-snug font-semibold tracking-tight",
  2: "text-[1.1em] leading-snug font-semibold tracking-tight",
  3: "font-semibold",
  4: "font-medium",
  5: "font-medium text-muted-foreground",
  6: "font-medium text-muted-foreground",
};

const BULLETS = ["•", "◦", "▪"];

const CALLOUTS: Record<CalloutKind, { label: string; icon: ReactNode }> = {
  note: { label: "Note", icon: <Info aria-hidden="true" className="size-3.5" /> },
  tip: { label: "Tip", icon: <Lightbulb aria-hidden="true" className="size-3.5" /> },
  important: { label: "Important", icon: <CircleAlert aria-hidden="true" className="size-3.5" /> },
  warning: { label: "Warning", icon: <TriangleAlert aria-hidden="true" className="size-3.5" /> },
  caution: { label: "Caution", icon: <OctagonAlert aria-hidden="true" className="size-3.5" /> },
};

function Anchor({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="font-medium underline decoration-muted-foreground/50 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-foreground">
      {children}
    </a>
  );
}

function Marker({ item, index, list, depth }: { item: ListItem; index: number; list: List; depth: number }) {
  if (item.checked !== null && item.checked !== undefined) {
    const Icon = item.checked ? SquareCheck : Square;
    return <Icon aria-label={item.checked ? "Done" : "Not done"} className="mt-[0.3em] size-[1em] shrink-0 text-muted-foreground" />;
  }
  return (
    <span aria-hidden="true" className="shrink-0 text-right text-muted-foreground tabular-nums select-none" style={{ minWidth: list.ordered ? "1.4em" : "0.8em" }}>
      {list.ordered ? `${(list.start ?? 1) + index}.` : BULLETS[depth % BULLETS.length]}
    </span>
  );
}

function ListView({ list, doc, depth }: { list: List; doc: Doc; depth: number }) {
  const Tag = list.ordered ? "ol" : "ul";
  return (
    <Tag className="flex list-none flex-col gap-1">
      {list.children.map((item, i) => (
        <li key={i} value={list.ordered ? (list.start ?? 1) + i : undefined} className="flex gap-2">
          <Marker item={item} index={i} list={list} depth={depth} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Walk nodes={item.children} doc={doc} depth={depth + 1} />
          </div>
        </li>
      ))}
    </Tag>
  );
}

function QuoteView({ quote, doc }: { quote: Blockquote; doc: Doc }) {
  const callout = calloutOf(quote);
  if (callout) {
    const { label, icon } = CALLOUTS[callout.kind];
    return (
      <div className="flex flex-col gap-1.5 rounded-xl bg-bubble-inset px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
          {icon}
          {label}
        </p>
        <Walk nodes={callout.children} doc={doc} />
      </div>
    );
  }
  return (
    <blockquote className="flex flex-col gap-2 border-l-2 border-foreground/15 pl-3 text-muted-foreground">
      <Walk nodes={quote.children} doc={doc} />
    </blockquote>
  );
}

function CodeView({ code }: { code: Code }) {
  const lang = code.lang?.trim().toLowerCase() ?? "";
  const text = code.value.replace(/^\n+|\n+$/g, "");
  const [wrap, setWrap] = useState(false);
  const { ref, edges } = useSideScroll<HTMLPreElement>();
  return (
    <div className="overflow-hidden rounded-xl border bg-background">
      <div className="flex h-8 items-center gap-1 border-b pr-1 pl-3 font-mono text-[11px] text-muted-foreground pointer-coarse:h-11">
        <span className="mr-auto truncate">{lang}</span>
        {wrap || edges.start || edges.end ? (
          <Toggle pressed={wrap} onPressedChange={setWrap} aria-label="Wrap long lines" className="size-7 min-w-0 rounded-full p-0 pointer-coarse:size-10">
            <WrapText aria-hidden="true" className="size-3.5" />
          </Toggle>
        ) : null}
        <CopyButton text={text} label="Copy code" className="size-7 pointer-coarse:size-10" />
      </div>
      <pre ref={ref} className={cn("overflow-x-auto overscroll-x-contain p-3 font-mono text-[12px] leading-5 text-foreground", wrap && "whitespace-pre-wrap [overflow-wrap:anywhere]")}>
        <code className="bg-transparent p-0">{text}</code>
      </pre>
    </div>
  );
}

// Cells wrap between words, and only a word longer than this breaks anywhere
// (a hash, a URL, a path): its column then gets a floor of about that many
// characters, so it can't push the table wider than the bubble. Once a table
// has to scroll anyway, every text column's floor is its longest cell up to
// that, so none is squeezed to a word per line. Figures never wrap.
const LONG_WORD = 12;

const longestWord = (text: string) => Math.max(0, ...text.split(/\s+/).map((word) => word.length));

function layoutOf(table: Table) {
  const count = table.children[0]?.children.length ?? 0;
  const texts = table.children.map((row) => Array.from({ length: count }, (_, c) => (row.children[c] ? plainText(row.children[c]) : "")));
  const columns = Array.from({ length: count }, (_, c) => {
    const align = table.align?.[c] ?? null;
    const figures = align === "right" || align === "center";
    const cells = texts.map((row) => row[c]);
    return {
      align: ALIGN[align ?? "left"],
      figures,
      long: !figures && cells.some((text) => longestWord(text) > LONG_WORD),
      chars: Math.max(0, ...cells.map((text) => text.length)) + 1,
    };
  });
  const wrap = texts.map((row) =>
    row.map((text, c) => (columns[c].figures ? "whitespace-nowrap" : longestWord(text) > LONG_WORD ? "[&,&_*]:[overflow-wrap:anywhere]" : "[&,&_*]:[overflow-wrap:break-word]")),
  );
  return { columns, wrap };
}

function useSideScroll<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const [roomy, setRoomy] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let tightWidth = 0;
    const update = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
      if (!tightWidth && el.scrollWidth > el.clientWidth + 1) {
        tightWidth = el.scrollWidth;
        setRoomy(true);
      } else if (tightWidth && tightWidth <= el.clientWidth) {
        tightWidth = 0;
        setRoomy(false);
      }
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);
  const scroll = (direction: 1 | -1) => ref.current?.scrollBy({ left: direction * ref.current.clientWidth * 0.8, behavior: "smooth" });
  return { ref, edges, roomy, scroll };
}

// Scrollbars are hidden app-wide, so a table wider than the bubble says so
// under its frame and offers the arrows a mouse would otherwise lack.
function SideScrollHint({ edges, scroll }: Pick<ReturnType<typeof useSideScroll>, "edges" | "scroll">) {
  if (!edges.start && !edges.end) return null;
  return (
    <div className="-mt-1 flex items-center justify-between gap-2 pl-1 text-[12px] leading-4 text-muted-foreground">
      <span>Scroll for more columns</span>
      <span className="flex">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Scroll left" disabled={!edges.start} onClick={() => scroll(-1)} className="pointer-coarse:size-10">
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Scroll right" disabled={!edges.end} onClick={() => scroll(1)} className="pointer-coarse:size-10">
          <ChevronRight aria-hidden="true" />
        </Button>
      </span>
    </div>
  );
}

function TableView({ table, doc }: { table: Table; doc: Doc }) {
  const [head, ...rows] = table.children;
  const { columns, wrap } = useMemo(() => layoutOf(table), [table]);
  const { ref, edges, roomy, scroll } = useSideScroll();
  // The first column stays put while the rest scroll, so a row keeps its name.
  const pinned = (c: number) => c === 0 && cn("sticky left-0 z-[1]", edges.start && "shadow-[inset_-1px_0_0_var(--color-border)]");
  return (
    <div className="flex flex-col gap-1">
      <div ref={ref} data-scroll-x="" className="overflow-x-auto overscroll-x-contain rounded-xl border bg-background">
        <table className="w-full border-collapse text-[13px] leading-5 tabular-nums">
          <thead className="bg-bubble-inset">
            <tr>
              {columns.map((column, c) => (
                <th key={c} className={cn("border-b px-2 py-2 align-bottom font-medium wide:px-3", column.align, wrap[0][c], pinned(c), c === 0 && "bg-background [background-image:linear-gradient(var(--color-bubble-inset),var(--color-bubble-inset))]")}>
                  <div style={{ "--chars": `${column.chars}ch` } as CSSProperties} className={cn(!column.figures && (roomy ? "min-w-[min(var(--chars),12ch)] wide:min-w-[min(var(--chars),18ch)]" : column.long && "min-w-[12ch]"))}>
                    {head?.children[c] ? <Walk nodes={head.children[c].children} doc={doc} /> : null}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-b last:border-b-0">
                {columns.map((column, c) => (
                  <td key={c} className={cn("px-2 py-2 align-top wide:px-3", column.align, wrap[r + 1][c], pinned(c), c === 0 && "bg-background")}>
                    {row.children[c] ? <Walk nodes={row.children[c].children} doc={doc} /> : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SideScrollHint edges={edges} scroll={scroll} />
    </div>
  );
}

function Raw({ node, doc, block }: { node: Nodes; doc: Doc; block?: boolean }) {
  const text = sourceOf(node, doc.source);
  return block ? <p className="whitespace-pre-wrap">{text}</p> : <span>{text}</span>;
}

function NodeView({ node, doc, depth }: { node: Nodes; doc: Doc; depth: number }) {
  switch (node.type) {
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap">
          <Walk nodes={node.children} doc={doc} />
        </p>
      );
    case "heading":
      return (
        <p role="heading" aria-level={Math.min(node.depth + 2, 6)} className={cn("[&:not(:first-child)]:mt-1.5", HEADING[node.depth])}>
          <Walk nodes={node.children} doc={doc} />
        </p>
      );
    case "list":
      return <ListView list={node} doc={doc} depth={depth} />;
    case "blockquote":
      return <QuoteView quote={node} doc={doc} />;
    case "code":
      return <CodeView code={node} />;
    case "table":
      return <TableView table={node} doc={doc} />;
    case "thematicBreak":
      return <Separator className="my-1 bg-foreground/10" />;
    case "text":
      return <span>{node.value}</span>;
    case "inlineCode":
      return <code className="rounded-md bg-bubble-inset box-decoration-clone px-1.5 py-0.5 font-mono text-[0.875em] text-foreground whitespace-normal [overflow-wrap:anywhere]">{node.value}</code>;
    case "strong":
      return (
        <strong className="font-semibold">
          <Walk nodes={node.children} doc={doc} />
        </strong>
      );
    case "emphasis":
      return (
        <em>
          <Walk nodes={node.children} doc={doc} />
        </em>
      );
    case "delete":
      return (
        <s className="text-muted-foreground">
          <Walk nodes={node.children} doc={doc} />
        </s>
      );
    case "link":
      return (
        <Anchor href={safeHref(node.url)}>
          <Walk nodes={node.children} doc={doc} />
        </Anchor>
      );
    case "linkReference": {
      const target = doc.definitions.get(node.identifier);
      if (!target) return <Raw node={node} doc={doc} />;
      return (
        <Anchor href={safeHref(target.url)}>
          <Walk nodes={node.children} doc={doc} />
        </Anchor>
      );
    }
    case "image":
      return <Anchor href={safeHref(node.url)}>{node.alt?.trim() || node.url}</Anchor>;
    case "imageReference": {
      const target = doc.definitions.get(node.identifier);
      if (!target) return <Raw node={node} doc={doc} />;
      return <Anchor href={safeHref(target.url)}>{node.alt?.trim() || target.url}</Anchor>;
    }
    case "break":
      return <br />;
    case "html":
      if (isLineBreak(node.value)) return <br />;
      return <span className="whitespace-pre-wrap">{node.value}</span>;
    case "definition":
      return null;
    case "textDirective": {
      const badge = badgeOf(node);
      if (!badge) return <Raw node={node} doc={doc} />;
      return (
        <StatusBadge badge={badge}>
          <Walk nodes={badge.label} doc={doc} />
        </StatusBadge>
      );
    }
    case "leafDirective": {
      const choices = choicesOf(node);
      if (choices) return <Choices options={choices} />;
      const meter = meterOf(node);
      if (!meter) return <Raw node={node} doc={doc} block />;
      return (
        <Meter meter={meter}>
          <Walk nodes={meter.label} doc={doc} />
        </Meter>
      );
    }
    case "containerDirective":
    case "footnoteDefinition":
      return <Raw node={node} doc={doc} block />;
    default:
      return <Raw node={node} doc={doc} />;
  }
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const { root, doc } = useMemo(() => {
    const root = parseMarkdown(text);
    return { root, doc: { source: prepareMarkdown(text), definitions: definitionsOf(root) } };
  }, [text]);
  return (
    <div className={className ?? "flex flex-col gap-2 text-[14px] leading-6"}>
      <Walk nodes={root.children} doc={doc} />
    </div>
  );
});
