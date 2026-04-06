# PRD: Lintic

Open-source, self-hostable platform that replaces traditional coding assessments with agentic AI workflow evaluations. Candidates get a browser-based IDE with an AI coding agent and open-ended prompts. Companies configure constraints (token budgets, interaction limits) and simulated infrastructure (Redis, Postgres, message queues). The platform records sessions and computes structured metrics on human-AI collaboration quality.

## Tech Stack

- Frontend: React, TypeScript, Vite, Tailwind CSS, Monaco Editor
- Backend: Node.js, Express, TypeScript
- Database: SQLite (via better-sqlite3) for Docker/local, PostgreSQL (via pg) for serverless/cloud. Abstract via DatabaseAdapter interface.
- Code Runtime: WebContainers (@webcontainer/api)
- Agent Communication: Agent Interface Protocol (internal REST API)
- Deployment: Docker, docker-compose
- Configuration: YAML (js-yaml)
- Testing: Vitest (unit), Playwright (e2e)

## Quality Gates

These commands must pass for every user story:

- `npm run typecheck` - TypeScript type checking
- `npm run lint` - ESLint
- `npm run test` - Vitest unit tests

For UI stories, also include:

- Verify in browser using dev-browser skill

## User Stories

### US-001: Initialize monorepo and project scaffolding

**Description:** As a developer, I need the monorepo structure set up with shared config so all packages can build and typecheck independently.

**Acceptance Criteria:**

- [ ] Create packages/core, packages/frontend, packages/adapters, packages/cli directories
- [ ] Root package.json with npm workspaces configured
- [ ] Shared tsconfig.base.json extended by each package
- [ ] ESLint config at root shared across packages
- [ ] `npm run typecheck` passes from root
- [ ] `npm run lint` passes from root

### US-002: Core session data models and types

**Description:** As a developer, I need TypeScript types and interfaces for sessions, constraints, metrics, and agent communication so all packages share a common contract.

**Acceptance Criteria:**

- [x] Define Session, Constraint, AgentConfig, AgentResponse, TokenUsage types in packages/core/src/types.ts
- [x] Define AgentAdapter interface with init, sendMessage, getTokenUsage, getCapabilities methods
- [x] Define MetricResult, SessionRecording, and ReviewData types
- [x] Export all types from packages/core/src/index.ts
- [x] Typecheck passes

### US-003: YAML configuration loader

**Description:** As a company admin, I need the platform to read an lintic.yml file so I can configure the agent provider, constraints, and prompts in one place.

**Acceptance Criteria:**

- [x] Parse lintic.yml using js-yaml into typed Config object
- [x] Validate required fields: agent.provider, agent.api_key (or env var reference), agent.model
- [x] Support ${ENV_VAR} syntax in string values for secrets
- [x] Throw descriptive errors for missing or invalid config
- [x] Unit tests for config parsing and validation
- [x] Typecheck passes

### US-004: Constraint enforcer module

**Description:** As a developer, I need a module that tracks token usage and interaction count per session and rejects requests that exceed configured limits.

**Acceptance Criteria:**

- [x] ConstraintEnforcer class that accepts a Constraint config
- [x] Methods: canSend() returns boolean, recordUsage(tokens) updates state, getRemaining() returns budget info
- [x] Enforces max_session_tokens, max_message_tokens, max_interactions
- [x] Returns descriptive error when a constraint is violated
- [x] Unit tests for all constraint boundaries and edge cases
- [x] Typecheck passes

### US-005: Database abstraction layer and SQLite adapter

**Description:** As a developer, I need a DatabaseAdapter interface and a SQLite implementation so all database access goes through a common contract that can be swapped for Postgres in serverless deployments.

**Acceptance Criteria:**

- [x] Define DatabaseAdapter interface in packages/core/src/database.ts with methods: createSession, getSession, addMessage, getMessages, closeSession, listSessions, getSessionsByPrompt
- [x] SQLiteAdapter implements DatabaseAdapter using better-sqlite3
- [x] Database initialized with sessions and messages tables on first run
- [x] createSession(config) returns a unique session ID and time-limited assessment link token
- [x] getSession(id) returns full session state including constraint usage
- [x] addMessage(sessionId, role, content, tokenCount) appends to messages table
- [x] closeSession(id) marks session as completed with timestamp
- [x] listSessions() returns all sessions with basic metadata and scores
- [x] getSessionsByPrompt(promptId) filters sessions by prompt
- [x] lintic.yml database.provider field selects adapter ("sqlite" default, "postgres" for Postgres)
- [x] Unit tests for all CRUD operations against SQLite
- [x] Typecheck passes

