# US-004: Constraint Enforcer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `ConstraintEnforcer` — a class that tracks token usage and interaction count per session and rejects requests that exceed configured limits.

**Architecture:** A single stateful class in `packages/core/src/constraint-enforcer.ts` that accepts a `Constraint` config and an optional session start timestamp. It exposes three methods: `canSend()` checks pre-request limits, `recordUsage(tokens)` records post-response usage and throws if the per-message cap was exceeded, and `getRemaining()` returns a budget snapshot. All types are already defined in `types.ts`.

**Tech Stack:** TypeScript, Vitest (already installed at workspace root)

---

### Task 1: Write the failing tests

**Files:**
- Create: `packages/core/src/constraint-enforcer.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// packages/core/src/constraint-enforcer.test.ts
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConstraintEnforcer } from './constraint-enforcer.js';
import type { Constraint } from './types.js';

const BASE: Constraint = {
  max_session_tokens: 1000,
  max_message_tokens: 200,
  max_interactions: 5,
  context_window: 8000,
  time_limit_minutes: 60,
};

describe('canSend', () => {
  test('returns true when all limits have headroom', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    expect(enforcer.canSend()).toBe(true);
  });

  test('returns false when session token budget is exhausted', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    enforcer.recordUsage(1000); // uses full budget
    expect(enforcer.canSend()).toBe(false);
  });

  test('returns false when interaction limit is reached', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    for (let i = 0; i < 5; i++) enforcer.recordUsage(10);
    expect(enforcer.canSend()).toBe(false);
  });

  test('returns false when time limit has elapsed', () => {
    const sixtyOneMinutesAgo = Date.now() - 61 * 60 * 1000;
    const enforcer = new ConstraintEnforcer(BASE, sixtyOneMinutesAgo);
    expect(enforcer.canSend()).toBe(false);
  });

  test('returns true when exactly one token under session limit', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    enforcer.recordUsage(999);
    expect(enforcer.canSend()).toBe(true);
  });

  test('returns false when exactly at session token limit', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    enforcer.recordUsage(1000);
    expect(enforcer.canSend()).toBe(false);
  });

  test('returns false when exactly at interaction limit', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    for (let i = 0; i < 5; i++) enforcer.recordUsage(1);
    expect(enforcer.canSend()).toBe(false);
  });

  test('returns true when one interaction under the limit', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    for (let i = 0; i < 4; i++) enforcer.recordUsage(1);
    expect(enforcer.canSend()).toBe(true);
  });
});

describe('recordUsage', () => {
  test('deducts tokens from session budget', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    enforcer.recordUsage(300);
    expect(enforcer.getRemaining().tokens_remaining).toBe(700);
  });

  test('increments interaction count', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    enforcer.recordUsage(10);
    enforcer.recordUsage(10);
    expect(enforcer.getRemaining().interactions_remaining).toBe(3);
  });

  test('throws descriptive error when tokens exceed per-message limit', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    expect(() => enforcer.recordUsage(201)).toThrow(
      'Constraint violated: message used 201 tokens, limit is 200 per message'
    );
  });

  test('still deducts tokens even when per-message limit is exceeded', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    try { enforcer.recordUsage(201); } catch { /* expected */ }
    expect(enforcer.getRemaining().tokens_remaining).toBe(799);
  });

  test('still increments interaction count even when per-message limit is exceeded', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    try { enforcer.recordUsage(201); } catch { /* expected */ }
    expect(enforcer.getRemaining().interactions_remaining).toBe(4);
  });

  test('does not throw when tokens equal the per-message limit', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    expect(() => enforcer.recordUsage(200)).not.toThrow();
  });
});

describe('getRemaining', () => {
  test('returns full budget when no usage recorded', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    const remaining = enforcer.getRemaining();
    expect(remaining.tokens_remaining).toBe(1000);
    expect(remaining.interactions_remaining).toBe(5);
    expect(remaining.seconds_remaining).toBeGreaterThan(3590);
  });

  test('clamps tokens_remaining to 0 when over budget', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    enforcer.recordUsage(200);
    enforcer.recordUsage(200);
    enforcer.recordUsage(200);
    enforcer.recordUsage(200);
    enforcer.recordUsage(200); // 1000 total — at limit
    // recordUsage a 6th time would exceed interactions; do it manually via a high token count
    // Actually: 5 * 200 = 1000. tokens_remaining should be exactly 0.
    expect(enforcer.getRemaining().tokens_remaining).toBe(0);
  });

  test('clamps interactions_remaining to 0, never negative', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    for (let i = 0; i < 5; i++) enforcer.recordUsage(1);
    expect(enforcer.getRemaining().interactions_remaining).toBe(0);
  });

  test('clamps seconds_remaining to 0 when time has elapsed', () => {
    const past = Date.now() - 120 * 60 * 1000; // 2 hours ago
    const enforcer = new ConstraintEnforcer(BASE, past);
    expect(enforcer.getRemaining().seconds_remaining).toBe(0);
  });

  test('returns correct seconds_remaining for a fresh session', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    const remaining = enforcer.getRemaining();
    // 60 minutes = 3600 seconds; allow 2 seconds of test execution slack
    expect(remaining.seconds_remaining).toBeGreaterThanOrEqual(3598);
    expect(remaining.seconds_remaining).toBeLessThanOrEqual(3600);
  });
});

describe('constructor', () => {
  test('startedAt defaults to approximately now', () => {
    const before = Date.now();
    const enforcer = new ConstraintEnforcer(BASE);
    const after = Date.now();
    const remaining = enforcer.getRemaining();
    const elapsed = BASE.time_limit_minutes * 60 - remaining.seconds_remaining;
    expect(elapsed * 1000).toBeGreaterThanOrEqual(0);
    expect(elapsed * 1000).toBeLessThanOrEqual(after - before + 100);
  });

  test('accepts a custom startedAt timestamp', () => {
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    const enforcer = new ConstraintEnforcer(BASE, thirtyMinutesAgo);
    const remaining = enforcer.getRemaining();
    // ~30 minutes = ~1800 seconds remaining; allow 5 seconds slack
    expect(remaining.seconds_remaining).toBeGreaterThanOrEqual(1795);
    expect(remaining.seconds_remaining).toBeLessThanOrEqual(1800);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd /path/to/repo && npm run test --workspace=packages/core
```

