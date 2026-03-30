import { useState } from 'react';
import { FileTree } from './FileTree.js';
import { TabBar } from './TabBar.js';
import { MonacoEditor } from './MonacoEditor.js';

export function IdePanel() {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  function handleFileCreate(name: string) {
    setFiles({ ...files, [name]: '' });
    const newTabs = openTabs.includes(name) ? openTabs : [...openTabs, name];
    setOpenTabs(newTabs);
    setActiveTab(name);
  }

  function handleFileSelect(path: string) {
    const newTabs = openTabs.includes(path) ? openTabs : [...openTabs, path];
    setOpenTabs(newTabs);
    setActiveTab(path);
  }

  function handleFileDelete(path: string) {
    const newFiles = { ...files };
    delete newFiles[path];
    setFiles(newFiles);
    const idx = openTabs.indexOf(path);
    const newTabs = openTabs.filter((t) => t !== path);
    setOpenTabs(newTabs);
    if (activeTab === path) {
      setActiveTab(newTabs[idx - 1] ?? newTabs[idx] ?? null);
    }
  }

  function handleTabClose(path: string) {
    const idx = openTabs.indexOf(path);
    const newTabs = openTabs.filter((t) => t !== path);
    setOpenTabs(newTabs);
    if (activeTab === path) {
      // Prefer the tab to the left, then right, then null
      setActiveTab(newTabs[idx - 1] ?? newTabs[idx] ?? null);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        <FileTree
          files={files}
          activeFile={activeTab}
          onFileSelect={handleFileSelect}
          onFileCreate={handleFileCreate}
          onFileDelete={handleFileDelete}
        />
        <div className="flex flex-col flex-1 overflow-hidden">
          <TabBar
            tabs={openTabs}
            activeTab={activeTab}
            onTabSelect={setActiveTab}
            onTabClose={handleTabClose}
          />
          <div className="flex-1 overflow-hidden">
            {activeTab !== null ? (
              <MonacoEditor
                filePath={activeTab}
                content={files[activeTab] ?? ''}
                onChange={(value) =>
                  setFiles((prev) => ({ ...prev, [activeTab]: value }))
                }
              />
            ) : (
              <div className="h-full flex items-center justify-center text-gray-600 text-sm">
                Create a file to get started
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
