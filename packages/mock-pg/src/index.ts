import { newDb, type IMemoryDb, type ISubscription } from 'pg-mem';
import { MockPgError } from './types.js';
import { parseSql } from './parser.js';
import type {
  BridgeCommand,
  BridgeExportFile,
  BridgeResponse,
  BridgeStateFile,
  IndexSnapshot,
  InspectablePoolState,
  PoolClient,
  PoolConfig,
  PoolExportState,
  PoolEvent,
  PoolEventListener,
  PoolSnapshot,
  PoolStatsSnapshot,
  PrimitiveValue,
  QueryLogEntry,
  QueryOperation,
  QueryResult,
  QueryRow,
  SlowQueryRecord,
  TableDataSnapshot,
  TableSnapshot,
} from './types.js';

interface RawQueryResult<R extends QueryRow = QueryRow> {
  rows?: R[];
  rowCount?: number | null;
}

interface RawClient {
  connect(): Promise<void>;
  query<R extends QueryRow = QueryRow>(sql: string, params?: PrimitiveValue[]): Promise<RawQueryResult<R>>;
  end(): Promise<void>;
}

interface RawClientConstructor {
  new (): RawClient;
}

interface QueryDescription {
  operation: QueryOperation;
  table: string | null;
  whereColumns: string[];
}

interface ExecutionContext {
  slowTables: Set<string>;
  slowQueryReason?: 'no_matching_index';
}

interface ResolvedBridgeConfig {
  statePath: string;
  exportPath: string;
  bootstrapPath: string;
  commandsDir: string;
  responsesDir: string;
  pollMs: number;
}

type FsModule = typeof import('node:fs/promises');

const DEFAULT_BRIDGE_ROOT = '.lintic/mock-pg';
const DEFAULT_BRIDGE_CONFIG: ResolvedBridgeConfig = {
  statePath: `${DEFAULT_BRIDGE_ROOT}/state.json`,
  exportPath: `${DEFAULT_BRIDGE_ROOT}/export.json`,
  bootstrapPath: `${DEFAULT_BRIDGE_ROOT}/bootstrap.json`,
  commandsDir: `${DEFAULT_BRIDGE_ROOT}/commands`,
  responsesDir: `${DEFAULT_BRIDGE_ROOT}/responses`,
  pollMs: 200,
};

const registeredPools = new Map<string, Pool>();
let poolCounter = 1;
let fsModulePromise: Promise<FsModule> | null = null;
let bridgePoller: ReturnType<typeof setInterval> | null = null;
let bridgeSyncInFlight = false;
let bridgeSyncPromise: Promise<void> | null = null;
let activeBridgeConfig: ResolvedBridgeConfig | null = null;

