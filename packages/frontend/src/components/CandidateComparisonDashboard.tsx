import { useEffect, useMemo, useState } from 'react';
import { ArrowUpDown, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { fetchAdminJson, useAdminKey } from './admin/AdminKeyContext.js';
import type { ComparisonResponse, ComparisonSessionRow } from '@lintic/core';

type SortColumn =
  | 'candidate_email'
  | 'prompt_title'
  | 'date'
  | 'composite_score'
  | 'ie'
  | 'te'
  | 'rs'
  | 'ir'
  | 'pq'
  | 'cc';

const PAGE_SIZE = 25;

interface ColumnDef {
  key: SortColumn;
  label: string;
  title?: string;
}

const COLUMNS: ColumnDef[] = [
  { key: 'candidate_email', label: 'Candidate' },
  { key: 'prompt_title', label: 'Prompt' },
  { key: 'date', label: 'Date' },
  { key: 'composite_score', label: 'Score', title: 'Composite Score (weighted average)' },
  { key: 'ie', label: 'IE', title: 'Iteration Efficiency' },
  { key: 'te', label: 'TE', title: 'Token Efficiency' },
  { key: 'rs', label: 'RS', title: 'Recovery Score' },
  { key: 'ir', label: 'IR', title: 'Independence Ratio' },
  { key: 'pq', label: 'PQ', title: 'Problem Decomposition (LLM eval)' },
  { key: 'cc', label: 'CC', title: 'Context Management (LLM eval)' },
];

function fmtMetric(v: number | null): string {
  if (v === null) return '—';
  return `${Math.round(v * 100)}%`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

interface CandidateComparisonDashboardProps {
  isDark: boolean;
  onToggleTheme: () => void;
}

export function CandidateComparisonDashboard({ isDark, onToggleTheme }: CandidateComparisonDashboardProps) {
  const { adminKey } = useAdminKey();

  const [sessions, setSessions] = useState<ComparisonSessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [promptFilter, setPromptFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<'7d' | '30d' | 'all'>('all');
  const [sortColumn, setSortColumn] = useState<SortColumn>('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  function load() {
    if (!adminKey) return;
    setLoading(true);
    setError(null);
    fetchAdminJson<ComparisonResponse>('/api/sessions/comparison', adminKey)
      .then((data) => setSessions(data.sessions))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [adminKey]);

  const promptOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of sessions) {
      if (!seen.has(s.prompt_id)) seen.set(s.prompt_id, s.prompt_title);
    }
    return Array.from(seen.entries()).map(([id, title]) => ({ id, title }));
  }, [sessions]);

  const filtered = useMemo(() => {
    let result = sessions;
    if (dateFilter !== 'all') {
      const cutoff = Date.now() - (dateFilter === '7d' ? 7 : 30) * 86_400_000;
      result = result.filter((s) => s.date >= cutoff);
    }
    if (promptFilter !== 'all') {
      result = result.filter((s) => s.prompt_id === promptFilter);
    }
    return result;
  }, [sessions, dateFilter, promptFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = a[sortColumn];
      const bv = b[sortColumn];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      let cmp: number;
      if (typeof av === 'string' && typeof bv === 'string') {
        cmp = av.localeCompare(bv);
      } else {
        cmp = (av as number) - (bv as number);
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paged = useMemo(
    () => sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sorted, page],
  );

  function handleSort(col: SortColumn) {
    if (sortColumn === col) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(col);
      setSortDirection('desc');
    }
    setPage(1);
  }

  function handleRowClick(sessionId: string) {
    window.history.pushState({}, '', `/review/${sessionId}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  function handlePromptFilter(id: string) {
    setPromptFilter(id);
    setPage(1);
  }

  function handleDateFilter(d: '7d' | '30d' | 'all') {
    setDateFilter(d);
    setPage(1);
  }

  return (
    <div
      className="flex flex-col h-screen overflow-hidden"
      style={{ background: 'var(--color-bg-app)', color: 'var(--color-text-main)' }}
    >
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-5 py-3 border-b shrink-0"
        style={{ borderColor: 'var(--color-text-dimmest)', background: 'var(--color-bg-panel)' }}
      >
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-semibold" style={{ color: 'var(--color-text-bold)' }}>
            Candidate Comparison
          </span>
          <span className="text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
            {filtered.length} session{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              window.history.pushState({}, '', '/admin');
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
            className="text-[11px] px-2 py-1 rounded-xl"
            style={{ color: 'var(--color-text-dim)', background: 'transparent' }}
          >
            Admin
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            className="text-[11px] px-2 py-1 rounded-xl"
            style={{ color: 'var(--color-text-dim)', background: 'transparent' }}
          >
            {isDark ? 'Light' : 'Dark'}
          </button>
        </div>
      </div>

      {/* Filter toolbar */}
      <div
        className="flex items-center gap-3 px-5 py-2.5 shrink-0 border-b"
        style={{ borderColor: 'var(--color-text-dimmest)' }}
      >
        {/* Prompt filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
            PROMPT
          </span>
          <select
            value={promptFilter}
            onChange={(e) => handlePromptFilter(e.target.value)}
            className="rounded-xl px-2 py-1 text-[11px]"
            style={{ background: 'var(--color-bg-panel)', color: 'var(--color-text-muted)', border: '1px solid var(--color-text-dimmest)', outline: 'none' }}
          >
            <option value="all">All prompts</option>
            {promptOptions.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
        </div>

        {/* Date range */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-semibold tracking-wider mr-1" style={{ color: 'var(--color-text-dim)' }}>
            DATE
          </span>
          {(['7d', '30d', 'all'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => handleDateFilter(d)}
              className="rounded-xl px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={{
                background: dateFilter === d ? 'rgba(56,135,206,0.15)' : 'var(--color-bg-panel)',
                color: dateFilter === d ? 'var(--color-brand)' : 'var(--color-text-muted)',
              }}
            >
              {d === '7d' ? '7 days' : d === '30d' ? '30 days' : 'All time'}
            </button>
          ))}
        </div>

        <div className="ml-auto">
          <button
            type="button"
            onClick={load}
            disabled={!adminKey || loading}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
            style={{ color: 'var(--color-text-muted)', background: 'var(--color-bg-panel)' }}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto p-5">
        {error ? (
          <div
            className="mb-4 rounded-xl px-3 py-2.5 text-[12px]"
            style={{ background: 'rgba(239,68,68,0.06)', color: 'var(--color-status-error)' }}
          >
            {error}
          </div>
        ) : null}

        {!adminKey ? (
          <div
            className="rounded-xl px-4 py-10 text-center text-[12px]"
            style={{ background: 'var(--color-bg-panel)', color: 'var(--color-text-dim)' }}
          >
            Enter your admin key in{' '}
            <button
              type="button"
              className="underline"
              style={{ color: 'var(--color-brand)' }}
              onClick={() => {
                window.history.pushState({}, '', '/admin');
                window.dispatchEvent(new PopStateEvent('popstate'));
              }}
            >
              Admin Settings
            </button>{' '}
            to view the candidate comparison dashboard.
          </div>
        ) : (
          <div
            className="rounded-xl overflow-hidden"
            style={{ background: 'var(--color-bg-panel)' }}
          >
            <div className="overflow-x-auto">
            <table className="min-w-full text-left text-[12px]">
              <thead>
                <tr>
                  {COLUMNS.map((col) => {
                    const active = sortColumn === col.key;
                    return (
                      <th
                        key={col.key}
                        title={col.title}
                        className="px-4 py-3 text-[10px] font-semibold tracking-wider cursor-pointer select-none whitespace-nowrap"
                        style={{ color: active ? 'var(--color-brand)' : 'var(--color-text-dim)' }}
                        onClick={() => handleSort(col.key)}
                      >
                        <span className="flex items-center gap-1">
                          {col.label}
                          {active ? (
                            sortDirection === 'asc' ? (
                              <ChevronUp size={10} />
                            ) : (
                              <ChevronDown size={10} />
                            )
                          ) : (
                            <ArrowUpDown size={10} style={{ opacity: 0.35 }} />
                          )}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-transparent">
                {loading ? (
                  <tr>
                    <td colSpan={COLUMNS.length} className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>
                      Loading…
                    </td>
                  </tr>
                ) : paged.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMNS.length} className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>
                      No completed sessions found.
                    </td>
                  </tr>
                ) : (
                  paged.map((row) => (
                    <tr
                      key={row.session_id}
                      className="hover:bg-[var(--color-bg-app)]/50 transition-colors even:bg-[var(--color-bg-app)]/20 cursor-pointer"
                      onClick={() => handleRowClick(row.session_id)}
                    >
                      <td className="px-4 py-2.5" style={{ color: 'var(--color-text-main)' }}>
                        {row.candidate_email}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--color-text-muted)' }}>
                        {row.prompt_title}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--color-text-dim)' }}>
                        {fmtDate(row.date)}
                      </td>
                      <td className="px-4 py-2.5 font-medium" style={{ color: row.composite_score !== null ? 'var(--color-text-bold)' : 'var(--color-text-dimmest)' }}>
                        {fmtMetric(row.composite_score)}
                      </td>
                      <td className="px-4 py-2.5 font-mono" style={{ color: row.ie !== null ? 'var(--color-text-main)' : 'var(--color-text-dimmest)' }}>
                        {fmtMetric(row.ie)}
                      </td>
                      <td className="px-4 py-2.5 font-mono" style={{ color: row.te !== null ? 'var(--color-text-main)' : 'var(--color-text-dimmest)' }}>
                        {fmtMetric(row.te)}
                      </td>
                      <td className="px-4 py-2.5 font-mono" style={{ color: row.rs !== null ? 'var(--color-text-main)' : 'var(--color-text-dimmest)' }}>
                        {fmtMetric(row.rs)}
                      </td>
                      <td className="px-4 py-2.5 font-mono" style={{ color: row.ir !== null ? 'var(--color-text-main)' : 'var(--color-text-dimmest)' }}>
                        {fmtMetric(row.ir)}
                      </td>
                      <td className="px-4 py-2.5 font-mono" style={{ color: 'var(--color-text-dimmest)' }}>
                        {fmtMetric(row.pq)}
                      </td>
                      <td className="px-4 py-2.5 font-mono" style={{ color: 'var(--color-text-dimmest)' }}>
                        {fmtMetric(row.cc)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div
                className="flex items-center justify-between px-4 py-3 border-t text-[11px]"
                style={{ borderColor: 'var(--color-text-dimmest)', color: 'var(--color-text-dim)' }}
              >
                <span>
                  Page {page} of {totalPages} · {sorted.length} result{sorted.length !== 1 ? 's' : ''}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="rounded-xl px-3 py-1 font-medium disabled:opacity-40"
                    style={{ background: 'var(--color-bg-app)', color: 'var(--color-text-muted)' }}
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="rounded-xl px-3 py-1 font-medium disabled:opacity-40"
                    style={{ background: 'var(--color-bg-app)', color: 'var(--color-text-muted)' }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
