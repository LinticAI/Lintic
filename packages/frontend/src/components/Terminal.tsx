import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WebContainer } from '@webcontainer/api';
import '@xterm/xterm/css/xterm.css';

export interface TerminalHandle {
  /** Write text directly to the xterm display (ANSI sequences supported). */
  write: (text: string) => void;
}

interface Props {
  wc: WebContainer | null;
}

const LIGHT_THEME = { 
  background: '#FFFBF7', 
  foreground: '#1A1520', 
  cursor: '#3887ce',
  selectionBackground: 'rgba(56, 135, 206, 0.2)',
  black: '#1A1520',
  red: '#E87461',
  green: '#2D8A2D',
  yellow: '#E8A832',
  blue: '#4A9EE8',
  magenta: '#8B6CC1',
  cyan: '#7FBDF0',
  white: '#FFFBF7',
};

const DARK_THEME = { 
  background: '#141414', 
  foreground: '#eeeeee', 
  cursor: '#3887ce',
  selectionBackground: 'rgba(56, 135, 206, 0.3)',
  black: '#000000',
  red: '#fca5a5',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#7FBDF0',
  magenta: '#8B6CC1',
  cyan: '#4A9EE8',
  white: '#ffffff',
};

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal({ wc }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useImperativeHandle(ref, () => ({
    write: (text: string) => {
      termRef.current?.write(text);
    },
  }));

  useEffect(() => {
    if (!containerRef.current) return;
    const isDark = document.documentElement.classList.contains('dark');
    
    const term = new XTerm({
      theme: isDark ? DARK_THEME : LIGHT_THEME,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, Consolas, monospace',
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;

    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(containerRef.current);

    // Watch for theme changes
    const themeObserver = new MutationObserver(() => {
      const currentIsDark = document.documentElement.classList.contains('dark');
      term.options.theme = currentIsDark ? DARK_THEME : LIGHT_THEME;
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!wc || !termRef.current) return;
    const term = termRef.current;
    let cleanup: (() => void) | undefined;

    void wc
      .spawn('jsh', { terminal: { cols: term.cols, rows: term.rows } })
      .then((process) => {
        const inputWriter = process.input.getWriter();
        const onData = term.onData((data) => {
          void inputWriter.write(data);
        });

        const reader = process.output.getReader();
        let active = true;
        function pump() {
          void reader.read().then(({ done, value }) => {
            if (done || !active) return;
            term.write(value);
            pump();
          });
        }
        pump();

        cleanup = () => {
          active = false;
          onData.dispose();
          void inputWriter.close().catch(() => {});
        };
      });

    return () => cleanup?.();
  }, [wc]);

  return (
    <div
      data-testid="terminal-container"
      ref={containerRef}
      className="w-full h-full bg-[var(--color-bg-ui)] p-2"
    />
  );
});
