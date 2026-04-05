import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Pool, MockPgError } from './index.js';
import { parseSql } from './parser.js';

function createPool(overrides: ConstructorParameters<typeof Pool>[0] = {}) {
  return new Pool({
    bridge: false,
    ...overrides,
  });
}

async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 2_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await fn();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return fn();
}

describe('parseSql', () => {
  test('parses CREATE TABLE columns including primary key metadata', () => {
    expect(parseSql('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, age INTEGER)')).toEqual({
      type: 'create_table',
      table: 'users',
      columns: [
        { name: 'id', dataType: 'INTEGER', primaryKey: true },
        { name: 'email', dataType: 'TEXT', primaryKey: false },
        { name: 'age', dataType: 'INTEGER', primaryKey: false },
      ],
    });
  });

  test('parses SELECT with WHERE, ORDER BY, and LIMIT', () => {
    expect(parseSql('SELECT id, email FROM users WHERE email = $1 AND age >= 21 ORDER BY id DESC LIMIT 5')).toEqual({
      type: 'select',
      table: 'users',
      columns: ['id', 'email'],
      where: [
        { column: 'email', operator: '=', value: { kind: 'param', index: 1 } },
        { column: 'age', operator: '>=', value: { kind: 'literal', value: 21 } },
      ],
      orderBy: {
        column: 'id',
        direction: 'DESC',
      },
      limit: 5,
    });
  });

  test('rejects unsupported OR predicates', () => {
    expect(() => parseSql('SELECT * FROM users WHERE email = $1 OR age = 20')).toThrow(/AND-combined/);
  });
});

