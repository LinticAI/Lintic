import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, Eye, Minus, Plus, RefreshCw, Trash2, X } from 'lucide-react';
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
import {
  ASSESSMENT_STATUS_DOT,
  getAssessmentDisplayStatus,
  getAssessmentStatusLabel,
} from './assessment-status.js';

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

interface CheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseDown?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  'data-testid'?: string;
}

function Checkbox({ checked, indeterminate = false, onClick, onMouseDown, 'data-testid': testId }: CheckboxProps) {
  const active = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      data-testid={testId}
      onClick={onClick}
      onMouseDown={onMouseDown}
      className="group flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] transition-all duration-100"
      style={{
        background: active ? 'var(--color-brand)' : 'rgba(255,255,255,0.04)',
        border: `1.5px solid ${active ? 'var(--color-brand)' : 'rgba(255,255,255,0.18)'}`,
        outline: 'none',
        boxShadow: active ? '0 0 0 2px rgba(56,135,206,0.18)' : undefined,
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.38)';
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.18)';
      }}
    >
      {indeterminate
        ? <Minus size={8} strokeWidth={3} color="white" />
        : checked
          ? <Check size={8} strokeWidth={3} color="white" />
          : null}
    </button>
  );
}

interface AdminLinksProps {
  onNavigate: (section: string, id?: string) => void;
}