### US-005b: PostgreSQL database adapter

**Description:** As a company admin deploying on Vercel or other serverless platforms, I need a Postgres adapter so session data persists without a local filesystem.

**Acceptance Criteria:**

- [x] PostgresAdapter implements DatabaseAdapter interface using pg library
- [x] Connects via DATABASE_URL environment variable or lintic.yml database.connection_string
- [x] Auto-runs CREATE TABLE IF NOT EXISTS on first connection for sessions and messages tables
- [x] All methods behave identically to SQLiteAdapter (same return types, same error semantics)
- [x] Connection pooling configured with sensible defaults (max 10 connections)
- [x] Graceful handling of connection failures with retry and descriptive error messages
- [x] Unit tests with a mocked pg client that verify query generation
- [x] Integration test instructions in README for running against a local Postgres
- [x] Typecheck passes

### US-006: OpenAI-compatible agent adapter

**Description:** As a company admin, I need a bundled adapter that works with any OpenAI-compatible API so I can plug in OpenAI, Groq, Together, or Ollama with just a base URL and API key.

**Acceptance Criteria:**

- [x] Implements AgentAdapter interface from core types
- [x] init() validates config and sets up HTTP client
- [x] sendMessage() posts to /v1/chat/completions with proper format
- [x] Respects max_message_tokens as max_tokens parameter
- [x] getTokenUsage() returns prompt and completion token counts from API response
- [x] Handles API errors gracefully with typed error responses
- [x] Unit tests with mocked HTTP responses
- [x] Typecheck passes

### US-007: Anthropic native agent adapter

**Description:** As a company admin, I need a direct Anthropic adapter so I can use Claude models with native API features.

**Acceptance Criteria:**

- [x] Implements AgentAdapter interface
- [x] Posts to Anthropic Messages API (/v1/messages) with correct headers
- [x] Maps conversation history to Anthropic's message format
- [x] Handles Anthropic-specific error codes (overloaded, rate_limited)
- [x] Unit tests with mocked HTTP responses
- [x] Typecheck passes

### US-007a: Agent tool definitions and executor

**Description:** As a developer, I need a set of tool definitions that give the LLM the ability to read files, write files, run terminal commands, and browse the file system inside the candidate's WebContainer, so the agent can act on the codebase directly rather than just chatting.

**Acceptance Criteria:**

- [ ] Define tool schemas compatible with both OpenAI function calling and Anthropic tool use formats
- [x] Tools defined: read_file(path), write_file(path, content), run_command(command), list_directory(path), search_files(query, path)
- [x] ToolExecutor class that receives a tool call from the LLM response, routes it to the correct handler, and returns the result
- [x] Each tool handler communicates with the WebContainer API (frontend ToolExecutor calls WebContainer directly; wired into App.tsx and passed to ChatPanel)
- [x] Tool results are formatted and injected back into the conversation for the next LLM call
- [x] Tool execution timeout (5 minutes for run_command, 5 seconds for file operations) with graceful error messages
- [x] Unit tests for tool routing and result formatting
- [x] Typecheck passes

### US-007b: Agent loop with multi-step tool use

**Description:** As a candidate, I need the agent to autonomously chain multiple tool calls in a single turn (read a file, edit it, run tests, fix errors) so I can direct the agent at a high level instead of copy-pasting code manually.

**Acceptance Criteria:**

- [x] runAgentLoop module (packages/backend/src/agent-loop.ts) implements the full loop: send to LLM, check for tool calls, execute, feed results back, repeat until text response
- [x] runAgentLoop is wired into POST /api/sessions/:id/messages/stream (SSE endpoint); companion POST /tool-results/:requestId delivers browser-side WebContainer results to the waiting server loop
- [x] Maximum of 10 tool calls per candidate message to prevent runaway loops
- [x] Each tool call and result is recorded in the session for replay
- [x] The candidate sees tool actions in real time: pending card appears immediately when tool_calls SSE event arrives, updated with results once execution completes
- [x] Token usage from all LLM calls in the loop counts toward the session budget (aggregated in total_usage)
- [x] If a tool call fails, the error is passed back to the LLM so it can recover (is_error field forwarded)
- [x] Unit tests for the loop termination conditions, token accounting, SSE endpoint, and tool-results/:requestId endpoint
- [x] Typecheck passes

