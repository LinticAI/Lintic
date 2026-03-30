interface TabBarProps {
  tabs: string[];
  activeTab: string | null;
  onTabSelect: (path: string) => void;
  onTabClose: (path: string) => void;
}

export function TabBar({ tabs, activeTab, onTabSelect, onTabClose }: TabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex items-end overflow-x-auto bg-gray-900 border-b border-gray-800 shrink-0" role="tablist">
      {tabs.map((tab) => {
        const isActive = tab === activeTab;
        return (
          <div
            key={tab}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => onTabSelect(tab)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                onTabSelect(tab);
              }
            }}
            className={`flex items-center gap-1 px-3 py-1.5 border-r border-gray-800 cursor-pointer text-xs shrink-0 group ${
              isActive
                ? 'bg-gray-950 text-gray-100 border-t-2 border-t-blue-500'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
          >
            <span className="max-w-[120px] truncate">{tab}</span>
            <button
              aria-label={`Close ${tab}`}
              className="ml-1 opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-200 transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
