import { mediaTypeFor, type Bot, type Thread } from "@gond/shared";
import { askApproval, ENGINE_FILES_TEXT, expiredText, SCRIPTED_SCREEN_TEXT, scriptsTheScreen, setAsideText, summarize, touchesEngine } from "./approvals.ts";
import { execOnBox, previewBoxImage, readBoxFile, writeBoxFile, type BoxConfig } from "./box.ts";
import type { DriverTool, ToolPart } from "./driver.ts";
import { hideSecrets, readSecret } from "./data/secrets.ts";
import { botHome } from "./memory.ts";

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

const MAX_READ_BYTES = 200_000;

const STOPPED = "Stopped: the command was ended.";

// Pictures the box can make a preview of; Read shows them to the model instead of calling them binary.
const PICTURES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"]);

const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_COMMAND_SECRETS = 10;

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export function resolvePath(botId: string, given: string): string {
  const path = String(given ?? "").trim();
  const home = botHome(botId);
  if (!path || path === "." || path === "./") return home;
  if (path.startsWith("~/")) return path.slice(2);
  const clean = path.replace(/^\/+/, "");

  if (clean.startsWith(".bots/") || clean.startsWith(".team/") || clean.startsWith(".skills/")) return clean;
  return path.startsWith("/") ? clean : `${home}/${clean}`;
}

export function fromHome(resolved: string): string {
  return `~/${resolved}`;
}

type Context = { box: BoxConfig; bot: Bot; thread: Thread; signal?: AbortSignal };

async function allowed(context: Context, tool: string, input: Record<string, unknown>): Promise<string | null> {
  if (scriptsTheScreen(tool, input)) return SCRIPTED_SCREEN_TEXT;
  if (touchesEngine(tool, input, context.bot)) return ENGINE_FILES_TEXT;
  const { decision, aside } = await askApproval({ bot: context.bot, threadId: context.thread.id, tool, input, signal: context.signal });
  if (aside) return setAsideText(`for "${summarize(tool, input)}"`);
  if (decision === "allow" || decision === "always") return null;
  if (decision === "expired") return expiredText(`for "${summarize(tool, input)}"`);
  return `The person denied "${summarize(tool, input)}". Do something else, or say what you would need.`;
}

/** A stop hangs up on the box, which kills the command and whatever it started (a server, a watch); null then. */
function runCommand(context: Context, command: string, options: { cwd: string; env?: Record<string, string> }) {
  return execOnBox(context.box, command, { ...options, timeoutMs: COMMAND_TIMEOUT_MS, signal: context.signal }).catch((error: unknown) => {
    if (context.signal?.aborted) return null;
    throw error;
  });
}

export function computerTools(context: Context): Record<string, DriverTool> {
  const { box, bot } = context;
  const home = botHome(bot.id);

  return {
    Bash: {
      description: `Runs a shell command on your computer, in your own folder (${home}) unless you give another directory. Use it for everything a terminal does: install things, run code, fetch a URL with curl, move files. Long output comes back trimmed.`,
      inputSchema: schema({ command: { type: "string", description: "The command line to run." }, cwd: { type: "string", description: "Where to run it, relative to your home. Defaults to your own folder." } }, ["command"]),
      execute: async (input) => {
        const command = String(input.command ?? "").trim();
        if (!command) return "No command given.";
        const denied = await allowed(context, "Bash", { command });
        if (denied) return denied;
        const cwd = typeof input.cwd === "string" && input.cwd.trim() ? resolvePath(bot.id, input.cwd) : home;
        const result = await runCommand(context, command, { cwd });
        if (!result) return STOPPED;
        const head = `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}${result.signal ? ` (${result.signal})` : ""}`;
        return `${head}\n${result.output || "(no output)"}`;
      },
    },

    Read: {
      description: "Reads a file on your computer. A directory comes back as a listing, and a picture (PNG, JPEG, WebP, GIF) as the picture itself, so you can look at it. Paths are relative to your own folder.",
      inputSchema: schema({ file_path: { type: "string", description: "The file to read." } }, ["file_path"]),
      execute: async (input): Promise<string | ToolPart[]> => {
        const file_path = resolvePath(bot.id, String(input.file_path ?? ""));
        if (touchesEngine("Read", { file_path: fromHome(file_path) })) return ENGINE_FILES_TEXT;
        const type = mediaTypeFor(file_path);
        if (PICTURES.has(type)) {
          const shown = await previewBoxImage(box, file_path, type, context.signal).catch(() => null);
          if (shown) return [{ type: "text", text: `${file_path}, a picture (shown at most 1568 px on its long edge):` }, { type: "image", data: shown.data, mimeType: shown.mediaType === "image/png" ? "image/png" : "image/jpeg" }];
        }
        const file = await readBoxFile(box, file_path);
        if (file.directory) return `${file_path} is a folder:\n${file.directory.join("\n") || "(empty)"}`;
        if (file.binary) return `${file_path} is a binary file (${file.size ?? 0} bytes). Use Bash if you need to work with it.`;
        const content = file.content ?? "";
        return content.length > MAX_READ_BYTES ? `${content.slice(0, MAX_READ_BYTES)}\n[… ${content.length - MAX_READ_BYTES} more characters; read the rest with Bash]` : content || "(empty file)";
      },
    },

    LS: {
      description: "Lists a folder on your computer. Defaults to your own folder.",
      inputSchema: schema({ path: { type: "string", description: "The folder to list." } }),
      execute: async (input) => {
        const path = resolvePath(bot.id, String(input.path ?? ""));
        if (touchesEngine("LS", { path: fromHome(path) })) return ENGINE_FILES_TEXT;
        const file = await readBoxFile(box, path);
        if (!file.directory) return `${path} is a file, not a folder.`;
        return `${path}:\n${file.directory.join("\n") || "(empty)"}`;
      },
    },

    Write: {
      description: "Writes a file on your computer, replacing whatever was there. Inside your own folder it just happens; anywhere else the person is asked first.",
      inputSchema: schema({ file_path: { type: "string", description: "The file to write." }, content: { type: "string", description: "Its whole new contents." } }, ["file_path", "content"]),
      execute: async (input) => {
        const file_path = resolvePath(bot.id, String(input.file_path ?? ""));
        const content = String(input.content ?? "");
        if (scriptsTheScreen("Write", { content })) return SCRIPTED_SCREEN_TEXT;
        const denied = await allowed(context, "Write", { file_path: fromHome(file_path) });
        if (denied) return denied;
        await writeBoxFile(box, file_path, content);
        return `Wrote ${file_path} (${content.length} characters).`;
      },
    },

    Edit: {
      description: "Replaces one exact piece of text in a file on your computer. The old text must appear exactly once; read the file first.",
      inputSchema: schema(
        {
          file_path: { type: "string", description: "The file to change." },
          old_text: { type: "string", description: "The text to replace, exactly as it appears." },
          new_text: { type: "string", description: "What to put there instead." },
        },
        ["file_path", "old_text", "new_text"],
      ),
      execute: async (input) => {
        const file_path = resolvePath(bot.id, String(input.file_path ?? ""));
        const old_text = String(input.old_text ?? "");
        const new_text = String(input.new_text ?? "");
        if (!old_text) return "Give the text to replace.";
        if (scriptsTheScreen("Edit", { new_string: new_text })) return SCRIPTED_SCREEN_TEXT;
        const denied = await allowed(context, "Edit", { file_path: fromHome(file_path) });
        if (denied) return denied;
        const file = await readBoxFile(box, file_path);
        if (typeof file.content !== "string") return `${file_path} isn't a text file.`;
        const count = file.content.split(old_text).length - 1;
        if (count === 0) return `That text isn't in ${file_path}. Read it again and match it exactly.`;
        if (count > 1) return `That text appears ${count} times in ${file_path}. Include more of what's around it so it names one place.`;
        await writeBoxFile(box, file_path, file.content.replace(old_text, new_text));
        return `Edited ${file_path}.`;
      },
    },
  };
}

