import { describe, expect, test } from 'vitest';
import type { Message, ReplayEvent, Session } from './types.js';
import {
  computeIndependenceRatio,
  computeIterationEfficiency,
  computeRecoveryScore,
  computeSessionMetrics,
  computeTokenEfficiency,
} from './metrics.js';

const baseSession: Pick<Session, 'tokens_used' | 'interactions_used' | 'score' | 'constraint'> = {
  tokens_used: 400,
  interactions_used: 2,
  score: 0.8,
  constraint: {
    max_session_tokens: 1000,
    max_message_tokens: 500,
    max_interactions: 10,
    context_window: 8000,
    time_limit_minutes: 60,
  },
};

function userMessage(content: string): Message {
  return { role: 'user', content };
}

function assistantMessage(content: string): Message {
  return { role: 'assistant', content };
}

function replayEvent(type: ReplayEvent['type'], payload: unknown): ReplayEvent {
  return { type, payload, timestamp: Date.now() };
}

describe('metrics', () => {
  test('computes iteration efficiency from productive interactions over total interactions', () => {
    const events: ReplayEvent[] = [
      replayEvent('message', { role: 'user', content: 'first' }),
      replayEvent('agent_response', { content: 'done', stop_reason: 'end_turn' }),
      replayEvent('message', { role: 'user', content: 'second' }),
      replayEvent('agent_response', { content: '', stop_reason: 'max_tokens' }),
    ];

    const metric = computeIterationEfficiency({
      session: { ...baseSession, interactions_used: 2 },
      recording: { events },
    });

    expect(metric.score).toBe(0.5);
    expect(metric.details).toContain('1/2');
  });

  test('falls back to messages when replay windows are unavailable', () => {
    const metric = computeIterationEfficiency({
      messages: [userMessage('a'), assistantMessage('ok'), userMessage('b')],
    });

    expect(metric.score).toBe(0.5);
  });

  test('computes token efficiency from correctness score and normalized token usage', () => {
    const metric = computeTokenEfficiency({
      session: baseSession,
    });

    expect(metric.score).toBe(1);
    expect(metric.details).toContain('tokens=400');
  });

  test('uses explicit correctnessScore override for token efficiency', () => {
    const metric = computeTokenEfficiency({
      session: { ...baseSession, score: 0.1, tokens_used: 800 },
      correctnessScore: 0.4,
    });

    expect(metric.score).toBe(0.5);
  });

  test('computes independence ratio from manual code diffs and final files', () => {
    const metric = computeIndependenceRatio({
      recording: {
        events: [
          replayEvent('code_change', {
            file_path: 'src/index.ts',
            diff: '@@ -1,1 +1,3 @@\n+const a = 1;\n+const b = 2;',
          }),
        ],
      },
      finalFiles: {
        'src/index.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;',
      },
    });

    expect(metric.score).toBe(0.5);
    expect(metric.details).toContain('2/4');
  });

  test('falls back to latest agent write snapshots when final files are unavailable', () => {
    const metric = computeIndependenceRatio({
      recording: {
        events: [
          replayEvent('tool_call', {
            tool_calls: [
              {
                id: 'call-1',
                name: 'write_file',
                input: {
                  path: 'src/index.ts',
                  content: 'line 1\nline 2\nline 3',
                },
              },
            ],
          }),
          replayEvent('code_change', {
            file_path: 'src/index.ts',
            diff: '@@ -1,1 +1,2 @@\n+line 4',
          }),
        ],
      },
    });

    expect(metric.score).toBeCloseTo(1 / 3, 5);
  });

  test('computes recovery score from recovered agent errors', () => {
    const metric = computeRecoveryScore({
      recording: {
        events: [
          replayEvent('tool_result', {
            tool_results: [{ tool_call_id: '1', name: 'run_command', output: 'fail', is_error: true }],
          }),
          replayEvent('tool_result', {
            tool_results: [{ tool_call_id: '2', name: 'run_command', output: 'pass', is_error: false }],
          }),
          replayEvent('agent_response', {
            content: 'Fixed it',
            stop_reason: 'end_turn',
          }),
        ],
      },
    });

    expect(metric.score).toBe(1);
  });

  test('counts unrecovered errors against recovery score', () => {
    const metric = computeRecoveryScore({
      recording: {
        events: [
          replayEvent('tool_result', {
            tool_results: [{ tool_call_id: '1', name: 'run_command', output: 'fail', is_error: true }],
          }),
          replayEvent('tool_result', {
            tool_results: [{ tool_call_id: '2', name: 'read_file', output: 'ok', is_error: false }],
          }),
        ],
      },
    });

    expect(metric.score).toBe(0);
  });

  test('returns a normalized metrics bundle for the full session', () => {
    const metrics = computeSessionMetrics({
      session: baseSession,
      messages: [userMessage('a'), assistantMessage('done')],
      recording: {
        events: [
          replayEvent('message', { role: 'user', content: 'a' }),
          replayEvent('agent_response', { content: 'done', stop_reason: 'end_turn' }),
          replayEvent('code_change', {
            file_path: 'src/index.ts',
            diff: '@@ -0,0 +1 @@\n+const answer = 42;',
          }),
        ],
      },
      finalFiles: { 'src/index.ts': 'const answer = 42;' },
    });

    expect(metrics.map((metric) => metric.name)).toEqual([
      'iteration_efficiency',
      'token_efficiency',
      'independence_ratio',
      'recovery_score',
    ]);
    expect(metrics.every((metric) => metric.score >= 0 && metric.score <= 1)).toBe(true);
  });
});
