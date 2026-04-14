export const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    candidate_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    max_session_tokens INTEGER NOT NULL,
    max_message_tokens INTEGER NOT NULL,
    max_interactions INTEGER NOT NULL,
    context_window INTEGER NOT NULL,
    time_limit_minutes INTEGER NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    interactions_used INTEGER NOT NULL DEFAULT 0,
    score REAL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_sequence INTEGER,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    rewound_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS replay_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_sequence INTEGER,
    type      TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    payload   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_replay_events_session
    ON replay_events(session_id, branch_id, timestamp ASC, id ASC);

  CREATE TABLE IF NOT EXISTS session_branches (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    name TEXT NOT NULL,
    parent_branch_id TEXT REFERENCES session_branches(id),
    forked_from_sequence INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_session_branches_name
    ON session_branches(session_id, name);

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL REFERENCES session_branches(id),
    title TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_branch
    ON conversations(session_id, branch_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS context_resources (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL REFERENCES session_branches(id),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_conversation_id TEXT REFERENCES conversations(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_context_resources_branch
    ON context_resources(session_id, branch_id, kind, updated_at DESC);

  CREATE TABLE IF NOT EXISTS conversation_context_attachments (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    path TEXT,
    resource_id TEXT REFERENCES context_resources(id),
    source_conversation_id TEXT REFERENCES conversations(id),
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_context_attachments_conversation
    ON conversation_context_attachments(conversation_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS workspace_snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL REFERENCES session_branches(id),
    kind TEXT NOT NULL,
    turn_sequence INTEGER,
    label TEXT,
    created_at INTEGER NOT NULL,
    active_path TEXT,
    workspace_section TEXT,
    filesystem_json TEXT NOT NULL,
    mock_pg_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_lookup
    ON workspace_snapshots(session_id, branch_id, kind, created_at DESC);

  CREATE TABLE IF NOT EXISTS assessment_links (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    url TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    candidate_email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    constraint_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assessment_link_uses (
    link_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    used_at INTEGER NOT NULL
  );
`;

export const POSTGRES_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    candidate_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at BIGINT NOT NULL,
    closed_at BIGINT,
    max_session_tokens INTEGER NOT NULL,
    max_message_tokens INTEGER NOT NULL,
    max_interactions INTEGER NOT NULL,
    context_window INTEGER NOT NULL,
    time_limit_minutes INTEGER NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    interactions_used INTEGER NOT NULL DEFAULT 0,
    score DOUBLE PRECISION
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_sequence BIGINT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    rewound_at BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS replay_events (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_sequence BIGINT,
    type TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_replay_events_session
    ON replay_events(session_id, branch_id, timestamp ASC, id ASC)`,
  `CREATE TABLE IF NOT EXISTS session_branches (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    name TEXT NOT NULL,
    parent_branch_id TEXT REFERENCES session_branches(id),
    forked_from_sequence BIGINT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_branches_name
    ON session_branches(session_id, name)`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL REFERENCES session_branches(id),
    title TEXT NOT NULL,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_branch
    ON conversations(session_id, branch_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS context_resources (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL REFERENCES session_branches(id),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_conversation_id TEXT REFERENCES conversations(id),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_context_resources_branch
    ON context_resources(session_id, branch_id, kind, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS conversation_context_attachments (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    path TEXT,
    resource_id TEXT REFERENCES context_resources(id),
    source_conversation_id TEXT REFERENCES conversations(id),
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_context_attachments_conversation
    ON conversation_context_attachments(conversation_id, created_at ASC)`,
  `CREATE TABLE IF NOT EXISTS workspace_snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL REFERENCES session_branches(id),
    kind TEXT NOT NULL,
    turn_sequence BIGINT,
    label TEXT,
    created_at BIGINT NOT NULL,
    active_path TEXT,
    workspace_section TEXT,
    filesystem_json TEXT NOT NULL,
    mock_pg_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_lookup
    ON workspace_snapshots(session_id, branch_id, kind, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS assessment_links (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    url TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    candidate_email TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    constraint_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assessment_link_uses (
    link_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    used_at BIGINT NOT NULL
  )`,
] as const;