export function AdminAssessments({ onNavigate }: AdminLinksProps) {
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

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  // Drag / shift-click refs
  const isMouseDownRef = useRef(false);
  const isDraggingRef = useRef(false);
  const dragStartIndexRef = useRef<number | null>(null);
  const dragBaseSelectionRef = useRef<Set<string>>(new Set());
  const dragModeRef = useRef<'add' | 'remove'>('add');
  const lastClickIndexRef = useRef<number | null>(null);

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
      showToast('Assessment created.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create assessment');
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
      showToast('Assessment link copied.');
    } catch {
      setError('Copy failed. Please copy manually.');
    }
  }

  async function handleDelete(ids: string[]) {
    if (ids.length === 0) return;
    setDeleting(true);
    setError(null);
    try {
      if (ids.length === 1) {
        await fetchAdminJson(`/api/links/${ids[0]}`, adminKey, { method: 'DELETE' });
      } else {
        await fetchAdminJson('/api/links', adminKey, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
      }
      setSelected(new Set());
      if (selectedLink && ids.includes(selectedLink.id)) setSelectedLink(null);
      showToast(`Deleted ${ids.length} assessment${ids.length > 1 ? 's' : ''}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  function toggleSelectAll() {
    if (selected.size === links.length && links.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(links.map((l) => l.id)));
    }
  }

  // Called on mousedown on a row's checkbox — starts drag tracking
  function handleCheckboxMouseDown(index: number, e: React.MouseEvent) {
    e.preventDefault(); // prevent text selection while dragging
    isMouseDownRef.current = true;
    isDraggingRef.current = false;
    dragStartIndexRef.current = index;
    dragBaseSelectionRef.current = new Set(selected);
    dragModeRef.current = (links[index] && selected.has(links[index].id)) ? 'remove' : 'add';
  }

  // Called on click (after mouseup without drag) on a row's checkbox
  function handleCheckboxClick(index: number, e: React.MouseEvent) {
    if (isDraggingRef.current) return; // drag already committed the selection
    const id = links[index]?.id;
    if (!id) return;
    if (e.shiftKey && lastClickIndexRef.current !== null) {
      const start = Math.min(lastClickIndexRef.current, index);
      const end = Math.max(lastClickIndexRef.current, index);
      // Determine intent: if current item is unselected, add; otherwise remove
      const adding = !selected.has(id);
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          const lid = links[i]?.id;
          if (lid) { if (adding) next.add(lid); else next.delete(lid); }
        }
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      lastClickIndexRef.current = index;
    }
  }

  // Called on mouseenter on a row while mouse is held down — extends drag
  function handleRowMouseEnter(index: number) {
    if (!isMouseDownRef.current || dragStartIndexRef.current === null) return;
    isDraggingRef.current = true;
    const start = Math.min(dragStartIndexRef.current, index);
    const end = Math.max(dragStartIndexRef.current, index);
    setSelected(() => {
      const next = new Set(dragBaseSelectionRef.current);
      for (let i = start; i <= end; i++) {
        const lid = links[i]?.id;
        if (lid) { if (dragModeRef.current === 'remove') next.delete(lid); else next.add(lid); }
      }
      return next;
    });
  }

  // Global mouseup ends any active drag
  useEffect(() => {
    function handleMouseUp() {
      isMouseDownRef.current = false;
      // Delay reset so onClick can still read isDraggingRef
      window.setTimeout(() => { isDraggingRef.current = false; }, 0);
    }
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);

  const inputClass = 'w-full rounded-xl bg-[var(--color-bg-app)]/50 px-3 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-[var(--color-brand)] transition-all';
  const inputStyle = { color: 'var(--color-text-main)' };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Topbar */}
      <div
        className="flex shrink-0 items-center justify-between px-5 py-3"
      >
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-[13px] font-semibold" style={{ color: 'var(--color-text-bold)' }}>Assessments</h2>
            {loading ? <RefreshCw size={11} className="animate-spin" style={{ color: 'var(--color-text-dim)' }} /> : null}
          </div>
          <p className="mt-0.5 text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
            Generate assessment links, track session activity, and jump into reviews from one place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 ? (
            <button
              type="button"
              data-testid="admin-links-delete-selected"
              onClick={() => void handleDelete([...selected])}
              disabled={deleting}
              className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-40"
              style={{ color: 'var(--color-status-error)', background: 'rgba(239,68,68,0.08)' }}
            >
              <Trash2 size={10} />
              Delete {selected.size}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void load()}
            disabled={!adminKey || loading}
            className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-40"
            style={{ color: 'var(--color-text-muted)', background: 'var(--color-bg-panel)' }}
          >
            <RefreshCw size={10} />
            Refresh
          </button>
          {adminKey ? (
            <button
              type="button"
              onClick={() => { setShowForm((v) => !v); setError(null); }}
              className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-semibold"
              style={{ background: 'var(--color-brand)', color: 'white' }}
            >
              <Plus size={11} />
              New Assessment
            </button>
          ) : null}
        </div>
      </div>

      {/* Toast */}
      {toast ? (
        <div className="mx-5 mt-3 shrink-0 rounded-xl px-3 py-2 text-[12px]" style={{ background: 'rgba(16,185,129,0.06)', color: 'var(--color-status-success)' }}>
          {toast}
        </div>
      ) : null}

      {error ? (
        <div data-testid="admin-link-error" className="mx-5 mt-3 shrink-0 rounded-xl px-3 py-2 text-[12px]" style={{ background: 'rgba(239,68,68,0.06)', color: 'var(--color-status-error)' }}>
          {error}
        </div>
      ) : null}

      {/* Inline create form */}
      {showForm ? (
        <div
          className="mx-5 mt-3 shrink-0 rounded-xl p-4"
          style={{ background: 'var(--color-bg-panel)' }}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
              New Assessment
            </span>
            <button type="button" onClick={() => setShowForm(false)} style={{ color: 'var(--color-text-dim)' }}>
              <X size={13} />
            </button>
          </div>
          <form data-testid="admin-link-form" onSubmit={(e) => void handleCreate(e)}>
            <div className="grid gap-3 sm:grid-cols-3">
              <label>
                <span className="mb-1 block text-[10px] font-semibold tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
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
                <span className="mb-1 block text-[10px] font-semibold tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
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
                <span className="mb-1 block text-[10px] font-semibold tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
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
                className="rounded-xl px-4 py-1.5 text-[12px] font-semibold disabled:opacity-40"
                style={{ background: 'var(--color-brand)', color: 'white' }}
              >
                {creating ? 'Generating…' : 'Generate assessment'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-xl px-4 py-1.5 text-[12px]"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--color-text-muted)' }}
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
            <div className="rounded-xl px-4 py-6 text-center text-[12px]" style={{ background: 'var(--color-bg-panel)', color: 'var(--color-text-dim)' }}>
              Enter your admin key in Settings to inspect assessments.
            </div>
          ) : (
            <div
              className="rounded-xl overflow-hidden"
              style={{ background: 'var(--color-bg-panel)' }}
            >
              <table className="min-w-full text-left text-[12px]">
                <thead>
                  <tr>
                    <th className="px-4 py-3">
                      <Checkbox
                        data-testid="admin-links-select-all"
                        checked={links.length > 0 && selected.size === links.length}
                        indeterminate={selected.size > 0 && selected.size < links.length}
                        onClick={toggleSelectAll}
                      />
                    </th>
                    {['Prompt', 'Candidate', 'Status', 'Created', 'Expires', 'Session', 'Actions'].map((col, i) => (
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
                  {links.map((link, rowIndex) => (
                    (() => {
                      const displayStatus = getAssessmentDisplayStatus(link);
                      return (
                        <tr
                          key={link.id}
                          data-testid={`admin-link-row-${link.id}`}
                          className="transition-colors even:bg-[var(--color-bg-app)]/20"
                          onMouseEnter={() => handleRowMouseEnter(rowIndex)}
                          onMouseDown={(e) => handleCheckboxMouseDown(rowIndex, e)}
                          onClick={(e) => handleCheckboxClick(rowIndex, e)}
                          style={{
                            background: selected.has(link.id)
                              ? 'rgba(56,135,206,0.07)'
                              : selectedLink?.id === link.id
                                ? 'rgba(56,135,206,0.08)'
                                : undefined,
                            cursor: 'pointer',
                            userSelect: 'none',
                          }}
                        >
                          <td className="px-4 py-2">
                            <Checkbox
                              data-testid={`admin-link-select-${link.id}`}
                              checked={selected.has(link.id)}
                            />
                          </td>
                          <td className="px-4 py-2">
                            <div style={{ color: 'var(--color-text-main)' }}>{link.prompt?.title ?? link.prompt_id}</div>
                            <div className="font-mono text-[10px]" style={{ color: 'var(--color-text-dimmest)' }}>
                              {link.prompt_id}
                            </div>
                          </td>
                          <td className="px-4 py-2" style={{ color: 'var(--color-text-muted)' }}>
                            {link.candidate_email}
                          </td>
                          <td className="px-4 py-2">
                            <span className="flex items-center gap-1.5">
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ background: ASSESSMENT_STATUS_DOT[displayStatus] }}
                              />
                              <span style={{ color: 'var(--color-text-muted)' }}>
                                {getAssessmentStatusLabel(link)}
                              </span>
                            </span>
                          </td>
                          <td className="px-4 py-2" style={{ color: 'var(--color-text-dim)' }}>
                            {relativeTime(link.created_at)}
                          </td>
                          <td className="px-4 py-2" style={{ color: 'var(--color-text-dim)' }}>
                            {relativeTime(link.expires_at)}
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px]">
                            {link.consumed_session_id ? (
                              <button
                                type="button"
                                className="underline transition-colors"
                                style={{ color: 'var(--color-brand)' }}
                                onClick={(e) => { e.stopPropagation(); onNavigate('reviews', link.consumed_session_id!); }}
                              >
                                {link.consumed_session_id.slice(0, 8)}…
                              </button>
                            ) : (
                              <span style={{ color: 'var(--color-text-dimmest)' }}>—</span>
                            )}
                          </td>
                          <td className="px-4 py-2" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void handleInspect(link.id)}
                                className="flex h-6 w-6 items-center justify-center rounded-xl transition-colors"
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
                                className="flex h-6 w-6 items-center justify-center rounded-xl transition-colors"
                                style={{ color: 'var(--color-text-dim)' }}
                                title="Copy link"
                                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-main)'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-dim)'; (e.currentTarget as HTMLButtonElement).style.background = ''; }}
                              >
                                <Copy size={12} />
                              </button>
                              <button
                                data-testid={`admin-link-delete-${link.id}`}
                                type="button"
                                onClick={() => void handleDelete([link.id])}
                                disabled={deleting}
                                className="flex h-6 w-6 items-center justify-center rounded-xl transition-colors disabled:opacity-40"
                                style={{ color: 'var(--color-text-dim)' }}
                                title="Delete"
                                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-status-error)'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.08)'; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-dim)'; (e.currentTarget as HTMLButtonElement).style.background = ''; }}
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })()
                  ))}
                  {!loading && links.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>
                        No assessments created yet.
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
            className="w-72 shrink-0 overflow-auto p-4"
            style={{ background: 'var(--color-bg-panel)' }}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[11px] font-semibold tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                Assessment Detail
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
                  { label: 'Status', value: getAssessmentStatusLabel(selectedLink) },
                  { label: 'Candidate', value: selectedLink.candidate_email },
                  { label: 'Prompt', value: selectedLink.prompt?.title ?? selectedLink.prompt_id },
                  { label: 'Created', value: new Date(selectedLink.created_at).toISOString() },
                  { label: 'Expires', value: new Date(selectedLink.expires_at).toISOString() },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div className="mb-0.5 text-[10px] font-semibold tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                      {label}
                    </div>
                    <div className="text-[12px]" style={{ color: 'var(--color-text-main)' }}>{value}</div>
                  </div>
                ))}

                <div>
                  <div className="mb-1 text-[10px] font-semibold tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                    Assessment Link
                  </div>
                  <div className="break-all text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    {selectedLink.url}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopy(selectedLink.url)}
                    className="mt-2 flex items-center gap-1 rounded-xl px-2.5 py-1 text-[11px] font-medium"
                    style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--color-text-muted)' }}
                  >
                    <Copy size={10} /> Copy link
                  </button>
                </div>

                {selectedLink.consumed_session_id ? (
                  <div>
                    <div className="mb-0.5 text-[10px] font-semibold tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                      Session
                    </div>
                    <div className="font-mono text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                      {selectedLink.consumed_session_id}
                    </div>
                  </div>
                ) : null}

                <div>
                  <div className="mb-1 text-[10px] font-semibold tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                    Constraints
                  </div>
                  <pre
                    className="overflow-x-auto rounded-xl p-2 text-[10px] leading-relaxed"
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
