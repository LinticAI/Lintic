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

// Mock WebContainer modules — we don't want real container boots in unit tests.
vi.mock('../lib/webcontainer.js', () => ({
  getWebContainer: vi.fn().mockResolvedValue({}),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
}));

vi.mock('../lib/useWebContainer.js', () => ({
  useWebContainer: () => ({ container: null, status: 'idle', error: null }),
}));

// Mock Terminal so xterm.js doesn't need a real DOM canvas.
vi.mock('./Terminal.js', () => ({
  Terminal: () => <div data-testid="terminal" />,
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
