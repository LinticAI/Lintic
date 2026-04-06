# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lintic** is an open-source, self-hostable agentic AI coding assessment platform. It evaluates candidates on how effectively they collaborate with AI under resource constraints (token budgets, interaction limits, time limits), rather than memorization of algorithms.

## Planned Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React, TypeScript, Vite, Tailwind CSS, Monaco Editor |
| Backend | Node.js, Express, TypeScript |
| Database | SQLite (Docker default) or PostgreSQL via `DatabaseAdapter` interface |
| Code Runtime | WebContainers (`@webcontainer/api`) — Node.js in-browser, no server-side sandboxing |
| Testing | Vitest (unit), Playwright (e2e) |
| Config | YAML (`lintic.yml`) parsed with `js-yaml` |
| Deployment | Single Docker image + `docker-compose.yml` |

## Planned Commands

Once implemented, these are the intended commands:

```bash
npm run dev          # Start frontend + backend in development mode
npm run build        # Build all packages
npm run typecheck    # TypeScript type checking (must pass on all PRs)
npm run lint         # ESLint (must pass on all PRs)
npm run test         # Vitest unit tests (must pass on all PRs)
npm run test:e2e     # Playwright end-to-end tests
```

## Monorepo Structure

```
packages/
├── core/        # Session management, constraint enforcement, metrics computation
├── frontend/    # React IDE (Monaco), agent chat panel, review dashboard
├── adapters/    # Agent adapter implementations (OpenAI-compatible, Anthropic native)
└── cli/         # CLI tools (generate assessment links, export results)
docs/            # Setup guides, adapter authoring docs
```

## Architecture

### Core Data Flow (Agent Message)

1. Candidate types in frontend chat panel
2. `POST /api/sessions/:id/messages` to Express backend
3. `ConstraintEnforcer` checks token budget and interaction count
4. Agent Adapter forwards to external LLM (OpenAI-compatible or Anthropic)
5. `ConstraintEnforcer` deducts tokens from session budget
6. `SessionRecorder` logs the event with timestamp
7. Response returns to frontend with updated constraint counters

### Key Abstractions

- **DatabaseAdapter**: Swappable SQLite/Postgres — methods: `createSession`, `getSession`, `addMessage`, `getMessages`, `closeSession`, `listSessions`, `getSessionsByPrompt`
- **Agent Interface Protocol (AIP)**: Standardized interface any LLM adapter must implement; no proprietary agent is bundled
- **ConstraintEnforcer**: Tracks per-session token budget, interaction count, time limit
- **SessionRecorder**: Logs all events (messages, code changes, terminal output) for replay

### Frontend Routes

- `/` — Active assessment interface (Monaco editor + agent chat + constraint dashboard)
- `/review/:sessionId` — Session replay (synchronized conversation + code diff timeline)
- `/review` — Comparison dashboard across candidates

### Backend API

```
POST /api/sessions              Create new session
GET  /api/sessions/:id          Get session state
POST /api/sessions/:id/messages Send message to agent
GET  /api/sessions/:id/messages Get conversation history
GET  /api/sessions/:id/replay   Get chronological events for replay
POST /api/sessions/:id/close    Close session
GET  /health                    Health check
```

### Configuration (`lintic.yml`)

```yaml
agent:
  provider: openai-compatible   # or 'local-openai', 'anthropic-native', 'groq', 'cerebras'
  base_url: https://api.openai.com/v1
  api_key: ${OPENAI_API_KEY}    # ${ENV_VAR} syntax supported
  model: gpt-4o

constraints:
  max_session_tokens: 50000
  max_message_tokens: 2000
  context_window: 8000
  max_interactions: 30
  time_limit_minutes: 60

prompts:
  - id: library-api
    title: Library Catalog API
    difficulty: medium
    tags: [backend, api-design]

infrastructure:
  redis:
    enabled: true
    profile: realistic          # gentle | realistic | adversarial
```

### Simulated Infrastructure (WebContainers)

In-browser mock services simulate real production infrastructure — Redis, PostgreSQL, message queue, HTTP load balancer, S3-compatible object storage, rate limiter. Difficulty profiles (`gentle`, `realistic`, `adversarial`) control failure injection.

### Session Replay Events

Recorded with timestamps: `message`, `agent_response`, `code_change`, `terminal_output`, `resource_usage`. Replay synchronizes conversation scrubber, code diffs, terminal history, and token consumption graph.

## Implementation Roadmap

- **Phase 1 (Weeks 1–6)**: Core session management, WebContainers + Monaco, OpenAI adapter, YAML config, Docker
- **Phase 2 (Weeks 7–10)**: Metrics, review dashboard, Anthropic adapter, Redis/Postgres mocks
- **Phase 3 (Weeks 11–14)**: Adapter SDK, message queue/load balancer mocks, difficulty profiles
- **Phase 4 (Future)**: Python/Go runtimes, collaborative assessments, ATS integrations

User stories US-001 through US-028 in `PRD.md` define acceptance criteria for each feature.

## Testing Requirements

Every completed user story **must** include Vitest unit tests:

- Tests live alongside the source file: `src/foo.ts` → `src/foo.test.ts`
- Cover all acceptance criteria listed in `PRD.md` for that story
- Mock all external I/O (HTTP, filesystem, DB) — no real API calls or disk writes
- A story PR will not be merged unless `npm run test` passes with tests for that story present
