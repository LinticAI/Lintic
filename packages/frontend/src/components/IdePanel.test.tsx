import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, test, it, expect, vi, beforeEach } from 'vitest';
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
  loader: { init: () => Promise.resolve({ editor: { defineTheme: () => {} } }) },
}));

const { mockWriteFile, mockReadFile, mockStopWatch, getCapturedWatchListener, setCapturedWatchListener } =
  vi.hoisted(() => {
    let _capturedWatchListener: ((event: string, filename: string) => void) | null = null;
    return {
      mockWriteFile: vi.fn().mockResolvedValue(undefined),
      mockReadFile: vi.fn().mockResolvedValue('from-wc'),
      mockStopWatch: vi.fn(),
      getCapturedWatchListener: () => _capturedWatchListener,
      setCapturedWatchListener: (l: ((event: string, filename: string) => void) | null) => {
        _capturedWatchListener = l;
      },
    };
  });

// Mock WebContainer modules — we don't want real container boots in unit tests.
vi.mock('../lib/webcontainer.js', () => ({
  getWebContainer: vi.fn().mockResolvedValue({}),
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  watchFiles: vi.fn().mockImplementation((_path: string, listener: any) => {
    setCapturedWatchListener(listener);
    return Promise.resolve(mockStopWatch);
  }),
}));

const mockWc = { fs: {} };

vi.mock('../hooks/useWebContainer.js', () => ({
  useWebContainer: () => ({ wc: mockWc, ready: true, error: null }),
}));

// Mock Terminal so xterm.js doesn't need a real DOM canvas.
vi.mock('./Terminal.js', () => ({
  Terminal: vi.fn().mockImplementation(() => <div data-testid="terminal" />),
}));

beforeEach(() => {
  vi.clearAllMocks();
  setCapturedWatchListener(null);
  mockWriteFile.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue('from-wc');
});

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

// ── US-012 tests ──────────────────────────────────────────────────────────────

describe('IdePanel — Monaco→WC sync', () => {
  it('writes file to WC when Monaco onChange fires', async () => {
    render(<IdePanel />);
    createFile('index.ts');

    const editor = document.querySelector('textarea')!;
    fireEvent.change(editor, { target: { value: 'const x = 1;' } });

    await waitFor(() =>
      expect(mockWriteFile).toHaveBeenCalledWith('index.ts', 'const x = 1;'),
    );
  });
});

describe('IdePanel — WC→Monaco sync', () => {
  it('updates file content when WC filesystem emits a change event', async () => {
    mockReadFile.mockResolvedValue('updated-from-wc');
    render(<IdePanel />);

    createFile('app.ts');

    await act(async () => {
      getCapturedWatchListener()?.('change', 'app.ts');
    });

    await waitFor(() => expect(mockReadFile).toHaveBeenCalledWith('app.ts'));
  });

  it('ignores changes inside node_modules', async () => {
    render(<IdePanel />);
    await act(async () => {
      getCapturedWatchListener()?.('change', 'node_modules/some-pkg/index.js');
    });
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});

describe('IdePanel — terminal panel', () => {
  it('renders the Terminal component', () => {
    render(<IdePanel />);
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
  });
});
