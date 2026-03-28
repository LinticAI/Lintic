import { randomUUID, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Session, SessionStatus, Constraint, MessageRole, ReplayEventType } from './types.js';

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

// ─── DatabaseAdapter Interface ────────────────────────────────────────────────

export interface DatabaseAdapter {
  createSession(config: CreateSessionConfig): Promise<{ id: string; token: string }>;
  getSession(id: string): Promise<Session | null>;
  addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void>;
  getMessages(sessionId: string): Promise<StoredMessage[]>;
  closeSession(id: string): Promise<void>;
  listSessions(): Promise<Session[]>;
  getSessionsByPrompt(promptId: string): Promise<Session[]>;
  validateSessionToken(id: string, token: string): Promise<boolean>;
  updateSessionUsage(id: string, additionalTokens: number, additionalInteractions: number): Promise<void>;
  addReplayEvent(sessionId: string, type: ReplayEventType, timestamp: number, payload: unknown): Promise<void>;
  getReplayEvents(sessionId: string): Promise<StoredReplayEvent[]>;
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

// ─── SQLiteAdapter ────────────────────────────────────────────────────────────

export class SQLiteAdapter implements DatabaseAdapter {
  private readonly db: Database.Database;

  constructor(dbPath: string = 'lintic.db') {
    this.db = new Database(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
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
    `);
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

  getSession(id: string): Promise<Session | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return Promise.resolve(row ? rowToSession(row) : null);
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