### US-007c: Tool action display in chat UI

**Description:** As a candidate, I need to see what the agent is doing when it uses tools so I can understand its approach and intervene if needed.

**Acceptance Criteria:**

- [x] Tool calls render as collapsible action cards in the chat panel (distinct from regular text messages)
- [x] Each action card shows the tool name, parameters, and result (truncated for large outputs)
- [x] File writes show a mini diff preview (added lines)
- [x] Terminal command actions show the command and output (monospace, truncated)
- [ ] Actions stream in real time as the agent loop executes (currently appear after the full loop completes — requires SSE or polling)
- [x] Candidate can click "Stop" to halt the agent mid-loop and take over manually
- [x] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-008: Express backend with session and agent routes

**Description:** As a developer, I need an Express server that exposes REST endpoints for session management and agent message proxying.

**Acceptance Criteria:**

- [x] POST /api/sessions creates a new session, returns session ID and assessment link
- [x] GET /api/sessions/:id returns session state with remaining constraints
- [x] POST /api/sessions/:id/messages accepts candidate message, proxies through constraint enforcer and agent adapter, returns response
- [x] GET /api/sessions/:id/messages returns full conversation history
- [x] POST /api/sessions/:id/close marks session as completed
- [x] Auth middleware validates assessment link tokens
- [x] Typecheck passes

### US-009: Session recording and replay data

**Description:** As a reviewer, I need all session activity (messages, code changes, timestamps) recorded so I can replay the session later.

**Acceptance Criteria:**

- [x] Every agent request/response is stored with timestamps and token counts
- [x] GET /api/sessions/:id/replay returns chronologically ordered session events
- [x] Events include type (message, code_change, terminal_output), timestamp, and payload
- [x] Code change events store file path and diff content
- [x] Typecheck passes

### US-010: Frontend shell with React, Vite, and layout

**Description:** As a candidate, I need the basic app shell with a split-pane layout so I can see the IDE on one side and the agent chat on the other.

**Acceptance Criteria:**

- [x] Vite + React + TypeScript project in packages/frontend
- [x] Tailwind CSS configured
- [x] Split-pane layout with resizable divider: left side for IDE, right side for chat
- [x] Top bar showing session timer, token budget remaining, and interaction count
- [x] Responsive: stacks vertically on smaller screens
- [x] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-011: Monaco Editor integration

**Description:** As a candidate, I need a code editor with syntax highlighting, file tabs, and a file tree so I can write and edit code during the assessment.

**Acceptance Criteria:**

- [x] Monaco Editor embedded in the IDE panel
- [x] File tree sidebar showing WebContainer filesystem
- [x] Clicking a file opens it in a new editor tab
- [x] Multiple tabs with active tab highlighting
- [x] Supports JavaScript, TypeScript, JSON, CSS, HTML, Markdown syntax
- [x] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-012: WebContainers runtime integration

**Description:** As a candidate, I need a terminal and Node.js runtime in the browser so I can run npm commands and execute code without any server-side compute.

**Acceptance Criteria:**

- [x] Boot a WebContainer instance on session start
- [x] Integrated terminal (xterm.js) connected to WebContainer shell
- [x] Candidates can run npm install, npm run, node commands
- [x] File system changes in Monaco sync to WebContainer and vice versa
- [x] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-013: Agent chat panel

**Description:** As a candidate, I need a chat interface to send messages to the AI agent and see responses so I can collaborate with the agent during the assessment.

**Acceptance Criteria:**

- [x] Chat panel on the right side with message input at the bottom
- [x] Messages display with role indicators (You / Agent)
- [x] Agent responses render markdown with syntax-highlighted code blocks
- [x] Shows loading spinner while waiting for agent response
- [x] Displays remaining token budget and interaction count above the input
- [x] Input disabled when constraints are exhausted
- [x] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-014: Constraint dashboard in candidate view

**Description:** As a candidate, I need to see my remaining budget in real time so I can make strategic decisions about when to prompt the agent.

**Acceptance Criteria:**

