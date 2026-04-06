import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
// ─── Env Var Resolution ───────────────────────────────────────────────────────
const ENV_VAR_RE = /\$\{([^}]+)\}/g;
export function resolveEnvVars(value) {
    if (typeof value === 'string') {
        return value.replace(ENV_VAR_RE, (_, name) => {
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
        const result = {};
        for (const [k, v] of Object.entries(value)) {
            result[k] = resolveEnvVars(v);
        }
        return result;
    }
    return value;
}
// ─── Validation ───────────────────────────────────────────────────────────────
const VALID_PROVIDERS = ['openai-compatible', 'anthropic-native', 'groq', 'cerebras', 'local-openai'];
const LOCAL_OPENAI_DEFAULT_API_KEY = 'local-dev';
const LOCAL_OPENAI_DEFAULT_BASE_URL = 'http://localhost:8080/v1';
function err(msg) {
    throw new Error(`Config error: ${msg}`);
}
function assertObj(val, path) {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        err(`${path} must be an object`);
    }
    return val;
}
function assertPositiveNumber(val, field) {
    if (typeof val !== 'number' || val <= 0) {
        err(`${field} must be a positive number`);
    }
    return val;
}
function assertNonEmptyString(val, field) {
    if (typeof val !== 'string' || val.trim() === '') {
        err(`${field} is required`);
    }
    return val;
}
export function validateConfig(raw) {
    const root = assertObj(raw, 'Config');
    // ── agent ──
    const rawAgent = assertObj(root.agent, 'agent');
    const provider = rawAgent.provider;
    if (!VALID_PROVIDERS.includes(provider)) {
        err(`agent.provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
    }
    const base_url = typeof rawAgent.base_url === 'string' ? rawAgent.base_url : undefined;
    const api_key = provider === 'local-openai'
        ? (typeof rawAgent.api_key === 'string' && rawAgent.api_key.trim()
            ? rawAgent.api_key.trim()
            : LOCAL_OPENAI_DEFAULT_API_KEY)
        : assertNonEmptyString(rawAgent.api_key, 'agent.api_key');
    const model = assertNonEmptyString(rawAgent.model, 'agent.model');
    const resolvedBaseUrl = provider === 'local-openai'
        ? (base_url?.trim() ? base_url.trim() : LOCAL_OPENAI_DEFAULT_BASE_URL)
        : base_url;
    const agent = { provider, api_key, model, ...(resolvedBaseUrl ? { base_url: resolvedBaseUrl } : {}) };
    // ── constraints ──
    const rawConstraints = assertObj(root.constraints, 'constraints');
    const constraints = {
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
    const prompts = root.prompts.map((p, i) => {
        const rawPrompt = assertObj(p, `prompts[${i}]`);
        const id = assertNonEmptyString(rawPrompt.id, `prompts[${i}].id`);
        const title = assertNonEmptyString(rawPrompt.title, `prompts[${i}].title`);
        const description = typeof rawPrompt.description === 'string' ? rawPrompt.description : undefined;
        const difficulty = typeof rawPrompt.difficulty === 'string' ? rawPrompt.difficulty : undefined;
        const tags = Array.isArray(rawPrompt.tags)
            ? rawPrompt.tags.filter((t) => typeof t === 'string')
            : undefined;
        return { id, title, ...(description ? { description } : {}), ...(difficulty ? { difficulty } : {}), ...(tags ? { tags } : {}) };
    });
    // ── database (optional) ──
    let database;
    if (root.database !== undefined) {
        const rawDb = assertObj(root.database, 'database');
        const dbProvider = rawDb.provider;
        if (dbProvider !== 'sqlite' && dbProvider !== 'postgres') {
            err("database.provider must be 'sqlite' or 'postgres'");
        }
        database = { provider: dbProvider };
        if (typeof rawDb.path === 'string')
            database.path = rawDb.path;
        if (typeof rawDb.connection_string === 'string')
            database.connection_string = rawDb.connection_string;
    }
    let api;
    if (root.api !== undefined) {
        const rawApi = assertObj(root.api, 'api');
        const admin_key = typeof rawApi.admin_key === 'string' ? rawApi.admin_key : undefined;
        const secret_key = typeof rawApi.secret_key === 'string' ? rawApi.secret_key : undefined;
        api = {
            ...(admin_key ? { admin_key } : {}),
            ...(secret_key ? { secret_key } : {}),
        };
    }
    return { agent, constraints, prompts, ...(database ? { database } : {}), ...(api ? { api } : {}) };
}
// ─── Loader ───────────────────────────────────────────────────────────────────
export function loadConfig(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(raw);
    const resolved = resolveEnvVars(parsed);
    return validateConfig(resolved);
}
//# sourceMappingURL=config.js.map