/** Every engine's: a command that needs a stored secret gets it as $NAME, and its output comes back with each value replaced by its name. */
export function secretCommandTool(context: Context): Record<string, DriverTool> {
  const { bot } = context;
  return {
    run_with_secrets: {
      description:
        'Run a shell command on the computer with stored secrets in its environment as $NAME, so a password or key reaches the command without you ever seeing it: SSHPASS="$ROOT_PASSWORD" sshpass -e ssh root@10.0.0.5 \'pct list\', curl -H "Authorization: Bearer $GITHUB_TOKEN" …, PGPASSWORD="$DB_PASSWORD" psql …. Name the secrets it needs (list_secrets shows them). Never echo, print or write a secret: whatever comes back has every stored secret replaced by its name.',
      inputSchema: schema(
        {
          command: { type: "string", description: "The command line, referring to each secret as $NAME." },
          secrets: { type: "array", items: { type: "string" }, description: "The names of the stored secrets it needs, like ROOT_PASSWORD." },
          cwd: { type: "string", description: "Where to run it, relative to your home. Defaults to your own folder." },
        },
        ["command", "secrets"],
      ),
      execute: async (input) => {
        const command = String(input.command ?? "").trim();
        if (!command) return "NOT run: give the command.";
        const names = [...new Set((Array.isArray(input.secrets) ? input.secrets : []).map((name) => String(name).trim().toUpperCase()).filter(Boolean))];
        if (!names.length) return "NOT run: name the stored secrets it needs. A command without secrets runs in your own shell.";
        if (names.length > MAX_COMMAND_SECRETS) return `NOT run: at most ${MAX_COMMAND_SECRETS} secrets in one command.`;
        const bad = names.find((name) => !SECRET_NAME.test(name));
        if (bad) return `NOT run: ${bad} isn't a secret's name (capitals, digits and _).`;
        const env: Record<string, string> = {};
        const missing: string[] = [];
        for (const name of names) {
          const value = readSecret(bot.userId, name);
          if (value === null) missing.push(name);
          else env[name] = value;
        }
        if (missing.length) return `NOT run: ${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} stored. Ask the person for it with request_secret.`;
        const denied = await allowed(context, "Bash", { command });
        if (denied) return denied;
        const cwd = typeof input.cwd === "string" && input.cwd.trim() ? resolvePath(bot.id, input.cwd) : botHome(bot.id);
        const result = await runCommand(context, command, { cwd, env });
        if (!result) return STOPPED;
        const head = `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}${result.signal ? ` (${result.signal})` : ""}`;
        return `${head}\n${scrubbed(result.output, env) || "(no output)"}`;
      },
    },
  };
}

export function scrubbed(text: string, env: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(env).sort((a, b) => b[1].length - a[1].length)) if (value) out = out.split(value).join(`[${name}]`);
  return hideSecrets(out);
}
