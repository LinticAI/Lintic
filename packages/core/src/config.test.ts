import { describe, test, expect, afterEach, vi } from 'vitest';
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, validateConfig, resolveEnvVars } from './config.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeYamlFile(obj: unknown): string {
  const dir = os.tmpdir();
  const file = path.join(dir, `lintic-test-${Date.now()}.yml`);
  fs.writeFileSync(file, yaml.dump(obj), 'utf8');
  return file;
}

const VALID_CONFIG = {
  agent: {
    provider: 'openai-compatible',
    api_key: 'sk-test',
    model: 'gpt-4o',
    base_url: 'https://api.openai.com/v1',
  },
  constraints: {
    max_session_tokens: 50000,
    max_message_tokens: 2000,
    context_window: 8000,
    max_interactions: 30,
    time_limit_minutes: 60,
  },
  prompts: [
    {
      id: 'library-api',
      title: 'Library Catalog API',
      difficulty: 'medium',
      tags: ['backend'],
    },
  ],
  database: {
    provider: 'sqlite',
  },
  api: {
    admin_key: 'admin-test-key',
    secret_key: 'secret-test-key',
  },
};

// ── resolveEnvVars ────────────────────────────────────────────────────────────

describe('resolveEnvVars', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('leaves non-template strings unchanged', () => {
    expect(resolveEnvVars('hello')).toBe('hello');
  });

  test('substitutes a ${VAR} reference with the env value', () => {
    vi.stubEnv('TEST_RESOLVE_KEY', 'resolved-value');
    expect(resolveEnvVars('${TEST_RESOLVE_KEY}')).toBe('resolved-value');
  });

  test('substitutes ${VAR} inside a longer string', () => {
    vi.stubEnv('TEST_BASE', 'https://api.example.com');
    expect(resolveEnvVars('${TEST_BASE}/v1')).toBe('https://api.example.com/v1');
  });

  test('throws a descriptive error when the env var is not set', () => {
    expect(() => resolveEnvVars('${MISSING_VAR_XYZ}')).toThrow('Missing env var: MISSING_VAR_XYZ');
  });

  test('recursively resolves values inside objects', () => {
    vi.stubEnv('TEST_OBJ_KEY', 'my-key');
    const result = resolveEnvVars({ api_key: '${TEST_OBJ_KEY}', model: 'gpt-4o' });
    expect((result as Record<string, unknown>).api_key).toBe('my-key');
  });

  test('recursively resolves values inside arrays', () => {
    vi.stubEnv('TEST_ARR_VAL', 'tag1');
    const result = resolveEnvVars(['${TEST_ARR_VAL}', 'tag2']);
    expect(result).toEqual(['tag1', 'tag2']);
  });
});

// ── validateConfig ────────────────────────────────────────────────────────────

