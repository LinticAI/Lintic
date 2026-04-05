import { WebContainer } from '@webcontainer/api';
import type { MockPgPoolExport, SnapshotFile } from '@lintic/core';

let instance: WebContainer | null = null;
let bootPromise: Promise<WebContainer> | null = null;
let mockPgBundlePromise: Promise<string> | null = null;

const MOCK_PG_DIR = 'node_modules/lintic-mock-pg';
const MOCK_PG_EXPORT_PATH = '.lintic/mock-pg/export.json';
const MOCK_PG_BOOTSTRAP_PATH = '.lintic/mock-pg/bootstrap.json';
const EXCLUDED_TOP_LEVEL_PATHS = new Set(['node_modules', '.git', '.cache', 'dist', 'build']);
const MOCK_PG_MANIFEST = JSON.stringify({
  name: 'lintic-mock-pg',
  version: '0.0.1',
  type: 'module',
  main: './index.js',
  exports: {
    '.': './index.js',
  },
}, null, 2);

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

function shouldExcludePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized) {
    return false;
  }

  if (EXCLUDED_TOP_LEVEL_PATHS.has(normalized.split('/')[0]!)) {
    return true;
  }

  return (
    normalized === '.lintic/mock-pg/commands'
    || normalized.startsWith('.lintic/mock-pg/commands/')
    || normalized === '.lintic/mock-pg/responses'
    || normalized.startsWith('.lintic/mock-pg/responses/')
  );
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToUint8Array(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

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

export async function captureWorkspaceSnapshot(root = '/'): Promise<SnapshotFile[]> {
  const wc = await getWebContainer();
  const snapshot: SnapshotFile[] = [];

  const walk = async (currentPath: string): Promise<void> => {
    const entries = await wc.fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      const relativePath = normalizePath(fullPath);
      if (!relativePath || shouldExcludePath(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      try {
        const text = await wc.fs.readFile(fullPath, 'utf-8');
        snapshot.push({
          path: relativePath,
          encoding: 'utf-8',
          content: text,
        });
      } catch {
        const bytes = await wc.fs.readFile(fullPath);
        snapshot.push({
          path: relativePath,
          encoding: 'base64',
          content: uint8ArrayToBase64(bytes),
        });
      }
    }
  };

  await walk(root);
  snapshot.sort((left, right) => left.path.localeCompare(right.path));
  return snapshot;
}

async function listWorkspaceFiles(root = '/'): Promise<string[]> {
  const wc = await getWebContainer();
  const files: string[] = [];

  const walk = async (currentPath: string): Promise<void> => {
    const entries = await wc.fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      const relativePath = normalizePath(fullPath);
      if (!relativePath || shouldExcludePath(relativePath)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(relativePath);
      }
    }
  };

  await walk(root);
  return files;
}

export async function restoreWorkspaceSnapshot(files: SnapshotFile[]): Promise<void> {
  const wc = await getWebContainer();
  const existingFiles = await listWorkspaceFiles('/');
  const nextFiles = new Set(files.map((file) => normalizePath(file.path)));

  for (const path of existingFiles) {
    if (!nextFiles.has(path)) {
      await wc.fs.rm(`/${path}`, { force: true });
    }
  }

  for (const file of files) {
    const normalizedPath = normalizePath(file.path);
    if (!normalizedPath) {
      continue;
    }

    const segments = normalizedPath.split('/');
    if (segments.length > 1) {
      await wc.fs.mkdir(`/${segments.slice(0, -1).join('/')}`, { recursive: true });
    }

    if (file.encoding === 'utf-8') {
      await wc.fs.writeFile(`/${normalizedPath}`, file.content);
    } else {
      await wc.fs.writeFile(`/${normalizedPath}`, base64ToUint8Array(file.content));
    }
  }
}

export async function readMockPgExportState(): Promise<MockPgPoolExport[]> {
  const wc = await getWebContainer();
  try {
    const raw = await wc.fs.readFile(`/${MOCK_PG_EXPORT_PATH}`, 'utf-8');
    const parsed = JSON.parse(raw) as { pools?: MockPgPoolExport[] } | MockPgPoolExport[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return Array.isArray(parsed.pools) ? parsed.pools : [];
  } catch {
    return [];
  }
}

export async function writeMockPgBootstrapState(pools: MockPgPoolExport[]): Promise<void> {
  const wc = await getWebContainer();
  await wc.fs.mkdir('/.lintic/mock-pg', { recursive: true });
  await wc.fs.writeFile(`/${MOCK_PG_BOOTSTRAP_PATH}`, JSON.stringify({ pools }, null, 2));
}

/** Only for use in tests — resets singleton state between test cases. */
export function resetForTests(): void {
  instance = null;
  bootPromise = null;
  mockPgBundlePromise = null;
}
