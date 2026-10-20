// Stands in for browser-host.mjs: answers each line, stalls on "stall", exits on "die".
import { takeLines } from "../../gond-mcp.mjs";

const state = { pending: "" };
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of takeLines(state, chunk)) {
    const message = JSON.parse(line);
    const first = message.steps?.[0]?.type;
    if (first === "die") process.exit(3);
    if (first === "stall") continue;
    if (first === "fail") process.stdout.write(`${JSON.stringify({ id: message.id, error: "it broke" })}\n`);
    else process.stdout.write(`${JSON.stringify({ id: message.id, result: { pid: process.pid, steps: message.steps } })}\n`);
  }
});
