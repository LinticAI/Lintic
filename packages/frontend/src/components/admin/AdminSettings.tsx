import { useState, type FormEvent } from 'react';
import { Check, Eye, EyeOff } from 'lucide-react';
import { useAdminKey } from './AdminKeyContext.js';

interface AdminSettingsProps {
  isDark: boolean;
  onToggleTheme: () => void;
}

export function AdminSettings({ isDark, onToggleTheme }: AdminSettingsProps) {
  const { adminKey, setAdminKey } = useAdminKey();
  const [draft, setDraft] = useState(adminKey);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  function handleSave(e: FormEvent) {
    e.preventDefault();
    setAdminKey(draft.trim());
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  const inputClass = 'w-full rounded-sm border bg-transparent px-3 py-1.5 text-[12px] outline-none focus:border-[var(--color-brand-orange)] transition-colors';
  const inputStyle = { borderColor: 'var(--color-border-main)', color: 'var(--color-text-main)' };

  return (
    <div className="flex flex-col gap-6 p-5 max-w-lg">
      <div>
        <h2 className="text-[13px] font-semibold" style={{ color: 'var(--color-text-bold)' }}>Settings</h2>
        <p className="text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
          Admin key and dashboard preferences
        </p>
      </div>

      {/* Admin Key */}
      <section
        className="rounded-sm border p-4"
        style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
      >
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
          Admin Key
        </h3>
        <form onSubmit={handleSave} className="flex flex-col gap-3">
          <label>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
              X-Lintic-Api-Key
            </span>
            <div className="relative">
              <input
                data-testid="admin-key-input"
                type={showKey ? 'text' : 'password'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Enter your admin key"
                className={inputClass + ' pr-9'}
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--color-text-dim)' }}
              >
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <p className="mt-1.5 text-[10px]" style={{ color: 'var(--color-text-dimmest)' }}>
              Stored in localStorage. Set via LINTIC_ADMIN_KEY env var on the server.
            </p>
          </label>

          <div className="flex items-center gap-2">
            <button
              data-testid="admin-key-submit"
              type="submit"
              disabled={!draft.trim()}
              className="flex items-center gap-1.5 rounded-sm px-4 py-1.5 text-[12px] font-semibold disabled:opacity-40 transition-colors"
              style={{ background: 'var(--color-brand-orange)', color: 'white' }}
            >
              {saved ? <><Check size={11} /> Saved</> : 'Save key'}
            </button>
            {adminKey ? (
              <button
                type="button"
                className="rounded-sm border px-4 py-1.5 text-[12px]"
                style={{ borderColor: 'var(--color-border-main)', color: 'var(--color-status-error)' }}
                onClick={() => { setAdminKey(''); setDraft(''); }}
              >
                Clear
              </button>
            ) : null}
          </div>
        </form>

        <div className="mt-3 flex items-center gap-2">
          <div
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: adminKey ? 'var(--color-status-success)' : 'var(--color-status-warning)' }}
          />
          <span className="text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
            {adminKey ? 'Admin key active' : 'No admin key set'}
          </span>
        </div>
      </section>

      {/* Appearance */}
      <section
        className="rounded-sm border p-4"
        style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
      >
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
          Appearance
        </h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[12px]" style={{ color: 'var(--color-text-main)' }}>Theme</div>
            <div className="text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
              Currently {isDark ? 'dark' : 'light'}
            </div>
          </div>
          <button
            type="button"
            onClick={onToggleTheme}
            className="rounded-sm border px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{ borderColor: 'var(--color-border-main)', color: 'var(--color-text-muted)', background: 'var(--color-bg-app)' }}
          >
            Switch to {isDark ? 'light' : 'dark'}
          </button>
        </div>
      </section>

      {/* About */}
      <section
        className="rounded-sm border p-4"
        style={{ background: 'var(--color-bg-panel)', borderColor: 'var(--color-border-main)' }}
      >
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
          About
        </h3>
        <div className="flex flex-col gap-1.5 text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
          <div>Lintic — AI Coding Assessment Platform</div>
          <a
            href="https://github.com/lintic-dev/lintic"
            target="_blank"
            rel="noopener noreferrer"
            className="underline transition-colors"
            style={{ color: 'var(--color-text-dim)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--color-brand-orange)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--color-text-dim)'; }}
          >
            GitHub →
          </a>
        </div>
      </section>
    </div>
  );
}