describe('validateConfig', () => {
  test('accepts a valid config and returns typed object', () => {
    const config = validateConfig(VALID_CONFIG);
    expect(config.agent.provider).toBe('openai-compatible');
    expect(config.agent.model).toBe('gpt-4o');
    expect(config.constraints.max_session_tokens).toBe(50000);
    expect(config.prompts).toHaveLength(1);
    expect(config.prompts.at(0)?.id).toBe('library-api');
  });

  test('accepts anthropic-native as a valid provider', () => {
    const cfg = { ...VALID_CONFIG, agent: { ...VALID_CONFIG.agent, provider: 'anthropic-native' } };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test('accepts groq as a valid provider', () => {
    const cfg = { ...VALID_CONFIG, agent: { ...VALID_CONFIG.agent, provider: 'groq' } };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test('accepts cerebras as a valid provider', () => {
    const cfg = { ...VALID_CONFIG, agent: { ...VALID_CONFIG.agent, provider: 'cerebras' } };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test('accepts local-openai as a valid provider', () => {
    const cfg = {
      ...VALID_CONFIG,
      agent: {
        provider: 'local-openai',
        model: 'qwen2.5-coder',
      },
    };
    expect(() => validateConfig(cfg)).not.toThrow();
    const config = validateConfig(cfg);
    expect(config.agent.api_key).toBe('local-dev');
    expect(config.agent.base_url).toBe('http://localhost:8080/v1');
  });

  test('throws when agent.provider is invalid', () => {
    const cfg = { ...VALID_CONFIG, agent: { ...VALID_CONFIG.agent, provider: 'unknown-llm' } };
    expect(() => validateConfig(cfg)).toThrow(/agent\.provider/);
  });

  test('throws when agent.api_key is missing', () => {
    const agent = { provider: VALID_CONFIG.agent.provider, model: VALID_CONFIG.agent.model };
    const cfg = { ...VALID_CONFIG, agent };
    expect(() => validateConfig(cfg)).toThrow(/agent\.api_key/);
  });

  test('throws when agent.api_key is an empty string', () => {
    const cfg = { ...VALID_CONFIG, agent: { ...VALID_CONFIG.agent, api_key: '' } };
    expect(() => validateConfig(cfg)).toThrow(/agent\.api_key/);
  });

  test('allows local-openai without an api key', () => {
    const cfg = {
      ...VALID_CONFIG,
      agent: {
        provider: 'local-openai',
        api_key: '',
        model: 'qwen2.5-coder',
      },
    };
    const config = validateConfig(cfg);
    expect(config.agent.api_key).toBe('local-dev');
  });

  test('throws when agent.model is missing', () => {
    const agent = { provider: VALID_CONFIG.agent.provider, api_key: VALID_CONFIG.agent.api_key };
    const cfg = { ...VALID_CONFIG, agent };
    expect(() => validateConfig(cfg)).toThrow(/agent\.model/);
  });

  test('throws when agent.model is an empty string', () => {
    const cfg = { ...VALID_CONFIG, agent: { ...VALID_CONFIG.agent, model: '' } };
    expect(() => validateConfig(cfg)).toThrow(/agent\.model/);
  });

  test('throws when max_session_tokens is zero', () => {
    const cfg = {
      ...VALID_CONFIG,
      constraints: { ...VALID_CONFIG.constraints, max_session_tokens: 0 },
    };
    expect(() => validateConfig(cfg)).toThrow(/max_session_tokens/);
  });

  test('throws when max_message_tokens is negative', () => {
    const cfg = {
      ...VALID_CONFIG,
      constraints: { ...VALID_CONFIG.constraints, max_message_tokens: -1 },
    };
    expect(() => validateConfig(cfg)).toThrow(/max_message_tokens/);
  });

  test('throws when prompts is empty', () => {
    const cfg = { ...VALID_CONFIG, prompts: [] };
    expect(() => validateConfig(cfg)).toThrow(/prompts/);
  });

  test('throws when a prompt is missing id', () => {
    const cfg = {
      ...VALID_CONFIG,
      prompts: [{ title: 'No ID Prompt' }],
    };
    expect(() => validateConfig(cfg)).toThrow(/prompt.*id/i);
  });

  test('throws when a prompt is missing title', () => {
    const cfg = {
      ...VALID_CONFIG,
      prompts: [{ id: 'no-title' }],
    };
    expect(() => validateConfig(cfg)).toThrow(/prompt.*title/i);
  });

  test('throws when the top-level value is null', () => {
    expect(() => validateConfig(null)).toThrow(/Config error/);
  });

  test('accepts a valid database config', () => {
    const cfg = {
      ...VALID_CONFIG,
      database: { provider: 'sqlite' },
    };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test('throws when database.provider is invalid', () => {
    const cfg = {
      ...VALID_CONFIG,
      database: { provider: 'mysql' },
    };
    expect(() => validateConfig(cfg)).toThrow(/database\.provider/);
  });

  test('accepts config without a database section', () => {
    const cfgWithout = { agent: VALID_CONFIG.agent, constraints: VALID_CONFIG.constraints, prompts: VALID_CONFIG.prompts };
    expect(() => validateConfig(cfgWithout)).not.toThrow();
  });

  test('accepts optional api config', () => {
    const config = validateConfig(VALID_CONFIG);
    expect(config.api?.admin_key).toBe('admin-test-key');
    expect(config.api?.secret_key).toBe('secret-test-key');
  });
});

// ── loadConfig ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let tmpFile: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  test('parses a valid lintic.yml and returns a typed Config', () => {
    tmpFile = makeYamlFile(VALID_CONFIG);
    const config = loadConfig(tmpFile);
    expect(config.agent.provider).toBe('openai-compatible');
    expect(config.constraints.max_interactions).toBe(30);
  });

  test('resolves ${ENV_VAR} in api_key before validation', () => {
    vi.stubEnv('TEST_LOAD_KEY', 'loaded-secret');
    const raw = {
      ...VALID_CONFIG,
      agent: { ...VALID_CONFIG.agent, api_key: '${TEST_LOAD_KEY}' },
    };
    tmpFile = makeYamlFile(raw);
    const config = loadConfig(tmpFile);
    expect(config.agent.api_key).toBe('loaded-secret');
  });

  test('throws a descriptive error when the file does not exist', () => {
    expect(() => loadConfig('/nonexistent/lintic.yml')).toThrow(/ENOENT|no such file/i);
  });

  test('throws on unparseable YAML with a descriptive error', () => {
    tmpFile = path.join(os.tmpdir(), `lintic-bad-${Date.now()}.yml`);
    fs.writeFileSync(tmpFile, 'agent: {\n  unclosed brace', 'utf8');
    expect(() => loadConfig(tmpFile)).toThrow(/unexpected|end of the stream|unexpected end/i);
  });
});