- [x] Top bar shows time remaining (countdown), tokens remaining (bar), interactions remaining (count)
- [x] Budget bar changes color from green to yellow to red as tokens deplete
- [x] Warning toast at 20% remaining tokens and 20% remaining interactions
- [x] Timer shows minutes:seconds, flashes red under 5 minutes
- [x] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-015: Metric computation engine

**Description:** As a reviewer, I need automated metrics computed from session data so I can evaluate candidates without manually reviewing every message.

**Acceptance Criteria:**

- [x] Compute iteration efficiency: productive interactions / total interactions
- [x] Compute token efficiency: final code correctness score / total tokens consumed
- [x] Compute independence ratio: manually edited lines / total lines in final code
- [x] Compute recovery score: successful corrections / total agent errors encountered
- [x] All metrics return a 0-1 normalized score
- [x] Unit tests for each metric computation
- [x] Typecheck passes

### US-016: Review dashboard with session replay

**Description:** As a reviewer, I need a dashboard to view candidate session metrics and replay the session timeline.

**Acceptance Criteria:**

- [x] GET /review/:sessionId route renders the review page
- [x] Summary cards showing all computed metrics with labels
- [x] Timeline scrubber that synchronizes conversation replay with code diff view
- [x] Clicking a timeline event scrolls the conversation and shows the corresponding code state
- [x] Export button generates JSON report of all metrics and conversation log
- [x] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-017: Assessment link generation and auth

**Description:** As a company admin, I need to generate assessment links both via CLI and a REST API so I can create links manually for individual candidates or programmatically from my ATS and internal tooling.

**Acceptance Criteria:**

- [x] CLI command: npx lintic generate-link --prompt library-api --email candidate@example.com outputs the assessment URL
- [x] REST API: POST /api/links accepts JSON body {prompt_id, email, expires_in_hours (optional, default 72), constraint_overrides (optional)}
- [x] REST API returns {url, token, expires_at, prompt_id, email}
- [x] REST API authenticated via API key in X-Lintic-Api-Key header, key configured in lintic.yml under api.admin_key or LINTIC_ADMIN_KEY env var
- [x] npx lintic init auto-generates a random admin API key and signing secret in the starter config
- [x] Both CLI and API generate a signed JWT with prompt ID, candidate email, constraint config, and expiry
- [x] JWT signed with LINTIC_SECRET_KEY, validated statelessly on any backend instance
- [x] Candidate opening the link in a browser starts a new session automatically
- [x] JWT is single-use: after a session is created from a token, the same token cannot create a second session
- [x] Expired links show a clear "assessment expired" message
- [x] Invalid or already-used links show a clear "link is no longer valid" message
- [x] Unit tests for token generation, validation, expiry, single-use enforcement, and API key auth
- [x] Typecheck passes

### US-018: Prompt configuration and display

**Description:** As a candidate, I need to see the assessment prompt clearly when I start my session so I know what to build.

**Acceptance Criteria:**

- [x] Prompts defined in lintic.yml under prompts array with id, title, description, tags
- [x] On session start, prompt title and description render in a dismissible panel above the IDE
- [x] Prompt remains accessible via a "View Prompt" button in the top bar
- [x] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-019: Docker build and compose configuration

**Description:** As a company admin, I need a single Docker image that runs the entire platform so I can deploy with docker compose up.

**Acceptance Criteria:**

- [x] Multi-stage Dockerfile: build frontend, build backend, production image with both
- [x] docker-compose.yml with single service, volume mount for lintic.yml and SQLite data
- [x] Environment variable passthrough for API keys
- [x] Container starts Express server serving frontend static files and API routes
- [x] Health check endpoint at GET /health
- [x] Typecheck passes

### US-024: Admin dashboard for assessment links

**Description:** As a company admin, I need a dashboard to generate assessment links and inspect previously generated links so I can manage candidate access from the UI.

**Acceptance Criteria:**

- [x] Admin dashboard route available in the frontend for assessment link management
- [x] Admin can generate a new assessment link by selecting a prompt, entering candidate email, and optional expiry/constraint overrides
- [x] Dashboard lists all generated assessment links with prompt, candidate email, created time, expiry, and associated session when consumed
- [x] Dashboard shows link status at a glance: active, consumed, expired, or invalid
- [x] Admin can inspect an individual link to view its full metadata and current state
- [x] Dashboard supports copying the generated assessment link from the UI
- [x] Backend provides API support to list generated links and fetch link details for inspection
- [x] Typecheck passes