function normalizeName(value: string): string {
  return value.replace(/"/g, '').trim().toLowerCase();
}

function detectOperation(sql: string): QueryOperation {
  const trimmed = sql.trim();
  if (/^CREATE\s+TABLE\b/i.test(trimmed)) return 'create_table';
  if (/^CREATE\s+INDEX\b/i.test(trimmed)) return 'create_index';
  if (/^INSERT\b/i.test(trimmed)) return 'insert';
  if (/^SELECT\b/i.test(trimmed)) return 'select';
  if (/^UPDATE\b/i.test(trimmed)) return 'update';
  if (/^DELETE\b/i.test(trimmed)) return 'delete';
  throw new MockPgError('Unsupported SQL statement', 'UNSUPPORTED_SQL');
}

function inferQueryDescription(sql: string): QueryDescription {
  const operation = detectOperation(sql);

  try {
    const statement = parseSql(sql);
    switch (statement.type) {
      case 'create_table':
      case 'create_index':
      case 'insert':
        return { operation, table: statement.table, whereColumns: [] };
      case 'select':
      case 'update':
      case 'delete':
        return {
          operation,
          table: statement.table,
          whereColumns: statement.where.map((condition) => condition.column),
        };
    }
  } catch {
    const tableMatch =
      operation === 'select'
        ? sql.match(/\bFROM\s+([A-Za-z_"][A-Za-z0-9_"]*)/i)
        : operation === 'create_index'
          ? sql.match(/\bON\s+([A-Za-z_"][A-Za-z0-9_"]*)/i)
          : operation === 'delete'
            ? sql.match(/^DELETE\s+FROM\s+([A-Za-z_"][A-Za-z0-9_"]*)/i)
            : sql.match(/^(?:CREATE\s+TABLE|INSERT\s+INTO|UPDATE)\s+([A-Za-z_"][A-Za-z0-9_"]*)/i);

    return {
      operation,
      table: tableMatch ? normalizeName(tableMatch[1]!) : null,
      whereColumns: [],
    };
  }
}

function nextPoolId(): string {
  const id = `pool-${poolCounter}`;
  poolCounter += 1;
  return id;
}

function resolveBridgeConfig(config: PoolConfig['bridge']): ResolvedBridgeConfig | null {
  if (config === false) {
    return null;
  }

  if (config === undefined || config === true) {
    return { ...DEFAULT_BRIDGE_CONFIG };
  }

  const statePath = config.statePath ?? DEFAULT_BRIDGE_CONFIG.statePath;
  const lastSlash = statePath.lastIndexOf('/');
  const bridgeRoot = lastSlash >= 0 ? statePath.slice(0, lastSlash) : DEFAULT_BRIDGE_ROOT;

  return {
    statePath,
    exportPath: `${bridgeRoot}/export.json`,
    bootstrapPath: `${bridgeRoot}/bootstrap.json`,
    commandsDir: config.commandsDir ?? DEFAULT_BRIDGE_CONFIG.commandsDir,
    responsesDir: config.responsesDir ?? DEFAULT_BRIDGE_CONFIG.responsesDir,
    pollMs: config.pollMs ?? DEFAULT_BRIDGE_CONFIG.pollMs,
  };
}

async function getFsModule(): Promise<FsModule> {
  if (!fsModulePromise) {
    fsModulePromise = import('node:fs/promises');
  }
  return fsModulePromise;
}

async function ensureBridgeDirectories(fs: FsModule, config: ResolvedBridgeConfig): Promise<void> {
  const path = await import('node:path');
  await fs.mkdir(path.dirname(config.statePath), { recursive: true });
  await fs.mkdir(path.dirname(config.exportPath), { recursive: true });
  await fs.mkdir(path.dirname(config.bootstrapPath), { recursive: true });
  await fs.mkdir(config.commandsDir, { recursive: true });
  await fs.mkdir(config.responsesDir, { recursive: true });
}

function getBridgePools(): Pool[] {
  return Array.from(registeredPools.values()).filter((pool) => pool.bridgeConfig !== null);
}

function startBridgeIfNeeded(config: ResolvedBridgeConfig): void {
  if (activeBridgeConfig === null) {
    activeBridgeConfig = config;
  }

  if (bridgePoller !== null) {
    return;
  }

  bridgePoller = setInterval(() => {
    void syncBridgeStateAndCommands();
  }, activeBridgeConfig.pollMs);
  void syncBridgeStateAndCommands();
}

async function writeBridgeStateFile(fs: FsModule, config: ResolvedBridgeConfig): Promise<void> {
  const state: BridgeStateFile = {
    version: 1,
    updatedAt: Date.now(),
    pools: getBridgePools().map((pool) => pool.getInspectorState()),
  };
  await fs.writeFile(config.statePath, JSON.stringify(state, null, 2), 'utf-8');
}

async function writeBridgeExportFile(fs: FsModule, config: ResolvedBridgeConfig): Promise<void> {
  const state: BridgeExportFile = {
    version: 1,
    updatedAt: Date.now(),
    pools: getBridgePools().map((pool) => pool.exportState()),
  };
  await fs.writeFile(config.exportPath, JSON.stringify(state, null, 2), 'utf-8');
}

async function processBridgeCommands(fs: FsModule, config: ResolvedBridgeConfig): Promise<void> {
  const path = await import('node:path');
  const commandFiles = await fs.readdir(config.commandsDir).catch(() => [] as string[]);

  for (const fileName of commandFiles.filter((entry) => entry.endsWith('.json')).sort()) {
    const commandPath = path.join(config.commandsDir, fileName);
    const rawCommand = await fs.readFile(commandPath, 'utf-8').catch(() => null);
    if (!rawCommand) {
      continue;
    }

    let command: BridgeCommand;
    try {
      command = JSON.parse(rawCommand) as BridgeCommand;
    } catch {
      await fs.rm(commandPath, { force: true });
      continue;
    }

    const targetPool = command.poolId
      ? registeredPools.get(command.poolId)
      : getBridgePools().at(0);

    let response: BridgeResponse;
    if (!targetPool) {
      response = {
        id: command.id,
        poolId: command.poolId ?? '',
        ok: false,
        error: { message: 'No active lintic-mock-pg pool was found' },
        createdAt: command.createdAt,
        completedAt: Date.now(),
      };
    } else {
      try {
        const result = await targetPool.query(command.sql, command.params ?? []);
        response = {
          id: command.id,
          poolId: targetPool.id,
          ok: true,
          result,
          createdAt: command.createdAt,
          completedAt: Date.now(),
        };
      } catch (error) {
        response = {
          id: command.id,
          poolId: targetPool.id,
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof MockPgError ? { code: error.code } : {}),
          },
          createdAt: command.createdAt,
          completedAt: Date.now(),
        };
      }
    }

    await fs.writeFile(
      path.join(config.responsesDir, `${command.id}.json`),
      JSON.stringify(response, null, 2),
      'utf-8',
    );
    await fs.rm(commandPath, { force: true });
  }
}

