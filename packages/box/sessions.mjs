import nodeFs from "node:fs";
import path from "node:path";

/**
 * The CLI session each agent (a bot in a conversation) was last on, kept in
 * /state so a restart or an update resumes the conversation instead of
 * starting it over. The sessions themselves live in the person's home with
 * the CLI's own files; this only remembers their ids. One that no longer
 * resumes is replaced as usual (the engine starts a new one).
 */
export function createSessionStore(file, { fs = nodeFs } = {}) {
  const read = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return new Map(Object.entries(data?.sessions ?? {}).filter(([, entry]) => valid(entry)));
    } catch {
      return new Map();
    }
  };
  const saved = read();

  const write = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ version: 1, sessions: Object.fromEntries(saved) }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      console.warn(`[box] could not save sessions: ${error.message}`);
    }
  };

  return {
    /** The session to resume for this agent, if it was this person's on this engine. */
    get(id, user, engine) {
      const entry = saved.get(id);
      return entry && entry.user === user && entry.engine === engine ? entry.sessionId : null;
    },
    remember(id, entry) {
      const before = JSON.stringify(saved.get(id) ?? null);
      if (entry && valid(entry)) saved.set(id, { user: entry.user, engine: entry.engine, sessionId: entry.sessionId, ...(typeof entry.backend === "string" && entry.backend.length <= 100 ? { backend: entry.backend } : {}) });
      else saved.delete(id);
      if (JSON.stringify(saved.get(id) ?? null) !== before) write();
    },
    /** The model service the agent's session was made on; every session from before this was kept was on the plan. */
    backendOf(id) {
      return saved.get(id)?.backend ?? "plan";
    },
    /** Forgets an agent's session; with a user, only if it was theirs. */
    forget(id, user) {
      const entry = saved.get(id);
      if (!entry || (user && entry.user !== user)) return;
      saved.delete(id);
      write();
    },
    forgetUser(user) {
      let changed = false;
      for (const [id, entry] of saved) {
        if (entry.user !== user) continue;
        saved.delete(id);
        changed = true;
      }
      if (changed) write();
    },
    clear() {
      if (!saved.size) return;
      saved.clear();
      write();
    },
    size: () => saved.size,
  };
}

function valid(entry) {
  return Boolean(entry) && typeof entry.user === "string" && typeof entry.engine === "string" && typeof entry.sessionId === "string" && entry.sessionId.length > 0 && entry.sessionId.length <= 200;
}

/**
 * The prompt for a turn: the short follow-up (only what is new since the
 * agent's last turn) when the session carries the conversation already,
 * else the full one. A session launched fresh, or one whose resume failed
 * and was replaced, has seen nothing.
 */
export function turnPrompt(body, launch) {
  const carries = !launch.recovered && (!launch.launched || Boolean(launch.resumed));
  return carries && typeof body.followUp === "string" && body.followUp.trim() ? body.followUp : body.prompt;
}
