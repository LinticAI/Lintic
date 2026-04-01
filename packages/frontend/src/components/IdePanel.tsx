import { useEffect, useRef, useState } from 'react';
import { FileTree } from './FileTree.js';
import { TabBar } from './TabBar.js';
import { MonacoEditor } from './MonacoEditor.js';
import { Terminal } from './Terminal.js';
import type { TerminalHandle } from './Terminal.js';
import { useWebContainer } from '../hooks/useWebContainer.js';
import { writeFile, readFile, watchFiles } from '../lib/webcontainer.js';

interface IdePanelProps {
  terminalRef?: React.RefObject<TerminalHandle>;
}

export function IdePanel({ terminalRef }: IdePanelProps) {
  const internalRef = useRef<TerminalHandle>(null);
  const resolvedRef = terminalRef ?? internalRef;
  const [files, setFiles] = useState<Record<string, string>>({});
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const { wc } = useWebContainer();

  function handleChange(value: string) {
    if (activeTab === null) return;
    setFiles((prev) => ({ ...prev, [activeTab]: value }));
    void writeFile(activeTab, value);
  }

  useEffect(() => {
    if (!wc) return;
    let stopWatch: (() => void) | undefined;
    void watchFiles('/', async (_event, filename) => {
      const name = filename instanceof Uint8Array ? new TextDecoder().decode(filename) : filename;
      if (!name || name.split('/').some((seg) => ['node_modules', '.git', '.DS_Store'].includes(seg))) return;
      try {
        const content = await readFile(name);
        setFiles((prev) => ({ ...prev, [name]: content }));
      } catch {
        // File may have been deleted — ignore.
      }
    }).then((stop) => {
      stopWatch = stop;
    });
    return () => stopWatch?.();
  }, [wc]);

  function handleFileCreate(name: string) {
    setFiles((prev) => ({ ...prev, [name]: '' }));
    setOpenTabs((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setActiveTab(name);
    void writeFile(name, '');
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
      if (activeTab === path) {
        setActiveTab(next[idx - 1] ?? next[idx] ?? null);
      }
      return next;
    });
  }

  function handleTabClose(path: string) {
    setOpenTabs((prev) => {
      const idx = prev.indexOf(path);
      const next = prev.filter((t) => t !== path);
      if (activeTab === path) {
        setActiveTab(next[idx - 1] ?? next[idx] ?? null);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-transparent">
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
                onChange={handleChange}
              />
            ) : (
              <div
                className="h-full flex flex-col items-center justify-center gap-2"
                style={{ background: 'var(--color-bg-code)', color: 'var(--color-text-dimmest)' }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.75" opacity={0.4}>
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="text-[11px]">Create a file to get started</span>
              </div>
            )}
          </div>
          <div
            style={{
              height: 200,
              flexShrink: 0,
              borderTop: '1px solid var(--color-border-main)',
              overflow: 'hidden',
              background: 'var(--color-bg-ui)',
            }}
          >
            <Terminal wc={wc} ref={resolvedRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
