import {
  Activity,
  BarChart2,
  FileCode2,
  LayoutDashboard,
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
  { id: 'assessments', label: 'Assessments', icon: Activity },
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
      title={label}
      className={`flex w-full items-center justify-center gap-3 rounded-[var(--assessment-radius-control)] py-2 px-3 text-left text-[13px] transition-all duration-200 lg:justify-start ${
        active
          ? 'bg-[#1A1A1A] text-white shadow-lg'
          : 'text-[#444444] hover:text-white hover:bg-white/5'
      }`}
    >
      <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
      <span className="hidden lg:block">{label}</span>
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
    <aside
      className="flex h-full w-12 lg:w-[240px] shrink-0 flex-col gap-4"
    >
      {/* Brand — matches TopBar typography but without box */}
      <div
        className="flex h-11 shrink-0 items-center gap-3 px-3"
      >
        <img
          src={isDark ? '/logo-dark.png' : '/logo-light.png'}
          alt="Lintic logo"
          className="h-6 w-6 object-contain"
        />
        <span className="text-[16px] font-bold tracking-tight" style={{ color: 'var(--color-text-bold)' }}>
          Lintic
        </span>
      </div>

      <nav 
        className="flex flex-1 flex-col gap-1 p-2 m-2 rounded-[var(--assessment-radius-shell)] bg-[#111111] shadow-2xl overflow-hidden"
      >
        {/* Nav items */}
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
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
            className="my-2"
          />

          <NavButton
            id="settings"
            label="Settings"
            icon={Settings}
            active={section === 'settings'}
            onClick={() => onNavigate('settings')}
          />
        </div>

        {/* Bottom controls inside the nav container */}
        <div
          className="shrink-0 px-3 py-3 mt-auto"
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
              className="flex h-7 w-7 items-center justify-center rounded-[var(--assessment-radius-control)] transition-all duration-200 text-[#444444] hover:text-white hover:bg-white/5"
            >
              {isDark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </div>
      </nav>
    </aside>
  );
}
