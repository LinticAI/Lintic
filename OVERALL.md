# Lintic - Product Requirements Document

**Open-source agentic coding assessment platform**

| Field   | Value              |
|---------|--------------------|
| Author  | Oleg Mrynskyi      |
| Version | 1.0                |
| Date    | March 21, 2026     |
| Status  | Draft              |
| License | MIT                |

---

## 1. Executive Summary

Lintic is an open-source, self-hostable platform that replaces traditional coding assessments with agentic AI workflow evaluations. Instead of asking candidates to solve algorithmic puzzles from memory, Lintic presents short, open-ended prompts and gives candidates access to a full IDE with an AI coding agent. The platform then evaluates how effectively candidates collaborate with AI to produce working software.

Companies deploy Lintic via a single Docker image, plug in their own LLM API key, and configure assessment prompts through a YAML-based question bank. There is zero cost to maintain on the project side and zero SaaS dependency for adopters. Companies retain full control over their data, their AI provider, their token budgets, and their evaluation criteria.

> **Core Thesis:** The most valuable engineering skill in 2026 is not memorizing sorting algorithms. It is the ability to effectively direct AI agents, decompose ambiguous problems, iterate on generated code, and ship working software under resource constraints.

---

## 2. Problem Statement

### 2.1 The Broken Status Quo

Traditional coding assessments like HackerRank and LeetCode measure a narrow band of skills that poorly predict on-the-job performance. They reward memorization of algorithmic patterns, penalize candidates who think differently, and completely ignore the reality that modern engineering is done in collaboration with AI tools. The result is a hiring process that filters for contest programmers while missing strong product engineers.

### 2.2 The Gap

No widely adopted open-source tool exists that lets companies evaluate candidates on agentic AI workflows. Existing solutions either cost significant money (proprietary platforms), require candidates to set up their own environments (friction-heavy), or simply add a chatbot to a traditional coding test without measuring the actual collaboration dynamics.

### 2.3 Who Feels This Pain

- Engineering managers at startups and mid-size companies (under 500 engineers) who know their teams use AI daily but still screen candidates with LeetCode
- Candidates who are excellent AI-augmented engineers but perform poorly on traditional timed algorithm tests
- Hiring teams that want to evaluate real-world engineering judgment rather than textbook knowledge

---

## 3. Target Users

### 3.1 Primary: Engineering Hiring Managers

These are engineering leads at companies with 10 to 500 engineers. They are frustrated with the signal-to-noise ratio of traditional assessments and are looking for a lightweight tool they can self-host without procurement cycles or vendor lock-in. They want to configure their own questions, set their own constraints, and review candidate sessions on their own terms.

### 3.2 Secondary: Candidates

Software engineers at all experience levels who are applying for roles. They interact with the assessment environment during a timed session. They need the IDE and agent to feel natural and responsive, with minimal setup friction and clear instructions.

### 3.3 Tertiary: Open-Source Contributors

Developers who want to extend the platform with new agent integrations, metric plugins, or IDE features. The project should be modular enough to welcome contributions without requiring deep knowledge of the full codebase.

---

## 4. Product Overview

### 4.1 How It Works

The assessment flow has three phases that map to the experience of the company admin, the candidate, and the reviewer.

**Phase 1: Company Setup**

An engineering manager deploys the Lintic Docker image on their infrastructure. They configure a YAML file that defines assessment prompts, which LLM provider and model to use, the API key, and any resource constraints such as context window limits and max tokens per session. The system generates unique, time-limited assessment links for each candidate.

**Phase 2: Candidate Session**

The candidate opens their assessment link in a browser. They see a brief, open-ended prompt (for example, "Build a REST API that manages a library catalog") alongside a full IDE powered by WebContainers and an AI coding agent panel. The candidate works by conversing with the agent, writing and editing code directly, running commands in an integrated terminal, and iterating until they are satisfied with their solution. The entire session is recorded, including all agent conversations, code changes, terminal output, and timestamps.

**Phase 3: Review and Scoring**

