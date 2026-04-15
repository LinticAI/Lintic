import { describe, expect, test } from 'vitest';
import type { EvaluationResult, InfrastructureMetricScore, MockPgPoolExport } from './types.js';
import type { StoredMessage, StoredReplayEvent } from './database.js';
import {
  aggregatePostgresStats,
  buildIterations,
  computeSessionAnalysisScore,
  computeInfrastructureMetrics,
  extractRedisStats,
  truncateHistory,
} from './SessionAnalyzer.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(
  id: number,
  role: 'user' | 'assistant',
  content: string,
  rewound_at: number | null = null,
  created_at = id * 1000,
): StoredMessage {
  return {
    id,
    session_id: 'sess-1',
    branch_id: 'main',
    conversation_id: 'conv-1',
    turn_sequence: id,
    role,
    content,
    token_count: 10,
    created_at,
    rewound_at,
  };
}

function makeReplayEvent(
  type: StoredReplayEvent['type'],
  payload: unknown,
  id = 1,
): StoredReplayEvent {
  return {
    id,
    session_id: 'sess-1',
    branch_id: 'main',
    conversation_id: 'conv-1',
    turn_sequence: null,
    type,
    timestamp: Date.now(),
    payload,
  };
}

function makeQueryLog(
  operation: 'select' | 'update' | 'delete' | 'insert' | 'create_table' | 'create_index',
  opts: { usedIndex?: string; slowQueryReason?: string } = {},
): MockPgPoolExport['recentQueries'][number] {
  return {
    sql: `${operation} ...`,
    params: [],
    operation,
    table: 'books',
    rowCount: 1,
    ...(opts.usedIndex ? { usedIndex: opts.usedIndex } : {}),
    ...(opts.slowQueryReason ? { slowQueryReason: opts.slowQueryReason } : {}),
    timestamp: Date.now(),
  };
}

function makePgExport(queries: MockPgPoolExport['recentQueries']): MockPgPoolExport {
  return {
    id: 'pool-1',
    name: 'default',
    tables: [],
    indexes: [],
    recentQueries: queries,
  };
}

// ─── buildIterations ──────────────────────────────────────────────────────────

describe('buildIterations', () => {
  test('returns a single active iteration when no messages were rewound', () => {
    const messages = [
      makeMessage(1, 'user', 'hello'),
      makeMessage(2, 'assistant', 'world'),
      makeMessage(3, 'user', 'follow up'),
    ];

    const iterations = buildIterations(messages);

    expect(iterations).toHaveLength(1);
    expect(iterations[0]?.index).toBe(1);
    expect(iterations[0]?.rewound_at).toBeUndefined();
    expect(iterations[0]?.message_count).toBe(3);
    expect(iterations[0]?.user_messages).toEqual(['hello', 'follow up']);
  });

  test('separates rewound messages into distinct prior iterations', () => {
    const REWIND_TS = 5000;
    const messages = [
      makeMessage(1, 'user', 'first attempt', REWIND_TS, 1000),
      makeMessage(2, 'assistant', 'bad answer', REWIND_TS, 2000),
      makeMessage(3, 'user', 'second attempt', null, 3000),
      makeMessage(4, 'assistant', 'good answer', null, 4000),
    ];

    const iterations = buildIterations(messages);

    expect(iterations).toHaveLength(2);
    // First iteration was the abandoned one
    expect(iterations[0]?.rewound_at).toBe(REWIND_TS);
    expect(iterations[0]?.message_count).toBe(2);
    // Second iteration is active
    expect(iterations[1]?.rewound_at).toBeUndefined();
    expect(iterations[1]?.message_count).toBe(2);
  });

  test('orders iterations chronologically by earliest message', () => {
    const REWIND_A = 9000;
    const REWIND_B = 18000;
    const messages = [
      makeMessage(1, 'user', 'a1', REWIND_A, 1000),
      makeMessage(2, 'user', 'b1', REWIND_B, 10000),
      makeMessage(3, 'user', 'c1', null, 20000),
    ];

    const iterations = buildIterations(messages);

    expect(iterations.map((it) => it.rewound_at)).toEqual([REWIND_A, REWIND_B, undefined]);
  });

  test('returns empty array when there are no messages', () => {
    expect(buildIterations([])).toEqual([]);
  });

  test('truncates long user messages to 300 characters', () => {
    const longText = 'x'.repeat(500);
    const messages = [makeMessage(1, 'user', longText)];

    const [iteration] = buildIterations(messages);
    expect(iteration?.user_messages[0]?.length).toBe(300);
  });
});

// ─── extractRedisStats ────────────────────────────────────────────────────────

