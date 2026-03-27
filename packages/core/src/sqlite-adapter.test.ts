import { describe, test, expect } from 'vitest';
import { jwtVerify } from 'jose';
import { SQLiteAdapter } from './sqlite-adapter.js';
import type { CreateSessionParams } from './database.js';
import type { Constraint } from './types.js';

const TEST_SECRET = 'test-jwt-secret-at-least-32-chars!!';
const TEST_CONSTRAINT: Constraint = {
  max_session_tokens: 50000,
  max_message_tokens: 2000,
  context_window: 8000,
  max_interactions: 30,
  time_limit_minutes: 60,
};
const TEST_PARAMS: CreateSessionParams = {
  promptId: 'library-api',
  candidateEmail: 'candidate@example.com',
  constraint: TEST_CONSTRAINT,
};

function makeAdapter() {
  return new SQLiteAdapter({ path: ':memory:', jwt_secret: TEST_SECRET });
}

describe('createSession', () => {
  test('returns a sessionId and linkToken', async () => {
    const adapter = makeAdapter();
    const result = await adapter.createSession(TEST_PARAMS);
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(typeof result.linkToken).toBe('string');
    expect(result.linkToken.length).toBeGreaterThan(0);
  });

  test('linkToken is a valid JWT encoding the sessionId', async () => {
    const adapter = makeAdapter();
    const { sessionId, linkToken } = await adapter.createSession(TEST_PARAMS);
    const secret = new TextEncoder().encode(TEST_SECRET);
    const { payload } = await jwtVerify(linkToken, secret);
    expect(payload.sub).toBe(sessionId);
  });

  test('linkToken expires after link_expiry_hours', async () => {
    const adapter = new SQLiteAdapter({
      path: ':memory:',
      jwt_secret: TEST_SECRET,
      link_expiry_hours: 1,
    });
    const { linkToken } = await adapter.createSession(TEST_PARAMS);
    const secret = new TextEncoder().encode(TEST_SECRET);
    const { payload } = await jwtVerify(linkToken, secret);
    const now = Math.floor(Date.now() / 1000);
    expect(payload.exp).toBeDefined();
    expect(payload.exp as number).toBeGreaterThan(now + 3500);
    expect(payload.exp as number).toBeLessThan(now + 3700);
  });

  test('each call generates a unique sessionId', async () => {
    const adapter = makeAdapter();
    const a = await adapter.createSession(TEST_PARAMS);
    const b = await adapter.createSession(TEST_PARAMS);
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe('getSession', () => {
  test('returns null for an unknown id', async () => {
    const adapter = makeAdapter();
    const result = await adapter.getSession('does-not-exist');
    expect(result).toBeNull();
  });

  test('returns the full session after createSession', async () => {
    const adapter = makeAdapter();
    const { sessionId } = await adapter.createSession(TEST_PARAMS);
    const session = await adapter.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(sessionId);
    expect(session!.prompt_id).toBe('library-api');
    expect(session!.candidate_email).toBe('candidate@example.com');
    expect(session!.status).toBe('active');
    expect(session!.tokens_used).toBe(0);
    expect(session!.interactions_used).toBe(0);
    expect(session!.created_at).toBeGreaterThan(0);
    expect(session!.closed_at).toBeUndefined();
  });

  test('constraint is deserialised correctly', async () => {
    const adapter = makeAdapter();
    const { sessionId } = await adapter.createSession(TEST_PARAMS);
    const session = await adapter.getSession(sessionId);
    expect(session!.constraint).toEqual(TEST_CONSTRAINT);
  });
});

describe('addMessage / getMessages', () => {
  test('getMessages returns empty array for new session', async () => {
    const adapter = makeAdapter();
    const { sessionId } = await adapter.createSession(TEST_PARAMS);
    const messages = await adapter.getMessages(sessionId);
    expect(messages).toEqual([]);
  });

  test('addMessage appends to messages table', async () => {
    const adapter = makeAdapter();
    const { sessionId } = await adapter.createSession(TEST_PARAMS);
    await adapter.addMessage(sessionId, 'user', 'Hello', 10);
    const messages = await adapter.getMessages(sessionId);
    expect(messages).toHaveLength(1);
    expect(messages.at(0)!.role).toBe('user');
    expect(messages.at(0)!.content).toBe('Hello');
  });

  test('messages are ordered by created_at ascending', async () => {
    const adapter = makeAdapter();
    const { sessionId } = await adapter.createSession(TEST_PARAMS);
    await adapter.addMessage(sessionId, 'user', 'first', 5);
    await adapter.addMessage(sessionId, 'assistant', 'second', 10);
    const messages = await adapter.getMessages(sessionId);
    expect(messages).toHaveLength(2);
    expect(messages.at(0)!.content).toBe('first');
    expect(messages.at(1)!.content).toBe('second');
  });
});

describe('closeSession', () => {
  test('sets status to completed and closed_at', async () => {
    const adapter = makeAdapter();
    const { sessionId } = await adapter.createSession(TEST_PARAMS);
    const before = Date.now();
    await adapter.closeSession(sessionId);
    const session = await adapter.getSession(sessionId);
    expect(session!.status).toBe('completed');
    expect(session!.closed_at).toBeDefined();
    expect(session!.closed_at!).toBeGreaterThanOrEqual(before);
  });
});

describe('listSessions', () => {
  test('returns empty array when no sessions', async () => {
    const adapter = makeAdapter();
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([]);
  });

  test('returns all sessions ordered by created_at DESC', async () => {
    const adapter = makeAdapter();
    await adapter.createSession(TEST_PARAMS);
    await new Promise(r => setTimeout(r, 5));
    await adapter.createSession({ ...TEST_PARAMS, candidateEmail: 'other@example.com' });
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.candidate_email).toBe('other@example.com');
    expect(sessions[0]!.created_at).toBeGreaterThanOrEqual(sessions[1]!.created_at);
  });
});

describe('getSessionsByPrompt', () => {
  test('returns only sessions for the given promptId ordered by created_at DESC', async () => {
    const adapter = makeAdapter();
    const { sessionId: firstId } = await adapter.createSession({ ...TEST_PARAMS, promptId: 'prompt-a' });
    await adapter.createSession({ ...TEST_PARAMS, promptId: 'prompt-b' });
    await new Promise(r => setTimeout(r, 5));
    const { sessionId: secondId } = await adapter.createSession({ ...TEST_PARAMS, promptId: 'prompt-a' });
    const results = await adapter.getSessionsByPrompt('prompt-a');
    expect(results).toHaveLength(2);
    expect(results.every(s => s.prompt_id === 'prompt-a')).toBe(true);
    expect(results[0]!.id).toBe(secondId);
    expect(results[1]!.id).toBe(firstId);
    expect(results[0]!.created_at).toBeGreaterThanOrEqual(results[1]!.created_at);
  });

  test('returns empty array when no sessions match', async () => {
    const adapter = makeAdapter();
    const results = await adapter.getSessionsByPrompt('nonexistent');
    expect(results).toEqual([]);
  });
});