After the session, reviewers access a dashboard that includes a full conversation and code replay, structured metrics computed automatically, and the final code output. Reviewers can scrub through the timeline to understand the candidate's thought process, decision-making patterns, and ability to recover from mistakes.

> **Key Differentiator:** Lintic does not just test whether candidates can use AI. It tests whether they can use AI strategically under constraints, which is exactly what matters in a production environment where token costs and rate limits are real.

---

## 5. The Constraint System

One of the most important features of Lintic is the ability for companies to impose resource constraints on the AI agent during an assessment. This transforms the evaluation from "can this person use AI" into "can this person use AI strategically when resources are limited," which is a much more valuable signal.

### 5.1 Configurable Constraints

| Constraint | Description | Example Config |
|---|---|---|
| **Context Window** | Maximum tokens the agent can see per request. Smaller windows force candidates to write clearer, more focused prompts. | `context_window: 8000` |
| **Max Tokens / Session** | Total token budget for the entire session. Candidates must prioritize which questions to ask the agent and when. | `max_session_tokens: 50000` |
| **Max Tokens / Message** | Per-message output cap. Prevents candidates from relying on massive single-shot code generation. | `max_message_tokens: 2000` |
| **Agent Interactions** | Hard limit on the number of times a candidate can prompt the agent. Encourages thoughtful, high-quality prompts. | `max_interactions: 25` |
| **Time Limit** | Total session duration. Candidates must balance speed with thoroughness. | `time_limit_minutes: 60` |

### 5.2 Why Constraints Matter

In real engineering work, AI resources are not unlimited. Teams operate under API budgets, rate limits, and latency requirements. A candidate who can produce a working solution with 15 well-crafted agent interactions is demonstrating a fundamentally different (and more valuable) skill than one who brute-forces through 50 vague prompts. The constraint system lets companies simulate their actual working conditions and see how candidates perform within them.

---

## 6. Agent-Agnostic Architecture

### 6.1 Design Philosophy

Lintic does not ship a proprietary AI agent. Instead, it provides a standardized Agent Interface Protocol (AIP) that any coding agent can implement to integrate with the platform. This means companies can use whatever AI provider and agent framework they prefer, the platform stays maintainable without depending on fast-moving third-party agent codebases, and the open-source community can contribute agent adapters without touching core platform code.

### 6.2 Agent Interface Protocol

The AIP defines a simple contract between the platform and any agent. An agent adapter must implement the following interface.

```typescript
interface AgentAdapter {
  init(config: AgentConfig): Promise<void>;
  sendMessage(msg: string, context: SessionContext): Promise<AgentResponse>;
  getTokenUsage(): TokenUsage;
  getCapabilities(): AgentCapabilities;
}
```

### 6.3 Bundled Adapters

The platform ships with reference adapters for the most common setups to minimize time-to-first-assessment for adopters.

- **Generic OpenAI-Compatible Adapter** works with any provider that exposes an OpenAI-compatible chat completions API, including OpenAI, Anthropic (via proxy), Groq, Together, Ollama, and others
- **Anthropic Native Adapter** provides direct integration with the Anthropic Messages API, supporting Claude's extended thinking and tool use features
- **Custom Agent Template** is a documented starter template for teams that want to bring their own fine-tuned model or custom agent framework

---

## 7. Metrics and Evaluation

### 7.1 Structured Metrics

Lintic automatically computes a set of structured metrics from every candidate session. These metrics are designed to capture the quality of the human-AI collaboration, not just the final output.

| Metric | What It Measures | How It Is Computed |
|---|---|---|
| **Prompt Quality Score** | Clarity, specificity, and effectiveness of the candidate's prompts to the agent | LLM-evaluated rubric applied to each prompt, averaged across the session |
| **Iteration Efficiency** | How many agent interactions it takes to reach a working solution | Ratio of productive interactions (ones that moved the solution forward) to total interactions |
| **Code Correctness** | Whether the final code works as specified | Automated test suite execution against the prompt's acceptance criteria |
| **Token Efficiency** | How strategically the candidate used their token budget | Solution quality score divided by total tokens consumed |
| **Recovery Score** | Ability to identify and fix agent errors or bad suggestions | Number of successful corrections divided by total agent errors encountered |
| **Independence Ratio** | Balance between agent-generated and hand-written code | Percentage of final code lines that were manually written or significantly modified by the candidate |

