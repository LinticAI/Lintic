import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { SessionContext } from '@lintic/core';
import { OpenAIAdapter, AdapterError } from './openai-adapter.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContext(tokensRemaining = 500): SessionContext {
  return {
    session_id: 'test-session',
    history: [],
    constraints_remaining: {
      tokens_remaining: tokensRemaining,
      interactions_remaining: 10,
      seconds_remaining: 3600,
    },
  };
}

function makeSuccessResponse(overrides?: {
  content?: string | null;
  finish_reason?: string;
  tool_calls?: Array<{ id: string; name: string; args: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}) {
  const usage = overrides?.usage ?? { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 };
  const message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  } = {
    role: 'assistant',
    content: overrides?.content ?? 'Hello!',
  };
  if (overrides?.tool_calls) {
    message.tool_calls = overrides.tool_calls.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args },
    }));
  }
  return {
    choices: [{ finish_reason: overrides?.finish_reason ?? 'stop', message }],
    usage,
  };
}

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('init', () => {
  test('succeeds with valid config', async () => {
    const adapter = new OpenAIAdapter();
    await expect(
      adapter.init({ provider: 'openai-compatible', api_key: 'sk-test', model: 'gpt-4o' }),
    ).resolves.toBeUndefined();
  });

  test('throws AdapterError when api_key is missing', async () => {
    const adapter = new OpenAIAdapter();
    await expect(
      adapter.init({ provider: 'openai-compatible', api_key: '', model: 'gpt-4o' }),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  test('uses https://api.openai.com as default base_url', async () => {
    const adapter = new OpenAIAdapter();
    await adapter.init({ provider: 'openai-compatible', api_key: 'sk-test', model: 'gpt-4o' });
    vi.stubGlobal('fetch', mockFetch(makeSuccessResponse()));
    await adapter.sendMessage('hi', makeContext());
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    vi.unstubAllGlobals();
  });

  test('uses Groq OpenAI-compatible base_url for provider groq by default', async () => {
    const adapter = new OpenAIAdapter();
    await adapter.init({ provider: 'groq', api_key: 'gsk-test', model: 'llama-3.3-70b-versatile' });
    vi.stubGlobal('fetch', mockFetch(makeSuccessResponse()));
    await adapter.sendMessage('hi', makeContext());
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://api.groq.com/openai/v1/chat/completions',
    );
    vi.unstubAllGlobals();
  });

  test('uses Cerebras OpenAI-compatible base_url for provider cerebras by default', async () => {
    const adapter = new OpenAIAdapter();
    await adapter.init({ provider: 'cerebras', api_key: 'csk-test', model: 'llama3.1-8b' });
    vi.stubGlobal('fetch', mockFetch(makeSuccessResponse()));
    await adapter.sendMessage('hi', makeContext());
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://api.cerebras.ai/v1/chat/completions',
    );
    vi.unstubAllGlobals();
  });

  test('uses localhost base_url for provider local-openai by default', async () => {
    const adapter = new OpenAIAdapter();
    await adapter.init({ provider: 'local-openai', api_key: '', model: 'qwen2.5-coder' });
    vi.stubGlobal('fetch', mockFetch(makeSuccessResponse()));
    await adapter.sendMessage('hi', makeContext());
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'http://localhost:8080/v1/chat/completions',
    );
    vi.unstubAllGlobals();
  });
});