async function syncBridgeStateAndCommands(): Promise<void> {
  if (bridgeSyncInFlight || activeBridgeConfig === null) {
    return bridgeSyncPromise ?? Promise.resolve();
  }

  const config = activeBridgeConfig;
  bridgeSyncInFlight = true;
  bridgeSyncPromise = (async () => {
    try {
      const fs = await getFsModule();
      await ensureBridgeDirectories(fs, config);
      await processBridgeCommands(fs, config);
      await writeBridgeStateFile(fs, config);
      await writeBridgeExportFile(fs, config);
    } finally {
      bridgeSyncInFlight = false;
      bridgeSyncPromise = null;
    }
  })();
  return bridgeSyncPromise;
}

function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

class PoolClientImpl implements PoolClient {
  private released = false;

  constructor(
    private readonly pool: Pool,
    private readonly id: number,
    private readonly rawClient: RawClient,
  ) {}

  async query<R extends QueryRow = QueryRow>(sql: string, params: PrimitiveValue[] = []): Promise<QueryResult<R>> {
    if (this.released) {
      throw new MockPgError('Client has already been released', 'CLIENT_RELEASED');
    }
    return this.pool.executeWithClient(this.rawClient, sql, params);
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.pool.releaseClient(this.id);
  }
}

export class Pool {
  readonly id: string;
  readonly name: string;
  readonly bridgeConfig: ResolvedBridgeConfig | null;

  private readonly db: IMemoryDb;
  private readonly RawClient: RawClientConstructor;
  private readonly listeners = new Set<PoolEventListener>();
  private readonly idleClientIds: number[] = [];
  private readonly activeClientIds = new Set<number>();
  private readonly clients = new Map<number, RawClient>();
  private readonly recentQueries: QueryLogEntry[] = [];
  private readonly subscriptions: ISubscription[] = [];
  private readonly activeExecutions: ExecutionContext[] = [];
  private readonly max: number;
  private readonly maxRecentQueries: number;
  private readonly slowQueryThresholdMs: number | undefined;
  private readonly onSlowQuery: ((record: SlowQueryRecord) => void) | undefined;
  private readonly bootstrapPromise: Promise<void>;
  private ended = false;
  private nextClientId = 1;

  constructor(config: PoolConfig = {}) {
    this.id = nextPoolId();
    this.name = config.name ?? this.id;
    this.bridgeConfig = resolveBridgeConfig(config.bridge);
    this.db = newDb();
    const adapter = this.db.adapters.createPg();
    this.RawClient = adapter.Client as RawClientConstructor;
    this.max = config.max ?? 10;
    this.maxRecentQueries = config.maxRecentQueries ?? 100;
    this.slowQueryThresholdMs = config.slowQueryThresholdMs;
    this.onSlowQuery = config.onSlowQuery;

    registeredPools.set(this.id, this);
    if (this.bridgeConfig) {
      startBridgeIfNeeded(this.bridgeConfig);
      this.bootstrapPromise = this.loadBootstrapState();
      void syncBridgeStateAndCommands();
    } else {
      this.bootstrapPromise = Promise.resolve();
    }

    this.subscriptions.push(
      this.db.on('seq-scan', (table) => {
        const execution = this.activeExecutions.at(-1);
        if (!execution) {
          return;
        }
        execution.slowQueryReason = 'no_matching_index';
        execution.slowTables.add(normalizeName(table));
      }),
      this.db.on('catastrophic-join-optimization', () => {
        const execution = this.activeExecutions.at(-1);
        if (!execution) {
          return;
        }
        execution.slowQueryReason = 'no_matching_index';
      }),
    );
  }