### 7.2 Session Replay

Beyond automated metrics, every session generates a full replay that reviewers can scrub through. The replay synchronizes the conversation timeline (every prompt and response), the code diff timeline (every file change with diffs), terminal output history, and resource consumption over time (a graph showing token usage against the budget). This gives reviewers the full picture of how a candidate thinks, not just what they produced.

### 7.3 Exportable Reports

Companies can export assessment results as JSON for integration with their ATS, or as a PDF summary for sharing with the hiring committee. The JSON export includes all raw metrics, the full conversation log, and code snapshots at each stage.

---

## 8. Simulated Infrastructure Layer

Real-world engineering goes far beyond writing application logic. Senior engineers are expected to think about caching strategies, message queues, database scaling, rate limiting, and service communication patterns. Lintic includes a Simulated Infrastructure Layer that provides in-browser mock implementations of common infrastructure services, allowing companies to test whether candidates can architect systems that handle scale, not just write code that works on a single request.

### 8.1 How It Works

The infrastructure mocks run entirely inside the WebContainers environment as lightweight npm packages that expose the same APIs as their real counterparts. Candidates install and use them exactly as they would the real services. The key difference is that these mocks are instrumented to simulate realistic behavior at scale, including latency characteristics, failure modes, and capacity limits that companies can configure per assessment.

> **Design Principle:** Mock services should feel indistinguishable from real services during development. A candidate who writes code against the mock Redis client should be writing code that would work against a real Redis instance. The mocks add simulated scale behavior on top of correct API behavior.

### 8.2 Available Infrastructure Mocks

| Service | What It Simulates | Scale Behaviors |
|---|---|---|
| **Redis** | In-memory key-value store with support for strings, hashes, lists, sets, sorted sets, pub/sub, and TTL expiration | Configurable memory limits that trigger eviction policies (LRU, LFU, random). Simulated latency spikes under high key counts. Connection pool exhaustion when too many concurrent operations are in flight. |
| **PostgreSQL** | Relational database with full SQL query support via an in-memory engine, including transactions, indexes, and joins | Slow query simulation when missing indexes are detected. Connection pool limits. Lock contention on concurrent writes to the same rows. Query planner hints in logs. |
| **Message Queue** | Pub/sub and point-to-point messaging compatible with both AMQP (RabbitMQ-style) and simple queue APIs | Consumer lag simulation. Dead letter queue behavior after configurable retry counts. Message ordering guarantees that break under specific failure scenarios. Backpressure when queue depth exceeds limits. |
| **HTTP Load Balancer** | Reverse proxy that distributes incoming requests across multiple simulated backend instances | Round-robin, least-connections, and weighted routing. Health check failures that remove instances. Rate limiting with configurable token bucket. 502/503 responses under simulated overload. |
| **Object Storage** | S3-compatible API for file uploads, downloads, listing, and pre-signed URLs | Bandwidth throttling on large file operations. Eventual consistency simulation for list operations after writes. Multipart upload timeout scenarios. |
| **Rate Limiter** | Middleware-compatible rate limiting service with sliding window and token bucket algorithms | Configurable limits per endpoint. Distributed rate limiting simulation across multiple instances. Burst allowance configuration. |

### 8.3 Infrastructure Configuration

Companies configure which infrastructure mocks are available for each assessment prompt and what scale characteristics they exhibit. This is defined in the prompt's YAML configuration.

```yaml
infrastructure:
  redis:
    enabled: true
    max_memory_mb: 64
    eviction_policy: allkeys-lru
    simulated_latency_ms: 2
    spike_latency_ms: 150
    spike_probability: 0.02

  postgres:
    enabled: true
    max_connections: 20
    slow_query_threshold_ms: 100
    simulate_missing_index_penalty: true

  message_queue:
    enabled: true
    max_queue_depth: 10000
    retry_limit: 3
    simulate_consumer_lag: true

  load_balancer:
    enabled: false
```

