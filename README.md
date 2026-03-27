# Lintic

Open-source, self-hostable AI coding assessment platform. Candidates get a browser-based IDE with an AI coding agent and real resource constraints — token budgets, interaction limits, simulated infrastructure. Companies evaluate how candidates use AI strategically, not just whether they can.

## Quick Start

```bash
npm install
npm run typecheck
npm run lint
npm run test
```

## Contributing

### The Golden Rules

1. **Never commit directly to `main`.** All work happens on a feature branch and merges via PR.
2. **One user story = one PR.** Every PR must map to a single user story. No bundling multiple stories into one PR.
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
| `@lintic/cli` | Assessment link generation, result export | `@lintic/core` |
| `@lintic/frontend` | React IDE, chat panel, review dashboard | `@lintic/core` |

**Rule:** All shared types live in `@lintic/core`. No type duplication across packages.

### Adding a New Package Dependency

Only add a dependency when a user story explicitly requires it. Add to the package that uses it, not the root (exception: shared dev tooling like TypeScript and ESLint stays at root).

### Design Docs and Plans

Before implementing any non-trivial story:
- Design doc → `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Implementation plan → `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`

These are committed alongside the implementation so future contributors understand the reasoning.
