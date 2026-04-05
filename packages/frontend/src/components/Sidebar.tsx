import React from 'react';
import { Code2, Database, GitBranch } from 'lucide-react';

export type WorkspaceSection = 'code' | 'database' | 'git';

interface SidebarProps {
  activeSection: WorkspaceSection;
  onSelect: (section: WorkspaceSection) => void;
}

export function Sidebar({ activeSection, onSelect }: SidebarProps) {
  return (
    <aside 
      className=" flex flex-col shrink-0"
      style={{ background: 'var(--color-bg-app)' }}
    >
      <nav 
        className="flex h-full w-full flex-col items-center gap-3 p-2 rounded-[var(--assessment-radius-shell)] bg-[#111111] shadow-2xl"
      >
        <SidebarIcon
          icon={<Code2 size={24} />}
          label="Code"
          active={activeSection === 'code'}
          onClick={() => onSelect('code')}
        />
        <SidebarIcon
          icon={<Database size={24} />}
          label="Database"
          active={activeSection === 'database'}
          onClick={() => onSelect('database')}
        />
        <SidebarIcon
          icon={<GitBranch size={24} />}
          label="Git"
          active={activeSection === 'git'}
          onClick={() => onSelect('git')}
        />
      </nav>
    </aside>
  );
}

function SidebarIcon({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`h-12 w-12 rounded-[var(--assessment-radius-control)] transition-all duration-200 flex items-center justify-center ${
        active 
          ? 'bg-[#1A1A1A] text-white shadow-lg' 
          : 'text-[#444444] hover:text-white hover:bg-white/5'
      }`}
    >
      {icon}
    </button>
  );
}
