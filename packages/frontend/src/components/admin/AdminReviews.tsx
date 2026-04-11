import { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { fetchAdminJson, useAdminKey } from './AdminKeyContext.js';
import type { AdminAssessmentLinksResponse, AdminAssessmentLinkSummary } from '@lintic/core';
import { ReviewDashboard } from '../ReviewDashboard.js';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

interface AdminReviewsProps {
  initialSessionId?: string | null;
  isDark: boolean;
  onToggleTheme: () => void;
}

export function AdminReviews({ initialSessionId, isDark, onToggleTheme }: AdminReviewsProps) {
  const { adminKey } = useAdminKey();
  const [links, setLinks] = useState<AdminAssessmentLinkSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(initialSessionId ?? null);

  useEffect(() => {
    if (initialSessionId) setReviewId(initialSessionId);
  }, [initialSessionId]);

  function load() {
    if (!adminKey) return;
    setLoading(true);
    setError(null);
    fetchAdminJson<AdminAssessmentLinksResponse>('/api/links', adminKey)
      .then((r) => setLinks(r.links))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [adminKey]);

  const consumed = links.filter((l) => l.consumed_session_id);

  if (reviewId) {
    return (
      <div className="flex h-full flex-col">
        <div
          className="flex shrink-0 items-center gap-3 px-5 py-2.5"
        >
          <button
            type="button"
            className="flex items-center gap-1.5 text-[12px] transition-colors"
            style={{ color: 'var(--color-text-dim)' }}
            onClick={() => setReviewId(null)}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-main)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-dim)'; }}
          >
            <ArrowLeft size={12} />
            Back to reviews
          </button>
          <span style={{ color: 'var(--color-text-dimmest)' }}>·</span>
          <span className="font-mono text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
            {reviewId}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ReviewDashboard
            sessionId={reviewId}
            isDark={isDark}
            onToggleTheme={onToggleTheme}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-[13px] font-semibold" style={{ color: 'var(--color-text-bold)' }}>Reviews</h2>
          <p className="text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
            Completed assessment sessions
          </p>
        </div>
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

      {error ? (
        <div className="mb-4 rounded-xl px-3 py-2.5 text-[12px]" style={{ background: 'rgba(239,68,68,0.06)', color: 'var(--color-status-error)' }}>
          {error}
        </div>
      ) : null}

      {!adminKey ? (
        <div className="rounded-xl px-4 py-6 text-center text-[12px]" style={{ background: 'var(--color-bg-panel)', color: 'var(--color-text-dim)' }}>
          Enter your admin key in Settings to view reviews.
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
                {['Candidate', 'Task', 'Session ID', 'Consumed', ''].map((col, i) => (
                  <th
                    key={i}
                    className="px-4 py-3 text-[10px] font-semibold tracking-wider"
                    style={{ color: 'var(--color-text-dim)' }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-transparent">
              {consumed.length === 0 && !loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>
                    No completed assessments yet.
                  </td>
                </tr>
              ) : null}
              {consumed.map((link) => (
                <tr
                  key={link.id}
                  className="hover:bg-[var(--color-bg-app)]/50 transition-colors even:bg-[var(--color-bg-app)]/20"
                >
                  <td className="px-4 py-2" style={{ color: 'var(--color-text-main)' }}>
                    {link.candidate_email}
                  </td>
                  <td className="px-4 py-2">
                    <div style={{ color: 'var(--color-text-muted)' }}>{link.prompt?.title ?? link.prompt_id}</div>
                    <div className="font-mono text-[10px]" style={{ color: 'var(--color-text-dimmest)' }}>{link.prompt_id}</div>
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
                    {link.consumed_session_id?.slice(0, 12)}…
                  </td>
                  <td className="px-4 py-2" style={{ color: 'var(--color-text-dim)' }}>
                    {link.created_at ? relativeTime(link.created_at) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      className="rounded-xl px-2.5 py-1 text-[11px] font-medium transition-colors"
                      style={{ background: 'rgba(56,135,206,0.1)', color: 'var(--color-brand)' }}
                      onClick={() => setReviewId(link.consumed_session_id!)}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(56,135,206,0.18)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(56,135,206,0.1)'; }}
                    >
                      Open Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