describe('extractRedisStats', () => {
  test('returns zeroes when there are no resource_usage events', () => {
    const stats = extractRedisStats([
      makeReplayEvent('message', { role: 'user', content: 'hello' }),
    ]);
    expect(stats).toEqual({ hits: 0, misses: 0, evictions: 0 });
  });

  test('accumulates redis_stats across multiple resource_usage events', () => {
    const events: StoredReplayEvent[] = [
      makeReplayEvent('resource_usage', { redis_stats: { hits: 3, misses: 1, evictions: 0 } }, 1),
      makeReplayEvent('resource_usage', { redis_stats: { hits: 2, misses: 0, evictions: 1 } }, 2),
    ];

    const stats = extractRedisStats(events);
    expect(stats).toEqual({ hits: 5, misses: 1, evictions: 1 });
  });

  test('ignores resource_usage events without redis_stats', () => {
    const events: StoredReplayEvent[] = [
      makeReplayEvent('resource_usage', { cpu: 0.5 }),
    ];
    expect(extractRedisStats(events)).toEqual({ hits: 0, misses: 0, evictions: 0 });
  });
});

// ─── aggregatePostgresStats ───────────────────────────────────────────────────

describe('aggregatePostgresStats', () => {
  test('returns zeroes for empty pool export', () => {
    expect(aggregatePostgresStats([makePgExport([])])).toEqual({
      total_queries: 0,
      slow_queries: 0,
      indexed_data_queries: 0,
      total_data_queries: 0,
    });
  });

  test('counts slow queries correctly', () => {
    const queries = [
      makeQueryLog('select', { slowQueryReason: 'no_matching_index' }),
      makeQueryLog('select', { usedIndex: 'idx_title' }),
      makeQueryLog('insert'),
    ];

    const stats = aggregatePostgresStats([makePgExport(queries)]);
    expect(stats.total_queries).toBe(3);
    expect(stats.slow_queries).toBe(1);
    expect(stats.total_data_queries).toBe(2); // select x2, no insert
    expect(stats.indexed_data_queries).toBe(1);
  });

  test('does not count create_table or create_index as data queries', () => {
    const queries = [
      makeQueryLog('create_table'),
      makeQueryLog('create_index'),
    ];

    const stats = aggregatePostgresStats([makePgExport(queries)]);
    expect(stats.total_queries).toBe(2);
    expect(stats.total_data_queries).toBe(0);
  });

  test('aggregates across multiple pools', () => {
    const pool1 = makePgExport([makeQueryLog('select', { usedIndex: 'idx' })]);
    const pool2 = makePgExport([makeQueryLog('select', { slowQueryReason: 'no_matching_index' })]);

    const stats = aggregatePostgresStats([pool1, pool2]);
    expect(stats.total_data_queries).toBe(2);
    expect(stats.indexed_data_queries).toBe(1);
    expect(stats.slow_queries).toBe(1);
  });
});

// ─── computeInfrastructureMetrics ─────────────────────────────────────────────

describe('computeInfrastructureMetrics', () => {
  test('caching_effectiveness is hit rate when Redis activity exists', () => {
    const redis = { hits: 3, misses: 1, evictions: 0 };
    const pg = { total_queries: 0, slow_queries: 0, indexed_data_queries: 0, total_data_queries: 0 };

    const metrics = computeInfrastructureMetrics(redis, pg);
    expect(metrics.caching_effectiveness.score).toBe(0.75);
  });

  test('caching_effectiveness is 0 when no Redis requests were made', () => {
    const redis = { hits: 0, misses: 0, evictions: 0 };
    const pg = { total_queries: 0, slow_queries: 0, indexed_data_queries: 0, total_data_queries: 0 };

    expect(computeInfrastructureMetrics(redis, pg).caching_effectiveness.score).toBe(0);
  });

  test('error_handling_coverage is 1 when there are no slow queries', () => {
    const redis = { hits: 0, misses: 0, evictions: 0 };
    const pg = { total_queries: 5, slow_queries: 0, indexed_data_queries: 5, total_data_queries: 5 };

    expect(computeInfrastructureMetrics(redis, pg).error_handling_coverage.score).toBe(1);
  });

  test('error_handling_coverage decreases proportionally with slow queries', () => {
    const redis = { hits: 0, misses: 0, evictions: 0 };
    const pg = { total_queries: 4, slow_queries: 2, indexed_data_queries: 2, total_data_queries: 4 };

    expect(computeInfrastructureMetrics(redis, pg).error_handling_coverage.score).toBe(0.5);
  });

  test('scaling_awareness reflects index usage rate', () => {
    const redis = { hits: 0, misses: 0, evictions: 0 };
    const pg = { total_queries: 4, slow_queries: 0, indexed_data_queries: 3, total_data_queries: 4 };

    expect(computeInfrastructureMetrics(redis, pg).scaling_awareness.score).toBe(0.75);
  });

  test('all scores are 1 when there is no Postgres data and no Redis misses', () => {
    const redis = { hits: 10, misses: 0, evictions: 0 };
    const pg = { total_queries: 0, slow_queries: 0, indexed_data_queries: 0, total_data_queries: 0 };

    const metrics = computeInfrastructureMetrics(redis, pg);
    expect(metrics.caching_effectiveness.score).toBe(1);
    expect(metrics.error_handling_coverage.score).toBe(1);
    expect(metrics.scaling_awareness.score).toBe(1);
  });

  test('all scores are clamped to [0, 1]', () => {
    const redis = { hits: 0, misses: 100, evictions: 50 };
    const pg = { total_queries: 10, slow_queries: 10, indexed_data_queries: 0, total_data_queries: 10 };

    const metrics = computeInfrastructureMetrics(redis, pg);
    for (const m of Object.values(metrics) as InfrastructureMetricScore[]) {
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(1);
    }
  });
});

