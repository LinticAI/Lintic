import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Download, Moon, Sun, MessageSquare, Code, Activity, User, Terminal, ChevronDown, ChevronUp, Info, Zap, Cpu, LifeBuoy, FlaskConical, Database, Shield, BarChart2, GitBranch, Navigation, Layers, Clock, Loader, RotateCcw, CheckCircle2 } from 'lucide-react';
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
  type ReviewEvaluationResult,
  type ReviewMetric,
  type ReviewSessionEvaluation,
} from '../lib/review-replay.js';
import type { SessionReviewStatus } from '@lintic/core';
import { Timeline } from './Timeline.js';
import { DropdownMenu, DropdownTriggerLabel } from './DropdownMenu.js';
import { SplitPane } from './SplitPane.js';

interface ReviewDashboardProps {
  sessionId: string;
  apiBase?: string;
  isDark: boolean;
  onToggleTheme: () => void;
  reviewStatus?: SessionReviewStatus | null;
  onReviewStatusChange?: (status: Extract<SessionReviewStatus, 'viewed' | 'passed'>) => Promise<void> | void;
}

// ─── Evaluation types ───────────────────────────────────────────────────────

type EvaluationResult = ReviewEvaluationResult;
type SessionEvaluation = ReviewSessionEvaluation;
type InfraMetricScore = EvaluationResult['infrastructure']['caching_effectiveness'];
type EvaluatorDimensionScore = EvaluationResult['llm_evaluation']['scores'][number];
type AcceptanceCriterionResult = NonNullable<EvaluationResult['llm_evaluation']['acceptance_criteria_results']>[number];
type RubricQuestionScore = NonNullable<EvaluationResult['llm_evaluation']['rubric_scores']>[number];
type Iteration = EvaluationResult['iterations'][number];

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatReviewStatus(status: SessionReviewStatus): string {
  if (status === 'passed') return 'Passed';
  if (status === 'viewed') return 'Viewed';
  return 'Unviewed';
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

// ── Infrastructure + LLM Scorecard panel ───────────────────────────────────

const RUBRIC_ICONS: Record<string, React.ElementType> = {
  prompt_quality: MessageSquare,
  technical_direction: Database,
  iterative_problem_solving: GitBranch,
  debugging_diagnosis: FlaskConical,
  robustness_edge_cases: Shield,
};

function InfraScoreRow({ metric }: { metric: InfraMetricScore }) {
  const pct = Math.round(metric.score * 100);
  const color = metric.score >= 0.7 ? '#10B981' : metric.score >= 0.4 ? '#F59E0B' : '#EF4444';
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="w-44 shrink-0 text-[12px] font-medium" style={{ color: 'var(--color-text-dim)' }}>
        {metric.label}
      </span>
      <div className="flex flex-1 items-center gap-2">
        <div className="h-[4px] flex-1 overflow-hidden rounded-full" style={{ background: 'var(--color-surface-muted)' }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        </div>
        <span className="w-9 shrink-0 text-right text-[12px] font-bold tabular-nums" style={{ color }}>
          {pct}%
        </span>
      </div>
      <span className="hidden text-[11px] opacity-40 xl:block truncate max-w-[200px]" style={{ color: 'var(--color-text-dim)' }}>
        {metric.details}
      </span>
    </div>
  );
}

function LlmScoreRow({ score }: { score: EvaluatorDimensionScore }) {
  const [open, setOpen] = useState(false);
  const Icon = RUBRIC_ICONS[score.dimension] ?? BarChart2;
  const color = score.score >= 7 ? '#10B981' : score.score >= 4 ? '#F59E0B' : '#EF4444';
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'var(--color-surface-subtle)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <Icon size={13} style={{ color, flexShrink: 0 }} />
        <span className="flex-1 text-[12px] font-semibold truncate" style={{ color: 'var(--color-text-main)' }}>
          {score.label}
        </span>
        <span className="shrink-0 text-[14px] font-bold tabular-nums" style={{ color }}>
          {score.score.toFixed(1)}<span className="text-[10px] opacity-50">/10</span>
        </span>
        <ChevronRight size={12} style={{ color: 'var(--color-text-dimmest)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }} />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0 text-[12px] leading-relaxed opacity-70" style={{ color: 'var(--color-text-dim)' }}>
          {score.rationale}
        </div>
      )}
    </div>
  );
}

