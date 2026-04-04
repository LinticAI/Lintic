import { randomUUID, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { Pool, type PoolConfig } from 'pg';
import type { AssessmentLinkRecord, Session, SessionStatus, Constraint, MessageRole, ReplayEventType } from './types.js';

// ─── Stored Message ───────────────────────────────────────────────────────────

export interface StoredMessage {
  id: number;
  session_id: string;
  role: MessageRole;
  content: string;
  token_count: number;
  created_at: number; // Unix ms
}

// ─── Stored Replay Event ──────────────────────────────────────────────────────

export interface StoredReplayEvent {
  id: number;
  session_id: string;
  type: ReplayEventType;
  timestamp: number; // Unix ms
  payload: unknown;
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
  role: string;
  content: string;
  token_count: number;
  created_at: number;
}

interface ReplayEventRow {
  id: number;
  session_id: string;
  type: string;
  timestamp: number;
  payload: string; // JSON text
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
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS replay_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    type      TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    payload   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_replay_events_session
    ON replay_events(session_id, timestamp ASC);

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
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS replay_events (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    type TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_replay_events_session
    ON replay_events(session_id, timestamp ASC, id ASC)`,
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
  }

  createSession(config: CreateSessionConfig): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const now = Date.now();

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

  addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void> {
    this.db.prepare(`
      INSERT INTO messages (session_id, role, content, token_count, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, role, content, tokenCount, Date.now());
    return Promise.resolve();
  }

  getMessages(sessionId: string): Promise<StoredMessage[]> {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC'
    ).all(sessionId) as MessageRow[];

    const messages = rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      role: r.role as MessageRole,
      content: r.content,
      token_count: r.token_count,
      created_at: r.created_at,
    }));
    return Promise.resolve(messages);
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

  addReplayEvent(sessionId: string, type: ReplayEventType, timestamp: number, payload: unknown): Promise<void> {
    this.db.prepare(
      'INSERT INTO replay_events (session_id, type, timestamp, payload) VALUES (?, ?, ?, ?)'
    ).run(sessionId, type, timestamp, JSON.stringify(payload));
    return Promise.resolve();
  }

  getReplayEvents(sessionId: string): Promise<StoredReplayEvent[]> {
    const rows = this.db.prepare(
      'SELECT * FROM replay_events WHERE session_id = ? ORDER BY timestamp ASC, id ASC'
    ).all(sessionId) as ReplayEventRow[];
    return Promise.resolve(rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      type: r.type as ReplayEventType,
      timestamp: r.timestamp,
      payload: JSON.parse(r.payload) as unknown,
    })));
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

  async addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO messages (session_id, role, content, token_count, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, role, content, tokenCount, Date.now()],
    );
  }

  async getMessages(sessionId: string): Promise<StoredMessage[]> {
    await this.initialize();
    const result = await this.pool.query<MessageRow>(
      'SELECT * FROM messages WHERE session_id = $1 ORDER BY id ASC',
      [sessionId],
    );

    return result.rows.map((row) => ({
      id: Number(row.id),
      session_id: row.session_id,
      role: row.role as MessageRole,
      content: row.content,
      token_count: Number(row.token_count),
      created_at: Number(row.created_at),
    }));
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
    await this.initialize();
    await this.pool.query(
      `INSERT INTO replay_events (session_id, type, timestamp, payload)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, type, timestamp, JSON.stringify(payload)],
    );
  }

  async getReplayEvents(sessionId: string): Promise<StoredReplayEvent[]> {
    await this.initialize();
    const result = await this.pool.query<ReplayEventRow>(
      'SELECT * FROM replay_events WHERE session_id = $1 ORDER BY timestamp ASC, id ASC',
      [sessionId],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      session_id: row.session_id,
      type: row.type as ReplayEventType,
      timestamp: Number(row.timestamp),
      payload: JSON.parse(row.payload) as unknown,
    }));
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
