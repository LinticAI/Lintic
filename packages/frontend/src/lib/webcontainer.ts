import { WebContainer } from '@webcontainer/api';

let instance: WebContainer | null = null;
let bootPromise: Promise<WebContainer> | null = null;
let mockPgBundlePromise: Promise<string> | null = null;

const MOCK_PG_DIR = 'node_modules/lintic-mock-pg';
const MOCK_PG_MANIFEST = JSON.stringify({
  name: 'lintic-mock-pg',
  version: '0.0.1',
  type: 'module',
  main: './index.js',
  exports: {
    '.': './index.js',
  },
}, null, 2);

async function fetchMockPgBundle(): Promise<string> {
  if (!mockPgBundlePromise) {
    mockPgBundlePromise = fetch('/lintic-mock-pg.js', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch lintic-mock-pg bundle (HTTP ${response.status})`);
      }
      return response.text();
    });
  }
  return mockPgBundlePromise;
}

async function ensureMockPgPackage(wc: WebContainer): Promise<void> {
  const bundle = await fetchMockPgBundle();
  await wc.fs.mkdir(MOCK_PG_DIR, { recursive: true });
  await wc.fs.writeFile(`${MOCK_PG_DIR}/package.json`, MOCK_PG_MANIFEST);
  await wc.fs.writeFile(`${MOCK_PG_DIR}/index.js`, bundle);
}

export async function ensureMockPgPackageInstalled(): Promise<void> {
  const wc = await getWebContainer();
  await ensureMockPgPackage(wc);
}

export async function getWebContainer(): Promise<WebContainer> {
  if (instance) return instance;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      const wc = await WebContainer.boot();
      await ensureMockPgPackage(wc);
      instance = wc;
      return wc;
    } catch (err) {
      bootPromise = null; // Allow retry on failure
      throw err;
    }
  })();

  return bootPromise;
}

export async function writeFile(path: string, content: string): Promise<void> {
  const wc = await getWebContainer();
  const segments = path.split('/').filter(Boolean);
  if (segments.length > 1) {
    const parentDir = `${path.startsWith('/') ? '/' : ''}${segments.slice(0, -1).join('/')}`;
    await wc.fs.mkdir(parentDir, { recursive: true });
  }
  await wc.fs.writeFile(path, content);
}

export async function readFile(path: string): Promise<string> {
  const wc = await getWebContainer();
  return wc.fs.readFile(path, 'utf-8');
}

export async function duplicate(path: string): Promise<string> {
  const content = await readFile(path);
  const parts = path.split('.');
  const ext = parts.pop();
  const newPath = `${parts.join('.')}-copy.${ext}`;
  await writeFile(newPath, content);
  return newPath;
}

export async function mkdir(path: string): Promise<void> {
  const wc = await getWebContainer();
  await wc.fs.mkdir(path, { recursive: true });
}

export async function rename(oldPath: string, newPath: string): Promise<void> {
  const wc = await getWebContainer();
  await wc.fs.rename(oldPath, newPath);
}

export async function rm(path: string): Promise<void> {
  const wc = await getWebContainer();
  await wc.fs.rm(path, { recursive: true, force: true });
}

export async function watchFiles(
  path: string,
  listener: (event: string, filename: string | Uint8Array) => void,
): Promise<() => void> {
  const wc = await getWebContainer();
  const watcher = wc.fs.watch(path, { recursive: true }, listener);
  return () => watcher.close();
}

/** Only for use in tests — resets singleton state between test cases. */
export function resetForTests(): void {
  instance = null;
  bootPromise = null;
  mockPgBundlePromise = null;
}