### 8.4 Infrastructure Metrics

When infrastructure mocks are enabled, the platform captures additional metrics that reveal how candidates think about system design.

- **Caching Effectiveness** measures hit rate, miss rate, and whether the candidate implemented caching proactively or only after observing latency issues
- **Error Handling Coverage** tracks whether the candidate handled connection failures, timeouts, and capacity errors gracefully or let them crash the application
- **Scaling Awareness** scores whether the candidate's architecture would hold up under the simulated load profile, based on connection pooling, query optimization, and queue management patterns
- **Infrastructure Iteration Count** captures how many times the candidate adjusted their infrastructure strategy during the session, distinguishing between candidates who design for scale upfront and those who iterate toward it

### 8.5 Difficulty Profiles

To make prompt configuration easier, the platform ships with pre-built infrastructure difficulty profiles that companies can reference by name instead of configuring every parameter individually.

| Profile | Behavior |
|---|---|
| **gentle** | All services behave ideally. No latency spikes, no failures, generous limits. Good for junior candidates or prompts focused on application logic rather than infrastructure. |
| **realistic** | Services exhibit typical production behavior. Occasional latency spikes, moderate connection limits, standard eviction and retry policies. Good baseline for mid-level assessments. |
| **adversarial** | Services actively stress the candidate's code. Frequent latency spikes, tight connection pools, aggressive eviction, queue backpressure, and intermittent failures. Designed for senior and staff-level assessments. |
| **custom** | Company defines every parameter. Full control over each service's behavior for specialized assessment scenarios. |

> **Example Use Case:** A company assessing senior backend candidates might present the prompt "Build a URL shortener that handles 10,000 requests per second" with the adversarial infrastructure profile enabled. The candidate would need to implement Redis caching with proper eviction handling, use the message queue for async analytics, handle database connection pool exhaustion gracefully, and implement rate limiting at the load balancer level. The metrics would capture not just whether the final code works, but how the candidate discovered and responded to each infrastructure challenge during the session.

---

## 9. Technical Architecture

### 9.1 High-Level Architecture

Lintic is a self-contained application delivered as a single Docker image. Internally it consists of three layers that communicate through well-defined internal APIs.

1. **Frontend Layer** is a React-based single-page application that includes the IDE (built on Monaco Editor), the agent chat panel, the constraint dashboard showing remaining budget in real time, and the review/replay interface.
2. **Backend Layer** is a Node.js server that handles session management, authentication via time-limited assessment links, agent message proxying and constraint enforcement, metric computation, and session recording and storage.
3. **Runtime Layer** uses WebContainers (via the @webcontainer/api package) running entirely in the candidate's browser. This provides a full Node.js environment with npm, a filesystem, and a terminal, all without requiring any server-side compute for code execution.

> **Why WebContainers:** By running the candidate's code environment entirely in the browser, Lintic eliminates the most expensive part of hosting a coding assessment platform. There are no sandboxed containers to spin up, no compute costs per session, and no security concerns around running untrusted code on your servers. The tradeoff is that the runtime is limited to Node.js and browser-compatible toolchains, which covers the vast majority of web-focused assessment scenarios.

### 9.2 Data Flow

When a candidate sends a message to the agent, the message first passes through the Constraint Enforcer on the backend, which checks the remaining token budget and interaction count. If the constraints are satisfied, the message is forwarded to the configured Agent Adapter, which calls the external LLM API using the company's API key. The response flows back through the Constraint Enforcer (which deducts tokens from the budget), gets recorded by the Session Recorder, and is delivered to the frontend. The entire round-trip is logged with timestamps for the session replay.

### 9.3 Technology Stack

