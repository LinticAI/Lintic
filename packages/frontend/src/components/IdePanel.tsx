import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Terminal as TerminalIcon } from 'lucide-react';
import { Sidebar } from './Sidebar.js';
import { FileTree } from './FileTree.js';
import { TabBar } from './TabBar.js';
import { MonacoEditor } from './MonacoEditor.js';
import { Terminal } from './Terminal.js';
import type { TerminalHandle } from './Terminal.js';
import { useWebContainer } from '../hooks/useWebContainer.js';
import { writeFile, readFile, watchFiles, mkdir, rename, rm, duplicate } from '../lib/webcontainer.js';

interface IdePanelProps {
  terminalRef?: React.RefObject<TerminalHandle>;
  /** Path of a file to open/activate from the parent. */
  requestOpenFile?: string | null;
  onActiveFileChange?: (path: string | null) => void;
}

export function IdePanel({ terminalRef, requestOpenFile, onActiveFileChange }: IdePanelProps) {
  const internalRef = useRef<TerminalHandle>(null);
  const resolvedRef = terminalRef ?? internalRef;
  const [files, setFiles] = useState<Record<string, string>>({});
  const [directories, setDirectories] = useState<Set<string>>(new Set());
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(false);
  const { wc } = useWebContainer();

  function handleChange(value: string) {
    if (activeTab === null) return;
    setFiles((prev) => ({ ...prev, [activeTab]: value }));
    void writeFile(activeTab, value);
  }

  // Handle external open requests (e.g. from View Prompt button)
  useEffect(() => {
    if (requestOpenFile) {
      const path = requestOpenFile.split('-')[0];
      if (path) {
        handleFileSelect(path);
      }
    }
  }, [requestOpenFile]);

  useEffect(() => {
    onActiveFileChange?.(activeTab);
  }, [activeTab, onActiveFileChange]);

  const syncFileSystem = useCallback(async (path: string = '') => {
    if (!wc) return;
    try {
      const newDirs = new Set<string>();
      const newFiles: Record<string, string> = {};

      const walk = async (currentPath: string) => {
        const currentEntries = await wc.fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of currentEntries) {
          const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          
          if (entry.isDirectory()) {
            newDirs.add(fullPath);
            await walk(fullPath);
          } else {
            // Only read if we don't have it or it's a small file to avoid overhead
            // For now, simple read
            try {
              const content = await readFile(fullPath);
              newFiles[fullPath] = content;
            } catch {
              // Ignore individual read errors
            }
          }
        }
      };

      await walk(path);
      setDirectories(newDirs);
      setFiles(newFiles);
    } catch (err) {}
  }, [wc]);

  useEffect(() => {
    if (!wc) return;
    let stopWatch: (() => void) | undefined;
    
    void syncFileSystem();

    void watchFiles('/', async (_event, filename) => {
      const changedPath = typeof filename === 'string' ? filename : '';
      if (!changedPath || changedPath.startsWith('.') || changedPath.includes('node_modules')) {
        return;
      }

      try {
        const content = await readFile(changedPath);
        setFiles((prev) => ({ ...prev, [changedPath]: content }));
      } catch {
        void syncFileSystem();
      }
    }).then((stop) => {
      stopWatch = stop;
    });
    return () => stopWatch?.();
  }, [wc, syncFileSystem]);

  async function handleFileCreate(name: string) {
    await writeFile(name, '');
    setFiles((prev) => ({ ...prev, [name]: '' }));
    setOpenTabs((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setActiveTab(name);
    void syncFileSystem();
  }

  async function handleFolderCreate(name: string) {
    await mkdir(name);
    setDirectories(prev => new Set(prev).add(name));
    void syncFileSystem();
  }

  function handleFileSelect(path: string) {
    setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveTab(path);
  }

  async function handleFileDelete(path: string) {
    try {
      await rm(path);
      setFiles((prev) =>
        Object.fromEntries(
          Object.entries(prev).filter(
            ([filePath]) => filePath !== path && !filePath.startsWith(`${path}/`),
          ),
        ),
      );
      setDirectories((prev) => {
        const next = new Set<string>();
        for (const dir of prev) {
          if (dir !== path && !dir.startsWith(`${path}/`)) {
            next.add(dir);
          }
        }
        return next;
      });
      setOpenTabs((prev) => {
        const next = prev.filter((t) => !t.startsWith(path));
        if (activeTab && activeTab.startsWith(path)) {
          setActiveTab(next[next.length - 1] ?? null);
        }
        return next;
      });
      void syncFileSystem();
    } catch (err) {
      console.error('Failed to delete:', err);
    }
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

  async function handleRename(oldPath: string, newPath: string) {
    try {
      await rename(oldPath, newPath);
      setOpenTabs((prev) => prev.map(t => {
        if (t === oldPath) return newPath;
        if (t.startsWith(oldPath + '/')) return t.replace(oldPath, newPath);
        return t;
      }));
      if (activeTab === oldPath) setActiveTab(newPath);
      else if (activeTab?.startsWith(oldPath + '/')) setActiveTab(activeTab.replace(oldPath, newPath));
      void syncFileSystem();
    } catch (err) {
      console.error('Failed to rename:', err);
    }
  }

  async function handleDuplicate(path: string) {
    try {
      const newPath = await duplicate(path);
      handleFileSelect(newPath);
      void syncFileSystem();
    } catch (err) {
      console.error('Failed to duplicate:', err);
    }
  }

  async function handleMove(oldPath: string, newPath: string) {
    try {
      await rename(oldPath, newPath);
      setOpenTabs((prev) => prev.map(t => {
        if (t === oldPath) return newPath;
        if (t.startsWith(oldPath + '/')) return t.replace(oldPath, newPath);
        return t;
      }));
      if (activeTab === oldPath) setActiveTab(newPath);
      else if (activeTab?.startsWith(oldPath + '/')) setActiveTab(activeTab.replace(oldPath, newPath));
      void syncFileSystem();
    } catch (err) {
      console.error('Failed to move:', err);
    }
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      <FileTree
        files={files}
        directories={Array.from(directories)}
        activeFile={activeTab}
        onFileSelect={handleFileSelect}
        onFileCreate={handleFileCreate}
        onFolderCreate={handleFolderCreate}
        onFileDelete={handleFileDelete}
        onRename={handleRename}
        onDuplicate={handleDuplicate}
        onMove={handleMove}
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
        
        {/* Terminal Section */}
        <div className="flex flex-col shrink-0 overflow-hidden bg-[var(--color-bg-ui)] border-t border-[var(--color-border-main)]">
          <button 
            type="button"
            onClick={() => setIsTerminalCollapsed(!isTerminalCollapsed)}
            className="flex items-center justify-between px-4 py-2 hover:bg-white/5 transition-colors group"
          >

            <div className="flex items-center gap-2 text-[var(--color-text-dim)] group-hover:text-[var(--color-text-main)] transition-colors">
              <TerminalIcon size={14} />
              <span className="text-[11px] font-bold tracking-tight">Terminal</span>
            </div>
            <div className="text-[var(--color-text-dim)] group-hover:text-[var(--color-text-main)] transition-colors">
              {isTerminalCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </div>
          </button>
          <motion.div
            initial={false}
            animate={{ height: isTerminalCollapsed ? 0 : 200 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <Terminal wc={wc} ref={resolvedRef} />
          </motion.div>
        </div>
      </div>
    </div>
  );
}
