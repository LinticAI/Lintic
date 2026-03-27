import { describe, test, expect } from 'vitest';
import { ConstraintEnforcer } from './constraint-enforcer.js';
import type { Constraint } from './types.js';

const BASE: Constraint = {
  max_session_tokens: 1000,
  max_message_tokens: 2000,
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
    enforcer.recordUsage(1000);
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
    expect(() => enforcer.recordUsage(2001)).toThrow(
      'Constraint violated: message used 2001 tokens, limit is 2000 per message'
    );
  });

  test('still deducts tokens even when per-message limit is exceeded', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    try { enforcer.recordUsage(2001); } catch { /* expected */ }
    expect(enforcer.getRemaining().tokens_remaining).toBe(0);
  });

  test('still increments interaction count even when per-message limit is exceeded', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    try { enforcer.recordUsage(2001); } catch { /* expected */ }
    expect(enforcer.getRemaining().interactions_remaining).toBe(4);
  });

  test('does not throw when tokens equal the per-message limit', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    expect(() => enforcer.recordUsage(2000)).not.toThrow();
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
    enforcer.recordUsage(200);
    expect(enforcer.getRemaining().tokens_remaining).toBe(0);
  });

  test('clamps interactions_remaining to 0, never negative', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    for (let i = 0; i < 5; i++) enforcer.recordUsage(1);
    expect(enforcer.getRemaining().interactions_remaining).toBe(0);
  });

  test('clamps seconds_remaining to 0 when time has elapsed', () => {
    const past = Date.now() - 120 * 60 * 1000;
    const enforcer = new ConstraintEnforcer(BASE, past);
    expect(enforcer.getRemaining().seconds_remaining).toBe(0);
  });

  test('returns correct seconds_remaining for a fresh session', () => {
    const enforcer = new ConstraintEnforcer(BASE);
    const remaining = enforcer.getRemaining();
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
    expect(remaining.seconds_remaining).toBeGreaterThanOrEqual(1795);
    expect(remaining.seconds_remaining).toBeLessThanOrEqual(1800);
  });
});
