import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, SQLiteAdapter } from '@lintic/core';
import { OpenAIAdapter, AnthropicAdapter } from '@lintic/adapters';
import { createApp } from './app.js';

/** Locate lintic.yml — checks CWD first, then walks up to the monorepo root. */
function findConfigPath(): string {
  if (existsSync('./lintic.yml')) return './lintic.yml';
  // When running from packages/backend, the repo root is three levels up from src/index.ts
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const candidate = join(repoRoot, 'lintic.yml');
  if (existsSync(candidate)) return candidate;
  throw new Error(
    'lintic.yml not found. Create one in the current directory or the repo root.',
  );
}

const config = loadConfig(findConfigPath());
const db = new SQLiteAdapter();

const adapter =
  config.agent.provider === 'anthropic-native' ? new AnthropicAdapter() : new OpenAIAdapter();

await adapter.init(config.agent);

const app = createApp(db, adapter, config);
const port = process.env['PORT'] ? Number(process.env['PORT']) : 3000;

app.listen(port, () => {
  console.log(`Lintic backend listening on port ${port}`);
});
