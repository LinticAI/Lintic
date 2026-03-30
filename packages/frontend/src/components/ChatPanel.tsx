import { useCallback, useEffect, useRef, useState } from 'react';
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Unix timestamp in ms */
  timestamp: number;
}

export interface ChatConstraints {
  tokensRemaining: number;
  maxTokens: number;
  interactionsRemaining: number;
  maxInteractions: number;
}

interface ChatPanelProps {
  /** Active session ID.  When null the panel shows a setup state. */
  sessionId: string | null;
  constraints: ChatConstraints;
  /** Backend base URL, e.g. "http://localhost:3000" */
  apiBase?: string;
  /** Called after the agent replies so the parent can update constraint state */
  onConstraintsUpdate?: (updated: Partial<ChatConstraints>) => void;
}

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
  apiBase = '',
  onConstraintsUpdate,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const exhausted =
    constraints.interactionsRemaining <= 0 || constraints.tokensRemaining <= 0;

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Load history when sessionId changes.
  useEffect(() => {
    if (!sessionId) return;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages`);
        if (!res.ok) return;
        const data = (await res.json()) as Array<{
          id: string;
          role: 'user' | 'assistant';
          content: string;
          created_at: string;
        }>;
        setMessages(
          data.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date(m.created_at).getTime(),
          })),
        );
      } catch {
        // Ignore load errors — panel still works without history.
      }
    })();
  }, [sessionId, apiBase]);

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

    try {
      const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        response: { content: string };
        remaining?: Partial<ChatConstraints>;
      };

      const agentMsg: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: data.response.content,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, agentMsg]);

      if (data.remaining) {
        onConstraintsUpdate?.(data.remaining);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      // Remove the optimistic user message on failure.
      setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
    } finally {
      setLoading(false);
    }
  }, [input, loading, exhausted, sessionId, apiBase, onConstraintsUpdate]);

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
    <div
      className="flex flex-col h-full"
      style={{ background: '#0c0c0c', borderLeft: '1px solid #1a1a1a' }}
    >
      {/* Header */}
      <div
        className="shrink-0 px-3 py-2 flex items-center justify-between"
        style={{ borderBottom: '1px solid #1a1a1a' }}
      >
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: '#555555' }}
        >
          Agent
        </span>
        <div className="flex items-center gap-3">
          {/* Mini token bar */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px]" style={{ color: '#444444' }}>
              {constraints.tokensRemaining.toLocaleString()} tk
            </span>
            <div
              className="w-12 h-[2px] rounded-full overflow-hidden"
              style={{ background: '#1e1e1e' }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${Math.min(100, tokenPct)}%`,
                  background: isLowTokens ? '#facc15' : '#2a4a6a',
                }}
              />
            </div>
          </div>
          {/* Interaction count */}
          <span className="text-[10px] font-mono" style={{ color: '#444444' }}>
            {constraints.interactionsRemaining}/{constraints.maxInteractions}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {messages.length === 0 && !loading && (
          <div
            className="flex-1 flex items-center justify-center text-xs"
            style={{ color: '#333333' }}
          >
            Ask the agent to help with your solution.
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <span className="text-[10px] uppercase tracking-wide" style={{ color: '#444444' }}>
              {msg.role === 'user' ? 'You' : 'Agent'}
            </span>
            {msg.role === 'user' ? (
              <div
                className="max-w-[90%] rounded px-3 py-2 text-xs whitespace-pre-wrap break-words"
                style={{ background: '#1a2a3a', color: '#cccccc' }}
              >
                {msg.content}
              </div>
            ) : (
              <div
                className="max-w-[95%] rounded px-3 py-2 text-xs chat-markdown break-words"
                style={{ background: '#141414', color: '#cccccc' }}
                // eslint-disable-next-line @typescript-eslint/naming-convention
                dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
              />
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-start gap-2">
            <div className="flex gap-1 items-center px-3 py-2 rounded" style={{ background: '#141414' }}>
              <span
                className="inline-block w-1.5 h-1.5 rounded-full animate-bounce"
                style={{ background: '#555555', animationDelay: '0ms' }}
              />
              <span
                className="inline-block w-1.5 h-1.5 rounded-full animate-bounce"
                style={{ background: '#555555', animationDelay: '150ms' }}
              />
              <span
                className="inline-block w-1.5 h-1.5 rounded-full animate-bounce"
                style={{ background: '#555555', animationDelay: '300ms' }}
              />
            </div>
          </div>
        )}

        {error && (
          <div
            className="text-xs px-3 py-2 rounded"
            style={{ background: '#2a1a1a', color: '#f87171' }}
          >
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        className="shrink-0 px-3 pb-3 pt-2"
        style={{ borderTop: '1px solid #1a1a1a' }}
      >
        {exhausted && (
          <div
            className="text-xs mb-2 px-2 py-1 rounded text-center"
            style={{ background: '#1a1a1a', color: '#666666' }}
          >
            {constraints.interactionsRemaining <= 0
              ? 'No interactions remaining.'
              : 'Token budget exhausted.'}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            className="flex-1 rounded px-3 py-2 text-xs resize-none outline-none"
            style={{
              background: '#141414',
              color: '#cccccc',
              border: '1px solid #222222',
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
          <button
            className="shrink-0 px-3 py-2 rounded text-xs font-medium transition-colors"
            style={{
              background: exhausted || loading || !input.trim() ? '#1a1a1a' : '#1e3a5a',
              color: exhausted || loading || !input.trim() ? '#444444' : '#90b8d8',
              cursor: exhausted || loading || !input.trim() ? 'not-allowed' : 'pointer',
            }}
            onClick={() => void sendMessage()}
            disabled={exhausted || loading || !input.trim()}
            aria-label="Send message"
            data-testid="chat-send"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
