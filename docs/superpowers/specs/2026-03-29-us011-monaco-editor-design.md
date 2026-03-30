# US-011: Monaco Editor Integration — Design Spec

**Date:** 2026-03-29
**Status:** Approved
**PRD Story:** US-011

---

## Overview

Embed Monaco Editor into the left IDE panel with a file tree sidebar, tab bar, and in-memory filesystem. Users can create files, write code, and switch between open files. Designed to swap in WebContainers (US-012) later by replacing the in-memory state source.

---

## Component Structure

```
IdePanel                          (stateful — owns files, openTabs, activeTab)
├── FileTree                      (dumb — shows file list, create button, delete)
│     props: files, activeFile, onFileSelect, onFileCreate, onFileDelete
├── TabBar                        (dumb — shows open tabs, close button per tab)
│     props: tabs, activeTab, onTabSelect, onTabClose
└── MonacoEditor                  (thin wrapper around @monaco-editor/react)
      props: filePath, content, onChange
```

**State shape in `IdePanel`:**
```ts
files: Record<string, string>   // filename → content
openTabs: string[]               // ordered list of open file paths
activeTab: string | null         // currently visible file
```

---

## Data Flow

- **Create file**: user clicks "New File" → prompted for filename → `files[name] = ''`, pushed to `openTabs`, set as `activeTab`
- **Select file from tree**: if not in `openTabs`, push it; set `activeTab`
- **Edit file**: Monaco `onChange(value)` → update `files[activeTab]`
- **Switch tab**: set `activeTab`
- **Close tab**: remove from `openTabs`; activate nearest remaining tab or `null` if none
- **Delete file**: remove from `files`, close its tab if open

No persistence — state resets on page reload. US-012 will replace the in-memory `files` map with the WebContainer filesystem.

---

## Package

- `@monaco-editor/react` — React wrapper handling loading, resizing, theming
- Language detection from file extension: `.ts`/`.tsx` → typescript, `.js`/`.jsx` → javascript, `.json` → json, `.css` → css, `.html` → html, `.md` → markdown

---

## File Layout

```
packages/frontend/src/components/
├── IdePanel.tsx
├── IdePanel.test.tsx
├── FileTree.tsx
├── FileTree.test.tsx
├── TabBar.tsx
├── TabBar.test.tsx
└── MonacoEditor.tsx          (no dedicated test — mocked in IdePanel tests)
```

`App.tsx` passes `<IdePanel />` as the `left` prop to `SplitPane`.

---

## Testing

Mock `@monaco-editor/react` with a plain `<textarea>` in tests (Monaco doesn't run in jsdom).

Key test cases:
- Creating a file adds it to the tree and opens it in a tab
- Clicking a file in the tree opens it, or switches to it if already open
- Closing a tab falls back to the nearest open tab
- Closing the last tab leaves the editor empty (`activeTab === null`)
- Deleting a file removes it from tree and closes its tab
- Language is correctly inferred from extension

---

## Out of Scope

- File renaming (future)
- Directory/folder support (future — WebContainers will drive this)
- Persistence across page reloads (US-012)
- Diff view (US-016)
