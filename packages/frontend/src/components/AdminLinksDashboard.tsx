import { useEffect, useState, type FormEvent } from 'react';
import type {
  AdminAssessmentLinkDetail,
  AdminAssessmentLinkDetailResponse,
  AdminAssessmentLinksResponse,
  AdminPromptsResponse,
  AdminAssessmentLinkSummary,
  Constraint,
  PromptSummary,
} from '@lintic/core';

interface AdminLinksDashboardProps {
  apiBase?: string;
  isDark: boolean;
  onToggleTheme: () => void;
}

const CONSTRAINT_FIELDS: Array<{ key: keyof Constraint; label: string }> = [
  { key: 'max_session_tokens', label: 'Max session tokens' },
  { key: 'max_message_tokens', label: 'Max message tokens' },
  { key: 'max_interactions', label: 'Max interactions' },
  { key: 'context_window', label: 'Context window' },
  { key: 'time_limit_minutes', label: 'Time limit (minutes)' },
];

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatStatus(status: AdminAssessmentLinkSummary['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Unexpected non-JSON response (HTTP ${response.status})`);
  }
}

async function fetchAdminJson<T>(
  url: string,
  adminKey: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('X-Lintic-Api-Key', adminKey);

  const response = await fetch(url, {
    ...init,
    headers,
  });

  const body = await parseJsonResponse<T & { error?: string }>(response);
  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }

  return body;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'absolute';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function AdminLinksDashboard({
  apiBase = '',
  isDark,
  onToggleTheme,
}: AdminLinksDashboardProps) {
  const [draftAdminKey, setDraftAdminKey] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [links, setLinks] = useState<AdminAssessmentLinkSummary[]>([]);
  const [selectedLink, setSelectedLink] = useState<AdminAssessmentLinkDetail | null>(null);
  const [promptId, setPromptId] = useState('');
  const [candidateEmail, setCandidateEmail] = useState('');
  const [expiresInHours, setExpiresInHours] = useState('72');
  const [constraintInputs, setConstraintInputs] = useState<Record<keyof Constraint, string>>({
    max_session_tokens: '',
    max_message_tokens: '',
    max_interactions: '',
    context_window: '',
    time_limit_minutes: '',
  });
  const [loading, setLoading] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  async function loadDashboardData(activeAdminKey: string): Promise<void> {
    setLoading(true);
    setError(null);

    try {
      const [promptResponse, linkResponse] = await Promise.all([
        fetchAdminJson<AdminPromptsResponse>(`${apiBase}/api/prompts`, activeAdminKey),
        fetchAdminJson<AdminAssessmentLinksResponse>(`${apiBase}/api/links`, activeAdminKey),
      ]);

      setPrompts(promptResponse.prompts);
      setLinks(linkResponse.links);
      setPromptId((current) => current || promptResponse.prompts[0]?.id || '');
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load admin dashboard');
      setPrompts([]);
      setLinks([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadLinkDetail(linkId: string, activeAdminKey: string): Promise<void> {
    setDetailLoading(true);
    setError(null);

    try {
      const response = await fetchAdminJson<AdminAssessmentLinkDetailResponse>(
        `${apiBase}/api/links/${linkId}`,
        activeAdminKey,
      );
      setSelectedLink(response.link);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load assessment link');
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    if (!adminKey) {
      return;
    }

    void loadDashboardData(adminKey);
  }, [adminKey, apiBase]);

  async function handleCreateLink(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!adminKey || !promptId || !candidateEmail.trim()) {
      return;
    }

    const constraintOverrides: Partial<Constraint> = {};
    for (const field of CONSTRAINT_FIELDS) {
      const rawValue = constraintInputs[field.key].trim();
      if (!rawValue) {
        continue;
      }
      constraintOverrides[field.key] = Number(rawValue);
    }

    setCreateLoading(true);
    setError(null);

    try {
      const created = await fetchAdminJson<AdminAssessmentLinkDetail & { prompt?: PromptSummary | null }>(
        `${apiBase}/api/links`,
        adminKey,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt_id: promptId,
            email: candidateEmail.trim(),
            ...(expiresInHours.trim() ? { expires_in_hours: Number(expiresInHours) } : {}),
            ...(Object.keys(constraintOverrides).length > 0 ? { constraint_overrides: constraintOverrides } : {}),
          }),
        },
      );

      setCandidateEmail('');
      setSelectedLink(created);
      await loadDashboardData(adminKey);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create assessment link');
    } finally {
      setCreateLoading(false);
    }
  }

  async function handleCopy(url: string): Promise<void> {
    try {
      await copyText(url);
      setCopyMessage('Assessment link copied.');
      window.setTimeout(() => setCopyMessage(null), 2000);
    } catch {
      setError('Copy failed. Please copy the link manually.');
    }
  }

  return (
    <div className="min-h-screen px-6 py-6" style={{ background: 'var(--color-bg-app)', color: 'var(--color-text-main)' }}>
      <div className="mx-auto flex max-w-[1500px] flex-col gap-6">
        <header
          className="flex flex-col gap-4 rounded-[28px] border px-6 py-5 lg:flex-row lg:items-center lg:justify-between"
          style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
        >
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.28em]" style={{ color: 'var(--color-text-dim)' }}>
              Admin Console
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight" style={{ color: 'var(--color-text-bold)' }}>
              Assessment Links
            </h1>
            <p className="mt-2 max-w-2xl text-sm" style={{ color: 'var(--color-text-muted)' }}>
              Generate secure candidate links, inspect their lifecycle, and copy active links back out of history.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: adminKey ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)', color: adminKey ? 'var(--color-status-success)' : 'var(--color-status-warning)' }}>
              {adminKey ? 'Admin key loaded' : 'Admin key required'}
            </div>
            <button
              type="button"
              onClick={onToggleTheme}
              className="rounded-full border px-4 py-2 text-xs font-semibold"
              style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}
            >
              {isDark ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        </header>

        <section
          className="rounded-[28px] border px-5 py-5"
          style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
        >
          <form
            className="flex flex-col gap-3 lg:flex-row lg:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              setAdminKey(draftAdminKey.trim());
            }}
          >
            <label className="flex-1 text-sm">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                Admin key
              </span>
              <input
                data-testid="admin-key-input"
                type="password"
                value={draftAdminKey}
                onChange={(event) => setDraftAdminKey(event.target.value)}
                placeholder="Enter X-Lintic-Api-Key"
                className="w-full rounded-2xl border px-4 py-3 text-sm outline-none"
                style={{
                  borderColor: 'var(--color-border-main)',
                  background: 'var(--color-bg-app)',
                  color: 'var(--color-text-main)',
                }}
              />
            </label>
            <button
              data-testid="admin-key-submit"
              type="submit"
              disabled={!draftAdminKey.trim()}
              className="rounded-2xl px-5 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: 'var(--color-brand)', color: 'white' }}
            >
              Load dashboard
            </button>
          </form>
        </section>

        {copyMessage ? (
          <div
            className="rounded-2xl border px-4 py-3 text-sm"
            style={{
              borderColor: 'rgba(16, 185, 129, 0.2)',
              background: 'rgba(16, 185, 129, 0.08)',
              color: 'var(--color-status-success)',
            }}
          >
            {copyMessage}
          </div>
        ) : null}

        {error ? (
          <div
            data-testid="admin-link-error"
            className="rounded-2xl border px-4 py-3 text-sm"
            style={{
              borderColor: 'rgba(239, 68, 68, 0.2)',
              background: 'rgba(239, 68, 68, 0.08)',
              color: 'var(--color-status-error)',
            }}
          >
            {error}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_420px]">
          <div className="flex flex-col gap-6">
            <section
              className="rounded-[28px] border px-5 py-5"
              style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
            >
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text-bold)' }}>
                    Generate link
                  </h2>
                  <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
                    Create a signed link with optional constraint overrides.
                  </p>
                </div>
              </div>

              <form data-testid="admin-link-form" className="grid gap-4 md:grid-cols-2" onSubmit={(event) => void handleCreateLink(event)}>
                <label className="text-sm">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                    Prompt
                  </span>
                  <select
                    value={promptId}
                    onChange={(event) => setPromptId(event.target.value)}
                    disabled={!adminKey || loading || prompts.length === 0}
                    className="w-full rounded-2xl border px-4 py-3 text-sm outline-none"
                    style={{
                      borderColor: 'var(--color-border-main)',
                      background: 'var(--color-bg-app)',
                      color: 'var(--color-text-main)',
                    }}
                  >
                    {prompts.length === 0 ? <option value="">No prompts loaded</option> : null}
                    {prompts.map((prompt) => (
                      <option key={prompt.id} value={prompt.id}>
                        {prompt.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                    Candidate email
                  </span>
                  <input
                    value={candidateEmail}
                    onChange={(event) => setCandidateEmail(event.target.value)}
                    disabled={!adminKey || loading}
                    placeholder="candidate@example.com"
                    className="w-full rounded-2xl border px-4 py-3 text-sm outline-none"
                    style={{
                      borderColor: 'var(--color-border-main)',
                      background: 'var(--color-bg-app)',
                      color: 'var(--color-text-main)',
                    }}
                  />
                </label>

                <label className="text-sm">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                    Expiry (hours)
                  </span>
                  <input
                    value={expiresInHours}
                    onChange={(event) => setExpiresInHours(event.target.value)}
                    disabled={!adminKey || loading}
                    placeholder="72"
                    className="w-full rounded-2xl border px-4 py-3 text-sm outline-none"
                    style={{
                      borderColor: 'var(--color-border-main)',
                      background: 'var(--color-bg-app)',
                      color: 'var(--color-text-main)',
                    }}
                  />
                </label>

                <div className="rounded-2xl border px-4 py-3 text-sm md:col-span-2" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                  <div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                    Constraint overrides
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {CONSTRAINT_FIELDS.map((field) => (
                      <label key={field.key} className="text-sm">
                        <span className="mb-2 block" style={{ color: 'var(--color-text-muted)' }}>
                          {field.label}
                        </span>
                        <input
                          value={constraintInputs[field.key]}
                          onChange={(event) =>
                            setConstraintInputs((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }))
                          }
                          disabled={!adminKey || loading}
                          placeholder="Leave blank to use default"
                          className="w-full rounded-2xl border px-4 py-3 text-sm outline-none"
                          style={{
                            borderColor: 'var(--color-border-main)',
                            background: 'var(--color-bg-panel)',
                            color: 'var(--color-text-main)',
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </div>

                <div className="md:col-span-2">
                  <button
                    data-testid="admin-link-create"
                    type="submit"
                    disabled={!adminKey || loading || createLoading || !promptId || !candidateEmail.trim()}
                    className="rounded-2xl px-5 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ background: 'var(--color-brand)', color: 'white' }}
                  >
                    {createLoading ? 'Generating link…' : 'Generate assessment link'}
                  </button>
                </div>
              </form>
            </section>

            <section
              className="rounded-[28px] border"
              style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
            >
              <div className="flex items-center justify-between px-5 py-5">
                <div>
                  <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text-bold)' }}>
                    Link history
                  </h2>
                  <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
                    Active, consumed, expired, and invalid links live here.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadDashboardData(adminKey)}
                  disabled={!adminKey || loading}
                  className="rounded-2xl border px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}
                >
                  Refresh
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full border-t text-left text-sm" style={{ borderColor: 'var(--color-border-main)' }}>
                  <thead style={{ color: 'var(--color-text-dim)' }}>
                    <tr>
                      <th className="px-5 py-3 font-semibold">Prompt</th>
                      <th className="px-5 py-3 font-semibold">Candidate</th>
                      <th className="px-5 py-3 font-semibold">Created</th>
                      <th className="px-5 py-3 font-semibold">Expires</th>
                      <th className="px-5 py-3 font-semibold">Status</th>
                      <th className="px-5 py-3 font-semibold">Session</th>
                      <th className="px-5 py-3 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {links.map((link) => (
                      <tr
                        key={link.id}
                        data-testid={`admin-link-row-${link.id}`}
                        className="border-t"
                        style={{ borderColor: 'var(--color-border-muted)' }}
                      >
                        <td className="px-5 py-4">
                          <div className="font-medium" style={{ color: 'var(--color-text-bold)' }}>
                            {link.prompt?.title ?? link.prompt_id}
                          </div>
                          <div className="mt-1 text-xs" style={{ color: 'var(--color-text-dim)' }}>
                            {link.prompt_id}
                          </div>
                        </td>
                        <td className="px-5 py-4">{link.candidate_email}</td>
                        <td className="px-5 py-4">{formatTimestamp(link.created_at)}</td>
                        <td className="px-5 py-4">{formatTimestamp(link.expires_at)}</td>
                        <td className="px-5 py-4">
                          <span
                            className="rounded-full px-3 py-1 text-xs font-semibold"
                            style={{
                              background: link.status === 'consumed'
                                ? 'rgba(16, 185, 129, 0.12)'
                                : link.status === 'expired'
                                  ? 'rgba(245, 158, 11, 0.12)'
                                  : link.status === 'invalid'
                                    ? 'rgba(239, 68, 68, 0.12)'
                                    : 'rgba(56, 135, 206, 0.12)',
                              color: link.status === 'consumed'
                                ? 'var(--color-status-success)'
                                : link.status === 'expired'
                                  ? 'var(--color-status-warning)'
                                  : link.status === 'invalid'
                                    ? 'var(--color-status-error)'
                                    : 'var(--color-brand)',
                            }}
                          >
                            {formatStatus(link.status)}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          {link.consumed_session_id ? (
                            <a
                              href={`/review/${link.consumed_session_id}`}
                              className="underline"
                              style={{ color: 'var(--color-brand)' }}
                            >
                              {link.consumed_session_id}
                            </a>
                          ) : (
                            <span style={{ color: 'var(--color-text-dim)' }}>—</span>
                          )}
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => void loadLinkDetail(link.id, adminKey)}
                              className="rounded-full border px-3 py-1 text-xs font-semibold"
                              style={{ borderColor: 'var(--color-border-main)' }}
                            >
                              Inspect
                            </button>
                            <button
                              data-testid={`admin-link-copy-${link.id}`}
                              type="button"
                              onClick={() => void handleCopy(link.url)}
                              className="rounded-full border px-3 py-1 text-xs font-semibold"
                              style={{ borderColor: 'var(--color-border-main)' }}
                            >
                              Copy
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {adminKey && !loading && links.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-5 py-8 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
                          No assessment links generated yet.
                        </td>
                      </tr>
                    ) : null}
                    {!adminKey ? (
                      <tr>
                        <td colSpan={7} className="px-5 py-8 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
                          Load an admin key to inspect links.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <aside
            data-testid="admin-link-detail"
            className="rounded-[28px] border px-5 py-5"
            style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text-bold)' }}>
                  Link detail
                </h2>
                <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
                  Inspect metadata, constraint snapshot, and current state.
                </p>
              </div>
            </div>

            {detailLoading ? (
              <div className="rounded-2xl border px-4 py-4 text-sm" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                Loading link detail…
              </div>
            ) : null}

            {!detailLoading && selectedLink ? (
              <div className="flex flex-col gap-4">
                <div className="rounded-2xl border px-4 py-4" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                    Public URL
                  </div>
                  <div className="mt-2 break-all text-sm" style={{ color: 'var(--color-text-main)' }}>
                    {selectedLink.url}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopy(selectedLink.url)}
                    className="mt-3 rounded-full border px-3 py-1 text-xs font-semibold"
                    style={{ borderColor: 'var(--color-border-main)' }}
                  >
                    Copy link
                  </button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border px-4 py-3" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                    <div className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                      Link ID
                    </div>
                    <div className="mt-2 text-sm">{selectedLink.id}</div>
                  </div>
                  <div className="rounded-2xl border px-4 py-3" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                    <div className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                      Status
                    </div>
                    <div className="mt-2 text-sm">{formatStatus(selectedLink.status)}</div>
                  </div>
                  <div className="rounded-2xl border px-4 py-3" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                    <div className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                      Candidate
                    </div>
                    <div className="mt-2 text-sm">{selectedLink.candidate_email}</div>
                  </div>
                  <div className="rounded-2xl border px-4 py-3" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                    <div className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                      Prompt
                    </div>
                    <div className="mt-2 text-sm">{selectedLink.prompt?.title ?? selectedLink.prompt_id}</div>
                  </div>
                  <div className="rounded-2xl border px-4 py-3" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                    <div className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                      Created at
                    </div>
                    <div className="mt-2 text-sm">{new Date(selectedLink.created_at).toISOString()}</div>
                  </div>
                  <div className="rounded-2xl border px-4 py-3" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                    <div className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                      Expires at
                    </div>
                    <div className="mt-2 text-sm">{new Date(selectedLink.expires_at).toISOString()}</div>
                  </div>
                </div>

                <div className="rounded-2xl border px-4 py-4" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                    Consumed session
                  </div>
                  <div className="mt-2 text-sm">
                    {selectedLink.consumed_session_id ?? 'Not consumed yet'}
                  </div>
                  <div className="mt-2 text-xs" style={{ color: 'var(--color-text-dim)' }}>
                    {selectedLink.consumed_at ? new Date(selectedLink.consumed_at).toISOString() : 'No consumption timestamp'}
                  </div>
                </div>

                <div className="rounded-2xl border px-4 py-4" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                    Token
                  </div>
                  <div className="mt-2 break-all text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {selectedLink.token}
                  </div>
                </div>

                <div className="rounded-2xl border px-4 py-4" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)' }}>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-dim)' }}>
                    Constraint snapshot
                  </div>
                  <pre className="mt-3 overflow-x-auto rounded-2xl p-4 text-xs" style={{ background: '#0d1117', color: '#d1d5db' }}>
                    {JSON.stringify(selectedLink.constraint, null, 2)}
                  </pre>
                </div>
              </div>
            ) : null}

            {!detailLoading && !selectedLink ? (
              <div className="rounded-2xl border px-4 py-6 text-sm" style={{ borderColor: 'var(--color-border-main)', background: 'var(--color-bg-app)', color: 'var(--color-text-muted)' }}>
                Select a link from the table to inspect its metadata.
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
