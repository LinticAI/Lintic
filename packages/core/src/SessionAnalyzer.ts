import type {
  InfrastructureMetricScore,
  InfrastructureMetrics,
  Iteration,
  MessageRole,
  MockPgPoolExport,
  PostgresStats,
  RedisStats,
} from './types.js';
import type { StoredMessage, StoredReplayEvent } from './database.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// ─── Iteration Builder ────────────────────────────────────────────────────────

/**
 * Groups stored messages (including rewound) into Iterations.
 *
 * Messages with the same non-null `rewound_at` timestamp belong to the same
 * discarded iteration. Messages with `rewound_at = null` form the active
 * (final) iteration. Iterations are returned in chronological order of first
 * message created_at.
 */
export function buildIterations(messages: StoredMessage[]): Iteration[] {
  // Bucket messages by their rewound_at value (null → active iteration key '')
  const buckets = new Map<string, StoredMessage[]>();

  for (const msg of messages) {
    const key = msg.rewound_at !== null ? String(msg.rewound_at) : '';
    const bucket = buckets.get(key) ?? [];
    bucket.push(msg);
    buckets.set(key, bucket);
  }

  // Determine chronological order: use the minimum created_at of each bucket
  const sortedEntries = [...buckets.entries()].sort(([, a], [, b]) => {
    const minA = Math.min(...a.map((m) => m.created_at));
    const minB = Math.min(...b.map((m) => m.created_at));
    return minA - minB;
  });

  return sortedEntries.map(([key, msgs], i): Iteration => {
    const rewound_at = key === '' ? undefined : Number(key);
    const userMsgs = msgs
      .filter((m) => m.role === ('user' as MessageRole))
      .map((m) => m.content.slice(0, 300));

    return {
      index: i + 1,
      ...(rewound_at !== undefined ? { rewound_at } : {}),
      message_count: msgs.length,
      user_messages: userMsgs,
    };
  });
}

// ─── Redis Stats Extractor ────────────────────────────────────────────────────

/**
 * Extracts Redis cache statistics from `resource_usage` replay events.
 * Events are expected to carry a payload like:
 * `{ redis_stats: { hits: number; misses: number; evictions: number } }`
 *
 * Accumulates across all such events in the session.
 */
export function extractRedisStats(events: StoredReplayEvent[]): RedisStats {
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  for (const event of events) {
    if (event.type !== 'resource_usage') continue;
    if (!isRecord(event.payload)) continue;

    const redisStats = event.payload['redis_stats'];
    if (!isRecord(redisStats)) continue;

    if (typeof redisStats['hits'] === 'number') hits += redisStats['hits'];
    if (typeof redisStats['misses'] === 'number') misses += redisStats['misses'];
    if (typeof redisStats['evictions'] === 'number') evictions += redisStats['evictions'];
  }

  return { hits, misses, evictions };
}

// ─── Postgres Stats Aggregator ────────────────────────────────────────────────

/**
 * Aggregates Postgres query statistics from mock-pg pool exports.
 * The `mock_pg` array comes from a WorkspaceSnapshot's `mock_pg` field.
 */
export function aggregatePostgresStats(mockPg: MockPgPoolExport[]): PostgresStats {
  let total_queries = 0;
  let slow_queries = 0;
  let indexed_data_queries = 0;
  let total_data_queries = 0;

  for (const pool of mockPg) {
    for (const q of pool.recentQueries) {
      total_queries++;

      const isDmlOrQuery =
        q.operation === 'select' ||
        q.operation === 'update' ||
        q.operation === 'delete';

      if (isDmlOrQuery) {
        total_data_queries++;
        if (q.usedIndex) indexed_data_queries++;
        if (q.slowQueryReason) slow_queries++;
      }
    }
  }

  return { total_queries, slow_queries, indexed_data_queries, total_data_queries };
}

// ─── Infrastructure Metrics Computation ──────────────────────────────────────

function makeScore(
  name: string,
  label: string,
  score: number,
  details: string,
): InfrastructureMetricScore {
  return { name, label, score: clamp01(score), details };
}

