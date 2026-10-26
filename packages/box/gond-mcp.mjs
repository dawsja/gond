import net from "node:net";

export const PROTOCOL_VERSION = "2024-11-05";

export async function handleRpc(message, bridge) {
  const { id, method, params } = message ?? {};
  if (typeof method !== "string") return null;
  if (method.startsWith("notifications/")) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, text) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  try {
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "gond", version: "1.0.0" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: (await bridge("tools/list", {})).tools ?? [] });
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string") return fail(-32602, "Missing tool name");
        const answer = await bridge("tools/call", { name, arguments: params?.arguments ?? {} });
        return reply({ content: mcpContent(answer?.content), isError: Boolean(answer?.isError) });
      }
      default:
        return fail(-32601, `Unknown method ${method}`);
    }
  } catch (error) {
    return fail(-32000, error instanceof Error ? error.message : "Bridge failed");
  }
}

export function mcpContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    const parts = content.flatMap((part) => {
      if (part?.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
      if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") return [{ type: "image", data: part.data, mimeType: part.mimeType }];
      return [];
    });
    if (parts.length) return parts;
  }
  return [{ type: "text", text: JSON.stringify(content ?? "") }];
}

export function takeLines(state, chunk) {
  state.pending += chunk;
  const lines = [];
  let newline = state.pending.indexOf("\n");
  while (newline !== -1) {
    lines.push(state.pending.slice(0, newline).replace(/\r$/, ""));
    state.pending = state.pending.slice(newline + 1);
    newline = state.pending.indexOf("\n");
  }
  return lines;
}

function main(socketPath) {
  const socket = net.connect(socketPath);
  socket.setEncoding("utf8");
  let next = 1;
  const waiting = new Map();
  const state = { pending: "" };
  socket.on("data", (chunk) => {
    for (const line of takeLines(state, chunk)) {
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = waiting.get(message.id);
      if (!entry) continue;
      waiting.delete(message.id);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    }
  });
  const die = () => {
    for (const entry of waiting.values()) entry.reject(new Error("The box went away"));
    waiting.clear();
    process.exit(0);
  };
  socket.on("close", die);
  socket.on("error", die);

  const bridge = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  process.stdin.setEncoding("utf8");
  const input = { pending: "" };
  process.stdin.on("data", (chunk) => {
    for (const line of takeLines(input, chunk)) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      void handleRpc(message, bridge).then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const socketPath = process.argv[2];
  if (!socketPath) {
    process.stderr.write("usage: gond-mcp.mjs <socket path>\n");
    process.exit(2);
  }
  main(socketPath);
}
