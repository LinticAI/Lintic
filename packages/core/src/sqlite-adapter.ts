import Database from 'better-sqlite3';
import { SignJWT } from 'jose';
import type { DatabaseAdapter, CreateSessionParams } from './database.js';
import type { Session, Message, MessageRole, Constraint } from './types.js';

interface SessionRow {
  id: string;
  prompt_id: string;
  candidate_email: string;
  status: string;
  created_at: number;
  closed_at: number | null;
  constraint_json: string;
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

function rowToSession(row: SessionRow): Session {
  const session: Session = {
    id: row.id,
    prompt_id: row.prompt_id,
    candidate_email: row.candidate_email,
    status: row.status as Session['status'],
    created_at: row.created_at,
    constraint: JSON.parse(row.constraint_json) as Constraint,
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

export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database;
  private jwtSecret: Uint8Array;
  private linkExpiryHours: number;

  constructor(config: { path?: string; jwt_secret: string; link_expiry_hours?: number }) {
    const dbPath = config.path ?? './lintic.db';
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.jwtSecret = new TextEncoder().encode(config.jwt_secret);
    this.linkExpiryHours = config.link_expiry_hours ?? 168;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        prompt_id TEXT NOT NULL,
        candidate_email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        constraint_json TEXT NOT NULL,
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
    `);
  }

  async createSession(params: CreateSessionParams): Promise<{ sessionId: string; linkToken: string }> {
    const sessionId = crypto.randomUUID();
    const createdAt = Date.now();

    this.db.prepare(`
      INSERT INTO sessions (id, prompt_id, candidate_email, status, created_at, constraint_json, tokens_used, interactions_used)
      VALUES (?, ?, ?, 'active', ?, ?, 0, 0)
    `).run(sessionId, params.promptId, params.candidateEmail, createdAt, JSON.stringify(params.constraint));

    const linkToken = await new SignJWT({ sub: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(`${this.linkExpiryHours}h`)
      .sign(this.jwtSecret);

    return { sessionId, linkToken };
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  async addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void> {
    this.db.prepare(`
      INSERT INTO messages (session_id, role, content, token_count, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, role, content, tokenCount, Date.now());
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as MessageRow[];

    return rows.map(row => ({
      role: row.role as MessageRole,
      content: row.content,
    }));
  }

  async closeSession(id: string): Promise<void> {
    const result = this.db.prepare("UPDATE sessions SET status = 'completed', closed_at = ? WHERE id = ?")
      .run(Date.now(), id);
    if (result.changes === 0) {
      throw new Error(`Session not found: ${id}`);
    }
  }

  async listSessions(): Promise<Session[]> {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as SessionRow[];
    return rows.map(rowToSession);
  }

  async getSessionsByPrompt(promptId: string): Promise<Session[]> {
    const rows = this.db.prepare(
      'SELECT * FROM sessions WHERE prompt_id = ? ORDER BY created_at DESC'
    ).all(promptId) as SessionRow[];
    return rows.map(rowToSession);
  }
}
