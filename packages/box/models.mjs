import { claudeModelInfo } from "./claude.mjs";

/** Gond's own pick for a new bot, `DEFAULT_MODEL` in shared. The list marks it so the pickers agree. */
const GOND_DEFAULT = "opus";

/** The CLI's row for "whatever it recommends": a pointer to a model it also lists, not a model of its own. */
const CLI_DEFAULT = "default";

/** `MODEL_ID_PATTERN` in shared, which the API holds every saved id to. */
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,120}(?:\[1m\])?$/;

/**
 * Used only while the CLI has never answered for this account. Aliases alone, and no version in any
 * word: the CLI moves an alias to the newest model itself, so nothing here can go stale.
 */
export const FALLBACK_CLAUDE_MODELS = Object.freeze([
  { id: "opus", name: "Opus", detail: "Best for everyday, complex work. The default for every bot.", default: true },
  { id: "fable", name: "Fable", detail: "The most capable, for the hardest and longest jobs. Only where your plan includes it." },
  { id: "sonnet", name: "Sonnet", detail: "Fast and capable. Good for routine work." },
  { id: "haiku", name: "Haiku", detail: "Quickest and cheapest. Good for triage and routines." },
]);

const MAX_NAME = 80;
const MAX_DETAIL = 300;

/** One line of at most `max` characters, so an odd or hostile answer can't wreck a picker. */
const text = (value, max) => {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/**
 * The CLI's `ModelInfo` rows as Gond's choices, in the CLI's order. Its list is Anthropic's own curation for
 * the account (retired models leave it), so nothing is dropped by name or version. Only:
 * a row without a usable id, a repeated id, the `default` pointer, and a row naming the same model
 * (`resolvedModel`) as one kept before it, so each model shows once, under the alias that follows it.
 * The default is Gond's own (`opus`) when listed, else the model the CLI recommends, else the first.
 */
export function modelsFromInfo(infos) {
  if (!Array.isArray(infos)) return [];
  const rows = infos.filter((info) => info && typeof info === "object" && typeof info.value === "string" && MODEL_ID.test(info.value));
  const recommended = text(rows.find((info) => info.value === CLI_DEFAULT)?.resolvedModel, 200);
  const ids = new Set();
  const resolved = new Set();
  const models = [];
  for (const info of rows) {
    if (info.value === CLI_DEFAULT || ids.has(info.value)) continue;
    const target = text(info.resolvedModel, 200) ?? info.value;
    if (resolved.has(target)) continue;
    ids.add(info.value);
    resolved.add(target);
    const name = text(info.displayName, MAX_NAME);
    const detail = text(info.description, MAX_DETAIL);
    models.push({ id: info.value, ...(name ? { name } : {}), ...(detail ? { detail } : {}), target });
  }
  const pick = models.find((model) => model.id === GOND_DEFAULT) ?? models.find((model) => model.target === recommended) ?? models[0];
  return models.map(({ target, ...model }) => (model.id === pick?.id ? { ...model, default: true } : model));
}

/** What the engine lists now, or null when it couldn't say. */
async function askEngine(engine, { bins = {}, cwd, env, uid, gid, timeoutMs } = {}) {
  if (engine !== "claude") return null;
  const models = modelsFromInfo(await claudeModelInfo({ bin: bins.claude, cwd, env, uid, gid, timeoutMs }));
  return models.length ? models : null;
}

function fallbackFor(engine) {
  return engine === "claude" ? FALLBACK_CLAUDE_MODELS.map((model) => ({ ...model })) : [];
}

/** One uncached look: the engine's own list, or the bundled fallback when it can't say. */
export async function engineModels(engine, options = {}) {
  return (await askEngine(engine, options)) ?? fallbackFor(engine);
}

const MODELS_TTL_MS = 5 * 60 * 1000;
const MODELS_RETRY_MS = 60 * 1000;
/** How long the last good list outlives looks that keep failing, so a retired model can't stay listed for good. */
const LAST_GOOD_MS = 24 * 60 * 60 * 1000;

/**
 * Each account's list, asked again once `ttlMs` has passed. A failed look keeps the last list the CLI gave,
 * for at most `lastGoodMs` after it gave it, else the bundled fallback, and tries again after `retryMs`;
 * callers asking at once share one look. `forget` drops a key's list, or every key starting with a prefix,
 * after a sign-in changes what the CLI would say.
 */
export function createModelLists({ ask = askEngine, ttlMs = MODELS_TTL_MS, retryMs = MODELS_RETRY_MS, lastGoodMs = LAST_GOOD_MS, now = Date.now } = {}) {
  const lists = new Map();
  const looks = new Map();

  const look = (key, engine, options) => {
    const running = (async () => {
      const found = await ask(engine, options).catch(() => null);
      if (looks.get(key) !== running) return found ?? lists.get(key)?.models ?? fallbackFor(engine);
      looks.delete(key);
      const last = lists.get(key);
      const at = now();
      if (found?.length) lists.set(key, { models: found, goodAt: at, until: at + ttlMs });
      else if (last?.goodAt !== undefined && at - last.goodAt < lastGoodMs) lists.set(key, { ...last, until: at + retryMs });
      else lists.set(key, { models: fallbackFor(engine), until: at + retryMs });
      return lists.get(key).models;
    })();
    looks.set(key, running);
    return running;
  };

  return {
    async get(key, engine, options) {
      const list = lists.get(key);
      const models = list && now() < list.until ? list.models : await (looks.get(key) ?? look(key, engine, options));
      return models.map((model) => ({ ...model }));
    },
    forget(prefix = "") {
      for (const map of [lists, looks]) for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    },
  };
}