/**
 * Computes the three infrastructure metric scores from raw stats.
 *
 * - **caching_effectiveness**: Redis hit rate (hits / (hits + misses)).
 *   If no Redis activity is observed (no requests), score is 0.
 * - **error_handling_coverage**: Inverse slow-query rate for Postgres.
 *   1 - (slow / total_data) measures how well the candidate avoided full scans.
 *   Score is 1 when there are no data queries (nothing to penalise).
 * - **scaling_awareness**: Proportion of data queries that used an index.
 *   Score is 1 when there are no data queries.
 */
export function computeInfrastructureMetrics(
  redis: RedisStats,
  pg: PostgresStats,
): InfrastructureMetrics {
  // Caching effectiveness
  const totalRedisRequests = redis.hits + redis.misses;
  const cachingScore = totalRedisRequests === 0
    ? 0
    : redis.hits / totalRedisRequests;
  const caching_effectiveness = makeScore(
    'caching_effectiveness',
    'Caching Effectiveness',
    cachingScore,
    totalRedisRequests === 0
      ? 'No Redis activity detected'
      : `${redis.hits} hits / ${totalRedisRequests} requests${redis.evictions > 0 ? `, ${redis.evictions} evictions` : ''}`,
  );

  // Error handling coverage (slow-query avoidance)
  const errorScore = pg.total_data_queries === 0
    ? 1
    : 1 - pg.slow_queries / pg.total_data_queries;
  const error_handling_coverage = makeScore(
    'error_handling_coverage',
    'Error Handling Coverage',
    errorScore,
    pg.total_data_queries === 0
      ? 'No Postgres data queries recorded'
      : `${pg.slow_queries} slow queries out of ${pg.total_data_queries} data queries`,
  );

  // Scaling awareness (index usage rate)
  const scalingScore = pg.total_data_queries === 0
    ? 1
    : pg.indexed_data_queries / pg.total_data_queries;
  const scaling_awareness = makeScore(
    'scaling_awareness',
    'Scaling Awareness',
    scalingScore,
    pg.total_data_queries === 0
      ? 'No Postgres data queries recorded'
      : `${pg.indexed_data_queries}/${pg.total_data_queries} queries used an index`,
  );

  return { caching_effectiveness, error_handling_coverage, scaling_awareness };
}

// ─── History Truncation ───────────────────────────────────────────────────────

/**
 * Returns the most recent `maxMessages` stored messages from the active
 * (non-rewound) subset. Used to cap the context fed to the evaluator LLM.
 */
export function truncateHistory(
  messages: StoredMessage[],
  maxMessages: number,
): StoredMessage[] {
  const active = messages.filter((m) => m.rewound_at === null);
  if (active.length <= maxMessages) return active;
  return active.slice(active.length - maxMessages);
}

// ─── Evaluator Context Builder ────────────────────────────────────────────────

/**
 * Formats a text block describing the session for the evaluator LLM.
 * Includes iteration summary, infrastructure stats, and the truncated
 * message history.
 */
export function buildEvaluatorContext(
  sessionId: string,
  promptId: string,
  iterations: Iteration[],
  infra: InfrastructureMetrics,
  history: StoredMessage[],
): string {
  const iterationSummary = iterations
    .map((it) => {
      const abandoned = it.rewound_at !== undefined ? ' [REWOUND]' : '';
      return `  Iteration ${it.index}${abandoned}: ${it.message_count} messages`;
    })
    .join('\n');

  const rewindCount = iterations.filter((it) => it.rewound_at !== undefined).length;

  const infraSummary = [
    `  Caching effectiveness: ${Math.round(infra.caching_effectiveness.score * 100)}% — ${infra.caching_effectiveness.details}`,
    `  Error handling coverage: ${Math.round(infra.error_handling_coverage.score * 100)}% — ${infra.error_handling_coverage.details}`,
    `  Scaling awareness: ${Math.round(infra.scaling_awareness.score * 100)}% — ${infra.scaling_awareness.details}`,
  ].join('\n');

  const historyText = history
    .map((m) => {
      const role = m.role === 'user' ? 'Candidate' : m.role === 'assistant' ? 'Agent' : m.role;
      const text = m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content;
      return `[${role}]: ${text}`;
    })
    .join('\n\n');

  return `## Session Metadata
Session ID: ${sessionId}
Prompt: ${promptId}
Total iterations: ${iterations.length} (${rewindCount} rewound)

## Iteration Breakdown
${iterationSummary}

## Infrastructure Metrics
${infraSummary}

## Conversation History (last ${history.length} messages)
${historyText || '(no messages)'}`;
}
