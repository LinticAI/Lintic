import { useEffect, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronUp, Copy, Eye, Plus, RefreshCw, X } from 'lucide-react';
import { fetchAdminJson, copyText, useAdminKey } from './AdminKeyContext.js';
import type {
  AdminAssessmentLinkDetail,
  AdminAssessmentLinkDetailResponse,
  AdminAssessmentLinksResponse,
  AdminAssessmentLinkSummary,
  AdminPromptsResponse,
  Constraint,
  PromptSummary,
} from '@lintic/core';

const CONSTRAINT_FIELDS: Array<{ key: keyof Constraint; label: string }> = [
  { key: 'max_session_tokens', label: 'Max session tokens' },
  { key: 'max_message_tokens', label: 'Max message tokens' },
  { key: 'max_interactions', label: 'Max interactions' },
  { key: 'context_window', label: 'Context window' },
  { key: 'time_limit_minutes', label: 'Time limit (min)' },
];

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

interface AdminLinksProps {
  onNavigate: (section: string, id?: string) => void;
}

export function AdminLinks({ onNavigate }: AdminLinksProps) {
  const { adminKey } = useAdminKey();

  const [links, setLinks] = useState<AdminAssessmentLinkSummary[]>([]);
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Create form
  const [showForm, setShowForm] = useState(false);
  const [promptId, setPromptId] = useState('');
  const [email, setEmail] = useState('');
  const [expiresInHours, setExpiresInHours] = useState('72');
  const [showConstraints, setShowConstraints] = useState(false);
  const [constraintInputs, setConstraintInputs] = useState<Record<keyof Constraint, string>>({
    max_session_tokens: '',
    max_message_tokens: '',
    max_interactions: '',
    context_window: '',
    time_limit_minutes: '',
  });
  const [creating, setCreating] = useState(false);

  // Detail panel
  const [selectedLink, setSelectedLink] = useState<AdminAssessmentLinkDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }

  async function load(key = adminKey) {
    if (!key) return;
    setLoading(true);
    setError(null);
    try {
      const [pr, lr] = await Promise.all([
        fetchAdminJson<AdminPromptsResponse>('/api/prompts', key),
        fetchAdminJson<AdminAssessmentLinksResponse>('/api/links', key),
      ]);
      setPrompts(pr.prompts);
      setLinks(lr.links);
      setPromptId((cur) => cur || pr.prompts[0]?.id || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [adminKey]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!adminKey || !promptId || !email.trim()) return;
    const overrides: Partial<Constraint> = {};
    for (const f of CONSTRAINT_FIELDS) {
      const v = constraintInputs[f.key].trim();
      if (v) overrides[f.key] = Number(v);
    }
    setCreating(true);
    setError(null);
    try {
      await fetchAdminJson<AdminAssessmentLinkDetail>('/api/links', adminKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt_id: promptId,
          email: email.trim(),
          ...(expiresInHours.trim() ? { expires_in_hours: Number(expiresInHours) } : {}),
          ...(Object.keys(overrides).length > 0 ? { constraint_overrides: overrides } : {}),
        }),
      });
      setEmail('');
      setShowForm(false);
      showToast('Link generated.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create link');
    } finally {
      setCreating(false);
    }
  }

  async function handleInspect(id: string) {
    setDetailLoading(true);
    try {
      const r = await fetchAdminJson<AdminAssessmentLinkDetailResponse>(`/api/links/${id}`, adminKey);
      setSelectedLink(r.link);
    } catch {
      // ignore
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleCopy(url: string) {
    try {
      await copyText(url);
      showToast('Link copied.');
    } catch {
      setError('Copy failed. Please copy manually.');
    }
  }

  const inputClass = 'w-full rounded-sm border bg-transparent px-3 py-1.5 text-[12px] outline-none focus:border-[var(--color-brand)] transition-colors';
  const inputStyle = { borderColor: 'var(--color-border-main)', color: 'var(--color-text-main)' };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Topbar */}
      <div
        className="flex shrink-0 items-center justify-between border-b px-5 py-3"
        style={{ borderColor: 'var(--color-border-main)' }}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-[13px] font-semibold" style={{ color: 'var(--color-text-bold)' }}>Links</h2>
          {loading ? <RefreshCw size={11} className="animate-spin" style={{ color: 'var(--color-text-dim)' }} /> : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={!adminKey || loading}
            className="flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-40"
            style={{ borderColor: 'var(--color-border-main)', color: 'var(--color-text-muted)', background: 'var(--color-bg-panel)' }}
          >
            <RefreshCw size={10} />
            Refresh
          </button>
          {adminKey ? (
            <button
              type="button"
              onClick={() => { setShowForm((v) => !v); setError(null); }}
              className="flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-[11px] font-semibold"
              style={{ background: 'var(--color-brand)', color: 'white' }}
            >
              <Plus size={11} />
              Generate Link
            </button>
          ) : null}
        </div>
      </div>

      {/* Toast */}
      {toast ? (
        <div className="mx-5 mt-3 shrink-0 rounded-sm border px-3 py-2 text-[12px]" style={{ borderColor: 'rgba(16,185,129,0.2)', background: 'rgba(16,185,129,0.06)', color: 'var(--color-status-success)' }}>
          {toast}
        </div>
      ) : null}

      {error ? (
        <div data-testid="admin-link-error" className="mx-5 mt-3 shrink-0 rounded-sm border px-3 py-2 text-[12px]" style={{ borderColor: 'rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.06)', color: 'var(--color-status-error)' }}>
          {error}
        </div>
      ) : null}

      {/* Inline create form */}
      {showForm ? (
        <div
          className="mx-5 mt-3 shrink-0 rounded-sm border p-4"
          style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
              New Assessment Link
            </span>
            <button type="button" onClick={() => setShowForm(false)} style={{ color: 'var(--color-text-dim)' }}>
              <X size={13} />
            </button>
          </div>
          <form data-testid="admin-link-form" onSubmit={(e) => void handleCreate(e)}>
            <div className="grid gap-3 sm:grid-cols-3">
              <label>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                  Prompt
                </span>
                <select
                  value={promptId}
                  onChange={(e) => setPromptId(e.target.value)}
                  disabled={prompts.length === 0}
                  className={inputClass}
                  style={inputStyle}
                >
                  {prompts.length === 0 ? <option value="">No prompts</option> : null}
                  {prompts.map((p) => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
                </select>
              </label>

              <label>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                  Candidate Email
                </span>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="candidate@example.com"
                  className={inputClass}
                  style={inputStyle}
                />
              </label>

              <label>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                  Expiry (hours)
                </span>
                <input
                  value={expiresInHours}
                  onChange={(e) => setExpiresInHours(e.target.value)}
                  placeholder="72"
                  className={inputClass}
                  style={inputStyle}
                />
              </label>
            </div>

            {/* Constraint overrides toggle */}
            <button
              type="button"
              className="mt-3 flex items-center gap-1 text-[11px] transition-colors"
              style={{ color: 'var(--color-text-dim)' }}
              onClick={() => setShowConstraints((v) => !v)}
            >
              {showConstraints ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              Customize constraints
            </button>

            {showConstraints ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {CONSTRAINT_FIELDS.map((f) => (
                  <label key={f.key}>
                    <span className="mb-1 block text-[10px]" style={{ color: 'var(--color-text-dim)' }}>
                      {f.label}
                    </span>
                    <input
                      value={constraintInputs[f.key]}
                      onChange={(e) =>
                        setConstraintInputs((cur) => ({ ...cur, [f.key]: e.target.value }))
                      }
                      placeholder="default"
                      className={inputClass}
                      style={inputStyle}
                    />
                  </label>
                ))}
              </div>
            ) : null}

            <div className="mt-4 flex items-center gap-2">
              <button
                data-testid="admin-link-create"
                type="submit"
                disabled={creating || !promptId || !email.trim()}
                className="rounded-sm px-4 py-1.5 text-[12px] font-semibold disabled:opacity-40"
                style={{ background: 'var(--color-brand)', color: 'white' }}
              >
                {creating ? 'Generating…' : 'Generate link'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-sm border px-4 py-1.5 text-[12px]"
                style={{ borderColor: 'var(--color-border-main)', color: 'var(--color-text-muted)' }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* Table + Detail panel */}
      <div className="flex min-h-0 flex-1 gap-0">
        {/* Table */}
        <div className={`flex min-h-0 flex-1 flex-col overflow-auto p-5 ${selectedLink ? 'pr-0' : ''}`}>
          {!adminKey ? (
            <div className="rounded-sm border px-4 py-6 text-center text-[12px]" style={{ borderColor: 'var(--color-border-main)', color: 'var(--color-text-dim)' }}>
              Enter your admin key in Settings to inspect links.
            </div>
          ) : (
            <div
              className="rounded-sm border overflow-hidden"
              style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
            >
              <table className="min-w-full text-left text-[12px]">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border-main)' }}>
                    {['Prompt', 'Candidate', 'Created', 'Expires', 'Status', 'Session', ''].map((col, i) => (
                      <th
                        key={i}
                        className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider"
                        style={{ color: 'var(--color-text-dim)' }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {links.map((link, i) => (
                    <tr
                      key={link.id}
                      data-testid={`admin-link-row-${link.id}`}
                      style={{
                        borderTop: i > 0 ? '1px solid var(--color-border-muted)' : undefined,
                        background: selectedLink?.id === link.id ? 'rgba(56,135,206,0.04)' : undefined,
                      }}
                    >
                      <td className="px-4 py-2">
                        <div style={{ color: 'var(--color-text-main)' }}>{link.prompt?.title ?? link.prompt_id}</div>
                        <div className="font-mono text-[10px]" style={{ color: 'var(--color-text-dimmest)' }}>
                          {link.prompt_id}
                        </div>
                      </td>
                      <td className="px-4 py-2" style={{ color: 'var(--color-text-muted)' }}>
                        {link.candidate_email}
                      </td>
                      <td className="px-4 py-2" style={{ color: 'var(--color-text-dim)' }}>
                        {relativeTime(link.created_at)}
                      </td>
                      <td className="px-4 py-2" style={{ color: 'var(--color-text-dim)' }}>
                        {relativeTime(link.expires_at)}
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
                      <td className="px-4 py-2 font-mono text-[11px]">
                        {link.consumed_session_id ? (
                          <button
                            type="button"
                            className="underline transition-colors"
                            style={{ color: 'var(--color-brand)' }}
                            onClick={() => onNavigate('reviews', link.consumed_session_id!)}
                          >
                            {link.consumed_session_id.slice(0, 8)}…
                          </button>
                        ) : (
                          <span style={{ color: 'var(--color-text-dimmest)' }}>—</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleInspect(link.id)}
                            className="flex h-6 w-6 items-center justify-center rounded-sm transition-colors"
                            style={{ color: 'var(--color-text-dim)' }}
                            title="Inspect"
                            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-main)'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-dim)'; (e.currentTarget as HTMLButtonElement).style.background = ''; }}
                          >
                            <Eye size={12} />
                          </button>
                          <button
                            data-testid={`admin-link-copy-${link.id}`}
                            type="button"
                            onClick={() => void handleCopy(link.url)}
                            className="flex h-6 w-6 items-center justify-center rounded-sm transition-colors"
                            style={{ color: 'var(--color-text-dim)' }}
                            title="Copy link"
                            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-main)'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-dim)'; (e.currentTarget as HTMLButtonElement).style.background = ''; }}
                          >
                            <Copy size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!loading && links.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>
                        No links generated yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedLink ? (
          <div
            data-testid="admin-link-detail"
            className="w-72 shrink-0 overflow-auto border-l p-4"
            style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-panel)' }}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                Link Detail
              </span>
              <button
                type="button"
                onClick={() => setSelectedLink(null)}
                style={{ color: 'var(--color-text-dim)' }}
              >
                <X size={13} />
              </button>
            </div>

            {detailLoading ? (
              <div className="text-[12px]" style={{ color: 'var(--color-text-dim)' }}>Loading…</div>
            ) : (
              <div className="flex flex-col gap-3">
                {[
                  { label: 'Status', value: selectedLink.status.charAt(0).toUpperCase() + selectedLink.status.slice(1) },
                  { label: 'Candidate', value: selectedLink.candidate_email },
                  { label: 'Prompt', value: selectedLink.prompt?.title ?? selectedLink.prompt_id },
                  { label: 'Created', value: new Date(selectedLink.created_at).toISOString() },
                  { label: 'Expires', value: new Date(selectedLink.expires_at).toISOString() },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                      {label}
                    </div>
                    <div className="text-[12px]" style={{ color: 'var(--color-text-main)' }}>{value}</div>
                  </div>
                ))}

                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                    URL
                  </div>
                  <div className="break-all text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    {selectedLink.url}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopy(selectedLink.url)}
                    className="mt-2 flex items-center gap-1 rounded-sm px-2.5 py-1 text-[11px] font-medium"
                    style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--color-text-muted)' }}
                  >
                    <Copy size={10} /> Copy link
                  </button>
                </div>

                {selectedLink.consumed_session_id ? (
                  <div>
                    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                      Session
                    </div>
                    <div className="font-mono text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                      {selectedLink.consumed_session_id}
                    </div>
                  </div>
                ) : null}

                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                    Constraints
                  </div>
                  <pre
                    className="overflow-x-auto rounded-sm p-2 text-[10px] leading-relaxed"
                    style={{ background: '#0d1117', color: '#d1d5db' }}
                  >
                    {JSON.stringify(selectedLink.constraint, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
