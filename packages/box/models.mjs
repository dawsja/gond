export const CLAUDE_ALIASES = [
  { id: "fable", name: "Fable 5.1", detail: "The newest, above Opus. Only where your plan includes it." },
  { id: "opus", name: "Opus 5.5", detail: "The most capable. Best for long, multi-step jobs. The default for every bot.", default: true },
  { id: "sonnet", name: "Sonnet 5.5", detail: "Fast and capable. Good for everyday work." },
  { id: "haiku", name: "Haiku 5.5", detail: "Quickest and cheapest. Good for triage and routines." },
];

export async function engineModels(engine) {
  return engine === "claude" ? CLAUDE_ALIASES.map((model) => ({ ...model })) : [];
}
