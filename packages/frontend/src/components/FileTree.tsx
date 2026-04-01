import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileTreeProps {
  files: Record<string, string>;
  activeFile: string | null;
  onFileSelect: (path: string) => void;
  onFileCreate: (name: string) => void;
  onFileDelete: (path: string) => void;
}

interface RenderNode {
  name: string;
  path: string;
  isDir: boolean;
  children: RenderNode[];
}

// ─── Tree builder ─────────────────────────────────────────────────────────────

const IGNORED = ['node_modules', '.git', '.DS_Store'];

export function buildRenderTree(files: Record<string, string>): RenderNode[] {
  // Filter out any path whose segments include an ignored name
  const paths = Object.keys(files).filter(
    (p) => !p.split('/').some((seg) => IGNORED.includes(seg)),
  );

  // Derive all directory paths from file path prefixes
  const dirSet = new Set<string>();
  for (const p of paths) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      dirSet.add(segs.slice(0, i).join('/'));
    }
  }

  // Only leaf paths (not a directory prefix) become file nodes
  const leafFiles = paths.filter((p) => !dirSet.has(p));

  type INode = { isDir: boolean; path: string; children: Map<string, INode> };

  function insert(map: Map<string, INode>, segs: string[], depth: number) {
    const seg = segs[depth]!;
    const isLast = depth === segs.length - 1;
    const nodePath = segs.slice(0, depth + 1).join('/');
    if (!map.has(seg)) {
      map.set(seg, { isDir: !isLast, path: nodePath, children: new Map() });
    }
    if (!isLast) insert(map.get(seg)!.children, segs, depth + 1);
  }

  const root = new Map<string, INode>();
  for (const fp of leafFiles) insert(root, fp.split('/'), 0);

  function toArr(map: Map<string, INode>): RenderNode[] {
    return [...map.entries()]
      .map(([name, node]) => ({
        name,
        path: node.path,
        isDir: node.isDir,
        children: node.isDir ? toArr(node.children) : [],
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  return toArr(root);
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      <path
        fill="var(--color-icon-file)"
        d="M3 1.5A1.5 1.5 0 014.5 0h5.793L13 2.707V14.5A1.5 1.5 0 0111.5 16h-7A1.5 1.5 0 013 14.5v-13zm1.5-.5a.5.5 0 00-.5.5v13a.5.5 0 00.5.5h7a.5.5 0 00.5-.5V3h-2.5A.5.5 0 019 2.5V1H4.5z"
      />
      <path fill="var(--color-icon-file)" fillOpacity={0.5} d="M9 1l3 3H9V1z" />
    </svg>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      {open ? (
        <path
          fill="var(--color-icon-folder-open)"
          d="M1 3.5A1.5 1.5 0 012.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0115 5.5v1H1V3.5zm0 3v6A1.5 1.5 0 002.5 14h11a1.5 1.5 0 001.5-1.5v-6H1z"
        />
      ) : (
        <path
          fill="var(--color-icon-folder-closed)"
          d="M1 3.5A1.5 1.5 0 012.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0115 5.5v7A1.5 1.5 0 0113.5 14h-11A1.5 1.5 0 011 12.5v-9z"
        />
      )}
    </svg>
  );
}

// ─── Tree node renderer ───────────────────────────────────────────────────────

interface NodeProps {
  node: RenderNode;
  depth: number;
  activeFile: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onFileSelect: (path: string) => void;
  onFileDelete: (path: string) => void;
}

function TreeNode({ node, depth, activeFile, expanded, onToggle, onFileSelect, onFileDelete }: NodeProps) {
  const indent = 12 + depth * 14;
  const isOpen = expanded.has(node.path);

  if (node.isDir) {
    return (
      <>
        <motion.li
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.1 }}
          className="flex items-center gap-1.5 py-[3px] cursor-pointer"
          style={{ paddingLeft: `${indent}px`, paddingRight: '6px', color: 'var(--color-text-muted)' }}
          onClick={() => onToggle(node.path)}
          data-testid="folder-node"
          aria-label={node.name}
        >
          <span style={{ color: 'var(--color-text-dimmer)', fontSize: '8px', width: '8px', flexShrink: 0 }}>
            {isOpen ? '▼' : '▶'}
          </span>
          <FolderIcon open={isOpen} />
          <span className="text-xs truncate">{node.name}</span>
        </motion.li>
        {isOpen &&
          node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFile={activeFile}
              expanded={expanded}
              onToggle={onToggle}
              onFileSelect={onFileSelect}
              onFileDelete={onFileDelete}
            />
          ))}
      </>
    );
  }

  const isActive = node.path === activeFile;
  return (
    <motion.li
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -4 }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
      role="option"
      aria-selected={isActive}
      aria-label={node.path}
      className="flex items-center gap-2 py-[3px] cursor-pointer group"
      style={{
        paddingLeft: isActive ? `${indent - 2}px` : `${indent}px`,
        paddingRight: '6px',
        background: isActive ? 'var(--color-bg-active-node)' : undefined,
        color: isActive ? 'var(--color-text-main)' : 'var(--color-text-dim)',
        borderLeft: isActive ? '2px solid var(--color-border-accent)' : '2px solid transparent',
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          (e.currentTarget as HTMLLIElement).style.background = 'var(--color-bg-hover-node)';
          (e.currentTarget as HTMLLIElement).style.color = 'var(--color-text-muted)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          (e.currentTarget as HTMLLIElement).style.background = '';
          (e.currentTarget as HTMLLIElement).style.color = 'var(--color-text-dim)';
        }
      }}
      onClick={() => onFileSelect(node.path)}
    >
      <FileIcon />
      <span className="text-xs truncate flex-1">{node.name}</span>
      <button
        aria-label={`Delete ${node.path}`}
        className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
        style={{ color: 'var(--color-text-dim)', padding: '1px' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#884444'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-dim)'; }}
        onClick={(e) => {
          e.stopPropagation();
          onFileDelete(node.path);
        }}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z" />
        </svg>
      </button>
    </motion.li>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export function FileTree({ files, activeFile, onFileSelect, onFileCreate, onFileDelete }: FileTreeProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const tree = buildRenderTree(files);

  function toggleDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function expandParents(filePath: string) {
    const segs = filePath.split('/');
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < segs.length; i++) {
        next.add(segs.slice(0, i).join('/'));
      }
      return next;
    });
  }

  function submitCreate() {
    const trimmed = newName.trim();
    if (trimmed) {
      onFileCreate(trimmed);
      expandParents(trimmed);
    }
    setIsCreating(false);
    setNewName('');
  }

  function cancelCreate() {
    setIsCreating(false);
    setNewName('');
  }

  return (
    <div
      className="flex flex-col h-full shrink-0 overflow-hidden select-none"
      style={{ width: '200px', background: 'var(--color-bg-sidebar)' }}
    >
      {/* Explorer header */}
      <div
        className="flex items-center justify-between px-3 shrink-0"
        style={{ height: '36px' }}
      >
        <span
          className="text-[9px] font-semibold uppercase tracking-widest"
          style={{ color: 'var(--color-text-dim)' }}
        >
          Explorer
        </span>
        <button
          aria-label="New File"
          title="New File"
          className="flex items-center justify-center w-5 h-5 rounded transition-colors"
          style={{ color: 'var(--color-text-dim)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-dim)'; }}
          onClick={() => setIsCreating(true)}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9.5 1.1l3.4 3.5.1.4v2h-1V6H9V2H4v11h4v1H3.5l-.5-.5v-12l.5-.5h5.7l.3.1zM10 2v3h2.9L10 2zm4 11h-2v-2H11v2H9v1h2v2h1v-2h2v-1z"/>
          </svg>
        </button>
      </div>

      {/* File list */}
      <ul role="listbox" className="flex-1 overflow-y-auto">
        <AnimatePresence>
          {isCreating && (
            <motion.li
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1, ease: 'easeOut' }}
              className="flex items-center gap-2 py-[3px]"
              style={{ paddingLeft: '12px', paddingRight: '8px' }}
            >
              <FileIcon />
              <input
                autoFocus
                type="text"
                className="flex-1 min-w-0 bg-transparent text-xs outline-none"
                style={{
                  color: 'var(--color-text-main)',
                  borderBottom: '1px solid var(--color-border-accent)',
                  paddingBottom: '1px',
                }}
                placeholder="filename.ts"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitCreate();
                  if (e.key === 'Escape') cancelCreate();
                }}
                onBlur={submitCreate}
              />
            </motion.li>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              activeFile={activeFile}
              expanded={expanded}
              onToggle={toggleDir}
              onFileSelect={onFileSelect}
              onFileDelete={onFileDelete}
            />
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
