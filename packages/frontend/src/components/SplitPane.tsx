import { useCallback, useRef, useState } from 'react';

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
}

const MIN_PCT = 20;
const MAX_PCT = 80;

export function SplitPane({ left, right }: SplitPaneProps) {
  const [leftPct, setLeftPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const onMouseDown = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const newPct = ((e.clientX - rect.left) / rect.width) * 100;
    setLeftPct(Math.min(MAX_PCT, Math.max(MIN_PCT, newPct)));
  }, []);

  const onMouseUp = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex flex-col md:flex-row h-full w-full overflow-hidden gap-[5px]"
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {/* Left pane (IDE) */}
      <div
        className="overflow-hidden md:h-full h-1/2 rounded-[var(--assessment-radius-shell)] shadow-lg bg-[var(--color-bg-code)]"
        style={{ width: `${leftPct}%` }}
        data-testid="pane-left"
      >
        {left}
      </div>

      {/* Right pane (Chat) with resize handle on its left edge */}
      <div
        className="relative overflow-hidden md:h-full flex-1 h-1/2 rounded-[var(--assessment-radius-shell)] shadow-lg bg-[var(--color-bg-panel)]"
        data-testid="pane-right"
      >
        <div
          className="hidden md:block absolute -left-2 top-0 bottom-0 w-3 cursor-col-resize z-50 hover:bg-white/5 transition-colors"
          onMouseDown={onMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panels"
          data-testid="split-divider"
        />
        {right}
      </div>
    </div>
  );
}