// ─── truncateHistory ──────────────────────────────────────────────────────────

describe('truncateHistory', () => {
  test('returns all active messages when count is below the limit', () => {
    const messages = [
      makeMessage(1, 'user', 'a'),
      makeMessage(2, 'assistant', 'b'),
    ];
    expect(truncateHistory(messages, 10)).toHaveLength(2);
  });

  test('excludes rewound messages', () => {
    const messages = [
      makeMessage(1, 'user', 'rewound', 9999),
      makeMessage(2, 'user', 'active'),
    ];
    const result = truncateHistory(messages, 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('active');
  });

  test('keeps only the last N active messages when limit is exceeded', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage(i + 1, i % 2 === 0 ? 'user' : 'assistant', `msg-${i + 1}`),
    );

    const result = truncateHistory(messages, 4);
    expect(result).toHaveLength(4);
    expect(result[0]?.content).toBe('msg-7');
    expect(result[3]?.content).toBe('msg-10');
  });

  test('returns empty array when all messages are rewound', () => {
    const messages = [
      makeMessage(1, 'user', 'rewound', 1000),
      makeMessage(2, 'assistant', 'rewound', 1000),
    ];
    expect(truncateHistory(messages, 10)).toHaveLength(0);
  });
});

// ─── computeSessionAnalysisScore ──────────────────────────────────────────────

describe('computeSessionAnalysisScore', () => {
  test('averages infrastructure, llm dimensions, acceptance criteria, and rubric questions', () => {
    const result: EvaluationResult = {
      infrastructure: {
        caching_effectiveness: { name: 'caching_effectiveness', label: 'Caching', score: 0.5, details: '' },
        error_handling_coverage: { name: 'error_handling_coverage', label: 'Errors', score: 0.75, details: '' },
        scaling_awareness: { name: 'scaling_awareness', label: 'Scaling', score: 1, details: '' },
      },
      llm_evaluation: {
        scores: [
          { dimension: 'prompt_quality', label: 'Prompt Quality', score: 8, rationale: '' },
          { dimension: 'technical_direction', label: 'Technical Direction', score: 6, rationale: '' },
        ],
        overall_summary: 'Strong session.',
        acceptance_criteria_results: [
          { criterion: 'criterion-1', score: 90, rationale: '' },
          { criterion: 'criterion-2', score: 70, rationale: '' },
        ],
        rubric_scores: [
          { question: 'question-1', score: 5, rationale: '', is_default: true },
        ],
      },
      iterations: [],
    };

    const expected = (0.5 + 0.75 + 1 + 0.8 + 0.6 + 0.9 + 0.7 + 0.5) / 8;
    expect(computeSessionAnalysisScore(result)).toBeCloseTo(expected, 5);
  });

  test('falls back to available analysis dimensions when optional groups are absent', () => {
    const result: EvaluationResult = {
      infrastructure: {
        caching_effectiveness: { name: 'caching_effectiveness', label: 'Caching', score: 0.2, details: '' },
        error_handling_coverage: { name: 'error_handling_coverage', label: 'Errors', score: 0.4, details: '' },
        scaling_awareness: { name: 'scaling_awareness', label: 'Scaling', score: 0.6, details: '' },
      },
      llm_evaluation: {
        scores: [
          { dimension: 'prompt_quality', label: 'Prompt Quality', score: 7, rationale: '' },
        ],
        overall_summary: 'Summary.',
      },
      iterations: [],
    };

    expect(computeSessionAnalysisScore(result)).toBeCloseTo((0.2 + 0.4 + 0.6 + 0.7) / 4, 5);
  });
});
