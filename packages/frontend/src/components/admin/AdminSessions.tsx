import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fetchAdminJson, useAdminKey } from './AdminKeyContext.js';
import type { AdminAssessmentLinksResponse, AdminAssessmentLinkSummary } from '@lintic/core';
import { getAssessmentDisplayStatus } from './assessment-status.js';

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

const STATUS_DOT: Record<string, string> = {
  active: 'var(--color-brand)',
  consumed: 'var(--color-status-success)',
  expired: 'var(--color-status-warning)',
  invalid: 'var(--color-status-error)',
};

interface AdminSessionsProps {
  onNavigate: (section: string, id?: string) => void;
}

export function AdminSessions({ onNavigate }: AdminSessionsProps) {
  const { adminKey } = useAdminKey();
  const [links, setLinks] = useState<AdminAssessmentLinkSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const activeSessions = links.filter((l) => getAssessmentDisplayStatus(l) === 'in_progress');

  return (
    <div className="flex flex-col gap-0 p-5">
      {/* Topbar */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-[13px] font-semibold" style={{ color: 'var(--color-text-bold)' }}>Live Sessions</h2>
          <p className="text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
            Active and recently consumed assessment links
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
          Enter your admin key in Settings to view sessions.
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
                {['Candidate', 'Task', 'Status', 'Created', 'Session', 'Actions'].map((col) => (
                  <th
                    key={col}
                    className="px-4 py-3 text-[10px] font-semibold tracking-wider"
                    style={{ color: 'var(--color-text-dim)' }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-transparent">
              {activeSessions.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>
                    No active sessions.
                  </td>
                </tr>
              ) : null}
              {activeSessions.map((link) => (
                <tr
                  key={link.id}
                  className="hover:bg-[var(--color-bg-app)]/50 transition-colors even:bg-[var(--color-bg-app)]/20"
                >
                  <td className="px-4 py-2" style={{ color: 'var(--color-text-main)' }}>
                    {link.candidate_email}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    {link.prompt_id}
                  </td>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: STATUS_DOT[link.status] ?? 'var(--color-text-dimmest)' }}
                      />
                      <span style={{ color: 'var(--color-text-muted)' }}>
                        {link.status.charAt(0).toUpperCase() + link.status.slice(1)}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-2" style={{ color: 'var(--color-text-dim)' }}>
                    {relativeTime(link.created_at)}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
                    {link.consumed_session_id ? link.consumed_session_id.slice(0, 8) + '…' : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {link.consumed_session_id ? (
                      <button
                        type="button"
                        className="rounded-xl px-2 py-1 text-[11px] font-medium transition-colors"
                        style={{ background: 'rgba(56,135,206,0.1)', color: 'var(--color-brand)' }}
                        onClick={() => onNavigate('reviews', link.consumed_session_id!)}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(56,135,206,0.18)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(56,135,206,0.1)'; }}
                      >
                        Review
                      </button>
                    ) : (
                      <span style={{ color: 'var(--color-text-dimmest)' }}>—</span>
                    )}
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
