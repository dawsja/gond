import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The pages and servers the browser and app cases use, served by the bench on this machine and reached
 * from the computer (and the API) at `publicUrl`. Every page takes `?run=` so what it records belongs
 * to one case run, and every answer a case checks is made fresh per run, so nothing can be remembered.
 */

export type Submission = { run: string; fields: Record<string, string> };

const challengeHtml = readFileSync(path.join(import.meta.dir, "..", "..", "box", "test", "fixtures", "challenges.html"), "utf8");

const ANIMALS = ["Aardvark", "Badger", "Capybara", "Dingo", "Echidna", "Fennec", "Gecko", "Heron", "Ibis", "Jackal", "Kiwi", "Lemur", "Marmot", "Narwhal", "Ocelot", "Pangolin", "Quoll", "Raccoon", "Serval", "Tapir", "Urial", "Vole", "Wombat", "Xerus", "Yak", "Zorilla"];

export function codeFor(run: string, what: string): string {
  let h = 2166136261;
  for (const ch of `${run}:${what}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return `${what.slice(0, 2).toUpperCase()}-${(h >>> 0).toString(36).slice(0, 5).toUpperCase()}`;
}

const page = (title: string, body: string, script = "") =>
  new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:24px;max-width:900px}li{margin:6px 0}.card{border:1px solid #ccc;border-radius:8px;padding:12px;margin:8px 0}</style></head><body>${body}<script>${script}</script></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

const KETTLES = [
  { id: "k1", name: "Blue kettle, steel", price: 39 },
  { id: "k2", name: "Blue kettle, glass", price: 27 },
  { id: "k3", name: "Blue kettle, enamel", price: 54 },
  { id: "k4", name: "Red kettle, steel", price: 19 },
];

export function startFixtures(port: number, publicHost: string) {
  const submissions: Submission[] = [];
  const solved = new Map<string, boolean>();
  const mcpCalls: { run: string; tool: string; args: unknown }[] = [];

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const run = url.searchParams.get("run") ?? "";
      const at = url.pathname;

      if (at === "/shop") return page("Kettle shop", `<h1>Kettle shop</h1><form action="/shop/search"><input type="hidden" name="run" value="${run}"><label>Search <input name="q" aria-label="Search"></label> <button>Search</button></form>`);
      if (at === "/shop/search") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const hits = KETTLES.filter((k) => q.split(/\s+/).every((w) => k.name.toLowerCase().includes(w)));
        return page("Results", `<h1>Results for ${q.replace(/[<>&"]/g, "")}</h1>${hits.length ? `<ul>${hits.map((k) => `<li class="card"><a href="/shop/p/${k.id}?run=${run}">${k.name}</a> $${k.price}</li>`).join("")}</ul>` : "<p>Nothing found.</p>"}`);
      }
      if (at.startsWith("/shop/p/")) {
        const kettle = KETTLES.find((k) => k.id === at.slice(8));
        if (!kettle) return new Response("Not found", { status: 404 });
        return page(kettle.name, `<h1>${kettle.name}</h1><p>Price: $${kettle.price}</p><p>Product code: <b>${codeFor(run, kettle.id)}</b></p>`);
      }

      if (at === "/form" && req.method === "GET") {
        return page(
          "Sign up",
          `<h1>Sign up for the newsletter</h1><form method="post" action="/form?run=${run}">
<p><label>Full name <input name="name" required></label></p>
<p><label>Email <input name="email" type="email" required></label></p>
<p><label>Country <select name="country"><option value="">Pick one</option><option>Canada</option><option>Portugal</option><option>Japan</option><option>Kenya</option></select></label></p>
<p>Frequency: <label><input type="radio" name="frequency" value="weekly"> Weekly</label> <label><input type="radio" name="frequency" value="monthly"> Monthly</label></p>
<p><label><input type="checkbox" name="terms" value="yes"> I agree to the terms</label></p>
<p><button>Sign up</button></p></form>`,
        );
      }
      if (at === "/form" && req.method === "POST") {
        const form = await req.formData();
        const fields: Record<string, string> = {};
        for (const [key, value] of form) fields[key] = String(value);
        submissions.push({ run, fields });
        return page("Thanks", "<h1>Thanks, you're signed up.</h1>");
      }

      if (at === "/carousel") {
        // Moves several times a second for as long as the page is open, like a hero carousel or a ticker.
        return page(
          "Offers",
          `<h1>Today's offers</h1><div id="ticker" class="card" style="overflow:hidden;white-space:nowrap"><span id="slide">Loading</span></div><p><button id="reveal">Show my discount code</button></p><p id="code" hidden>Your code: <b>${codeFor(run, "discount")}</b></p>`,
          `const slides=["Free shipping","20% off mugs","New teapots","Kettles from $19"];let i=0;setInterval(()=>{i++;const s=document.getElementById("slide");s.textContent=slides[i%slides.length];s.style.marginLeft=(i*7%120)+"px";document.getElementById("ticker").style.background="hsl("+(i*13%360)+",60%,92%)"},90);document.getElementById("reveal").onclick=()=>{document.getElementById("code").hidden=false};`,
        );
      }

      if (at === "/long") {
        const items = Array.from({ length: 120 }, (_, n) => (n === 86 ? "Quokka" : `${ANIMALS[n % ANIMALS.length]} ${Math.floor(n / ANIMALS.length) + 1}`));
        return page("Animal registry", `<h1>Animal registry</h1><ol>${items.map((name) => `<li class="card">${name}: tag ${codeFor(run, name)}</li>`).join("")}</ol>`);
      }

      if (at === "/challenge") {
        const report = `<script>new MutationObserver(()=>{if(document.body.dataset.solved==="true")fetch("/report?run=${encodeURIComponent(run)}",{method:"POST"})}).observe(document.body,{attributes:true,attributeFilter:["data-solved"]});</script>`;
        return new Response(challengeHtml.replace("</body>", `${report}</body>`), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (at === "/report" && req.method === "POST") {
        solved.set(run, true);
        return new Response(null, { status: 204 });
      }

      // The run rides in the path: Gond's MCP proxy passes its own query string, not the one saved with the server.
      if (at.startsWith("/mcp/orders/") && req.method === "POST") return orders(await req.json().catch(() => null), at.slice("/mcp/orders/".length), mcpCalls);
      if (at.startsWith("/mcp/orders/")) return new Response(null, { status: 405 });
      // A server that takes the connection and never answers, as one that hangs or sits behind a dead proxy.
      if (at === "/mcp/dead") {
        await Bun.sleep(120_000);
        return new Response("Too late", { status: 504 });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const base = `http://${publicHost}:${server.port}`;
  return {
    url: (route: string, run: string) => `${base}${route}${route.includes("?") ? "&" : "?"}run=${encodeURIComponent(run)}`,
    ordersMcp: (run: string) => `${base}/mcp/orders/${encodeURIComponent(run)}`,
    deadMcp: () => `${base}/mcp/dead`,
    submission: (run: string) => submissions.find((s) => s.run === run) ?? null,
    solved: (run: string) => solved.get(run) === true,
    mcpCalls: (run: string) => mcpCalls.filter((c) => c.run === run),
    stop: () => server.stop(true),
  };
}

type Rpc = { jsonrpc?: string; id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };

/** A tiny MCP server over HTTP with one tool: an order's status, its tracking number made from the run. */
function orders(body: unknown, run: string, calls: { run: string; tool: string; args: unknown }[]): Response {
  const rpc = (body ?? {}) as Rpc;
  const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: rpc.id ?? null, result });
  if (rpc.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "orders", version: "1.0.0" } });
  if (rpc.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
  if (rpc.method === "tools/list") {
    return reply({
      tools: [
        {
          name: "lookup_order",
          description: "Look up one of the person's orders by its number: status, carrier and tracking number.",
          inputSchema: { type: "object", properties: { order_id: { type: "string", description: "The order number" } }, required: ["order_id"] },
        },
      ],
    });
  }
  if (rpc.method === "tools/call") {
    const id = String(rpc.params?.arguments?.order_id ?? "");
    calls.push({ run, tool: rpc.params?.name ?? "", args: rpc.params?.arguments });
    const text = id.replace(/\D/g, "") === "5521" ? `Order 5521: shipped, carrier Parcelly, tracking ${codeFor(run, "tracking")}, arriving Tuesday.` : `No order ${id}.`;
    return reply({ content: [{ type: "text", text }] });
  }
  return Response.json({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601, message: "Method not found" } });
}
