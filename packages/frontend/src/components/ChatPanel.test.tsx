import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatPanel } from './ChatPanel.js';
import type { LocalToolCall, LocalToolResult } from './ToolActionCard.js';

// jsdom doesn't implement scrollIntoView.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// Mock marked and highlight.js to avoid DOM complexity in jsdom.
vi.mock('marked', () => ({
  marked: (text: string, _opts?: unknown) => `<p>${text}</p>`,
  Renderer: class {
    code = ({ text }: { text: string }) => `<pre>${text}</pre>`;
  },
}));

vi.mock('highlight.js', () => ({
  default: {
    getLanguage: () => true,
    highlight: (_text: string, { language }: { language: string }) => ({
      value: `<highlighted lang="${language}" />`,
    }),
  },
}));

vi.mock('highlight.js/styles/github-dark.css', () => ({}));

// ─── SSE helpers ──────────────────────────────────────────────────────────────

/** Build a fake SSE Response whose body streams the given events. */
function makeSSEResponse(events: Array<{ event: string; data: unknown }>): Response {
  const sseText = events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });
  return { ok: true, body: stream } as unknown as Response;
}

/** Build the payload for a `done` SSE event (text response, no tools). */
function sseAgentDone(
  content: string,
  tokensRemaining = 49000,
  interactionsRemaining = 29,
) {
  return {
    content,
    stop_reason: 'end_turn',
    tool_actions: [],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    constraints_remaining: {
      tokens_remaining: tokensRemaining,
      interactions_remaining: interactionsRemaining,
      seconds_remaining: 3500,
    },
  };
}

/** Standard empty-history GET response. */
const historyResponse: Response = {
  ok: true,
  json: async () => ({ messages: [] }),
} as unknown as Response;

/** Simple ok response for fire-and-forget tool-results POST calls. */
const okResponse: Response = {
  ok: true,
  json: async () => ({ ok: true }),
} as unknown as Response;

