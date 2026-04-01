import { AnimatePresence, motion } from 'framer-motion';

interface TabBarProps {
  tabs: string[];
  activeTab: string | null;
  onTabSelect: (path: string) => void;
  onTabClose: (path: string) => void;
}

export function TabBar({ tabs, activeTab, onTabSelect, onTabClose }: TabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div
      className="flex items-stretch overflow-x-auto shrink-0"
      role="tablist"
      style={{ background: 'var(--color-bg-sidebar)', height: '34px' }}
    >
      <AnimatePresence initial={false}>
        {tabs.map((tab) => {
          const isActive = tab === activeTab;
          return (
            <motion.div
              key={tab}
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => onTabSelect(tab)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onTabSelect(tab);
              }}
              className="flex items-center gap-1.5 px-3 cursor-pointer text-xs shrink-0 group overflow-hidden"
              style={{
                background: isActive ? 'var(--color-bg-code)' : 'transparent',
                color: isActive ? 'var(--color-text-main)' : 'var(--color-text-muted)',
                borderRight: '1px solid var(--color-border-main)',
                borderTop: isActive ? '2px solid var(--color-brand-orange)' : '2px solid transparent',
                borderTopLeftRadius: isActive ? 'var(--radius-md)' : '0',
                borderTopRightRadius: isActive ? 'var(--radius-md)' : '0',
                minWidth: '80px',
                maxWidth: '160px',
              }}
            >
              <span className="truncate flex-1">{tab}</span>
              <button
                aria-label={`Close ${tab}`}
                className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                style={{ color: '#444444', lineHeight: 1 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#888888'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#444444'; }}
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab);
                }}
              >
                <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z" />
                </svg>
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
