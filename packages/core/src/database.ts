import { randomUUID, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { Pool, type PoolConfig } from 'pg';
import type {
  AssessmentLinkRecord,
  MockPgPoolExport,
  Session,
  SessionBranch,
  SessionStatus,
  Constraint,
  MessageRole,
  ReplayEventType,
  SnapshotFile,
  WorkspaceSection,
  WorkspaceSnapshot,
  WorkspaceSnapshotKind,
} from './types.js';

// ─── Stored Message ───────────────────────────────────────────────────────────

export interface StoredMessage {
  id: number;
  session_id: string;
  branch_id: string;
  turn_sequence: number | null;
  role: MessageRole;
  content: string;
  token_count: number;
  created_at: number; // Unix ms
}

// ─── Stored Replay Event ──────────────────────────────────────────────────────

export interface StoredReplayEvent {
  id: number;
  session_id: string;
  branch_id: string;
  turn_sequence: number | null;
  type: ReplayEventType;
  timestamp: number; // Unix ms
  payload: unknown;
}

export interface CreateBranchConfig {
  session_id: string;
  name: string;
  parent_branch_id: string;
  forked_from_sequence: number;
}

export interface WorkspaceSnapshotInput {
  session_id: string;
  branch_id: string;
  kind: WorkspaceSnapshotKind;
  turn_sequence?: number;
  label?: string;
  created_at?: number;
  active_path?: string;
  workspace_section?: WorkspaceSection;
  filesystem: SnapshotFile[];
  mock_pg: MockPgPoolExport[];
}

// ─── Create Session Config ────────────────────────────────────────────────────

export interface CreateSessionConfig {
  prompt_id: string;
  candidate_email: string;
  constraint: Constraint;
}

export interface CreateAssessmentLinkConfig {
  id: string;
  token: string;
  url: string;
  prompt_id: string;
  candidate_email: string;
  created_at: number;
  expires_at: number;
  constraint: Constraint;
}

// ─── DatabaseAdapter Interface ────────────────────────────────────────────────

export interface DatabaseAdapter {
  createSession(config: CreateSessionConfig): Promise<{ id: string; token: string }>;
  createAssessmentLink(config: CreateAssessmentLinkConfig): Promise<AssessmentLinkRecord>;
  getSession(id: string): Promise<Session | null>;
  getSessionToken(id: string): Promise<string | null>;
  addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void>;
  getMessages(sessionId: string): Promise<StoredMessage[]>;
  closeSession(id: string): Promise<void>;
  listSessions(): Promise<Session[]>;
  getSessionsByPrompt(promptId: string): Promise<Session[]>;
  listAssessmentLinks(): Promise<AssessmentLinkRecord[]>;
  getAssessmentLink(id: string): Promise<AssessmentLinkRecord | null>;
  validateSessionToken(id: string, token: string): Promise<boolean>;
  updateSessionUsage(id: string, additionalTokens: number, additionalInteractions: number): Promise<void>;
  addReplayEvent(sessionId: string, type: ReplayEventType, timestamp: number, payload: unknown): Promise<void>;
  getReplayEvents(sessionId: string): Promise<StoredReplayEvent[]>;
  getMainBranch(sessionId: string): Promise<SessionBranch | null>;
  getBranch(sessionId: string, branchId: string): Promise<SessionBranch | null>;
  listBranches(sessionId: string): Promise<SessionBranch[]>;
  createBranch(config: CreateBranchConfig): Promise<SessionBranch>;
  allocateTurnSequence(sessionId: string): Promise<number>;
  addBranchMessage(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    role: MessageRole,
    content: string,
    tokenCount: number,
  ): Promise<void>;
  getBranchMessages(sessionId: string, branchId: string): Promise<StoredMessage[]>;
  addBranchReplayEvent(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    type: ReplayEventType,
    timestamp: number,
    payload: unknown,
  ): Promise<void>;
  getBranchReplayEvents(sessionId: string, branchId: string): Promise<StoredReplayEvent[]>;
  upsertWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot>;
  createWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot>;
  getWorkspaceSnapshot(
    sessionId: string,
    branchId: string,
    options?: { kind?: WorkspaceSnapshotKind; turn_sequence?: number },
  ): Promise<WorkspaceSnapshot | null>;
  markAssessmentLinkUsed(linkId: string, sessionId: string): Promise<boolean>;
  isAssessmentLinkUsed(linkId: string): Promise<boolean>;
  getAssessmentLinkSessionId(linkId: string): Promise<string | null>;
}

// ─── Internal DB Row Types ────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  token: string;
  prompt_id: string;
  candidate_email: string;
  status: string;
  created_at: number;
  closed_at: number | null;
  max_session_tokens: number;
  max_message_tokens: number;
  max_interactions: number;
  context_window: number;
  time_limit_minutes: number;
  tokens_used: number;
  interactions_used: number;
  score: number | null;
}

interface MessageRow {
  id: number;
  session_id: string;
  branch_id: string;
  turn_sequence: number | null;
  role: string;
  content: string;
  token_count: number;
  created_at: number;
}

interface ReplayEventRow {
  id: number;
  session_id: string;
  branch_id: string;
  turn_sequence: number | null;
  type: string;
  timestamp: number;
  payload: string; // JSON text
}

interface SessionBranchRow {
  id: string;
  session_id: string;
  name: string;
  parent_branch_id: string | null;
  forked_from_sequence: number | null;
  created_at: number;
}

interface WorkspaceSnapshotRow {
  id: string;
  session_id: string;
  branch_id: string;
  kind: string;
  turn_sequence: number | null;
  label: string | null;
  created_at: number;
  active_path: string | null;
  workspace_section: string | null;
  filesystem_json: string;
  mock_pg_json: string;
}