const defaultConstraints = {
  tokensRemaining: 50000,
  maxTokens: 50000,
  interactionsRemaining: 30,
  maxInteractions: 30,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(historyResponse));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders the input and send button', () => {
    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
    expect(screen.getByTestId('chat-send')).toBeInTheDocument();
  });

  test('shows empty state message when no messages', () => {
    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    expect(screen.getByText(/ask the agent/i)).toBeInTheDocument();
  });

  test('disables input and send when interactions exhausted', () => {
    render(
      <ChatPanel
        sessionId="s1"
        constraints={{ ...defaultConstraints, interactionsRemaining: 0 }}
      />,
    );
    expect(screen.getByTestId('chat-input')).toBeDisabled();
    expect(screen.getByTestId('chat-send')).toBeDisabled();
  });

  test('disables input and send when token budget exhausted', () => {
    render(
      <ChatPanel
        sessionId="s1"
        constraints={{ ...defaultConstraints, tokensRemaining: 0 }}
      />,
    );
    expect(screen.getByTestId('chat-input')).toBeDisabled();
    expect(screen.getByTestId('chat-send')).toBeDisabled();
  });

  test('sends a message and shows agent response', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(makeSSEResponse([{ event: 'done', data: sseAgentDone('Hello from agent') }]));

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello agent' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(screen.getByText('You')).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText('Agent').length).toBeGreaterThan(0));
  });

  test('sends message on Enter keydown', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(makeSSEResponse([{ event: 'done', data: sseAgentDone('ok') }]));

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });
  });

  test('does NOT send on Shift+Enter', async () => {
    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  test('shows error message when request fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Token budget exceeded' }),
      } as unknown as Response);

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(screen.getByText('Token budget exceeded')).toBeInTheDocument());
  });

  test('shows error message when SSE error event is received', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(
        makeSSEResponse([{ event: 'error', data: { error: 'Session constraints exhausted' } }]),
      );

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() =>
      expect(screen.getByText('Session constraints exhausted')).toBeInTheDocument(),
    );
  });

  test('calls onConstraintsUpdate when done event arrives', async () => {
    const onUpdate = vi.fn();
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(makeSSEResponse([{ event: 'done', data: sseAgentDone('hi', 49000, 29) }]));

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        onConstraintsUpdate={onUpdate}
      />,
    );

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({
        tokensRemaining: 49000,
        interactionsRemaining: 29,
      });
    });
  });

  test('shows no session placeholder when sessionId is null', () => {
    render(<ChatPanel sessionId={null} constraints={defaultConstraints} />);
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
  });

  test('shows loading spinner while waiting for agent response', async () => {
    let resolvePost!: (value: Response) => void;
    const postPromise = new Promise<Response>((res) => { resolvePost = res; });

    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockReturnValueOnce(postPromise);

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(screen.getByTestId('loading-spinner')).toBeInTheDocument());

    await act(async () => {
      resolvePost(makeSSEResponse([{ event: 'done', data: sseAgentDone('done') }]));
    });

    await waitFor(() => expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument());
  });

  test('renders agent response as HTML (markdown)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(makeSSEResponse([{ event: 'done', data: sseAgentDone('**bold text**') }]));

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => {
      const agentBubbles = screen.getAllByTestId('agent-message');
      expect(agentBubbles.length).toBeGreaterThan(0);
      expect(agentBubbles[0]!.innerHTML).toBe('<p>**bold text**</p>');
    });
  });

  // ── Stop button ─────────────────────────────────────────────────────────────

  test('shows Stop button while loading', async () => {
    let resolvePost!: (value: Response) => void;
    const postPromise = new Promise<Response>((res) => { resolvePost = res; });

    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockReturnValueOnce(postPromise);

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(screen.getByTestId('stop-button')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-send')).not.toBeInTheDocument();

    await act(async () => {
      resolvePost(makeSSEResponse([{ event: 'done', data: sseAgentDone('done') }]));
    });
  });

  test('clicking Stop clears the spinner and hides Stop button', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockImplementationOnce(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The user aborted a request.', 'AbortError'));
            });
          }),
      );

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'run something slow' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(screen.getByTestId('stop-button')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('stop-button'));

    await waitFor(() => {
      expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument();
      expect(screen.queryByTestId('stop-button')).not.toBeInTheDocument();
    });
  });

  // ── Tool action streaming ────────────────────────────────────────────────────

  test('shows pending tool card immediately when tool_calls event arrives', async () => {
    const toolCalls: LocalToolCall[] = [
      { id: 'tc-1', name: 'read_file', input: { path: '/app/index.ts' } },
    ];
    const toolResults: LocalToolResult[] = [
      { tool_call_id: 'tc-1', name: 'read_file', output: 'hello', is_error: false },
    ];

    let resolveTools!: (r: LocalToolResult[]) => void;
    const toolsPromise = new Promise<LocalToolResult[]>((r) => { resolveTools = r; });
    const onExecuteTools = vi.fn().mockReturnValue(toolsPromise);

    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(
        makeSSEResponse([
          { event: 'tool_calls', data: { request_id: 'req-1', tool_calls: toolCalls } },
          { event: 'done', data: sseAgentDone('I read the file') },
        ]),
      )
      .mockResolvedValue(okResponse); // tool-results POST

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        onExecuteTools={onExecuteTools}
      />,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'read a file' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    // Pending card appears before tools finish executing
    await waitFor(() => expect(screen.getByTestId('tool-action-card')).toBeInTheDocument());

    // Resolve tools — card updates and final message appears
    await act(async () => { resolveTools(toolResults); });

    await waitFor(() => expect(screen.getByTestId('agent-message')).toBeInTheDocument());
  });

  test('renders tool action card with results after tools execute', async () => {
    const toolCalls: LocalToolCall[] = [
      { id: 'tc-1', name: 'read_file', input: { path: '/app/index.ts' } },
    ];
    const toolResults: LocalToolResult[] = [
      { tool_call_id: 'tc-1', name: 'read_file', output: 'hello', is_error: false },
    ];

    const onExecuteTools = vi.fn().mockResolvedValue(toolResults);

    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(
        makeSSEResponse([
          { event: 'tool_calls', data: { request_id: 'req-1', tool_calls: toolCalls } },
          { event: 'done', data: sseAgentDone('I read the file') },
        ]),
      )
      .mockResolvedValue(okResponse);

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        onExecuteTools={onExecuteTools}
      />,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'read a file' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => {
      expect(screen.getByTestId('tool-actions-container')).toBeInTheDocument();
      expect(screen.getByTestId('tool-action-card')).toBeInTheDocument();
    });
  });

  test('calls onExecuteTools with tool_calls from tool_calls event', async () => {
    const toolCalls: LocalToolCall[] = [
      { id: 'tc-1', name: 'run_command', input: { command: 'npm test' } },
    ];
    const toolResults: LocalToolResult[] = [
      { tool_call_id: 'tc-1', name: 'run_command', output: 'PASS', is_error: false },
    ];

    const onExecuteTools = vi.fn().mockResolvedValue(toolResults);

    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(
        makeSSEResponse([
          { event: 'tool_calls', data: { request_id: 'req-1', tool_calls: toolCalls } },
          { event: 'done', data: sseAgentDone('Tests passed') },
        ]),
      )
      .mockResolvedValue(okResponse);

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        onExecuteTools={onExecuteTools}
      />,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'run tests' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => {
      expect(onExecuteTools).toHaveBeenCalledWith(toolCalls);
    });

    await waitFor(() => expect(screen.getByTestId('agent-message')).toBeInTheDocument());
  });

  test('posts tool results to /tool-results/:requestId endpoint', async () => {
    const toolCalls: LocalToolCall[] = [
      { id: 'tc-1', name: 'write_file', input: { path: '/a.ts', content: 'hello' } },
    ];
    const toolResults: LocalToolResult[] = [
      { tool_call_id: 'tc-1', name: 'write_file', output: 'ok', is_error: false },
    ];

    const onExecuteTools = vi.fn().mockResolvedValue(toolResults);

    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(
        makeSSEResponse([
          { event: 'tool_calls', data: { request_id: 'req-abc', tool_calls: toolCalls } },
          { event: 'done', data: sseAgentDone('Written') },
        ]),
      )
      .mockResolvedValue(okResponse);

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        onExecuteTools={onExecuteTools}
      />,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'write a file' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    // Wait for the tool-results POST (fire-and-forget, happens after tools execute)
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3));

    const [url] = vi.mocked(fetch).mock.calls[2]!;
    expect(String(url)).toContain('tool-results/req-abc');
  });

  test('uses stub error results when onExecuteTools is not provided', async () => {
    const toolCalls: LocalToolCall[] = [
      { id: 'tc-1', name: 'read_file', input: { path: '/x.ts' } },
    ];

    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(
        makeSSEResponse([
          { event: 'tool_calls', data: { request_id: 'req-1', tool_calls: toolCalls } },
          { event: 'done', data: sseAgentDone('Done') },
        ]),
      )
      .mockResolvedValue(okResponse);

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(screen.getByTestId('agent-message')).toBeInTheDocument());
  });

  test('forwards agentConfig to backend in request body', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(makeSSEResponse([{ event: 'done', data: sseAgentDone('ok') }]));

    const agentConfig = { provider: 'openai-compatible', api_key: 'sk-test', model: 'gpt-4o' };

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        agentConfig={agentConfig}
      />,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    const [url, init] = vi.mocked(fetch).mock.calls[1]!;
    expect(String(url)).toContain('messages/stream');
    const body = JSON.parse(init?.body as string) as { agent_config?: unknown };
    expect(body.agent_config).toEqual(agentConfig);
  });
});
