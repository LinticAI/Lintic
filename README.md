# Lintic

Open-source, self-hostable AI coding assessment platform. Candidates get a browser-based IDE with an AI coding agent and real resource constraints — token budgets, interaction limits, simulated infrastructure. Companies evaluate how candidates use AI strategically, not just whether they can.

## What it evaluates

Traditional coding assessments test memorization. Lintic tests AI collaboration quality:

- **Prompt engineering** — does the candidate direct the agent precisely or waste tokens on vague requests?
- **Iteration efficiency** — how many interactions did it take to reach a working solution?
- **Token efficiency** — how much of the budget was used relative to solution quality?
- **Independence ratio** — how much did the candidate write versus rely entirely on the agent?
- **Recovery** — did the candidate catch and correct agent mistakes?

## Features

- Browser-based IDE with Monaco Editor, integrated terminal (xterm.js), and WebContainers Node.js runtime — no server-side sandboxing
- AI agent chat panel with real-time tool use: the agent can read/write files, run commands, and browse the filesystem inside the candidate's WebContainer
- Configurable constraints: token budget, max interactions, time limit
- Signed single-use assessment links with configurable expiry
- Session replay for reviewers with synchronized conversation, code diffs, and a timeline scrubber
- Candidate comparison dashboard with sortable metrics
- OpenAI-compatible, local OpenAI-compatible, Cerebras, Groq, and Anthropic native adapters — plug in any model
- SQLite (default) or PostgreSQL database backend
- Single Docker image, `docker compose up` deployment

### Roadmap

- **Prompt history and library** — versioned prompts with per-version stats and diff view
- **Conversation source control** — named checkpoints, branch from any prior turn, restore file state
- **Advanced agent skill modes** — Code Review, Write Tests, Refactor, Explain, Debug with structured instructions
- **Git integration** — git panel in the IDE, commit log in session replay, commit frequency and granularity metrics

## Quick Start

```bash
npm install
npm run startdev
npm run build
npm run typecheck
npm run lint
npm run test
```

## Docker Deployment

Lintic ships as a single production image. The Express backend serves the built frontend, API routes, and sets the required `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers needed for WebContainers to run in the browser.

### 1. Configure `lintic.yml`

```yaml
agent:
  provider: openai-compatible       # or local-openai, cerebras, groq, anthropic-native
  base_url: https://api.openai.com/v1
  api_key: ${LINTIC_API_KEY}
  model: gpt-4o

constraints:
  max_session_tokens: 50000
  max_message_tokens: 2000
  max_interactions: 30
  time_limit_minutes: 60

prompts:
  - id: library-api
    title: Library Catalog API
    description: Build a REST API for managing a library catalog with borrowing logic.
    difficulty: medium
    tags: [backend, api-design]
```

For a local OpenAI-compatible server, you can instead use:

```yaml
agent:
  provider: local-openai
  base_url: http://localhost:8080/v1   # optional; this is the default
  api_key: local-dev                   # optional; defaults to local-dev
  model: qwen2.5-coder
```

### 2. Set environment variables

```bash
export LINTIC_API_KEY=your-provider-key      # LLM provider API key
export LINTIC_ADMIN_KEY=your-admin-key       # protects POST /api/links
export LINTIC_SECRET_KEY=your-signing-secret # signs assessment JWTs
```

### 3. Start

```bash
docker compose up --build -d
```

The app is available at `http://localhost:3300`. `./lintic.yml` is mounted read-only into the container and `./data` persists the SQLite database between restarts.

**Health check:** `GET /health` returns `{"status":"ok"}`.

## Local PostgreSQL

For serverless-style deployments, set `database.provider` to `postgres` and point Lintic at a Postgres instance instead of the local SQLite file.

### Start Postgres locally

```bash
docker run --name lintic-postgres \
  -e POSTGRES_USER=lintic \
  -e POSTGRES_PASSWORD=lintic \
  -e POSTGRES_DB=lintic \
  -p 5432:5432 \
  -d postgres:16
```