| Component | Technology |
|---|---|
| **Frontend** | React, TypeScript, Monaco Editor, Tailwind CSS |
| **Backend** | Node.js, Express, SQLite (embedded) or PostgreSQL (serverless) |
| **Code Runtime** | WebContainers (@webcontainer/api) |
| **Infrastructure Mocks** | Custom npm packages (lintic-mock-redis, lintic-mock-pg, etc.) |
| **Agent Communication** | Agent Interface Protocol over internal REST API |
| **Session Storage** | SQLite with JSON columns or PostgreSQL via DatabaseAdapter interface |
| **Deployment** | Single Docker image, docker-compose.yml included |
| **Configuration** | YAML files for prompts, constraints, and agent config |

---

## 10. Configuration and Deployment

### 10.1 Minimal Configuration

A company can go from zero to running assessments with a single configuration file. The following is an example of the minimum viable config.

```yaml
# lintic.yml
agent:
  provider: openai-compatible
  base_url: https://api.openai.com/v1
  api_key: ${OPENAI_API_KEY}
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
    description: >
      Build a REST API that manages a library catalog.
      Support CRUD operations for books, search by
      title or author, and a checkout system that
      tracks which books are currently borrowed.
    difficulty: medium
    tags: [backend, api-design, data-modeling]
```

### 10.2 Deployment

Deployment requires two commands.

```bash
docker pull ghcr.io/lintic/lintic:latest
docker compose up -d
```

The Docker image includes everything needed to run the platform. There are no external database dependencies (SQLite is embedded), no separate services to configure, and no cloud accounts to set up beyond the LLM API key the company already has.

---

## 11. Question Design Philosophy

Lintic prompts are intentionally different from traditional coding assessment questions. They follow a set of design principles that maximize the signal companies get about a candidate's agentic workflow skills.

1. **Open-ended by default.** Prompts describe a goal and constraints, not a specific algorithm or data structure. There are multiple valid approaches, which lets the platform observe how candidates decompose ambiguity.
2. **Short and realistic.** Prompts are 2 to 4 sentences, similar to a real Jira ticket or Slack message from a product manager. Candidates must decide what questions to ask (of the agent) and what assumptions to make.
3. **Testable outcomes.** Every prompt has a hidden acceptance criteria suite that runs automatically. Candidates are told their solution will be tested but do not see the specific test cases, mirroring real-world development against a spec.
4. **Constraint-aware.** The best prompts are designed so that the optimal solution strategy changes depending on the constraint profile. A candidate with 50 agent interactions should approach the problem differently than one with 15.

---

## 12. Open-Source Strategy

### 12.1 License

Lintic will be released under the MIT License to maximize adoption and minimize friction for companies evaluating the tool. MIT was chosen over more restrictive licenses like AGPL because the goal is widespread adoption, not monetization.

### 12.2 Repository Structure

The project will use a monorepo structure organized into clear packages to make contributions approachable.

