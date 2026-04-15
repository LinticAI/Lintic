import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PostgresAdapter } from './database.js';
import type { CreateSessionConfig } from './database.js';
import type { Constraint, EvaluationResult } from './types.js';

const poolInstances: MockPool[] = [];

class MockPool {
  public query = vi.fn((text: string, params?: unknown[]) => {
    this.queries.push({ text, params });

    if (this.failOnQuery) {
      throw this.failOnQuery;
    }

    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift());
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  });

  public queries: Array<{ text: string; params: unknown[] | undefined }> = [];
  public queue: Array<{ rows?: unknown[]; rowCount?: number | null }> = [];
  public failOnQuery: Error | null = null;
}

vi.mock('pg', () => ({
  Pool: vi.fn(() => {
    const pool = new MockPool();
    poolInstances.push(pool);
    return pool;
  }),
}));

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

function latestPool(): MockPool {
  const pool = poolInstances.at(-1);
  if (!pool) {
    throw new Error('Expected a mock Pool instance');
  }
  return pool;
}

describe('PostgresAdapter', () => {
  beforeEach(() => {
    poolInstances.length = 0;
    vi.clearAllMocks();
  });

  test('bootstraps schema on initialize', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });

    await adapter.initialize();

    const pool = latestPool();
    expect(pool.queries.length).toBeGreaterThanOrEqual(6);
    expect(pool.queries[0]!.text).toContain('CREATE TABLE IF NOT EXISTS sessions');
    expect(pool.queries.some((query) => query.text.includes('CREATE TABLE IF NOT EXISTS messages'))).toBe(true);
    expect(pool.queries.some((query) => query.text.includes('CREATE TABLE IF NOT EXISTS replay_events'))).toBe(true);
    expect(pool.queries.some((query) => query.text.includes('CREATE TABLE IF NOT EXISTS assessment_links'))).toBe(true);
    expect(pool.queries.some((query) => query.text.includes('CREATE TABLE IF NOT EXISTS assessment_link_uses'))).toBe(true);
  });

  test('createSession inserts a new session and returns generated id/token', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });

    const result = await adapter.createSession(BASE_CONFIG);

    const pool = latestPool();
    const sessionInsert = pool.queries.find((q) => q.text.includes('INSERT INTO sessions'));
    expect(sessionInsert?.text).toContain('INSERT INTO sessions');
    expect(sessionInsert?.params?.[2]).toBe('library-api');
    expect(sessionInsert?.params?.[3]).toBe('alice@example.com');
    expect(result.id).toMatch(/[0-9a-f-]{36}/i);
    expect(result.token).toHaveLength(64);
  });

  test('getSession reconstructs the session shape used by SQLiteAdapter', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });
    await adapter.initialize();
    const pool = latestPool();
    pool.queue.push({
      rows: [{
        id: 'session-1',
        token: 'token-1',
        prompt_id: 'library-api',
        candidate_email: 'alice@example.com',
        status: 'active',
        created_at: '1000',
        closed_at: null,
        max_session_tokens: '50000',
        max_message_tokens: '2000',
        max_interactions: '30',
        context_window: '8000',
        time_limit_minutes: '60',
        tokens_used: '12',
        interactions_used: '2',
        score: null,
      }],
      rowCount: 1,
    });

    const session = await adapter.getSession('session-1');

    expect(session).toEqual({
      id: 'session-1',
      prompt_id: 'library-api',
      candidate_email: 'alice@example.com',
      status: 'active',
      created_at: 1000,
      constraint: BASE_CONSTRAINT,
      tokens_used: 12,
      interactions_used: 2,
    });
  });

  test('getMessages orders by id ASC and normalizes numeric fields', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });
    await adapter.initialize();
    const pool = latestPool();
    // getMessages calls getMainBranch first, then getBranchMessages
    pool.queue.push({
      rows: [{ id: 'branch-1', session_id: 'session-1', name: 'main', parent_branch_id: null, forked_from_sequence: null, created_at: '100' }],
      rowCount: 1,
    });
    pool.queue.push({
      rows: [
        { id: '1', session_id: 'session-1', branch_id: 'branch-1', conversation_id: 'conv-1', turn_sequence: null, role: 'user', content: 'first', token_count: '5', created_at: '100', rewound_at: null },
        { id: '2', session_id: 'session-1', branch_id: 'branch-1', conversation_id: 'conv-1', turn_sequence: null, role: 'assistant', content: 'second', token_count: '8', created_at: '200', rewound_at: null },
      ],
      rowCount: 2,
    });

    const messages = await adapter.getMessages('session-1');

    expect(pool.queries.some((q) => q.text.includes('ORDER BY id ASC'))).toBe(true);
    expect(messages).toEqual([
      { id: 1, session_id: 'session-1', branch_id: 'branch-1', conversation_id: 'conv-1', turn_sequence: null, role: 'user', content: 'first', token_count: 5, created_at: 100, rewound_at: null },
      { id: 2, session_id: 'session-1', branch_id: 'branch-1', conversation_id: 'conv-1', turn_sequence: null, role: 'assistant', content: 'second', token_count: 8, created_at: 200, rewound_at: null },
    ]);
  });

  test('upsertSessionEvaluation persists analysis and updates session score', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });
    await adapter.initialize();
    const pool = latestPool();
    pool.queue.push({ rows: [], rowCount: 0 });

    const result: EvaluationResult = {
      infrastructure: {
        caching_effectiveness: { name: 'caching_effectiveness', label: 'Caching', score: 0.4, details: '' },
        error_handling_coverage: { name: 'error_handling_coverage', label: 'Errors', score: 0.6, details: '' },
        scaling_awareness: { name: 'scaling_awareness', label: 'Scaling', score: 0.8, details: '' },
      },
      llm_evaluation: {
        scores: [{ dimension: 'prompt_quality', label: 'Prompt Quality', score: 7, rationale: '' }],
        overall_summary: 'Summary',
      },
      iterations: [],
    };

    const evaluation = await adapter.upsertSessionEvaluation('session-1', result, 0.65);

    expect(evaluation.score).toBe(0.65);
    expect(pool.queries.some((query) => query.text.includes('INSERT INTO session_evaluations'))).toBe(true);
    expect(pool.queries.some((query) => query.text.includes('UPDATE sessions SET score = $1 WHERE id = $2'))).toBe(true);
  });

  test('getReplayEvents orders by timestamp ASC then id ASC and parses payload JSON', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });
    await adapter.initialize();
    const pool = latestPool();
    // getReplayEvents calls getMainBranch first, then getBranchReplayEvents
    pool.queue.push({
      rows: [{ id: 'branch-1', session_id: 'session-1', name: 'main', parent_branch_id: null, forked_from_sequence: null, created_at: '100' }],
      rowCount: 1,
    });
    pool.queue.push({
      rows: [
        { id: '1', session_id: 'session-1', branch_id: 'branch-1', conversation_id: 'conv-1', turn_sequence: null, type: 'message', timestamp: '1000', payload: '{"a":1}' },
        { id: '2', session_id: 'session-1', branch_id: 'branch-1', conversation_id: 'conv-1', turn_sequence: null, type: 'agent_response', timestamp: '1000', payload: '{"b":2}' },
      ],
      rowCount: 2,
    });

    const events = await adapter.getReplayEvents('session-1');

    expect(pool.queries.some((q) => q.text.includes('ORDER BY timestamp ASC, id ASC'))).toBe(true);
    expect(events[0]?.payload).toEqual({ a: 1 });
    expect(events[1]?.payload).toEqual({ b: 2 });
  });

  test('markAssessmentLinkUsed uses conflict-safe insert semantics', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });
    await adapter.initialize();
    const pool = latestPool();
    pool.queue.push({ rows: [], rowCount: 1 });

    const inserted = await adapter.markAssessmentLinkUsed('link-1', 'session-1');

    expect(inserted).toBe(true);
    expect(pool.queries.at(-1)?.text).toContain('ON CONFLICT (link_id) DO NOTHING');
  });

  test('markAssessmentLinkUsed returns false when the link was already used', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });
    await adapter.initialize();
    const pool = latestPool();
    pool.queue.push({ rows: [], rowCount: 0 });

    await expect(adapter.markAssessmentLinkUsed('link-1', 'session-1')).resolves.toBe(false);
  });

  test('creates and lists persisted assessment links', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });

    await adapter.createAssessmentLink({
      id: 'link-1',
      token: 'token-1',
      url: 'http://localhost:5173/assessment?token=token-1',
      prompt_id: 'library-api',
      candidate_email: 'alice@example.com',
      created_at: 1000,
      expires_at: 2000,
      constraint: BASE_CONSTRAINT,
    });

    const pool = latestPool();
    expect(pool.queries.at(-1)?.text).toContain('INSERT INTO assessment_links');

    pool.queue.push({
      rows: [{
        id: 'link-1',
        token: 'token-1',
        url: 'http://localhost:5173/assessment?token=token-1',
        prompt_id: 'library-api',
        candidate_email: 'alice@example.com',
        created_at: '1000',
        expires_at: '2000',
        constraint_json: JSON.stringify(BASE_CONSTRAINT),
        consumed_session_id: 'session-1',
        consumed_at: '1500',
      }],
      rowCount: 1,
    });

    const links = await adapter.listAssessmentLinks();

    expect(pool.queries.at(-1)?.text).toContain('FROM assessment_links l');
    expect(links).toEqual([{
      id: 'link-1',
      token: 'token-1',
      url: 'http://localhost:5173/assessment?token=token-1',
      prompt_id: 'library-api',
      candidate_email: 'alice@example.com',
      created_at: 1000,
      expires_at: 2000,
      constraint: BASE_CONSTRAINT,
      consumed_session_id: 'session-1',
      consumed_at: 1500,
    }]);
  });

  test('returns null for an unknown persisted assessment link id', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });
    await adapter.initialize();
    const pool = latestPool();
    pool.queue.push({ rows: [], rowCount: 0 });

    await expect(adapter.getAssessmentLink('missing-link')).resolves.toBeNull();
  });

  test('rewindMessages resolves and getBranchMessages filters rewound rows', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });
    await adapter.initialize();
    const pool = latestPool();

    // rewindMessages issues an UPDATE — no rows returned
    pool.queue.push({ rows: [], rowCount: 1 });

    // getBranchMessages (default, no includeRewound) — only non-rewound rows
    pool.queue.push({
      rows: [
        { id: '1', session_id: 'session-1', branch_id: 'branch-1', conversation_id: 'conv-1', turn_sequence: '1', role: 'user', content: 'hello', token_count: '5', created_at: '100', rewound_at: null },
      ],
      rowCount: 1,
    });

    // getBranchMessages with includeRewound: true — all rows
    pool.queue.push({
      rows: [
        { id: '1', session_id: 'session-1', branch_id: 'branch-1', conversation_id: 'conv-1', turn_sequence: '1', role: 'user', content: 'hello', token_count: '5', created_at: '100', rewound_at: null },
        { id: '2', session_id: 'session-1', branch_id: 'branch-1', conversation_id: 'conv-1', turn_sequence: '2', role: 'assistant', content: 'world', token_count: '8', created_at: '200', rewound_at: '300' },
      ],
      rowCount: 2,
    });

    await expect(adapter.rewindMessages('session-1', 'branch-1', 'conv-1', 1)).resolves.toBeUndefined();

    const visible = await adapter.getBranchMessages('session-1', 'branch-1', 'conv-1');
    expect(visible).toHaveLength(1);
    expect(visible[0]?.rewound_at).toBeNull();
    expect(pool.queries.some((q) => q.text.includes('AND rewound_at IS NULL'))).toBe(true);

    const all = await adapter.getBranchMessages('session-1', 'branch-1', 'conv-1', { includeRewound: true });
    expect(all).toHaveLength(2);
    expect(all[1]?.rewound_at).toBe(300);
  });

  test('surfaces descriptive bootstrap errors', async () => {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://lintic:test@localhost/lintic' });
    const pool = latestPool();
    pool.failOnQuery = new Error('ECONNREFUSED');

    await expect(adapter.initialize()).rejects.toThrow(
      'Failed to initialize PostgreSQL database schema: ECONNREFUSED',
    );
  });
});
