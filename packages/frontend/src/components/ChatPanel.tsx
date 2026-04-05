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
  AlertCircle,
  Bookmark,
  Check,
  X
} from 'lucide-react';
import { ToolActionCard } from './ToolActionCard.js';
import type { LocalToolAction, LocalToolCall, LocalToolResult } from './ToolActionCard.js';
import type { PersistedBranchSummary } from '../lib/session-persist.js';
import { DropdownMenu, DropdownTriggerLabel } from './DropdownMenu.js';

export type AgentMode = 'build' | 'plan';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Tool actions associated with this assistant turn. */
  tool_actions?: LocalToolAction[];
  /** Unix timestamp in ms */
  timestamp: number;
  turnSequence?: number | null;
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
  tool_actions: Array<{ description?: string | null; tool_calls: LocalToolCall[]; tool_results: LocalToolResult[] }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  constraints_remaining: { tokens_remaining: number; interactions_remaining: number; seconds_remaining: number };
  turn_sequence?: number;
}

interface SSEToolCallsPayload {
  request_id: string;
  description?: string | null;
  tool_calls: LocalToolCall[];
  turn_sequence?: number;
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
  /** Notifies the parent when a turn is actively running. */
  onLoadingChange?: (loading: boolean) => void;
  mode?: AgentMode;
  onModeChange?: (mode: AgentMode) => void;
  latestPlanPath?: string | null;
  onPlanGenerated?: (path: string) => void;
  onApprovePlan?: (path: string) => Promise<string>;
  modelLabel?: string;
  branches?: PersistedBranchSummary[];
  activeBranchId?: string | null;
  onBranchChange?: (branchId: string) => void;
  onSaveCheckpoint?: (label: string) => Promise<void> | void;
  onCreateBranch?: (name: string, turnSequence: number) => Promise<void> | void;
  onTurnComplete?: (turnSequence: number) => void;
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
          content: null,
          tool_actions: [{ description: parsed.content || null, tool_calls: parsed.tool_calls, tool_results: [] }]
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
            tool_actions.push({ description: parsed.content || null, tool_calls: parsed.tool_calls, tool_results: [] });
            remainingText = remainingText.slice(0, objStart) + remainingText.slice(objEnd + 1);
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
  onLoadingChange,
  mode = 'build',
  onModeChange,
  latestPlanPath,
  onPlanGenerated,
  onApprovePlan,
  modelLabel,
  branches = [],
  activeBranchId,
  onBranchChange,
  onSaveCheckpoint,
  onCreateBranch,
  onTurnComplete,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const checkpointInputRef = useRef<HTMLInputElement>(null);
  const [checkpointEditing, setCheckpointEditing] = useState(false);
  const [checkpointName, setCheckpointName] = useState('');

