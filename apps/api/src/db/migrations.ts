import type { Database } from "bun:sqlite";

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
];

export const RENAME_VERSION = MIGRATIONS.indexOf(renameLegacyObjects) + 1;
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
