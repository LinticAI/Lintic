import { useEffect, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronUp, Download, Plus, Tag, X } from 'lucide-react';
import { fetchAdminJson, useAdminKey } from './AdminKeyContext.js';
import type { AdminPromptsResponse, PromptSummary } from '@lintic/core';

interface AdminTasksProps {}

export function AdminTasks({}: AdminTasksProps) {
  const { adminKey } = useAdminKey();
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  // Add form state (UI-only placeholder - backend CRUD not yet implemented)
  const [newId, setNewId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newTags, setNewTags] = useState('');

  useEffect(() => {
    if (!adminKey) return;
    setLoading(true);
    fetchAdminJson<AdminPromptsResponse>('/api/prompts', adminKey)
      .then((r) => setPrompts(r.prompts))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [adminKey]);

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    // TODO: wire up to backend CRUD endpoint when available
    setError('Adding tasks via the UI is not yet supported by the backend. Edit lintic.yml to add prompts.');
    setShowAdd(false);
  }

  const inputClass = 'w-full rounded-sm border bg-transparent px-3 py-1.5 text-[12px] outline-none focus:border-[var(--color-brand)] transition-colors';
  const inputStyle = { borderColor: 'var(--color-border-main)', color: 'var(--color-text-main)' };

  return (
    <div className="flex flex-col gap-0 p-5">
      {/* Topbar */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-[13px] font-semibold" style={{ color: 'var(--color-text-bold)' }}>Tasks</h2>
          <p className="text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
            Assessment prompts loaded from lintic.yml
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled
            className="flex cursor-not-allowed items-center gap-1.5 rounded-sm border px-3 py-1.5 text-[11px] font-medium opacity-40"
            style={{ borderColor: 'var(--color-border-main)', color: 'var(--color-text-muted)', background: 'var(--color-bg-panel)' }}
            title="Coming soon"
          >
            <Download size={11} />
            Install Task
          </button>
          {adminKey ? (
            <button
              type="button"
              onClick={() => { setShowAdd((v) => !v); setError(null); }}
              className="flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-[11px] font-semibold"
              style={{ background: 'var(--color-brand)', color: 'white' }}
            >
              <Plus size={11} />
              Add Task
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="mb-4 rounded-sm border px-3 py-2.5 text-[12px]" style={{ borderColor: 'rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.06)', color: 'var(--color-status-error)' }}>
          {error}
        </div>
      ) : null}

      {/* Add task form */}
      {showAdd ? (
        <div
          className="mb-4 rounded-sm border p-4"
          style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
              New Task
            </span>
            <button type="button" onClick={() => setShowAdd(false)} style={{ color: 'var(--color-text-dim)' }}>
              <X size={13} />
            </button>
          </div>
          <form onSubmit={handleAdd}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>ID</span>
                <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="library-api" className={inputClass} style={inputStyle} />
              </label>
              <label>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>Title</span>
                <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Library Catalog API" className={inputClass} style={inputStyle} />
              </label>
              <label>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>Tags (comma separated)</span>
                <input value={newTags} onChange={(e) => setNewTags(e.target.value)} placeholder="backend, api-design" className={inputClass} style={inputStyle} />
              </label>
              <label className="sm:col-span-2">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>Description (Markdown)</span>
                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  rows={4}
                  placeholder="Task description…"
                  className={inputClass + ' resize-y'}
                  style={inputStyle}
                />
              </label>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="submit"
                className="rounded-sm px-4 py-1.5 text-[12px] font-semibold"
                style={{ background: 'var(--color-brand)', color: 'white' }}
              >
                Add task
              </button>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="rounded-sm border px-4 py-1.5 text-[12px]"
                style={{ borderColor: 'var(--color-border-main)', color: 'var(--color-text-muted)' }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {!adminKey ? (
        <div className="rounded-sm border px-4 py-6 text-center text-[12px]" style={{ borderColor: 'var(--color-border-main)', color: 'var(--color-text-dim)' }}>
          Enter your admin key in Settings to view tasks.
        </div>
      ) : loading ? (
        <div className="text-center text-[12px]" style={{ color: 'var(--color-text-dim)' }}>Loading…</div>
      ) : prompts.length === 0 ? (
        <div className="rounded-sm border px-4 py-8 text-center text-[12px]" style={{ borderColor: 'var(--color-border-main)', color: 'var(--color-text-dim)' }}>
          No tasks configured. Add prompts to lintic.yml.
        </div>
      ) : (
        <div
          className="rounded-sm border overflow-hidden"
          style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
        >
          {prompts.map((prompt, i) => (
            <div
              key={prompt.id}
              style={{ borderTop: i > 0 ? '1px solid var(--color-border-muted)' : undefined }}
            >
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors"
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.02)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = ''; }}
                onClick={() => setExpandedId(expandedId === prompt.id ? null : prompt.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="text-[13px] font-medium" style={{ color: 'var(--color-text-bold)' }}>
                    {prompt.title}
                  </span>
                  <span className="ml-3 font-mono text-[10px]" style={{ color: 'var(--color-text-dimmest)' }}>
                    {prompt.id}
                  </span>
                </span>


                {prompt.tags?.map((tag) => (
                  <span
                    key={tag}
                    className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px]"
                    style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--color-text-dim)' }}
                  >
                    <Tag size={9} />
                    {tag}
                  </span>
                ))}

                {expandedId === prompt.id ? (
                  <ChevronUp size={13} style={{ color: 'var(--color-text-dim)' }} />
                ) : (
                  <ChevronDown size={13} style={{ color: 'var(--color-text-dim)' }} />
                )}
              </button>

              {expandedId === prompt.id && prompt.description ? (
                <div
                  className="border-t px-4 py-3"
                  style={{ borderColor: 'var(--color-border-muted)', background: 'rgba(255,255,255,0.01)' }}
                >
                  <pre className="whitespace-pre-wrap text-[12px] leading-relaxed" style={{ color: 'var(--color-text-muted)', fontFamily: 'inherit' }}>
                    {prompt.description}
                  </pre>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
