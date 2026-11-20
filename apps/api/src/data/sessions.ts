import { ensureDatabase } from "../db/init.ts";
import { now } from "../ids.ts";

/**
 * An agent (a bot in one conversation) and its CLI session: what its last turn ran on (`runKey`), the
 * session the CLI made, and the last message that session was given. Kept here so a restart of either
 * side resumes the session and sends only what is new.
 */
export type AgentSession = { run: string; sessionId: string | null; seenAt: string | null };

export function agentSession(agentId: string): AgentSession | null {
  const row = ensureDatabase().query("SELECT run, session_id, seen_at FROM gond_agent_sessions WHERE agent_id = ?").get(agentId) as { run: string; session_id: string | null; seen_at: string | null } | null;
  return row ? { run: row.run, sessionId: row.session_id, seenAt: row.seen_at } : null;
}

/** Keeps what the agent's turn ran on and saw; nothing when its bot or conversation went while it ran. */
export function saveAgentSession(agent: { agentId: string; botId: string; threadId: string }, session: AgentSession): void {
  ensureDatabase()
    .query(
      `INSERT INTO gond_agent_sessions (agent_id, bot_id, thread_id, run, session_id, seen_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM gond_bots WHERE id = ?) AND EXISTS (SELECT 1 FROM gond_threads WHERE id = ?)
       ON CONFLICT (agent_id) DO UPDATE SET run = excluded.run, session_id = excluded.session_id, seen_at = excluded.seen_at, updated_at = excluded.updated_at`,
    )
    .run(agent.agentId, agent.botId, agent.threadId, session.run, session.sessionId, session.seenAt, now(), agent.botId, agent.threadId);
}

/** Forgets the sessions of a profile's bots, as when its home on the computer was emptied; every profile's with none. */
export function forgetAgentSessions(userId?: string): void {
  if (userId === undefined) ensureDatabase().query("DELETE FROM gond_agent_sessions").run();
  else ensureDatabase().query("DELETE FROM gond_agent_sessions WHERE bot_id IN (SELECT id FROM gond_bots WHERE user_id = ?)").run(userId);
}
