import { describe, it, test, expect, beforeEach } from 'vitest';
import { SQLiteAdapter } from './database.js';
import type { CreateSessionConfig } from './database.js';
import type { Constraint } from './types.js';

const BASE_CONSTRAINT: Constraint = {
  max_session_tokens: 50000,
  max_message_tokens: 2000,
  max_interactions: 30,
  context_window: 8000,
  time_limit_minutes: 60,
};

const BASE_CONFIG: CreateSessionConfig = {
  prompt_id: 'library-api',
  candidate_email: 'alice@example.com',
  constraint: BASE_CONSTRAINT,
};

// Each test gets a fresh in-memory database.
function makeAdapter(): SQLiteAdapter {
  return new SQLiteAdapter(':memory:');
}

describe('createSession', () => {
  test('returns a unique id and token', async () => {
    const db = makeAdapter();
    const { id, token } = await db.createSession(BASE_CONFIG);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(typeof token).toBe('string');
    expect(token.length).toBe(64); // 32 bytes hex
  });

  test('two calls return distinct ids and tokens', async () => {
    const db = makeAdapter();
    const a = await db.createSession(BASE_CONFIG);
    const b = await db.createSession(BASE_CONFIG);
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
  });

  test('created session is retrievable via getSession', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const session = await db.getSession(id);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(id);
  });

  test('new session has status active', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const session = await db.getSession(id);
    expect(session!.status).toBe('active');
  });

  test('new session has zero tokens_used and interactions_used', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const session = await db.getSession(id);
    expect(session!.tokens_used).toBe(0);
    expect(session!.interactions_used).toBe(0);
  });
});

describe('getSession', () => {
  test('returns null for unknown id', async () => {
    const db = makeAdapter();
    const result = await db.getSession('non-existent-id');
    expect(result).toBeNull();
  });

  test('reconstructs full session with correct constraint', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const session = await db.getSession(id);

    expect(session!.prompt_id).toBe(BASE_CONFIG.prompt_id);
    expect(session!.candidate_email).toBe(BASE_CONFIG.candidate_email);
    expect(session!.constraint).toEqual(BASE_CONSTRAINT);
  });

  test('created_at is a recent Unix ms timestamp', async () => {
    const before = Date.now();
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const after = Date.now();
    const session = await db.getSession(id);

    expect(session!.created_at).toBeGreaterThanOrEqual(before);
    expect(session!.created_at).toBeLessThanOrEqual(after);
  });

  test('closed_at is undefined on a fresh session', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const session = await db.getSession(id);
    expect(session!.closed_at).toBeUndefined();
  });

  test('score is undefined on a fresh session', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const session = await db.getSession(id);
    expect(session!.score).toBeUndefined();
  });
});

describe('addMessage / getMessages', () => {
  let db: SQLiteAdapter;
  let sessionId: string;

  beforeEach(async () => {
    db = makeAdapter();
    ({ id: sessionId } = await db.createSession(BASE_CONFIG));
  });

  test('getMessages returns empty array before any messages added', async () => {
    const msgs = await db.getMessages(sessionId);
    expect(msgs).toEqual([]);
  });

  test('addMessage stores a message retrievable via getMessages', async () => {
    await db.addMessage(sessionId, 'user', 'Hello, agent!', 10);
    const msgs = await db.getMessages(sessionId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toBe('Hello, agent!');
    expect(msgs[0]!.token_count).toBe(10);
    expect(msgs[0]!.session_id).toBe(sessionId);
  });

  test('messages are returned in insertion order', async () => {
    await db.addMessage(sessionId, 'user', 'first', 5);
    await db.addMessage(sessionId, 'assistant', 'second', 15);
    await db.addMessage(sessionId, 'user', 'third', 8);

    const msgs = await db.getMessages(sessionId);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.content).toBe('first');
    expect(msgs[1]!.content).toBe('second');
    expect(msgs[2]!.content).toBe('third');
  });

  test('getMessages only returns messages for the given session', async () => {
    const { id: otherId } = await db.createSession({ ...BASE_CONFIG, candidate_email: 'bob@example.com' });
    await db.addMessage(sessionId, 'user', 'mine', 5);
    await db.addMessage(otherId, 'user', 'theirs', 5);

    const mine = await db.getMessages(sessionId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.content).toBe('mine');
  });

  test('created_at is set on stored messages', async () => {
    const before = Date.now();
    await db.addMessage(sessionId, 'user', 'hello', 4);
    const after = Date.now();
    const msgs = await db.getMessages(sessionId);
    expect(msgs[0]!.created_at).toBeGreaterThanOrEqual(before);
    expect(msgs[0]!.created_at).toBeLessThanOrEqual(after);
  });

  test('addReplayEvent falls back to the oldest branch conversation when main is renamed', async () => {
    const branch = await db.getMainBranch(sessionId);
    expect(branch).not.toBeNull();

    const mainConversation = await db.getMainConversation(sessionId, branch!.id);
    expect(mainConversation).not.toBeNull();

    await db.updateConversation({
      session_id: sessionId,
      conversation_id: mainConversation!.id,
      title: 'Renamed chat',
    });

    await expect(
      db.addReplayEvent(sessionId, 'agent_response', Date.now(), {
        content: null,
        stop_reason: 'error',
        error: 'boom',
      }),
    ).resolves.toBeUndefined();

    const events = await db.getReplayEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.conversation_id).toBe(mainConversation!.id);
  });
});

