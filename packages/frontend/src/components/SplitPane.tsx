import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  initialPct?: number;
  minPct?: number;
  maxPct?: number;
  orientation?: 'horizontal' | 'vertical';
}

export function SplitPane({
  left,
  right,
  initialPct = 50,
  minPct = 20,
  maxPct = 80,
  orientation = 'horizontal',
}: SplitPaneProps) {
  const [leftPct, setLeftPct] = useState(initialPct);
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * Attach window-level mousemove/mouseup listeners on drag start so the
   * resize keeps working even when the pointer leaves the container.
   * Listeners are created and destroyed per drag gesture — no leaks.
   */
  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault(); // prevent text selection while dragging

      document.body.style.cursor =
        orientation === 'horizontal' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      function handleMouseMove(ev: MouseEvent) {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const newPct =
          orientation === 'horizontal'
            ? ((ev.clientX - rect.left) / rect.width) * 100
            : ((ev.clientY - rect.top) / rect.height) * 100;
        setLeftPct(Math.min(maxPct, Math.max(minPct, newPct)));
      }

      function handleMouseUp() {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      }

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [orientation, minPct, maxPct],
  );

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full overflow-hidden gap-[5px] ${
        orientation === 'horizontal' ? 'flex-row' : 'flex-col'
      }`}
    >
      {/* First pane */}
      <div
        className="min-w-0 min-h-0 overflow-hidden rounded-[var(--assessment-radius-shell)] shadow-lg bg-[var(--color-bg-code)]"
        style={{ flexBasis: `${leftPct}%`, flexShrink: 0, flexGrow: 0 }}
      >
        {left}
      </div>

      {/* Second pane — resize handle sits on its leading edge */}
      <div className="relative min-w-0 min-h-0 flex-1 overflow-hidden rounded-[var(--assessment-radius-shell)] shadow-lg bg-[var(--color-bg-panel)]">
        <div
          className={`absolute z-50 transition-colors hover:bg-white/10 ${
            orientation === 'horizontal'
              ? '-left-[3px] top-0 bottom-0 w-[6px] cursor-col-resize'
              : '-top-[3px] left-0 right-0 h-[6px] cursor-row-resize'
          }`}
          onMouseDown={onDividerMouseDown}
          role="separator"
          aria-orientation={orientation}
          aria-label="Resize panels"
        />
        {right}
      </div>
    </div>
  );
}
