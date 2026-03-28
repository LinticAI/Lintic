import { describe, test, expect } from 'vitest';
import request from 'supertest';
import type {
  DatabaseAdapter,
  AgentAdapter,
  AgentConfig,
  AgentResponse,
  AgentCapabilities,
  TokenUsage,
  ToolDefinition,
  SessionContext,
  Session,
  StoredMessage,
  StoredReplayEvent,
  CreateSessionConfig,
  MessageRole,
  ReplayEventType,
  Config,
  Constraint,
} from '@lintic/core';
import { createApp } from './app.js';

// ─── Fake DatabaseAdapter ────────────────────────────────────────────────────

const BASE_CONSTRAINT: Constraint = {
  max_session_tokens: 10000,
  max_message_tokens: 2000,
  max_interactions: 20,
  context_window: 8000,
  time_limit_minutes: 60,
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    prompt_id: 'test-prompt',
    candidate_email: 'candidate@example.com',
    status: 'active',
    created_at: Date.now(),
    constraint: BASE_CONSTRAINT,
    tokens_used: 0,
    interactions_used: 0,
    ...overrides,
  };
}

class FakeDb implements DatabaseAdapter {
  sessions = new Map<string, Session & { token: string }>();
  messageStore = new Map<string, StoredMessage[]>();
  replayStore = new Map<string, StoredReplayEvent[]>();
  nextMsgId = 1;

  createSession(config: CreateSessionConfig): Promise<{ id: string; token: string }> {
    const id = `sess-${this.sessions.size + 1}`;
    const token = 'test-token-abc';
    const session = {
      id,
      token,
      prompt_id: config.prompt_id,
      candidate_email: config.candidate_email,
      status: 'active' as const,
      created_at: Date.now(),
      constraint: config.constraint,
      tokens_used: 0,
      interactions_used: 0,
    };
    this.sessions.set(id, session);
    this.messageStore.set(id, []);
    this.replayStore.set(id, []);
    return Promise.resolve({ id, token });
  }

  getSession(id: string): Promise<Session | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void> {
    const msgs = this.messageStore.get(sessionId) ?? [];
    msgs.push({
      id: this.nextMsgId++,
      session_id: sessionId,
      role,
      content,
      token_count: tokenCount,
      created_at: Date.now(),
    });
    this.messageStore.set(sessionId, msgs);
    return Promise.resolve();
  }

  getMessages(sessionId: string): Promise<StoredMessage[]> {
    return Promise.resolve(this.messageStore.get(sessionId) ?? []);
  }

  closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.set(id, { ...session, status: 'completed', closed_at: Date.now() });
    }
    return Promise.resolve();
  }

  listSessions(): Promise<Session[]> {
    return Promise.resolve([...this.sessions.values()]);
  }

  getSessionsByPrompt(promptId: string): Promise<Session[]> {
    return Promise.resolve([...this.sessions.values()].filter((s) => s.prompt_id === promptId));
  }

  validateSessionToken(id: string, token: string): Promise<boolean> {
    const session = this.sessions.get(id);
    return Promise.resolve(session?.token === token);
  }

  updateSessionUsage(id: string, additionalTokens: number, additionalInteractions: number): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.set(id, {
        ...session,
        tokens_used: session.tokens_used + additionalTokens,
        interactions_used: session.interactions_used + additionalInteractions,
      });
    }
    return Promise.resolve();
  }

  addReplayEvent(sessionId: string, type: ReplayEventType, timestamp: number, payload: unknown): Promise<void> {
    const events = this.replayStore.get(sessionId) ?? [];
    events.push({ id: events.length + 1, session_id: sessionId, type, timestamp, payload });
    this.replayStore.set(sessionId, events);
    return Promise.resolve();
  }

  getReplayEvents(sessionId: string): Promise<StoredReplayEvent[]> {
    return Promise.resolve(this.replayStore.get(sessionId) ?? []);
  }
}

// ─── Fake AgentAdapter ────────────────────────────────────────────────────────

class FakeAdapter implements AgentAdapter {
  lastUsage: TokenUsage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };

  init(_config: AgentConfig): Promise<void> {
    return Promise.resolve();
  }

  sendMessage(_msg: string, _ctx: SessionContext): Promise<AgentResponse> {
    return Promise.resolve({
      content: 'Hello from the agent!',
      usage: this.lastUsage,
      stop_reason: 'end_turn',
    });
  }

  getTokenUsage(): TokenUsage {
    return this.lastUsage;
  }

  getCapabilities(): AgentCapabilities {
    return { supports_system_prompt: true, supports_tool_use: false, max_context_window: 8000 };
  }

  getTools(): ToolDefinition[] {
    return [];
  }
}

// ─── Test Config ──────────────────────────────────────────────────────────────