  async query<R extends QueryRow = QueryRow>(sql: string, params: PrimitiveValue[] = []): Promise<QueryResult<R>> {
    await this.bootstrapPromise;
    this.assertUsable();
    const client = await this.connect();
    try {
      return await client.query<R>(sql, params);
    } finally {
      client.release();
    }
  }

  async connect(): Promise<PoolClient> {
    await this.bootstrapPromise;
    this.assertUsable();

    let clientId: number;
    if (this.idleClientIds.length > 0) {
      clientId = this.idleClientIds.pop()!;
    } else if (this.activeClientIds.size + this.idleClientIds.length < this.max) {
      clientId = this.nextClientId;
      this.nextClientId += 1;
      const rawClient = new this.RawClient();
      await rawClient.connect();
      this.clients.set(clientId, rawClient);
    } else {
      throw new MockPgError(`Connection pool exhausted (max=${this.max})`, 'POOL_EXHAUSTED');
    }

    const rawClient = this.clients.get(clientId);
    if (!rawClient) {
      throw new MockPgError(`Missing pooled client ${clientId}`, 'POOL_STATE_ERROR');
    }

    this.activeClientIds.add(clientId);
    this.emit({
      type: 'pool',
      action: 'client_acquired',
      stats: this.getStats(),
      timestamp: Date.now(),
    });
    return new PoolClientImpl(this, clientId, rawClient);
  }

  async end(): Promise<void> {
    this.ended = true;
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    await Promise.all(Array.from(this.clients.values()).map((client) => client.end()));
    this.clients.clear();
    this.activeClientIds.clear();
    this.idleClientIds.length = 0;
    this.emit({
      type: 'pool',
      action: 'ended',
      stats: this.getStats(),
      timestamp: Date.now(),
    });
    if (this.bridgeConfig) {
      registeredPools.delete(this.id);
      if (getBridgePools().length === 0 && bridgePoller !== null) {
        clearInterval(bridgePoller);
        bridgePoller = null;
        activeBridgeConfig = null;
        if (bridgeSyncPromise) {
          await bridgeSyncPromise;
        }
      } else {
        void syncBridgeStateAndCommands();
      }
    }
  }

  getSnapshot(): PoolSnapshot {
    return {
      stats: this.getStats(),
      tables: this.getTableSnapshots(),
      indexes: this.getIndexSnapshots(),
    };
  }

  getRecentQueries(): QueryLogEntry[] {
    return this.recentQueries.map((query) => ({ ...query, params: [...query.params] }));
  }

  exportState(): PoolExportState {
    return {
      id: this.id,
      name: this.name,
      tables: this.getTableDataSnapshots().map((table) => ({
        name: table.name,
        columns: table.columns,
        rows: table.rows.map((row) => ({ ...row })),
      })),
      indexes: this.getIndexSnapshots(),
      recentQueries: this.getRecentQueries(),
    };
  }

  async importState(state: PoolExportState): Promise<void> {
    await this.bootstrapPromise;
    await this.importStateInternal(state);
  }

  private async importStateInternal(state: PoolExportState): Promise<void> {
    const rawClient = new this.RawClient();
    await rawClient.connect();
    try {
      for (const tableName of [...this.getTableNames()].reverse()) {
        await rawClient.query(`DROP TABLE IF EXISTS ${escapeIdentifier(tableName)} CASCADE`);
      }

      for (const table of state.tables) {
        const columnsSql = table.columns
          .map((column) => `${escapeIdentifier(column.name)} ${column.type}${column.primaryKey ? ' PRIMARY KEY' : ''}`)
          .join(', ');
        await rawClient.query(`CREATE TABLE ${escapeIdentifier(table.name)} (${columnsSql})`);
      }

      for (const index of state.indexes) {
        if (index.kind === 'primary') {
          continue;
        }
        const columnsSql = index.columns.map(escapeIdentifier).join(', ');
        await rawClient.query(
          `CREATE INDEX ${escapeIdentifier(index.name)} ON ${escapeIdentifier(index.table)} (${columnsSql})`,
        );
      }

      for (const table of state.tables) {
        for (const row of table.rows) {
          const columns = Object.keys(row);
          if (columns.length === 0) {
            continue;
          }
          const values = columns.map((column) => row[column] ?? null);
          const placeholders = values.map((_value, index) => `$${index + 1}`).join(', ');
          const columnsSql = columns.map(escapeIdentifier).join(', ');
          await rawClient.query(
            `INSERT INTO ${escapeIdentifier(table.name)} (${columnsSql}) VALUES (${placeholders})`,
            values,
          );
        }
      }

      this.recentQueries.splice(0, this.recentQueries.length, ...state.recentQueries.map((query) => ({
        ...query,
        params: [...query.params],
      })));
    } finally {
      await rawClient.end();
    }

    if (this.bridgeConfig) {
      void syncBridgeStateAndCommands();
    }
  }