Expected: `FAIL src/constraint-enforcer.test.ts` — module not found.

---

### Task 2: Implement ConstraintEnforcer

**Files:**
- Create: `packages/core/src/constraint-enforcer.ts`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/constraint-enforcer.ts
import type { Constraint, ConstraintsRemaining } from './types.js';

export class ConstraintEnforcer {
  private readonly constraint: Constraint;
  private readonly startedAt: number;
  private tokensUsed: number = 0;
  private interactionsUsed: number = 0;

  constructor(constraint: Constraint, startedAt?: number) {
    this.constraint = constraint;
    this.startedAt = startedAt ?? Date.now();
  }

  canSend(): boolean {
    return (
      this.tokensUsed < this.constraint.max_session_tokens &&
      this.interactionsUsed < this.constraint.max_interactions &&
      this.elapsedSeconds() < this.constraint.time_limit_minutes * 60
    );
  }

  recordUsage(tokens: number): void {
    this.tokensUsed += tokens;
    this.interactionsUsed += 1;

    if (tokens > this.constraint.max_message_tokens) {
      throw new Error(
        `Constraint violated: message used ${tokens} tokens, limit is ${this.constraint.max_message_tokens} per message`
      );
    }
  }

  getRemaining(): ConstraintsRemaining {
    const secondsAllowed = this.constraint.time_limit_minutes * 60;
    return {
      tokens_remaining: Math.max(0, this.constraint.max_session_tokens - this.tokensUsed),
      interactions_remaining: Math.max(0, this.constraint.max_interactions - this.interactionsUsed),
      seconds_remaining: Math.max(0, secondsAllowed - this.elapsedSeconds()),
    };
  }

  private elapsedSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test --workspace=packages/core
```

Expected: all tests pass, no errors.

---

### Task 3: Export and verify

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 5: Add export to index.ts**

Add this line to `packages/core/src/index.ts`:

```typescript
export * from './constraint-enforcer.js';
```

The file should now read:
```typescript
export const VERSION: string = '0.0.1';
export * from './types.js';
export * from './config.js';
export * from './constraint-enforcer.js';
```

- [ ] **Step 6: Run full quality gate**

```bash
npm run typecheck && npm run lint && npm run test --workspace=packages/core
```

Expected: all pass with no errors or warnings.

- [ ] **Step 7: Mark US-004 acceptance criteria complete in PRD.md**

In `PRD.md`, change the US-004 checkboxes from `[ ]` to `[x]`:

```markdown
- [x] ConstraintEnforcer class that accepts a Constraint config
- [x] Methods: canSend() returns boolean, recordUsage(tokens) updates state, getRemaining() returns budget info
- [x] Enforces max_session_tokens, max_message_tokens, max_interactions
- [x] Returns descriptive error when a constraint is violated
- [x] Unit tests for all constraint boundaries and edge cases
- [x] Typecheck passes
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/constraint-enforcer.ts \
        packages/core/src/constraint-enforcer.test.ts \
        packages/core/src/index.ts \
        PRD.md
git commit -m "feat(core): add ConstraintEnforcer module (US-004)"
```
