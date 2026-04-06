import type {
  EvaluationConfig,
  EvaluatorDimensionScore,
  EvaluatorResponse,
  InfrastructureMetrics,
  Iteration,
  RubricDimension,
  Session,
} from '@lintic/core';
import { buildEvaluatorContext, buildEvaluatorSystemPrompt } from '@lintic/core';

// ─── LLM Wire Types ───────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAICompletionResponse {
  choices: Array<{
    message: { content: string | null };
    finish_reason: string;
  }>;
}

interface AnthropicCompletionResponse {
  content: Array<{ type: string; text?: string }>;
}

// ─── Raw LLM call ─────────────────────────────────────────────────────────────

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';
const MAX_OUTPUT_TOKENS = 2048;

function resolveBaseUrl(config: EvaluationConfig): string {
  if (config.base_url) return config.base_url.replace(/\/$/, '');
  if (config.provider === 'groq') return 'https://api.groq.com/openai';
  if (config.provider === 'cerebras') return 'https://api.cerebras.ai/v1';
  if (config.provider === 'local-openai') return 'http://localhost:8080/v1';
  return 'https://api.openai.com';
}

async function callAnthropicEvaluator(
  config: EvaluationConfig,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const base = config.base_url ? config.base_url.replace(/\/$/, '') : ANTHROPIC_BASE;
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.api_key,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Anthropic evaluator error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as AnthropicCompletionResponse;
  const textBlock = data.content.find((b) => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error('Anthropic evaluator returned no text content');
  }
  return textBlock.text;
}

async function callOpenAICompatEvaluator(
  config: EvaluationConfig,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const base = resolveBaseUrl(config);
  const messages: OpenAIMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Evaluator LLM error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as OpenAICompletionResponse;
  const content = data.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Evaluator LLM returned empty content');
  }
  return content;
}

async function callEvaluatorLLM(
  config: EvaluationConfig,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  if (config.provider === 'anthropic-native') {
    return callAnthropicEvaluator(config, systemPrompt, userMessage);
  }
  return callOpenAICompatEvaluator(config, systemPrompt, userMessage);
}

// ─── Response Parsing ─────────────────────────────────────────────────────────

const VALID_DIMENSIONS = new Set<string>([
  'context_management',
  'problem_decomposition',
  'debugging_collaboration',
  'task_iteration_velocity',
  'security_awareness',
  'strategic_backtracking',
  'domain_knowledge_directiveness',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseEvaluatorResponse(raw: string): EvaluatorResponse {
  let parsed: unknown;
  try {
    // Strip accidental markdown fences that some models add
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Evaluator returned non-JSON response: ${raw.slice(0, 100)}`);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed['scores']) || typeof parsed['overall_summary'] !== 'string') {
    throw new Error('Evaluator response missing required fields');
  }

  const scores: EvaluatorDimensionScore[] = [];
  for (const item of parsed['scores']) {
    if (!isRecord(item)) continue;
    const dim = item['dimension'];
    const label = item['label'];
    const score = item['score'];
    const rationale = item['rationale'];

    if (
      typeof dim !== 'string'
      || !VALID_DIMENSIONS.has(dim)
      || typeof label !== 'string'
      || typeof score !== 'number'
      || typeof rationale !== 'string'
    ) {
      continue;
    }

    scores.push({
      dimension: dim as RubricDimension,
      label,
      score: Math.min(10, Math.max(0, score)),
      rationale,
    });
  }

  if (scores.length === 0) {
    throw new Error('Evaluator returned no valid dimension scores');
  }

  return {
    scores,
    overall_summary: parsed['overall_summary'] as string,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface EvaluateSessionInput {
  session: Session;
  iterations: Iteration[];
  infrastructure: InfrastructureMetrics;
  truncatedHistory: Array<{ role: string; content: string }>;
  evaluationConfig: EvaluationConfig;
}

/**
 * Calls the configured Evaluator LLM with the session context and returns
 * strongly-typed dimension scores.
 */
export async function evaluateSession(
  input: EvaluateSessionInput,
): Promise<EvaluatorResponse> {
  const { session, iterations, infrastructure, truncatedHistory, evaluationConfig } = input;

  const systemPrompt = buildEvaluatorSystemPrompt();

  // Build user context using the session analyzer helper, adapted for the
  // pre-truncated history already provided by the caller.
  const historyText = truncatedHistory
    .map((m) => {
      const role = m.role === 'user' ? 'Candidate' : m.role === 'assistant' ? 'Agent' : m.role;
      const text = m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content;
      return `[${role}]: ${text}`;
    })
    .join('\n\n');

  const rewindCount = iterations.filter((it) => it.rewound_at !== undefined).length;
  const iterationLines = iterations
    .map((it) => {
      const tag = it.rewound_at !== undefined ? ' [REWOUND]' : '';
      return `  Iteration ${it.index}${tag}: ${it.message_count} messages`;
    })
    .join('\n');

  const infraLines = [
    `  Caching effectiveness: ${Math.round(infrastructure.caching_effectiveness.score * 100)}% — ${infrastructure.caching_effectiveness.details}`,
    `  Error handling coverage: ${Math.round(infrastructure.error_handling_coverage.score * 100)}% — ${infrastructure.error_handling_coverage.details}`,
    `  Scaling awareness: ${Math.round(infrastructure.scaling_awareness.score * 100)}% — ${infrastructure.scaling_awareness.details}`,
  ].join('\n');

  const userMessage = `## Session Metadata
Session ID: ${session.id}
Prompt: ${session.prompt_id}
Candidate: ${session.candidate_email}
Tokens used: ${session.tokens_used} / ${session.constraint.max_session_tokens}
Interactions used: ${session.interactions_used} / ${session.constraint.max_interactions}

## Iteration Breakdown (${iterations.length} total, ${rewindCount} rewound)
${iterationLines}

## Infrastructure Metrics
${infraLines}

## Conversation History (${truncatedHistory.length} messages)
${historyText || '(no messages recorded)'}

---
Please evaluate the candidate using all 7 rubric dimensions.`;

  const rawResponse = await callEvaluatorLLM(evaluationConfig, systemPrompt, userMessage);
  return parseEvaluatorResponse(rawResponse);
}
