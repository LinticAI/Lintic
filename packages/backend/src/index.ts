import { loadConfig } from '@lintic/core';
import { OpenAIAdapter, AnthropicAdapter } from '@lintic/adapters';
import { createApp } from './app.js';
import { createDatabase, findConfigPath, loadEnv, resolveFrontendDistPath } from './runtime.js';

loadEnv();
const config = loadConfig(findConfigPath());
const db = await createDatabase(config);

const adapter =
  config.agent.provider === 'anthropic-native' ? new AnthropicAdapter() : new OpenAIAdapter();

await adapter.init(config.agent);

const app = createApp(db, adapter, config, {
  frontendDistPath: resolveFrontendDistPath(),
});
const port = 3300;

app.listen(port, () => {
  console.log(`Lintic backend listening on port ${port}`);
});