interface AssessmentLinkRow {
  id: string;
  token: string;
  url: string;
  prompt_id: string;
  candidate_email: string;
  created_at: number;
  expires_at: number;
  constraint_json: string;
  consumed_session_id?: string | null;
  consumed_at?: number | null;
}

const SQLITE_SCHEMA = `
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
    turn_sequence INTEGER,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS replay_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL,
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

const POSTGRES_SCHEMA_STATEMENTS = [
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
    turn_sequence BIGINT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS replay_events (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_id TEXT NOT NULL,
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

// ─── SQLiteAdapter ────────────────────────────────────────────────────────────

export class SQLiteAdapter implements DatabaseAdapter {
  private readonly db: Database.Database;

  constructor(dbPath: string = 'lintic.db') {
    this.db = new Database(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(SQLITE_SCHEMA);
    this.applySqliteMigrations();
  }

  private applySqliteMigrations(): void {
    const migrations = [
      'ALTER TABLE messages ADD COLUMN branch_id TEXT',
      'ALTER TABLE messages ADD COLUMN turn_sequence INTEGER',
      'ALTER TABLE replay_events ADD COLUMN branch_id TEXT',
      'ALTER TABLE replay_events ADD COLUMN turn_sequence INTEGER',
    ];

    for (const statement of migrations) {
      try {
        this.db.exec(statement);
      } catch {
        // Existing databases may already have the column.
      }
    }

    this.db.exec("UPDATE messages SET branch_id = COALESCE(branch_id, 'main') WHERE branch_id IS NULL OR branch_id = ''");
    this.db.exec("UPDATE replay_events SET branch_id = COALESCE(branch_id, 'main') WHERE branch_id IS NULL OR branch_id = ''");
  }

  createSession(config: CreateSessionConfig): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const branchId = randomUUID();

    this.db.prepare(`
      INSERT INTO sessions (
        id, token, prompt_id, candidate_email, status, created_at,
        max_session_tokens, max_message_tokens, max_interactions,
        context_window, time_limit_minutes, tokens_used, interactions_used
      ) VALUES (
        ?, ?, ?, ?, 'active', ?,
        ?, ?, ?,
        ?, ?, 0, 0
      )
    `).run(
      id, token, config.prompt_id, config.candidate_email, now,
      config.constraint.max_session_tokens,
      config.constraint.max_message_tokens,
      config.constraint.max_interactions,
      config.constraint.context_window,
      config.constraint.time_limit_minutes,
    );

    this.db.prepare(`
      INSERT INTO session_branches (
        id, session_id, name, parent_branch_id, forked_from_sequence, created_at
      ) VALUES (?, ?, 'main', NULL, NULL, ?)
    `).run(branchId, id, now);

    return Promise.resolve({ id, token });
  }

  createAssessmentLink(config: CreateAssessmentLinkConfig): Promise<AssessmentLinkRecord> {
    this.db.prepare(`
      INSERT INTO assessment_links (
        id, token, url, prompt_id, candidate_email, created_at, expires_at, constraint_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.id,
      config.token,
      config.url,
      config.prompt_id,
      config.candidate_email,
      config.created_at,
      config.expires_at,
      JSON.stringify(config.constraint),
    );

    return Promise.resolve({
      id: config.id,
      token: config.token,
      url: config.url,
      prompt_id: config.prompt_id,
      candidate_email: config.candidate_email,
      created_at: config.created_at,
      expires_at: config.expires_at,
      constraint: config.constraint,
    });
  }

  getSession(id: string): Promise<Session | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return Promise.resolve(row ? rowToSession(row) : null);
  }

  getSessionToken(id: string): Promise<string | null> {
    const row = this.db.prepare('SELECT token FROM sessions WHERE id = ?').get(id) as { token: string } | undefined;
    return Promise.resolve(row?.token ?? null);
  }

  getMainBranch(sessionId: string): Promise<SessionBranch | null> {
    const row = this.db.prepare(
      "SELECT * FROM session_branches WHERE session_id = ? AND name = 'main' LIMIT 1",
    ).get(sessionId) as SessionBranchRow | undefined;
    return Promise.resolve(row ? rowToSessionBranch(row) : null);
  }

  getBranch(sessionId: string, branchId: string): Promise<SessionBranch | null> {
    const row = this.db.prepare(
      'SELECT * FROM session_branches WHERE session_id = ? AND id = ? LIMIT 1',
    ).get(sessionId, branchId) as SessionBranchRow | undefined;
    return Promise.resolve(row ? rowToSessionBranch(row) : null);
  }

  listBranches(sessionId: string): Promise<SessionBranch[]> {
    const rows = this.db.prepare(
      'SELECT * FROM session_branches WHERE session_id = ? ORDER BY created_at ASC, id ASC',
    ).all(sessionId) as SessionBranchRow[];
    return Promise.resolve(rows.map(rowToSessionBranch));
  }

  createBranch(config: CreateBranchConfig): Promise<SessionBranch> {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db.prepare(
      `INSERT INTO session_branches (
        id, session_id, name, parent_branch_id, forked_from_sequence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      config.session_id,
      config.name,
      config.parent_branch_id,
      config.forked_from_sequence,
      createdAt,
    );

    this.db.prepare(
      `INSERT INTO messages (
        session_id, branch_id, turn_sequence, role, content, token_count, created_at
      )
      SELECT session_id, ?, turn_sequence, role, content, token_count, created_at
      FROM messages
      WHERE session_id = ? AND branch_id = ? AND turn_sequence IS NOT NULL AND turn_sequence <= ?
      ORDER BY id ASC`,
    ).run(id, config.session_id, config.parent_branch_id, config.forked_from_sequence);

    this.db.prepare(
      `INSERT INTO replay_events (
        session_id, branch_id, turn_sequence, type, timestamp, payload
      )
      SELECT session_id, ?, turn_sequence, type, timestamp, payload
      FROM replay_events
      WHERE session_id = ? AND branch_id = ? AND turn_sequence IS NOT NULL AND turn_sequence <= ?
      ORDER BY timestamp ASC, id ASC`,
    ).run(id, config.session_id, config.parent_branch_id, config.forked_from_sequence);

    const snapshot = this.db.prepare(
      `SELECT * FROM workspace_snapshots
       WHERE session_id = ? AND branch_id = ? AND (
         kind = 'draft' OR (turn_sequence IS NOT NULL AND turn_sequence <= ?)
       )
       ORDER BY
         CASE WHEN kind = 'draft' THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 1`,
    ).get(
      config.session_id,
      config.parent_branch_id,
      config.forked_from_sequence,
    ) as WorkspaceSnapshotRow | undefined;

    if (snapshot) {
      this.db.prepare(
        `INSERT INTO workspace_snapshots (
          id, session_id, branch_id, kind, turn_sequence, label, created_at, active_path, workspace_section, filesystem_json, mock_pg_json
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        snapshot.session_id,
        id,
        snapshot.turn_sequence,
        snapshot.label,
        createdAt,
        snapshot.active_path,
        snapshot.workspace_section,
        snapshot.filesystem_json,
        snapshot.mock_pg_json,
      );
    }

    return Promise.resolve({
      id,
      session_id: config.session_id,
      name: config.name,
      parent_branch_id: config.parent_branch_id,
      forked_from_sequence: config.forked_from_sequence,
      created_at: createdAt,
    });
  }

  allocateTurnSequence(sessionId: string): Promise<number> {
    const row = this.db.prepare(
      `SELECT MAX(turn_sequence) AS max_turn_sequence FROM (
         SELECT turn_sequence FROM messages WHERE session_id = ?
         UNION ALL
         SELECT turn_sequence FROM replay_events WHERE session_id = ?
         UNION ALL
         SELECT turn_sequence FROM workspace_snapshots WHERE session_id = ?
       )`,
    ).get(sessionId, sessionId, sessionId) as { max_turn_sequence: number | null };
    return Promise.resolve((row.max_turn_sequence ?? 0) + 1);
  }

  async addBranchMessage(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    role: MessageRole,
    content: string,
    tokenCount: number,
  ): Promise<void> {
    this.db.prepare(`
      INSERT INTO messages (session_id, branch_id, turn_sequence, role, content, token_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, branchId, turnSequence, role, content, tokenCount, Date.now());
  }

  addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void> {
    return this.getMainBranch(sessionId).then((branch) => {
      if (!branch) {
        throw new Error(`Main branch not found for session ${sessionId}`);
      }
      return this.addBranchMessage(sessionId, branch.id, null, role, content, tokenCount);
    });
  }

  getBranchMessages(sessionId: string, branchId: string): Promise<StoredMessage[]> {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? AND branch_id = ? ORDER BY id ASC',
    ).all(sessionId, branchId) as MessageRow[];

    return Promise.resolve(rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      branch_id: r.branch_id,
      turn_sequence: r.turn_sequence === null ? null : Number(r.turn_sequence),
      role: r.role as MessageRole,
      content: r.content,
      token_count: r.token_count,
      created_at: r.created_at,
    })));
  }

  getMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.getMainBranch(sessionId).then((branch) => {
      if (!branch) {
        return [];
      }
      return this.getBranchMessages(sessionId, branch.id);
    });
  }

  closeSession(id: string): Promise<void> {
    this.db.prepare(`
      UPDATE sessions SET status = 'completed', closed_at = ? WHERE id = ?
    `).run(Date.now(), id);
    return Promise.resolve();
  }

  listSessions(): Promise<Session[]> {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as SessionRow[];
    return Promise.resolve(rows.map(rowToSession));
  }

  getSessionsByPrompt(promptId: string): Promise<Session[]> {
    const rows = this.db.prepare(
      'SELECT * FROM sessions WHERE prompt_id = ? ORDER BY created_at DESC'
    ).all(promptId) as SessionRow[];
    return Promise.resolve(rows.map(rowToSession));
  }

  listAssessmentLinks(): Promise<AssessmentLinkRecord[]> {
    const rows = this.db.prepare(`
      SELECT
        l.id,
        l.token,
        l.url,
        l.prompt_id,
        l.candidate_email,
        l.created_at,
        l.expires_at,
        l.constraint_json,
        u.session_id AS consumed_session_id,
        u.used_at AS consumed_at
      FROM assessment_links l
      LEFT JOIN assessment_link_uses u ON u.link_id = l.id
      ORDER BY l.created_at DESC
    `).all() as AssessmentLinkRow[];

    return Promise.resolve(rows.map(rowToAssessmentLink));
  }

  getAssessmentLink(id: string): Promise<AssessmentLinkRecord | null> {
    const row = this.db.prepare(`
      SELECT
        l.id,
        l.token,
        l.url,
        l.prompt_id,
        l.candidate_email,
        l.created_at,
        l.expires_at,
        l.constraint_json,
        u.session_id AS consumed_session_id,
        u.used_at AS consumed_at
      FROM assessment_links l
      LEFT JOIN assessment_link_uses u ON u.link_id = l.id
      WHERE l.id = ?
    `).get(id) as AssessmentLinkRow | undefined;

    return Promise.resolve(row ? rowToAssessmentLink(row) : null);
  }

  validateSessionToken(id: string, token: string): Promise<boolean> {
    const row = this.db.prepare(
      'SELECT id FROM sessions WHERE id = ? AND token = ?'
    ).get(id, token);
    return Promise.resolve(row !== undefined);
  }

  updateSessionUsage(id: string, additionalTokens: number, additionalInteractions: number): Promise<void> {
    this.db.prepare(
      'UPDATE sessions SET tokens_used = tokens_used + ?, interactions_used = interactions_used + ? WHERE id = ?'
    ).run(additionalTokens, additionalInteractions, id);
    return Promise.resolve();
  }

  async addBranchReplayEvent(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    type: ReplayEventType,
    timestamp: number,
    payload: unknown,
  ): Promise<void> {
    this.db.prepare(
      'INSERT INTO replay_events (session_id, branch_id, turn_sequence, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sessionId, branchId, turnSequence, type, timestamp, JSON.stringify(payload));
  }

  addReplayEvent(sessionId: string, type: ReplayEventType, timestamp: number, payload: unknown): Promise<void> {
    return this.getMainBranch(sessionId).then((branch) => {
      if (!branch) {
        throw new Error(`Main branch not found for session ${sessionId}`);
      }
      return this.addBranchReplayEvent(sessionId, branch.id, null, type, timestamp, payload);
    });
  }

  getBranchReplayEvents(sessionId: string, branchId: string): Promise<StoredReplayEvent[]> {
    const rows = this.db.prepare(
      'SELECT * FROM replay_events WHERE session_id = ? AND branch_id = ? ORDER BY timestamp ASC, id ASC',
    ).all(sessionId, branchId) as ReplayEventRow[];
    return Promise.resolve(rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      branch_id: r.branch_id,
      turn_sequence: r.turn_sequence === null ? null : Number(r.turn_sequence),
      type: r.type as ReplayEventType,
      timestamp: r.timestamp,
      payload: JSON.parse(r.payload) as unknown,
    })));
  }

  getReplayEvents(sessionId: string): Promise<StoredReplayEvent[]> {
    return this.getMainBranch(sessionId).then((branch) => {
      if (!branch) {
        return [];
      }
      return this.getBranchReplayEvents(sessionId, branch.id);
    });
  }

  async upsertWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot> {
    const createdAt = input.created_at ?? Date.now();
    const existing = this.db.prepare(
      `SELECT id FROM workspace_snapshots
       WHERE session_id = ? AND branch_id = ? AND kind = ?
       ORDER BY created_at DESC LIMIT 1`,
    ).get(input.session_id, input.branch_id, input.kind) as { id: string } | undefined;

    if (existing && input.kind === 'draft') {
      this.db.prepare(
        `UPDATE workspace_snapshots
         SET turn_sequence = ?, label = ?, created_at = ?, active_path = ?, workspace_section = ?, filesystem_json = ?, mock_pg_json = ?
         WHERE id = ?`,
      ).run(
        input.turn_sequence ?? null,
        input.label ?? null,
        createdAt,
        input.active_path ?? null,
        input.workspace_section ?? null,
        JSON.stringify(input.filesystem),
        JSON.stringify(input.mock_pg),
        existing.id,
      );

      const row = this.db.prepare('SELECT * FROM workspace_snapshots WHERE id = ?').get(existing.id) as WorkspaceSnapshotRow;
      return rowToWorkspaceSnapshot(row);
    }

    return this.createWorkspaceSnapshot({ ...input, created_at: createdAt });
  }

  createWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot> {
    const id = randomUUID();
    const createdAt = input.created_at ?? Date.now();
    this.db.prepare(
      `INSERT INTO workspace_snapshots (
        id, session_id, branch_id, kind, turn_sequence, label, created_at, active_path, workspace_section, filesystem_json, mock_pg_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.session_id,
      input.branch_id,
      input.kind,
      input.turn_sequence ?? null,
      input.label ?? null,
      createdAt,
      input.active_path ?? null,
      input.workspace_section ?? null,
      JSON.stringify(input.filesystem),
      JSON.stringify(input.mock_pg),
    );

    return Promise.resolve({
      id,
      session_id: input.session_id,
      branch_id: input.branch_id,
      kind: input.kind,
      ...(input.turn_sequence !== undefined ? { turn_sequence: input.turn_sequence } : {}),
      ...(input.label ? { label: input.label } : {}),
      created_at: createdAt,
      ...(input.active_path ? { active_path: input.active_path } : {}),
      ...(input.workspace_section ? { workspace_section: input.workspace_section } : {}),
      filesystem: input.filesystem,
      mock_pg: input.mock_pg,
    });
  }

  getWorkspaceSnapshot(
    sessionId: string,
    branchId: string,
    options: { kind?: WorkspaceSnapshotKind; turn_sequence?: number } = {},
  ): Promise<WorkspaceSnapshot | null> {
    let row: WorkspaceSnapshotRow | undefined;

    if (options.turn_sequence !== undefined) {
      row = this.db.prepare(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = ? AND branch_id = ? AND turn_sequence = ? AND (? IS NULL OR kind = ?)
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(
        sessionId,
        branchId,
        options.turn_sequence,
        options.kind ?? null,
        options.kind ?? null,
      ) as WorkspaceSnapshotRow | undefined;
    } else if (options.kind) {
      row = this.db.prepare(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = ? AND branch_id = ? AND kind = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(sessionId, branchId, options.kind) as WorkspaceSnapshotRow | undefined;
    } else {
      row = this.db.prepare(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = ? AND branch_id = ?
         ORDER BY CASE WHEN kind = 'draft' THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`,
      ).get(sessionId, branchId) as WorkspaceSnapshotRow | undefined;
    }

    return Promise.resolve(row ? rowToWorkspaceSnapshot(row) : null);
  }

  markAssessmentLinkUsed(linkId: string, sessionId: string): Promise<boolean> {
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO assessment_link_uses (link_id, session_id, used_at) VALUES (?, ?, ?)',
    ).run(linkId, sessionId, Date.now());
    return Promise.resolve(result.changes > 0);
  }

  isAssessmentLinkUsed(linkId: string): Promise<boolean> {
    const row = this.db.prepare(
      'SELECT link_id FROM assessment_link_uses WHERE link_id = ?',
    ).get(linkId);
    return Promise.resolve(row !== undefined);
  }

  getAssessmentLinkSessionId(linkId: string): Promise<string | null> {
    const row = this.db.prepare(
      'SELECT session_id FROM assessment_link_uses WHERE link_id = ?',
    ).get(linkId) as { session_id: string } | undefined;
    return Promise.resolve(row?.session_id ?? null);
  }
}

export interface PostgresAdapterConfig {
  connectionString: string;
  pool?: Pool;
  poolConfig?: Omit<PoolConfig, 'connectionString'>;
}

export class PostgresAdapter implements DatabaseAdapter {
  private readonly pool: Pool;
  private initializationPromise: Promise<void> | null = null;

  constructor(config: PostgresAdapterConfig) {
    this.pool = config.pool ?? new Pool({
      connectionString: config.connectionString,
      max: 10,
      ...config.poolConfig,
    });
  }

  async initialize(): Promise<void> {
    if (this.initializationPromise === null) {
      this.initializationPromise = this.bootstrapSchema();
    }
    await this.initializationPromise;
  }

  async createSession(config: CreateSessionConfig): Promise<{ id: string; token: string }> {
    await this.initialize();

    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const branchId = randomUUID();

    await this.pool.query(
      `INSERT INTO sessions (
        id, token, prompt_id, candidate_email, status, created_at,
        max_session_tokens, max_message_tokens, max_interactions,
        context_window, time_limit_minutes, tokens_used, interactions_used
      ) VALUES (
        $1, $2, $3, $4, 'active', $5,
        $6, $7, $8,
        $9, $10, 0, 0
      )`,
      [
        id,
        token,
        config.prompt_id,
        config.candidate_email,
        now,
        config.constraint.max_session_tokens,
        config.constraint.max_message_tokens,
        config.constraint.max_interactions,
        config.constraint.context_window,
        config.constraint.time_limit_minutes,
      ],
    );

    await this.pool.query(
      `INSERT INTO session_branches (
        id, session_id, name, parent_branch_id, forked_from_sequence, created_at
      ) VALUES ($1, $2, 'main', NULL, NULL, $3)`,
      [branchId, id, now],
    );

    return { id, token };
  }

  async createAssessmentLink(config: CreateAssessmentLinkConfig): Promise<AssessmentLinkRecord> {
    await this.initialize();

    await this.pool.query(
      `INSERT INTO assessment_links (
        id, token, url, prompt_id, candidate_email, created_at, expires_at, constraint_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8
      )`,
      [
        config.id,
        config.token,
        config.url,
        config.prompt_id,
        config.candidate_email,
        config.created_at,
        config.expires_at,
        JSON.stringify(config.constraint),
      ],
    );

    return {
      id: config.id,
      token: config.token,
      url: config.url,
      prompt_id: config.prompt_id,
      candidate_email: config.candidate_email,
      created_at: config.created_at,
      expires_at: config.expires_at,
      constraint: config.constraint,
    };
  }

  async getSession(id: string): Promise<Session | null> {
    await this.initialize();
    const result = await this.pool.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    return result.rows[0] ? rowToSession(normalizeSessionRow(result.rows[0])) : null;
  }

  async getSessionToken(id: string): Promise<string | null> {
    await this.initialize();
    const result = await this.pool.query<{ token: string }>('SELECT token FROM sessions WHERE id = $1', [id]);
    return result.rows[0]?.token ?? null;
  }

  async getMainBranch(sessionId: string): Promise<SessionBranch | null> {
    await this.initialize();
    const result = await this.pool.query<SessionBranchRow>(
      "SELECT * FROM session_branches WHERE session_id = $1 AND name = 'main' LIMIT 1",
      [sessionId],
    );
    return result.rows[0] ? rowToSessionBranch(normalizeSessionBranchRow(result.rows[0])) : null;
  }

  async getBranch(sessionId: string, branchId: string): Promise<SessionBranch | null> {
    await this.initialize();
    const result = await this.pool.query<SessionBranchRow>(
      'SELECT * FROM session_branches WHERE session_id = $1 AND id = $2 LIMIT 1',
      [sessionId, branchId],
    );
    return result.rows[0] ? rowToSessionBranch(normalizeSessionBranchRow(result.rows[0])) : null;
  }

  async listBranches(sessionId: string): Promise<SessionBranch[]> {
    await this.initialize();
    const result = await this.pool.query<SessionBranchRow>(
      'SELECT * FROM session_branches WHERE session_id = $1 ORDER BY created_at ASC, id ASC',
      [sessionId],
    );
    return result.rows.map((row) => rowToSessionBranch(normalizeSessionBranchRow(row)));
  }

  async createBranch(config: CreateBranchConfig): Promise<SessionBranch> {
    await this.initialize();
    const id = randomUUID();
    const createdAt = Date.now();
    await this.pool.query(
      `INSERT INTO session_branches (
        id, session_id, name, parent_branch_id, forked_from_sequence, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, config.session_id, config.name, config.parent_branch_id, config.forked_from_sequence, createdAt],
    );

    await this.pool.query(
      `INSERT INTO messages (session_id, branch_id, turn_sequence, role, content, token_count, created_at)
       SELECT session_id, $1, turn_sequence, role, content, token_count, created_at
       FROM messages
       WHERE session_id = $2 AND branch_id = $3 AND turn_sequence IS NOT NULL AND turn_sequence <= $4
       ORDER BY id ASC`,
      [id, config.session_id, config.parent_branch_id, config.forked_from_sequence],
    );

    await this.pool.query(
      `INSERT INTO replay_events (session_id, branch_id, turn_sequence, type, timestamp, payload)
       SELECT session_id, $1, turn_sequence, type, timestamp, payload
       FROM replay_events
       WHERE session_id = $2 AND branch_id = $3 AND turn_sequence IS NOT NULL AND turn_sequence <= $4
       ORDER BY timestamp ASC, id ASC`,
      [id, config.session_id, config.parent_branch_id, config.forked_from_sequence],
    );

    const snapshotResult = await this.pool.query<WorkspaceSnapshotRow>(
      `SELECT * FROM workspace_snapshots
       WHERE session_id = $1 AND branch_id = $2 AND (
         kind = 'draft' OR (turn_sequence IS NOT NULL AND turn_sequence <= $3)
       )
       ORDER BY CASE WHEN kind = 'draft' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
      [config.session_id, config.parent_branch_id, config.forked_from_sequence],
    );

    const snapshot = snapshotResult.rows[0];
    if (snapshot) {
      const normalized = normalizeWorkspaceSnapshotRow(snapshot);
      await this.pool.query(
        `INSERT INTO workspace_snapshots (
          id, session_id, branch_id, kind, turn_sequence, label, created_at, active_path, workspace_section, filesystem_json, mock_pg_json
        ) VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10)`,
        [
          randomUUID(),
          normalized.session_id,
          id,
          normalized.turn_sequence,
          normalized.label,
          createdAt,
          normalized.active_path,
          normalized.workspace_section,
          normalized.filesystem_json,
          normalized.mock_pg_json,
        ],
      );
    }

    return {
      id,
      session_id: config.session_id,
      name: config.name,
      parent_branch_id: config.parent_branch_id,
      forked_from_sequence: config.forked_from_sequence,
      created_at: createdAt,
    };
  }

  async allocateTurnSequence(sessionId: string): Promise<number> {
    await this.initialize();
    const result = await this.pool.query<{ max_turn_sequence: number | null }>(
      `SELECT MAX(turn_sequence) AS max_turn_sequence FROM (
         SELECT turn_sequence FROM messages WHERE session_id = $1
         UNION ALL
         SELECT turn_sequence FROM replay_events WHERE session_id = $1
         UNION ALL
         SELECT turn_sequence FROM workspace_snapshots WHERE session_id = $1
       ) AS turn_sequences`,
      [sessionId],
    );
    return Number(result.rows[0]?.max_turn_sequence ?? 0) + 1;
  }

  async addBranchMessage(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    role: MessageRole,
    content: string,
    tokenCount: number,
  ): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO messages (session_id, branch_id, turn_sequence, role, content, token_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sessionId, branchId, turnSequence, role, content, tokenCount, Date.now()],
    );
  }

  async addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void> {
    const branch = await this.getMainBranch(sessionId);
    if (!branch) {
      throw new Error(`Main branch not found for session ${sessionId}`);
    }
    await this.addBranchMessage(sessionId, branch.id, null, role, content, tokenCount);
  }

  async getBranchMessages(sessionId: string, branchId: string): Promise<StoredMessage[]> {
    await this.initialize();
    const result = await this.pool.query<MessageRow>(
      'SELECT * FROM messages WHERE session_id = $1 AND branch_id = $2 ORDER BY id ASC',
      [sessionId, branchId],
    );

    return result.rows.map((row) => ({
      id: Number(row.id),
      session_id: row.session_id,
      branch_id: row.branch_id,
      turn_sequence: row.turn_sequence === null ? null : Number(row.turn_sequence),
      role: row.role as MessageRole,
      content: row.content,
      token_count: Number(row.token_count),
      created_at: Number(row.created_at),
    }));
  }

  async getMessages(sessionId: string): Promise<StoredMessage[]> {
    const branch = await this.getMainBranch(sessionId);
    if (!branch) {
      return [];
    }
    return this.getBranchMessages(sessionId, branch.id);
  }

  async closeSession(id: string): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `UPDATE sessions SET status = 'completed', closed_at = $1 WHERE id = $2`,
      [Date.now(), id],
    );
  }

  async listSessions(): Promise<Session[]> {
    await this.initialize();
    const result = await this.pool.query<SessionRow>('SELECT * FROM sessions ORDER BY created_at DESC');
    return result.rows.map((row) => rowToSession(normalizeSessionRow(row)));
  }

  async getSessionsByPrompt(promptId: string): Promise<Session[]> {
    await this.initialize();
    const result = await this.pool.query<SessionRow>(
      'SELECT * FROM sessions WHERE prompt_id = $1 ORDER BY created_at DESC',
      [promptId],
    );
    return result.rows.map((row) => rowToSession(normalizeSessionRow(row)));
  }

  async listAssessmentLinks(): Promise<AssessmentLinkRecord[]> {
    await this.initialize();
    const result = await this.pool.query<AssessmentLinkRow>(
      `SELECT
         l.id,
         l.token,
         l.url,
         l.prompt_id,
         l.candidate_email,
         l.created_at,
         l.expires_at,
         l.constraint_json,
         u.session_id AS consumed_session_id,
         u.used_at AS consumed_at
       FROM assessment_links l
       LEFT JOIN assessment_link_uses u ON u.link_id = l.id
       ORDER BY l.created_at DESC`,
    );
    return result.rows.map((row) => rowToAssessmentLink(normalizeAssessmentLinkRow(row)));
  }

  async getAssessmentLink(id: string): Promise<AssessmentLinkRecord | null> {
    await this.initialize();
    const result = await this.pool.query<AssessmentLinkRow>(
      `SELECT
         l.id,
         l.token,
         l.url,
         l.prompt_id,
         l.candidate_email,
         l.created_at,
         l.expires_at,
         l.constraint_json,
         u.session_id AS consumed_session_id,
         u.used_at AS consumed_at
       FROM assessment_links l
       LEFT JOIN assessment_link_uses u ON u.link_id = l.id
       WHERE l.id = $1`,
      [id],
    );
    return result.rows[0] ? rowToAssessmentLink(normalizeAssessmentLinkRow(result.rows[0])) : null;
  }

  async validateSessionToken(id: string, token: string): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query('SELECT id FROM sessions WHERE id = $1 AND token = $2', [id, token]);
    return result.rows.length > 0;
  }

  async updateSessionUsage(id: string, additionalTokens: number, additionalInteractions: number): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `UPDATE sessions
       SET tokens_used = tokens_used + $1, interactions_used = interactions_used + $2
       WHERE id = $3`,
      [additionalTokens, additionalInteractions, id],
    );
  }

  async addReplayEvent(sessionId: string, type: ReplayEventType, timestamp: number, payload: unknown): Promise<void> {
    const branch = await this.getMainBranch(sessionId);
    if (!branch) {
      throw new Error(`Main branch not found for session ${sessionId}`);
    }
    await this.addBranchReplayEvent(sessionId, branch.id, null, type, timestamp, payload);
  }

  async addBranchReplayEvent(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    type: ReplayEventType,
    timestamp: number,
    payload: unknown,
  ): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO replay_events (session_id, branch_id, turn_sequence, type, timestamp, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, branchId, turnSequence, type, timestamp, JSON.stringify(payload)],
    );
  }

  async getBranchReplayEvents(sessionId: string, branchId: string): Promise<StoredReplayEvent[]> {
    await this.initialize();
    const result = await this.pool.query<ReplayEventRow>(
      'SELECT * FROM replay_events WHERE session_id = $1 AND branch_id = $2 ORDER BY timestamp ASC, id ASC',
      [sessionId, branchId],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      session_id: row.session_id,
      branch_id: row.branch_id,
      turn_sequence: row.turn_sequence === null ? null : Number(row.turn_sequence),
      type: row.type as ReplayEventType,
      timestamp: Number(row.timestamp),
      payload: JSON.parse(row.payload) as unknown,
    }));
  }

  async getReplayEvents(sessionId: string): Promise<StoredReplayEvent[]> {
    const branch = await this.getMainBranch(sessionId);
    if (!branch) {
      return [];
    }
    return this.getBranchReplayEvents(sessionId, branch.id);
  }

  async upsertWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot> {
    await this.initialize();
    if (input.kind === 'draft') {
      const existing = await this.pool.query<{ id: string }>(
        `SELECT id FROM workspace_snapshots
         WHERE session_id = $1 AND branch_id = $2 AND kind = 'draft'
         ORDER BY created_at DESC
         LIMIT 1`,
        [input.session_id, input.branch_id],
      );
      if (existing.rows[0]?.id) {
        const createdAt = input.created_at ?? Date.now();
        await this.pool.query(
          `UPDATE workspace_snapshots
           SET turn_sequence = $1, label = $2, created_at = $3, active_path = $4, workspace_section = $5, filesystem_json = $6, mock_pg_json = $7
           WHERE id = $8`,
          [
            input.turn_sequence ?? null,
            input.label ?? null,
            createdAt,
            input.active_path ?? null,
            input.workspace_section ?? null,
            JSON.stringify(input.filesystem),
            JSON.stringify(input.mock_pg),
            existing.rows[0].id,
          ],
        );
        const rowResult = await this.pool.query<WorkspaceSnapshotRow>(
          'SELECT * FROM workspace_snapshots WHERE id = $1',
          [existing.rows[0].id],
        );
        return rowToWorkspaceSnapshot(normalizeWorkspaceSnapshotRow(rowResult.rows[0]!));
      }
    }

    return this.createWorkspaceSnapshot(input);
  }

  async createWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot> {
    await this.initialize();
    const id = randomUUID();
    const createdAt = input.created_at ?? Date.now();
    await this.pool.query(
      `INSERT INTO workspace_snapshots (
        id, session_id, branch_id, kind, turn_sequence, label, created_at, active_path, workspace_section, filesystem_json, mock_pg_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        input.session_id,
        input.branch_id,
        input.kind,
        input.turn_sequence ?? null,
        input.label ?? null,
        createdAt,
        input.active_path ?? null,
        input.workspace_section ?? null,
        JSON.stringify(input.filesystem),
        JSON.stringify(input.mock_pg),
      ],
    );
    return {
      id,
      session_id: input.session_id,
      branch_id: input.branch_id,
      kind: input.kind,
      ...(input.turn_sequence !== undefined ? { turn_sequence: input.turn_sequence } : {}),
      ...(input.label ? { label: input.label } : {}),
      created_at: createdAt,
      ...(input.active_path ? { active_path: input.active_path } : {}),
      ...(input.workspace_section ? { workspace_section: input.workspace_section } : {}),
      filesystem: input.filesystem,
      mock_pg: input.mock_pg,
    };
  }

  async getWorkspaceSnapshot(
    sessionId: string,
    branchId: string,
    options: { kind?: WorkspaceSnapshotKind; turn_sequence?: number } = {},
  ): Promise<WorkspaceSnapshot | null> {
    await this.initialize();
    let result;
    if (options.turn_sequence !== undefined) {
      result = await this.pool.query<WorkspaceSnapshotRow>(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = $1 AND branch_id = $2 AND turn_sequence = $3 AND ($4::text IS NULL OR kind = $4)
         ORDER BY created_at DESC
         LIMIT 1`,
        [sessionId, branchId, options.turn_sequence, options.kind ?? null],
      );
    } else if (options.kind) {
      result = await this.pool.query<WorkspaceSnapshotRow>(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = $1 AND branch_id = $2 AND kind = $3
         ORDER BY created_at DESC
         LIMIT 1`,
        [sessionId, branchId, options.kind],
      );
    } else {
      result = await this.pool.query<WorkspaceSnapshotRow>(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = $1 AND branch_id = $2
         ORDER BY CASE WHEN kind = 'draft' THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`,
        [sessionId, branchId],
      );
    }

    return result.rows[0] ? rowToWorkspaceSnapshot(normalizeWorkspaceSnapshotRow(result.rows[0])) : null;
  }

  async markAssessmentLinkUsed(linkId: string, sessionId: string): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query(
      `INSERT INTO assessment_link_uses (link_id, session_id, used_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (link_id) DO NOTHING`,
      [linkId, sessionId, Date.now()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async isAssessmentLinkUsed(linkId: string): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query(
      'SELECT link_id FROM assessment_link_uses WHERE link_id = $1',
      [linkId],
    );
    return result.rows.length > 0;
  }

  async getAssessmentLinkSessionId(linkId: string): Promise<string | null> {
    await this.initialize();
    const result = await this.pool.query<{ session_id: string }>(
      'SELECT session_id FROM assessment_link_uses WHERE link_id = $1',
      [linkId],
    );
    return result.rows[0]?.session_id ?? null;
  }

  private async bootstrapSchema(): Promise<void> {
    try {
      for (const statement of POSTGRES_SCHEMA_STATEMENTS) {
        await this.pool.query(statement);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize PostgreSQL database schema: ${message}`);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeSessionRow(row: SessionRow): SessionRow {
  return {
    ...row,
    created_at: Number(row.created_at),
    closed_at: row.closed_at === null ? null : Number(row.closed_at),
    max_session_tokens: Number(row.max_session_tokens),
    max_message_tokens: Number(row.max_message_tokens),
    max_interactions: Number(row.max_interactions),
    context_window: Number(row.context_window),
    time_limit_minutes: Number(row.time_limit_minutes),
    tokens_used: Number(row.tokens_used),
    interactions_used: Number(row.interactions_used),
    score: row.score === null ? null : Number(row.score),
  };
}

function normalizeAssessmentLinkRow(row: AssessmentLinkRow): AssessmentLinkRow {
  return {
    ...row,
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
    consumed_at: row.consumed_at === null || row.consumed_at === undefined ? null : Number(row.consumed_at),
  };
}

function normalizeSessionBranchRow(row: SessionBranchRow): SessionBranchRow {
  return {
    ...row,
    forked_from_sequence:
      row.forked_from_sequence === null || row.forked_from_sequence === undefined
        ? null
        : Number(row.forked_from_sequence),
    created_at: Number(row.created_at),
  };
}

function normalizeWorkspaceSnapshotRow(row: WorkspaceSnapshotRow): WorkspaceSnapshotRow {
  return {
    ...row,
    turn_sequence:
      row.turn_sequence === null || row.turn_sequence === undefined ? null : Number(row.turn_sequence),
    created_at: Number(row.created_at),
  };
}

function rowToSession(row: SessionRow): Session {
  const constraint: Constraint = {
    max_session_tokens: row.max_session_tokens,
    max_message_tokens: row.max_message_tokens,
    max_interactions: row.max_interactions,
    context_window: row.context_window,
    time_limit_minutes: row.time_limit_minutes,
  };

  const session: Session = {
    id: row.id,
    prompt_id: row.prompt_id,
    candidate_email: row.candidate_email,
    status: row.status as SessionStatus,
    created_at: row.created_at,
    constraint,
    tokens_used: row.tokens_used,
    interactions_used: row.interactions_used,
  };

  if (row.closed_at !== null) {
    session.closed_at = row.closed_at;
  }
  if (row.score !== null) {
    session.score = row.score;
  }

  return session;
}

function rowToSessionBranch(row: SessionBranchRow): SessionBranch {
  const branch: SessionBranch = {
    id: row.id,
    session_id: row.session_id,
    name: row.name,
    created_at: row.created_at,
  };

  if (row.parent_branch_id) {
    branch.parent_branch_id = row.parent_branch_id;
  }

  if (row.forked_from_sequence !== null && row.forked_from_sequence !== undefined) {
    branch.forked_from_sequence = row.forked_from_sequence;
  }

  return branch;
}

function rowToWorkspaceSnapshot(row: WorkspaceSnapshotRow): WorkspaceSnapshot {
  const snapshot: WorkspaceSnapshot = {
    id: row.id,
    session_id: row.session_id,
    branch_id: row.branch_id,
    kind: row.kind as WorkspaceSnapshotKind,
    created_at: row.created_at,
    filesystem: JSON.parse(row.filesystem_json) as SnapshotFile[],
    mock_pg: JSON.parse(row.mock_pg_json) as MockPgPoolExport[],
  };

  if (row.turn_sequence !== null && row.turn_sequence !== undefined) {
    snapshot.turn_sequence = row.turn_sequence;
  }

  if (row.label) {
    snapshot.label = row.label;
  }

  if (row.active_path) {
    snapshot.active_path = row.active_path;
  }

  if (row.workspace_section) {
    snapshot.workspace_section = row.workspace_section as WorkspaceSection;
  }

  return snapshot;
}

function rowToAssessmentLink(row: AssessmentLinkRow): AssessmentLinkRecord {
  const link: AssessmentLinkRecord = {
    id: row.id,
    token: row.token,
    url: row.url,
    prompt_id: row.prompt_id,
    candidate_email: row.candidate_email,
    created_at: row.created_at,
    expires_at: row.expires_at,
    constraint: JSON.parse(row.constraint_json) as Constraint,
  };

  if (row.consumed_session_id) {
    link.consumed_session_id = row.consumed_session_id;
  }
  if (row.consumed_at !== null && row.consumed_at !== undefined) {
    link.consumed_at = row.consumed_at;
  }

  return link;
}
