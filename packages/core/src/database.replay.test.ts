import { describe, test, expect } from 'vitest';
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

function makeAdapter(): SQLiteAdapter {
  return new SQLiteAdapter(':memory:');
}

describe('addReplayEvent / getReplayEvents', () => {
  test('returns empty array for new session', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const events = await db.getReplayEvents(id);
    expect(events).toEqual([]);
  });

  test('stores a single event retrievable by session id', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    await db.addReplayEvent(id, 'message', 1000, { role: 'user', content: 'Hello' });
    const events = await db.getReplayEvents(id);
    expect(events).toHaveLength(1);
  });

  test('event has correct type, timestamp, and parsed payload', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const ts = Date.now();
    await db.addReplayEvent(id, 'message', ts, { role: 'user', content: 'Test' });
    const events = await db.getReplayEvents(id);
    const event = events[0]!;
    expect(event.type).toBe('message');
    expect(event.timestamp).toBe(ts);
    expect(event.session_id).toBe(id);
    expect(event.payload).toEqual({ role: 'user', content: 'Test' });
  });

  test('events are returned in timestamp ASC order', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    await db.addReplayEvent(id, 'resource_usage', 3000, { total_tokens: 30 });
    await db.addReplayEvent(id, 'agent_response', 2000, { content: 'Hi' });
    await db.addReplayEvent(id, 'message', 1000, { role: 'user', content: 'Hello' });
    const events = await db.getReplayEvents(id);
    expect(events[0]!.timestamp).toBe(1000);
    expect(events[1]!.timestamp).toBe(2000);
    expect(events[2]!.timestamp).toBe(3000);
  });

  test('events with equal timestamps are returned in insertion order', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const ts = 5000;
    await db.addReplayEvent(id, 'message', ts, { role: 'user', content: 'first' });
    await db.addReplayEvent(id, 'agent_response', ts, { content: 'second' });
    await db.addReplayEvent(id, 'resource_usage', ts, { total_tokens: 10 });
    const events = await db.getReplayEvents(id);
    expect(events[0]!.type).toBe('message');
    expect(events[1]!.type).toBe('agent_response');
    expect(events[2]!.type).toBe('resource_usage');
  });

  test('events are isolated per session', async () => {
    const db = makeAdapter();
    const { id: id1 } = await db.createSession(BASE_CONFIG);
    const { id: id2 } = await db.createSession({ ...BASE_CONFIG, candidate_email: 'bob@example.com' });
    await db.addReplayEvent(id1, 'message', 1000, { role: 'user', content: 'session 1' });
    await db.addReplayEvent(id2, 'message', 2000, { role: 'user', content: 'session 2' });
    const events1 = await db.getReplayEvents(id1);
    const events2 = await db.getReplayEvents(id2);
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect((events1[0]!.payload as { content: string }).content).toBe('session 1');
    expect((events2[0]!.payload as { content: string }).content).toBe('session 2');
  });

  test('nested object payload round-trips through JSON correctly', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const payload = {
      content: 'response',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      stop_reason: 'end_turn',
    };
    await db.addReplayEvent(id, 'agent_response', 1000, payload);
    const events = await db.getReplayEvents(id);
    expect(events[0]!.payload).toEqual(payload);
  });

  test('code_change event stores file_path and diff in payload', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    const payload = { file_path: 'src/index.ts', diff: '@@ -1,3 +1,4 @@\n+export const x = 1;' };
    await db.addReplayEvent(id, 'code_change', 1000, payload);
    const events = await db.getReplayEvents(id);
    expect(events[0]!.type).toBe('code_change');
    expect(events[0]!.payload).toEqual(payload);
  });

  test('stores numeric id in each event', async () => {
    const db = makeAdapter();
    const { id } = await db.createSession(BASE_CONFIG);
    await db.addReplayEvent(id, 'message', 1000, {});
    await db.addReplayEvent(id, 'agent_response', 2000, {});
    const events = await db.getReplayEvents(id);
    expect(typeof events[0]!.id).toBe('number');
    expect(typeof events[1]!.id).toBe('number');
    expect(events[1]!.id).toBeGreaterThan(events[0]!.id);
  });
});
