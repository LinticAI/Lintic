# Implementation Plan: Advanced Metrics & LLM Evaluator Layer (US-023)

## Objective
Enhance Lintic's evaluation capabilities by moving beyond simple quantitative metrics (like token counts and interaction ratios) and introducing a sophisticated **LLM Evaluator Layer**. This layer will analyze the candidate's entire interaction history to measure the *quality* and *efficiency* of their collaboration with the AI agent.

## Proposed New Metrics (Via LLM Evaluator)

1. **Context Management Score** 🎯: Does the candidate carefully select necessary files/snippets, or dump the entire codebase into the prompt?
2. **Problem Decomposition Skill** 🧩: Does the candidate break the problem down into smaller, verifiable steps?
3. **Debugging Collaboration (Hypothesis vs. Dump)** 🐛: Does the candidate provide hypotheses with their stack traces?
4. **Task Iteration Velocity** ⏱️: Time and token budget spent from "first attempt" to "working state".
5. **Security & Edge Case Awareness** 🔒: Did the candidate consider edge cases and rate limits?
6. **Strategic Backtracking (Rewind Utilization)** ⏪: Does the candidate use the Context Panel's "Rewind" feature to restore a clean state when the agent hallucinates, or do they waste tokens arguing?
7. **Domain Knowledge Directiveness** 🧭: Does the candidate proactively step in with technical constraints, libraries, and architectural decisions (e.g. "Use SQLite and React Native with the following schema...") to save tokens on generic LLM research?

*Note: Infrastructure Metrics (Cache hit rate, Postgres slow queries) will be computed programmatically alongside this LLM Evaluator.*

## Architecture

**The Interaction Graph**
Model the session as a series of **Iterations** containing:
- Candidate's Prompt, Agent's Response, Code Deltas, Terminal Outputs
- **Rewind Events**: Extracted from `rewound_at` timeline events to measure strategic backtracking.

**The Synchronous Evaluator**
When a reviewer clicks "Analyze Session" in the dashboard:
1. `SessionAnalyzer.ts` synchronously aggregates Iterations.
2. `SynchronousEvaluatorService.ts` feeds this to the Evaluator LLM (potentially a distinct model from the candidate's active agent).
3. The response is strongly typed via a JSON Schema defined in `EvaluatorRubric.ts`.
4. Extracted metrics are persisted and returned to the frontend.

## Files to Modify/Create

- `packages/core/src/metrics/EvaluatorRubric.ts` (NEW) - Zod/JSON Schema for evaluator outputs.
- `packages/core/src/metrics/SessionAnalyzer.ts` (NEW) - Truncates and formats session history.
- `packages/backend/src/services/SynchronousEvaluatorService.ts` (NEW) - API orchestrator for evaluation.
- `packages/backend/src/api/sessions.ts` (MODIFY) - Add `POST /api/sessions/:id/evaluate` endpoint.
- `lintic.yml` & `packages/core/config/schema.ts` (MODIFY) - Add `evaluation` block to specify `model`, `provider`, and `api_key`.
- `packages/frontend/src/features/dashboard/SessionReview.tsx` (MODIFY) - Render the resulting scorecard and "Analyze Session" button.