describe('closeSession', () => {
  test('sets status to completed', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    await db.closeSession(id);
    const session = await db.getSession(id);
    expect(session!.status).toBe('completed');
  });

  test('sets closed_at to approximately now', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const before = Date.now();
    await db.closeSession(id);
    const after = Date.now();
    const session = await db.getSession(id);
    expect(session!.closed_at).toBeGreaterThanOrEqual(before);
    expect(session!.closed_at).toBeLessThanOrEqual(after);
  });
});

describe('listSessions', () => {
  test('returns empty array when no sessions exist', async () => {
    const db = makeAdapter();
    const sessions = await db.listSessions();
    expect(sessions).toEqual([]);
  });

  test('returns all created sessions', async () => {
    const db = makeAdapter();
    await db.createSession(BASE_CONFIG);
    await db.createSession({ ...BASE_CONFIG, candidate_email: 'bob@example.com' });
    const sessions = await db.listSessions();
    expect(sessions).toHaveLength(2);
  });

  test('returned sessions include correct metadata', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const sessions = await db.listSessions();
    const found = sessions.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found!.candidate_email).toBe(BASE_CONFIG.candidate_email);
    expect(found!.prompt_id).toBe(BASE_CONFIG.prompt_id);
  });
});

describe('getSessionsByPrompt', () => {
  test('returns empty array when no sessions match the prompt', async () => {
    const db = makeAdapter();
    await db.createSession(BASE_CONFIG);
    const results = await db.getSessionsByPrompt('other-prompt');
    expect(results).toEqual([]);
  });

  test('returns only sessions with the matching prompt_id', async () => {
    const db = makeAdapter();
    await db.createSession(BASE_CONFIG); // prompt_id: 'library-api'
    await db.createSession({ ...BASE_CONFIG, prompt_id: 'other-prompt', candidate_email: 'bob@example.com' });

    const results = await db.getSessionsByPrompt('library-api');
    expect(results).toHaveLength(1);
    expect(results[0]!.prompt_id).toBe('library-api');
  });

  test('returns multiple sessions with the same prompt_id', async () => {
    const db = makeAdapter();
    await db.createSession(BASE_CONFIG);
    await db.createSession({ ...BASE_CONFIG, candidate_email: 'bob@example.com' });
    await db.createSession({ ...BASE_CONFIG, prompt_id: 'other-prompt', candidate_email: 'carol@example.com' });

    const results = await db.getSessionsByPrompt('library-api');
    expect(results).toHaveLength(2);
    results.forEach((s) => expect(s.prompt_id).toBe('library-api'));
  });
});

