import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import type { AgentConfig, AgentProvider, Constraint } from './types.js';

// ─── Config Types ─────────────────────────────────────────────────────────────

export interface PromptConfig {
  id: string;
  title: string;
  description?: string;
  difficulty?: string;
  tags?: string[];
}

export interface DatabaseConfig {
  provider: 'sqlite' | 'postgres';
  path?: string;             // SQLite file path (default: lintic.db)
  connection_string?: string; // Postgres connection string
}

export interface Config {
  agent: AgentConfig;
  constraints: Constraint;
  prompts: PromptConfig[];
  database?: DatabaseConfig;
}

// ─── Env Var Resolution ───────────────────────────────────────────────────────

const ENV_VAR_RE = /\$\{([^}]+)\}/g;

export function resolveEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_VAR_RE, (_, name: string) => {
      const resolved = process.env[name];
      if (resolved === undefined) {
        throw new Error(`Missing env var: ${name}`);
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const VALID_PROVIDERS: AgentProvider[] = ['openai-compatible', 'anthropic-native', 'groq'];

function err(msg: string): never {
  throw new Error(`Config error: ${msg}`);
}

function assertObj(val: unknown, path: string): Record<string, unknown> {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    err(`${path} must be an object`);
  }
  return val as Record<string, unknown>;
}

function assertPositiveNumber(val: unknown, field: string): number {
  if (typeof val !== 'number' || val <= 0) {
    err(`${field} must be a positive number`);
  }
  return val;
}

function assertNonEmptyString(val: unknown, field: string): string {
  if (typeof val !== 'string' || val.trim() === '') {
    err(`${field} is required`);
  }
  return val;
}

export function validateConfig(raw: unknown): Config {
  const root = assertObj(raw, 'Config');

  // ── agent ──
  const rawAgent = assertObj(root.agent, 'agent');

  const provider = rawAgent.provider as AgentProvider;
  if (!VALID_PROVIDERS.includes(provider)) {
    err(`agent.provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
  }
  const api_key = assertNonEmptyString(rawAgent.api_key, 'agent.api_key');
  const model = assertNonEmptyString(rawAgent.model, 'agent.model');
  const base_url = typeof rawAgent.base_url === 'string' ? rawAgent.base_url : undefined;

  const agent: AgentConfig = { provider, api_key, model, ...(base_url ? { base_url } : {}) };

  // ── constraints ──
  const rawConstraints = assertObj(root.constraints, 'constraints');

  const constraints: Constraint = {
    max_session_tokens: assertPositiveNumber(rawConstraints.max_session_tokens, 'max_session_tokens'),
    max_message_tokens: assertPositiveNumber(rawConstraints.max_message_tokens, 'max_message_tokens'),
    context_window: assertPositiveNumber(rawConstraints.context_window, 'context_window'),
    max_interactions: assertPositiveNumber(rawConstraints.max_interactions, 'max_interactions'),
    time_limit_minutes: assertPositiveNumber(rawConstraints.time_limit_minutes, 'time_limit_minutes'),
  };

  // ── prompts ──
  if (!Array.isArray(root.prompts) || root.prompts.length === 0) {
    err('prompts must be a non-empty array');
  }

  const prompts: PromptConfig[] = (root.prompts as unknown[]).map((p, i) => {
    const rawPrompt = assertObj(p, `prompts[${i}]`);
    const id = assertNonEmptyString(rawPrompt.id, `prompts[${i}].id`);
    const title = assertNonEmptyString(rawPrompt.title, `prompts[${i}].title`);
    const description = typeof rawPrompt.description === 'string' ? rawPrompt.description : undefined;
    const difficulty = typeof rawPrompt.difficulty === 'string' ? rawPrompt.difficulty : undefined;
    const tags = Array.isArray(rawPrompt.tags)
      ? (rawPrompt.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;
    return { id, title, ...(description ? { description } : {}), ...(difficulty ? { difficulty } : {}), ...(tags ? { tags } : {}) };
  });

  // ── database (optional) ──
  let database: DatabaseConfig | undefined;
  if (root.database !== undefined) {
    const rawDb = assertObj(root.database, 'database');
    const dbProvider = rawDb.provider;
    if (dbProvider !== 'sqlite' && dbProvider !== 'postgres') {
      err("database.provider must be 'sqlite' or 'postgres'");
    }
    database = { provider: dbProvider };
    if (typeof rawDb.path === 'string') database.path = rawDb.path;
    if (typeof rawDb.connection_string === 'string') database.connection_string = rawDb.connection_string;
  }

  return { agent, constraints, prompts, ...(database ? { database } : {}) };
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export function loadConfig(filePath: string): Config {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw);
  const resolved = resolveEnvVars(parsed);
  return validateConfig(resolved);
}
