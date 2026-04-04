import {
  Activity,
  BarChart2,
  FileCode2,
  LayoutDashboard,
  Link2,
  Moon,
  Settings,
  Sun,
} from 'lucide-react';
import type { AdminSection } from './AdminDashboard.js';
import { useAdminKey } from './AdminKeyContext.js';

interface NavItem {
  id: AdminSection;
  label: string;
  icon: React.ElementType;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'sessions', label: 'Live Sessions', icon: Activity },
  { id: 'links', label: 'Links', icon: Link2 },
  { id: 'tasks', label: 'Tasks', icon: FileCode2 },
  { id: 'reviews', label: 'Reviews', icon: BarChart2 },
];

function NavButton({
  id,
  label,
  icon: Icon,
  active,
  onClick,
}: {
  id: string;
  label: string;
  icon: React.ElementType;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      key={id}
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-sm py-1.5 pl-2.5 pr-3 text-left text-[13px] transition-colors"
      style={
        active
          ? { background: 'var(--color-brand-orange)', color: '#ffffff' }
          : { color: 'var(--color-text-dim)' }
      }
      onMouseEnter={(e) => {
        if (!active) {
          const el = e.currentTarget as HTMLButtonElement;
          el.style.color = 'var(--color-text-main)';
          el.style.background = 'rgba(255,255,255,0.04)';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          const el = e.currentTarget as HTMLButtonElement;
          el.style.color = 'var(--color-text-dim)';
          el.style.background = '';
        }
      }}
    >
      <Icon size={14} strokeWidth={active ? 2.2 : 1.8} />
      {label}
    </button>
  );
}

interface AdminNavProps {
  section: AdminSection;
  onNavigate: (section: AdminSection) => void;
  isDark: boolean;
  onToggleTheme: () => void;
}

export function AdminNav({ section, onNavigate, isDark, onToggleTheme }: AdminNavProps) {
  const { adminKey } = useAdminKey();

  return (
    <nav
      className="flex h-full w-[200px] shrink-0 flex-col border-r"
      style={{
        background: 'var(--color-bg-sidebar)',
        borderColor: 'var(--color-border-main)',
      }}
    >
      {/* Brand — matches TopBar typography */}
      <div
        className="flex h-11 shrink-0 items-center gap-2.5 border-b px-3"
        style={{ borderColor: 'var(--color-border-main)' }}
      >
        <img
          src={isDark ? '/logo-dark.png' : '/logo-light.png'}
          alt="Lintic logo"
          className="h-5 w-5 object-contain"
        />
        <span className="text-[15px] font-bold tracking-tight" style={{ color: 'var(--color-text-bold)' }}>
          Lintic
        </span>
        <span
          className="ml-auto rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
          style={{ background: 'rgba(232,98,42,0.15)', color: 'var(--color-brand-orange)' }}
        >
          Admin
        </span>
      </div>

      {/* Nav items */}
      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2">
        {NAV_ITEMS.map((item) => (
          <NavButton
            key={item.id}
            id={item.id}
            label={item.label}
            icon={item.icon}
            active={section === item.id}
            onClick={() => onNavigate(item.id)}
          />
        ))}

        <div
          className="my-2 border-t"
          style={{ borderColor: 'var(--color-border-muted)' }}
        />

        <NavButton
          id="settings"
          label="Settings"
          icon={Settings}
          active={section === 'settings'}
          onClick={() => onNavigate('settings')}
        />
      </div>

      {/* Bottom controls */}
      <div
        className="shrink-0 border-t px-3 py-2.5"
        style={{ borderColor: 'var(--color-border-main)' }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <div
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: adminKey ? 'var(--color-status-success)' : 'var(--color-status-warning)' }}
            />
            <span className="text-[11px]" style={{ color: 'var(--color-text-dim)' }}>
              {adminKey ? 'Key active' : 'No key'}
            </span>
          </div>
          <button
            type="button"
            onClick={onToggleTheme}
            className="flex h-6 w-6 items-center justify-center rounded-sm transition-colors"
            style={{ color: 'var(--color-text-dim)' }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.color = 'var(--color-text-main)';
              el.style.background = 'rgba(255,255,255,0.06)';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.color = 'var(--color-text-dim)';
              el.style.background = '';
            }}
          >
            {isDark ? <Sun size={12} /> : <Moon size={12} />}
          </button>
        </div>
      </div>
    </nav>
  );
}
