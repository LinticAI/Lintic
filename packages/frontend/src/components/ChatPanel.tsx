import { useCallback, useEffect, useRef, useState } from 'react';
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { 
  Send, 
  CornerDownLeft, 
  ChevronDown, 
  Square, 
  MessageSquare,
  AlertCircle
} from 'lucide-react';
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

interface SSEDonePayload {
  content: string | null;
  stop_reason: string;
  tool_actions: Array<{ tool_calls: LocalToolCall[]; tool_results: LocalToolResult[] }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  constraints_remaining: { tokens_remaining: number; interactions_remaining: number; seconds_remaining: number };
}

interface SSEToolCallsPayload {
  request_id: string;
  tool_calls: LocalToolCall[];
}

/** Parse SSE events from a fetch ReadableStream. Yields { event, data } for each complete event block. */
async function* readSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        if (!block.trim()) continue;
        let event = 'message';
        let dataStr = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataStr = line.slice(6);
        }
        if (dataStr) yield { event, data: JSON.parse(dataStr) as unknown };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface ChatPanelProps {
  /** Active session ID.  When null the panel shows a setup state. */
  sessionId: string | null;
  constraints: ChatConstraints;
  /** Bearer token for authenticating API requests. */
  sessionToken?: string;
  /** Backend base URL, e.g. "http://localhost:3300" */
  apiBase?: string;
  /** Called after the agent replies so the parent can update constraint state */
  onConstraintsUpdate?: (updated: Partial<ChatConstraints>) => void;
  /** When provided, used to execute tool calls locally (WebContainer). */
  onExecuteTools?: (calls: LocalToolCall[]) => Promise<LocalToolResult[]>;
  /** When provided, called when the user stops the current turn so in-flight tools can be terminated. */
  onStopTools?: () => void;
  /** When provided, forwarded to the backend as `agent_config` for per-request adapter creation. */
  agentConfig?: AgentConfig;
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const MESSAGE_DEDUPE_WINDOW_MS = 5_000;

function isSameMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.id === b.id) {
    return true;
  }

  return (
    a.role === b.role &&
    a.content === b.content &&
    Math.abs(a.timestamp - b.timestamp) <= MESSAGE_DEDUPE_WINDOW_MS
  );
}

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const merged = [...existing];

  for (const message of incoming) {
    if (!merged.some((candidate) => isSameMessage(candidate, message))) {
      merged.push(message);
    }
  }

  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
}

