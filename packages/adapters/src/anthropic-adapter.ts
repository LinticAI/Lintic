import type {
  AgentAdapter,
  AgentCapabilities,
  AgentConfig,
  AgentResponse,
  Message,
  SessionContext,
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

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

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

    const messages: AnthropicMessage[] = [...context.history.map(toAnthropicMessage)];
    if (msg !== null) messages.push({ role: 'user', content: msg });

    const MAX_OUTPUT_TOKENS = 4096;
    const requestBody = {
      model: this.config.model,
      max_tokens: Math.min(context.constraints_remaining.tokens_remaining, MAX_OUTPUT_TOKENS),
      messages,
      tools: toAnthropicTools(TOOLS),
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.api_key,
          'anthropic-version': '2023-06-01',
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

    const textBlock = data.content.find((b): b is AnthropicTextBlock => b.type === 'text');
    const toolUseBlocks = data.content.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');

    const toolCalls: ToolCall[] = toolUseBlocks.map(b => ({
      id: b.id,
      name: b.name as ToolName,
      input: b.input,
    }));

    const agentResponse: AgentResponse = {
      content: textBlock?.text ?? null,
      usage: this.lastUsage,
      stop_reason: mapStopReason(data.stop_reason),
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
    if (msg.content) {
      blocks.push({ type: 'text', text: msg.content });
    }
    for (const tc of msg.tool_calls) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    return { role: 'assistant', content: blocks };
  }

  return {
    role: msg.role as 'user' | 'assistant',
    content: msg.content ?? '',
  };
}

function mapStopReason(reason: string): AgentResponse['stop_reason'] {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}
