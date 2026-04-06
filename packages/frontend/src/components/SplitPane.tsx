import { useCallback, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

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
      className="flex h-full w-full flex-col overflow-hidden gap-[5px] min-[920px]:flex-row"
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {/* Left pane (IDE) */}
      <div
        className="min-w-0 basis-full overflow-hidden rounded-[var(--assessment-radius-shell)] bg-[var(--color-bg-code)] shadow-lg h-1/2 min-[920px]:h-full min-[920px]:basis-[var(--split-left-pct)]"
        style={{ '--split-left-pct': `${leftPct}%` } as CSSProperties}
        data-testid="pane-left"
      >
        {left}
      </div>

      {/* Right pane (Chat) with resize handle on its left edge */}
      <div
        className="relative min-w-0 basis-full overflow-hidden rounded-[var(--assessment-radius-shell)] bg-[var(--color-bg-panel)] shadow-lg h-1/2 min-[920px]:h-full min-[920px]:flex-1"
        data-testid="pane-right"
      >
        <div
          className="absolute -left-2 top-0 bottom-0 z-50 hidden w-3 cursor-col-resize transition-colors hover:bg-white/5 min-[920px]:block"
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
