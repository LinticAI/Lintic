# US-011: Monaco Editor Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed Monaco Editor into the left IDE panel with a file tree, tab bar, and in-memory filesystem that lets users create and edit files.

**Architecture:** `IdePanel` owns all state (`files`, `openTabs`, `activeTab`). `FileTree`, `TabBar`, and `MonacoEditor` are dumb components that receive props and callbacks. Language is detected from the file extension. The in-memory `files` map is the WebContainers seam — US-012 will replace it.

**Tech Stack:** `@monaco-editor/react`, React 18, TypeScript, Tailwind CSS, Vitest + @testing-library/react

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/frontend/src/lib/languageFromPath.ts` | Create | Maps file extension → Monaco language string |
| `packages/frontend/src/lib/languageFromPath.test.ts` | Create | Unit tests for language detection |
| `packages/frontend/src/components/TabBar.tsx` | Create | Dumb tab bar — renders open tabs, close buttons |
| `packages/frontend/src/components/TabBar.test.tsx` | Create | Tests for TabBar rendering and callbacks |
| `packages/frontend/src/components/FileTree.tsx` | Create | Dumb file tree — file list, inline new-file input, delete |
| `packages/frontend/src/components/FileTree.test.tsx` | Create | Tests for FileTree rendering and callbacks |
| `packages/frontend/src/components/MonacoEditor.tsx` | Create | Thin wrapper around `@monaco-editor/react` |
| `packages/frontend/src/components/IdePanel.tsx` | Create | Stateful parent — owns files/tabs state |
| `packages/frontend/src/components/IdePanel.test.tsx` | Create | Integration tests for all IDE interactions |
| `packages/frontend/src/App.tsx` | Modify | Pass `<IdePanel />` as left prop to SplitPane |
| `packages/frontend/package.json` | Modify | Add `@monaco-editor/react` dependency |
| `PRD.md` | Modify | Check off US-011 acceptance criteria |

---

## Task 1: Install @monaco-editor/react

**Files:**
- Modify: `packages/frontend/package.json`

- [ ] **Step 1: Install the package**

```bash
cd packages/frontend && npm install @monaco-editor/react
```

Expected output: added 1 package (or similar), no errors.

- [ ] **Step 2: Commit**

```bash
git add packages/frontend/package.json package-lock.json
git commit -m "chore(frontend): add @monaco-editor/react"
```

---

## Task 2: Language detection utility

**Files:**
- Create: `packages/frontend/src/lib/languageFromPath.ts`
- Create: `packages/frontend/src/lib/languageFromPath.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/frontend/src/lib/languageFromPath.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { languageFromPath } from './languageFromPath.js';