const TEST_CONFIG: Config = {
  agent: { provider: 'openai-compatible', api_key: 'key', model: 'gpt-4o', base_url: 'https://api.openai.com' },
  constraints: BASE_CONSTRAINT,
  prompts: [{ id: 'test-prompt', title: 'Test Prompt' }],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('returns 200 with status ok', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('POST /api/sessions', () => {
  test('creates a session and returns session_id, token, assessment_link', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/sessions')
      .send({ prompt_id: 'test-prompt', candidate_email: 'a@b.com' });

    expect(res.status).toBe(201);
    const body = res.body as { session_id: string; token: string; assessment_link: string };
    expect(typeof body.session_id).toBe('string');
    expect(typeof body.token).toBe('string');
    expect(body.assessment_link).toContain(body.session_id);
  });

  test('returns 400 when prompt_id is missing', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/sessions')
      .send({ candidate_email: 'a@b.com' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when candidate_email is missing', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/sessions')
      .send({ prompt_id: 'test-prompt' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/sessions/:id', () => {
  test('returns 401 with no auth header', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app).get('/api/sessions/sess-1');
    expect(res.status).toBe(401);
  });

  test('returns 401 with invalid token', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get('/api/sessions/sess-1')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  test('returns 404 for unknown session', async () => {
    const db = new FakeDb();
    // We bypass createSession so no session exists, but we need a token that passes validateSessionToken.
    // validateSessionToken returns false for unknown sessions, so we'd get 401.
    // Instead, seed the session map directly:
    db.sessions.set('unknown-id', { ...makeSession({ id: 'unknown-id' }), token: 'tok' });
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    // Delete from sessions after seeding to trigger 404 path — simpler: use getSession returning null.
    // Use a custom override:
    const origGet = db.getSession.bind(db);
    db.getSession = (id: string): Promise<Session | null> =>
      id === 'unknown-id' ? Promise.resolve(null) : origGet(id);
    const res = await request(app)
      .get('/api/sessions/unknown-id')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(404);
  });

  test('returns session state and constraints_remaining for valid request', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = res.body as { session: { id: string }; constraints_remaining: { tokens_remaining: number; interactions_remaining: number; seconds_remaining: number } };
    expect(body.session.id).toBe(id);
    expect(typeof body.constraints_remaining.tokens_remaining).toBe('number');
    expect(typeof body.constraints_remaining.interactions_remaining).toBe('number');
    expect(typeof body.constraints_remaining.seconds_remaining).toBe('number');
  });
});

describe('POST /api/sessions/:id/messages', () => {
  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(401);
  });

  test('returns 400 when message is missing', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('proxies message through adapter and returns response', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Write a function' });

    expect(res.status).toBe(200);
    const body = res.body as { content: string; stop_reason: string; usage: { total_tokens: number } };
    expect(body.content).toBe('Hello from the agent!');
    expect(body.stop_reason).toBe('end_turn');
    expect(typeof body.usage.total_tokens).toBe('number');
  });

  test('stores user and assistant messages in db', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello agent' });

    const msgs = await db.getMessages(id);
    expect(msgs.some((m) => m.role === 'user')).toBe(true);
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true);
  });

  test('updates session usage counters', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const session = await db.getSession(id);
    expect(session?.tokens_used).toBeGreaterThan(0);
    expect(session?.interactions_used).toBe(1);
  });

  test('returns 429 when token budget exhausted', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const exhaustedConstraint: Constraint = { ...BASE_CONSTRAINT, max_session_tokens: 0 };
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: exhaustedConstraint });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(429);
  });

  test('returns 429 when interaction limit exhausted', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const exhaustedConstraint: Constraint = { ...BASE_CONSTRAINT, max_interactions: 0 };
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: exhaustedConstraint });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(429);
  });

  test('returns 409 when session is not active', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    await db.closeSession(id);
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(409);
  });

  test('returns 502 when adapter throws', async () => {
    const db = new FakeDb();
    const adapter = new FakeAdapter();
    adapter.sendMessage = (): Promise<AgentResponse> => { throw new Error('API down'); };
    const app = createApp(db, adapter, TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(502);
  });

  test('includes updated constraints_remaining in response', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const body = res.body as { constraints_remaining: { interactions_remaining: number } };
    expect(body.constraints_remaining.interactions_remaining).toBe(
      BASE_CONSTRAINT.max_interactions - 1
    );
  });
});

describe('GET /api/sessions/:id/messages', () => {
  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app).get(`/api/sessions/${id}/messages`);
    expect(res.status).toBe(401);
  });

  test('returns full conversation history', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    // Send a message to populate history
    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = res.body as { messages: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(2); // user + assistant
  });
});

describe('POST /api/sessions/:id/close', () => {
  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app).post(`/api/sessions/${id}/close`);
    expect(res.status).toBe(401);
  });

  test('marks session as completed', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const res = await request(app)
      .post(`/api/sessions/${id}/close`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = res.body as { status: string };
    expect(body.status).toBe('completed');

    const session = await db.getSession(id);
    expect(session?.status).toBe('completed');
  });

  test('returns 404 for unknown session', async () => {
    const db = new FakeDb();
    db.sessions.set('ghost', { ...makeSession({ id: 'ghost' }), token: 'tok' });
    db.getSession = (): Promise<Session | null> => Promise.resolve(null);
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/sessions/ghost/close')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(404);
  });
});

describe('auth middleware', () => {
  test('rejects requests with no Authorization header', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app).get(`/api/sessions/${id}`);
    expect(res.status).toBe(401);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Authorization/);
  });

  test('rejects requests with malformed Authorization header', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}`)
      .set('Authorization', 'Token abc');
    expect(res.status).toBe(401);
  });

  test('rejects requests with wrong token', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}`)
      .set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Invalid/);
  });
});
