import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Download, Moon, Sun, MessageSquare, Code, Activity, User, Terminal } from 'lucide-react';
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

function MetricsStrip({ metrics }: { metrics: ReviewMetric[] }) {
  if (metrics.length === 0) return null;
  return (
    <div
      className="flex shrink-0 border-b"
      style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-panel)' }}
    >
      {metrics.map((metric, i) => {
        const color = METRIC_COLORS[i % METRIC_COLORS.length] ?? '#3887ce';
        const abbrev = getAbbrev(metric.label);
        const pct = Math.round(metric.score * 100);
        return (
          <div
            key={metric.name}
            className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5"
            style={{
              borderRight: i < metrics.length - 1 ? '1px solid var(--color-border-muted)' : undefined,
            }}
          >
            {/* Abbreviation badge */}
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold"
              style={{ background: `${color}1a`, color }}
            >
              {abbrev}
            </div>
            {/* Label + description + bar */}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-1">
                <span
                  className="truncate text-[11px] font-semibold"
                  style={{ color: 'var(--color-text-main)' }}
                >
                  {metric.label}
                </span>
                <span
                  className="shrink-0 text-[12px] font-bold tabular-nums"
                  style={{ color }}
                >
                  {pct}%
                </span>
              </div>
              {metric.details && (
                <div
                  className="truncate text-[10px] leading-none mt-0.5"
                  style={{ color: 'var(--color-text-dimmest)' }}
                >
                  {metric.details}
                </div>
              )}
              {/* Progress bar */}
              <div
                className="mt-1.5 h-[2px] w-full overflow-hidden rounded-full"
                style={{ background: 'rgba(255,255,255,0.06)' }}
              >
                <div
                  className="h-full rounded-full"
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

function isToolEntry(entry: ConversationEntry): boolean {
  return entry.title === 'Tool Call' || entry.title === 'Tool Result';
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
      className="rounded-sm"
      style={{
        opacity: isPast ? 1 : 0.2,
        border: isAnchor ? '1px solid rgba(56,135,206,0.25)' : '1px solid var(--color-border-muted)',
        background: isAnchor ? 'rgba(56,135,206,0.05)' : 'rgba(255,255,255,0.02)',
      }}
    >
      {/* Collapsed header */}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <Terminal size={10} style={{ color: 'var(--color-text-dimmest)', flexShrink: 0 }} />
        <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
          {callCount} tool call{callCount !== 1 ? 's' : ''}
          {calls[0] ? (
            <span className="ml-1.5 font-mono" style={{ color: 'var(--color-text-dimmest)' }}>
              {calls.map((c) => c.name).join(', ')}
            </span>
          ) : null}
        </span>
        {hasErrors && (
          <span className="shrink-0 text-[9px] font-semibold uppercase" style={{ color: 'var(--color-status-error)' }}>
            err
          </span>
        )}
        <ChevronRight
          size={10}
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
          className="flex flex-col overflow-hidden border-t"
          style={{ borderColor: 'var(--color-border-muted)' }}
        >
          {calls.map((call, i) => {
            const result = results[i];
            return (
              <div
                key={i}
                className="grid min-w-0 items-center gap-x-1.5 px-2.5 py-1"
                style={{
                  gridTemplateColumns: '6px auto 1fr auto',
                  borderTop: i > 0 ? '1px solid var(--color-border-muted)' : undefined,
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
                  className="font-mono text-[10px] font-semibold"
                  style={{ color: 'var(--color-brand)' }}
                >
                  {call.name}
                </span>
                {/* Params — fills remaining space, truncates */}
                <span
                  className="min-w-0 truncate font-mono text-[10px]"
                  style={{ color: 'var(--color-text-dimmest)' }}
                >
                  {call.params}
                </span>
                {/* Result summary — pinned right */}
                <span
                  className="font-mono text-[10px] text-right"
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
  const conversationRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const response = await fetch(`${apiBase}/api/review/${sessionId}`);
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
  }, [apiBase, sessionId]);

  const events = useMemo(() => {
    if (!data) return [];
    if (data.recording.events.length > 0) return data.recording.events;
    return synthesizeReplayEventsFromMessages(data.messages, data.session.created_at);
  }, [data]);

  const selectedEvent = events[selectedEventIndex] ?? null;
  const conversationEntries = useMemo(() => buildConversationEntries(events), [events]);
  const conversationItems = useMemo(() => groupConversationEntries(conversationEntries), [conversationEntries]);
  const anchorIndex = useMemo(
    () => getConversationAnchorIndex(conversationEntries, selectedEventIndex),
    [conversationEntries, selectedEventIndex],
  );
  const codeState = useMemo(
    () => buildCodeStateSnapshot(events, selectedEventIndex),
    [events, selectedEventIndex],
  );
  const activeCode = codeState.activePath ? codeState.files[codeState.activePath] ?? '' : '';

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

  useEffect(() => {
    conversationRefs.current[anchorItemIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [anchorItemIndex]);

  if (loading) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3"
        style={{ background: 'var(--color-bg-app)', color: 'var(--color-text-dim)' }}>
        <Activity size={20} className="animate-pulse text-[var(--color-brand)]" />
        <span className="text-[12px]">Loading session…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-screen items-center justify-center px-6"
        style={{ background: 'var(--color-bg-app)' }}>
        <div className="rounded-sm border px-5 py-4 text-[12px]"
          style={{ background: 'var(--color-bg-panel)', borderColor: 'rgba(239,68,68,0.2)', color: 'var(--color-status-error)' }}>
          {error ?? 'Review data unavailable'}
        </div>
      </div>
    );
  }

  const overallScore = data.session.score != null ? formatMetricScore(data.session.score) : '—';

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: 'var(--color-bg-app)' }}>

      {/* ── Topbar ── */}
      <header
        className="flex shrink-0 items-center justify-between border-b px-4"
        style={{ height: '44px', background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-[13px] font-semibold tracking-tight" style={{ color: 'var(--color-text-bold)' }}>
            {data.prompt?.title ?? data.session.prompt_id}
          </span>
          <span style={{ color: 'var(--color-border-main)' }}>·</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <User size={11} style={{ color: 'var(--color-text-dim)' }} />
            <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
              {data.session.candidate_email}
            </span>
          </div>
          <span className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{
              background: data.session.status === 'completed' ? 'rgba(16,185,129,0.1)' : 'rgba(56,135,206,0.1)',
              color: data.session.status === 'completed' ? 'var(--color-status-success)' : 'var(--color-brand)',
            }}>
            {data.session.status}
          </span>
          <span className="shrink-0 text-[13px] font-bold tabular-nums" style={{ color: 'var(--color-brand)' }}>
            {overallScore}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="text-[11px] tabular-nums" style={{ color: 'var(--color-text-dim)' }}>
            {events.length === 0 ? '0/0' : `${selectedEventIndex + 1}/${events.length}`}
          </div>
          <button
            type="button"
            onClick={() => triggerJsonDownload(`review-${sessionId}.json`, data)}
            className="flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-[11px] font-medium"
            style={{ borderColor: 'var(--color-border-main)', color: 'var(--color-text-muted)', background: 'var(--color-bg-app)' }}
          >
            <Download size={11} />
            Export
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            className="flex h-7 w-7 items-center justify-center rounded-sm border"
            style={{ borderColor: 'var(--color-border-main)', color: 'var(--color-text-dim)', background: 'var(--color-bg-app)' }}
          >
            {isDark ? <Sun size={12} /> : <Moon size={12} />}
          </button>
        </div>
      </header>

      {/* ── Timeline strip ── */}
      <div className="shrink-0 border-b px-4 py-2"
        style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-panel)' }}>
        <div className="flex items-center gap-3">
          {selectedEvent ? (
            <span className="shrink-0 text-[10px]" style={{ color: 'var(--color-text-dim)' }}>
              {describeReviewEvent(selectedEvent)} · {formatTimestamp(selectedEvent.timestamp)}
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <Timeline events={events} selectedEventIndex={selectedEventIndex} onSelectEvent={setSelectedEventIndex} />
          </div>
        </div>
      </div>

      {/* ── Metrics strip ── */}
      <MetricsStrip metrics={data.metrics} />

      {/* ── Main content ── */}
      <div className="flex min-h-0 flex-1">

        {/* Conversation */}
        <div className="flex min-h-0 w-[280px] shrink-0 flex-col border-r" style={{ borderColor: 'var(--color-border-main)' }}>
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
            style={{ borderColor: 'var(--color-border-main)' }}>
            <MessageSquare size={12} style={{ color: 'var(--color-brand)' }} />
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
              Conversation
            </span>
          </div>

          <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-2.5 no-scrollbar">
            {conversationItems.map((item, itemIndex) => {
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

              return (
                <motion.div
                  key={entry.id}
                  ref={(node) => { conversationRefs.current[itemIndex] = node; }}
                  initial={false}
                  animate={{ opacity: isPast ? 1 : 0.2 }}
                  className="rounded-sm p-2.5 text-[12px] leading-relaxed"
                  style={{
                    background: isAnchor
                      ? 'rgba(56,135,206,0.08)'
                      : isUser ? 'var(--color-bg-user-msg)' : 'var(--color-bg-agent-msg)',
                    border: isAnchor
                      ? '1px solid rgba(56,135,206,0.25)'
                      : '1px solid var(--color-border-muted)',
                    color: 'var(--color-text-main)',
                  }}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wider"
                      style={{ color: isUser ? 'var(--color-brand)' : 'var(--color-status-success)' }}>
                      {isUser ? 'Candidate' : 'Agent'}
                    </span>
                    <span className="font-mono text-[9px]" style={{ color: 'var(--color-text-dimmest)' }}>
                      {formatTimestamp(entry.timestamp)}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap break-words opacity-90">
                    {entry.body || <span className="italic opacity-40">No text content</span>}
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Code context */}
        <div className="flex min-h-0 flex-1 flex-col" style={{ borderRight: '1px solid var(--color-border-main)' }}>
          <div className="flex min-h-0 flex-1 flex-col border-b" style={{ borderColor: 'var(--color-border-main)' }}>
            <div className="flex shrink-0 items-center justify-between border-b px-3 py-2"
              style={{ borderColor: 'var(--color-border-main)' }}>
              <div className="flex items-center gap-2">
                <Code size={12} style={{ color: 'var(--color-text-dim)' }} />
                <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                  Snapshot
                </span>
              </div>
              {codeState.activePath && (
                <span className="font-mono text-[10px]" style={{ color: 'var(--color-text-dimmest)' }}>
                  {codeState.activePath}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3" style={{ background: 'var(--color-bg-code)' }}>
              <AnimatePresence mode="wait">
                <motion.pre
                  key={(codeState.activePath ?? 'null') + selectedEventIndex}
                  data-testid="code-state-content"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed"
                  style={{ color: 'var(--color-text-main)' }}
                >
                  {activeCode || 'No code snapshot for this event.'}
                </motion.pre>
              </AnimatePresence>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
              style={{ borderColor: 'var(--color-border-main)' }}>
              <Activity size={12} style={{ color: 'var(--color-text-dim)' }} />
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                Diff
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3" style={{ background: 'var(--color-bg-code)' }}>
              <AnimatePresence mode="wait">
                <motion.pre
                  key={(codeState.activePath ?? 'null') + '-diff-' + selectedEventIndex}
                  data-testid="code-state-diff"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed"
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
                    <span className="italic" style={{ color: 'var(--color-text-dimmest)' }}>
                      No diff for this event.
                    </span>
                  )}
                </motion.pre>
              </AnimatePresence>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
