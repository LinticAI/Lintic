import { useCallback, useEffect, useRef, useState } from 'react';
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { ToolActionCard } from './ToolActionCard.js';
import type { LocalToolAction, LocalToolCall, LocalToolResult } from './ToolActionCard.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Tool actions associated with this assistant turn. */
  tool_actions?: LocalToolAction[];
  /** Unix timestamp in ms */
  timestamp: number;
}

export interface ChatConstraints {
  tokensRemaining: number;
  maxTokens: number;
  interactionsRemaining: number;
  maxInteractions: number;
}

/** Minimal agent config shape forwarded to the backend for per-request adapter creation. */
export interface AgentConfig {
  provider: string;
  api_key: string;
  model: string;
  base_url?: string;
}

interface SingleCallResponse {
  content: string | null;
  stop_reason: string;
  tool_calls?: LocalToolCall[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  constraints_remaining: { tokens_remaining: number; interactions_remaining: number; seconds_remaining: number };
}

interface ChatPanelProps {
  /** Active session ID.  When null the panel shows a setup state. */
  sessionId: string | null;
  constraints: ChatConstraints;
  /** Bearer token for authenticating API requests. */
  sessionToken?: string;
  /** Backend base URL, e.g. "http://localhost:3000" */
  apiBase?: string;
  /** Called after the agent replies so the parent can update constraint state */
  onConstraintsUpdate?: (updated: Partial<ChatConstraints>) => void;
  /** When provided, used to execute tool calls locally (WebContainer). */
  onExecuteTools?: (calls: LocalToolCall[]) => Promise<LocalToolResult[]>;
  /** When provided, forwarded to the backend as `agent_config` for per-request adapter creation. */
  agentConfig?: AgentConfig;
}

const MAX_TOOL_LOOPS = 10;

// Configure a custom renderer with highlight.js code highlighting.
const renderer = new Renderer();
renderer.code = ({ text, lang }: { text: string; lang?: string | null }) => {
  const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
  const highlighted = hljs.highlight(text, { language }).value;
  return `<pre class="hljs-pre"><code class="hljs language-${language}">${highlighted}</code></pre>`;
};

function renderMarkdown(content: string): string {
  return marked(content, { renderer }) as string;
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function ChatPanel({
  sessionId,
  constraints,
  sessionToken,
  apiBase = '',
  onConstraintsUpdate,
  onExecuteTools,
  agentConfig,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const exhausted =
    constraints.interactionsRemaining <= 0 || constraints.tokensRemaining <= 0;

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Load history when sessionId changes.
  useEffect(() => {
    if (!sessionId) return;
    const headers: HeadersInit = sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages`, { headers });
        if (!res.ok) return;
        const data = (await res.json()) as {
          messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; created_at: string }>;
        };
        setMessages(
          data.messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              timestamp: new Date(m.created_at).getTime(),
            })),
        );
      } catch {
        // Ignore load errors.
      }
    })();
  }, [sessionId, apiBase, sessionToken]);

  const stopAgent = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading || exhausted || !sessionId) return;

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);
    setError(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const authHeaders: HeadersInit = sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
    const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json', ...authHeaders };
    const agentConfigBody = agentConfig ? { agent_config: agentConfig } : {};

    try {
      // ── First call: POST the user message ──────────────────────────────────
      const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ message: text, ...agentConfigBody }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const errBody = (await res.json()) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }

      let data = (await res.json()) as SingleCallResponse;
      onConstraintsUpdate?.({
        tokensRemaining: data.constraints_remaining.tokens_remaining,
        interactionsRemaining: data.constraints_remaining.interactions_remaining,
      });

      // ── Round-trip tool loop ───────────────────────────────────────────────
      let loopCount = 0;
      while (
        data.stop_reason === 'tool_use' &&
        data.tool_calls?.length &&
        loopCount < MAX_TOOL_LOOPS
      ) {
        loopCount++;
        const toolCalls = data.tool_calls;

        // Execute tools locally or return stub errors
        let toolResults: LocalToolResult[];
        if (onExecuteTools) {
          toolResults = await onExecuteTools(toolCalls);
        } else {
          toolResults = toolCalls.map((c) => ({
            tool_call_id: c.id,
            name: c.name,
            output: 'Tool execution not available',
            is_error: true,
          }));
        }

        // Show tool action card immediately
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: 'assistant',
            content: '',
            tool_actions: [{ tool_calls: toolCalls, tool_results: toolResults }],
            timestamp: Date.now(),
          },
        ]);

        // POST tool results for continuation LLM call
        const toolRes = await fetch(`${apiBase}/api/sessions/${sessionId}/tool-results`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ tool_results: toolResults, ...agentConfigBody }),
          signal: ctrl.signal,
        });

        if (!toolRes.ok) {
          const errBody = (await toolRes.json()) as { error?: string };
          throw new Error(errBody.error ?? `HTTP ${toolRes.status}`);
        }

        data = (await toolRes.json()) as SingleCallResponse;
        onConstraintsUpdate?.({
          tokensRemaining: data.constraints_remaining.tokens_remaining,
          interactionsRemaining: data.constraints_remaining.interactions_remaining,
        });
      }

      // ── Final assistant message ────────────────────────────────────────────
      if (data.content) {
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: 'assistant',
            content: data.content!,
            timestamp: Date.now(),
          },
        ]);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // User clicked Stop — suppress error
      } else {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [input, loading, exhausted, sessionId, apiBase, sessionToken, agentConfig, onExecuteTools, onConstraintsUpdate]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  const tokenPct =
    constraints.maxTokens > 0
      ? (constraints.tokensRemaining / constraints.maxTokens) * 100
      : 0;
  const isLowTokens = tokenPct < 20;

  return (
    <div className="flex flex-col h-full bg-transparent">
      {/* Header */}
      <div
        className="shrink-0 px-3 flex items-center justify-between"
        style={{ height: '36px' }}
      >
        <span
          className="text-[9px] font-semibold uppercase tracking-widest"
          style={{ color: 'var(--color-text-dim)' }}
        >
          Agent
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {messages.length === 0 && !loading && (
          <div
            className="flex-1 flex items-center justify-center text-xs"
            style={{ color: 'var(--color-text-dimmer)' }}
          >
            Ask the agent to help with your solution.
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-dim)' }}>
              {msg.role === 'user' ? 'You' : 'Agent'}
            </span>

            {/* Tool action cards (before text content) */}
            {msg.tool_actions && msg.tool_actions.length > 0 && (
              <div className="w-full max-w-[95%]" data-testid="tool-actions-container">
                {msg.tool_actions.map((action, i) => (
                  <ToolActionCard key={i} action={action} />
                ))}
              </div>
            )}

            {/* Text content */}
            {msg.role === 'user' ? (
              <div
                className="max-w-[90%] rounded-[var(--radius-md)] px-3 py-2 text-xs whitespace-pre-wrap break-words"
                style={{ background: 'var(--color-bg-user-msg)', color: 'var(--color-text-user-msg)' }}
              >
                {msg.content}
              </div>
            ) : msg.content ? (
              <div
                className="max-w-[95%] rounded-[var(--radius-md)] px-3 py-2 text-xs chat-markdown break-words"
                style={{ background: 'var(--color-bg-agent-msg)', color: 'var(--color-text-agent-msg)', border: '1px solid var(--color-border-main)' }}
                data-testid="agent-message"
                // eslint-disable-next-line @typescript-eslint/naming-convention
                dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
              />
            ) : null}
          </div>
        ))}

        {loading && (
          <div className="flex items-start gap-2">
            <div
              data-testid="loading-spinner"
              className="flex gap-1 items-center px-3 py-2 rounded"
              style={{ background: 'var(--color-bg-agent-msg)' }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full animate-bounce"
                style={{ background: 'var(--color-text-muted)', animationDelay: '0ms' }}
              />
              <span
                className="inline-block w-1.5 h-1.5 rounded-full animate-bounce"
                style={{ background: 'var(--color-text-muted)', animationDelay: '150ms' }}
              />
              <span
                className="inline-block w-1.5 h-1.5 rounded-full animate-bounce"
                style={{ background: 'var(--color-text-muted)', animationDelay: '300ms' }}
              />
            </div>
          </div>
        )}

        {error && (
          <div
            className="text-xs px-3 py-2 rounded"
            style={{ background: 'var(--color-bg-error)', color: 'var(--color-status-error)' }}
          >
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        className="shrink-0 px-3 pb-3 pt-2"
        style={{ borderTop: '1px solid var(--color-border-main)' }}
      >
        {exhausted && (
          <div
            className="text-xs mb-2 px-2 py-1 rounded text-center"
            style={{ background: 'var(--color-border-main)', color: 'var(--color-text-muted)' }}
          >
            {constraints.interactionsRemaining <= 0
              ? 'No interactions remaining.'
              : 'Token budget exhausted.'}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            className="flex-1 rounded-[var(--radius-md)] px-3 py-2 text-xs resize-none outline-none"
            style={{
              background: 'var(--color-bg-input)',
              color: 'var(--color-text-main)',
              border: '1px solid var(--color-border-main)',
              minHeight: '60px',
              maxHeight: '160px',
              fontFamily: 'inherit',
            }}
            placeholder={exhausted ? 'Constraints exhausted' : 'Ask the agent… (Enter to send, Shift+Enter for newline)'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={exhausted || loading}
            rows={2}
            data-testid="chat-input"
          />
          {loading ? (
            <button
              className="shrink-0 px-4 py-2 rounded-[var(--radius-md)] text-xs font-medium transition-colors"
              style={{ background: 'var(--color-bg-stop-btn)', color: 'var(--color-status-error-text)', cursor: 'pointer', border: '1px solid var(--color-status-error)' }}
              onClick={stopAgent}
              aria-label="Stop agent"
              data-testid="stop-button"
            >
              Stop
            </button>
          ) : (
            <button
              className="shrink-0 px-4 py-2 rounded-[var(--radius-md)] text-xs font-medium transition-colors"
              style={{
                background: exhausted || !input.trim() ? 'var(--color-border-main)' : 'var(--color-bg-send-btn)',
                color: exhausted || !input.trim() ? 'var(--color-text-dimmest)' : '#ffffff',
                cursor: exhausted || !input.trim() ? 'not-allowed' : 'pointer',
              }}
              onClick={() => void sendMessage()}
              disabled={exhausted || !input.trim()}
              aria-label="Send message"
              data-testid="chat-send"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
