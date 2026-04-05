import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Play, RefreshCw } from 'lucide-react';
import { useWebContainer } from '../hooks/useWebContainer.js';
import { ensureMockPgPackageInstalled, readFile, writeFile } from '../lib/webcontainer.js';
import { DropdownMenu, DropdownTriggerLabel } from './DropdownMenu.js';

const STATE_PATH = '.lintic/mock-pg/state.json';
const COMMANDS_DIR = '.lintic/mock-pg/commands';
const RESPONSES_DIR = '.lintic/mock-pg/responses';

type PrimitiveValue = string | number | boolean | null;

interface QueryResultState {
  rows: Array<Record<string, PrimitiveValue>>;
  rowCount: number;
}

interface TableState {
  name: string;
  columns: Array<{ name: string; type: string; primaryKey: boolean }>;
  rowCount: number;
  rows: Array<Record<string, PrimitiveValue>>;
}

interface PoolState {
  id: string;
  name: string;
  snapshot: {
    stats: { max: number; active: number; idle: number; ended: boolean };
    indexes: Array<{ name: string; table: string; columns: string[]; kind: 'primary' | 'index' }>;
  };
  tables: TableState[];
  recentQueries: Array<{
    sql: string;
    operation: string;
    rowCount: number;
    slowQueryReason?: string;
    usedIndex?: string;
  }>;
}

interface BridgeStateFile {
  version: number;
  updatedAt: number;
  pools: PoolState[];
}

interface QueryResponse {
  ok: boolean;
  result?: QueryResultState;
  error?: {
    message: string;
  };
}

interface DatabasePanelProps {
  onOpenSetupFile?: (path: string) => void;
}

type DatabaseWorkspaceTab = 'sql' | 'tables' | 'history' | 'setup';

const DEFAULT_SETUP_PATH = 'src/lib/mock-postgres.js';
const FALLBACK_SETUP_PATH = 'lib/mock-postgres.js';

function buildSetupFileContent(importPath: string): string {
  return `import { Pool } from 'lintic-mock-pg';

/*
  Import from this helper in your app code:

  import { db, sql, ensureExampleTables } from '${importPath}';

  await ensureExampleTables();
  const users = await sql('SELECT * FROM users ORDER BY id ASC');
*/

const globalStore = globalThis.__linticMockPostgresStore ?? (globalThis.__linticMockPostgresStore = {});

export const db = globalStore.pool ?? (globalStore.pool = new Pool({
  name: 'app-db',
  max: 4,
}));

export async function sql(text, params = []) {
  return db.query(text, params);
}

export async function ensureExampleTables() {
  await sql(\`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT,
      name TEXT
    )
  \`);
}
`;
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path);
  return JSON.parse(raw) as T;
}