- **packages/core** contains session management, constraint enforcement, metric computation
- **packages/frontend** contains the React application with the IDE, agent panel, and review dashboard
- **packages/adapters** contains agent adapter implementations, one directory per adapter
- **packages/cli** contains command-line tools for generating assessment links and exporting results
- **docs/** contains setup guides, adapter authoring guide, question design guide, architecture overview

### 12.3 Community Contribution Model

The most natural contribution surface is agent adapters. Each adapter is self-contained in its own directory with a standard structure, which means contributors can add support for a new LLM provider or agent framework without touching any core code. The project will also accept community-contributed prompt packs (curated sets of assessment questions for specific roles like frontend, backend, full-stack, or data engineering), metric plugins for custom scoring, and IDE theme and layout customizations.

### 12.4 Zero-Cost Sustainability

The project is designed so that the maintainer bears zero infrastructure or operational cost. Companies self-host everything. The Docker image is published to GitHub Container Registry (free for public repos). CI/CD runs on GitHub Actions (free for public repos). Documentation lives in the repo and is published via GitHub Pages. There is no SaaS backend, no telemetry server, and no license server.

---

## 13. Adoption Strategy

### 13.1 Reducing Friction to Zero

Every design decision in Lintic prioritizes reducing adoption friction. The single Docker image means no multi-service orchestration. The embedded SQLite database means no external database provisioning. YAML configuration means no admin dashboard to build for V1. The agent-agnostic architecture means companies use whatever LLM provider they already pay for. The WebContainers runtime means no per-session compute costs.

### 13.2 Go-To-Market Channels

1. Launch on Hacker News and r/programming with a clear demo video showing the full flow from deployment to candidate session to review
2. Publish the project on GitHub with a polished README, animated GIF demos, and a one-click deploy badge for Railway/Render/Fly.io
3. Write a blog post framing the thesis ("LeetCode is dead, here is how to assess AI-native engineers") and distribute through developer newsletters
4. Engage with the hiring/recruiting community on LinkedIn and Twitter, targeting engineering managers who publicly criticize traditional assessments
5. Submit talks to developer conferences about rethinking technical interviews in the AI era

### 13.3 Success Metrics for Adoption

| Metric | 3-Month Target | 12-Month Target |
|---|---|---|
| **GitHub Stars** | 500 | 3,000 |
| **Docker Pulls** | 1,000 | 10,000 |
| **Companies Using in Production** | 10 | 100 |
| **Community Agent Adapters** | 3 | 10+ |
| **Community Prompt Packs** | 2 | 8+ |

---

## 14. Roadmap

**Phase 1: Foundation (Weeks 1 through 6)**

- Core session management and constraint enforcement engine
- WebContainers integration with Monaco Editor
- OpenAI-compatible agent adapter
- Basic session recording and playback
- YAML-based configuration system
- Docker image build and publish pipeline

**Phase 2: Metrics and Review (Weeks 7 through 10)**

- Automated metric computation pipeline
- Review dashboard with synchronized timeline replay
- JSON and PDF export for assessment results
- Anthropic native agent adapter
- Sample prompt pack with 10 assessment questions
- Redis and PostgreSQL infrastructure mocks with configurable scale profiles

**Phase 3: Community and Polish (Weeks 11 through 14)**

- Agent adapter authoring SDK and documentation
- Message queue, load balancer, and object storage mocks
- Pre-built infrastructure difficulty profiles (gentle, realistic, adversarial)
- Community prompt pack submission system
- One-click deploy templates for Railway, Render, and Fly.io
- Comprehensive documentation site
- Launch campaign and outreach

**Phase 4: Future Considerations**

- Optional cloud container runtime for Python, Go, and Rust assessments
- Team-based collaborative assessments (pair programming with AI)
- Integration plugins for popular ATS platforms (Greenhouse, Lever, Ashby)
- Candidate self-practice mode for interview preparation
- Comparative analytics across candidates for the same prompt

---

## 15. Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **WebContainers limits language support to Node.js ecosystem** | Medium | Document this limitation clearly. Plan Phase 4 cloud container option for teams that need Python/Go. Most web-focused assessments work fine with Node.js. |
| **Companies may not trust open-source for hiring security** | Medium | Self-hosting means data never leaves the company's infrastructure. Provide a security architecture document. Offer guidance on running behind a VPN. |
| **LLM API changes break agent adapters** | Low | Agent-agnostic architecture isolates breakage to individual adapters. Community can patch adapters independently of core releases. |
| **Low initial adoption makes the project appear abandoned** | Medium | Invest heavily in documentation, demo content, and the launch campaign. Keep the scope small and polished rather than broad and rough. |
| **Candidates game the system by pre-preparing agent prompts** | Low | Companies control their own question bank and can rotate prompts. Constraint system makes pre-prepared prompts less effective since the strategy must adapt to the budget. |

---

## 16. Success Criteria

Lintic will be considered successful if it meets the following criteria within 12 months of launch.

1. At least 100 companies have deployed and used the platform in a real hiring pipeline
2. The platform generates measurably better hiring signal than traditional coding assessments, as validated by feedback from adopting companies
3. An active open-source community contributes at least 10 agent adapters and 8 prompt packs
4. The project maintains zero ongoing cost to the maintainer
5. At least 3 blog posts or conference talks by external developers reference Lintic as a tool they use or recommend