function AcceptanceCriterionRow({ criterion }: { criterion: AcceptanceCriterionResult }) {
  const [open, setOpen] = useState(false);
  const color = criterion.score >= 80 ? '#10B981' : criterion.score >= 50 ? '#F59E0B' : '#EF4444';
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'var(--color-surface-subtle)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <div className="h-[4px] w-16 shrink-0 overflow-hidden rounded-full" style={{ background: 'var(--color-surface-muted)' }}>
          <div className="h-full rounded-full" style={{ width: `${criterion.score}%`, background: color }} />
        </div>
        <span className="flex-1 text-[12px] font-medium truncate" style={{ color: 'var(--color-text-main)' }}>
          {criterion.criterion}
        </span>
        <span className="shrink-0 text-[13px] font-bold tabular-nums" style={{ color }}>
          {criterion.score}<span className="text-[10px] opacity-50">%</span>
        </span>
        <ChevronRight size={12} style={{ color: 'var(--color-text-dimmest)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }} />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0 text-[12px] leading-relaxed opacity-70" style={{ color: 'var(--color-text-dim)' }}>
          {criterion.rationale}
        </div>
      )}
    </div>
  );
}

function RubricQuestionRow({ item }: { item: RubricQuestionScore }) {
  const [open, setOpen] = useState(false);
  const color = item.score >= 7 ? '#10B981' : item.score >= 4 ? '#F59E0B' : '#EF4444';
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'var(--color-surface-subtle)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <BarChart2 size={13} style={{ color, flexShrink: 0 }} />
        <span className="flex-1 text-[12px] font-medium truncate" style={{ color: 'var(--color-text-main)' }}>
          {item.question}
        </span>
        <span className="shrink-0 text-[14px] font-bold tabular-nums" style={{ color }}>
          {item.score.toFixed(1)}<span className="text-[10px] opacity-50">/10</span>
        </span>
        <ChevronRight size={12} style={{ color: 'var(--color-text-dimmest)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }} />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0 text-[12px] leading-relaxed opacity-70" style={{ color: 'var(--color-text-dim)' }}>
          {item.rationale}
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({ icon: Icon, label, children, defaultOpen = true }: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-2 flex w-full items-center gap-2 text-left"
      >
        <Icon size={13} style={{ color: 'var(--color-text-dimmest)' }} />
        <span className="flex-1 text-[11px] font-bold uppercase tracking-wider opacity-40" style={{ color: 'var(--color-text-dim)' }}>
          {label}
        </span>
        <ChevronRight size={11} style={{ color: 'var(--color-text-dimmest)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease', opacity: 0.4 }} />
      </button>
      {open && children}
    </div>
  );
}

interface QAEntry {
  question: string;
  answer: string | null; // null while loading
}

function EvaluationPanel({ result, sessionId, apiBase }: {
  result: EvaluationResult;
  sessionId: string;
  apiBase: string;
}) {
  const [showInfra, setShowInfra] = useState(false);
  const [qaEntries, setQaEntries] = useState<QAEntry[]>([]);
  const [qaInput, setQaInput] = useState('');
  const [qaLoading, setQaLoading] = useState(false);
  const rewindCount = result.iterations.filter((it) => it.rewound_at !== undefined).length;

  const handleAsk = async () => {
    const q = qaInput.trim();
    if (!q || qaLoading) return;
    setQaInput('');
    setQaLoading(true);
    setQaEntries((prev) => [...prev, { question: q, answer: null }]);
    try {
      const resp = await fetch(`${apiBase}/api/sessions/${sessionId}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await resp.json() as { answer?: string; error?: string };
      const answer = resp.ok ? (data.answer ?? '') : (data.error ?? 'Error getting answer');
      setQaEntries((prev) => prev.map((e) => e.question === q && e.answer === null ? { ...e, answer } : e));
    } catch {
      setQaEntries((prev) => prev.map((e) => e.question === q && e.answer === null ? { ...e, answer: 'Failed to reach server' } : e));
    } finally {
      setQaLoading(false);
    }
  };
  const infraScores = [
    result.infrastructure.caching_effectiveness,
    result.infrastructure.error_handling_coverage,
    result.infrastructure.scaling_awareness,
  ];
  return (
    <div className="flex flex-col gap-4">
      {/* Reviewer Q&A */}
      <div className="pt-1">
        <div className="mb-2 flex items-center gap-2">
          <MessageSquare size={13} style={{ color: 'var(--color-text-dimmest)' }} />
          <span className="text-[11px] font-bold uppercase tracking-wider opacity-40" style={{ color: 'var(--color-text-dim)' }}>
            Ask about this candidate
          </span>
        </div>

        {/* Previous Q&A pairs */}
        {qaEntries.length > 0 && (
          <div className="mb-3 flex flex-col gap-3">
            {qaEntries.map((entry, i) => (
              <div key={i} className="flex flex-col gap-1">
                <div className="flex items-start gap-2">
                  <User size={11} className="mt-0.5 shrink-0 opacity-40" style={{ color: 'var(--color-text-dim)' }} />
                  <span className="text-[12px] font-medium" style={{ color: 'var(--color-text-main)' }}>
                    {entry.question}
                  </span>
                </div>
                <div className="flex items-start gap-2 pl-1">
                  <FlaskConical size={11} className="mt-0.5 shrink-0 opacity-40" style={{ color: 'var(--color-brand)' }} />
                  {entry.answer === null ? (
                    <span className="flex items-center gap-1.5 text-[12px] opacity-40" style={{ color: 'var(--color-text-dim)' }}>
                      <Loader size={11} className="animate-spin" />
                      Thinking…
                    </span>
                  ) : (
                    <span className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text-dim)' }}>
                      {entry.answer}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'var(--color-surface-subtle)', border: '1px solid var(--color-surface-muted)' }}>
          <input
            type="text"
            value={qaInput}
            onChange={(e) => setQaInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleAsk(); }}
            placeholder="Did the candidate plan before coding?"
            disabled={qaLoading}
            className="flex-1 bg-transparent text-[12px] outline-none placeholder:opacity-25 disabled:opacity-40"
            style={{ color: 'var(--color-text-main)' }}
          />
          <button
            type="button"
            onClick={() => void handleAsk()}
            disabled={!qaInput.trim() || qaLoading}
            className="shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-opacity disabled:opacity-30"
            style={{ background: 'var(--color-brand)', color: '#fff' }}
          >
            Ask
          </button>
        </div>
      </div>

      {/* Summary */}
      <p className="text-[12px] leading-relaxed italic" style={{ color: 'var(--color-text-dim)' }}>
        {result.llm_evaluation.overall_summary}
      </p>

      {/* Iterations */}
      <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--color-text-dimmest)' }}>
        <GitBranch size={12} />
        <span>{result.iterations.length} iteration{result.iterations.length !== 1 ? 's' : ''}</span>
        {rewindCount > 0 && (
          <span className="rounded-xl px-1.5 py-0.5" style={{ background: 'rgba(245,158,11,0.1)', color: '#F59E0B' }}>
            {rewindCount} rewound
          </span>
        )}
      </div>

      {/* LLM Dimensions */}
      <CollapsibleSection icon={FlaskConical} label="Collaboration Quality">
        <div className="flex flex-col gap-1">
          {result.llm_evaluation.scores.map((s) => <LlmScoreRow key={s.dimension} score={s} />)}
        </div>
      </CollapsibleSection>

      {/* Acceptance Criteria */}
      {result.llm_evaluation.acceptance_criteria_results && result.llm_evaluation.acceptance_criteria_results.length > 0 && (() => {
        const avg = Math.round(result.llm_evaluation.acceptance_criteria_results.reduce((sum, c) => sum + c.score, 0) / result.llm_evaluation.acceptance_criteria_results.length);
        const avgColor = avg >= 80 ? '#10B981' : avg >= 50 ? '#F59E0B' : '#EF4444';
        return (
          <CollapsibleSection icon={Activity} label={`Acceptance Criteria · avg ${avg}%`}>
            <div className="flex flex-col gap-1">
              {result.llm_evaluation.acceptance_criteria_results.map((c, i) => (
                <AcceptanceCriterionRow key={i} criterion={c} />
              ))}
            </div>
          </CollapsibleSection>
        );
      })()}

      {/* Rubric Questions */}
      {result.llm_evaluation.rubric_scores && result.llm_evaluation.rubric_scores.length > 0 && (() => {
        const defaultQuestions = result.llm_evaluation.rubric_scores!.filter((q) => q.is_default);
        const customQuestions = result.llm_evaluation.rubric_scores!.filter((q) => !q.is_default);
        return (
          <CollapsibleSection icon={Info} label="Rubric Questions">
            <>
              {defaultQuestions.length > 0 && (
                <div className="mb-3">
                  <div className="mb-1.5 text-[10px] uppercase tracking-wider opacity-30" style={{ color: 'var(--color-text-dim)' }}>
                    Default
                  </div>
                  <div className="flex flex-col gap-1">
                    {defaultQuestions.map((q, i) => <RubricQuestionRow key={`default-${i}`} item={q} />)}
                  </div>
                </div>
              )}
              {customQuestions.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wider opacity-30" style={{ color: 'var(--color-text-dim)' }}>
                    Custom
                  </div>
                  <div className="flex flex-col gap-1">
                    {customQuestions.map((q, i) => <RubricQuestionRow key={`custom-${i}`} item={q} />)}
                  </div>
                </div>
              )}
            </>
          </CollapsibleSection>
        );
      })()}

      {/* Infrastructure — hidden by default */}
      {showInfra ? (
        <CollapsibleSection icon={Database} label="Infrastructure" defaultOpen>
          <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-border-main)' }}>
            {infraScores.map((m) => <InfraScoreRow key={m.name} metric={m} />)}
          </div>
        </CollapsibleSection>
      ) : (
        <button
          type="button"
          onClick={() => setShowInfra(true)}
          className="text-left text-[11px] opacity-30 hover:opacity-60 transition-opacity"
          style={{ color: 'var(--color-text-dim)' }}
        >
          Show infrastructure metrics
        </button>
      )}

    </div>
  );
}

// ── Session Stats strip ──────────────────────────────────────────────────────

interface StatCard {
  icon: React.ElementType;
  label: string;
  value: string;
  detail: string;
  pct: number;   // 0–100 for the progress bar, -1 to hide bar
  color: string;
}

function buildSessionStats(session: ReviewDataPayload['session']): StatCard[] {
  const tokenPct = session.constraint.max_session_tokens > 0
    ? Math.round((session.tokens_used / session.constraint.max_session_tokens) * 100)
    : 0;
  const tokenColor = tokenPct >= 80 ? '#EF4444' : tokenPct >= 50 ? '#F59E0B' : '#10B981';

  const interactionPct = session.constraint.max_interactions > 0
    ? Math.round((session.interactions_used / session.constraint.max_interactions) * 100)
    : 0;
  const interactionColor = interactionPct >= 80 ? '#EF4444' : interactionPct >= 50 ? '#F59E0B' : '#10B981';

  const startMs = session.created_at;
  const endMs = session.closed_at ?? Date.now();
  const durationMs = Math.max(0, endMs - startMs);
  const durationMin = Math.round(durationMs / 60000);
  const timeLimitMin = session.constraint.time_limit_minutes;
  const timePct = timeLimitMin > 0 ? Math.min(100, Math.round((durationMin / timeLimitMin) * 100)) : 0;
  const timeColor = timePct >= 90 ? '#EF4444' : timePct >= 60 ? '#F59E0B' : '#3B82F6';
  const durationStr = durationMin >= 60
    ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
    : `${durationMin}m`;

  const hasScore = session.score != null;
  const scorePct = hasScore ? Math.round(session.score! * 100) : 0;
  const scoreColor = scorePct >= 70 ? '#10B981' : scorePct >= 40 ? '#F59E0B' : '#EF4444';

  return [
    {
      icon: Zap,
      label: 'Token Budget',
      value: `${tokenPct}%`,
      detail: `${session.tokens_used.toLocaleString()} / ${session.constraint.max_session_tokens.toLocaleString()} tokens`,
      pct: tokenPct,
      color: tokenColor,
    },
    {
      icon: MessageSquare,
      label: 'Interactions',
      value: `${interactionPct}%`,
      detail: `${session.interactions_used} / ${session.constraint.max_interactions} messages`,
      pct: interactionPct,
      color: interactionColor,
    },
    {
      icon: Clock,
      label: 'Time Used',
      value: durationStr,
      detail: `of ${timeLimitMin} min limit`,
      pct: timePct,
      color: timeColor,
    },
    {
      icon: Activity,
      label: 'Score',
      value: hasScore ? `${scorePct}%` : '—',
      detail: hasScore ? 'session analysis average' : 'run evaluation to score',
      pct: hasScore ? scorePct : -1,
      color: hasScore ? scoreColor : 'var(--color-text-dimmest)',
    },
  ];
}

function SessionStatsStrip({ session }: { session: ReviewDataPayload['session'] }) {
  const stats = buildSessionStats(session);
  return (
    <div
      className="flex shrink-0 gap-[5px] p-[5px]"
      style={{ background: 'var(--color-bg-app)' }}
    >
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div
            key={stat.label}
            className="flex min-w-0 flex-1 items-start gap-2.5 px-4 py-3 rounded-xl"
            style={{ background: 'var(--color-bg-panel)' }}
          >
            <div
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
              style={{ background: `${stat.color}1a`, color: stat.color }}
            >
              <Icon size={14} strokeWidth={2.5} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-1">
                <span className="truncate text-[12px] font-semibold" style={{ color: 'var(--color-text-main)' }}>
                  {stat.label}
                </span>
                <span className="shrink-0 text-[13px] font-bold tabular-nums" style={{ color: stat.color }}>
                  {stat.value}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-snug opacity-40 truncate">
                {stat.detail}
              </p>
              {stat.pct >= 0 && (
                <div
                  className="mt-2 h-[3px] w-full overflow-hidden rounded-full"
                  style={{ background: 'var(--color-surface-muted)' }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${stat.pct}%`, background: stat.color }}
                  />
                </div>
              )}
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
        background: isAnchor ? 'rgba(56,135,206,0.05)' : 'var(--color-surface-subtle)',
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
                      : 'var(--color-surface-muted)',
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
            className="flex h-5 w-5 items-center justify-center rounded-xl transition-colors hover:bg-[var(--color-surface-subtle)]"
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
  reviewStatus = null,
  onReviewStatusChange,
}: ReviewDashboardProps) {
  const [data, setData] = useState<ReviewDataPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedEventIndex, setSelectedEventIndex] = useState(0);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [evaluationResult, setEvaluationResult] = useState<EvaluationResult | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [showEvaluation, setShowEvaluation] = useState(false);
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const [expandedRewindBlocks, setExpandedRewindBlocks] = useState<Set<string>>(new Set());
  const [updatingReviewStatus, setUpdatingReviewStatus] = useState(false);

  // Reset branch and evaluation state when the session changes
  useEffect(() => {
    setActiveBranchId(null);
    setData(null);
    setEvaluationResult(null);
    setShowEvaluation(false);
    setAnalysisCollapsed(false);
  }, [sessionId]);
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
          // Stale branch ID from a previous session → reset and retry without it
          if (response.status === 404 && activeBranchId) {
            if (!cancelled) setActiveBranchId(null);
            return;
          }
          const body = await response.json() as { error?: string };
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        const payload = await response.json() as ReviewDataPayload;
        if (!cancelled) {
          const initialEvents = payload.recording.events.length > 0
            ? payload.recording.events
            : synthesizeReplayEventsFromMessages(payload.messages, payload.session.created_at);
          setData(payload);
          if (payload.evaluation) {
            setEvaluationResult(payload.evaluation.result);
            setShowEvaluation(true);
          }
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

  const handleAnalyzeSession = async () => {
    if (evaluating) return;
    setEvaluating(true);
    setEvaluationError(null);
    setShowEvaluation(true);
    try {
      const response = await fetch(`${apiBase}/api/sessions/${sessionId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const body = await response.json() as { error?: string };
          if (body.error) message = body.error;
        } catch { /* response body was not JSON */ }
        throw new Error(message);
      }
      const evaluation = await response.json() as SessionEvaluation;
      setEvaluationResult(evaluation.result);
      setData((prev) => prev ? {
        ...prev,
        session: {
          ...prev.session,
          score: evaluation.score,
        },
        evaluation,
      } : prev);
    } catch (err) {
      setEvaluationError(err instanceof Error ? err.message : 'Evaluation failed');
    } finally {
      setEvaluating(false);
    }
  };

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

  const handleReviewStatusChange = async (status: 'viewed' | 'passed') => {
    if (!onReviewStatusChange || updatingReviewStatus) return;
    setUpdatingReviewStatus(true);
    try {
      await onReviewStatusChange(status);
    } finally {
      setUpdatingReviewStatus(false);
    }
  };

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

  const sessionAnalysisAverage = data.session.score != null ? formatMetricScore(data.session.score) : null;

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
        <div className="min-w-0">
          <span className="block truncate text-[15px] font-bold tracking-tight" style={{ color: 'var(--color-text-bold)' }}>
            {data.prompt?.title ?? data.session.prompt_id}
          </span>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] opacity-70">
            <span className="flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
              <User size={12} style={{ color: 'var(--color-text-dim)' }} />
              {data.session.candidate_email}
            </span>
            <span style={{ color: 'var(--color-text-dim)' }}>
              Session: {data.session.status}
            </span>
            {reviewStatus ? (
              <span style={{ color: 'var(--color-text-dim)' }}>
                Review status: {formatReviewStatus(reviewStatus)}
              </span>
            ) : null}
            {sessionAnalysisAverage ? (
              <span style={{ color: 'var(--color-text-dim)' }}>
                Session analysis average: {sessionAnalysisAverage}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-4">
          {onReviewStatusChange ? (
            <button
              type="button"
              disabled={updatingReviewStatus}
              onClick={() => {
                void handleReviewStatusChange(reviewStatus === 'passed' ? 'viewed' : 'passed');
              }}
              className="flex items-center gap-2 rounded-xl px-4 py-2 text-[12px] font-bold transition-all shadow-sm hover:shadow-md active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: reviewStatus === 'passed' 
                  ? 'var(--color-bg-app)' 
                  : 'var(--color-status-success)',
                color: reviewStatus === 'passed' 
                  ? 'var(--color-text-muted)' 
                  : 'white',
                border: reviewStatus === 'passed'
                  ? '1px solid var(--color-border-main)'
                  : 'none'
              }}
            >
              {updatingReviewStatus ? (
                <Loader size={14} className="animate-spin" />
              ) : reviewStatus === 'passed' ? (
                <>
                  <RotateCcw size={14} />
                  Mark Viewed
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} />
                  Mark Passed
                </>
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => { void handleAnalyzeSession(); }}
            disabled={evaluating}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-semibold transition-colors hover:bg-[var(--color-surface-subtle)] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ color: showEvaluation ? 'var(--color-brand)' : 'var(--color-text-muted)' }}
            title="Run LLM evaluation and compute infrastructure metrics"
          >
            {evaluating
              ? <Loader size={14} className="animate-spin" />
              : <FlaskConical size={14} />}
            Analyze Session
          </button>
          {branchItems.length > 0 ? (
            <DropdownMenu
              label="Branch selector"
              role="listbox"
              widthClassName="w-auto"
              triggerClassName="flex h-8 items-center justify-center rounded-xl px-2 py-1 text-left transition-colors hover:bg-[var(--color-surface-subtle)]"
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
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-semibold transition-colors hover:bg-[var(--color-surface-subtle)]"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Download size={13} />
            Export
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            className="flex h-8 w-8 items-center justify-center rounded-xl transition-colors hover:bg-[var(--color-surface-subtle)]"
            style={{ color: 'var(--color-text-dim)' }}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
      </header>

      {/* ── Session stats strip (Top) ── */}
      <SessionStatsStrip session={data.session} />

      {/* ── Evaluation Panel ── */}
      {showEvaluation && (
        <div
          className="shrink-0 px-[5px] pb-[5px]"
          style={{ background: 'var(--color-bg-app)' }}
        >
          <div className="rounded-xl" style={{ background: 'var(--color-bg-panel)' }}>
            {/* Panel header — always visible, click to collapse */}
            <button
              type="button"
              onClick={() => setAnalysisCollapsed((v) => !v)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left"
            >
              <FlaskConical size={14} style={{ color: 'var(--color-brand)' }} />
              <span className="flex-1 text-[12px] font-bold" style={{ color: 'var(--color-text-dim)' }}>
                Session Analysis
              </span>
              {evaluating && <Loader size={13} className="animate-spin opacity-50" />}
              <ChevronDown
                size={13}
                style={{
                  color: 'var(--color-text-dimmest)',
                  transform: analysisCollapsed ? 'rotate(0deg)' : 'rotate(180deg)',
                  transition: 'transform 160ms ease',
                  opacity: 0.5,
                }}
              />
            </button>

            {/* Panel body */}
            {!analysisCollapsed && (
              <div className="overflow-y-auto max-h-[38vh] px-4 pb-4">
                {evaluating && (
                  <div className="flex items-center gap-2 py-3 text-[12px]" style={{ color: 'var(--color-text-dimmest)' }}>
                    <Loader size={14} className="animate-spin" />
                    Running LLM evaluation…
                  </div>
                )}
                {evaluationError && !evaluating && (
                  <div className="text-[12px] py-2" style={{ color: 'var(--color-status-error)' }}>
                    {evaluationError}
                  </div>
                )}
                {evaluationResult && !evaluating && (
                  <EvaluationPanel result={evaluationResult} sessionId={sessionId} apiBase={apiBase} />
                )}
              </div>
            )}
          </div>
        </div>
      )}

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
                        style={{ background: 'var(--color-surface-subtle)' }}
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