### US-020: Redis infrastructure mock package

**Description:** As a candidate, I need a Redis-compatible mock that runs in WebContainers so I can implement caching in my assessment solution.

**Acceptance Criteria:**

- [ ] npm package (lintic-mock-redis) installable inside WebContainers
- [ ] Supports get, set, del, expire, ttl, keys, hget, hset, hgetall, lpush, lrange, sadd, smembers
- [ ] Configurable memory limit with LRU eviction when exceeded
- [ ] Simulated latency (configurable base + random spike probability)
- [ ] Connection pool limit that throws when exceeded
- [ ] Unit tests for all commands and eviction behavior
- [ ] Typecheck passes

### US-021: PostgreSQL infrastructure mock package

**Description:** As a candidate, I need a SQL-compatible mock so I can implement database queries in my assessment solution.

**Acceptance Criteria:**

- [x] npm package (lintic-mock-pg) installable inside WebContainers
- [x] Supports CREATE TABLE, INSERT, SELECT (with WHERE, ORDER BY, LIMIT), UPDATE, DELETE
- [x] In-memory storage engine with basic index simulation
- [x] Configurable connection pool limit
- [x] Slow query logging when no index matches a WHERE clause
- [x] Unit tests for SQL parsing and query execution
- [x] Typecheck passes

### US-022: Infrastructure difficulty profiles

**Description:** As a company admin, I need pre-built difficulty profiles so I can configure infrastructure behavior without setting every parameter.

**Acceptance Criteria:**

- [ ] Define gentle, realistic, and adversarial profiles in packages/core/src/profiles.ts
- [ ] gentle: no failures, generous limits, zero simulated latency
- [ ] realistic: occasional latency spikes (2% probability), moderate connection limits
- [ ] adversarial: frequent spikes (10%), tight pools, aggressive eviction, intermittent failures
- [ ] Profile is specified in lintic.yml under infrastructure.profile
- [ ] Custom overrides merge on top of the base profile
- [ ] Unit tests for profile merging logic
- [ ] Typecheck passes

### US-023: Advanced Metrics and LLM Evaluation Layer

**Description:** As a reviewer, I need a comprehensive advanced metrics suite covering both simulated infrastructure handling (Redis/Postgres) and strategic agent usage (LLM evaluation) so I get a holistic view of the candidate's engineering skills.

**Acceptance Criteria:**

- [x] Track cache hit rate, miss rate, and eviction count for Redis mock
- [x] Track slow queries, connection pool usage, and failed queries for Postgres mock
- [x] Aggregate into infrastructure scores: caching_effectiveness, error_handling_coverage, and scaling_awareness
- [x] Model session data into Iterations preserving `rewound_at` timeline events
- [x] Define Structured Output JSON Schema rubric in `EvaluatorRubric.ts` covering Context Management, Problem Decomposition, Debugging Collaboration, Task Iteration Velocity, Security Awareness, Strategic Backtracking, and Domain Knowledge Directiveness
- [x] Add `SynchronousEvaluatorService.ts` and `POST /api/sessions/:id/evaluate` endpoint
- [x] Update `lintic.yml` schema (`evaluation` block) to support an independent Evaluator LLM config
- [x] Update Review Dashboard UI to render both Infrastructure metrics and the LLM Evaluator Scorecard upon clicking "Analyze Session"
- [x] Write unit tests for metric aggregation and SessionAnalyzer history truncation logic
- [x] Typecheck passes

### US-024: CLI for session management and result export

**Description:** As a company admin, I need CLI tools so I can manage assessments, generate links, and export results without a web admin dashboard.

**Acceptance Criteria:**

- [ ] npx lintic init generates a starter lintic.yml with commented examples
- [ ] npx lintic generate-link --prompt <id> --email <email> outputs assessment URL
- [ ] npx lintic list-sessions shows all sessions with status and scores
- [ ] npx lintic export --session <id> --format json outputs full session data
- [ ] npx lintic export --session <id> --format pdf generates a PDF summary report
- [ ] Typecheck passes

### US-025: End-to-end integration test

**Description:** As a developer, I need an e2e test that validates the full flow from session creation through agent interaction to metric computation.

**Acceptance Criteria:**