describe('assessment link persistence', () => {
  test('persists a created assessment link record', async () => {
    const db = makeAdapter();

    const link = await db.createAssessmentLink({
      id: 'link-1',
      token: 'token-1',
      url: 'http://localhost:5173/assessment?token=token-1',
      prompt_id: 'library-api',
      candidate_email: 'alice@example.com',
      created_at: 1000,
      expires_at: 2000,
      constraint: BASE_CONSTRAINT,
    });

    expect(link).toEqual({
      id: 'link-1',
      token: 'token-1',
      url: 'http://localhost:5173/assessment?token=token-1',
      prompt_id: 'library-api',
      candidate_email: 'alice@example.com',
      created_at: 1000,
      expires_at: 2000,
      constraint: BASE_CONSTRAINT,
    });
    await expect(db.getAssessmentLink('link-1')).resolves.toEqual(link);
  });

  test('lists assessment links newest first', async () => {
    const db = makeAdapter();

    await db.createAssessmentLink({
      id: 'link-1',
      token: 'token-1',
      url: 'http://localhost:5173/assessment?token=token-1',
      prompt_id: 'library-api',
      candidate_email: 'alice@example.com',
      created_at: 1000,
      expires_at: 2000,
      constraint: BASE_CONSTRAINT,
    });
    await db.createAssessmentLink({
      id: 'link-2',
      token: 'token-2',
      url: 'http://localhost:5173/assessment?token=token-2',
      prompt_id: 'library-api',
      candidate_email: 'bob@example.com',
      created_at: 2000,
      expires_at: 3000,
      constraint: BASE_CONSTRAINT,
    });

    await expect(db.listAssessmentLinks()).resolves.toMatchObject([
      { id: 'link-2', candidate_email: 'bob@example.com' },
      { id: 'link-1', candidate_email: 'alice@example.com' },
    ]);
  });

  test('returns link detail with its constraint snapshot and consumed session metadata', async () => {
    const db = makeAdapter();
    const session = await db.createSession(BASE_CONFIG);
    await db.createAssessmentLink({
      id: 'link-1',
      token: 'token-1',
      url: 'http://localhost:5173/assessment?token=token-1',
      prompt_id: 'library-api',
      candidate_email: 'alice@example.com',
      created_at: 1000,
      expires_at: 2000,
      constraint: {
        ...BASE_CONSTRAINT,
        max_interactions: 12,
      },
    });

    await db.markAssessmentLinkUsed('link-1', session.id);

    await expect(db.getAssessmentLink('link-1')).resolves.toMatchObject({
      id: 'link-1',
      constraint: {
        ...BASE_CONSTRAINT,
        max_interactions: 12,
      },
      consumed_session_id: session.id,
    });
  });
});

describe('assessment link usage tracking', () => {
  test('reports false for an unused assessment link id', async () => {
    const db = makeAdapter();
    await expect(db.isAssessmentLinkUsed('unused-link')).resolves.toBe(false);
  });

  test('marks an assessment link id as used once', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);

    await expect(db.markAssessmentLinkUsed('link-1', id)).resolves.toBe(true);
    await expect(db.isAssessmentLinkUsed('link-1')).resolves.toBe(true);
    await expect(db.getAssessmentLinkSessionId('link-1')).resolves.toBe(id);
  });

  test('prevents the same assessment link id from being marked twice', async () => {
    const db = makeAdapter();
    const first = await db.createSession(BASE_CONFIG);
    const second = await db.createSession({ ...BASE_CONFIG, candidate_email: 'bob@example.com' });

    await expect(db.markAssessmentLinkUsed('link-dup', first.id)).resolves.toBe(true);
    await expect(db.markAssessmentLinkUsed('link-dup', second.id)).resolves.toBe(false);
  });

  test('returns a session token for an existing session', async () => {
    const db = makeAdapter();
    const created = await db.createSession(BASE_CONFIG);
    await expect(db.getSessionToken(created.id)).resolves.toBe(created.token);
  });

  it('rewindMessages soft-hides messages after a turn sequence', async () => {
    const db = new SQLiteAdapter(':memory:');
    const { id: sessionId } = await db.createSession({
      prompt_id: 'p1',
      candidate_email: 'a@b.com',
      constraint: { max_session_tokens: 1000, max_message_tokens: 500, max_interactions: 10, context_window: 8000, time_limit_minutes: 60 },
    });
    const branch = await db.getMainBranch(sessionId);
    const conversation = await db.getMainConversation(sessionId, branch!.id);
    await db.addBranchMessage(sessionId, branch!.id, 1, 'user', 'first', 0, conversation!.id);
    await db.addBranchMessage(sessionId, branch!.id, 1, 'assistant', 'reply', 0, conversation!.id);
    await db.addBranchMessage(sessionId, branch!.id, 2, 'user', 'second', 0, conversation!.id);
    await db.addBranchMessage(sessionId, branch!.id, 2, 'assistant', 'reply2', 0, conversation!.id);

    await db.rewindMessages(sessionId, branch!.id, conversation!.id, 1);

    const visible = await db.getBranchMessages(sessionId, branch!.id, conversation!.id);
    expect(visible).toHaveLength(2);
    expect(visible.every((m) => m.turn_sequence === 1)).toBe(true);

    const all = await db.getBranchMessages(sessionId, branch!.id, conversation!.id, { includeRewound: true });
    expect(all).toHaveLength(4);
    expect(all.filter((m) => m.rewound_at !== null)).toHaveLength(2);
  });
});
