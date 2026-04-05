import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DatabasePanel } from './DatabasePanel.js';

const {
  mockEnsureMockPgPackageInstalled,
  mockReadFile,
  mockWriteFile,
  mockWc,
} = vi.hoisted(() => ({
  mockEnsureMockPgPackageInstalled: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockWc: {
    fs: {
      readdir: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('../hooks/useWebContainer.js', () => ({
  useWebContainer: () => ({ wc: mockWc, ready: true, error: null }),
}));

vi.mock('../lib/webcontainer.js', () => ({
  ensureMockPgPackageInstalled: mockEnsureMockPgPackageInstalled,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

const SAMPLE_STATE = {
  version: 1,
  updatedAt: Date.now(),
  pools: [
    {
      id: 'pool-1',
      name: 'primary-db',
      snapshot: {
        stats: { max: 10, active: 0, idle: 1, ended: false },
        indexes: [
          { name: 'users_pkey', table: 'users', columns: ['id'], kind: 'primary' },
        ],
      },
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'INTEGER', primaryKey: true },
            { name: 'email', type: 'TEXT', primaryKey: false },
          ],
          rowCount: 2,
          rows: [
            { id: 1, email: 'alice@example.com' },
            { id: 2, email: 'bob@example.com' },
          ],
        },
      ],
      recentQueries: [
        {
          sql: 'SELECT * FROM users',
          operation: 'select',
          rowCount: 2,
          usedIndex: 'users_pkey',
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockWc.fs.readdir.mockResolvedValue([]);
  mockReadFile.mockImplementation(async (path: string) => {
    if (path === '.lintic/mock-pg/state.json') {
      return JSON.stringify(SAMPLE_STATE);
    }
    throw new Error(`Unexpected read: ${path}`);
  });
});

describe('DatabasePanel', () => {
  test('shows empty state when no pool is available yet', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('missing'));

    render(<DatabasePanel />);

    await waitFor(() => {
      expect(screen.getByText(/No active pool yet/i)).toBeInTheDocument();
    });
    expect(screen.getAllByRole('button', { name: /setup postgres/i }).length).toBeGreaterThan(0);
  });

  test('renders tables, entries, indexes, and recent queries from bridge state', async () => {
    render(<DatabasePanel />);

    expect(await screen.findByText('primary-db')).toBeInTheDocument();
    expect(screen.getByLabelText('Database pool')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SQL' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tables' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Setup' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Tables' }));

    expect(screen.getAllByText('users').length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getAllByText('alice@example.com').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Table details' }));
    expect(screen.getByText('users_pkey')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'History' }));

    expect(screen.getByText('SELECT * FROM users')).toBeInTheDocument();
  });

  test('writes a bridge command and displays the query response', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '.lintic/mock-pg/state.json') {
        return JSON.stringify(SAMPLE_STATE);
      }
      if (path.includes('.lintic/mock-pg/responses/cmd-')) {
        return JSON.stringify({
          ok: true,
          result: {
            rows: [{ id: 1, email: 'alice@example.com' }],
            rowCount: 1,
          },
        });
      }
      throw new Error(`Unexpected read: ${path}`);
    });

    render(<DatabasePanel />);

    expect(await screen.findByText('primary-db')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('SQL query'), {
      target: { value: 'SELECT * FROM users WHERE id = $1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Parameters' }));
    fireEvent.change(screen.getByLabelText('SQL parameters'), {
      target: { value: '[1]' },
    });

    fireEvent.click(screen.getByRole('button', { name: /run sql/i }));

    await waitFor(() => {
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringMatching(/\.lintic\/mock-pg\/commands\/cmd-/),
        expect.stringContaining('"sql": "SELECT * FROM users WHERE id = $1"'),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Result (1)')).toBeInTheDocument();
      expect(screen.getAllByText('alice@example.com').length).toBeGreaterThan(0);
    });
  });

  test('creates an importable postgres helper and opens it for editing', async () => {
    const onOpenSetupFile = vi.fn();
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '.lintic/mock-pg/state.json') {
        throw new Error('missing');
      }
      if (path === 'src/lib/mock-postgres.js') {
        throw new Error('not found');
      }
      throw new Error(`Unexpected read: ${path}`);
    });

    render(<DatabasePanel onOpenSetupFile={onOpenSetupFile} />);

    await waitFor(() => {
      expect(screen.getByText(/No active pool yet/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /setup postgres/i })[0]!);

    await waitFor(() => {
      expect(mockWriteFile).toHaveBeenCalledWith(
        'src/lib/mock-postgres.js',
        expect.stringContaining("import { Pool } from 'lintic-mock-pg';"),
      );
    });

    expect(mockEnsureMockPgPackageInstalled).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledWith(
      'src/lib/mock-postgres.js',
      expect.stringContaining("import { db, sql, ensureExampleTables } from './lib/mock-postgres.js';"),
    );
    expect(onOpenSetupFile).toHaveBeenCalledWith('src/lib/mock-postgres.js');
  });

  test('uses setup as a dedicated tab for onboarding instructions', async () => {
    render(<DatabasePanel />);

    expect(await screen.findByText('primary-db')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));

    expect(screen.getAllByRole('button', { name: /setup postgres/i }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Create a reusable database helper in the WebContainer/i)).toBeInTheDocument();
    expect(screen.getByText(/What this gives you/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'What this gives you' }));
    expect(screen.getByText(/A singleton `Pool` backed by `lintic-mock-pg`\./i)).toBeInTheDocument();
  });
});