- [ ] Playwright test that loads the assessment URL, sends a message to the agent, verifies the response appears
- [ ] Verifies constraint counters decrement after each interaction
- [ ] Verifies session can be closed and review page loads with computed metrics
- [ ] Test uses a mock agent adapter that returns deterministic responses
- [ ] All tests pass in CI (GitHub Actions)
- [ ] Typecheck passes

### US-026: Candidate comparison dashboard

**Description:** As a reviewer, I need a table view of all candidates who took the same assessment so I can compare scores, sort by metrics, and quickly identify top performers.

**Acceptance Criteria:**

- [ ] GET /review route renders a dashboard listing all completed sessions
- [ ] Table columns: candidate email, prompt title, date, overall score, and each individual metric (PQ, IE, CC, TE, RS, IR)
- [ ] Clicking any column header sorts the table by that metric (ascending/descending toggle)
- [ ] Filter dropdown to show only sessions for a specific prompt
- [ ] Filter by date range (last 7 days, 30 days, all time)
- [ ] Clicking a row navigates to the individual session replay at /review/:sessionId
- [ ] Composite score is a weighted average of all metrics (weights configurable in lintic.yml)
- [ ] Table supports pagination (25 candidates per page)
- [ ] npm run typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-027: Webhook and API for external integrations

**Description:** As a company admin, I need Lintic to push assessment results to external systems via webhooks so results flow into our ATS, Slack, or custom tooling automatically.

**Acceptance Criteria:**

- [ ] Configure webhooks in lintic.yml under integrations.webhooks as an array of {url, events, secret}
- [ ] Supported events: session.completed, session.scored
- [ ] session.completed fires when a candidate closes their session, payload includes session ID, candidate email, prompt ID, and timestamp
- [ ] session.scored fires after metrics are computed, payload includes all metric scores, composite score, and a link to the review page
- [ ] Payloads are signed with HMAC-SHA256 using the configured secret, sent in X-Lintic-Signature header
- [ ] Retry failed webhook deliveries up to 3 times with exponential backoff
- [ ] GET /api/webhooks/history returns delivery log with status codes for debugging
- [ ] Unit tests for payload signing and retry logic
- [ ] npm run typecheck passes

### US-028: S3-compatible session backup

**Description:** As a company admin, I need session recordings backed up to S3-compatible storage so session data survives beyond the local SQLite database and can be archived long-term.

**Acceptance Criteria:**

- [ ] Configure backup in lintic.yml under storage.backup with endpoint, bucket, access_key_id, secret_access_key, and region
- [ ] Support any S3-compatible provider (AWS S3, MinIO, Cloudflare R2, Backblaze B2)
- [ ] After a session is scored, automatically upload a JSON archive containing full session data, messages, code snapshots, and computed metrics
- [ ] Archive file path: s3://bucket/lintic/sessions/{sessionId}.json
- [ ] npx lintic backup --all uploads all sessions not yet backed up
- [ ] npx lintic restore --session <id> downloads and imports a session from S3 into local SQLite
- [ ] Backup failures log warnings but do not block session completion
- [ ] Unit tests for S3 upload and restore logic with mocked S3 client
- [ ] npm run typecheck passes

---

## Advanced Agent & Collaboration Features

The stories below extend the platform beyond basic assessment into richer AI-collaboration tooling: a versioned prompt library, conversation branching, advanced agent skill modes, and full git integration inside the WebContainer.

### US-029: Prompt history and library

**Description:** As a company admin, I need a versioned prompt library with usage history so I can iterate on assessment prompts over time and track which versions candidates received.

**Acceptance Criteria:**

- [ ] Prompts stored in the database with a version number and created_at timestamp in addition to the existing lintic.yml definitions
- [ ] Editing a prompt in lintic.yml or via the admin API creates a new version rather than mutating the existing record; prior versions are retained
- [ ] GET /api/prompts returns all prompts with their latest version and aggregate stats (session count, median score, completion rate)
- [ ] GET /api/prompts/:id/history returns all versions of a prompt with diff between consecutive versions
- [ ] Sessions record the exact prompt version used so reviewers see the precise text a candidate received
- [ ] Admin dashboard prompt list shows version number, last edited date, and a "View history" link that diffs versions side by side
- [ ] npx lintic list-prompts --history <id> prints version history in the terminal
- [ ] Unit tests for version creation, history retrieval, and diff generation
- [ ] npm run typecheck passes