/** Helper to parse JSON tool use from assistant content */
function parseToolUse(content: string): { content: string | null; tool_actions: LocalToolAction[] } {
  const tool_actions: LocalToolAction[] = [];
  let remainingText = content;

  // 1. Try parsing the whole thing if it looks like a tool_use JSON block
  if (content.trim().startsWith('{') && content.includes('"__type"') && content.includes('"tool_use"')) {
    try {
      const parsed = JSON.parse(content.trim());
      if (parsed.__type === 'tool_use' && parsed.tool_calls) {
        return {
          content: parsed.content || null,
          tool_actions: [{ tool_calls: parsed.tool_calls, tool_results: [] }]
        };
      }
    } catch {
      // Fall back to regex/extraction if direct parse fails
    }
  }

  // 2. Look for ANY JSON block that looks like tool_use using a more robust approach
  // We look for the start sequence and then try to find the matching closing brace
  const marker = '"__type"';
  let startIndex = remainingText.indexOf(marker);
  
  while (startIndex !== -1) {
    // Find the start of the object containing this marker
    let objStart = remainingText.lastIndexOf('{', startIndex);
    if (objStart !== -1) {
      // Basic brace counting to find the matching end brace
      let depth = 0;
      let objEnd = -1;
      for (let i = objStart; i < remainingText.length; i++) {
        if (remainingText[i] === '{') depth++;
        else if (remainingText[i] === '}') {
          depth--;
          if (depth === 0) {
            objEnd = i;
            break;
          }
        }
      }

      if (objEnd !== -1) {
        const potentialJson = remainingText.slice(objStart, objEnd + 1);
        try {
          const parsed = JSON.parse(potentialJson);
          if (parsed.__type === 'tool_use' && parsed.tool_calls) {
            tool_actions.push({ tool_calls: parsed.tool_calls, tool_results: [] });
            remainingText = remainingText.slice(0, objStart) + (parsed.content || '') + remainingText.slice(objEnd + 1);
            // Restart search from current position as remainingText has changed
            startIndex = remainingText.indexOf(marker);
            continue;
          }
        } catch {
          // Not valid JSON
        }
      }
    }
    startIndex = remainingText.indexOf(marker, startIndex + 1);
  }

  // 3. Look for <function/NAME{...} patterns (fallback for some models)
  const functionRegex = /<function\/(\w+)(\{[\s\S]*?\})/g;
  let funcMatch;
  while ((funcMatch = functionRegex.exec(remainingText)) !== null) {
    try {
      const name = funcMatch[1];
      const input = JSON.parse(funcMatch[2]!);
      tool_actions.push({
        tool_calls: [{ id: generateId(), name: name!, input }],
        tool_results: []
      });
      remainingText = remainingText.replace(funcMatch[0], '');
    } catch {
      // Invalid JSON in function call
    }
  }

  return {
    content: remainingText.trim() || null,
    tool_actions
  };
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

export function ChatPanel({
  sessionId,
  constraints,
  sessionToken,
  apiBase = '',
  onConstraintsUpdate,
  onExecuteTools,
  onStopTools,
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
    setMessages([]);
    if (!sessionId) return;
    const headers: HeadersInit = sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages`, { headers });
        if (!res.ok) return;
        const data = (await res.json()) as {
          messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; created_at: string }>;
        };
        const loadedMessages = data.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date(m.created_at).getTime(),
          }));

        setMessages((prev) => mergeMessages(prev, loadedMessages));
      } catch {
        // Ignore load errors.
      }
    })();
  }, [sessionId, apiBase, sessionToken]);

  const stopAgent = useCallback(() => {
    onStopTools?.();
    abortRef.current?.abort();
  }, [onStopTools]);

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
      const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages/stream`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ message: text, ...agentConfigBody }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const errBody = (await res.json()) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }

      for await (const { event, data } of readSSEStream(res.body)) {
        if (event === 'tool_calls') {
          const { request_id, tool_calls } = data as SSEToolCallsPayload;
          const msgId = generateId();
          setMessages((prev) => [
            ...prev,
            {
              id: msgId,
              role: 'assistant',
              content: '',
              tool_actions: [{ tool_calls, tool_results: [] }],
              timestamp: Date.now(),
            },
          ]);

          const toolResults: LocalToolResult[] = onExecuteTools
            ? await onExecuteTools(tool_calls)
            : tool_calls.map((c: LocalToolCall) => ({
                tool_call_id: c.id,
                name: c.name,
                output: 'Tool execution not available',
                is_error: true,
              }));

          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId
                ? { ...m, tool_actions: [{ tool_calls, tool_results: toolResults }] }
                : m,
            ),
          );

          void fetch(`${apiBase}/api/sessions/${sessionId}/tool-results/${request_id}`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ tool_results: toolResults }),
            signal: ctrl.signal,
          });

        } else if (event === 'done') {
          const result = data as SSEDonePayload;
          onConstraintsUpdate?.({
            tokensRemaining: result.constraints_remaining.tokens_remaining,
            interactionsRemaining: result.constraints_remaining.interactions_remaining,
          });
          if (result.content) {
            setMessages((prev) => [
              ...prev,
              { id: generateId(), role: 'assistant', content: result.content!, timestamp: Date.now() },
            ]);
          }

        } else if (event === 'error') {
          const { error } = data as { error: string };
          throw new Error(error);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
      } else {
        setError(err instanceof Error ? err.message : 'Unknown error');
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
    <div className="flex flex-col h-full overflow-hidden" style={{ background: 'var(--color-bg-chat)' }}>
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 flex flex-col gap-10 relative">
        {messages.length === 0 && !loading && (
          <div
            className="flex-1 flex items-center justify-center text-xs opacity-40 pt-12"
            style={{ color: 'var(--color-text-dim)' }}
          >
            Ask the agent to help with your solution.
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.role === 'user';
          
          let displayContent = msg.content;
          let displayToolActions = msg.tool_actions || [];
          
          if (!isUser && msg.content) {
            const parsed = parseToolUse(msg.content);
            displayContent = parsed.content || '';
            if (parsed.tool_actions.length > 0) {
              displayToolActions = [...displayToolActions, ...parsed.tool_actions];
            }
          }
          
          return (
            <div
              key={msg.id}
              className="flex flex-col gap-6 py-1"
            >
              {/* Text content */}
              {isUser ? (
                <div
                  className="w-full rounded-[25px] px-8 py-5 text-sm whitespace-pre-wrap break-words border-none shadow-none"
                  style={{ background: 'var(--color-bg-user-msg)', color: 'var(--color-text-user-msg)' }}
                  data-testid="user-message"
                >
                  {displayContent}
                </div>
              ) : (
                <>
                  {/* Tool action cards */}
                  {displayToolActions.length > 0 && (
                    <div className="w-full" data-testid="tool-actions-container">
                      {displayToolActions.map((action, i) => (
                        <ToolActionCard key={i} action={action} />
                      ))}
                    </div>
                  )}

                  {displayContent && (
                    <div
                      className="w-full text-sm chat-markdown break-words"
                      style={{ color: 'var(--color-text-agent-msg)' }}
                      data-testid="agent-message"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(displayContent) }}
                    />
                  )}
                </>
              )}
            </div>
          );
        })}

        {loading && (
          <div className="flex items-start gap-2 py-2">
            <div
              data-testid="loading-spinner"
              className="flex gap-2 items-center px-5 py-3 rounded-full"
              style={{ background: 'var(--color-bg-agent-msg)', opacity: 0.6 }}
            >
              <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}

        {error && (
          <div
            className="text-xs px-6 py-4 rounded-[25px] flex items-center gap-3"
            style={{ background: 'var(--color-bg-error)', color: 'var(--color-status-error)' }}
          >
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Section */}
      <div className="shrink-0 px-4 pt-4">
        <div
          className="rounded-[25px] pt-5 pb-2 pl-5 pr-5 flex flex-col gap-5 border-none"
          style={{
            background: 'var(--color-bg-input)',
            boxShadow: '0 8px 30px rgba(0,0,0,0.2)'
          }}
        >
          <textarea
            ref={textareaRef}
            className="w-full text-[15px] resize-none outline-none border-none bg-transparent"
            style={{
              color: 'var(--color-text-main)',
              minHeight: '44px',
              maxHeight: '140px',
              fontFamily: 'inherit',
            }}
            placeholder={exhausted ? 'Constraints exhausted' : 'Talk to the agent...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={exhausted || loading}
            rows={1}
            data-testid="chat-input"
          />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              {/* Model Dropdown Mock */}
              <div
                className="flex items-center gap-2 text-[13px] font-medium opacity-60 cursor-pointer hover:opacity-100 transition-opacity"
                style={{ color: 'var(--color-text-main)' }}
              >
                <span>{agentConfig?.model || 'Opus 4.6'}</span>
                <ChevronDown size={14} />
              </div>
              {/* Level/Setting Dropdown Mock */}
              <div
                className="flex items-center gap-2 text-[13px] font-medium opacity-60 cursor-pointer hover:opacity-100 transition-opacity"
                style={{ color: 'var(--color-text-main)' }}
              >
                <span>Medium</span>
                <ChevronDown size={14} />
              </div>
            </div>

            <div className="flex items-center gap-3">
              {loading ? (
                <button
                  type="button"
                  className="w-10 h-10 rounded-full flex items-center justify-center transition-colors hover:bg-red-500/20"
                  style={{ background: 'var(--color-bg-stop-btn)', color: 'var(--color-status-error-text)' }}
                  onClick={stopAgent}
                  aria-label="Stop agent"
                  data-testid="stop-button"
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  className="h-10 px-5 rounded-full flex items-center justify-center gap-2 transition-all hover:scale-[1.05]"
                  style={{
                    background: exhausted || !input.trim() ? 'rgba(255,255,255,0.05)' : '#FFFFFF',
                    color: exhausted || !input.trim() ? 'rgba(255,255,255,0.2)' : '#000000',
                    cursor: exhausted || !input.trim() ? 'not-allowed' : 'pointer',
                  }}
                  onClick={() => void sendMessage()}
                  disabled={exhausted || !input.trim()}
                  aria-label="Send message"
                  data-testid="chat-send"
                >
                  <CornerDownLeft size={16} />
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Usage Bar */}
      <div 
        className="shrink-0 h-12 px-5 flex items-center justify-between border-none"
        style={{ 
          background: 'transparent'
        }}
      >
        <div className="flex items-center gap-2 opacity-50" style={{ color: 'var(--color-text-main)' }}>
          <span className="text-[12px] font-medium tracking-tight">{constraints.interactionsRemaining} / {constraints.maxInteractions}</span>
          <MessageSquare size={13} />
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[12px] font-medium opacity-50" style={{ color: 'var(--color-text-main)' }}>
            {Math.round(100 - tokenPct)}% tokens used
          </span>
          <div className="w-40 h-1 rounded-full overflow-hidden bg-white/10">
            <div 
              className="h-full transition-all duration-300"
              style={{ width: `${100 - tokenPct}%`, background: isLowTokens ? 'var(--color-status-error)' : 'var(--color-status-diff-add)' }}
            />
          </div>
        </div>
      </div>    </div>
  );
}
