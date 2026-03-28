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
    msgs.push({ id: this.nextMsgId++, session_id: sessionId, role, content, token_count: tokenCount, created_at: Date.now() });
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

const TEST_CONFIG: Config = {
  agent: { provider: 'openai-compatible', api_key: 'key', model: 'gpt-4o', base_url: 'https://api.openai.com' },
  constraints: BASE_CONSTRAINT,
  prompts: [{ id: 'test-prompt', title: 'Test Prompt' }],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/sessions/:id/replay', () => {
  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app).get(`/api/sessions/${id}/replay`);
    expect(res.status).toBe(401);
  });

  test('returns 401 with invalid token', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  test('returns 404 for unknown session', async () => {
    const db = new FakeDb();
    db.sessions.set('ghost', {
      id: 'ghost', token: 'tok', prompt_id: 'p', candidate_email: 'e@e.com',
      status: 'active', created_at: Date.now(), constraint: BASE_CONSTRAINT,
      tokens_used: 0, interactions_used: 0,
    });
    db.getSession = (): Promise<Session | null> => Promise.resolve(null);
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .get('/api/sessions/ghost/replay')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(404);
  });

  test('returns 200 with empty events array before any messages', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(0);
  });

  test('returns session_id in response body', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);
    const body = res.body as { session_id: string };
    expect(body.session_id).toBe(id);
  });

  test('after sending a message, replay contains message, agent_response, and resource_usage events', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = res.body as { events: Array<{ type: string }> };
    const types = body.events.map((e) => e.type);
    expect(types).toContain('message');
    expect(types).toContain('agent_response');
    expect(types).toContain('resource_usage');
  });

  test('events have a timestamp field', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    const body = res.body as { events: Array<{ timestamp: number }> };
    for (const event of body.events) {
      expect(typeof event.timestamp).toBe('number');
    }
  });

  test('message event payload contains role and content', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Write a test' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    const body = res.body as { events: Array<{ type: string; payload: { role: string; content: string } }> };
    const messageEvent = body.events.find((e) => e.type === 'message');
    expect(messageEvent?.payload.role).toBe('user');
    expect(messageEvent?.payload.content).toBe('Write a test');
  });

  test('agent_response event payload contains content, stop_reason, and usage', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    const body = res.body as { events: Array<{ type: string; payload: { content: string; stop_reason: string; usage: unknown } }> };
    const agentEvent = body.events.find((e) => e.type === 'agent_response');
    expect(agentEvent?.payload.content).toBe('Hello from the agent!');
    expect(agentEvent?.payload.stop_reason).toBe('end_turn');
    expect(agentEvent?.payload.usage).toBeDefined();
  });

  test('resource_usage event payload contains total_tokens', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    const body = res.body as { events: Array<{ type: string; payload: { total_tokens: number } }> };
    const usageEvent = body.events.find((e) => e.type === 'resource_usage');
    expect(typeof usageEvent?.payload.total_tokens).toBe('number');
    expect(usageEvent?.payload.total_tokens).toBe(30);
  });

  test('events have a payload field', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    const body = res.body as { events: Array<{ payload: unknown }> };
    for (const event of body.events) {
      expect(event.payload).toBeDefined();
    }
  });
});
