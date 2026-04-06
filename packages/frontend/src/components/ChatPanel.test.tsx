import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ComponentProps } from 'react';
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

    await waitFor(() => expect(screen.getByText('Hello agent')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Hello from agent')).toBeInTheDocument());
  });

  test('shows rewind affordance for a freshly sent message once turn_sequence arrives', async () => {
    const onRewind = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(makeSSEResponse([{
        event: 'done',
        data: { ...sseAgentDone('Hello from agent'), turn_sequence: 1 },
      }]));

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} onRewind={onRewind} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello agent' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(screen.getByText('Hello from agent')).toBeInTheDocument());
    expect(screen.getByTestId('rewind-button')).toBeInTheDocument();
  });

  test('keeps optimistic user messages when history finishes loading later', async () => {
    let resolveHistory!: (value: Response) => void;
    const delayedHistory = new Promise<Response>((resolve) => { resolveHistory = resolve; });

    vi.mocked(fetch)
      .mockReturnValueOnce(delayedHistory)
      .mockResolvedValueOnce(makeSSEResponse([{ event: 'done', data: sseAgentDone('Hello from agent') }]));

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello agent' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() =>
      expect(screen.getByTestId('user-message')).toHaveTextContent('Hello agent'),
    );

    await act(async () => {
      resolveHistory(historyResponse);
    });

    await waitFor(() =>
      expect(screen.getByTestId('user-message')).toHaveTextContent('Hello agent'),
    );
    await waitFor(() => expect(screen.getByText('Hello from agent')).toBeInTheDocument());
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

  test('keeps the user message visible when a streamed turn fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(
        makeSSEResponse([{ event: 'error', data: { error: 'Failed to call a function.' } }]),
      );

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'please inspect the repo' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() =>
      expect(screen.getByTestId('user-message')).toHaveTextContent('please inspect the repo'),
    );
    await waitFor(() =>
      expect(screen.getByText('Failed to call a function.')).toBeInTheDocument(),
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

  test('reports loading state while a turn is in flight', async () => {
    const onLoadingChange = vi.fn();
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(makeSSEResponse([{ event: 'done', data: sseAgentDone('hi') }]));

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        onLoadingChange={onLoadingChange}
      />,
    );

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => {
      expect(onLoadingChange).toHaveBeenCalledWith(true);
    });
    await waitFor(() => {
      expect(onLoadingChange).toHaveBeenLastCalledWith(false);
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

  test('constrains rendered markdown bubbles so wide code blocks do not expand the pane', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(makeSSEResponse([{ event: 'done', data: sseAgentDone('```markdown\\n# Plan\\n```') }]));

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => {
      const agentBubble = screen.getByTestId('agent-message');
      expect(agentBubble).toHaveClass('chat-markdown');
      expect(agentBubble).toHaveClass('max-w-full');
      expect(agentBubble).toHaveClass('min-w-0');
      expect(agentBubble).toHaveClass('overflow-x-auto');
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
    const onStopTools = vi.fn();
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

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} onStopTools={onStopTools} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'run something slow' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(screen.getByTestId('stop-button')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('stop-button'));

    expect(onStopTools).toHaveBeenCalledTimes(1);

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

  test('renders the streamed tool description before tool execution details', async () => {
    const toolCalls: LocalToolCall[] = [
      { id: 'tc-1', name: 'read_file', input: { path: '/app/index.ts' } },
    ];
    const toolResults: LocalToolResult[] = [
      { tool_call_id: 'tc-1', name: 'read_file', output: 'hello', is_error: false },
    ];

    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(
        makeSSEResponse([
          { event: 'tool_calls', data: { request_id: 'req-1', description: 'Inspecting the entrypoint first.', tool_calls: toolCalls } },
          { event: 'done', data: sseAgentDone('I read the file') },
        ]),
      )
      .mockResolvedValue(okResponse);

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        onExecuteTools={vi.fn().mockResolvedValue(toolResults)}
      />,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'read a file' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() =>
      expect(screen.getByTestId('tool-action-description')).toHaveTextContent('Inspecting the entrypoint first.'),
    );
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

  test('calls onPlanGenerated when a plan file is written successfully', async () => {
    const toolCalls: LocalToolCall[] = [
      { id: 'tc-1', name: 'write_file', input: { path: 'plans/2026-04-04-101500-plan.md', content: '# Plan' } },
    ];
    const toolResults: LocalToolResult[] = [
      { tool_call_id: 'tc-1', name: 'write_file', output: 'ok', is_error: false },
    ];
    const onPlanGenerated = vi.fn();

    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(
        makeSSEResponse([
          { event: 'tool_calls', data: { request_id: 'req-1', description: 'Writing the plan file.', tool_calls: toolCalls } },
          { event: 'done', data: sseAgentDone('Plan ready') },
        ]),
      )
      .mockResolvedValue(okResponse);

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        mode="plan"
        onPlanGenerated={onPlanGenerated}
        onExecuteTools={vi.fn().mockResolvedValue(toolResults)}
      />,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'make a plan' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() =>
      expect(onPlanGenerated).toHaveBeenCalledWith('plans/2026-04-04-101500-plan.md'),
    );
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
    const body = JSON.parse(init?.body as string) as { agent_config?: unknown; mode?: string };
    expect(body.agent_config).toEqual(agentConfig);
    expect(body.mode).toBe('build');
  });

  test('allows switching between Build and Plan modes', async () => {
    const onModeChange = vi.fn();
    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        mode="build"
        onModeChange={onModeChange}
      />,
    );

    fireEvent.click(screen.getByTestId('mode-toggle-plan'));
    expect(onModeChange).toHaveBeenCalledWith('plan');
  });

  test('sends plan mode when the panel is in Plan mode', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(makeSSEResponse([{ event: 'done', data: sseAgentDone('ok') }]));

    render(<ChatPanel sessionId="s1" constraints={defaultConstraints} mode="plan" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'plan this' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    const [, init] = vi.mocked(fetch).mock.calls[1]!;
    const body = JSON.parse(init?.body as string) as { mode?: string };
    expect(body.mode).toBe('plan');
  });

  test('approves the latest plan and starts a Build-mode turn', async () => {
    const onApprovePlan = vi.fn().mockResolvedValue('Implement the approved plan.');

    vi.mocked(fetch)
      .mockResolvedValueOnce(historyResponse)
      .mockResolvedValueOnce(makeSSEResponse([{ event: 'done', data: sseAgentDone('Implementation started') }]));

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        latestPlanPath="plans/2026-04-04-101500-plan.md"
        onApprovePlan={onApprovePlan}
        mode="plan"
      />,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('approve-plan'));

    await waitFor(() =>
      expect(onApprovePlan).toHaveBeenCalledWith('plans/2026-04-04-101500-plan.md'),
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));

    const [, init] = vi.mocked(fetch).mock.calls[1]!;
    const body = JSON.parse(init?.body as string) as { message?: string; mode?: string };
    expect(body.message).toBe('Implement the approved plan.');
    expect(body.mode).toBe('build');
  });

  test('switches branches through the custom branch menu', async () => {
    const onBranchChange = vi.fn();

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        branches={[
          { id: 'main', name: 'main', created_at: 1000 },
          { id: 'feature-a', name: 'feature-a', created_at: 2000 },
        ]}
        activeBranchId="main"
        onBranchChange={onBranchChange}
      />,
    );

    fireEvent.click(screen.getByTestId('branch-select'));
    fireEvent.click(screen.getByRole('option', { name: 'feature-a' }));

    expect(onBranchChange).toHaveBeenCalledWith('feature-a');
  });

  test('opens the inline checkpoint editor and saves a named checkpoint', async () => {
    const onSaveCheckpoint = vi.fn();

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        onSaveCheckpoint={onSaveCheckpoint}
      />,
    );

    fireEvent.click(screen.getByTestId('save-checkpoint'));
    fireEvent.change(await screen.findByTestId('checkpoint-name-input'), {
      target: { value: 'Checkpoint Alpha' },
    });
    fireEvent.click(screen.getByTestId('confirm-checkpoint'));

    expect(onSaveCheckpoint).toHaveBeenCalledWith('Checkpoint Alpha');
  });

  test('opens the context panel and shows conversation/context controls for the active branch', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/conversations')) {
        return {
          ok: true,
          json: async () => ({
            conversations: [
              {
                id: 'conv-1',
                branch_id: 'branch-1',
                title: 'New chat',
                archived: false,
                created_at: 1,
                updated_at: 2,
              },
              {
                id: 'conv-0',
                branch_id: 'branch-1',
                title: 'Earlier chat',
                archived: false,
                created_at: 0,
                updated_at: 1,
              },
            ],
            active_conversation_id: 'conv-1',
          }),
        } as unknown as Response;
      }
      if (url.includes('/context?')) {
        return {
          ok: true,
          json: async () => ({
            conversations: [
              {
                id: 'conv-1',
                branch_id: 'branch-1',
                title: 'New chat',
                archived: false,
                created_at: 1,
                updated_at: 2,
              },
              {
                id: 'conv-0',
                branch_id: 'branch-1',
                title: 'Earlier chat',
                archived: false,
                created_at: 0,
                updated_at: 1,
              },
            ],
            attachments: [],
            resources: [],
            available: {
              files: [{ path: 'src/app.ts', label: 'src/app.ts', selected: true }],
              resources: [{ id: 'repo-1', kind: 'repo_map', title: 'Repository Map', source_conversation_id: null, selected: false }],
              prior_conversations: [{ id: 'conv-0', title: 'Earlier chat', updated_at: 1, selected: false }],
            },
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({
          messages: [],
          conversations: [
            {
              id: 'conv-1',
              branch_id: 'branch-1',
              title: 'New chat',
              archived: false,
              created_at: 1,
              updated_at: 2,
            },
          ],
          active_conversation_id: 'conv-1',
        }),
      } as unknown as Response;
    });

    render(
      <ChatPanel
        sessionId="s1"
        constraints={defaultConstraints}
        branches={[{ id: 'branch-1', name: 'main', created_at: 1000 }]}
        activeBranchId="branch-1"
        activeFilePath="src/app.ts"
      />,
    );

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('context-panel-trigger'));

    expect(await screen.findByTestId('context-panel')).toBeInTheDocument();
    expect(screen.getByTestId('new-chat-button')).toBeInTheDocument();
    expect(screen.getByTestId('clear-chat-button')).toBeInTheDocument();
    expect(screen.getByTestId('generate-repo-map-button')).toBeInTheDocument();
    expect(screen.getByTestId('generate-summary-button')).toBeInTheDocument();
    expect(screen.getByTestId('context-file-src/app.ts')).toBeInTheDocument();
    expect(screen.getByTestId('context-resource-repo-1')).toBeInTheDocument();
    expect(screen.getByTestId('context-prior-conversation-conv-0')).toBeInTheDocument();
  });

  describe('Rewind UX', () => {
    /** History response with a user message that has turn_sequence: 1 (rewind button shows). */
    const historyWithUserMsg: Response = {
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Hello',
            created_at: new Date(1000).toISOString(),
            turn_sequence: 1,
          },
        ],
        conversations: [{ id: 'conv-1', branch_id: 'branch-1', title: 'New chat', archived: false, created_at: 1, updated_at: 2 }],
        active_conversation_id: 'conv-1',
      }),
    } as unknown as Response;

    /** Helper: render ChatPanel with a history-loaded user message that has turnSequence: 1. */
    async function renderWithHistoryMessage(onRewind?: ComponentProps<typeof ChatPanel>['onRewind']) {
      // All fetches return the history-with-user-msg response (handles multiple history loads).
      vi.mocked(fetch).mockResolvedValue(historyWithUserMsg);

      render(
        <ChatPanel
          sessionId="s1"
          constraints={defaultConstraints}
          onRewind={onRewind}
        />,
      );

      // Wait for history to load and user message to appear.
      await waitFor(() => expect(screen.getByTestId('user-message')).toBeInTheDocument());
    }

    test('rewind button not visible when onRewind is not provided', async () => {
      await renderWithHistoryMessage();
      expect(screen.queryByTestId('rewind-button')).not.toBeInTheDocument();
    });

    test('rewind button visible when onRewind is provided and message has turnSequence', async () => {
      const onRewind = vi.fn().mockResolvedValue(undefined);
      await renderWithHistoryMessage(onRewind);
      expect(screen.getByTestId('rewind-button')).toBeInTheDocument();
    });

    test('clicking rewind button opens a popover with two options', async () => {
      const onRewind = vi.fn().mockResolvedValue(undefined);
      await renderWithHistoryMessage(onRewind);

      fireEvent.click(screen.getByTestId('rewind-button'));

      expect(screen.getByText('Rewind code + conversation')).toBeInTheDocument();
      expect(screen.getByText('Rewind code only')).toBeInTheDocument();
    });

    test('"Rewind code only" calls onRewind with (turnSequence, "code") and does not change messages', async () => {
      const onRewind = vi.fn().mockResolvedValue(undefined);
      await renderWithHistoryMessage(onRewind);

      fireEvent.click(screen.getByTestId('rewind-button'));
      fireEvent.click(screen.getByText('Rewind code only'));

      await waitFor(() => expect(onRewind).toHaveBeenCalledWith(1, 'code'));
      expect(screen.getByTestId('user-message')).toBeInTheDocument();
    });

    test('"Rewind code + conversation" calls onRewind with (turnSequence, "both") and removes messages after that point', async () => {
      const onRewind = vi.fn().mockResolvedValue(undefined);
      await renderWithHistoryMessage(onRewind);

      fireEvent.click(screen.getByTestId('rewind-button'));
      fireEvent.click(screen.getByText('Rewind code + conversation'));

      await waitFor(() => expect(onRewind).toHaveBeenCalledWith(1, 'both'));
      // User message has turnSequence === 1 === ts, so it should still be present.
      expect(screen.getByTestId('user-message')).toBeInTheDocument();
    });
  });
});