  getTableRows(tableName: string): QueryRow[] {
    const table = this.db.getTable(tableName, true);
    if (!table) {
      throw new MockPgError(`Table does not exist: ${tableName}`, 'UNDEFINED_TABLE');
    }
    return table.find().map((row) => ({ ...row } as QueryRow));
  }

  getInspectorState(): InspectablePoolState {
    return {
      id: this.id,
      name: this.name,
      snapshot: this.getSnapshot(),
      tables: this.getTableDataSnapshots(),
      recentQueries: this.getRecentQueries(),
    };
  }

  subscribe(listener: PoolEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  releaseClient(clientId: number): void {
    if (!this.activeClientIds.has(clientId)) {
      return;
    }
    this.activeClientIds.delete(clientId);
    if (!this.ended) {
      this.idleClientIds.push(clientId);
    }
    this.emit({
      type: 'pool',
      action: 'client_released',
      stats: this.getStats(),
      timestamp: Date.now(),
    });
  }

  async executeWithClient<R extends QueryRow = QueryRow>(rawClient: RawClient, sql: string, params: PrimitiveValue[] = []): Promise<QueryResult<R>> {
    await this.bootstrapPromise;
    this.assertUsable();
    const description = inferQueryDescription(sql);
    const execution: ExecutionContext = {
      slowTables: new Set<string>(),
    };
    this.activeExecutions.push(execution);

    let rawResult: RawQueryResult<R>;
    try {
      rawResult = await rawClient.query<R>(sql, params);
    } finally {
      this.activeExecutions.pop();
    }

    const timestamp = Date.now();
    const rowCount = rawResult.rowCount ?? rawResult.rows?.length ?? 0;
    const usedIndex = this.inferUsedIndex(description.table, description.whereColumns, execution);
    const queryRecord: QueryLogEntry = {
      sql,
      params: [...params],
      operation: description.operation,
      table: description.table,
      rowCount,
      ...(usedIndex ? { usedIndex } : {}),
      ...(execution.slowQueryReason ? { slowQueryReason: execution.slowQueryReason } : {}),
      timestamp,
    };

    this.recentQueries.push(queryRecord);
    if (this.recentQueries.length > this.maxRecentQueries) {
      this.recentQueries.shift();
    }

    this.emit({ type: 'query', query: queryRecord, timestamp });

    if (description.operation === 'create_table' || description.operation === 'create_index') {
      this.emit({
        type: 'schema',
        action: description.operation === 'create_table' ? 'table_created' : 'index_created',
        table: description.table!,
        snapshot: this.getSnapshot(),
        timestamp,
      });
    }

    if (
      execution.slowQueryReason &&
      (description.operation === 'select' || description.operation === 'update' || description.operation === 'delete')
    ) {
      const slowTable = description.table ?? execution.slowTables.values().next().value ?? null;
      if (slowTable !== null) {
        const slowQuery: SlowQueryRecord = {
          sql,
          params: [...params],
          operation: description.operation,
          table: slowTable,
          whereColumns: [...description.whereColumns],
          reason: execution.slowQueryReason,
          timestamp,
        };
        this.onSlowQuery?.(slowQuery);
        void this.slowQueryThresholdMs;
      }
    }

    if (this.bridgeConfig) {
      void syncBridgeStateAndCommands();
    }

    return {
      rows: rawResult.rows ?? [],
      rowCount,
    };
  }

  private assertUsable(): void {
    if (this.ended) {
      throw new MockPgError('Pool has been ended', 'POOL_ENDED');
    }
  }

  private getStats(): PoolStatsSnapshot {
    return {
      max: this.max,
      active: this.activeClientIds.size,
      idle: this.idleClientIds.length,
      ended: this.ended,
    };
  }

  private getTableSnapshots(): TableSnapshot[] {
    return this.getTableDataSnapshots().map((table) => ({
      name: table.name,
      columns: table.columns,
      rowCount: table.rowCount,
    }));
  }

  private getTableDataSnapshots(): TableDataSnapshot[] {
    const tables = this.db.public.many(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    ) as Array<{ table_name: string }>;

    return tables.map(({ table_name }) => {
      const table = this.db.getTable(table_name);
      const rows = table.find().map((row) => ({ ...row } as QueryRow));
      const columns = Array.from(table.getColumns()).map((column) => ({
        name: column.name,
        type: String((column.type as { primary?: string }).primary ?? column.type).toUpperCase(),
        primaryKey: table.primaryIndex?.expressions.some((expression) => normalizeName(expression) === normalizeName(column.name)) ?? false,
      }));

      return {
        name: table_name,
        columns,
        rowCount: rows.length,
        rows,
      };
    });
  }

  private getIndexSnapshots(): IndexSnapshot[] {
    return this.getTableNames()
      .flatMap((tableName) => {
        const table = this.db.getTable(tableName);
        return table.listIndices().map((index) => {
          const kind: IndexSnapshot['kind'] = table.primaryIndex?.name === index.name ? 'primary' : 'index';
          return {
            name: index.name,
            table: tableName,
            columns: index.expressions.map(normalizeName),
            kind,
          };
        });
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private getTableNames(): string[] {
    return (this.db.public
      .many("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name") as Array<{ table_name: string }>)
      .map((row) => row.table_name);
  }

  private inferUsedIndex(tableName: string | null, whereColumns: string[], execution: ExecutionContext): string | undefined {
    if (!tableName || whereColumns.length === 0 || execution.slowQueryReason) {
      return undefined;
    }

    const table = this.db.getTable(tableName, true);
    if (!table) {
      return undefined;
    }

    let bestIndexName: string | undefined;
    let bestPrefix = 0;
    const availableColumns = new Set(whereColumns.map(normalizeName));

    for (const index of table.listIndices()) {
      let prefix = 0;
      for (const expression of index.expressions.map(normalizeName)) {
        if (!availableColumns.has(expression)) {
          break;
        }
        prefix += 1;
      }
      if (prefix > bestPrefix) {
        bestPrefix = prefix;
        bestIndexName = index.name;
      }
    }

    return bestIndexName;
  }

  private emit(event: PoolEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async loadBootstrapState(): Promise<void> {
    if (!this.bridgeConfig) {
      return;
    }

    const fs = await getFsModule();
    const raw = await fs.readFile(this.bridgeConfig.bootstrapPath, 'utf-8').catch(() => null);
    if (!raw) {
      return;
    }

    let bootstrap: BridgeExportFile | { pools?: PoolExportState[] };
    try {
      bootstrap = JSON.parse(raw) as BridgeExportFile | { pools?: PoolExportState[] };
    } catch {
      return;
    }

    const pools = Array.isArray(bootstrap.pools) ? bootstrap.pools : [];
    const match = pools.find((pool) => pool.name === this.name || pool.id === this.id);
    if (!match) {
      return;
    }

    await this.importStateInternal(match);
    const remaining = pools.filter((pool) => pool !== match);
    await fs.writeFile(
      this.bridgeConfig.bootstrapPath,
      JSON.stringify({ version: 1, updatedAt: Date.now(), pools: remaining }, null, 2),
      'utf-8',
    ).catch(() => undefined);
  }
}

export type {
  BridgeCommand,
  BridgeConfig,
  BridgeExportFile,
  BridgeResponse,
  BridgeStateFile,
  ColumnSnapshot,
  IndexKind,
  IndexSnapshot,
  InspectablePoolState,
  PoolClient,
  PoolConfig,
  PoolEvent,
  PoolEventListener,
  PoolExportState,
  PoolSnapshot,
  PoolStatsSnapshot,
  PrimitiveValue,
  QueryLogEntry,
  QueryOperation,
  QueryResult,
  QueryRow,
  SlowQueryReason,
  SlowQueryRecord,
  TableDataSnapshot,
  TableSnapshot,
} from './types.js';

export { MockPgError } from './types.js';
