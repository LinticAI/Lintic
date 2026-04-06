import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Download, Moon, Sun, MessageSquare, Code, Activity, User, Terminal, ChevronDown, ChevronUp, Info, Zap, Cpu, LifeBuoy, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  buildCodeStateSnapshot,
  buildConversationEntries,
  describeReviewEvent,
  formatMetricScore,
  getConversationAnchorIndex,
  synthesizeReplayEventsFromMessages,
  type ConversationEntry,
  type ReviewDataPayload,
  type ReviewMetric,
} from '../lib/review-replay.js';
import { Timeline } from './Timeline.js';
import { DropdownMenu, DropdownTriggerLabel } from './DropdownMenu.js';
import { SplitPane } from './SplitPane.js';

interface ReviewDashboardProps {
  sessionId: string;
  apiBase?: string;
  isDark: boolean;
  onToggleTheme: () => void;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function triggerJsonDownload(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ── Tool call formatting helpers ────────────────────────────────────────────

/** Parse a tool call body like "run_command {\"command\": \"ls\"}" */
function parseToolCallBody(body: string): Array<{ name: string; params: string }> {
  return body.split('\n').filter(Boolean).reduce<Array<{ name: string; params: string }>>((acc, line) => {
    const space = line.indexOf(' ');
    if (space === -1) {
      acc.push({ name: line, params: '' });
      return acc;
    }
    const name = line.slice(0, space);
    const jsonStr = line.slice(space + 1);
    try {
      const input = JSON.parse(jsonStr) as Record<string, unknown>;
      // Compact: show the most meaningful key-value pairs
      const entries = Object.entries(input).slice(0, 2);
      const params = entries
        .map(([k, v]) => {
          const val = String(v);
          // Truncate long values (e.g. file content)
          return `${k}=${val.length > 40 ? val.slice(0, 40) + '…' : val}`;
        })
        .join('  ');
      acc.push({ name, params });
    } catch {
      acc.push({ name, params: jsonStr.slice(0, 50) });
    }
    return acc;
  }, []);
}

/** Parse a tool result body like "run_command\n{output json}" */
function parseToolResultBody(body: string): Array<{ name: string; summary: string; isError: boolean }> {
  const blocks = body.split('\n\n').filter(Boolean);
  return blocks.map((block) => {
    const firstNewline = block.indexOf('\n');
    const name = firstNewline === -1 ? block : block.slice(0, firstNewline);
    const outputStr = firstNewline === -1 ? '' : block.slice(firstNewline + 1);
    let summary = '';
    let isError = false;
    try {
      const parsed = JSON.parse(outputStr) as Record<string, unknown>;
      if (typeof parsed['exit_code'] === 'number') {
        const code = parsed['exit_code'] as number;
        isError = code !== 0;
        const out = typeof parsed['output'] === 'string' ? (parsed['output'] as string).trim() : '';
        summary = `exit ${code}${out ? ` · ${out.slice(0, 50)}` : ''}`;
      } else if (typeof parsed['status'] === 'string') {
        summary = parsed['status'] as string;
        isError = parsed['status'] === 'error';
      } else if (typeof parsed['is_error'] === 'boolean') {
        isError = parsed['is_error'] as boolean;
        summary = isError ? 'error' : 'ok';
      } else {
        summary = outputStr.slice(0, 60).replace(/\n/g, ' ');
      }
    } catch {
      isError = outputStr.toLowerCase().includes('error');
      summary = outputStr.slice(0, 60).replace(/\n/g, ' ');
    }
    return { name, summary, isError };
  });
}

// ── Metrics strip ───────────────────────────────────────────────────────────

const METRIC_COLORS = [
  '#3887ce', // orange
  '#3B82F6', // blue
  '#10B981', // green
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // purple
];

function getAbbrev(label: string): string {
  return label
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);
}

const METRIC_DESCRIPTIONS: Record<string, string> = {
  'Iteration Efficiency': 'Measures the ratio of productive steps to total steps. Higher means more focused work.',
  'Token Efficiency': 'Measures result quality relative to LLM token consumption. Higher means better use of AI resources.',
  'Independence Ratio': 'Percentage of code and logic driven by the candidate rather than automated agent suggestions.',
  'Recovery Score': 'Capability to identify, debug, and fix errors encountered during the development process.',
};

const METRIC_ICONS: Record<string, React.ElementType> = {
  'Iteration Efficiency': Zap,
  'Token Efficiency': Cpu,
  'Independence Ratio': User,
  'Recovery Score': LifeBuoy,
};

function MetricsStrip({ metrics, expanded }: { metrics: ReviewMetric[]; expanded: boolean }) {
  if (metrics.length === 0) return null;
  return (
    <div
      className="flex shrink-0 gap-[5px] p-[5px]"
      style={{ background: 'var(--color-bg-app)' }}
    >
      {metrics.map((metric, i) => {
        const color = METRIC_COLORS[i % METRIC_COLORS.length] ?? '#3887ce';
        const Icon = METRIC_ICONS[metric.label] || Activity;
        const pct = Math.round(metric.score * 100);
        const description = METRIC_DESCRIPTIONS[metric.label];

        return (
          <div
            key={metric.name}
            className="flex min-w-0 flex-1 items-start gap-2.5 px-4 py-3 rounded-xl transition-all duration-300"
            style={{ background: 'var(--color-bg-panel)' }}
          >
            {/* Icon badge */}
            <div
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
              style={{ background: `${color}1a`, color }}
            >
              <Icon size={14} strokeWidth={2.5} />
            </div>
            {/* Label + details + bar */}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-1">
                <span
                  className="truncate text-[12px] font-semibold"
                  style={{ color: 'var(--color-text-main)' }}
                >
                  {metric.label}
                </span>
                <span
                  className="shrink-0 text-[13px] font-bold tabular-nums"
                  style={{ color }}
                >
                  {pct}%
                </span>
              </div>

              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0, marginTop: 0 }}
                    animate={{ height: 'auto', opacity: 1, marginTop: 4 }}
                    exit={{ height: 0, opacity: 0, marginTop: 0 }}
                    transition={{ duration: 0.25, ease: 'easeInOut' }}
                    className="overflow-hidden"
                  >
                    <div className="flex flex-col gap-1.5 pb-1">
                      {description && (
                        <p className="text-[11px] leading-snug opacity-40">
                          {description}
                        </p>
                      )}
                      {metric.details && (
                        <p className="text-[11px] font-medium leading-tight opacity-80" style={{ color: 'var(--color-text-dim)' }}>
                          {metric.details}
                        </p>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Progress bar */}
              <div
                className="mt-2 h-[3px] w-full overflow-hidden rounded-full"
                style={{ background: 'rgba(255,255,255,0.06)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${pct}%`, background: color }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Grouping logic ──────────────────────────────────────────────────────────

type ConversationItem =
  | { kind: 'message'; entry: ConversationEntry }
  | { kind: 'toolGroup'; id: string; entries: ConversationEntry[]; eventIndex: number; timestamp: number };

interface RewindBlock {
  kind: 'rewindBlock';
  id: string;
  insertAfterTimestamp: number;
  messages: Array<{
    id: number;
    role: string;
    content: string;
    created_at: number;
  }>;
}

function isToolEntry(entry: ConversationEntry): boolean {
  return entry.title === 'Tool Call' || entry.title === 'Tool Result';
}

function computeRewindBlocks(
  rawMessages: NonNullable<ReviewDataPayload['raw_messages']>,
): RewindBlock[] {
  const blocks: RewindBlock[] = [];
  let currentBlock: RewindBlock | null = null;
  let lastNonRewoundTimestamp = 0;

  for (const msg of rawMessages) {
    if (msg.rewound_at !== null) {
      if (!currentBlock) {
        currentBlock = {
          kind: 'rewindBlock',
          id: `rewind-${msg.id}`,
          insertAfterTimestamp: lastNonRewoundTimestamp,
          messages: [],
        };
      }
      currentBlock.messages.push({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        created_at: msg.created_at,
      });
      continue;
    }

    if (currentBlock) {
      blocks.push(currentBlock);
      currentBlock = null;
    }
    lastNonRewoundTimestamp = msg.created_at;
  }

  if (currentBlock) {
    blocks.push(currentBlock);
  }

  return blocks;
}

function groupConversationEntries(entries: ConversationEntry[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (!entry) { i++; continue; }
    if (isToolEntry(entry)) {
      const group: ConversationEntry[] = [];
      while (i < entries.length) {
        const e = entries[i];
        if (!e || !isToolEntry(e)) break;
        group.push(e);
        i++;
      }
      const first = group[0];
      if (first) {
        items.push({ kind: 'toolGroup', id: first.id, entries: group, eventIndex: first.eventIndex, timestamp: first.timestamp });
      }
    } else {
      items.push({ kind: 'message', entry });
      i++;
    }
  }
  return items;
}

// ── ToolGroup component ─────────────────────────────────────────────────────

function ToolGroup({
  group,
  isPast,
  isAnchor,
}: {
  group: Extract<ConversationItem, { kind: 'toolGroup' }>;
  isPast: boolean;
  isAnchor: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const callEntries = group.entries.filter((e) => e.title === 'Tool Call');
  const resultEntries = group.entries.filter((e) => e.title === 'Tool Result');

  const calls = callEntries.flatMap((e) => parseToolCallBody(e.body));
  const results = resultEntries.flatMap((e) => parseToolResultBody(e.body));

  const hasErrors = results.some((r) => r.isError);
  const callCount = calls.length;

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        opacity: isPast ? 1 : 0.2,
        background: isAnchor ? 'rgba(56,135,206,0.05)' : 'rgba(255,255,255,0.02)',
      }}
    >
      {/* Collapsed header */}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <Terminal size={12} style={{ color: 'var(--color-text-dimmest)', flexShrink: 0 }} />
        <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
          {callCount} tool call{callCount !== 1 ? 's' : ''}
          {calls[0] ? (
            <span className="ml-1.5 font-mono" style={{ color: 'var(--color-text-dimmest)' }}>
              {calls.map((c) => c.name).join(', ')}
            </span>
          ) : null}
        </span>
        {hasErrors && (
          <span className="shrink-0 text-[10px] font-semibold" style={{ color: 'var(--color-status-error)' }}>
            Error
          </span>
        )}
        <ChevronRight
          size={12}
          style={{
            color: 'var(--color-text-dimmest)',
            flexShrink: 0,
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms ease',
          }}
        />
      </button>

      {/* Expanded detail — one line per tool call */}
      {expanded && (
        <div
          className="flex flex-col overflow-hidden px-3 pb-2"
        >
          {calls.map((call, i) => {
            const result = results[i];
            return (
              <div
                key={i}
                className="grid min-w-0 items-center gap-x-2 py-1"
                style={{
                  gridTemplateColumns: '8px auto 1fr auto',
                }}
              >
                {/* Status dot */}
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    background: result
                      ? result.isError ? 'var(--color-status-error)' : 'var(--color-status-success)'
                      : 'rgba(255,255,255,0.2)',
                  }}
                />
                {/* Tool name */}
                <span
                  className="font-mono text-[11px] font-semibold"
                  style={{ color: 'var(--color-brand)' }}
                >
                  {call.name}
                </span>
                {/* Params — fills remaining space, truncates */}
                <span
                  className="min-w-0 truncate font-mono text-[11px]"
                  style={{ color: 'var(--color-text-dimmest)' }}
                >
                  {call.params}
                </span>
                {/* Result summary — pinned right */}
                <span
                  className="font-mono text-[11px] text-right"
                  style={{ color: result?.isError ? 'var(--color-status-error)' : 'var(--color-text-dimmest)' }}
                >
                  {result?.summary ?? ''}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Agent Message Component (Minimizeable) ──────────────────────────────────

function AgentMessage({
  entry,
  isPast,
  isAnchor,
}: {
  entry: ConversationEntry;
  isPast: boolean;
  isAnchor: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="rounded-xl p-3 text-[13px] leading-relaxed transition-all"
      style={{
        opacity: isPast ? 1 : 0.2,
        background: isAnchor
          ? 'rgba(56,135,206,0.08)'
          : 'var(--color-bg-agent-msg)',
        color: 'var(--color-text-main)',
      }}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <Activity size={12} style={{ color: 'var(--color-status-success)' }} />
          <span className="text-[11px] font-semibold" style={{ color: 'var(--color-status-success)' }}>
            Agent
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px]" style={{ color: 'var(--color-text-dimmest)' }}>
            {formatTimestamp(entry.timestamp)}
          </span>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex h-5 w-5 items-center justify-center rounded-xl hover:bg-white/5 transition-colors"
            style={{ color: 'var(--color-text-dim)' }}
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="whitespace-pre-wrap break-words opacity-90">
          {entry.body || <span className="italic opacity-40">No text content</span>}
        </div>
      ) : (
        <div className="truncate text-[11px] opacity-60 italic">
          {entry.body ? entry.body.slice(0, 80) + (entry.body.length > 80 ? '...' : '') : 'Empty response'}
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function ReviewDashboard({
  sessionId,
  apiBase = '',
  isDark,
  onToggleTheme,
}: ReviewDashboardProps) {
  const [data, setData] = useState<ReviewDataPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedEventIndex, setSelectedEventIndex] = useState(0);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [showMetricDetails, setShowMetricDetails] = useState(false);
  const [expandedRewindBlocks, setExpandedRewindBlocks] = useState<Set<string>>(new Set());
  const conversationRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const branchQuery = activeBranchId ? `?branch_id=${encodeURIComponent(activeBranchId)}` : '';
        const response = await fetch(`${apiBase}/api/review/${sessionId}${branchQuery}`);
        if (!response.ok) {
          const body = await response.json() as { error?: string };
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        const payload = await response.json() as ReviewDataPayload;
        if (!cancelled) {
          const initialEvents = payload.recording.events.length > 0
            ? payload.recording.events
            : synthesizeReplayEventsFromMessages(payload.messages, payload.session.created_at);
          setData(payload);
          setActiveBranchId((current) => current ?? payload.branch?.id ?? payload.branches?.[0]?.id ?? null);
          setSelectedEventIndex(Math.max(0, initialEvents.length - 1));
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : 'Failed to load review');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeBranchId, apiBase, sessionId]);

  const events = useMemo(() => {
    if (!data) return [];
    if (data.recording.events.length > 0) return data.recording.events;
    return synthesizeReplayEventsFromMessages(data.messages, data.session.created_at);
  }, [data]);

  const selectedEvent = events[selectedEventIndex] ?? null;
  const conversationEntries = useMemo(() => buildConversationEntries(events), [events]);
  const conversationItems = useMemo(() => groupConversationEntries(conversationEntries), [conversationEntries]);
  const rewindBlocks = useMemo(
    () => computeRewindBlocks(data?.raw_messages ?? []),
    [data],
  );
  const anchorIndex = useMemo(
    () => getConversationAnchorIndex(conversationEntries, selectedEventIndex),
    [conversationEntries, selectedEventIndex],
  );
  const codeState = useMemo(
    () => buildCodeStateSnapshot(events, selectedEventIndex),
    [events, selectedEventIndex],
  );
  const effectiveCodeState = useMemo(() => {
    if (Object.keys(codeState.files).length > 0 || !data?.workspace_snapshot) {
      return codeState;
    }

    const files = Object.fromEntries(
      data.workspace_snapshot.filesystem
        .filter((file) => file.encoding === 'utf-8')
        .map((file) => [file.path, file.content]),
    );

    return {
      files,
      activePath: data.workspace_snapshot.active_path ?? Object.keys(files)[0] ?? null,
      diff: null,
    };
  }, [codeState, data]);
  const activeCode = effectiveCodeState.activePath ? effectiveCodeState.files[effectiveCodeState.activePath] ?? '' : '';

  // Map from ConversationEntry index to ConversationItem index for anchor tracking
  const anchorItemIndex = useMemo(() => {
    let entryCount = 0;
    for (let i = 0; i < conversationItems.length; i++) {
      const item = conversationItems[i];
      if (!item) continue;
      const entriesInItem = item.kind === 'toolGroup' ? item.entries.length : 1;
      if (entryCount + entriesInItem > anchorIndex) return i;
      entryCount += entriesInItem;
    }
    return conversationItems.length - 1;
  }, [conversationItems, anchorIndex]);

  const renderItems = useMemo(() => {
    const items: Array<
      | { kind: 'conversation'; item: ConversationItem; itemIndex: number }
      | { kind: 'rewind'; block: RewindBlock }
    > = [];
    let rewindIndex = 0;

    const pushPendingBlocks = (nextTimestamp: number) => {
      while (rewindIndex < rewindBlocks.length) {
        const block = rewindBlocks[rewindIndex];
        if (!block || block.insertAfterTimestamp >= nextTimestamp) {
          break;
        }
        items.push({ kind: 'rewind', block });
        rewindIndex += 1;
      }
    };

    conversationItems.forEach((item, itemIndex) => {
      const itemTimestamp = item.kind === 'toolGroup' ? item.timestamp : item.entry.timestamp;
      pushPendingBlocks(itemTimestamp);
      items.push({ kind: 'conversation', item, itemIndex });
    });

    while (rewindIndex < rewindBlocks.length) {
      const block = rewindBlocks[rewindIndex];
      if (!block) {
        break;
      }
      items.push({ kind: 'rewind', block });
      rewindIndex += 1;
    }

    return items;
  }, [conversationItems, rewindBlocks]);

  useEffect(() => {
    conversationRefs.current[anchorItemIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [anchorItemIndex]);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3"
        style={{ background: 'var(--color-bg-app)', color: 'var(--color-text-dim)' }}>
        <Activity size={24} className="animate-pulse text-[var(--color-brand)]" />
        <span className="text-[13px] font-medium">Loading session review…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-full items-center justify-center px-6"
        style={{ background: 'var(--color-bg-app)' }}>
        <div className="rounded-xl px-6 py-5 text-[14px] text-center max-w-md"
          style={{ background: 'var(--color-bg-panel)', color: 'var(--color-status-error)' }}>
          <div className="font-bold mb-2">Error</div>
          {error ?? 'Review data unavailable'}
        </div>
      </div>
    );
  }

  const overallScore = data.session.score != null ? formatMetricScore(data.session.score) : '—';

  const branchItems = (data.branches ?? []).map((branch) => ({
    value: branch.id,
    label: branch.name,
    selected: branch.id === (activeBranchId ?? data.branch?.id),
    onSelect: () => setActiveBranchId(branch.id),
  }));

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--color-bg-app)' }}>

      {/* ── Topbar ── */}
      <header
        className="flex shrink-0 items-center justify-between px-5"
        style={{ height: '52px', background: 'var(--color-bg-app)' }}
      >
        <div className="flex min-w-0 items-center gap-4">
          <span className="truncate text-[15px] font-bold tracking-tight" style={{ color: 'var(--color-text-bold)' }}>
            {data.prompt?.title ?? data.session.prompt_id}
          </span>
          <div className="flex shrink-0 items-center gap-1.5 opacity-60">
            <User size={12} style={{ color: 'var(--color-text-dim)' }} />
            <span className="text-[13px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
              {data.session.candidate_email}
            </span>
          </div>
          <span className="shrink-0 rounded-xl px-2.5 py-1 text-[11px] font-bold"
            style={{
              background: data.session.status === 'completed' ? 'rgba(16,185,129,0.1)' : 'rgba(56,135,206,0.1)',
              color: data.session.status === 'completed' ? 'var(--color-status-success)' : 'var(--color-brand)',
            }}>
            {data.session.status}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-4">
          <button
            type="button"
            onClick={() => setShowMetricDetails(!showMetricDetails)}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-semibold transition-colors hover:bg-white/5"
            style={{ color: showMetricDetails ? 'var(--color-brand)' : 'var(--color-text-muted)' }}
            title="Show metric details"
          >
            <Info size={14} />
            Details
          </button>
          {branchItems.length > 0 ? (
            <DropdownMenu
              label="Branch selector"
              role="listbox"
              widthClassName="w-auto"
              triggerClassName="flex h-8 items-center justify-center px-2 py-1 text-left rounded-xl hover:bg-white/5 transition-colors"
              items={branchItems}
              trigger={(open) => (
                <DropdownTriggerLabel
                  primary={branchItems.find(i => i.selected)?.label ?? 'main'}
                  open={open}
                  compact
                />
              )}
            />
          ) : null}
          <div className="text-[12px] tabular-nums font-medium opacity-60" style={{ color: 'var(--color-text-dim)' }}>
            {events.length === 0 ? '0/0' : `${selectedEventIndex + 1}/${events.length}`}
          </div>
          <button
            type="button"
            onClick={() => triggerJsonDownload(`review-${sessionId}.json`, data)}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-semibold transition-colors hover:bg-white/5"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Download size={13} />
            Export
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            className="flex h-8 w-8 items-center justify-center rounded-xl transition-colors hover:bg-white/5"
            style={{ color: 'var(--color-text-dim)' }}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
      </header>

      {/* ── Metrics strip (Top) ── */}
      <MetricsStrip metrics={data.metrics} expanded={showMetricDetails} />

      {/* ── Timeline strip ── */}
      <div className="shrink-0 px-5 py-3 mb-2"
        style={{ background: 'var(--color-bg-app)' }}>
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <Timeline 
              events={events} 
              selectedEventIndex={selectedEventIndex} 
              onSelectEvent={setSelectedEventIndex} 
              markerIndices={conversationEntries.filter(e => e.title === 'You').map(e => e.eventIndex)}
            />
          </div>
          {selectedEvent ? (
            <span className="shrink-0 text-[11px] font-medium opacity-60" style={{ color: 'var(--color-text-dim)' }}>
              {formatTimestamp(selectedEvent.timestamp)}
            </span>
          ) : null}
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="flex min-h-0 flex-1 p-[5px] pt-0">
        <SplitPane
          orientation="horizontal"
          initialPct={25}
          minPct={15}
          maxPct={45}
          left={
            /* Conversation */
            <div className="flex h-full flex-col rounded-xl overflow-hidden" style={{ background: 'var(--color-bg-panel)' }}>
              <div className="flex shrink-0 items-center gap-2 px-4 py-3">
                <MessageSquare size={14} style={{ color: 'var(--color-brand)' }} />
                <span className="text-[12px] font-bold" style={{ color: 'var(--color-text-dim)' }}>
                  Conversation
                </span>
              </div>

              <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3 no-scrollbar">
                {renderItems.map((renderItem) => {
                  if (renderItem.kind === 'rewind') {
                    const { block } = renderItem;
                    const isExpanded = expandedRewindBlocks.has(block.id);

                    return (
                      <div
                        key={block.id}
                        className="overflow-hidden rounded-xl border border-white/8"
                        style={{ background: 'rgba(255,255,255,0.02)' }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedRewindBlocks((prev) => {
                              const next = new Set(prev);
                              if (next.has(block.id)) {
                                next.delete(block.id);
                              } else {
                                next.add(block.id);
                              }
                              return next;
                            });
                          }}
                          className="flex w-full items-center justify-between px-4 py-2.5 text-left transition hover:bg-white/4"
                          style={{ color: 'var(--color-text-dim)' }}
                        >
                          <div className="flex items-center gap-2 text-[11px] font-medium">
                            <RotateCcw size={12} />
                            <span>Rewound here</span>
                            <span className="opacity-55">
                              {block.messages.length} {block.messages.length === 1 ? 'message' : 'messages'} hidden
                            </span>
                          </div>
                          <ChevronDown
                            size={13}
                            style={{
                              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                              transition: 'transform 160ms ease',
                            }}
                          />
                        </button>

                        {isExpanded ? (
                          <div className="space-y-3 border-t border-white/8 px-4 py-3">
                            {block.messages.map((message) => (
                              <div key={message.id} className="text-[12px]" style={{ color: 'var(--color-text-dim)' }}>
                                <div className="mb-1 flex items-center gap-2">
                                  <span className="font-medium" style={{ color: 'var(--color-text-dimmest)' }}>
                                    {message.role === 'user' ? 'You' : 'Agent'}
                                  </span>
                                  <span className="font-mono text-[10px]" style={{ color: 'var(--color-text-dimmest)' }}>
                                    {formatTimestamp(message.created_at)}
                                  </span>
                                </div>
                                <div className="whitespace-pre-wrap break-words opacity-75">
                                  {message.content.slice(0, 200)}
                                  {message.content.length > 200 ? '…' : ''}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  }

                  const { item, itemIndex } = renderItem;
                  const itemEventIndex = item.kind === 'toolGroup' ? item.eventIndex : item.entry.eventIndex;
                  const isPast = itemEventIndex <= selectedEventIndex;
                  const isAnchor = itemIndex === anchorItemIndex;

                  if (item.kind === 'toolGroup') {
                    return (
                      <div key={item.id} ref={(node) => { conversationRefs.current[itemIndex] = node; }}>
                        <ToolGroup group={item} isPast={isPast} isAnchor={isAnchor} />
                      </div>
                    );
                  }

                  const { entry } = item;
                  const isUser = entry.title === 'You';

                  if (!isUser) {
                    return (
                      <div key={entry.id} ref={(node) => { conversationRefs.current[itemIndex] = node; }}>
                        <AgentMessage entry={entry} isPast={isPast} isAnchor={isAnchor} />
                      </div>
                    );
                  }

                  return (
                    <motion.div
                      key={entry.id}
                      ref={(node) => { conversationRefs.current[itemIndex] = node; }}
                      initial={false}
                      animate={{ opacity: isPast ? 1 : 0.2 }}
                      className="rounded-xl p-4 text-[14px] leading-relaxed transition-all"
                      style={{
                        background: isAnchor
                          ? 'rgba(56,135,206,0.12)'
                          : 'var(--color-bg-user-msg)',
                        color: 'var(--color-text-main)',
                      }}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <User size={13} style={{ color: 'var(--color-brand)' }} />
                          <span className="text-[12px] font-bold" style={{ color: 'var(--color-brand)' }}>
                            Candidate
                          </span>
                        </div>
                        <span className="font-mono text-[10px]" style={{ color: 'var(--color-text-dimmest)' }}>
                          {formatTimestamp(entry.timestamp)}
                        </span>
                      </div>
                      <div className="whitespace-pre-wrap break-words opacity-95">
                        {entry.body || <span className="italic opacity-40">No text content</span>}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          }
          right={
            /* Code context */
            <SplitPane
              orientation="vertical"
              initialPct={65}
              minPct={30}
              maxPct={85}
              left={
                /* Snapshot */
                <div className="flex h-full flex-col rounded-xl overflow-hidden" style={{ background: 'var(--color-bg-panel)' }}>
                  <div className="flex shrink-0 items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Code size={14} style={{ color: 'var(--color-text-dim)' }} />
                      <span className="text-[12px] font-bold" style={{ color: 'var(--color-text-dim)' }}>
                        Snapshot
                      </span>
                    </div>
                    {effectiveCodeState.activePath && (
                      <span className="font-mono text-[11px] opacity-50" style={{ color: 'var(--color-text-dim)' }}>
                        {effectiveCodeState.activePath}
                      </span>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto p-4" style={{ background: 'var(--color-bg-code)' }}>
                    <AnimatePresence mode="wait">
                      <motion.pre
                        key={(effectiveCodeState.activePath ?? 'null') + selectedEventIndex}
                        data-testid="code-state-content"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed"
                        style={{ color: 'var(--color-text-main)' }}
                      >
                        {activeCode || 'No code snapshot for this event.'}
                      </motion.pre>
                    </AnimatePresence>
                  </div>
                </div>
              }
              right={
                /* Diff */
                <div className="flex h-full flex-col rounded-xl overflow-hidden" style={{ background: 'var(--color-bg-panel)' }}>
                  <div className="flex shrink-0 items-center gap-2 px-4 py-3">
                    <Activity size={14} style={{ color: 'var(--color-text-dim)' }} />
                    <span className="text-[12px] font-bold" style={{ color: 'var(--color-text-dim)' }}>
                      Diff
                    </span>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto p-4" style={{ background: 'var(--color-bg-code)' }}>
                    <AnimatePresence mode="wait">
                      <motion.pre
                        key={(effectiveCodeState.activePath ?? 'null') + '-diff-' + selectedEventIndex}
                        data-testid="code-state-diff"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed"
                      >
                        {codeState.diff ? (
                          codeState.diff.split('\n').map((line, i) => (
                            <div key={i} style={{
                              color: line.startsWith('+') ? 'var(--color-status-success)'
                                : line.startsWith('-') ? 'var(--color-status-error)'
                                : 'var(--color-text-dimmest)',
                            }}>
                              {line}
                            </div>
                          ))
                        ) : (
                          <span className="italic opacity-30" style={{ color: 'var(--color-text-dim)' }}>
                            No diff for this event.
                          </span>
                        )}
                      </motion.pre>
                    </AnimatePresence>
                  </div>
                </div>
              }
            />
          }
        />
      </div>
    </div>
  );
}
