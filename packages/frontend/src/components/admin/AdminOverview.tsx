import { useEffect, useState } from 'react';
import { Activity, Link2, CheckCircle2, Clock, ArrowRight } from 'lucide-react';
import { fetchAdminJson, useAdminKey } from './AdminKeyContext.js';
import type { AdminAssessmentLinksResponse, AdminAssessmentLinkSummary } from '@lintic/core';

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

interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ElementType;
  accent?: string;
}

function StatCard({ label, value, icon: Icon, accent }: StatCardProps) {
  return (
    <div
      className="rounded-sm border px-4 py-3"
      style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
          {label}
        </span>
        <Icon size={13} style={{ color: accent ?? 'var(--color-text-dimmest)' }} strokeWidth={1.8} />
      </div>
      <div
        className="mt-2 text-2xl font-bold tabular-nums tracking-tight"
        style={{ color: accent ?? 'var(--color-text-bold)' }}
      >
        {value}
      </div>
    </div>
  );
}

interface AdminOverviewProps {
  onNavigate: (section: string, id?: string) => void;
}

export function AdminOverview({ onNavigate }: AdminOverviewProps) {
  const { adminKey } = useAdminKey();
  const [links, setLinks] = useState<AdminAssessmentLinkSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!adminKey) return;
    setLoading(true);
    setError(null);
    fetchAdminJson<AdminAssessmentLinksResponse>('/api/links', adminKey)
      .then((r) => setLinks(r.links))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [adminKey]);

  const active = links.filter((l) => l.status === 'active').length;
  const consumed = links.filter((l) => l.status === 'consumed').length;
  const today = links.filter((l) => {
    const d = new Date(l.created_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;
  const recent = [...links].sort((a, b) => b.created_at - a.created_at).slice(0, 8);

  if (!adminKey) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="text-[13px]" style={{ color: 'var(--color-text-muted)' }}>
            Enter your admin key in{' '}
            <button
              type="button"
              className="underline"
              style={{ color: 'var(--color-brand)' }}
              onClick={() => onNavigate('settings')}
            >
              Settings
            </button>{' '}
            to load the dashboard.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-5">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active Links" value={loading ? '—' : active} icon={Link2} accent="var(--color-brand)" />
        <StatCard label="Consumed" value={loading ? '—' : consumed} icon={CheckCircle2} accent="var(--color-status-success)" />
        <StatCard label="Created Today" value={loading ? '—' : today} icon={Clock} />
        <StatCard label="Total Links" value={loading ? '—' : links.length} icon={Activity} />
      </div>

      {error ? (
        <div className="rounded-sm border px-3 py-2.5 text-[12px]" style={{ borderColor: 'rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.06)', color: 'var(--color-status-error)' }}>
          {error}
        </div>
      ) : null}

      {/* Recent activity */}
      <div
        className="rounded-sm border"
        style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
      >
        <div
          className="flex items-center justify-between border-b px-4 py-2.5"
          style={{ borderColor: 'var(--color-border-main)' }}
        >
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
            Recent Activity
          </span>
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] transition-colors"
            style={{ color: 'var(--color-text-dim)' }}
            onClick={() => onNavigate('links')}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-brand)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-dim)'; }}
          >
            View all <ArrowRight size={10} />
          </button>
        </div>

        {loading ? (
          <div className="px-4 py-6 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>
            Loading…
          </div>
        ) : recent.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>
            No links generated yet.
          </div>
        ) : (
          <div>
            {recent.map((link, i) => (
              <div
                key={link.id}
                className="flex items-center gap-3 px-4 py-2"
                style={{
                  borderTop: i > 0 ? '1px solid var(--color-border-muted)' : undefined,
                }}
              >
                <div
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    background:
                      link.status === 'consumed'
                        ? 'var(--color-status-success)'
                        : link.status === 'expired'
                          ? 'var(--color-status-warning)'
                          : link.status === 'invalid'
                            ? 'var(--color-status-error)'
                            : 'var(--color-brand)',
                  }}
                />
                <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: 'var(--color-text-main)' }}>
                  {link.candidate_email}
                </span>
                <span className="shrink-0 font-mono text-[10px]" style={{ color: 'var(--color-text-dim)' }}>
                  {link.prompt_id}
                </span>
                <span className="shrink-0 text-[11px]" style={{ color: 'var(--color-text-dimmest)' }}>
                  {relativeTime(link.created_at)}
                </span>
                {link.consumed_session_id ? (
                  <button
                    type="button"
                    className="shrink-0 text-[11px] underline transition-colors"
                    style={{ color: 'var(--color-text-dim)' }}
                    onClick={() => onNavigate('reviews', link.consumed_session_id!)}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-brand)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-dim)'; }}
                  >
                    Review
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