describe('sendMessage', () => {
  let adapter: OpenAIAdapter;

  beforeEach(async () => {
    adapter = new OpenAIAdapter();
    await adapter.init({
      provider: 'openai-compatible',
      base_url: 'https://api.example.com',
      api_key: 'sk-test',
      model: 'gpt-4o',
    });
  });

  test('POSTs to /v1/chat/completions and returns AgentResponse', async () => {
    vi.stubGlobal('fetch', mockFetch(makeSuccessResponse({ content: 'Hi there' })));

    const response = await adapter.sendMessage('hello', makeContext());

    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://api.example.com/v1/chat/completions',
    );
    expect(response.content).toBe('Hi there');
    expect(response.stop_reason).toBe('end_turn');
    expect(response.usage.prompt_tokens).toBe(20);
    expect(response.usage.completion_tokens).toBe(30);
    vi.unstubAllGlobals();
  });

  test('does not duplicate /v1 when base_url already includes it', async () => {
    const custom = new OpenAIAdapter();
    await custom.init({
      provider: 'openai-compatible',
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-test',
      model: 'gpt-4o',
    });
    vi.stubGlobal('fetch', mockFetch(makeSuccessResponse({ content: 'Hi there' })));

    await custom.sendMessage('hello', makeContext());

    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://api.example.com/v1/chat/completions',
    );
    vi.unstubAllGlobals();
  });

  test('respects tokens_remaining as max_tokens in request body', async () => {
    vi.stubGlobal('fetch', mockFetch(makeSuccessResponse()));

    await adapter.sendMessage('hello', makeContext(123));

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call?.[1] as { body: string }).body) as {
      max_tokens: number;
      tool_choice: string;
      tools: unknown[];
    };
    expect(body.max_tokens).toBe(123);
    expect(body.tool_choice).toBe('auto');
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  test('maps finish_reason=tool_calls to stop_reason=tool_use', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(
        makeSuccessResponse({
          content: null,
          finish_reason: 'tool_calls',
          tool_calls: [{ id: 'call_1', name: 'read_file', args: '{"path":"/foo.ts"}' }],
        }),
      ),
    );

    const response = await adapter.sendMessage('read it', makeContext());

    expect(response.stop_reason).toBe('tool_use');
    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls?.[0]?.name).toBe('read_file');
    expect(response.tool_calls?.[0]?.input).toEqual({ path: '/foo.ts' });
    vi.unstubAllGlobals();
  });

  test('maps finish_reason=length to stop_reason=max_tokens', async () => {
    vi.stubGlobal('fetch', mockFetch(makeSuccessResponse({ finish_reason: 'length' })));

    const response = await adapter.sendMessage('go', makeContext());

    expect(response.stop_reason).toBe('max_tokens');
    vi.unstubAllGlobals();
  });

  test('does not include tool_calls field when response has none', async () => {
    vi.stubGlobal('fetch', mockFetch(makeSuccessResponse({ content: 'done' })));

    const response = await adapter.sendMessage('hi', makeContext());

    expect(response.tool_calls).toBeUndefined();
    vi.unstubAllGlobals();
  });

  test('converts tool-role history messages correctly', async () => {
    vi.stubGlobal('fetch', mockFetch(makeSuccessResponse()));

    const ctx: SessionContext = {
      session_id: 's',
      history: [
        {
          role: 'tool',
          content: null,
          tool_results: [
            {
              tool_call_id: 'call_abc',
              name: 'read_file',
              output: 'file contents',
              is_error: false,
            },
          ],
        },
      ],
      constraints_remaining: { tokens_remaining: 100, interactions_remaining: 5, seconds_remaining: 60 },
    };

    await adapter.sendMessage('ok', ctx);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call?.[1] as { body: string }).body) as {
      messages: Array<{ role: string; tool_call_id?: string; content: string }>;
    };
    const toolMsg = body.messages[0];
    expect(toolMsg?.role).toBe('tool');
    expect(toolMsg?.tool_call_id).toBe('call_abc');
    expect(toolMsg?.content).toBe('file contents');
    vi.unstubAllGlobals();
  });

  test('throws AdapterError on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }, 401),
    );

    await expect(adapter.sendMessage('hi', makeContext())).rejects.toMatchObject({
      name: 'AdapterError',
      status: 401,
      code: 'invalid_api_key',
      message: 'Invalid API key',
    });
    vi.unstubAllGlobals();
  });

  test('includes failed_generation details in AdapterError messages', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        error: {
          message: 'Failed to call a function. Please adjust your prompt.',
          code: 'tool_use_failed',
          failed_generation: '<tool-use>{"name":"read_file"}</tool-use>',
        },
      }, 400),
    );

    await expect(adapter.sendMessage('hi', makeContext())).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'tool_use_failed',
    });

    await adapter.sendMessage('hi', makeContext()).catch((error: unknown) => {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).message).toContain(
        'failed_generation: <tool-use>{"name":"read_file"}</tool-use>',
      );
    });
    vi.unstubAllGlobals();
  });

  test('throws AdapterError on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );

    await expect(adapter.sendMessage('hi', makeContext())).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'network_error',
    });
    vi.unstubAllGlobals();
  });

  test('throws when called before init()', async () => {
    const uninit = new OpenAIAdapter();
    await expect(uninit.sendMessage('hi', makeContext())).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'not_initialized',
    });
  });
});

describe('getTokenUsage', () => {
  test('returns zeros before any sendMessage call', async () => {
    const adapter = new OpenAIAdapter();
    await adapter.init({ provider: 'openai-compatible', api_key: 'sk-test', model: 'gpt-4o' });
    const usage = adapter.getTokenUsage();
    expect(usage.prompt_tokens).toBe(0);
    expect(usage.completion_tokens).toBe(0);
    expect(usage.total_tokens).toBe(0);
  });

  test('returns usage from the last sendMessage call', async () => {
    const adapter = new OpenAIAdapter();
    await adapter.init({
      provider: 'openai-compatible',
      base_url: 'https://api.example.com',
      api_key: 'sk-test',
      model: 'gpt-4o',
    });
    vi.stubGlobal(
      'fetch',
      mockFetch(makeSuccessResponse({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })),
    );

    await adapter.sendMessage('hi', makeContext());
    const usage = adapter.getTokenUsage();

    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(20);
    expect(usage.total_tokens).toBe(30);
    vi.unstubAllGlobals();
  });
});

describe('getCapabilities', () => {
  test('reports system prompt and tool use support', async () => {
    const adapter = new OpenAIAdapter();
    await adapter.init({ provider: 'openai-compatible', api_key: 'sk-test', model: 'gpt-4o' });
    const caps = adapter.getCapabilities();
    expect(caps.supports_system_prompt).toBe(true);
    expect(caps.supports_tool_use).toBe(true);
    expect(caps.max_context_window).toBeGreaterThan(0);
  });
});

describe('getTools', () => {
  test('returns all 8 tool definitions', async () => {
    const adapter = new OpenAIAdapter();
    await adapter.init({ provider: 'openai-compatible', api_key: 'sk-test', model: 'gpt-4o' });
    const tools = adapter.getTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('run_command');
    expect(names).toContain('list_directory');
    expect(names).toContain('search_files');
    expect(tools).toHaveLength(8);
  });
});