### US-030: Conversation source control

**Description:** As a candidate, I need the ability to branch and restore conversation states so I can explore different approaches with the agent without losing earlier progress.

**Acceptance Criteria:**

- [ ] Every message turn is assigned a monotonically increasing sequence number stored in the database
- [ ] Candidate can click "Save checkpoint" on any assistant turn to name and bookmark that conversation state
- [ ] Candidate can "Branch from here" on any prior turn: this forks the conversation, preserving the original branch, and starts a new active branch from that point
- [ ] A branch selector in the chat panel header shows the current branch name and a dropdown to switch between branches
- [ ] Switching branches updates the chat history and the Monaco editor file state to match the chosen branch snapshot (file state captured at each checkpoint)
- [ ] All branches are recorded in the session and visible in the review replay; the reviewer can switch branches during replay
- [ ] GET /api/sessions/:id/branches returns all branches with name, fork point sequence number, and message count
- [ ] POST /api/sessions/:id/branches creates a new branch from a given sequence number
- [ ] Unit tests for branching, branch switching, file state snapshotting, and history isolation between branches
- [ ] npm run typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-031: Advanced AI coding agent skills

**Description:** As a candidate, I need the agent to offer specialized skill modes beyond open-ended chat so I can invoke targeted workflows like code review, test generation, and refactoring without crafting detailed prompts from scratch.

**Acceptance Criteria:**

- [ ] Agent skill modes selectable from a dropdown next to the message input: General, Code Review, Write Tests, Refactor, Explain, Debug
- [ ] Each skill mode prepends a structured system-level instruction to the next message that focuses the agent on that task type (e.g. Code Review instructs the agent to analyze the current file for bugs, style, and correctness)
- [ ] "Code Review" skill: agent reads the active file via read_file, returns inline annotated feedback organized by severity (critical / warning / suggestion)
- [ ] "Write Tests" skill: agent reads the active file, identifies untested functions, and writes a test file alongside it using the project's detected test framework
- [ ] "Refactor" skill: agent reads the active file, proposes and applies a refactored version, explains each change
- [ ] "Explain" skill: agent explains the selected code (or whole file if no selection) in plain language appropriate to a junior developer
- [ ] "Debug" skill: agent reads recent terminal output from the session, identifies the error, locates the source, and proposes a fix
- [ ] Skill mode is recorded per message in the session so reviewers can see which skills the candidate used
- [ ] Skill usage is included as a metric: skill_diversity (number of distinct skills used) and skill_effectiveness (skill messages that resulted in accepted file changes / total skill messages)
- [ ] Admin can restrict available skill modes per prompt in lintic.yml under prompts[].allowed_skills
- [ ] Unit tests for skill instruction assembly, metric computation, and skill restriction enforcement
- [ ] npm run typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-032: Git integration

**Description:** As a candidate, I need git available inside the WebContainer so I can commit my work incrementally, view diffs, and manage branches — mirroring the real workflow of a professional engineer.

**Acceptance Criteria:**

- [ ] Git is initialized in the WebContainer filesystem at session start (git init + initial commit of any starter files)
- [ ] A Git panel in the IDE sidebar shows: current branch name, unstaged changes (file list with +/- counts), staged files, and recent commit log (last 10 commits)
- [ ] Candidate can stage individual files or all changes from the Git panel without using the terminal
- [ ] Candidate can commit staged files with a commit message from the Git panel
- [ ] Candidate can create and switch branches from the Git panel
- [ ] Diff view: clicking a changed file in the Git panel opens a side-by-side diff in Monaco (current vs last commit)
- [ ] All git operations (commit, branch create, checkout) are also available via the integrated terminal using the git binary bundled in the WebContainer node image
- [ ] Reviewers see the full git log in the session replay; each commit is a timeline event with its message, changed files, and insertions/deletions
- [ ] Session metrics include: commit_frequency (commits per hour), commit_granularity (median changed lines per commit), and branch_usage (boolean: did the candidate use branches)
- [ ] If a prompt specifies a starter repository URL in lintic.yml under prompts[].starter_repo, it is cloned into the WebContainer at session start instead of an empty git init
- [ ] Unit tests for git event recording, metric computation, and starter repo cloning logic (mocked WebContainer FS)
- [ ] npm run typecheck passes
- [ ] Verify in browser using dev-browser skill
