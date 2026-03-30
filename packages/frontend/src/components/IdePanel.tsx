import { useCallback, useEffect, useRef, useState } from 'react';
import { FileTree } from './FileTree.js';
import { TabBar } from './TabBar.js';
import { MonacoEditor } from './MonacoEditor.js';
import { Terminal } from './Terminal.js';
import { useWebContainer } from '../lib/useWebContainer.js';
import { writeFile } from '../lib/webcontainer.js';

/** Minimum height (px) for the terminal pane. */
const TERMINAL_MIN_H = 80;
/** Default terminal height (px). */
const TERMINAL_DEFAULT_H = 200;

export function IdePanel() {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  // Terminal height (px), resizable via drag divider.
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_H);
  // Whether the terminal pane is visible at all.
  const [terminalOpen, setTerminalOpen] = useState(true);

  const { container } = useWebContainer();

  // Sync a file change from Monaco into the WebContainer filesystem.
  const syncToWc = useCallback(
    (path: string, content: string) => {
      if (container) {
        void writeFile(path, content);
      }
    },
    [container],
  );

  // When the container first becomes ready, write all in-memory files into it.
  const didInitialSync = useRef(false);
  useEffect(() => {
    if (!container || didInitialSync.current) return;
    didInitialSync.current = true;
    for (const [path, content] of Object.entries(files)) {
      void writeFile(path, content);
    }
  }, [container, files]);

  function handleFileCreate(name: string) {
    setFiles((prev) => {
      const next = { ...prev, [name]: '' };
      if (container) void writeFile(name, '');
      return next;
    });
    setOpenTabs((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setActiveTab(name);
  }

  function handleFileSelect(path: string) {
    setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveTab(path);
  }

  function handleFileDelete(path: string) {
    setFiles((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    setOpenTabs((prev) => {
      const idx = prev.indexOf(path);
      const next = prev.filter((t) => t !== path);
      setActiveTab((cur) => {
        if (cur !== path) return cur;
        return next[idx - 1] ?? next[idx] ?? null;
      });
      return next;
    });
  }

  function handleTabClose(path: string) {
    setOpenTabs((prev) => {
      const idx = prev.indexOf(path);
      const next = prev.filter((t) => t !== path);
      setActiveTab((cur) => {
        if (cur !== path) return cur;
        return next[idx - 1] ?? next[idx] ?? null;
      });
      return next;
    });
  }

  function handleEditorChange(value: string) {
    if (activeTab === null) return;
    setFiles((prev) => {
      const next = { ...prev, [activeTab]: value };
      syncToWc(activeTab, value);
      return next;
    });
  }

  // --- Terminal resize drag ---
  const dragStartY = useRef<number | null>(null);
  const dragStartH = useRef<number>(TERMINAL_DEFAULT_H);

  function handleDividerMouseDown(e: React.MouseEvent) {
    dragStartY.current = e.clientY;
    dragStartH.current = terminalHeight;
    e.preventDefault();
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (dragStartY.current === null) return;
      const delta = dragStartY.current - e.clientY;
      setTerminalHeight(Math.max(TERMINAL_MIN_H, dragStartH.current + delta));
    }
    function onMouseUp() {
      dragStartY.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex flex-1 overflow-hidden min-h-0">
        <FileTree
          files={files}
          activeFile={activeTab}
          onFileSelect={handleFileSelect}
          onFileCreate={handleFileCreate}
          onFileDelete={handleFileDelete}
        />
        <div className="flex flex-col flex-1 overflow-hidden min-h-0">
          <TabBar
            tabs={openTabs}
            activeTab={activeTab}
            onTabSelect={setActiveTab}
            onTabClose={handleTabClose}
          />
          <div className="flex-1 overflow-hidden min-h-0">
            {activeTab !== null ? (
              <MonacoEditor
                filePath={activeTab}
                content={files[activeTab] ?? ''}
                onChange={handleEditorChange}
              />
            ) : (
              <div
                className="h-full flex flex-col items-center justify-center gap-2"
                style={{ background: '#0c0c0c', color: '#2a2a2a' }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.75" opacity={0.4}>
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="text-[11px]">Create a file to get started</span>
              </div>
            )}
          </div>

          {/* Terminal drag divider */}
          <div
            className="relative shrink-0 flex items-center justify-between px-2 select-none"
            style={{ height: '24px', background: '#111111', borderTop: '1px solid #1e1e1e', cursor: 'row-resize' }}
            onMouseDown={handleDividerMouseDown}
          >
            <span className="text-[10px] uppercase tracking-wide" style={{ color: '#555555' }}>
              Terminal
            </span>
            <button
              className="text-[10px] px-1 rounded"
              style={{ color: '#555555', background: 'transparent' }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setTerminalOpen((o) => !o)}
              aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
            >
              {terminalOpen ? '▼' : '▲'}
            </button>
          </div>

          {/* Terminal pane */}
          {terminalOpen && (
            <div
              className="shrink-0 overflow-hidden"
              style={{ height: terminalHeight }}
            >
              <Terminal container={container} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
