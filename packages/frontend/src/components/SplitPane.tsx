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
    // On small screens (<md) stack vertically; on md+ use horizontal split with drag
    <div
      ref={containerRef}
      className="flex flex-col md:flex-row h-full w-full overflow-hidden"
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {/* Left pane (IDE) */}
      <div
        className="overflow-hidden md:h-full h-1/2"
        style={{ width: `${leftPct}%` }}
        data-testid="pane-left"
      >
        {left}
      </div>

      {/* Drag handle — hidden on small screens */}
      <div
        className="hidden md:flex w-1.5 shrink-0 bg-gray-800 hover:bg-blue-500 active:bg-blue-400 cursor-col-resize items-center justify-center transition-colors"
        onMouseDown={onMouseDown}
        data-testid="split-divider"
        role="separator"
        aria-label="Resize panels"
        aria-orientation="vertical"
      />

      {/* Right pane (Chat) */}
      <div
        className="overflow-hidden md:h-full flex-1 h-1/2"
        data-testid="pane-right"
      >
        {right}
      </div>
    </div>
  );
}
