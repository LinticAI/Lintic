import type { RubricDimension } from './types.js';

// ─── Rubric Dimension Definitions ────────────────────────────────────────────

export const RUBRIC_DIMENSIONS: Array<{
  dimension: RubricDimension;
  label: string;
  description: string;
}> = [
  {
    dimension: 'context_management',
    label: 'Context Management',
    description:
      'Does the candidate carefully select necessary files/snippets to share with the agent, or dump the entire codebase? Lower context padding = higher precision = higher score.',
  },
  {
    dimension: 'problem_decomposition',
    label: 'Problem Decomposition',
    description:
      'Does the candidate break the problem into smaller, individually verifiable steps, or send large monolithic tasks that cause the agent to hallucinate?',
  },
  {
    dimension: 'debugging_collaboration',
    label: 'Debugging Collaboration',
    description:
      'Does the candidate provide hypotheses alongside stack traces ("I think the issue is X because..."), or just paste raw error output and hope for the best?',
  },
  {
    dimension: 'task_iteration_velocity',
    label: 'Task Iteration Velocity',
    description:
      'Token budget and interaction count spent from first attempt to working state. Fewer cycles and tokens used to reach correctness = higher score.',
  },
  {
    dimension: 'security_awareness',
    label: 'Security & Edge Case Awareness',
    description:
      'Did the candidate consider edge cases, rate limits, input validation, SQL injection, authentication, or other security and robustness constraints during the session?',
  },
  {
    dimension: 'strategic_backtracking',
    label: 'Strategic Backtracking',
    description:
      'Does the candidate use the Rewind feature to restore a clean state when the agent hallucinates or derails, rather than spending additional tokens arguing or trying to patch a broken thread?',
  },
  {
    dimension: 'domain_knowledge_directiveness',
    label: 'Domain Knowledge Directiveness',
    description:
      'Does the candidate proactively supply technical constraints, library choices, schema designs, and architectural decisions to steer the agent efficiently, saving tokens on generic LLM research?',
  },
];

// ─── JSON Schema for Structured LLM Output ───────────────────────────────────

export const EVALUATOR_OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    scores: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          dimension: { type: 'string' as const },
          label: { type: 'string' as const },
          score: { type: 'number' as const, minimum: 0, maximum: 10 },
          rationale: { type: 'string' as const },
        },
        required: ['dimension', 'label', 'score', 'rationale'] as const,
        additionalProperties: false,
      },
      minItems: 7,
      maxItems: 7,
    },
    overall_summary: { type: 'string' as const },
  },
  required: ['scores', 'overall_summary'] as const,
  additionalProperties: false,
};

// ─── Prompt Builder ───────────────────────────────────────────────────────────

export function buildEvaluatorSystemPrompt(): string {
  const dimensionLines = RUBRIC_DIMENSIONS.map(
    (d) => `- **${d.label}** (\`${d.dimension}\`): ${d.description}`,
  ).join('\n');

  return `You are an expert technical interview assessor evaluating how effectively a software engineering candidate collaborates with an AI coding agent.

You will receive a session transcript including the candidate's messages, the agent's responses, infrastructure usage data, and iteration metadata (including any rewind events).

Score the candidate on each of the following 7 dimensions from 0 to 10 (integers preferred, halves acceptable), with a concise rationale for each score. Then write a 2–4 sentence overall summary.

## Scoring Dimensions

${dimensionLines}

## Scoring Guidelines

- **0–3**: Poor. The candidate demonstrated little awareness or actively made things worse.
- **4–6**: Average. Some awareness but inconsistent application.
- **7–9**: Good. Consistent, effective application with minor gaps.
- **10**: Exceptional. A model example of the skill.

## Output Format

Respond ONLY with valid JSON matching this schema. Do not include markdown fences or commentary outside the JSON object.`;
}