  const exhausted =
    constraints.interactionsRemaining <= 0 || constraints.tokensRemaining <= 0;

  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

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
        const branchQuery = activeBranchId ? `?branch_id=${encodeURIComponent(activeBranchId)}` : '';
        const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages${branchQuery}`, { headers });
        if (!res.ok) return;
        const data = (await res.json()) as {
          messages: Array<{
            id: string;
            role: 'user' | 'assistant';
            content: string;
            created_at: string;
            turn_sequence?: number | null;
          }>;
        };
        const loadedMessages = data.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date(m.created_at).getTime(),
            turnSequence: m.turn_sequence ?? null,
          }));

        setMessages((prev) => mergeMessages(prev, loadedMessages));
      } catch {
        // Ignore load errors.
      }
    })();
  }, [activeBranchId, sessionId, apiBase, sessionToken]);

  useEffect(() => {
    if (!sessionId) {
      onLoadingChange?.(false);
    }
  }, [sessionId, onLoadingChange]);

  useEffect(() => {
    if (!checkpointEditing) {
      return;
    }

    const timer = window.setTimeout(() => {
      checkpointInputRef.current?.focus();
      checkpointInputRef.current?.select();
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [checkpointEditing]);

  const stopAgent = useCallback(() => {
    onStopTools?.();
    abortRef.current?.abort();
  }, [onStopTools]);

  const handleStartCheckpointEdit = useCallback(() => {
    setCheckpointName('');
    setCheckpointEditing(true);
  }, []);

  const handleCancelCheckpointEdit = useCallback(() => {
    setCheckpointEditing(false);
    setCheckpointName('');
  }, []);

  const handleSubmitCheckpoint = useCallback(() => {
    const label = checkpointName.trim();
    if (!label) {
      return;
    }
    void onSaveCheckpoint?.(label);
    setCheckpointEditing(false);
    setCheckpointName('');
  }, [checkpointName, onSaveCheckpoint]);

  const sendMessage = useCallback(async (overrideText?: string, overrideMode?: AgentMode) => {
    const text = (overrideText ?? input).trim();
    if (!text || loading || exhausted || !sessionId) return;
    const selectedMode = overrideMode ?? mode;

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
        body: JSON.stringify({
          message: text,
          mode: selectedMode,
          ...(activeBranchId ? { branch_id: activeBranchId } : {}),
          ...agentConfigBody,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const errBody = (await res.json()) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }

      for await (const { event, data } of readSSEStream(res.body)) {
        if (event === 'tool_calls') {
          const { request_id, description, tool_calls, turn_sequence } = data as SSEToolCallsPayload;
          const msgId = generateId();
          setMessages((prev) => [
            ...prev,
            {
              id: msgId,
              role: 'assistant',
              content: '',
              tool_actions: [{ description: description ?? null, tool_calls, tool_results: [] }],
              timestamp: Date.now(),
              turnSequence: turn_sequence ?? null,
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
                ? { ...m, tool_actions: [{ description: description ?? null, tool_calls, tool_results: toolResults }] }
                : m,
            ),
          );

          const generatedPlanPath = tool_calls
            .map((call) => ({
              path: typeof call.input['path'] === 'string' ? String(call.input['path']) : null,
              result: toolResults.find((result) => result.tool_call_id === call.id),
              name: call.name,
            }))
            .filter(({ path, result, name }) => name === 'write_file' && path?.startsWith('plans/') && !result?.is_error)
            .at(-1)?.path;

          if (generatedPlanPath) {
            onPlanGenerated?.(generatedPlanPath);
          }

          void fetch(`${apiBase}/api/sessions/${sessionId}/tool-results/${request_id}`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({
              tool_results: toolResults,
              ...(activeBranchId ? { branch_id: activeBranchId } : {}),
              ...(turn_sequence !== undefined ? { turn_sequence } : {}),
            }),
            signal: ctrl.signal,
          });

        } else if (event === 'done') {
          const result = data as SSEDonePayload;
          onConstraintsUpdate?.({
            tokensRemaining: result.constraints_remaining.tokens_remaining,
            interactionsRemaining: result.constraints_remaining.interactions_remaining,
          });
          if (result.turn_sequence !== undefined) {
            onTurnComplete?.(result.turn_sequence);
          }
          if (result.content) {
            setMessages((prev) => [
              ...prev,
              {
                id: generateId(),
                role: 'assistant',
                content: result.content!,
                timestamp: Date.now(),
                turnSequence: result.turn_sequence ?? null,
              },
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
  }, [
    agentConfig,
    activeBranchId,
    apiBase,
    exhausted,
    input,
    loading,
    mode,
    onConstraintsUpdate,
    onExecuteTools,
    onPlanGenerated,
    onTurnComplete,
    sessionId,
    sessionToken,
  ]);

  const approvePlan = useCallback(async () => {
    if (!latestPlanPath || !onApprovePlan || loading) return;

    try {
      const approvedMessage = await onApprovePlan(latestPlanPath);
      onModeChange?.('build');
      await sendMessage(approvedMessage, 'build');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to approve plan');
    }
  }, [latestPlanPath, loading, onApprovePlan, onModeChange, sendMessage]);

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
  const tokenUsagePct = Math.max(0, Math.min(100, 100 - tokenPct));
  const tokenRingRadius = 8;
  const tokenRingCircumference = 2 * Math.PI * tokenRingRadius;
  const tokenRingOffset = tokenRingCircumference - (tokenUsagePct / 100) * tokenRingCircumference;
  const selectedBranch = branches.find((branch) => branch.id === activeBranchId) ?? branches[0] ?? null;
  const branchItems = branches.map((branch) => ({
    value: branch.id,
    label: branch.name,
    selected: branch.id === selectedBranch?.id,
    onSelect: () => onBranchChange?.(branch.id),
  }));

  return (
    <div className="flex min-w-0 flex-col h-full overflow-hidden" style={{ background: 'var(--color-bg-chat)' }}>
      {/* Messages */}
      <div className="relative flex flex-1 flex-col gap-3 overflow-y-auto px-5 pt-4 pb-4">
        {messages.length === 0 && !loading && (
          <div
            className="flex-1 flex items-center justify-center text-xs opacity-40 pt-12"
            style={{ color: 'var(--color-text-dim)' }}
          >
            Ask the agent to help with your solution.
          </div>
        )}

        {(() => {
          const rendered: React.ReactNode[] = [];
          let currentGroup: { role: 'user' | 'assistant'; messages: ChatMessage[] } | null = null;

          // Helper to group messages
          for (const msg of messages) {
            if (!currentGroup || currentGroup.role !== msg.role || msg.role === 'user') {
              currentGroup = { role: msg.role, messages: [msg] };
              rendered.push(currentGroup as any); // We'll map this below
            } else {
              currentGroup.messages.push(msg);
            }
          }

          return (rendered as unknown as Array<{ role: 'user' | 'assistant'; messages: ChatMessage[] }>).map((group, groupIdx) => {
            const isUser = group.role === 'user';
            
            if (isUser) {
              const msg = group.messages[0]!;
              return (
                <div key={msg.id} className="flex flex-col py-1">
                  <div
                    className="w-full rounded-[var(--assessment-radius-shell)] px-6 py-4 text-[14px] whitespace-pre-wrap break-words border-none shadow-none"
                    style={{ background: 'var(--color-bg-user-msg)', color: 'var(--color-text-user-msg)' }}
                    data-testid="user-message"
                  >
                    {msg.content}
                  </div>
                </div>
              );
            }

            // Assistant group: extract all tool actions and all content
            const allToolActions: LocalToolAction[] = [];
            const contentBlocks: string[] = [];
            
            for (const msg of group.messages) {
              if (msg.tool_actions) {
                allToolActions.push(...msg.tool_actions);
              }
              
              if (msg.content) {
                const parsed = parseToolUse(msg.content);
                if (parsed.content) contentBlocks.push(parsed.content);
                if (parsed.tool_actions.length > 0) {
                  allToolActions.push(...parsed.tool_actions);
                }
              }
            }

            return (
              <div key={`group-${groupIdx}`} className="flex flex-col gap-1.5 py-1">
                {allToolActions.length > 0 && (
                  <div className="w-full px-1" data-testid="tool-actions-container">
                    <ToolActionCard action={allToolActions} />
                  </div>
                )}
                {contentBlocks.map((content, i) => (
                  <div
                    key={i}
                    className="w-full text-[14px] chat-markdown break-words px-2"
                    style={{ color: 'var(--color-text-agent-msg)' }}
                    data-testid="agent-message"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
                  />
                ))}
                {group.messages.at(-1)?.turnSequence && onCreateBranch ? (
                  <div className="px-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        const name = window.prompt('New branch name');
                        const turnSequence = group.messages.at(-1)?.turnSequence;
                        if (name?.trim() && typeof turnSequence === 'number') {
                          void onCreateBranch(name.trim(), turnSequence);
                        }
                      }}
                      className="text-[11px] opacity-60 transition-opacity hover:opacity-100"
                      style={{ color: 'var(--color-text-main)' }}
                    >
                      Branch from here
                    </button>
                  </div>
                ) : null}
              </div>
            );
          });
        })()}

        {loading && (
          <div className="flex items-start gap-2 py-3">
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
            className="flex items-center gap-3 rounded-[var(--assessment-radius-shell)] px-6 py-4 text-xs"
            style={{ background: 'var(--color-bg-error)', color: 'var(--color-status-error)' }}
          >
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Section */}
      <div className="shrink-0 px-5 pt-4">
        <div
          className="flex flex-col gap-5 rounded-[var(--assessment-radius-shell)] border-none px-5 pt-5 pb-3"
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
            placeholder={
              exhausted
                ? 'Constraints exhausted'
                : mode === 'plan'
                  ? 'Ask the agent to inspect the repo and write a plan...'
                  : 'Tell the agent what to build...'
            }
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
                <span>{agentConfig?.model || modelLabel || 'Configured model'}</span>
                <ChevronDown size={14} />
              </div>
              <div className="flex items-center rounded-full bg-white/5 p-1">
                {(['build', 'plan'] as const).map((option) => {
                  const active = mode === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      data-testid={`mode-toggle-${option}`}
                      onClick={() => onModeChange?.(option)}
                      disabled={loading}
                      className="rounded-[var(--assessment-radius-pill)] px-3 py-1.5 text-[12px] font-semibold transition-colors"
                      style={{
                        background: active ? '#FFFFFF' : 'transparent',
                        color: active ? '#000000' : 'rgba(255,255,255,0.6)',
                        cursor: loading ? 'not-allowed' : 'pointer',
                        opacity: loading ? 0.6 : 1,
                      }}
                    >
                      {option === 'build' ? 'Build' : 'Plan'}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-3">
              {latestPlanPath && onApprovePlan && !loading ? (
                <button
                  type="button"
                  data-testid="approve-plan"
                  onClick={() => void approvePlan()}
                  className="flex items-center justify-center rounded-[var(--assessment-radius-pill)] px-3 py-1.5 text-[12px] font-semibold transition-all hover:scale-[1.03]"
                  style={{
                    background: 'rgba(16,185,129,0.15)',
                    color: '#6EE7B7',
                  }}
                >
                  Approve plan
                </button>
              ) : null}
              {loading ? (
                <button
                  type="button"
                  className="flex h-10 w-10 items-center justify-center rounded-[var(--assessment-radius-pill)] transition-colors hover:bg-red-500/20"
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
                  className="flex items-center justify-center gap-2 rounded-[var(--assessment-radius-pill)] px-3 py-1.5 text-[12px] font-semibold transition-all hover:scale-[1.05]"
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
        className="shrink-0 flex h-12 items-center justify-between gap-4 px-5 border-none"
        style={{ 
          background: 'transparent'
        }}
      >
        <div className="flex min-w-0 flex-1 items-center justify-start gap-4" style={{ color: 'var(--color-text-main)' }}>
          <div className="shrink-0 flex items-center gap-2 opacity-50">
            <span className="text-[12px] font-medium tracking-tight">{constraints.interactionsRemaining} / {constraints.maxInteractions}</span>
            <MessageSquare size={13} />
          </div>
          {branchItems.length > 0 ? (
            <DropdownMenu
              label="Branch selector"
              role="listbox"
              widthClassName="w-auto"
              menuPositionClassName="left-0 bottom-[calc(100%+10px)] min-w-[180px]"
              triggerClassName="chat-inline-menu-trigger flex h-7 items-center justify-center px-1 py-1 text-left"
              itemClassName="chat-inline-menu-item flex w-full items-center justify-between px-3.5 py-2.5 text-left"
              dataTestId="branch-select"
              items={branchItems}
              trigger={(open) => (
                <DropdownTriggerLabel
                  primary={selectedBranch?.name ?? 'main'}
                  open={open}
                  compact
                />
              )}
            />
          ) : null}
          <div className="relative h-7 w-7 shrink-0">
            {checkpointEditing ? (
              <div
                className="chat-inline-editor absolute left-0 top-1/2 z-10 flex w-[248px] -translate-y-1/2 items-center justify-start gap-2 px-2 py-1"
                data-testid="checkpoint-editor"
              >
                <span className="inline-flex shrink-0 items-center opacity-70">
                  <Bookmark size={14} />
                </span>
                <input
                  ref={checkpointInputRef}
                  type="text"
                  value={checkpointName}
                  onChange={(event) => setCheckpointName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleSubmitCheckpoint();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      handleCancelCheckpointEdit();
                    }
                  }}
                  placeholder="Checkpoint name"
                  className="chat-inline-editor-input min-w-0 flex-1 bg-transparent text-[12px] outline-none"
                  style={{ color: 'var(--color-text-main)' }}
                  aria-label="Checkpoint name"
                  data-testid="checkpoint-name-input"
                />
                <button
                  type="button"
                  onClick={handleSubmitCheckpoint}
                  disabled={!checkpointName.trim()}
                  className="chat-inline-icon-button"
                  aria-label="Confirm checkpoint"
                  data-testid="confirm-checkpoint"
                >
                  <Check size={14} />
                </button>
                <button
                  type="button"
                  onClick={handleCancelCheckpointEdit}
                  className="chat-inline-icon-button"
                  aria-label="Cancel checkpoint"
                  data-testid="cancel-checkpoint"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleStartCheckpointEdit}
                className="absolute left-0 top-1/2 flex h-7 -translate-y-1/2 items-center justify-center px-1 py-1 text-left chat-inline-menu-trigger"
                data-testid="save-checkpoint"
                aria-label="Save checkpoint"
              >
                <DropdownTriggerLabel
                  primary=""
                  open={false}
                  compact
                  icon={<Bookmark size={14} />}
                />
              </button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 opacity-70" style={{ color: 'var(--color-text-main)' }}>
          <span className="text-[12px] font-medium tracking-tight">Context</span>
          <div
            className="chat-token-indicator"
            data-testid="token-context-indicator"
            aria-label={`Context: ${Math.round(tokenUsagePct)}% tokens used`}
            title={`Context: ${Math.round(tokenUsagePct)}% tokens used`}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <circle
                cx="10"
                cy="10"
                r={tokenRingRadius}
                fill="none"
                stroke="rgba(255,255,255,0.12)"
                strokeWidth="2.5"
              />
              <circle
                cx="10"
                cy="10"
                r={tokenRingRadius}
                fill="none"
                stroke={isLowTokens ? 'var(--color-status-error)' : 'rgba(229,229,229,0.72)'}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={tokenRingCircumference}
                strokeDashoffset={tokenRingOffset}
                transform="rotate(-90 10 10)"
                style={{ transition: 'stroke-dashoffset 220ms ease, stroke 220ms ease' }}
              />
            </svg>
          </div>
        </div>
      </div>    </div>
  );
}
