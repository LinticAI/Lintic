import { describe, test, expect, vi, beforeEach } from 'vitest';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { AdapterError } from './openai-adapter.js';
import type { AgentConfig, SessionContext } from '@lintic/core';

const VALID_CONFIG: AgentConfig = {
  provider: 'anthropic-native',
  api_key: 'sk-ant-test',
  model: 'claude-3-5-sonnet-20241022',
};

function makeContext(overrides?: Partial<SessionContext>): SessionContext {
  return {
    session_id: 'test-session',
    history: [],
    constraints_remaining: {
      tokens_remaining: 4096,
      interactions_remaining: 10,
      seconds_remaining: 3600,
    },
    ...overrides,
  };
}

function makeTextResponse(text: string, stopReason = 'end_turn') {
  return {
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function makeToolUseResponse(id: string, name: string, input: Record<string, unknown>) {
  return {
    content: [
      { type: 'text', text: 'I will use a tool.' },
      { type: 'tool_use', id, name, input },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 20, output_tokens: 10 },
  };
}

describe('AnthropicAdapter', () => {
  let adapter: AnthropicAdapter;

  beforeEach(() => {
    adapter = new AnthropicAdapter();
    vi.restoreAllMocks();
  });

  // ── init ──────────────────────────────────────────────────────────────────

  describe('init', () => {
    test('succeeds with valid config', async () => {
      await expect(adapter.init(VALID_CONFIG)).resolves.toBeUndefined();
    });

    test('throws AdapterError when api_key is empty', async () => {
      await expect(
        adapter.init({ ...VALID_CONFIG, api_key: '' }),
      ).rejects.toMatchObject({ code: 'missing_api_key' });
    });

    test('throws an instance of AdapterError', async () => {
      await expect(
        adapter.init({ ...VALID_CONFIG, api_key: '' }),
      ).rejects.toBeInstanceOf(AdapterError);
    });
  });

  // ── sendMessage ───────────────────────────────────────────────────────────

  describe('sendMessage', () => {
    beforeEach(async () => {
      await adapter.init(VALID_CONFIG);
    });

    test('POSTs to /v1/messages with correct URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeTextResponse('Hello!')),
      });
      vi.stubGlobal('fetch', fetchMock);

      await adapter.sendMessage('Hi', makeContext());

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
    });

    test('sends correct Anthropic headers', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeTextResponse('Hello!')),
      });
      vi.stubGlobal('fetch', fetchMock);

      await adapter.sendMessage('Hi', makeContext());

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['content-type']).toBe('application/json');
    });

    test('uses base_url override when provided', async () => {
      const custom = new AnthropicAdapter();
      await custom.init({ ...VALID_CONFIG, base_url: 'https://custom.anthropic.com' });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeTextResponse('Hi')),
      });
      vi.stubGlobal('fetch', fetchMock);

      await custom.sendMessage('Hi', makeContext());

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://custom.anthropic.com/v1/messages');
    });

    test('returns AgentResponse with text content', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeTextResponse('Hello!')),
      }));

      const response = await adapter.sendMessage('Hi', makeContext());

      expect(response.content).toBe('Hello!');
      expect(response.stop_reason).toBe('end_turn');
      expect(response.tool_calls).toBeUndefined();
    });

    test('maps stop_reason tool_use to tool_use', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(
          makeToolUseResponse('toolu_01', 'read_file', { path: 'src/index.ts' }),
        ),
      }));

      const response = await adapter.sendMessage('Read it', makeContext());

      expect(response.stop_reason).toBe('tool_use');
      expect(response.tool_calls).toHaveLength(1);
      expect(response.tool_calls![0]).toMatchObject({
        id: 'toolu_01',
        name: 'read_file',
        input: { path: 'src/index.ts' },
      });
    });

    test('maps stop_reason max_tokens to max_tokens', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeTextResponse('Truncated', 'max_tokens')),
      }));

      const response = await adapter.sendMessage('Hi', makeContext());

      expect(response.stop_reason).toBe('max_tokens');
    });

    test('does not include tool_calls field when response has none', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeTextResponse('Plain text')),
      }));

      const response = await adapter.sendMessage('Hi', makeContext());

      expect(Object.prototype.hasOwnProperty.call(response, 'tool_calls')).toBe(false);
    });

    test('throws AdapterError on non-ok HTTP response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: { type: 'invalid_request_error', message: 'Bad request' } }),
      }));

      await expect(adapter.sendMessage('Hi', makeContext())).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request_error',
      });
    });

    test('maps overloaded_error to code overloaded', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 529,
        json: () => Promise.resolve({ error: { type: 'overloaded_error', message: 'Overloaded' } }),
      }));

      await expect(adapter.sendMessage('Hi', makeContext())).rejects.toMatchObject({
        code: 'overloaded',
      });
    });

    test('maps rate_limit_error to code rate_limited', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: { type: 'rate_limit_error', message: 'Rate limited' } }),
      }));

      await expect(adapter.sendMessage('Hi', makeContext())).rejects.toMatchObject({
        code: 'rate_limited',
      });
    });

    test('throws AdapterError with network_error on fetch failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      await expect(adapter.sendMessage('Hi', makeContext())).rejects.toMatchObject({
        code: 'network_error',
      });
    });

    test('throws not_initialized when called before init()', async () => {
      const fresh = new AnthropicAdapter();
      await expect(fresh.sendMessage('Hi', makeContext())).rejects.toMatchObject({
        code: 'not_initialized',
      });
    });

    test('passes tokens_remaining as max_tokens in request body', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeTextResponse('OK')),
      });
      vi.stubGlobal('fetch', fetchMock);

      await adapter.sendMessage('Hi', makeContext({ constraints_remaining: { tokens_remaining: 512, interactions_remaining: 5, seconds_remaining: 100 } }));

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as { max_tokens: number };
      expect(body.max_tokens).toBe(512);
    });
  });

  // ── getTokenUsage ─────────────────────────────────────────────────────────

  describe('getTokenUsage', () => {
    test('returns zeros before any sendMessage call', async () => {
      await adapter.init(VALID_CONFIG);
      expect(adapter.getTokenUsage()).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      });
    });

    test('returns usage from last sendMessage call', async () => {
      await adapter.init(VALID_CONFIG);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeTextResponse('Hi')),
      }));

      await adapter.sendMessage('Hi', makeContext());

      // makeTextResponse uses input_tokens: 10, output_tokens: 5
      expect(adapter.getTokenUsage()).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
    });
  });

  // ── getCapabilities ───────────────────────────────────────────────────────

  describe('getCapabilities', () => {
    test('reports system prompt and tool use support', async () => {
      await adapter.init(VALID_CONFIG);
      const caps = adapter.getCapabilities();
      expect(caps.supports_system_prompt).toBe(true);
      expect(caps.supports_tool_use).toBe(true);
    });

    test('reports max_context_window of 200000', async () => {
      await adapter.init(VALID_CONFIG);
      expect(adapter.getCapabilities().max_context_window).toBe(200000);
    });
  });

  // ── getTools ──────────────────────────────────────────────────────────────

  describe('getTools', () => {
    test('returns all 5 tool definitions', async () => {
      await adapter.init(VALID_CONFIG);
      const tools = adapter.getTools();
      expect(tools).toHaveLength(5);
      const names = tools.map(t => t.name);
      expect(names).toContain('read_file');
      expect(names).toContain('write_file');
      expect(names).toContain('run_command');
      expect(names).toContain('list_directory');
      expect(names).toContain('search_files');
    });
  });
});
