import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import { FileTree, buildRenderTree } from './FileTree.js';

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

  test('renders folder nodes for nested files', () => {
    render(
      <FileTree
        files={{ 'src/index.ts': '', 'src/App.tsx': '' }}
        activeFile={null}
        onFileSelect={vi.fn()}
        onFileCreate={vi.fn()}
        onFileDelete={vi.fn()}
      />
    );
    expect(screen.getByTestId('folder-node')).toBeInTheDocument();
    expect(screen.getByLabelText('src')).toBeInTheDocument();
  });

  test('folder children are hidden until clicked', () => {
    render(
      <FileTree
        files={{ 'src/index.ts': '' }}
        activeFile={null}
        onFileSelect={vi.fn()}
        onFileCreate={vi.fn()}
        onFileDelete={vi.fn()}
      />
    );
    // File not visible before expanding
    expect(screen.queryByRole('option', { name: 'src/index.ts' })).toBeNull();
    // Click folder to expand
    fireEvent.click(screen.getByTestId('folder-node'));
    expect(screen.getByRole('option', { name: 'src/index.ts' })).toBeInTheDocument();
    // Click again to collapse
    fireEvent.click(screen.getByTestId('folder-node'));
    expect(screen.queryByRole('option', { name: 'src/index.ts' })).toBeNull();
  });

  test('clicking a nested file calls onFileSelect with full path', () => {
    const onFileSelect = vi.fn();
    render(
      <FileTree
        files={{ 'src/utils.ts': '' }}
        activeFile={null}
        onFileSelect={onFileSelect}
        onFileCreate={vi.fn()}
        onFileDelete={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('folder-node'));
    fireEvent.click(screen.getByRole('option', { name: 'src/utils.ts' }));
    expect(onFileSelect).toHaveBeenCalledWith('src/utils.ts');
  });
});

describe('buildRenderTree', () => {
  test('filters out node_modules paths', () => {
    const tree = buildRenderTree({
      'index.ts': '',
      'node_modules/react/index.js': '',
      'src/node_modules/foo/bar.js': '',
    });
    const allPaths = (nodes: ReturnType<typeof buildRenderTree>): string[] =>
      nodes.flatMap((n) => [n.path, ...allPaths(n.children)]);
    const paths = allPaths(tree);
    expect(paths).toContain('index.ts');
    expect(paths.every((p) => !p.includes('node_modules'))).toBe(true);
  });

  test('filters out .git paths', () => {
    const tree = buildRenderTree({
      'index.ts': '',
      '.git/HEAD': '',
      '.git/config': '',
    });
    const allPaths = (nodes: ReturnType<typeof buildRenderTree>): string[] =>
      nodes.flatMap((n) => [n.path, ...allPaths(n.children)]);
    const paths = allPaths(tree);
    expect(paths.every((p) => !p.includes('.git'))).toBe(true);
  });

  test('directories sort before files', () => {
    const tree = buildRenderTree({ 'z.ts': '', 'a/b.ts': '' });
    expect(tree[0]!.isDir).toBe(true);
    expect(tree[1]!.isDir).toBe(false);
  });
});
