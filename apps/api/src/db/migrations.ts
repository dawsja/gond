import type { Database } from "bun:sqlite";

const CALLS_OUT = `DELETE FROM gond_messages WHERE spoken = 1 OR (kind = 'event' AND author = 'system' AND (body = 'Call started' OR body LIKE 'Call ended · %'));`;

const MIGRATIONS: Array<string | ((db: Database) => void)> = [
  `
  CREATE TABLE kru_bots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    voice TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    expression TEXT NOT NULL DEFAULT 'happy',
    tilt REAL NOT NULL DEFAULT 0,
    model TEXT NOT NULL,
    effort TEXT,
    approval TEXT NOT NULL DEFAULT 'ask' CHECK (approval IN ('ask', 'edits', 'full')),
    is_chief INTEGER NOT NULL DEFAULT 0,
    toolkits TEXT NOT NULL DEFAULT '[]',
    thread_id TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_threads (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bot', 'room')),
    bot_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    last_read_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_thread_members (
    thread_id TEXT NOT NULL REFERENCES kru_threads (id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, bot_id)
  );

  CREATE TABLE kru_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES kru_threads (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'event', 'activity', 'approval')),
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    depth INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    from_thread_id TEXT,
    -- Which process is answering this message, and when it was answered.
    claimed_by TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX kru_messages_thread ON kru_messages (thread_id, created_at);
  CREATE INDEX kru_messages_pending ON kru_messages (answered_at) WHERE answered_at IS NULL AND author IN ('you', 'routine');

  CREATE TABLE kru_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE kru_approvals (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'allowed', 'denied', 'expired')),
    rule TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX kru_approvals_pending ON kru_approvals (status, created_at);

  -- "Always allow" rules: a tool (and optionally a command prefix) a bot may
  -- use without asking again.
  CREATE TABLE kru_approval_rules (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    rule TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (bot_id, rule)
  );

  CREATE TABLE kru_routines (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES kru_routines (id) ON DELETE CASCADE,
    message_id TEXT,
    status TEXT NOT NULL DEFAULT 'started',
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE kru_connections (
    toolkit TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    account_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );

  CREATE TABLE kru_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    onboarding TEXT NOT NULL DEFAULT '{"done":false,"apps":[],"templates":[]}',
    concurrency INTEGER,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    updated_at TEXT NOT NULL
  );

  -- Bot-to-bot handoffs: which thread a delegated task reports back to.
  CREATE TABLE kru_delegations (
    id TEXT PRIMARY KEY,
    from_bot_id TEXT NOT NULL,
    from_thread_id TEXT NOT NULL,
    to_bot_id TEXT NOT NULL,
    to_thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    brief TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    result TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  `,

  `
  ALTER TABLE kru_settings ADD COLUMN model TEXT;
  ALTER TABLE kru_settings ADD COLUMN effort TEXT;
  `,

  `
  CREATE TABLE kru_avatar (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    media_type TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,

  `
  CREATE TABLE kru_skills (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'written',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL CHECK (transport IN ('http', 'stdio')),
    url TEXT,
    headers TEXT NOT NULL DEFAULT '{}',
    command TEXT,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    proxy_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    requested_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_secret_requests (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    name TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE kru_push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  ALTER TABLE kru_bots ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE kru_routines ADD COLUMN skill_id TEXT;
  ALTER TABLE kru_delegations ADD COLUMN nudged_at TEXT;
  ALTER TABLE kru_delegations ADD COLUMN escalated_at TEXT;
  `,

  `
  ALTER TABLE kru_mcp_servers ADD COLUMN oauth TEXT;
  ALTER TABLE kru_mcp_servers ADD COLUMN auth_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE kru_mcp_servers ADD COLUMN auth_error TEXT;
  `,

  `
  CREATE TABLE kru_messages_next (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES kru_threads (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'event', 'activity', 'approval', 'secret', 'prompt')),
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    depth INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    from_thread_id TEXT,
    claimed_by TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO kru_messages_next SELECT id, thread_id, author, kind, body, attachments, depth, approval_id, from_thread_id, claimed_by, answered_at, created_at FROM kru_messages;
  DROP TABLE kru_messages;
  ALTER TABLE kru_messages_next RENAME TO kru_messages;
  CREATE INDEX kru_messages_thread ON kru_messages (thread_id, created_at);
  CREATE INDEX kru_messages_pending ON kru_messages (answered_at) WHERE answered_at IS NULL AND author IN ('you', 'routine');
  `,

  `
  CREATE TABLE kru_providers (
    kind TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    proxy_token TEXT NOT NULL,
    last_check TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE kru_settings ADD COLUMN engine TEXT;
  ALTER TABLE kru_settings ADD COLUMN engines TEXT;
  `,

  `
  CREATE TABLE kru_messages_next (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES kru_threads (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'event', 'activity', 'approval', 'secret', 'prompt', 'signin')),
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    depth INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    from_thread_id TEXT,
    claimed_by TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO kru_messages_next SELECT id, thread_id, author, kind, body, attachments, depth, approval_id, from_thread_id, claimed_by, answered_at, created_at FROM kru_messages;
  DROP TABLE kru_messages;
  ALTER TABLE kru_messages_next RENAME TO kru_messages;
  CREATE INDEX kru_messages_thread ON kru_messages (thread_id, created_at);
  CREATE INDEX kru_messages_pending ON kru_messages (answered_at) WHERE answered_at IS NULL AND author IN ('you', 'routine');
  `,

  `
  ALTER TABLE kru_mcp_servers ADD COLUMN oauth_redirect TEXT NOT NULL DEFAULT 'app';
  UPDATE kru_mcp_servers SET oauth_redirect = 'localhost' WHERE url LIKE 'https://agent.robinhood.com/%';
  `,

  `
  UPDATE kru_bots SET toolkits = (
    SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(kru_bots.toolkits)
      UNION SELECT 'mcp:' || id FROM kru_mcp_servers
    )
  );
  `,

  `
  ALTER TABLE kru_bots ADD COLUMN user_id TEXT;
  ALTER TABLE kru_threads ADD COLUMN user_id TEXT;
  ALTER TABLE kru_push_subscriptions ADD COLUMN user_id TEXT;
  CREATE INDEX kru_bots_user ON kru_bots (user_id);
  CREATE INDEX kru_threads_user ON kru_threads (user_id);
  ALTER TABLE kru_connections ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE kru_mcp_servers ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE kru_user_avatars (
    user_id TEXT PRIMARY KEY,
    media_type TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE kru_settings ADD COLUMN oidc TEXT;
  `,

  `
  CREATE TABLE kru_connections_new (
    user_id TEXT,
    toolkit TEXT NOT NULL,
    name TEXT NOT NULL,
    account_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    UNIQUE (user_id, toolkit)
  );
  INSERT INTO kru_connections_new (user_id, toolkit, name, account_id, status, created_at)
    SELECT NULL, toolkit, name, account_id, status, created_at FROM kru_connections;
  DROP TABLE kru_connections;
  ALTER TABLE kru_connections_new RENAME TO kru_connections;

  CREATE TABLE kru_mcp_servers_new (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    transport TEXT NOT NULL CHECK (transport IN ('http', 'stdio')),
    url TEXT,
    headers TEXT NOT NULL DEFAULT '{}',
    command TEXT,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    proxy_token TEXT NOT NULL,
    oauth TEXT,
    auth_status TEXT NOT NULL DEFAULT 'none',
    auth_error TEXT,
    oauth_redirect TEXT NOT NULL DEFAULT 'app',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, name)
  );
  INSERT INTO kru_mcp_servers_new (id, user_id, name, transport, url, headers, command, args, env, enabled, proxy_token, oauth, auth_status, auth_error, oauth_redirect, created_at, updated_at)
    SELECT id, NULL, name, transport, url, headers, command, args, env, enabled, proxy_token, oauth, auth_status, auth_error, oauth_redirect, created_at, updated_at FROM kru_mcp_servers;
  DROP TABLE kru_mcp_servers;
  ALTER TABLE kru_mcp_servers_new RENAME TO kru_mcp_servers;

  CREATE TABLE kru_secrets_new (
    user_id TEXT,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    requested_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, name)
  );
  INSERT INTO kru_secrets_new (user_id, name, value, requested_by, created_at, updated_at)
    SELECT NULL, name, value, requested_by, created_at, updated_at FROM kru_secrets;
  DROP TABLE kru_secrets;
  ALTER TABLE kru_secrets_new RENAME TO kru_secrets;

  CREATE TABLE kru_composio_keys (
    user_id TEXT PRIMARY KEY,
    api_key TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,

  `
  ALTER TABLE kru_secret_requests ADD COLUMN target TEXT NOT NULL DEFAULT 'secret';
  `,

  `
  UPDATE kru_bots SET approval = 'ask' WHERE approval = 'edits';
  `,

  `
  CREATE TABLE kru_user_ai (
    user_id TEXT PRIMARY KEY,
    engine TEXT NOT NULL DEFAULT 'claude',
    engines TEXT NOT NULL DEFAULT '{}',
    effort TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE kru_providers_new (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    kind TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    proxy_token TEXT NOT NULL UNIQUE,
    last_check TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, kind)
  );
  INSERT INTO kru_providers_new (id, user_id, kind, base_url, api_key, proxy_token, last_check, created_at, updated_at)
    SELECT 'legacy-' || kind, NULL, kind, base_url, api_key, proxy_token, last_check, created_at, updated_at FROM kru_providers;
  DROP TABLE kru_providers;
  ALTER TABLE kru_providers_new RENAME TO kru_providers;
  CREATE INDEX kru_providers_user ON kru_providers (user_id);
  `,

  `
  ALTER TABLE kru_user_ai ADD COLUMN enabled TEXT;
  UPDATE kru_user_ai SET enabled = json_array(engine) WHERE enabled IS NULL;
  `,

  `
  CREATE TABLE kru_follow_ups (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    note TEXT NOT NULL,
    due_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    fired_at TEXT
  );
  CREATE INDEX kru_follow_ups_due ON kru_follow_ups (fired_at, due_at);
  `,

  `
  CREATE TABLE kru_board_cleared (
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    cleared_at TEXT NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );
  `,

  `
  ALTER TABLE kru_messages ADD COLUMN steered INTEGER NOT NULL DEFAULT 0;
  `,

  `
  CREATE TABLE IF NOT EXISTS kru_usage (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cached_input INTEGER NOT NULL DEFAULT 0,
    cost REAL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS kru_usage_user_time ON kru_usage (user_id, created_at);
  `,

  `
  CREATE TABLE kru_skills_new (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'written',
    meta TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, slug)
  );
  INSERT INTO kru_skills_new (id, user_id, slug, name, description, instructions, source, created_at, updated_at)
    SELECT id, NULL, slug, name, description, instructions, source, created_at, updated_at FROM kru_skills;
  DROP TABLE kru_skills;
  ALTER TABLE kru_skills_new RENAME TO kru_skills;
  CREATE INDEX IF NOT EXISTS kru_skills_user ON kru_skills (user_id);

  CREATE TABLE IF NOT EXISTS kru_skill_files (
    skill_id TEXT NOT NULL REFERENCES kru_skills(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    data BLOB NOT NULL,
    executable INTEGER NOT NULL DEFAULT 0,
    text INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (skill_id, path)
  );
  `,

  `
  ALTER TABLE kru_delegations ADD COLUMN parent_id TEXT;
  ALTER TABLE kru_delegations ADD COLUMN result_message_id TEXT;
  CREATE INDEX kru_delegations_parent ON kru_delegations (parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX kru_delegations_result ON kru_delegations (result_message_id) WHERE result_message_id IS NOT NULL;
  `,

  `
  UPDATE kru_bots SET color = CASE upper(color)
    WHEN '#FF5A0F' THEN '#E04E0A' WHEN '#3B82F6' THEN '#2F6FD6' WHEN '#EF4444' THEN '#D03A3A'
    WHEN '#F59E0B' THEN '#D98A08' WHEN '#8B5CF6' THEN '#7650D8' WHEN '#EC4899' THEN '#CF3D85'
    WHEN '#14B8A6' THEN '#11998A' WHEN '#1DB954' THEN '#189C47' WHEN '#0EA5E9' THEN '#0B8EC8'
    WHEN '#F97316' THEN '#D8620F' WHEN '#22C55E' THEN '#189C47' ELSE color END;
  UPDATE kru_bots SET expression = 'happy' WHERE expression IN ('sleepy', 'excited');
  `,
  renameLegacyObjects,
  `
  DROP TABLE IF EXISTS gond_board_cleared;
  DROP TABLE IF EXISTS gond_usage;
  `,
  `
  ALTER TABLE gond_bots ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0;
  UPDATE gond_bots SET is_primary = 1 WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY (is_chief = 1 AND hidden = 0) DESC, hidden ASC, position ASC, created_at ASC) AS rn FROM gond_bots
    ) WHERE rn = 1
  );
  ALTER TABLE gond_bots DROP COLUMN is_chief;
  `,
  `
  UPDATE gond_bots SET toolkits = (SELECT json_group_array(value) FROM json_each(gond_bots.toolkits) WHERE value NOT LIKE 'mcp:%')
  WHERE EXISTS (SELECT 1 FROM json_each(gond_bots.toolkits) WHERE value LIKE 'mcp:%');
  `,
  `
  CREATE TABLE gond_bots_next (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    voice TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    expression TEXT NOT NULL DEFAULT 'happy',
    tilt REAL NOT NULL DEFAULT 0,
    model TEXT NOT NULL,
    effort TEXT,
    approval TEXT NOT NULL DEFAULT 'auto' CHECK (approval IN ('ask', 'auto', 'full')),
    toolkits TEXT NOT NULL DEFAULT '[]',
    thread_id TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    notify INTEGER NOT NULL DEFAULT 1,
    user_id TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO gond_bots_next (id, name, title, description, voice, color, expression, tilt, model, effort, approval, toolkits, thread_id, hidden, pinned, position, created_at, updated_at, notify, user_id, is_primary)
  SELECT id, name, title, description, voice, color, expression, tilt, model, effort, approval, toolkits, thread_id, hidden, pinned, position, created_at, updated_at, notify, user_id, is_primary FROM gond_bots;
  DROP TABLE gond_bots;
  ALTER TABLE gond_bots_next RENAME TO gond_bots;
  CREATE INDEX gond_bots_user ON gond_bots (user_id);
  `,
  `
  CREATE TABLE gond_user_prefs (
    user_id TEXT PRIMARY KEY,
    timezone TEXT,
    updated_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE gond_secret_requests ADD COLUMN site TEXT;
  ALTER TABLE gond_secret_requests ADD COLUMN fields TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE gond_secrets ADD COLUMN site TEXT;
  `,
  `
  CREATE TABLE gond_thread_summaries (
    thread_id TEXT PRIMARY KEY REFERENCES gond_threads (id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    through TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE gond_bots ADD COLUMN shape TEXT NOT NULL DEFAULT 'cog';
  `,
  `
  CREATE TABLE gond_bot_avatars (
    bot_id TEXT PRIMARY KEY REFERENCES gond_bots (id) ON DELETE CASCADE,
    media_type TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE gond_message_reactions (
    message_id TEXT NOT NULL REFERENCES gond_messages (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, author)
  );
  `,
  `ALTER TABLE gond_push_subscriptions ADD COLUMN device TEXT;`,
  `ALTER TABLE gond_user_prefs ADD COLUMN voice TEXT;`,
  `ALTER TABLE gond_user_prefs ADD COLUMN voice_model TEXT;`,
  // Search: a trigram index over every message's text, kept by triggers. It follows the messages'
  // rowids, so a migration that rebuilds gond_messages (or a VACUUM) must end with a 'rebuild'.
  `
  CREATE VIRTUAL TABLE gond_messages_fts USING fts5(body, content='gond_messages', content_rowid='rowid', tokenize='trigram');
  INSERT INTO gond_messages_fts (gond_messages_fts) VALUES ('rebuild');
  CREATE TRIGGER gond_messages_fts_insert AFTER INSERT ON gond_messages BEGIN
    INSERT INTO gond_messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  CREATE TRIGGER gond_messages_fts_delete AFTER DELETE ON gond_messages BEGIN
    INSERT INTO gond_messages_fts (gond_messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  END;
  CREATE TRIGGER gond_messages_fts_update AFTER UPDATE OF body ON gond_messages BEGIN
    INSERT INTO gond_messages_fts (gond_messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
    INSERT INTO gond_messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  `,
  `ALTER TABLE gond_threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`,
  // Held a table for bot templates that was taken out before release; kept so later versions keep their numbers.
  `DROP TABLE IF EXISTS gond_bot_templates;`,
  `ALTER TABLE gond_user_prefs ADD COLUMN accent TEXT;`,
  `ALTER TABLE gond_routines ADD COLUMN watch INTEGER NOT NULL DEFAULT 0;`,
  // A ChatGPT plan's sign-in (refresh token, client, account), encrypted; and the client a person's
  // ChatGPT account was registered as, kept past a sign-out so signing in again reuses it.
  `
  ALTER TABLE gond_providers ADD COLUMN oauth TEXT;
  ALTER TABLE gond_user_prefs ADD COLUMN chatgpt_client TEXT;
  `,
  // When the person last refreshed an MCP server; a new value relaunches the sessions that use it.
  `ALTER TABLE gond_mcp_servers ADD COLUMN refreshed_at TEXT;`,
  // An email card's answer past yes or no: sent from a draft, saved, or sent back with a note;
  // whether the person edited the letter; and the draft a redraft follows, to mark what changed.
  `
  ALTER TABLE gond_approvals ADD COLUMN outcome TEXT;
  ALTER TABLE gond_approvals ADD COLUMN note TEXT;
  ALTER TABLE gond_approvals ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE gond_approvals ADD COLUMN revises TEXT;
  `,
  // The message the person replied to, quoted with theirs.
  `ALTER TABLE gond_messages ADD COLUMN reply_to TEXT;`,
  // A bot shared as a template: whoever is signed in here with the link can add a copy of it.
  `
  CREATE TABLE gond_bot_shares (
    token TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL UNIQUE REFERENCES gond_bots (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  `,
  // Said out loud on a call rather than typed.
  `ALTER TABLE gond_messages ADD COLUMN spoken INTEGER NOT NULL DEFAULT 0;`,
  // The voice a call speaks in, per provider, as JSON.
  `ALTER TABLE gond_user_prefs ADD COLUMN call_voice TEXT;`,
  // Calls were taken out: what was said on them and their start and end lines go. The columns stay
  // (migrations only add), unused.
  CALLS_OUT,
  // Indexes for the queries that run most: a thread's routine runs and the person's last line (the
  // thread list, rooms), the messages still waiting (every dispatcher tick), and what a
  // conversation sent elsewhere (its messages, with the exchanges it opened).
  `
  CREATE INDEX gond_messages_author ON gond_messages (thread_id, author, created_at);
  CREATE INDEX gond_messages_open ON gond_messages (created_at) WHERE answered_at IS NULL AND claimed_by IS NULL;
  CREATE INDEX gond_messages_from ON gond_messages (from_thread_id, created_at) WHERE from_thread_id IS NOT NULL;
  `,
  // A bot's line in a room keeps the message it answered, so naming a bot that answered it too wakes nobody.
  `ALTER TABLE gond_messages ADD COLUMN answering TEXT;`,
  `
  ALTER TABLE gond_user_prefs ADD COLUMN reply_style TEXT;
  ALTER TABLE gond_user_prefs ADD COLUMN emoji TEXT;
  `,
  `ALTER TABLE gond_routines ADD COLUMN once INTEGER NOT NULL DEFAULT 0;`,
  // Whom the room's router judged a person's unnamed line was for, as a JSON array of bot ids.
  `ALTER TABLE gond_messages ADD COLUMN sent_to TEXT;`,
  // A person's chat exports, made in the background; the zip is a blob in a table of its own.
  `
  CREATE TABLE gond_exports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    thread_id TEXT,
    since TEXT,
    label TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed', 'expired')),
    done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    size INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    expires_at TEXT
  );
  CREATE INDEX gond_exports_user ON gond_exports (user_id, created_at);
  CREATE TABLE gond_export_files (
    export_id TEXT PRIMARY KEY REFERENCES gond_exports (id) ON DELETE CASCADE,
    data BLOB NOT NULL
  );
  `,
  // A secret card that replaces a value the person already has, so it says so.
  `ALTER TABLE gond_secret_requests ADD COLUMN replaces INTEGER NOT NULL DEFAULT 0;`,
  // Where a person's notices go besides their browsers and apps: one service each, its keys encrypted.
  `
  CREATE TABLE gond_notify_services (
    user_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    settings TEXT NOT NULL,
    secrets TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_sent_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // "Show me how": what a person showed a bot on its screen, the screenshots taken as they did,
  // and what the bot made of it, until it is saved as a skill or dropped.
  `
  CREATE TABLE gond_teachings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('offered', 'recording', 'paused', 'review', 'looking', 'ready', 'saved', 'discarded', 'failed')),
    steps TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]',
    skipped TEXT NOT NULL DEFAULT '[]',
    hidden TEXT NOT NULL DEFAULT '[]',
    active_ms INTEGER NOT NULL DEFAULT 0,
    paused_for TEXT,
    full INTEGER NOT NULL DEFAULT 0,
    draft TEXT,
    previous TEXT,
    started_at TEXT,
    ended_at TEXT,
    ended_why TEXT,
    error TEXT,
    skill_id TEXT,
    message_id TEXT,
    prompt_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX gond_teachings_user ON gond_teachings (user_id, status);
  CREATE TABLE gond_teaching_frames (
    teaching_id TEXT NOT NULL REFERENCES gond_teachings (id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    step INTEGER,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (teaching_id, n)
  );
  `,
  allowTeachMessages,
  // Spaces: rooms shared with people on other Gonds, through gond-relay. This Gond's keys and how it
  // reaches the relay; the Gonds it knows; each space (a room here) with the Gonds and members in it,
  // your bots' rules there, its invites, which of its lines are which messages here, what has
  // arrived (so nothing posts twice) and what is waiting to go out.
  `
  CREATE TABLE gond_federation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    relay TEXT NOT NULL DEFAULT 'gond' CHECK (relay IN ('gond', 'own')),
    relay_url TEXT NOT NULL DEFAULT '',
    invites TEXT NOT NULL DEFAULT 'everyone' CHECK (invites IN ('everyone', 'admin')),
    key TEXT,
    identity TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE gond_peers (
    key TEXT PRIMARY KEY,
    box TEXT NOT NULL,
    sig TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    relay_url TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE gond_spaces (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL UNIQUE REFERENCES gond_threads (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    host_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('joining', 'active', 'left', 'closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE gond_space_gonds (
    space_id TEXT NOT NULL REFERENCES gond_spaces (id) ON DELETE CASCADE,
    peer_key TEXT NOT NULL,
    PRIMARY KEY (space_id, peer_key)
  );
  CREATE TABLE gond_space_members (
    space_id TEXT NOT NULL REFERENCES gond_spaces (id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    peer_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'bot')),
    name TEXT NOT NULL,
    color TEXT,
    PRIMARY KEY (space_id, member_id)
  );
  CREATE TABLE gond_space_rules (
    space_id TEXT NOT NULL REFERENCES gond_spaces (id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('talk', 'look', 'act')),
    memory INTEGER NOT NULL DEFAULT 0,
    bots_wake INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (space_id, bot_id)
  );
  CREATE TABLE gond_space_invites (
    hash TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES gond_spaces (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE gond_space_lines (
    space_id TEXT NOT NULL REFERENCES gond_spaces (id) ON DELETE CASCADE,
    line_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (space_id, line_id)
  );
  CREATE INDEX gond_space_lines_message ON gond_space_lines (message_id);
  CREATE TABLE gond_space_seen (
    peer_key TEXT NOT NULL,
    envelope_id TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (peer_key, envelope_id)
  );
  CREATE TABLE gond_space_outbox (
    id TEXT PRIMARY KEY,
    peer_key TEXT NOT NULL,
    body TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  ALTER TABLE gond_user_prefs ADD COLUMN space_level TEXT;
  ALTER TABLE gond_user_prefs ADD COLUMN space_bots TEXT;
  `,

  `
  CREATE TABLE gond_usage (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    bot_id TEXT,
    thread_id TEXT,
    source TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost REAL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX gond_usage_user_time ON gond_usage (user_id, created_at);
  CREATE TABLE gond_plan_limits (
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    windows TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (user_id, source)
  );
  `,

  `
  ALTER TABLE gond_secrets ADD COLUMN card TEXT;
  ALTER TABLE gond_secret_requests ADD COLUMN total TEXT;
  ALTER TABLE gond_secret_requests ADD COLUMN card TEXT;
  `,
  allowControlMessages,
  // What a teammate's note is: an action the bot it reaches must act on, or information that needs nothing.
  `ALTER TABLE gond_messages ADD COLUMN note TEXT;`,
  // A bot may say something in a space when its own person asks it in their chat; off until they say so.
  `ALTER TABLE gond_space_rules ADD COLUMN relay INTEGER NOT NULL DEFAULT 0;`,
  // Whether the people on the other Gonds can wake a bot by naming it: on, as it always was, until turned off.
  `ALTER TABLE gond_space_rules ADD COLUMN people_wake INTEGER NOT NULL DEFAULT 1;`,
  // A space's members are keyed by the Gond that declared them too, so one Gond reusing another's
  // member id makes a member of its own instead of writing over theirs. Row ids are kept for the order.
  `
  CREATE TABLE gond_space_members_next (
    space_id TEXT NOT NULL REFERENCES gond_spaces (id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    peer_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'bot')),
    name TEXT NOT NULL,
    color TEXT,
    PRIMARY KEY (space_id, peer_key, member_id)
  );
  INSERT INTO gond_space_members_next (rowid, space_id, member_id, peer_key, kind, name, color)
    SELECT rowid, space_id, member_id, peer_key, kind, name, color FROM gond_space_members;
  DROP TABLE gond_space_members;
  ALTER TABLE gond_space_members_next RENAME TO gond_space_members;
  `,
  // Who checked another Gond's words is each person's own. The old flag was one for everyone and
  // anyone sharing a space with that Gond could set it, so nobody knows whose check it was: it is
  // not carried over, and the column stays unread.
  `
  CREATE TABLE gond_peer_checks (
    user_id TEXT NOT NULL,
    peer_key TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (user_id, peer_key)
  );
  `,
];

/**
 * A message may now be a "Show me how" card. The CHECK on its kind can only change by rebuilding the
 * table, inside the migration's transaction where foreign keys stay on, so dropping the old table
 * would take every reaction with it: they are set aside and put back. Row ids are kept, since the
 * search index follows them, and the index is rebuilt at the end.
 */
function allowTeachMessages(db: Database) {
  db.exec(`
  CREATE TEMP TABLE gond_reactions_kept AS SELECT * FROM gond_message_reactions;
  CREATE TABLE gond_messages_next (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES "gond_threads" (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'event', 'activity', 'approval', 'secret', 'prompt', 'signin', 'teach')),
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    depth INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    from_thread_id TEXT,
    claimed_by TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL,
    steered INTEGER NOT NULL DEFAULT 0,
    reply_to TEXT,
    spoken INTEGER NOT NULL DEFAULT 0,
    answering TEXT,
    sent_to TEXT
  );
  INSERT INTO gond_messages_next (rowid, id, thread_id, author, kind, body, attachments, depth, approval_id, from_thread_id, claimed_by, answered_at, created_at, steered, reply_to, spoken, answering, sent_to)
    SELECT rowid, id, thread_id, author, kind, body, attachments, depth, approval_id, from_thread_id, claimed_by, answered_at, created_at, steered, reply_to, spoken, answering, sent_to FROM gond_messages;
  DROP TABLE gond_messages;
  ALTER TABLE gond_messages_next RENAME TO gond_messages;
  INSERT OR IGNORE INTO gond_message_reactions SELECT * FROM gond_reactions_kept;
  DROP TABLE gond_reactions_kept;
  CREATE INDEX gond_messages_thread ON gond_messages (thread_id, created_at);
  CREATE INDEX gond_messages_pending ON gond_messages (answered_at) WHERE answered_at IS NULL AND author IN ('you', 'routine');
  CREATE INDEX gond_messages_author ON gond_messages (thread_id, author, created_at);
  CREATE INDEX gond_messages_open ON gond_messages (created_at) WHERE answered_at IS NULL AND claimed_by IS NULL;
  CREATE INDEX gond_messages_from ON gond_messages (from_thread_id, created_at) WHERE from_thread_id IS NOT NULL;
  CREATE TRIGGER gond_messages_fts_insert AFTER INSERT ON gond_messages BEGIN
    INSERT INTO gond_messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  CREATE TRIGGER gond_messages_fts_delete AFTER DELETE ON gond_messages BEGIN
    INSERT INTO gond_messages_fts (gond_messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  END;
  CREATE TRIGGER gond_messages_fts_update AFTER UPDATE OF body ON gond_messages BEGIN
    INSERT INTO gond_messages_fts (gond_messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
    INSERT INTO gond_messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  INSERT INTO gond_messages_fts (gond_messages_fts) VALUES ('rebuild');
  `);
}

/**
 * A message may now be a "Take Control" card. As with the teach card, the CHECK on the kind can
 * only change by rebuilding the table; reactions are set aside and put back, row ids are kept for
 * the search index, and the index is rebuilt.
 */
function allowControlMessages(db: Database) {
  db.exec(`
  CREATE TEMP TABLE gond_reactions_kept AS SELECT * FROM gond_message_reactions;
  CREATE TABLE gond_messages_next (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES "gond_threads" (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'event', 'activity', 'approval', 'secret', 'prompt', 'signin', 'teach', 'control')),
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    depth INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    from_thread_id TEXT,
    claimed_by TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL,
    steered INTEGER NOT NULL DEFAULT 0,
    reply_to TEXT,
    spoken INTEGER NOT NULL DEFAULT 0,
    answering TEXT,
    sent_to TEXT
  );
  INSERT INTO gond_messages_next (rowid, id, thread_id, author, kind, body, attachments, depth, approval_id, from_thread_id, claimed_by, answered_at, created_at, steered, reply_to, spoken, answering, sent_to)
    SELECT rowid, id, thread_id, author, kind, body, attachments, depth, approval_id, from_thread_id, claimed_by, answered_at, created_at, steered, reply_to, spoken, answering, sent_to FROM gond_messages;
  DROP TABLE gond_messages;
  ALTER TABLE gond_messages_next RENAME TO gond_messages;
  INSERT OR IGNORE INTO gond_message_reactions SELECT * FROM gond_reactions_kept;
  DROP TABLE gond_reactions_kept;
  CREATE INDEX gond_messages_thread ON gond_messages (thread_id, created_at);
  CREATE INDEX gond_messages_pending ON gond_messages (answered_at) WHERE answered_at IS NULL AND author IN ('you', 'routine');
  CREATE INDEX gond_messages_author ON gond_messages (thread_id, author, created_at);
  CREATE INDEX gond_messages_open ON gond_messages (created_at) WHERE answered_at IS NULL AND claimed_by IS NULL;
  CREATE INDEX gond_messages_from ON gond_messages (from_thread_id, created_at) WHERE from_thread_id IS NOT NULL;
  CREATE TRIGGER gond_messages_fts_insert AFTER INSERT ON gond_messages BEGIN
    INSERT INTO gond_messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  CREATE TRIGGER gond_messages_fts_delete AFTER DELETE ON gond_messages BEGIN
    INSERT INTO gond_messages_fts (gond_messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  END;
  CREATE TRIGGER gond_messages_fts_update AFTER UPDATE OF body ON gond_messages BEGIN
    INSERT INTO gond_messages_fts (gond_messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
    INSERT INTO gond_messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  INSERT INTO gond_messages_fts (gond_messages_fts) VALUES ('rebuild');
  `);
}

export const RENAME_VERSION = MIGRATIONS.indexOf(renameLegacyObjects) + 1;
export const CALLS_OUT_VERSION = MIGRATIONS.indexOf(CALLS_OUT) + 1;
export const TEACH_CARDS_VERSION = MIGRATIONS.indexOf(allowTeachMessages) + 1;
export const CONTROL_CARDS_VERSION = MIGRATIONS.indexOf(allowControlMessages) + 1;
export const LATEST_VERSION = MIGRATIONS.length;

type Named = { name: string; sql: string | null };

function renameLegacyObjects(db: Database) {
  db.exec("DROP TRIGGER IF EXISTS kru_single_user");
  const tables = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'kru\\_%' ESCAPE '\\'").all() as Named[];
  for (const table of tables) {
    db.exec(`ALTER TABLE "${table.name}" RENAME TO "${table.name.replace(/^kru_/, "gond_")}"`);
  }
  const indexes = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'kru\\_%' ESCAPE '\\' AND sql IS NOT NULL").all() as Named[];
  for (const index of indexes) {
    db.exec(`DROP INDEX "${index.name}"`);
    db.exec(index.sql!.replaceAll("kru_", "gond_"));
  }
  const left = db.query("SELECT name FROM sqlite_master WHERE name LIKE 'kru\\_%' ESCAPE '\\'").all() as { name: string }[];
  if (left.length > 0) throw new Error(`Legacy objects still named kru_: ${left.map((r) => r.name).join(", ")}`);
}

function hasTable(db: Database, name: string) {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

export function runMigrations(db: Database, upTo = MIGRATIONS.length) {
  if (hasTable(db, "kru_schema") && !hasTable(db, "gond_schema")) db.exec("ALTER TABLE kru_schema RENAME TO gond_schema");
  db.exec("CREATE TABLE IF NOT EXISTS gond_schema (version INTEGER NOT NULL)");
  const row = db.query("SELECT MAX(version) AS v FROM gond_schema").get() as { v: number | null } | null;
  let version = row?.v ?? 0;
  while (version < Math.min(upTo, MIGRATIONS.length)) {
    const step = MIGRATIONS[version]!;
    db.transaction(() => {
      if (typeof step === "string") db.exec(step);
      else step(db);
      db.query("INSERT INTO gond_schema (version) VALUES (?)").run(version + 1);
    })();
    version += 1;
  }
  return version;
}
