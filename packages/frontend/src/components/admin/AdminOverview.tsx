import { useEffect, useState } from 'react';
import { Activity, Link2, CheckCircle2, Clock, ArrowRight, Star } from 'lucide-react';
import { fetchAdminJson, useAdminKey } from './AdminKeyContext.js';
import type { 
  AdminAssessmentLinksResponse, 
  AdminAssessmentLinkSummary,
  AdminReviewRow,
  AdminReviewsResponse
} from '@lintic/core';
import {
  ASSESSMENT_STATUS_DOT,
  getAssessmentDisplayStatus,
  getAssessmentStatusLabel,
} from './assessment-status.js';

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
      className="rounded-xl px-4 py-3"
      style={{ background: 'var(--color-bg-panel)' }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold" style={{ color: 'var(--color-text-dim)' }}>
          {label}
        </span>
        <Icon size={14} style={{ color: accent ?? 'var(--color-text-dimmest)' }} strokeWidth={2} />
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

function BentoCard({ title, children, action, className = '' }: { title: string, children: React.ReactNode, action?: React.ReactNode, className?: string }) {
  return (
    <div className={`rounded-xl flex flex-col overflow-hidden ${className}`} style={{ background: 'var(--color-bg-panel)' }}>
      <div className="flex items-center justify-between px-5 py-4">
        <span className="text-[11px] font-bold" style={{ color: 'var(--color-text-dim)' }}>
          {title}
        </span>
        {action}
      </div>
      <div className="flex-1 p-5 pt-0 flex flex-col min-h-0">
        {children}
      </div>
    </div>
  );
}

function LegendItem({ color, label, value, total }: { color: string; label: string; value: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <div className="flex items-center justify-between text-[12px]">
      <div className="flex items-center gap-2">
        <div className="w-2.5 h-2.5 rounded-[3px]" style={{ background: color }} />
        <span style={{ color: 'var(--color-text-main)' }}>{label}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-semibold" style={{ color: 'var(--color-text-bold)' }}>{value}</span>
        <span className="w-8 text-right text-[10px]" style={{ color: 'var(--color-text-dim)' }}>{pct}%</span>
      </div>
    </div>
  );
}

function DonutChart({ unviewed, viewed, passed }: { unviewed: number, viewed: number, passed: number }) {
  const total = unviewed + viewed + passed;
  if (total === 0) return (
    <svg viewBox="0 0 36 36" className="w-full h-full drop-shadow-sm">
      <circle r="15.915" cx="18" cy="18" fill="transparent" stroke="var(--color-bg-app)" strokeWidth="3" />
    </svg>
  );

  const radius = 15.915;
  const unviewedPct = (unviewed / total) * 100;
  const viewedPct = (viewed / total) * 100;
  const passedPct = (passed / total) * 100;

  return (
    <svg viewBox="0 0 36 36" className="w-full h-full drop-shadow-sm transform -rotate-90 overflow-visible">
      <circle r={radius} cx="18" cy="18" fill="transparent" stroke="var(--color-bg-app)" strokeWidth="3" />
      {unviewedPct > 0 && (
        <circle r={radius} cx="18" cy="18" fill="transparent" stroke="var(--color-status-warning)" strokeWidth="3" strokeDasharray={`${unviewedPct} ${100 - unviewedPct}`} strokeDashoffset="0" strokeLinecap="round" />
      )}
      {viewedPct > 0 && (
        <circle r={radius} cx="18" cy="18" fill="transparent" stroke="var(--color-brand)" strokeWidth="3" strokeDasharray={`${viewedPct} ${100 - viewedPct}`} strokeDashoffset={-unviewedPct} strokeLinecap="round" />
      )}
      {passedPct > 0 && (
        <circle r={radius} cx="18" cy="18" fill="transparent" stroke="var(--color-status-success)" strokeWidth="3" strokeDasharray={`${passedPct} ${100 - passedPct}`} strokeDashoffset={-(unviewedPct + viewedPct)} strokeLinecap="round" />
      )}
    </svg>
  );
}

interface AdminOverviewProps {
  onNavigate: (section: string, id?: string) => void;
}

export function AdminOverview({ onNavigate }: AdminOverviewProps) {
  const { adminKey } = useAdminKey();
  const [links, setLinks] = useState<AdminAssessmentLinkSummary[]>([]);
  const [reviews, setReviews] = useState<AdminReviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!adminKey) return;
    setLoading(true);
    setError(null);
    
    Promise.all([
      fetchAdminJson<AdminAssessmentLinksResponse>('/api/links', adminKey),
      fetchAdminJson<AdminReviewsResponse>('/api/reviews', adminKey),
    ])
      .then(([linksRes, reviewsRes]) => {
        setLinks(linksRes.links);
        setReviews(reviewsRes.reviews);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [adminKey]);

  const notOpened = links.filter((l) => getAssessmentDisplayStatus(l) === 'not_opened').length;
  const submitted = links.filter((l) => getAssessmentDisplayStatus(l) === 'submitted').length;
  const totalLinks = links.length;

  const reviewsWithScore = reviews.filter((r) => r.session_score !== undefined && r.session_score !== null);
  const avgScore = reviewsWithScore.length > 0 
    ? (reviewsWithScore.reduce((acc, r) => acc + r.session_score!, 0) / reviewsWithScore.length).toFixed(1)
    : '—';

  const unviewedReviews = reviews.filter((r) => r.review_status === 'unviewed' && !r.archived_at).length;
  const inProgressReviews = reviews.filter((r) => r.review_status === 'viewed' && !r.archived_at).length;
  const completedReviews = reviews.filter((r) => r.review_status === 'passed' && !r.archived_at).length;

  const pendingReviews = reviews.filter((r) => r.review_status !== 'passed' && !r.archived_at).sort((a, b) => b.completed_at - a.completed_at);
  const recentLinks = [...links].sort((a, b) => b.created_at - a.created_at).slice(0, 5);

  const promptCounts = links.reduce((acc, link) => {
    acc[link.prompt_id] = (acc[link.prompt_id] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const topPrompts = Object.entries(promptCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);

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
    <div className="flex flex-col gap-5 p-5 max-w-[1200px] mx-auto w-full">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Not Opened" value={loading ? '—' : notOpened} icon={Link2} />
        <StatCard label="Total Links" value={loading ? '—' : totalLinks} icon={Activity} />
        <StatCard label="Submitted" value={loading ? '—' : submitted} icon={CheckCircle2} accent="var(--color-status-success)" />
        <StatCard label="Pending Reviews" value={loading ? '—' : pendingReviews.length} icon={Star} accent="var(--color-brand)" />
        <StatCard label="Avg Score" value={loading ? '—' : avgScore} icon={Activity} accent="var(--color-brand)" />
      </div>

      {error ? (
        <div className="rounded-xl px-3 py-2.5 text-[12px]" style={{ background: 'rgba(239,68,68,0.06)', color: 'var(--color-status-error)' }}>
          {error}
        </div>
      ) : null}

      {/* Bento Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        
        {/* Left Column */}
        <div className="lg:col-span-2 flex flex-col gap-5">
          <BentoCard 
            title="Pick up where you left off" 
            action={
              <button 
                type="button" 
                onClick={() => onNavigate('reviews')}
                className="text-[11px] flex items-center gap-1 hover:text-[var(--color-brand)] transition-colors"
                style={{ color: 'var(--color-text-dim)' }}
              >
                View all reviews <ArrowRight size={10} />
              </button>
            }
          >
            {loading ? (
              <div className="py-8 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>Loading…</div>
            ) : pendingReviews.length === 0 ? (
               <div className="py-8 text-center text-[12px] flex flex-col items-center gap-3" style={{ color: 'var(--color-text-dim)' }}>
                 <CheckCircle2 size={28} style={{ color: 'var(--color-status-success)', opacity: 0.5 }} />
                 All caught up! No pending reviews.
               </div>
            ) : (
              <div className="flex flex-col gap-1 -mx-2">
                {pendingReviews.slice(0, 5).map(review => (
                  <div key={review.session_id} className="flex items-center gap-4 px-3 py-2.5 rounded-lg hover:bg-[var(--color-bg-app)]/50 transition-colors group cursor-pointer" onClick={() => onNavigate('reviews', review.session_id)}>
                     <div className="h-2 w-2 rounded-full shrink-0" style={{ background: review.review_status === 'viewed' ? 'var(--color-brand)' : 'var(--color-status-warning)' }} />
                     <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                       <div className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text-main)' }}>{review.candidate_email}</div>
                       <div className="text-[11px] truncate" style={{ color: 'var(--color-text-dim)' }}>{review.prompt_title}</div>
                     </div>
                     <div className="shrink-0 text-[11px] flex items-center gap-4">
                       <span style={{ color: 'var(--color-text-dim)' }}>{relativeTime(review.completed_at)}</span>
                       <span className="opacity-0 group-hover:opacity-100 transition-opacity font-medium" style={{ color: 'var(--color-brand)' }}>Review <ArrowRight size={10} className="inline ml-1" /></span>
                     </div>
                  </div>
                ))}
              </div>
            )}
          </BentoCard>

          <BentoCard 
            title="Recent Links"
            action={
              <button 
                type="button" 
                onClick={() => onNavigate('assessments')}
                className="text-[11px] flex items-center gap-1 hover:text-[var(--color-brand)] transition-colors"
                style={{ color: 'var(--color-text-dim)' }}
              >
                View all <ArrowRight size={10} />
              </button>
            }
          >
            {loading ? (
              <div className="py-6 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>Loading…</div>
            ) : recentLinks.length === 0 ? (
              <div className="py-6 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>No assessments created yet.</div>
            ) : (
              <div className="flex flex-col gap-1 -mx-2">
                {recentLinks.map((link) => (
                  <div key={link.id} className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--color-bg-app)]/50 transition-colors rounded-lg group cursor-pointer" onClick={() => onNavigate('assessments', link.id)}>
                    <div className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: ASSESSMENT_STATUS_DOT[getAssessmentDisplayStatus(link)] }} />
                    <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: 'var(--color-text-main)' }}>{link.candidate_email}</span>
                    <span className="shrink-0 font-mono text-[10px]" style={{ color: 'var(--color-text-dim)' }}>{link.prompt_id}</span>
                    <span className="shrink-0 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>{getAssessmentStatusLabel(link)}</span>
                    <span className="shrink-0 text-[11px] w-16 text-right" style={{ color: 'var(--color-text-dimmest)' }}>{relativeTime(link.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </BentoCard>
        </div>

        {/* Right Column */}
        <div className="lg:col-span-1 flex flex-col gap-5">
           <BentoCard title="Review Status">
             {loading ? (
                <div className="py-10 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>Loading…</div>
             ) : (
                <div className="flex flex-col items-center py-4">
                  <div className="relative w-44 h-44 mb-2">
                    <DonutChart unviewed={unviewedReviews} viewed={inProgressReviews} passed={completedReviews} />
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                      <span className="text-3xl font-bold tracking-tight" style={{ color: 'var(--color-text-main)' }}>{reviews.filter(r => !r.archived_at).length}</span>
                      <span className="text-[10px] font-bold mt-1" style={{ color: 'var(--color-text-dim)' }}>Total candidates</span>
                    </div>
                  </div>
                  
                  <div className="mt-6 w-full flex flex-col gap-3 px-2">
                    <LegendItem color="var(--color-status-success)" label="Passed" value={completedReviews} total={reviews.filter(r => !r.archived_at).length} />
                    <LegendItem color="var(--color-brand)" label="Viewed" value={inProgressReviews} total={reviews.filter(r => !r.archived_at).length} />
                    <LegendItem color="var(--color-status-warning)" label="Unviewed" value={unviewedReviews} total={reviews.filter(r => !r.archived_at).length} />
                  </div>
                </div>
             )}
           </BentoCard>

           <BentoCard title="Top Prompts">
             {loading ? (
                <div className="py-6 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>Loading…</div>
             ) : topPrompts.length === 0 ? (
                <div className="py-6 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>No data yet.</div>
             ) : (
                <div className="flex flex-col gap-3">
                  {topPrompts.map(([id, count]) => (
                    <div key={id} className="flex items-center justify-between text-[12px]">
                      <span className="font-mono" style={{ color: 'var(--color-text-main)' }}>{id}</span>
                      <span className="font-semibold px-2 py-0.5 rounded-full bg-[var(--color-bg-app)] text-[11px]" style={{ color: 'var(--color-text-bold)' }}>{count}</span>
                    </div>
                  ))}
                </div>
             )}
           </BentoCard>
        </div>

      </div>
    </div>
  );
}