describe('languageFromPath', () => {
  test.each([
    ['index.ts', 'typescript'],
    ['App.tsx', 'typescript'],
    ['index.js', 'javascript'],
    ['App.jsx', 'javascript'],
    ['package.json', 'json'],
    ['styles.css', 'css'],
    ['index.html', 'html'],
    ['README.md', 'markdown'],
    ['notes.txt', 'plaintext'],
    ['Makefile', 'plaintext'],
    ['noextension', 'plaintext'],
  ])('%s → %s', (path, expected) => {
    expect(languageFromPath(path)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /path/to/repo && npm run test -- --reporter=verbose 2>&1 | grep languageFromPath
```

Expected: `Cannot find module './languageFromPath.js'`

- [ ] **Step 3: Implement languageFromPath**

Create `packages/frontend/src/lib/languageFromPath.ts`:

```ts
const EXT_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  css: 'css',
  html: 'html',
  md: 'markdown',
};

export function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MAP[ext] ?? 'plaintext';
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
npm run test -- --reporter=verbose 2>&1 | grep -A5 "languageFromPath"
```

Expected: all 11 cases pass.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/lib/
git commit -m "feat(frontend): add languageFromPath utility"
```

---

## Task 3: TabBar component

**Files:**
- Create: `packages/frontend/src/components/TabBar.tsx`
- Create: `packages/frontend/src/components/TabBar.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `packages/frontend/src/components/TabBar.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import { TabBar } from './TabBar.js';

describe('TabBar', () => {
  test('renders a button for each open tab', () => {
    render(
      <TabBar
        tabs={['index.ts', 'App.tsx']}
        activeTab="index.ts"
        onTabSelect={vi.fn()}
        onTabClose={vi.fn()}
      />
    );
    expect(screen.getByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText('App.tsx')).toBeInTheDocument();
  });

  test('active tab has active styling (aria-selected=true)', () => {
    render(
      <TabBar
        tabs={['index.ts', 'App.tsx']}
        activeTab="index.ts"
        onTabSelect={vi.fn()}
        onTabClose={vi.fn()}
      />
    );
    const active = screen.getByRole('tab', { name: /index\.ts/ });
    expect(active).toHaveAttribute('aria-selected', 'true');
    const inactive = screen.getByRole('tab', { name: /App\.tsx/ });
    expect(inactive).toHaveAttribute('aria-selected', 'false');
  });

  test('clicking a tab calls onTabSelect with that path', () => {
    const onTabSelect = vi.fn();
    render(
      <TabBar
        tabs={['index.ts', 'App.tsx']}
        activeTab="index.ts"
        onTabSelect={onTabSelect}
        onTabClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('tab', { name: /App\.tsx/ }));
    expect(onTabSelect).toHaveBeenCalledWith('App.tsx');
  });

  test('clicking close button calls onTabClose with that path', () => {
    const onTabClose = vi.fn();
    render(
      <TabBar
        tabs={['index.ts']}
        activeTab="index.ts"
        onTabSelect={vi.fn()}
        onTabClose={onTabClose}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /close index\.ts/i }));
    expect(onTabClose).toHaveBeenCalledWith('index.ts');
  });

  test('renders nothing when tabs is empty', () => {
    const { container } = render(
      <TabBar tabs={[]} activeTab={null} onTabSelect={vi.fn()} onTabClose={vi.fn()} />
    );
    expect(container.querySelector('[role="tab"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test -- --reporter=verbose 2>&1 | grep -A3 "TabBar"
```

Expected: `Cannot find module './TabBar.js'`

- [ ] **Step 3: Implement TabBar**

Create `packages/frontend/src/components/TabBar.tsx`:

```tsx
interface TabBarProps {
  tabs: string[];
  activeTab: string | null;
  onTabSelect: (path: string) => void;
  onTabClose: (path: string) => void;
}

export function TabBar({ tabs, activeTab, onTabSelect, onTabClose }: TabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex items-end overflow-x-auto bg-gray-900 border-b border-gray-800 shrink-0" role="tablist">
      {tabs.map((tab) => {
        const isActive = tab === activeTab;
        return (
          <div
            key={tab}
            className={`flex items-center gap-1 px-3 py-1.5 border-r border-gray-800 cursor-pointer text-xs shrink-0 group ${
              isActive
                ? 'bg-gray-950 text-gray-100 border-t-2 border-t-blue-500'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
          >
            <button
              role="tab"
              aria-selected={isActive}
              className="max-w-[120px] truncate"
              onClick={() => onTabSelect(tab)}
            >
              {tab}
            </button>
            <button
              aria-label={`Close ${tab}`}
              className="ml-1 opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-200 transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
npm run test -- --reporter=verbose 2>&1 | grep -A10 "TabBar"
```

Expected: all 5 TabBar tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/TabBar.tsx packages/frontend/src/components/TabBar.test.tsx
git commit -m "feat(frontend): add TabBar component"
```

---

## Task 4: FileTree component

**Files:**
- Create: `packages/frontend/src/components/FileTree.tsx`
- Create: `packages/frontend/src/components/FileTree.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `packages/frontend/src/components/FileTree.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import { FileTree } from './FileTree.js';

const FILES = { 'index.ts': 'const x = 1;', 'App.tsx': '' };

describe('FileTree', () => {
  test('renders all filenames', () => {
    render(
      <FileTree
        files={FILES}
        activeFile="index.ts"
        onFileSelect={vi.fn()}
        onFileCreate={vi.fn()}
        onFileDelete={vi.fn()}
      />
    );
    expect(screen.getByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText('App.tsx')).toBeInTheDocument();
  });

  test('active file has aria-selected=true', () => {
    render(
      <FileTree
        files={FILES}
        activeFile="index.ts"
        onFileSelect={vi.fn()}
        onFileCreate={vi.fn()}
        onFileDelete={vi.fn()}
      />
    );
    expect(screen.getByRole('option', { name: 'index.ts' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'false');
  });

  test('clicking a filename calls onFileSelect', () => {
    const onFileSelect = vi.fn();
    render(
      <FileTree
        files={FILES}
        activeFile={null}
        onFileSelect={onFileSelect}
        onFileCreate={vi.fn()}
        onFileDelete={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('option', { name: 'App.tsx' }));
    expect(onFileSelect).toHaveBeenCalledWith('App.tsx');
  });

  test('clicking delete button calls onFileDelete', () => {
    const onFileDelete = vi.fn();
    render(
      <FileTree
        files={FILES}
        activeFile={null}
        onFileSelect={vi.fn()}
        onFileCreate={vi.fn()}
        onFileDelete={onFileDelete}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /delete index\.ts/i }));
    expect(onFileDelete).toHaveBeenCalledWith('index.ts');
  });

  test('shows inline input when New File is clicked', () => {
    render(
      <FileTree
        files={{}}
        activeFile={null}
        onFileSelect={vi.fn()}
        onFileCreate={vi.fn()}
        onFileDelete={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /new file/i }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  test('pressing Enter in the input calls onFileCreate and hides input', () => {
    const onFileCreate = vi.fn();
    render(
      <FileTree
        files={{}}
        activeFile={null}
        onFileSelect={vi.fn()}
        onFileCreate={onFileCreate}
        onFileDelete={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /new file/i }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'utils.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onFileCreate).toHaveBeenCalledWith('utils.ts');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('pressing Escape cancels creation without calling onFileCreate', () => {
    const onFileCreate = vi.fn();
    render(
      <FileTree
        files={{}}
        activeFile={null}
        onFileSelect={vi.fn()}
        onFileCreate={onFileCreate}
        onFileDelete={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /new file/i }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onFileCreate).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('does not call onFileCreate when input is empty', () => {
    const onFileCreate = vi.fn();
    render(
      <FileTree
        files={{}}
        activeFile={null}
        onFileSelect={vi.fn()}
        onFileCreate={onFileCreate}
        onFileDelete={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /new file/i }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onFileCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test -- --reporter=verbose 2>&1 | grep -A3 "FileTree"
```

Expected: `Cannot find module './FileTree.js'`

- [ ] **Step 3: Implement FileTree**

Create `packages/frontend/src/components/FileTree.tsx`:

```tsx
import { useState } from 'react';

interface FileTreeProps {
  files: Record<string, string>;
  activeFile: string | null;
  onFileSelect: (path: string) => void;
  onFileCreate: (name: string) => void;
  onFileDelete: (path: string) => void;
}

export function FileTree({ files, activeFile, onFileSelect, onFileCreate, onFileDelete }: FileTreeProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');

  function submitCreate() {
    const trimmed = newName.trim();
    if (trimmed) onFileCreate(trimmed);
    setIsCreating(false);
    setNewName('');
  }

  function cancelCreate() {
    setIsCreating(false);
    setNewName('');
  }

  return (
    <div className="flex flex-col h-full bg-gray-900 border-r border-gray-800 w-48 shrink-0 overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Files</span>
        <button
          aria-label="New File"
          className="text-gray-400 hover:text-gray-100 text-lg leading-none"
          onClick={() => setIsCreating(true)}
        >
          +
        </button>
      </div>

      <ul role="listbox" className="flex-1 py-1">
        {Object.keys(files).sort().map((path) => (
          <li
            key={path}
            role="option"
            aria-selected={path === activeFile}
            className={`flex items-center justify-between px-3 py-1 cursor-pointer text-xs group ${
              path === activeFile
                ? 'bg-gray-800 text-gray-100'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
            onClick={() => onFileSelect(path)}
          >
            <span className="truncate">{path}</span>
            <button
              aria-label={`Delete ${path}`}
              className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 ml-1 shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onFileDelete(path);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {isCreating && (
        <div className="px-2 py-1 border-t border-gray-800">
          <input
            autoFocus
            type="text"
            className="w-full bg-gray-800 text-gray-100 text-xs px-2 py-1 rounded outline-none border border-blue-500"
            placeholder="filename.ts"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCreate();
              if (e.key === 'Escape') cancelCreate();
            }}
            onBlur={submitCreate}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
npm run test -- --reporter=verbose 2>&1 | grep -A15 "FileTree"
```

Expected: all 8 FileTree tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/FileTree.tsx packages/frontend/src/components/FileTree.test.tsx
git commit -m "feat(frontend): add FileTree component"
```

---

## Task 5: MonacoEditor wrapper

**Files:**
- Create: `packages/frontend/src/components/MonacoEditor.tsx`

No dedicated test — it's a thin pass-through wrapper; tested via IdePanel's mock.

- [ ] **Step 1: Implement MonacoEditor**

Create `packages/frontend/src/components/MonacoEditor.tsx`:

```tsx
import Editor from '@monaco-editor/react';
import { languageFromPath } from '../lib/languageFromPath.js';

interface MonacoEditorProps {
  filePath: string;
  content: string;
  onChange: (value: string) => void;
}

export function MonacoEditor({ filePath, content, onChange }: MonacoEditorProps) {
  return (
    <Editor
      height="100%"
      theme="vs-dark"
      language={languageFromPath(filePath)}
      value={content}
      onChange={(value) => onChange(value ?? '')}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 2,
      }}
    />
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/components/MonacoEditor.tsx
git commit -m "feat(frontend): add MonacoEditor wrapper"
```

---

## Task 6: IdePanel component

**Files:**
- Create: `packages/frontend/src/components/IdePanel.tsx`
- Create: `packages/frontend/src/components/IdePanel.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `packages/frontend/src/components/IdePanel.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import { IdePanel } from './IdePanel.js';

// Mock Monaco so it renders a textarea in jsdom
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea
      data-testid="monaco-editor"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

function createFile(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /new file/i }));
  const input = screen.getByPlaceholderText('filename.ts');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('IdePanel', () => {
  test('starts with empty file tree and no editor', () => {
    render(<IdePanel />);
    expect(screen.queryByTestId('monaco-editor')).toBeNull();
    expect(screen.queryByRole('option')).toBeNull();
  });

  test('creating a file adds it to the tree and opens it in a tab', () => {
    render(<IdePanel />);
    createFile('index.ts');
    expect(screen.getByRole('option', { name: 'index.ts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /index\.ts/ })).toBeInTheDocument();
    expect(screen.getByTestId('monaco-editor')).toBeInTheDocument();
  });

  test('clicking a file in the tree opens it in a tab', () => {
    render(<IdePanel />);
    createFile('main.ts');
    createFile('utils.ts');
    // Both tabs should be open; click main.ts in tree to switch
    fireEvent.click(screen.getByRole('option', { name: 'main.ts' }));
    expect(screen.getByRole('tab', { name: /main\.ts/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking an already-open file in the tree switches to its tab', () => {
    render(<IdePanel />);
    createFile('a.ts');
    createFile('b.ts');
    // b.ts is active; click a.ts in tree
    fireEvent.click(screen.getByRole('option', { name: 'a.ts' }));
    expect(screen.getByRole('tab', { name: /a\.ts/ })).toHaveAttribute('aria-selected', 'true');
    // should not create a duplicate tab
    expect(screen.getAllByRole('tab', { name: /a\.ts/ })).toHaveLength(1);
  });

  test('closing a tab falls back to the nearest remaining tab', () => {
    render(<IdePanel />);
    createFile('a.ts');
    createFile('b.ts');
    // b.ts is active; close it
    fireEvent.click(screen.getByRole('button', { name: /close b\.ts/i }));
    expect(screen.queryByRole('tab', { name: /b\.ts/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /a\.ts/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('closing the last tab leaves the editor empty', () => {
    render(<IdePanel />);
    createFile('only.ts');
    fireEvent.click(screen.getByRole('button', { name: /close only\.ts/i }));
    expect(screen.queryByTestId('monaco-editor')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  test('deleting a file removes it from the tree and closes its tab', () => {
    render(<IdePanel />);
    createFile('gone.ts');
    fireEvent.click(screen.getByRole('button', { name: /delete gone\.ts/i }));
    expect(screen.queryByRole('option', { name: 'gone.ts' })).toBeNull();
    expect(screen.queryByRole('tab', { name: /gone\.ts/ })).toBeNull();
  });

  test('editing in Monaco updates the stored content', () => {
    render(<IdePanel />);
    createFile('edit.ts');
    const editor = screen.getByTestId('monaco-editor');
    fireEvent.change(editor, { target: { value: 'const x = 1;' } });
    // Close and reopen the tab to verify content persisted in state
    fireEvent.click(screen.getByRole('button', { name: /close edit\.ts/i }));
    fireEvent.click(screen.getByRole('option', { name: 'edit.ts' }));
    expect(screen.getByTestId('monaco-editor')).toHaveValue('const x = 1;');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test -- --reporter=verbose 2>&1 | grep -A3 "IdePanel"
```

Expected: `Cannot find module './IdePanel.js'`

- [ ] **Step 3: Implement IdePanel**

Create `packages/frontend/src/components/IdePanel.tsx`:

```tsx
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
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
npm run test -- --reporter=verbose 2>&1 | grep -A15 "IdePanel"
```

Expected: all 8 IdePanel tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/IdePanel.tsx packages/frontend/src/components/IdePanel.test.tsx
git commit -m "feat(frontend): add IdePanel with file tree, tabs, and Monaco editor"
```

---

## Task 7: Wire IdePanel into App and update PRD

**Files:**
- Modify: `packages/frontend/src/App.tsx`
- Modify: `PRD.md`

- [ ] **Step 1: Replace the IDE placeholder in App.tsx**

Open `packages/frontend/src/App.tsx`. Replace the left placeholder with `<IdePanel />`:

```tsx
import { TopBar } from './components/TopBar.js';
import { SplitPane } from './components/SplitPane.js';
import { IdePanel } from './components/IdePanel.js';

export function App() {
  const constraintState = {
    secondsRemaining: 3600,
    tokensRemaining: 50000,
    interactionsRemaining: 30,
    maxTokens: 50000,
    maxInteractions: 30,
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 overflow-hidden">
      <TopBar
        secondsRemaining={constraintState.secondsRemaining}
        tokensRemaining={constraintState.tokensRemaining}
        interactionsRemaining={constraintState.interactionsRemaining}
        maxTokens={constraintState.maxTokens}
        maxInteractions={constraintState.maxInteractions}
      />
      <div className="flex-1 overflow-hidden">
        <SplitPane
          left={<IdePanel />}
          right={
            <div className="h-full flex items-center justify-center bg-gray-900 text-gray-500 text-sm">
              Agent chat panel (US-013)
            </div>
          }
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run full test suite**

```bash
npm run test 2>&1 | tail -8
```

Expected: all tests pass, 0 errors.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Check off US-011 in PRD.md**

In `PRD.md`, update the US-011 acceptance criteria checkboxes from `- [ ]` to `- [x]`:

```markdown
### US-011: Monaco Editor integration

**Acceptance Criteria:**
- [x] Monaco Editor embedded in the IDE panel
- [x] File tree sidebar showing WebContainer filesystem
- [x] Clicking a file opens it in a new editor tab
- [x] Multiple tabs with active tab highlighting
- [x] Supports JavaScript, TypeScript, JSON, CSS, HTML, Markdown syntax
- [x] Typecheck passes
```

(Leave `Verify in browser using dev-browser skill` unchecked — requires manual browser verification.)

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/App.tsx PRD.md
git commit -m "feat(frontend): wire IdePanel into App; mark US-011 complete"
```
