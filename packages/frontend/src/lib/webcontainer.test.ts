import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFs = {
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('file-content'),
  watch: vi.fn().mockReturnValue({ close: vi.fn() }),
};

const mockWc = { fs: mockFs };

vi.mock('@webcontainer/api', () => ({
  WebContainer: { boot: vi.fn().mockResolvedValue(mockWc) },
}));

const { getWebContainer, ensureMockPgPackageInstalled, writeFile, readFile, watchFiles, resetForTests } =
  await import('./webcontainer.js');

beforeEach(() => {
  resetForTests();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    text: vi.fn().mockResolvedValue('// mock pg bundle'),
  }));
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.readFile.mockResolvedValue('file-content');
  mockFs.watch.mockReturnValue({ close: vi.fn() });
});

describe('getWebContainer', () => {
  it('boots once and returns the same instance', async () => {
    const { WebContainer } = await import('@webcontainer/api');
    const a = await getWebContainer();
    const b = await getWebContainer();
    expect(a).toBe(b);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(WebContainer.boot).toHaveBeenCalledTimes(1);
    expect(mockFs.mkdir).toHaveBeenCalledWith('node_modules/lintic-mock-pg', { recursive: true });
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      'node_modules/lintic-mock-pg/package.json',
      expect.stringContaining('"name": "lintic-mock-pg"'),
    );
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      'node_modules/lintic-mock-pg/index.js',
      '// mock pg bundle',
    );
    expect(fetch).toHaveBeenCalledWith('/lintic-mock-pg.js', { cache: 'no-store' });
  });

  it('can re-install the mock pg package into an already booted container', async () => {
    await getWebContainer();
    vi.clearAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);

    await ensureMockPgPackageInstalled();

    expect(mockFs.mkdir).toHaveBeenCalledWith('node_modules/lintic-mock-pg', { recursive: true });
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      'node_modules/lintic-mock-pg/package.json',
      expect.stringContaining('"name": "lintic-mock-pg"'),
    );
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      'node_modules/lintic-mock-pg/index.js',
      '// mock pg bundle',
    );
  });
});

describe('writeFile', () => {
  it('writes content to the WebContainer filesystem', async () => {
    await writeFile('/index.ts', 'const x = 1;');
    expect(mockFs.writeFile).toHaveBeenCalledWith('/index.ts', 'const x = 1;');
  });
});

describe('readFile', () => {
  it('reads content from the WebContainer filesystem', async () => {
    const content = await readFile('/index.ts');
    expect(content).toBe('file-content');
    expect(mockFs.readFile).toHaveBeenCalledWith('/index.ts', 'utf-8');
  });
});

describe('watchFiles', () => {
  it('registers a watch on the given path and returns a cleanup function', async () => {
    const listener = vi.fn();
    const close = vi.fn();
    mockFs.watch.mockReturnValue({ close });

    const stop = await watchFiles('/', listener);
    expect(mockFs.watch).toHaveBeenCalledWith('/', { recursive: true }, listener);

    stop();
    expect(close).toHaveBeenCalled();
  });
});
