/** Server-sent events into their `data` payloads, in order. */
export function sseEvents(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* a keep-alive or a torn line */
    }
  }
  return out;
}

/** The same `data` payloads as `sseEvents`, as they arrive. */
export async function* sseStream(body: NonNullable<Response["body"]>): AsyncGenerator<unknown> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += value;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : (blocks.pop() ?? "");
      for (const event of sseEvents(blocks.join("\n\n"))) yield event;
      if (done) return;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
