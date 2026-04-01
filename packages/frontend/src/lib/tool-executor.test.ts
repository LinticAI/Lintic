import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor } from './tool-executor.js';
import type { ToolCall } from '@lintic/core';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProcess(output: string) {
  const stream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue(output);
      controller.close();
    },
  });
  return { output: stream, exit: Promise.resolve(0), input: {} as WritableStream<string> };
}

function toolCall(overrides: Partial<ToolCall> & Pick<ToolCall, 'name' | 'input'>): ToolCall {
  return { id: 'tc-1', ...overrides };
}

// ─── Mock WebContainer ────────────────────────────────────────────────────────

const mockFs = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
};

const mockWc = {
  fs: mockFs,
  spawn: vi.fn(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ToolExecutor', () => {
  let executor: ToolExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    executor = new ToolExecutor(mockWc as any);
  });

  // ── read_file ──────────────────────────────────────────────────────────────

  describe('read_file', () => {
    test('returns file content on success', async () => {
      mockFs.readFile.mockResolvedValue('hello world');
      const result = await executor.execute(toolCall({ name: 'read_file', input: { path: '/app/index.ts' } }));
      expect(result).toEqual({ tool_call_id: 'tc-1', name: 'read_file', output: 'hello world', is_error: false });
      expect(mockFs.readFile).toHaveBeenCalledWith('/app/index.ts', 'utf-8');
    });

    test('returns error result when readFile throws', async () => {
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      const result = await executor.execute(toolCall({ name: 'read_file', input: { path: '/missing.ts' } }));
      expect(result.is_error).toBe(true);
      expect(result.output).toContain('File not found');
    });

    test('returns error result on timeout', async () => {
      vi.useFakeTimers();
      mockFs.readFile.mockReturnValue(new Promise(() => { /* never resolves */ }));
      const promise = executor.execute(toolCall({ name: 'read_file', input: { path: '/slow.ts' } }));
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.is_error).toBe(true);
      expect(result.output).toMatch(/Timeout/i);
      vi.useRealTimers();
    });
  });

  // ── write_file ─────────────────────────────────────────────────────────────

  describe('write_file', () => {
    test('returns "ok" on success', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);
      const result = await executor.execute(toolCall({ name: 'write_file', input: { path: '/app/out.ts', content: 'const x = 1;' } }));
      expect(result).toEqual({ tool_call_id: 'tc-1', name: 'write_file', output: 'ok', is_error: false });
      expect(mockFs.writeFile).toHaveBeenCalledWith('/app/out.ts', 'const x = 1;');
    });

    test('returns error result when writeFile throws', async () => {
      mockFs.writeFile.mockRejectedValue(new Error('Permission denied'));
      const result = await executor.execute(toolCall({ name: 'write_file', input: { path: '/readonly.ts', content: 'x' } }));
      expect(result.is_error).toBe(true);
      expect(result.output).toContain('Permission denied');
    });
  });

  // ── run_command ────────────────────────────────────────────────────────────

  describe('run_command', () => {
    test('returns combined output on success', async () => {
      mockWc.spawn.mockResolvedValue(makeProcess('build success\n'));
      const result = await executor.execute(toolCall({ name: 'run_command', input: { command: 'npm run build' } }));
      expect(result).toEqual({ tool_call_id: 'tc-1', name: 'run_command', output: 'build success\n', is_error: false });
      expect(mockWc.spawn).toHaveBeenCalledWith('npm', ['run', 'build']);
    });

    test('splits command on whitespace for spawn args', async () => {
      mockWc.spawn.mockResolvedValue(makeProcess(''));
      await executor.execute(toolCall({ name: 'run_command', input: { command: 'node index.js --port 3000' } }));
      expect(mockWc.spawn).toHaveBeenCalledWith('node', ['index.js', '--port', '3000']);
    });

    test('returns error result on timeout', async () => {
      vi.useFakeTimers();
      const neverEndingStream = new ReadableStream<string>({ start() { /* never closes */ } });
      mockWc.spawn.mockResolvedValue({ output: neverEndingStream, exit: new Promise(() => {}), input: {} });
      const promise = executor.execute(toolCall({ name: 'run_command', input: { command: 'sleep 60' } }));
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.is_error).toBe(true);
      expect(result.output).toMatch(/Timeout/i);
      vi.useRealTimers();
    });
  });

  // ── list_directory ─────────────────────────────────────────────────────────

  describe('list_directory', () => {
    test('lists entries, suffixing directories with /', async () => {
      mockFs.readdir.mockResolvedValue([
        { name: 'src', isDirectory: () => true, isFile: () => false },
        { name: 'package.json', isDirectory: () => false, isFile: () => true },
        { name: 'tsconfig.json', isDirectory: () => false, isFile: () => true },
      ]);
      const result = await executor.execute(toolCall({ name: 'list_directory', input: { path: '/app' } }));
      expect(result.is_error).toBe(false);
      expect(result.output).toBe('src/\npackage.json\ntsconfig.json');
      expect(mockFs.readdir).toHaveBeenCalledWith('/app', { withFileTypes: true });
    });

    test('returns error result when readdir throws', async () => {
      mockFs.readdir.mockRejectedValue(new Error('No such directory'));
      const result = await executor.execute(toolCall({ name: 'list_directory', input: { path: '/nope' } }));
      expect(result.is_error).toBe(true);
      expect(result.output).toContain('No such directory');
    });
  });

  // ── search_files ───────────────────────────────────────────────────────────

  describe('search_files', () => {
    test('spawns grep with pattern and path', async () => {
      mockWc.spawn.mockResolvedValue(makeProcess('src/foo.ts\nsrc/bar.ts\n'));
      const result = await executor.execute(toolCall({ name: 'search_files', input: { pattern: 'useState', path: 'src' } }));
      expect(result.is_error).toBe(false);
      expect(result.output).toBe('src/foo.ts\nsrc/bar.ts\n');
      expect(mockWc.spawn).toHaveBeenCalledWith('grep', ['-rl', 'useState', 'src']);
    });

    test('defaults path to "." when omitted', async () => {
      mockWc.spawn.mockResolvedValue(makeProcess('index.ts\n'));
      await executor.execute(toolCall({ name: 'search_files', input: { pattern: 'TODO' } }));
      expect(mockWc.spawn).toHaveBeenCalledWith('grep', ['-rl', 'TODO', '.']);
    });
  });

  // ── unknown tool ───────────────────────────────────────────────────────────

  describe('unknown tool', () => {
    test('returns error result for unrecognised tool name', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      const badCall = toolCall({ name: 'delete_everything' as any, input: {} });
      const result = await executor.execute(badCall);
      expect(result.is_error).toBe(true);
      expect(result.output).toContain('Unknown tool');
    });
  });

  // ── executeAll ─────────────────────────────────────────────────────────────

  describe('executeAll', () => {
    test('returns one result per call in order', async () => {
      mockFs.readFile
        .mockResolvedValueOnce('content-a')
        .mockResolvedValueOnce('content-b');

      const calls: ToolCall[] = [
        { id: 'a', name: 'read_file', input: { path: '/a.ts' } },
        { id: 'b', name: 'read_file', input: { path: '/b.ts' } },
      ];
      const results = await executor.executeAll(calls);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ tool_call_id: 'a', output: 'content-a', is_error: false });
      expect(results[1]).toMatchObject({ tool_call_id: 'b', output: 'content-b', is_error: false });
    });

    test('preserves order even when individual calls have errors', async () => {
      mockFs.readFile
        .mockRejectedValueOnce(new Error('oops'))
        .mockResolvedValueOnce('ok');

      const calls: ToolCall[] = [
        { id: '1', name: 'read_file', input: { path: '/bad.ts' } },
        { id: '2', name: 'read_file', input: { path: '/good.ts' } },
      ];
      const results = await executor.executeAll(calls);
      expect(results[0]!.is_error).toBe(true);
      expect(results[1]!.is_error).toBe(false);
    });
  });
});
