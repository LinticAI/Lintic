import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WebContainer } from '@webcontainer/api';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  container: WebContainer | null;
  /** Called whenever a file is written via the shell (optional hook for sync). */
  onFileChange?: (path: string, content: string) => void;
}

/**
 * Embeds an xterm.js terminal connected to a WebContainer shell process.
 * Falls back to a loading/error state while the container boots.
 */
export function Terminal({ container }: TerminalProps) {
  const domRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Boot the xterm instance once on mount.
  useEffect(() => {
    if (!domRef.current) return;

    const term = new XTerm({
      theme: {
        background: '#0c0c0c',
        foreground: '#cccccc',
        cursor: '#cccccc',
        selectionBackground: '#264f78',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(domRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(domRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Spawn a shell inside the WebContainer once the container is ready.
  useEffect(() => {
    if (!container || !xtermRef.current) return;

    const term = xtermRef.current;
    let active = true;

    void (async () => {
      try {
        const process = await container.spawn('bash', [], {
          terminal: {
            cols: term.cols,
            rows: term.rows,
          },
        });

        // Stream container output → xterm.
        void process.output.pipeTo(
          new WritableStream({
            write(chunk) {
              if (active) term.write(chunk);
            },
          }),
        );

        // Stream xterm input → container.
        const writer = process.input.getWriter();
        term.onData((data) => {
          if (active) void writer.write(data);
        });

        // Resize the pty when xterm resizes.
        term.onResize(({ cols, rows }) => {
          if (active) process.resize({ cols, rows });
        });
      } catch (err: unknown) {
        if (active) {
          const msg = err instanceof Error ? err.message : String(err);
          term.write(`\r\n\x1b[31mTerminal error: ${msg}\x1b[0m\r\n`);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [container]);

  if (!container) {
    return (
      <div
        className="h-full flex items-center justify-center text-xs font-mono"
        style={{ background: '#0c0c0c', color: '#555555' }}
      >
        Booting terminal…
      </div>
    );
  }

  return (
    <div
      ref={domRef}
      className="h-full w-full overflow-hidden"
      style={{ background: '#0c0c0c' }}
    />
  );
}
