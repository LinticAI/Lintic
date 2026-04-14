import { describe, test, expect, vi, beforeEach } from 'vitest';
import { runAgentLoop } from './agent-loop.js';
import type { AgentAdapter, AgentConfig, AgentCapabilities, AgentResponse, SessionContext, ToolCall, ToolDefinition, TokenUsage } from '@lintic/core';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_CONTEXT: SessionContext = {
  session_id: 'sess-1',
  history: [],
  constraints_remaining: { tokens_remaining: 10000, interactions_remaining: 20, seconds_remaining: 3600 },
};

function usage(n: number): TokenUsage {
  return { prompt_tokens: n, completion_tokens: n, total_tokens: n * 2 };
}

function endTurnResponse(content: string, u = usage(10), thinking?: string): AgentResponse {
  return { content, usage: u, stop_reason: 'end_turn', ...(thinking !== undefined ? { thinking } : {}) };
}

function toolUseResponse(calls: ToolCall[], u = usage(10), content: string | null = null, thinking?: string): AgentResponse {
  return {
    content,
    tool_calls: calls,
    usage: u,
    stop_reason: 'tool_use',
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

function toolCall(id: string, name: ToolCall['name'] = 'read_file'): ToolCall {
  return { id, name, input: { path: `/file-${id}.ts` } };
}

// ─── Fake Adapter ─────────────────────────────────────────────────────────────

class FakeAdapter implements AgentAdapter {
  responses: AgentResponse[] = [];

  init(_cfg: AgentConfig): Promise<void> { return Promise.resolve(); }

  sendMessage(_msg: string | null, _ctx: SessionContext): Promise<AgentResponse> {
    const next = this.responses.shift();
    if (!next) throw new Error('FakeAdapter: no more responses queued');
    return Promise.resolve(next);
  }

  getTokenUsage(): TokenUsage { return usage(0); }
  getCapabilities(): AgentCapabilities { return { supports_system_prompt: true, supports_tool_use: true, max_context_window: 8000 }; }
  getTools(): ToolDefinition[] { return []; }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runAgentLoop', () => {
  let adapter: FakeAdapter;
  const noopRunner = vi.fn().mockResolvedValue([]);

  beforeEach(() => {
    adapter = new FakeAdapter();
    vi.clearAllMocks();
    noopRunner.mockResolvedValue([]);
  });

  test('returns content immediately when first response has no tool calls', async () => {
    adapter.responses = [endTurnResponse('Hello!')];
    const result = await runAgentLoop('hi', BASE_CONTEXT, adapter, noopRunner);

    expect(result.content).toBe('Hello!');
    expect(result.stop_reason).toBe('end_turn');
    expect(result.tool_actions).toHaveLength(0);
    expect(noopRunner).not.toHaveBeenCalled();
  });

  test('executes a single tool iteration and returns final content', async () => {
    const call = toolCall('tc-1');
    const toolResult = { tool_call_id: 'tc-1', name: 'read_file' as const, output: 'content', is_error: false };

    adapter.responses = [
      toolUseResponse([call], usage(10), 'Reading the file first.', 'Need to inspect the file.'),
      endTurnResponse('Done after reading'),
    ];
    noopRunner.mockResolvedValueOnce([toolResult]);

    const result = await runAgentLoop('read a file', BASE_CONTEXT, adapter, noopRunner);

    expect(result.content).toBe('Done after reading');
    expect(result.stop_reason).toBe('end_turn');
    expect(result.tool_actions).toHaveLength(1);
    expect(result.tool_actions[0]!.description).toBe('Reading the file first.');
    expect(result.tool_actions[0]!.thinking).toBe('Need to inspect the file.');
    expect(result.tool_actions[0]!.tool_calls).toEqual([call]);
    expect(result.tool_actions[0]!.tool_results).toEqual([toolResult]);
    expect(noopRunner).toHaveBeenCalledTimes(1);
    expect(noopRunner).toHaveBeenCalledWith([call], 'Reading the file first.', 'Need to inspect the file.');
  });

  test('chains three tool iterations before end_turn', async () => {
    adapter.responses = [
      toolUseResponse([toolCall('a')]),
      toolUseResponse([toolCall('b')]),
      toolUseResponse([toolCall('c')]),
      endTurnResponse('All done'),
    ];
    noopRunner.mockResolvedValue([]);

    const result = await runAgentLoop('chain test', BASE_CONTEXT, adapter, noopRunner);

    expect(result.content).toBe('All done');
    expect(result.tool_actions).toHaveLength(3);
    expect(noopRunner).toHaveBeenCalledTimes(3);
  });

  test('stops at tool_limit when total calls would exceed 10', async () => {
    // First LLM call returns 5 tool calls, then 6 more — total 11 > 10.
    const fiveCalls = Array.from({ length: 5 }, (_, i) => toolCall(`a${i}`));
    const sixCalls = Array.from({ length: 6 }, (_, i) => toolCall(`b${i}`));

    adapter.responses = [
      toolUseResponse(fiveCalls),
      toolUseResponse(sixCalls),  // would push total to 11
    ];
    noopRunner.mockResolvedValue([]);

    const result = await runAgentLoop('limit test', BASE_CONTEXT, adapter, noopRunner);

    expect(result.stop_reason).toBe('tool_limit');
    expect(result.content).toBeNull();
    // Only the first batch was executed before the limit was checked.
    expect(noopRunner).toHaveBeenCalledTimes(1);
    expect(result.tool_actions).toHaveLength(1);
  });

  test('allows exactly 10 tool calls across iterations', async () => {
    // 3 + 3 + 4 = 10, then end_turn.
    adapter.responses = [
      toolUseResponse(Array.from({ length: 3 }, (_, i) => toolCall(`a${i}`))),
      toolUseResponse(Array.from({ length: 3 }, (_, i) => toolCall(`b${i}`))),
      toolUseResponse(Array.from({ length: 4 }, (_, i) => toolCall(`c${i}`))),
      endTurnResponse('10 calls done'),
    ];
    noopRunner.mockResolvedValue([]);

    const result = await runAgentLoop('exact limit', BASE_CONTEXT, adapter, noopRunner);

    expect(result.stop_reason).toBe('end_turn');
    expect(noopRunner).toHaveBeenCalledTimes(3);
  });

  test('accumulates token usage across all LLM calls', async () => {
    adapter.responses = [
      toolUseResponse([toolCall('x')], usage(5)),
      toolUseResponse([toolCall('y')], usage(7)),
      endTurnResponse('ok', usage(3)),
    ];
    noopRunner.mockResolvedValue([]);

    const result = await runAgentLoop('token test', BASE_CONTEXT, adapter, noopRunner);

    // prompt and completion each: 5 + 7 + 3 = 15; total_tokens: 10 + 14 + 6 = 30
    expect(result.total_usage.prompt_tokens).toBe(15);
    expect(result.total_usage.completion_tokens).toBe(15);
    expect(result.total_usage.total_tokens).toBe(30);
  });

  test('passes tool error results back to LLM and continues loop', async () => {
    const call = toolCall('err-1');
    const errResult = { tool_call_id: 'err-1', name: 'run_command' as const, output: 'command failed', is_error: true };

    adapter.responses = [
      toolUseResponse([call]),
      endTurnResponse('I see the error, let me fix it'),
    ];
    noopRunner.mockResolvedValueOnce([errResult]);

    const result = await runAgentLoop('run command', BASE_CONTEXT, adapter, noopRunner);

    expect(result.stop_reason).toBe('end_turn');
    expect(result.tool_actions[0]!.tool_results[0]!.is_error).toBe(true);
    expect(result.content).toContain('fix');
  });

  test('stops immediately when first response has max_tokens stop reason', async () => {
    adapter.responses = [{ content: 'truncated', usage: usage(10), stop_reason: 'max_tokens' }];

    const result = await runAgentLoop('long request', BASE_CONTEXT, adapter, noopRunner);

    expect(result.stop_reason).toBe('max_tokens');
    expect(result.content).toBe('truncated');
    expect(result.tool_actions).toHaveLength(0);
    expect(noopRunner).not.toHaveBeenCalled();
  });

  test('returns final thinking when the adapter provides it', async () => {
    adapter.responses = [endTurnResponse('Hello!', usage(10), 'Reasoning summary')];

    const result = await runAgentLoop('hi', BASE_CONTEXT, adapter, noopRunner);

    expect(result.content).toBe('Hello!');
    expect(result.thinking).toBe('Reasoning summary');
  });

  test('passes updated history to continuation calls', async () => {
    const sendSpy = vi.spyOn(adapter, 'sendMessage');
    const call = toolCall('spy-1');

    adapter.responses = [
      toolUseResponse([call]),
      endTurnResponse('done'),
    ];
    noopRunner.mockResolvedValue([]);

    await runAgentLoop('spy test', BASE_CONTEXT, adapter, noopRunner);

    // First call gets the original message and base context.
    expect(sendSpy).toHaveBeenNthCalledWith(1, 'spy test', BASE_CONTEXT);
    // Continuation call gets null message and updated history.
    const [secondMsg, secondCtx] = sendSpy.mock.calls[1]! as [string | null, SessionContext];
    expect(secondMsg).toBeNull();
    expect(secondCtx.history.some(m => m.role === 'user')).toBe(true);
    expect(secondCtx.history.some(m => m.role === 'assistant')).toBe(true);
    expect(secondCtx.history.some(m => m.role === 'tool')).toBe(true);
  });
});
