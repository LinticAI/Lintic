import { loadConfig, SQLiteAdapter } from '@lintic/core';
import { OpenAIAdapter, AnthropicAdapter } from '@lintic/adapters';
import { createApp } from './app.js';

const config = loadConfig('./lintic.yml');
const db = new SQLiteAdapter();

const adapter =
  config.agent.provider === 'anthropic-native' ? new AnthropicAdapter() : new OpenAIAdapter();

await adapter.init(config.agent);

const app = createApp(db, adapter, config);
const port = process.env['PORT'] ? Number(process.env['PORT']) : 3000;

app.listen(port, () => {
  console.log(`Lintic backend listening on port ${port}`);
});
