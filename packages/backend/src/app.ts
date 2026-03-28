import express, { type Express } from 'express';
import type { DatabaseAdapter, AgentAdapter, Config } from '@lintic/core';
import { createApiRouter } from './routes/api.js';

export function createApp(db: DatabaseAdapter, adapter: AgentAdapter, config: Config): Express {
  const app = express();
  app.use(express.json());

  app.use('/api', createApiRouter(db, adapter, config));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
