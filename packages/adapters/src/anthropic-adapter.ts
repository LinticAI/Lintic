import type {
  AgentAdapter,
  AgentCapabilities,
  AgentConfig,
  AgentResponse,
  Message,
  SessionContext,
  ThinkingBlock,
  ToolCall,
  ToolDefinition,
  ToolName,
  TokenUsage,
} from '@lintic/core';
import { AdapterError } from './openai-adapter.js';
import { TOOLS, toAnthropicTools } from './tools.js';

// ─── Anthropic wire types ─────────────────────────────────────────────────────

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AnthropicErrorBody {
  error?: {
    type?: string;
    message?: string;
  };
}

// ─── AnthropicAdapter ─────────────────────────────────────────────────────────

export class AnthropicAdapter implements AgentAdapter {
  private config: AgentConfig | null = null;
  private baseUrl: string = 'https://api.anthropic.com';
  private lastUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  init(config: AgentConfig): Promise<void> {
    if (!config.api_key) {
      return Promise.reject(new AdapterError('AnthropicAdapter: api_key is required', 0, 'missing_api_key'));
    }
    this.config = config;
    this.baseUrl = (config.base_url ?? 'https://api.anthropic.com').replace(/\/$/, '');
    return Promise.resolve();
  }

  async sendMessage(msg: string | null, context: SessionContext): Promise<AgentResponse> {
    if (!this.config) {
      throw new AdapterError('AnthropicAdapter: call init() before sendMessage()', 0, 'not_initialized');
    }

    const systemMessages = context.history.filter(m => m.role === 'system');
    const otherMessages = context.history.filter(m => m.role !== 'system');

    const messages: AnthropicMessage[] = otherMessages.map(toAnthropicMessage);
    if (msg !== null) messages.push({ role: 'user', content: msg });

    const systemPrompt = systemMessages.map(m => m.content).filter(Boolean).join('\n\n');

    const MAX_OUTPUT_TOKENS = 4096;
    const maxTokens = Math.min(context.constraints_remaining.tokens_remaining, MAX_OUTPUT_TOKENS);
    const thinkingConfig = buildThinkingConfig(this.config.model, maxTokens);
    const requestBody = {
      model: this.config.model,
      max_tokens: maxTokens,
      messages,
      system: systemPrompt || undefined,
      tools: toAnthropicTools(TOOLS),
      ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.api_key,
          'anthropic-version': '2023-06-01',
          ...(thinkingConfig ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {}),
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      throw new AdapterError(
        `AnthropicAdapter: network error – ${err instanceof Error ? err.message : String(err)}`,
        0,
        'network_error',
      );
    }

    if (!response.ok) {
      let errMessage = `HTTP ${response.status}`;
      let errCode = String(response.status);
      try {
        const body = (await response.json()) as AnthropicErrorBody;
        if (body.error?.message) errMessage = body.error.message;
        if (body.error?.type) {
          errCode =
            body.error.type === 'overloaded_error' ? 'overloaded'
            : body.error.type === 'rate_limit_error' ? 'rate_limited'
            : body.error.type;
        }
      } catch {
        // ignore JSON parse failure
      }
      throw new AdapterError(errMessage, response.status, errCode);
    }

    const data = (await response.json()) as AnthropicResponse;

    if (!data.content || data.content.length === 0) {
      throw new AdapterError('AnthropicAdapter: empty content in response', 0, 'empty_response');
    }

    this.lastUsage = {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens,
    };

    const textBlocks = data.content.filter((b): b is AnthropicTextBlock => b.type === 'text');
    const thinkingBlocks = data.content.filter(isAnthropicThinkingBlock);
    const toolUseBlocks = data.content.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');

    const toolCalls: ToolCall[] = toolUseBlocks.map(b => ({
      id: b.id,
      name: b.name as ToolName,
      input: b.input,
    }));
    const thinking = thinkingBlocks
      .map((block) => block.type === 'thinking' ? block.thinking : '')
      .filter(Boolean)
      .join('\n\n') || null;

    const agentResponse: AgentResponse = {
      content: textBlocks.map((block) => block.text).join('\n\n') || null,
      usage: this.lastUsage,
      stop_reason: mapStopReason(data.stop_reason),
      ...(thinking ? { thinking } : {}),
      ...(thinkingBlocks.length > 0 ? { thinking_blocks: thinkingBlocks.map(toThinkingBlock) } : {}),
    };
    if (toolCalls.length > 0) {
      agentResponse.tool_calls = toolCalls;
    }
    return agentResponse;
  }

  getTokenUsage(): TokenUsage {
    return { ...this.lastUsage };
  }

  getCapabilities(): AgentCapabilities {
    return {
      supports_system_prompt: true,
      supports_tool_use: true,
      max_context_window: 200000,
    };
  }

  getTools(): ToolDefinition[] {
    return TOOLS;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toAnthropicMessage(msg: Message): AnthropicMessage {
  if (msg.role === 'tool') {
    const results = msg.tool_results ?? [];
    return {
      role: 'user',
      content: results.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.tool_call_id,
        content: r.output,
      })),
    };
  }

  if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
    const blocks: AnthropicContentBlock[] = [];
    if (msg.thinking_blocks?.length) {
      blocks.push(...msg.thinking_blocks.map(fromThinkingBlock));
    }
    if (msg.content) {
      blocks.push({ type: 'text', text: msg.content });
    }
    for (const tc of msg.tool_calls) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    return { role: 'assistant', content: blocks };
  }

  return {
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content: msg.content ?? '',
  };
}

function mapStopReason(reason: string): AgentResponse['stop_reason'] {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

function supportsAnthropicThinking(model: string): boolean {
  return /mythos|claude-.*(?:3-7|4)/i.test(model);
}

function buildThinkingConfig(model: string, maxTokens: number):
  | { type: 'enabled'; budget_tokens: number; display: 'summarized' }
  | undefined {
  if (!supportsAnthropicThinking(model) || maxTokens < 1025) {
    return undefined;
  }

  const budgetTokens = Math.min(2048, maxTokens - 1);
  if (budgetTokens < 1024) {
    return undefined;
  }

  return {
    type: 'enabled',
    budget_tokens: budgetTokens,
    display: 'summarized',
  };
}

function isAnthropicThinkingBlock(
  block: AnthropicContentBlock,
): block is AnthropicThinkingBlock | AnthropicRedactedThinkingBlock {
  return block.type === 'thinking' || block.type === 'redacted_thinking';
}

function toThinkingBlock(block: AnthropicThinkingBlock | AnthropicRedactedThinkingBlock): ThinkingBlock {
  if (block.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: block.thinking,
      signature: block.signature,
    };
  }

  return {
    type: 'redacted_thinking',
    data: block.data,
  };
}

function fromThinkingBlock(block: ThinkingBlock): AnthropicThinkingBlock | AnthropicRedactedThinkingBlock {
  if (block.type === 'redacted_thinking') {
    return {
      type: 'redacted_thinking',
      data: block.data ?? '',
    };
  }

  return {
    type: 'thinking',
    thinking: block.thinking ?? '',
    signature: block.signature ?? '',
  };
}