async function waitForResponse(commandId: string, timeoutMs = 5_000): Promise<QueryResponse> {
  const started = Date.now();
  const responsePath = `${RESPONSES_DIR}/${commandId}.json`;

  while (Date.now() - started < timeoutMs) {
    try {
      return await readJson<QueryResponse>(responsePath);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error('Timed out waiting for database query response');
}

function formatCellValue(value: PrimitiveValue): string {
  if (value === null) return 'null';
  return String(value);
}

function renderDataTable(
  columns: string[],
  rows: Array<Record<string, PrimitiveValue>>,
  emptyMessage: string,
) {
  if (!rows.length) {
    return (
      <div className="px-4 py-6 text-sm" style={{ color: 'var(--db-text-secondary)' }}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <table className="min-w-full text-left text-sm">
      <thead>
        <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
          {columns.map((column) => (
            <th
              key={column}
              className="border-b px-4 py-3 font-medium"
              style={{ borderColor: 'var(--db-border-default)', color: 'var(--db-text-primary)' }}
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={`row-${rowIndex}`} className="db-table-row">
            {columns.map((column) => (
              <td
                key={`${rowIndex}-${column}`}
                className="border-b px-4 py-3 font-mono text-xs"
                style={{ borderColor: 'var(--db-border-subtle)', color: 'var(--db-text-secondary)' }}
              >
                {formatCellValue(row[column] ?? null)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SectionDisclosure({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="db-surface">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold" style={{ color: 'var(--db-text-primary)' }}>
          {title}
        </span>
        <ChevronDown
          size={16}
          style={{
            color: 'var(--db-text-tertiary)',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 160ms ease',
          }}
        />
      </button>
      {open ? (
        <div className="border-t px-4 py-4" style={{ borderColor: 'var(--db-border-default)' }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function DatabasePanel({ onOpenSetupFile }: DatabasePanelProps) {
  const { wc, ready, error } = useWebContainer();
  const [bridgeState, setBridgeState] = useState<BridgeStateFile | null>(null);
  const [activeTab, setActiveTab] = useState<DatabaseWorkspaceTab>('sql');
  const [hasChosenTab, setHasChosenTab] = useState(false);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [selectedTableName, setSelectedTableName] = useState<string | null>(null);
  const [queryText, setQueryText] = useState('SELECT * FROM users LIMIT 20;');
  const [paramsText, setParamsText] = useState('[]');
  const [queryResult, setQueryResult] = useState<QueryResultState | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState(false);
  const [runningQuery, setRunningQuery] = useState(false);
  const [sqlParamsOpen, setSqlParamsOpen] = useState(false);
  const [tableDetailsOpen, setTableDetailsOpen] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [setupPath, setSetupPath] = useState<string | null>(null);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [setupImportOpen, setSetupImportOpen] = useState(true);
  const [setupInfoOpen, setSetupInfoOpen] = useState(false);

  useEffect(() => {
    if (!wc) {
      return;
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const loadState = async () => {
      setLoadingState(true);
      try {
        const nextState = await readJson<BridgeStateFile>(STATE_PATH);
        if (!cancelled) {
          setBridgeState(nextState);
        }
      } catch {
        if (!cancelled) {
          setBridgeState(null);
        }
      } finally {
        if (!cancelled) {
          setLoadingState(false);
        }
      }
    };

    void loadState();
    intervalId = setInterval(() => {
      void loadState();
    }, 1000);

    return () => {
      cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [wc]);

  useEffect(() => {
    if (!bridgeState?.pools.length) {
      setSelectedPoolId(null);
      return;
    }
    if (!selectedPoolId || !bridgeState.pools.some((pool) => pool.id === selectedPoolId)) {
      setSelectedPoolId(bridgeState.pools[0]!.id);
    }
  }, [bridgeState, selectedPoolId]);

  const activePool = useMemo(
    () => bridgeState?.pools.find((pool) => pool.id === selectedPoolId) ?? bridgeState?.pools[0] ?? null,
    [bridgeState, selectedPoolId],
  );

  useEffect(() => {
    if (!activePool?.tables.length) {
      setSelectedTableName(null);
      return;
    }
    if (!selectedTableName || !activePool.tables.some((table) => table.name === selectedTableName)) {
      setSelectedTableName(activePool.tables[0]!.name);
    }
  }, [activePool, selectedTableName]);

  useEffect(() => {
    if (hasChosenTab) {
      return;
    }
    if (!activePool && activeTab !== 'setup') {
      setActiveTab('setup');
    }
    if (activePool && activeTab !== 'sql') {
      setActiveTab('sql');
    }
  }, [activePool, activeTab, hasChosenTab]);

  const selectedTable = activePool?.tables.find((table) => table.name === selectedTableName) ?? null;

  async function handleRefresh() {
    setLoadingState(true);
    try {
      const nextState = await readJson<BridgeStateFile>(STATE_PATH);
      setBridgeState(nextState);
    } catch {
      setBridgeState(null);
    } finally {
      setLoadingState(false);
    }
  }

  async function handleRunQuery() {
    if (!activePool) {
      setQueryError('No active database pool detected yet.');
      return;
    }

    let parsedParams: PrimitiveValue[] = [];
    try {
      const parsed = JSON.parse(paramsText) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Parameters must be a JSON array.');
      }
      parsedParams = parsed as PrimitiveValue[];
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : 'Invalid parameters JSON');
      return;
    }

    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setRunningQuery(true);
    setQueryError(null);

    try {
      await writeFile(
        `${COMMANDS_DIR}/${commandId}.json`,
        JSON.stringify({
          id: commandId,
          poolId: activePool.id,
          sql: queryText,
          params: parsedParams,
          createdAt: Date.now(),
        }, null, 2),
      );

      const response = await waitForResponse(commandId);
      if (!response.ok || !response.result) {
        throw new Error(response.error?.message ?? 'Database query failed');
      }
      setQueryResult(response.result);
      await handleRefresh();
    } catch (err) {
      setQueryResult(null);
      setQueryError(err instanceof Error ? err.message : 'Database query failed');
    } finally {
      setRunningQuery(false);
    }
  }

  async function resolveSetupPath(): Promise<string> {
    if (!wc) {
      return DEFAULT_SETUP_PATH;
    }

    try {
      await wc.fs.readdir('src');
      return DEFAULT_SETUP_PATH;
    } catch {
      return FALLBACK_SETUP_PATH;
    }
  }

  async function handleSetupPostgres() {
    setSettingUp(true);
    setSetupMessage(null);

    try {
      await ensureMockPgPackageInstalled();
      const nextSetupPath = await resolveSetupPath();
      const helperImportPath = nextSetupPath.startsWith('src/')
        ? `./${nextSetupPath.slice(4)}`
        : `./${nextSetupPath}`;

      let existed = false;
      try {
        await readFile(nextSetupPath);
        existed = true;
      } catch {
        await writeFile(nextSetupPath, buildSetupFileContent(helperImportPath));
      }

      setSetupPath(nextSetupPath);
      setSetupMessage(
        existed
          ? `Mock Postgres is already set up at ${nextSetupPath}.`
          : `Mock Postgres is ready at ${nextSetupPath}. Import { db, sql } from ${helperImportPath}.`,
      );
      onOpenSetupFile?.(nextSetupPath);
    } catch (err) {
      setSetupMessage(err instanceof Error ? err.message : 'Failed to set up mock Postgres');
    } finally {
      setSettingUp(false);
    }
  }

  const queryColumns = queryResult && queryResult.rows.length > 0
    ? Object.keys(queryResult.rows[0]!)
    : [];
  const selectedTableColumns = selectedTable?.columns.map((column) => column.name) ?? [];
  const poolOptions = bridgeState?.pools.map((pool) => ({
    value: pool.id,
    label: pool.name,
    meta: `${pool.tables.length} table${pool.tables.length === 1 ? '' : 's'}`,
  })) ?? [];
  const tableOptions = activePool?.tables.map((table) => ({
    value: table.name,
    label: table.name,
    meta: `${table.rowCount} row${table.rowCount === 1 ? '' : 's'}`,
  })) ?? [];
  const selectedPoolOption = poolOptions.find((option) => option.value === activePool?.id) ?? poolOptions[0] ?? null;
  const selectedTableOption = tableOptions.find((option) => option.value === selectedTableName) ?? tableOptions[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ background: 'var(--db-surface-canvas)' }}>
      <div className="border-b px-5 pt-4" style={{ borderColor: 'var(--db-border-default)' }}>
        <div className="flex flex-wrap items-center gap-2 pb-4">
          {([
            ['sql', 'SQL'],
            ['tables', 'Tables'],
            ['history', 'History'],
            ['setup', 'Setup'],
          ] as const).map(([tabId, label]) => {
            const isActive = activeTab === tabId;
            return (
              <button
                key={tabId}
                type="button"
                onClick={() => {
                  setHasChosenTab(true);
                  setActiveTab(tabId);
                }}
                data-active={isActive}
                className="db-tab px-3.5 py-1.5 text-sm font-semibold"
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-b px-5 py-3" style={{ borderColor: 'var(--db-border-default)' }}>
        <div className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--db-text-secondary)' }}>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            className="db-action-secondary inline-flex items-center gap-2 px-3 py-1.5"
            aria-label="Refresh database state"
          >
            <RefreshCw size={14} />
            Refresh
          </button>

          {activePool ? (
            <>
              <DropdownMenu
                label="Database pool"
                role="listbox"
                widthClassName="min-w-[220px]"
                items={poolOptions.map((option) => ({
                  ...option,
                  selected: option.value === selectedPoolOption?.value,
                  onSelect: () => setSelectedPoolId(option.value),
                }))}
                trigger={(open) => (
                  <DropdownTriggerLabel
                    primary={selectedPoolOption?.label ?? 'Select'}
                    secondary={selectedPoolOption?.meta}
                    open={open}
                  />
                )}
              />
              <span>{activePool.tables.length} table{activePool.tables.length === 1 ? '' : 's'}</span>
              <span>{activePool.recentQueries.length} quer{activePool.recentQueries.length === 1 ? 'y' : 'ies'}</span>
              <span>active {activePool.snapshot.stats.active}</span>
            </>
          ) : (
            <span>No active pool yet</span>
          )}

          {loadingState ? (
            <span>Refreshing…</span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="px-5 pt-4">
          <div className="db-surface px-4 py-3 text-sm" style={{ background: 'var(--db-danger-surface)', color: 'var(--db-danger-text)' }}>
            {error}
          </div>
        </div>
      ) : null}

      {!ready ? (
        <div className="px-5 pt-4 text-sm" style={{ color: 'var(--db-text-secondary)' }}>
          Booting WebContainer…
        </div>
      ) : null}

      <div className="min-h-0 overflow-hidden px-5 py-4">
        {!activePool && activeTab !== 'setup' ? (
          <div className="db-surface px-4 py-4 text-sm" style={{ color: 'var(--db-text-secondary)' }}>
            Create the mocked Postgres helper in the `Setup` tab, then import it in your code to start seeing live tables here.
          </div>
        ) : null}

        {activeTab === 'sql' && activePool ? (
          <div className="grid h-full min-h-0 gap-4 grid-rows-[auto_minmax(0,1fr)]">
            <div className="db-surface p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold" style={{ color: 'var(--db-text-primary)' }}>
                  SQL
                </div>
                <button
                  type="button"
                  onClick={() => void handleRunQuery()}
                  disabled={runningQuery || !activePool}
                  className="db-action-primary inline-flex items-center gap-2 px-3.5 py-2 text-sm font-semibold"
                >
                  <Play size={14} />
                  {runningQuery ? 'Running…' : 'Run SQL'}
                </button>
              </div>

              <textarea
                value={queryText}
                onChange={(event) => setQueryText(event.target.value)}
                className="db-control min-h-[180px] w-full px-4 py-3 font-mono text-sm"
                style={{ background: 'var(--db-surface-canvas)' }}
                spellCheck={false}
                aria-label="SQL query"
              />

              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setSqlParamsOpen((current) => !current)}
                  className="flex items-center gap-2 text-sm font-medium"
                  style={{ color: 'var(--db-text-secondary)' }}
                >
                  <span>Parameters</span>
                  <ChevronDown
                    size={16}
                    style={{
                      transform: sqlParamsOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 160ms ease',
                    }}
                  />
                </button>
                {sqlParamsOpen ? (
                  <textarea
                    value={paramsText}
                    onChange={(event) => setParamsText(event.target.value)}
                    className="db-control mt-3 min-h-[100px] w-full px-4 py-3 font-mono text-sm"
                    style={{ background: 'var(--db-surface-canvas)' }}
                    spellCheck={false}
                    aria-label="SQL parameters"
                  />
                ) : null}
                {sqlParamsOpen ? (
                  <div className="mt-2 text-[11px]" style={{ color: 'var(--db-text-tertiary)' }}>
                    Use a JSON array like `[]` or `[1, "alice@example.com"]`.
                  </div>
                ) : null}
              </div>

              {queryError ? (
                <div className="db-surface mt-3 px-3 py-2 text-sm" style={{ background: 'var(--db-danger-surface)', color: 'var(--db-danger-text)' }}>
                  {queryError}
                </div>
              ) : null}
            </div>

            <div className="db-surface min-h-0 overflow-hidden">
              <div className="border-b px-4 py-3 text-sm font-semibold" style={{ borderColor: 'var(--db-border-default)', color: 'var(--db-text-primary)' }}>
                {queryResult ? `Result (${queryResult.rowCount})` : 'Result'}
              </div>
              <div className="h-full overflow-auto">
                {queryResult
                  ? renderDataTable(queryColumns, queryResult.rows, 'Query returned no rows.')
                  : (
                    <div className="px-4 py-6 text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                      Run a query to see rows here.
                    </div>
                  )}
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === 'tables' && activePool ? (
          <div className="grid h-full min-h-0 gap-4 grid-rows-[auto_auto_minmax(0,1fr)]">
            <div className="flex flex-wrap items-center gap-3">
              <DropdownMenu
                label="Selected table"
                role="listbox"
                widthClassName="min-w-[180px]"
                items={tableOptions.map((option) => ({
                  ...option,
                  selected: option.value === selectedTableOption?.value,
                  onSelect: () => {
                    setHasChosenTab(true);
                    setSelectedTableName(option.value);
                    setQueryText(`SELECT * FROM ${option.value} LIMIT 20;`);
                  },
                }))}
                trigger={(open) => (
                  <DropdownTriggerLabel
                    primary={selectedTableOption?.label ?? 'Select'}
                    secondary={selectedTableOption?.meta}
                    open={open}
                  />
                )}
              />
              {selectedTable ? (
                <span className="text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                  {selectedTable.rowCount} row{selectedTable.rowCount === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>

            <SectionDisclosure
              title="Table details"
              open={tableDetailsOpen}
              onToggle={() => setTableDetailsOpen((current) => !current)}
            >
              <div className="grid gap-5 lg:grid-cols-3">
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--db-text-quiet)' }}>
                    Columns
                  </div>
                  <div className="space-y-2">
                    {selectedTable?.columns.map((column) => (
                      <div key={column.name} className="text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                        <span style={{ color: 'var(--db-text-primary)' }}>{column.name}</span>
                        {' · '}
                        {column.type}
                        {column.primaryKey ? ' · primary key' : ''}
                      </div>
                    )) ?? (
                      <div className="text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                        No table selected.
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--db-text-quiet)' }}>
                    Indexes
                  </div>
                  <div className="space-y-2">
                    {activePool.snapshot.indexes.length ? activePool.snapshot.indexes.map((index) => (
                      <div key={index.name} className="text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                        <span style={{ color: 'var(--db-text-primary)' }}>{index.name}</span>
                        {' · '}
                        {index.table}
                        {' ('}
                        {index.columns.join(', ')}
                        {')'}
                      </div>
                    )) : (
                      <div className="text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                        No indexes detected yet.
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--db-text-quiet)' }}>
                    Pool stats
                  </div>
                  <div className="space-y-2 text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                    <div>max {activePool.snapshot.stats.max}</div>
                    <div>active {activePool.snapshot.stats.active}</div>
                    <div>idle {activePool.snapshot.stats.idle}</div>
                  </div>
                </div>
              </div>
            </SectionDisclosure>

            <div className="db-surface min-h-0 overflow-hidden">
              <div className="border-b px-4 py-3 text-sm font-semibold" style={{ borderColor: 'var(--db-border-default)', color: 'var(--db-text-primary)' }}>
                {selectedTable ? selectedTable.name : 'Table'}
              </div>
              <div className="h-full overflow-auto">
                {selectedTable
                  ? renderDataTable(selectedTableColumns, selectedTable.rows, 'This table does not have any rows yet.')
                  : (
                    <div className="px-4 py-6 text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                      Select a table to inspect its rows.
                    </div>
                  )}
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === 'history' && activePool ? (
          <div className="db-surface h-full min-h-0 overflow-hidden">
            <div className="h-full overflow-auto px-4 py-3">
              <div className="space-y-4">
                {activePool.recentQueries.length ? [...activePool.recentQueries].reverse().map((query, index) => (
                  <div key={`${query.sql}-${index}`} className={index > 0 ? 'border-t pt-4' : ''} style={{ borderColor: 'var(--db-border-default)' }}>
                    <div className="mb-1 text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--db-text-quiet)' }}>
                      {query.operation}
                    </div>
                    <div className="font-mono text-xs" style={{ color: 'var(--db-text-primary)' }}>
                      {query.sql}
                    </div>
                    <div className="mt-2 text-[11px]" style={{ color: 'var(--db-text-secondary)' }}>
                      rows {query.rowCount}
                      {query.usedIndex ? ` · index ${query.usedIndex}` : ''}
                      {query.slowQueryReason ? ` · ${query.slowQueryReason}` : ''}
                    </div>
                  </div>
                )) : (
                  <div className="text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                    No queries captured yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === 'setup' ? (
          <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="db-surface px-4 py-4">
              <div className="text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                Create a reusable database helper in the WebContainer, then import it from your code.
              </div>

              <button
                type="button"
                onClick={() => void handleSetupPostgres()}
                disabled={settingUp}
                className="db-action-primary mt-4 inline-flex items-center justify-center px-3.5 py-2 text-sm font-semibold"
              >
                {settingUp ? 'Setting Up…' : 'Setup Postgres'}
              </button>

              {setupMessage ? (
                <div className="mt-4 text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                  {setupMessage}
                  {setupPath ? (
                    <div className="mt-2 font-mono text-xs" style={{ color: 'var(--db-text-quiet)' }}>
                      {setupPath}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-5">
                <button
                  type="button"
                  onClick={() => setSetupImportOpen((current) => !current)}
                  className="flex items-center gap-2 text-sm font-semibold"
                  style={{ color: 'var(--db-text-primary)' }}
                >
                  <span>Import example</span>
                  <ChevronDown
                    size={16}
                    style={{
                      transform: setupImportOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 160ms ease',
                    }}
                  />
                </button>
                {setupImportOpen ? (
                  <div className="db-control mt-3 p-4 font-mono text-xs" style={{ background: 'var(--db-surface-canvas)', color: 'var(--db-text-secondary)' }}>
                    import {'{ db, sql, ensureExampleTables }'} from './lib/mock-postgres.js';
                    {'\n\n'}await ensureExampleTables();
                    {'\n'}const users = await sql('SELECT * FROM users ORDER BY id ASC');
                  </div>
                ) : null}
              </div>
            </div>

            <div className="db-surface px-4 py-4">
              <button
                type="button"
                onClick={() => setSetupInfoOpen((current) => !current)}
                className="flex items-center gap-2 text-sm font-semibold"
                style={{ color: 'var(--db-text-primary)' }}
              >
                <span>What this gives you</span>
                <ChevronDown
                  size={16}
                  style={{
                    transform: setupInfoOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 160ms ease',
                  }}
                  />
              </button>
              {setupInfoOpen ? (
                <div className="mt-3 space-y-2 text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                  <div>A singleton `Pool` backed by `lintic-mock-pg`.</div>
                  <div>A small `sql()` helper for parameterized queries.</div>
                  <div>Live inspection in this DB workspace after your code imports it.</div>
                </div>
              ) : null}

              <div className="mt-6 text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--db-text-quiet)' }}>
                Status
              </div>
              <div className="mt-2 text-sm" style={{ color: 'var(--db-text-secondary)' }}>
                {activePool
                  ? `Connected to ${activePool.name}.`
                  : 'No active pool detected yet.'}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
