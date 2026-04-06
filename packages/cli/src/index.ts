#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildAssessmentLink,
  createAssessmentLinkToken,
  generateRandomSecret,
  loadConfig,
  resolveSecretKey,
} from '@lintic/core';

export const VERSION: string = '0.0.1';

export interface GenerateLinkOptions {
  promptId: string;
  email: string;
  expiresInHours?: number;
  baseUrl?: string;
  configPath?: string;
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (!current?.startsWith('--') || next === undefined) {
      continue;
    }
    flags[current.slice(2)] = next;
    index += 1;
  }
  return flags;
}

export function createStarterConfig(): string {
  const adminKey = generateRandomSecret(16);
  const secretKey = generateRandomSecret(32);

  return `agent:
  provider: openai-compatible
  api_key: \${OPENAI_API_KEY}
  model: gpt-4o
  # For local OpenAI-compatible servers, use:
  # provider: local-openai
  # model: qwen2.5-coder
  # base_url: http://localhost:8080/v1

constraints:
  max_session_tokens: 50000
  max_message_tokens: 4000
  context_window: 32000
  max_interactions: 30
  time_limit_minutes: 60

api:
  admin_key: ${adminKey}
  secret_key: ${secretKey}

prompts:
  - id: library-api
    title: Library Catalog API
    description: Build a REST API that manages a library catalog.
    tags: [backend, api-design]

# Add more prompts below as needed.
`;
}

export async function generateLink(options: GenerateLinkOptions): Promise<string> {
  const config = loadConfig(options.configPath ?? 'lintic.yml');
  const prompt = config.prompts.find((entry) => entry.id === options.promptId);
  if (!prompt) {
    throw new Error(`Unknown prompt: ${options.promptId}`);
  }

  const secretKey = resolveSecretKey(config.api?.secret_key);
  if (!secretKey) {
    throw new Error('Missing API signing secret. Configure api.secret_key or LINTIC_SECRET_KEY.');
  }

  const generated = await createAssessmentLinkToken(
    {
      prompt_id: options.promptId,
      email: options.email,
      constraint: config.constraints,
    },
    secretKey,
    options.expiresInHours ?? 72,
  );

  const link = buildAssessmentLink(
    options.baseUrl ?? 'http://localhost:5173',
    generated.token,
    options.promptId,
    options.email,
    generated.expiresAt,
  );

  return link.url;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === 'init') {
    const target = resolve('lintic.yml');
    if (existsSync(target)) {
      throw new Error('lintic.yml already exists');
    }
    writeFileSync(target, createStarterConfig(), 'utf8');
    console.log(`Created ${target}`);
    return;
  }

  if (command === 'generate-link') {
    const flags = parseFlags(rest);
    if (!flags['prompt']) {
      throw new Error('--prompt is required');
    }
    if (!flags['email']) {
      throw new Error('--email is required');
    }
    const options: GenerateLinkOptions = {
      promptId: flags['prompt'],
      email: flags['email'],
      ...(flags['expires-in-hours'] ? { expiresInHours: Number(flags['expires-in-hours']) } : {}),
      ...(flags['base-url'] ? { baseUrl: flags['base-url'] } : {}),
    };
    const url = await generateLink(options);
    console.log(url);
    return;
  }

  console.log('Usage: lintic <init|generate-link> [options]');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