### Configure `lintic.yml`

Use either an explicit connection string in config:

```yaml
database:
  provider: postgres
  connection_string: postgres://lintic:lintic@localhost:5432/lintic
```

Or let the environment provide it:

```bash
export DATABASE_URL=postgres://lintic:lintic@localhost:5432/lintic
```

`database.connection_string` takes precedence over `DATABASE_URL` when both are set.

### Smoke test persistence

1. Start the backend with your normal workflow.
2. Create a session with `npx lintic generate-link --prompt library-api --email candidate@example.com` or `POST /api/links`.
3. Verify rows were created in Postgres:

```bash
psql postgres://lintic:lintic@localhost:5432/lintic -c "select id, prompt_id, candidate_email from sessions;"
psql postgres://lintic:lintic@localhost:5432/lintic -c "select session_id, role, content from messages order by id;"
```

### Generating assessment links

```bash
# CLI
npx lintic generate-link --prompt library-api --email candidate@example.com

# REST API
curl -X POST http://localhost:3300/api/links \
  -H "X-Lintic-Api-Key: $LINTIC_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt_id":"library-api","email":"candidate@example.com"}'
```

Links are signed JWTs, single-use, and expire after 72 hours by default.

## Contributing

### The Golden Rules

1. **Never commit directly to `main`.** All work happens on a feature branch and merges via PR.
2. **One user story = one PR.** Every PR must map to a single user story from `PRD.md`. No bundling.
3. **No story starts without a branch.** If you don't have a branch, you're not ready to write code.
4. Do not start the next story until all acceptance criteria for the current one are checked off and the PR is merged.

### User Story Workflow

```
Pick story from PRD.md (first unchecked)
      ↓
Create feature branch: git checkout -b us-NNN-short-description
      ↓
Implement — test-driven where possible (write test → see it fail → make it pass)
      ↓
Run quality gates (all must pass before opening PR)
      ↓
Check off all acceptance criteria in PRD.md
      ↓
Commit with: feat(scope): description (US-NNN)
      ↓
Open PR targeting main — title must include the story ID, e.g. "[US-003] YAML config loader"
      ↓
PR is reviewed and merged → pick the next story
```

### Quality Gates

Every PR must pass all three before merge:

```bash
npm run typecheck   # zero TypeScript errors
npm run lint        # zero ESLint errors
npm run test        # all Vitest tests pass
```

UI stories additionally require browser verification.

### Commit Format

```
<type>(<scope>): <description> (US-NNN)

Types: feat | fix | refactor | test | docs | chore
Scopes: core | adapters | cli | frontend | backend | infra
```

Examples:
```
feat(core): add constraint enforcer module (US-004)
fix(adapters): handle Anthropic rate limit errors (US-007)
test(core): add edge cases for token budget enforcement (US-004)
```

### Marking Acceptance Criteria

When your implementation satisfies a criterion, change `- [ ]` to `- [x]` in `PRD.md` **in the same commit** that implements it. Never mark criteria complete before the quality gates pass.

### Packages

| Package | Scope | Depends on |
|---------|-------|------------|
| `@lintic/core` | Types, constraint logic, DB interfaces, metrics | — |
| `@lintic/adapters` | LLM adapter implementations | `@lintic/core` |
| `@lintic/backend` | Express server, agent loop, session API | `@lintic/core`, `@lintic/adapters` |
| `@lintic/frontend` | React IDE, chat panel, review dashboard | `@lintic/core` |
| `@lintic/cli` | Assessment link generation, result export | `@lintic/core` |

**Rule:** All shared types live in `@lintic/core`. No type duplication across packages.

### Adding a New Package Dependency

Only add a dependency when a user story explicitly requires it. Add to the package that uses it, not the root (exception: shared dev tooling like TypeScript and ESLint stays at root).

### Design Docs and Plans

Before implementing any non-trivial story:
- Design doc → `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Implementation plan → `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`

These are committed alongside the implementation so future contributors understand the reasoning.