describe('Pool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('creates tables, inserts rows, and selects with filtering, ordering, and limits', async () => {
    const pool = createPool();

    await pool.query('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, age INTEGER)');
    await pool.query(
      "INSERT INTO users (id, email, age) VALUES (1, 'b@example.com', 40), (2, 'a@example.com', 30), (3, 'a@example.com', 25)",
    );

    const result = await pool.query<{ id: number; email: string }>(
      'SELECT id, email FROM users WHERE email = $1 ORDER BY id DESC LIMIT 1',
      ['a@example.com'],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows).toEqual([{ id: 3, email: 'a@example.com' }]);
  });

  test('updates and deletes matching rows', async () => {
    const pool = createPool();

    await pool.query('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, age INTEGER)');
    await pool.query("INSERT INTO users (id, email, age) VALUES (1, 'alice@example.com', 30), (2, 'bob@example.com', 40)");

    const updated = await pool.query('UPDATE users SET age = $1 WHERE email = $2', [31, 'alice@example.com']);
    const afterUpdate = await pool.query<{ id: number; age: number }>('SELECT id, age FROM users WHERE email = $1', ['alice@example.com']);
    const deleted = await pool.query('DELETE FROM users WHERE id = $1', [2]);
    const remaining = await pool.query('SELECT * FROM users');

    expect(updated.rowCount).toBe(1);
    expect(afterUpdate.rows).toEqual([{ id: 1, age: 31 }]);
    expect(deleted.rowCount).toBe(1);
    expect(remaining.rowCount).toBe(1);
  });

  test('records indexed queries without slow-query flags and records non-indexed queries as slow', async () => {
    const onSlowQuery = vi.fn();
    const pool = createPool({ onSlowQuery });

    await pool.query('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, age INTEGER)');
    await pool.query('CREATE INDEX users_email_idx ON users (email)');
    await pool.query("INSERT INTO users (id, email, age) VALUES (1, 'alice@example.com', 30), (2, 'bob@example.com', 40)");

    await pool.query('SELECT * FROM users WHERE email = $1', ['alice@example.com']);
    await pool.query('SELECT * FROM users WHERE age = $1', [30]);

    const recent = pool.getRecentQueries().filter((query) => query.operation === 'select');
    expect(recent[0]).toMatchObject({ usedIndex: 'users_email_idx' });
    expect(recent[0]?.slowQueryReason).toBeUndefined();
    expect(recent[1]).toMatchObject({ slowQueryReason: 'no_matching_index' });
    expect(onSlowQuery).toHaveBeenCalledTimes(1);
    expect(onSlowQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        table: 'users',
        reason: 'no_matching_index',
        whereColumns: ['age'],
      }),
    );
  });

  test('supports joins through the underlying pg-mem engine', async () => {
    const pool = createPool();

    await pool.query('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)');
    await pool.query('CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER, title TEXT)');
    await pool.query("INSERT INTO authors (id, name) VALUES (1, 'Octavia Butler'), (2, 'Ursula Le Guin')");
    await pool.query(
      "INSERT INTO books (id, author_id, title) VALUES (1, 1, 'Kindred'), (2, 2, 'A Wizard of Earthsea'), (3, 2, 'The Left Hand of Darkness')",
    );

    const joined = await pool.query<{ author: string; title: string }>(`
      SELECT authors.name AS author, books.title
      FROM authors
      JOIN books ON books.author_id = authors.id
      WHERE authors.id = $1
      ORDER BY books.id ASC
    `, [2]);

    expect(joined.rows).toEqual([
      { author: 'Ursula Le Guin', title: 'A Wizard of Earthsea' },
      { author: 'Ursula Le Guin', title: 'The Left Hand of Darkness' },
    ]);
  });

  test('returns table rows for inspector use', async () => {
    const pool = createPool();

    await pool.query('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
    await pool.query("INSERT INTO users (id, email) VALUES (1, 'alice@example.com'), (2, 'bob@example.com')");

    expect(pool.getTableRows('users')).toEqual([
      { id: 1, email: 'alice@example.com' },
      { id: 2, email: 'bob@example.com' },
    ]);
  });

  test('caps recent query history', async () => {
    const pool = createPool({ maxRecentQueries: 2 });

    await pool.query('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
    await pool.query("INSERT INTO users (id, email) VALUES (1, 'alice@example.com')");
    await pool.query('SELECT * FROM users');

    expect(pool.getRecentQueries()).toHaveLength(2);
    expect(pool.getRecentQueries()[0]?.operation).toBe('insert');
    expect(pool.getRecentQueries()[1]?.operation).toBe('select');
  });

  test('enforces pool limits for connect and allows reuse after release', async () => {
    const pool = createPool({ max: 1 });
    const client = await pool.connect();

    await expect(pool.connect()).rejects.toThrow(/pool exhausted/i);

    client.release();

    const nextClient = await pool.connect();
    expect(pool.getSnapshot().stats.active).toBe(1);
    nextClient.release();
    expect(pool.getSnapshot().stats.idle).toBe(1);
  });

  test('prevents client queries after release', async () => {
    const pool = createPool();
    const client = await pool.connect();
    client.release();
    await expect(client.query('SELECT 1')).rejects.toThrow(/released/i);
  });

  test('prevents queries after pool end', async () => {
    const pool = createPool();
    await pool.end();
    await expect(pool.query('SELECT * FROM users')).rejects.toBeInstanceOf(MockPgError);
  });

  test('exposes serializable snapshots and emits pool, schema, and query events', async () => {
    const pool = createPool({ max: 2 });
    const events: string[] = [];
    const unsubscribe = pool.subscribe((event) => {
      if (event.type === 'pool') {
        events.push(`pool:${event.action}`);
      } else if (event.type === 'schema') {
        events.push(`schema:${event.action}:${event.table}`);
      } else {
        events.push(`query:${event.query.operation}`);
      }
    });

    await pool.query('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
    await pool.query('CREATE INDEX users_email_idx ON users (email)');
    const client = await pool.connect();
    client.release();
    unsubscribe();

    const snapshot = pool.getSnapshot();
    expect(snapshot).toEqual({
      stats: {
        max: 2,
        active: 0,
        idle: 1,
        ended: false,
      },
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'INTEGER', primaryKey: true },
            { name: 'email', type: 'TEXT', primaryKey: false },
          ],
          rowCount: 0,
        },
      ],
      indexes: [
        { name: 'users_email_idx', table: 'users', columns: ['email'], kind: 'index' },
        { name: 'users_pkey', table: 'users', columns: ['id'], kind: 'primary' },
      ],
    });

    expect(events).toContain('schema:table_created:users');
    expect(events).toContain('schema:index_created:users');
    expect(events).toContain('query:create_table');
    expect(events).toContain('query:create_index');
    expect(events).toContain('pool:client_acquired');
    expect(events).toContain('pool:client_released');
  });

  test('writes bridge state and executes bridge commands through the filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lintic-mock-pg-'));
    const statePath = join(root, 'state.json');
    const commandsDir = join(root, 'commands');
    const responsesDir = join(root, 'responses');
    const pool = new Pool({
      name: 'primary-db',
      bridge: {
        statePath,
        commandsDir,
        responsesDir,
        pollMs: 25,
      },
    });

    try {
      await pool.query('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
      await pool.query("INSERT INTO users (id, email) VALUES (1, 'alice@example.com')");

      const state = await waitFor(async () => {
        const raw = await readFile(statePath, 'utf-8');
        return JSON.parse(raw) as {
          pools: Array<{
            id: string;
            name: string;
            tables: Array<{ name: string; rows: Array<{ id: number; email: string }> }>;
          }>;
        };
      });

      expect(state.pools[0]?.name).toBe('primary-db');
      expect(state.pools[0]?.tables[0]).toMatchObject({
        name: 'users',
        rows: [{ id: 1, email: 'alice@example.com' }],
      });

      await writeFile(
        join(commandsDir, 'cmd-1.json'),
        JSON.stringify({
          id: 'cmd-1',
          poolId: state.pools[0]!.id,
          sql: 'SELECT * FROM users WHERE id = $1',
          params: [1],
          createdAt: Date.now(),
        }),
        'utf-8',
      );

      const response = await waitFor(async () => {
        const raw = await readFile(join(responsesDir, 'cmd-1.json'), 'utf-8');
        return JSON.parse(raw) as {
          ok: boolean;
          result: { rows: Array<{ id: number; email: string }>; rowCount: number };
        };
      });

      expect(response.ok).toBe(true);
      expect(response.result).toEqual({
        rows: [{ id: 1, email: 'alice@example.com' }],
        rowCount: 1,
      });
    } finally {
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('exports and imports serializable pool state', async () => {
    const source = createPool({ name: 'source-db' });
    const target = createPool({ name: 'target-db' });

    try {
      await source.query('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
      await source.query('CREATE INDEX users_email_idx ON users (email)');
      await source.query("INSERT INTO users (id, email) VALUES (1, 'alice@example.com'), (2, 'bob@example.com')");
      await source.query('SELECT * FROM users WHERE email = $1', ['alice@example.com']);

      const exported = source.exportState();
      await target.importState(exported);

      expect(await target.query('SELECT * FROM users ORDER BY id ASC')).toEqual({
        rows: [
          { id: 1, email: 'alice@example.com' },
          { id: 2, email: 'bob@example.com' },
        ],
        rowCount: 2,
      });
      expect(target.exportState().indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'users_email_idx', table: 'users', kind: 'index' }),
          expect.objectContaining({ name: 'users_pkey', table: 'users', kind: 'primary' }),
        ]),
      );
      expect(target.getRecentQueries()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: 'select', table: 'users' }),
        ]),
      );
    } finally {
      await source.end();
      await target.end();
    }
  });

  test('hydrates pool state from a bootstrap manifest when bridging is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lintic-mock-pg-bootstrap-'));
    const statePath = join(root, 'state.json');
    const commandsDir = join(root, 'commands');
    const responsesDir = join(root, 'responses');
    const bootstrapPath = join(root, 'bootstrap.json');

    await writeFile(
      bootstrapPath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        pools: [{
          id: 'seed-pool',
          name: 'seed-db',
          tables: [{
            name: 'users',
            columns: [
              { name: 'id', type: 'INTEGER', primaryKey: true },
              { name: 'email', type: 'TEXT', primaryKey: false },
            ],
            rows: [{ id: 1, email: 'alice@example.com' }],
          }],
          indexes: [
            { name: 'users_pkey', table: 'users', columns: ['id'], kind: 'primary' },
          ],
          recentQueries: [],
        }],
      }),
      'utf-8',
    );

    const pool = new Pool({
      name: 'seed-db',
      bridge: {
        statePath,
        commandsDir,
        responsesDir,
        pollMs: 25,
      },
    });

    try {
      await waitFor(async () => {
        const result = await pool.query('SELECT * FROM users');
        expect(result.rows).toEqual([{ id: 1, email: 'alice@example.com' }]);
        return result;
      });

      const rawBootstrap = await readFile(bootstrapPath, 'utf-8');
      expect(JSON.parse(rawBootstrap)).toMatchObject({ pools: [] });
    } finally {
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
