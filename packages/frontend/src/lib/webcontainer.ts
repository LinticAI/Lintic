import { WebContainer } from '@webcontainer/api';

// Singleton promise — WebContainer can only be booted once per origin.
let _instance: Promise<WebContainer> | null = null;

/**
 * Returns a promise that resolves to the shared WebContainer instance.
 * The container is booted on the first call; subsequent calls return the
 * same promise.
 */
export function getWebContainer(): Promise<WebContainer> {
  if (!_instance) {
    _instance = WebContainer.boot();
  }
  return _instance;
}

/**
 * Write a file into the WebContainer filesystem.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  const wc = await getWebContainer();
  await wc.fs.writeFile(path, content, 'utf-8');
}

/**
 * Read a file from the WebContainer filesystem.
 */
export async function readFile(path: string): Promise<string> {
  const wc = await getWebContainer();
  return wc.fs.readFile(path, 'utf-8');
}
