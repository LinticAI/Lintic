# US-004: Constraint Enforcer Design

**Date:** 2026-03-27
**Story:** US-004 — Constraint enforcer module
**Status:** Approved

---

## Context

The constraint enforcer is a per-session guard that enforces the resource limits configured in `lintic.yml`. It lives between the backend request handler and the agent adapter: before forwarding a message the handler calls `canSend()`, and after the LLM responds it calls `recordUsage(tokens)`. The enforcer is the single source of truth for what budget remains in a session.

---

## Public API

```ts
class ConstraintEnforcer {
  constructor(constraint: Constraint, startedAt?: number)
  canSend(): boolean
  recordUsage(tokens: number): void
  getRemaining(): ConstraintsRemaining
}
```

`Constraint` and `ConstraintsRemaining` are re-used from `packages/core/src/types.ts`.

---

## Behaviour

### `constructor(constraint, startedAt?)`

- Accepts a `Constraint` config object and an optional Unix ms timestamp for when the session started.
- `startedAt` defaults to `Date.now()` at construction time. Callers should pass `session.created_at` to stay in sync with the database record.
- Initialises internal counters: `tokensUsed = 0`, `interactionsUsed = 0`.

### `canSend(): boolean`

Returns `false` (without throwing) if any of the following are true:
- `tokensUsed >= constraint.max_session_tokens`
- `interactionsUsed >= constraint.max_interactions`
- Elapsed time since `startedAt` >= `constraint.time_limit_minutes * 60` seconds

Returns `true` otherwise. The caller decides how to surface the rejection to the user.

### `recordUsage(tokens: number): void`

1. Adds `tokens` to `tokensUsed`.
2. Increments `interactionsUsed` by 1.
3. If `tokens > constraint.max_message_tokens`, throws:
   ```
   Error('Constraint violated: message used N tokens, limit is M per message')
   ```
   The deduction has already been applied before the throw, so the session budget always reflects actual usage. The over-limit response was already delivered to the user; the throw signals that the per-message cap was breached.

### `getRemaining(): ConstraintsRemaining`

Returns a snapshot:
```ts
{
  tokens_remaining:       Math.max(0, constraint.max_session_tokens - tokensUsed),
  interactions_remaining: Math.max(0, constraint.max_interactions - interactionsUsed),
  seconds_remaining:      Math.max(0, constraint.time_limit_minutes * 60 - elapsedSeconds),
}
```

All values are clamped to 0 — never negative.

---

## File

- **New:** `packages/core/src/constraint-enforcer.ts`
- **New:** `packages/core/src/constraint-enforcer.test.ts`
- **Edit:** `packages/core/src/index.ts` — export `ConstraintEnforcer`

No new dependencies required.

---

## Testing

One test file with Vitest. Coverage targets:

| Scenario | Method |
|---|---|
| `canSend()` returns true when all limits have headroom | `canSend` |
| `canSend()` returns false when session tokens exhausted | `canSend` |
| `canSend()` returns false when interactions exhausted | `canSend` |
| `canSend()` returns false when time limit elapsed | `canSend` |
| `recordUsage()` deducts tokens and increments interactions | `recordUsage` |
| `recordUsage()` throws with descriptive message when tokens exceed per-message limit | `recordUsage` |
| `recordUsage()` still deducts when over per-message limit (budget accuracy) | `recordUsage` |
| `getRemaining()` returns correct values after several usages | `getRemaining` |
| `getRemaining()` clamps all values to 0, never negative | `getRemaining` |
| Boundary: exactly at session token limit → `canSend()` returns false | boundary |
| Boundary: exactly at interaction limit → `canSend()` returns false | boundary |
| Boundary: one token under session limit → `canSend()` returns true | boundary |
| Time: `startedAt` defaults to construction time | time |
| Time: custom `startedAt` in past puts session over time limit | time |
