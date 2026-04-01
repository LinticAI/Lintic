import type { AgentAdapter, AgentResponse, Message, SessionContext, ToolCall, ToolResult, TokenUsage } from '@lintic/core';

export type ToolRunner = (calls: ToolCall[]) => Promise<ToolResult[]>;

export type LoopEvent =
  | { type: 'tool_action'; data: ToolAction }
  | { type: 'done'; data: AgentLoopResult };

export interface ToolAction {
  tool_calls: ToolCall[];
  tool_results: ToolResult[];
}

export type AgentLoopStopReason = 'end_turn' | 'max_tokens' | 'tool_limit';

export interface AgentLoopResult {
  content: string | null;
  tool_actions: ToolAction[];
  total_usage: TokenUsage;
  stop_reason: AgentLoopStopReason;
}

const MAX_TOOL_CALLS = 10;

function addUsage(acc: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    prompt_tokens: acc.prompt_tokens + next.prompt_tokens,
    completion_tokens: acc.completion_tokens + next.completion_tokens,
    total_tokens: acc.total_tokens + next.total_tokens,
  };
}

export async function runAgentLoop(
  message: string,
  context: SessionContext,
  adapter: AgentAdapter,
  toolRunner: ToolRunner,
  onEvent?: (event: LoopEvent) => void,
): Promise<AgentLoopResult> {
  const tool_actions: ToolAction[] = [];
  let total_usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let toolCallsUsed = 0;

  // In-memory history for continuation calls — starts as a copy of the provided history.
  const history: Message[] = [...context.history];
  let userMessageAddedToHistory = false;

  // First LLM call — passes the user message normally.
  let response: AgentResponse = await adapter.sendMessage(message, context);
  total_usage = addUsage(total_usage, response.usage);

  while (
    response.stop_reason === 'tool_use' &&
    response.tool_calls &&
    response.tool_calls.length > 0
  ) {
    const calls = response.tool_calls;

    // Enforce the per-candidate-message tool call limit.
    if (toolCallsUsed + calls.length > MAX_TOOL_CALLS) {
      const limitResult: AgentLoopResult = {
        content: null,
        tool_actions,
        total_usage,
        stop_reason: 'tool_limit',
      };
      onEvent?.({ type: 'done', data: limitResult });
      return limitResult;
    }
    toolCallsUsed += calls.length;

    // Execute tools via the injected runner.
    const results = await toolRunner(calls);
    tool_actions.push({ tool_calls: calls, tool_results: results });
    onEvent?.({ type: 'tool_action', data: { tool_calls: calls, tool_results: results } });

    // Build the continuation history.
    // On the first iteration the user message hasn't been added yet.
    if (!userMessageAddedToHistory) {
      history.push({ role: 'user', content: message });
      userMessageAddedToHistory = true;
    }
    history.push({ role: 'assistant', content: response.content, tool_calls: calls });
    history.push({ role: 'tool', content: null, tool_results: results });

    // Continuation call — history already ends with tool results; pass null message.
    response = await adapter.sendMessage(null, { ...context, history });
    total_usage = addUsage(total_usage, response.usage);
  }

  const result: AgentLoopResult = {
    content: response.content,
    tool_actions,
    total_usage,
    stop_reason: response.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn',
  };
  onEvent?.({ type: 'done', data: result });
  return result;
}
